import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {z} from "zod";
import {checkpointDigest,checkpointManifest,type CheckpointRepo} from "../shared/checkpoints";
import {adoptionPreviewFile,adoptionPreviewSummary,type AdoptionPreviewFile,type AdoptionPreviewSummary,type AdoptionPreviewDetail} from "../shared/handoff-adoption-preview";
import type {HandoffEntry,HandoffWorkspace} from "../shared/handoff";
import type {HandoffRepository} from "./handoff-repository";
import {prepareCheckpoint,captureCheckpointFiles,assertCheckpointSource} from "./checkpoint-capture";
import {checkpointFingerprint,checkpointSourcePath,sameCheckpointPath} from "./checkpoint-file";
import {adoptionSourceSignature,adoptionRepositoryGuard,captureAdoptionRepositoryGuards,assertAdoptionRepositoryGuards} from "./handoff-adoption-guards";
import {readHandoffGraph,graphReviewWorkspace} from "./handoff-graph";
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex"),uuid=z.string().uuid();
const previewPlan=z.object({version:z.literal(1),id:uuid,owner:uuid,entryId:uuid,workspaceId:uuid,reviewId:uuid,requestSha256:checkpointDigest,createdAt:z.number().finite(),expiresAt:z.number().finite(),source:z.string(),sourceSha256:checkpointDigest,preparedSha256:checkpointDigest,guards:z.array(adoptionRepositoryGuard),files:z.array(adoptionPreviewFile)}).strict();
export type AdoptionPreviewPlan=z.infer<typeof previewPlan>;
async function save(file:string,value:unknown){const json=JSON.stringify(value),handle=await fs.open(file,"wx",0o600);try{await handle.writeFile(json);await handle.sync();}finally{await handle.close();}return hash(json);}
function summarize(plan:AdoptionPreviewPlan,sha256:string):AdoptionPreviewSummary{return adoptionPreviewSummary.parse({id:plan.id,workspaceId:plan.workspaceId,reviewId:plan.reviewId,requestSha256:plan.requestSha256,sha256,createdAt:plan.createdAt,expiresAt:plan.expiresAt,files:plan.files.length,changes:plan.files.filter(file=>file.action!=="unchanged").length,blocked:plan.files.filter(file=>file.action==="blocked").length,sourceSha256:plan.sourceSha256});}
function bytes(value:{bytes:number;sha256?:string}|undefined){return value?.sha256?{bytes:value.bytes,sha256:value.sha256}:undefined;}
async function parentExists(root:string,name:string){
  let current=root;for(const part of name.split("/").slice(0,-1)){current=path.join(current,part);try{const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink()||!sameCheckpointPath(current,await fs.realpath(current)))return false;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}return true;
}
/** Builds a complete read-only plan. Unsupported metadata/structure is visible;
 * producing or reopening a preview never applies the native transaction. */
export async function createAdoptionPreview(input:{id:string;owner:string;entry:HandoffEntry;workspace:HandoffWorkspace;repository:HandoffRepository;folder:string;requestSha256:string},options:{signal:AbortSignal;native?:boolean;assertTask:()=>void;progress?:(file:string,bytes:number)=>void}){
  [input.id,input.owner].forEach(value=>uuid.parse(value));checkpointDigest.parse(input.requestSha256);const {entry,repository,workspace}=input;
  if(!entry.review||entry.review.workspaceId!==workspace.id||entry.review.expiresAt<=Date.now())throw Error("采用验收已过期，请重新验收当前候选。");
  options.assertTask();await fs.mkdir(input.folder,{mode:0o700});await save(path.join(input.folder,".relay-adoption-preview.json"),{version:1,id:input.id,owner:input.owner,entryId:entry.id});
  const capture=path.join(input.folder,"source");await fs.mkdir(capture,{mode:0o700});const captureOptions={root:capture,native:options.native,signal:options.signal,ignored:entry.ignored,progress:(_phase:string,file:string,bytes:number)=>options.progress?.(file,bytes)},prepared=await prepareCheckpoint(entry.sourceCwd,entry.title,captureOptions),retained=await repository.archiveMetadata(entry.archives.source),signature=adoptionSourceSignature(prepared.manifest);
  if(signature!==adoptionSourceSignature(retained.manifest))throw Error("原项目已偏离审阅来源，请重新捕获并建立交接。");
  await captureCheckpointFiles(prepared,captureOptions);await save(path.join(capture,"manifest.json"),prepared.manifest);
  const guards=await captureAdoptionRepositoryGuards(prepared.manifest,path.join(input.folder,"commands"),options),selected=new Map<string,HandoffWorkspace>([["",workspace]]);
  if(entry.graph){const graph=await readHandoffGraph(repository,entry,input.owner,entry.graph);if(!entry.assembly)throw Error("请先明确所有子仓库来源并解决冲突");for(const node of graph.record.nodes){const actual=await graphReviewWorkspace(repository,entry,graph.record,node,{native:options.native,signal:options.signal});selected.set(node.path,await actual.repository.readWorkspace(actual.workspaceId));}}
  const rows:AdoptionPreviewFile[]=[];
  for(const node of prepared.manifest.repos){
    options.signal.throwIfAborted();const target=selected.get(node.relative);if(!target)throw Error("原项目仓库拓扑与当前集成候选不一致");
    await inventory(node,target,rows);
  }
  if(selected.size!==prepared.manifest.repos.length)throw Error("原项目仓库拓扑与当前集成候选不一致");
  const preparedSha256=await save(path.join(input.folder,"prepared.json"),prepared),now=Date.now(),plan=previewPlan.parse({version:1,id:input.id,owner:input.owner,entryId:entry.id,workspaceId:workspace.id,reviewId:entry.review.id,requestSha256:input.requestSha256,createdAt:now,expiresAt:Math.min(entry.review.expiresAt,now+10*60*1000),source:prepared.manifest.source,sourceSha256:signature,preparedSha256,guards,files:rows});
  await assertCheckpointSource(prepared,captureOptions,true);await assertAdoptionRepositoryGuards(guards,path.join(input.folder,"commands"),options);if(!(await repository.verifyWorkspace(workspace.id)).unchanged)throw Error("候选在采用前发生变化，请重新验收");options.assertTask();options.signal.throwIfAborted();if(plan.expiresAt<=Date.now())throw Error("采用验收已过期，请重新验收当前候选。");
  const sha256=await save(path.join(input.folder,"plan.json"),plan);await save(path.join(input.folder,"receipt.json"),{version:1,id:input.id,sha256});return summarize(plan,sha256);
  async function inventory(node:CheckpointRepo,target:HandoffWorkspace,rows:AdoptionPreviewFile[]){
    const before=new Map(node.files.map(file=>[file.path,file])),after=new Map(target.files.map(file=>[file.path,file])),names=[...new Set([...before.keys(),...after.keys()])].sort(),folded=new Map<string,string>();
    for(const name of names){
      options.signal.throwIfAborted();const source=before.get(name),result=after.get(name),row:AdoptionPreviewFile={repository:node.relative,path:name,action:"unchanged",before:bytes(source?.stored),after:bytes(result)};
      if(folded.has(name.toLowerCase())&&folded.get(name.toLowerCase())!==name){row.action="blocked";row.issue="structural";}else if(result?.disposition==="gitlink"||source?.kind==="directory"){
        const relative=node.relative?`${node.relative}/${name}`:name,child=prepared.manifest.repos.find(value=>value.relative===relative);
        if(source?.kind==="directory"&&result&&result.disposition!=="gitlink"){row.action="blocked";row.issue="structural";}else if(!child&&!(source?.kind==="directory"&&!result)){row.action="blocked";row.issue="topology";}
      }else if(source?.kind==="link"||result?.disposition==="link"||result?.disposition==="deferredLink"){
        if(source?.kind!=="link"||source.link?.target!==result?.linkTarget){row.action="blocked";row.issue="link";}
      }else if(result?.disposition==="sparse"){row.action="blocked";row.issue="sparse";}
      else if(!row.before&&!row.after){if(result){row.action="blocked";row.issue="structural";}}
      else if(row.before&&row.after&&row.before.sha256===row.after.sha256&&row.before.bytes===row.after.bytes){}
      else if(!row.after)row.action="delete";
      else if(!row.before){row.action="blocked";row.issue=await parentExists(node.source,name)?"newFilePermissions":"newDirectory";}
      else row.action="replace";
      if(row.after&&result?.disposition==="file"){
        row.afterFile=await checkpointSourcePath(target.target,name);const actual=await checkpointFingerprint(row.afterFile,{signal:options.signal});if(actual.bytes!==row.after.bytes||actual.sha256!==row.after.sha256)throw Error("候选在采用前发生变化，请重新验收");
      }
      folded.set(name.toLowerCase(),name);rows.push(adoptionPreviewFile.parse(row));
    }
  }
}
export async function readAdoptionPreview(folder:string,summary:AdoptionPreviewSummary,expected:{owner:string;entryId:string}){
  adoptionPreviewSummary.parse(summary);const file=await checkpointSourcePath(folder,"plan.json"),proof=await checkpointFingerprint(file),json=await fs.readFile(file),plan=previewPlan.parse(JSON.parse(json.toString("utf8"))),marker=JSON.parse(await fs.readFile(await checkpointSourcePath(folder,".relay-adoption-preview.json"),"utf8")),receipt=JSON.parse(await fs.readFile(await checkpointSourcePath(folder,"receipt.json"),"utf8"));
  if(proof.sha256!==summary.sha256||hash(json)!==summary.sha256||JSON.stringify(summarize(plan,summary.sha256))!==JSON.stringify(summary)||plan.owner!==expected.owner||plan.entryId!==expected.entryId||marker.version!==1||marker.id!==plan.id||marker.owner!==expected.owner||marker.entryId!==expected.entryId||receipt.version!==1||receipt.id!==plan.id||receipt.sha256!==summary.sha256)throw Error("原项目采用预览完整性未通过");
  const preparedFile=await checkpointSourcePath(folder,"prepared.json"),preparedProof=await checkpointFingerprint(preparedFile),preparedJson=await fs.readFile(preparedFile);if(preparedProof.sha256!==plan.preparedSha256||hash(preparedJson)!==plan.preparedSha256)throw Error("原项目采用预览完整性未通过");checkpointManifest.parse(JSON.parse(preparedJson.toString("utf8")).manifest);return plan;
}
export function adoptionPreviewPage(plan:AdoptionPreviewPlan,summary:AdoptionPreviewSummary,offset:number,limit:number):AdoptionPreviewDetail{return{summary,source:plan.source,offset,total:plan.files.length,files:plan.files.slice(offset,offset+limit).map(({afterFile,...file})=>file)};}
