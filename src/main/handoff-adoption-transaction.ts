import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import {adoptionTransaction,adoptionNativeRequest,adoptionNativeInspection,type AdoptionTransaction,type AdoptionFileProof,type AdoptionNativeRequest,type AdoptionTransactionView} from "../shared/handoff-adoption";
import {checkpointPath,checkpointDigest} from "../shared/checkpoints";
import {checkpointSourcePath,checkpointFingerprint,sameCheckpointPath,insideCheckpoint} from "./checkpoint-file";
import {adoptionNativeFileProof,prepareAdoptionNativeRequest,runAdoptionNative} from "./handoff-adoption-native";
import {classifyAdoptionFile} from "./handoff-adoption-state";
const uuid=z.string().uuid(),hash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
export type AdoptionTransactionOptions={signal?:AbortSignal;executable?:string;protect:(directory:string)=>Promise<void>;assertSource:()=>Promise<void>};
type Options=AdoptionTransactionOptions;
const desiredFile=z.object({path:checkpointPath,before:z.object({bytes:z.number().int().nonnegative().safe(),sha256:checkpointDigest}).strict().optional(),after:z.object({file:z.string(),bytes:z.number().int().nonnegative().safe(),sha256:checkpointDigest}).strict().optional()}).strict().refine(value=>!!value.before||!!value.after);
const same=(actual:AdoptionFileProof,expected:AdoptionFileProof)=>actual.dev===expected.dev&&actual.ino===expected.ino&&actual.bytes===expected.bytes&&actual.sha256===expected.sha256;
async function directory(folder:string){const stat=await fs.lstat(folder,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!sameCheckpointPath(folder,await fs.realpath(folder)))throw Error("采用恢复目录归属已变化");return`${stat.dev}:${stat.ino}`;}
async function save(file:string,value:unknown){const bytes=JSON.stringify(value),output=await fs.open(file,"wx",0o600);try{await output.writeFile(bytes);await output.sync();}finally{await output.close();}return hash(bytes);}
/** Prepare every byte and every native guard before allowing any source mutation.
 * The product service supplies fresh source/index/ref guard callbacks and policy. */
export async function prepareAdoptionTransaction(input:{id:string;owner:string;entryId:string;workspaceId:string;reviewId:string;home:string;root:string;files:z.input<typeof desiredFile>[];metadata:string[]},options:Options){
  [input.id,input.owner,input.entryId,input.workspaceId,input.reviewId].forEach(value=>uuid.parse(value));input.files.forEach(value=>desiredFile.parse(value));if(!input.files.length)throw Error("采用计划没有文件变更");options.signal?.throwIfAborted();
  const root=await fs.realpath(input.root),home=path.resolve(input.home);if(!sameCheckpointPath(root,input.root)||sameCheckpointPath(root,home)||insideCheckpoint(root,home)||!sameCheckpointPath(path.parse(root).root,path.parse(home).root))throw Error("采用恢复目录必须独立并位于来源所在卷");
  const names=new Set<string>();for(const file of input.files){const key=file.path.toLowerCase();if(names.has(key)||[...names].some(value=>value.startsWith(key+"/")||key.startsWith(value+"/")))throw Error("采用文件路径重复或存在结构冲突");names.add(key);}
  await options.assertSource();await fs.mkdir(home,{mode:0o700});const rootIdentity=await directory(root);await directory(home);await options.protect(home);await save(path.join(home,".relay-adoption.json"),{version:1,id:input.id,owner:input.owner,root});for(const folder of ["staged","actual","before","receipts","requests","metadata","observations","recoveries"])await fs.mkdir(path.join(home,folder),{mode:0o700});
  const plan:AdoptionTransaction={version:1,id:input.id,owner:input.owner,entryId:input.entryId,workspaceId:input.workspaceId,reviewId:input.reviewId,createdAt:Date.now(),home,root,rootIdentity,files:[],metadata:[]};
  // An independently retained raw index/config/ref copy is evidence, never a source
  // for an unguarded restore. Later source metadata must still match exact identity.
  for(const file of [...new Set(input.metadata)]){options.signal?.throwIfAborted();const id=randomUUID(),output=path.join(home,"metadata",id),proof=await checkpointFingerprint(file,{signal:options.signal,output}),[dev,ino]=proof.identity.split(":");plan.metadata.push({id,path:file,proof:{dev,ino,bytes:proof.bytes,sha256:proof.sha256}});}
  for(const item of input.files){
    options.signal?.throwIfAborted();await options.assertSource();const id=randomUUID(),target=path.join(root,...item.path.split("/"));let before:AdoptionFileProof|undefined;
    if(item.before){before=await adoptionNativeFileProof(await checkpointSourcePath(root,item.path),options.signal);if(before.bytes!==item.before.bytes||before.sha256!==item.before.sha256)throw Error("采用来源与已审阅文件不一致");}else try{await fs.lstat(target);throw Error("采用目标已存在，原文件已保留");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    let after:AdoptionFileProof|undefined;const stage=item.after?`staged/${id}`:undefined;if(item.after){if(!path.isAbsolute(item.after.file)||sameCheckpointPath(root,item.after.file)||insideCheckpoint(root,item.after.file))throw Error("采用内容必须来自独立的完整候选");const proof=await checkpointFingerprint(item.after.file,{signal:options.signal,output:path.join(home,stage!)});if(proof.bytes!==item.after.bytes||proof.sha256!==item.after.sha256)throw Error("采用候选在独立保存期间发生变化");after=await adoptionNativeFileProof(path.join(home,stage!),options.signal);}
    const request=await prepareAdoptionNativeRequest({id,transactionId:input.id,owner:input.owner,home,root,path:item.path,action:before?after?"replace":"delete":"create",before,after,stage},options);plan.files.push({id,path:item.path,requestSha256:request.sha256});
  }
  await options.assertSource();adoptionTransaction.parse(plan);const sha256=await save(path.join(home,"transaction.json"),plan);await save(path.join(home,"transaction.receipt.json"),{version:1,id:input.id,sha256});return{plan,sha256};
}
export async function readAdoptionTransaction(home:string,expected:{id:string;owner:string;sha256:string}){
  uuid.parse(expected.id);uuid.parse(expected.owner);checkpointDigest.parse(expected.sha256);await directory(home);const file=await checkpointSourcePath(home,"transaction.json"),proof=await checkpointFingerprint(file),json=await fs.readFile(file),plan=adoptionTransaction.parse(JSON.parse(json.toString("utf8"))),marker=JSON.parse(await fs.readFile(await checkpointSourcePath(home,".relay-adoption.json"),"utf8")),receipt=z.object({version:z.literal(1),id:uuid,sha256:checkpointDigest}).strict().parse(JSON.parse(await fs.readFile(await checkpointSourcePath(home,"transaction.receipt.json"),"utf8")));
  if(proof.sha256!==expected.sha256||hash(json)!==expected.sha256||plan.id!==expected.id||plan.owner!==expected.owner||!sameCheckpointPath(plan.home,home)||marker.id!==plan.id||marker.owner!==plan.owner||marker.version!==1||!sameCheckpointPath(marker.root,plan.root)||receipt.id!==plan.id||receipt.sha256!==expected.sha256||await directory(plan.root)!==plan.rootIdentity)throw Error("采用事务与恢复目录身份不一致");return plan;
}
export async function adoptionTransitionRequest(plan:AdoptionTransaction,transition:AdoptionTransaction["files"][number]){
  const file=await checkpointSourcePath(plan.home,`requests/${transition.id}.json`),proof=await checkpointFingerprint(file),bytes=await fs.readFile(file),request=adoptionNativeRequest.parse(JSON.parse(bytes.toString("utf8")));if(proof.sha256!==transition.requestSha256||hash(bytes)!==transition.requestSha256||request.id!==transition.id||request.transactionId!==plan.id||request.owner!==plan.owner||!sameCheckpointPath(request.home,plan.home)||!sameCheckpointPath(request.root,plan.root)||request.path!==transition.path)throw Error("采用文件计划与当前事务不一致");return{request,file,sha256:transition.requestSha256};
}
const requestFor=adoptionTransitionRequest;
async function metadataUnchanged(plan:AdoptionTransaction,signal?:AbortSignal){for(const item of plan.metadata){signal?.throwIfAborted();if(!same(await adoptionNativeFileProof(item.path,signal),item.proof))return false;const backup=await checkpointFingerprint(await checkpointSourcePath(plan.home,`metadata/${item.id}`),{signal});if(backup.sha256!==item.proof.sha256||backup.bytes!==item.proof.bytes)throw Error("采用事务的独立元数据备份完整性未通过");}return true;}
export async function inspectAdoptionTransaction(plan:AdoptionTransaction,sha256:string,options:Pick<Options,"signal"|"executable">={}):Promise<AdoptionTransactionView>{
  const current=await readAdoptionTransaction(plan.home,{id:plan.id,owner:plan.owner,sha256}),files:AdoptionTransactionView["files"]=[];for(const item of current.files){const native=await requestFor(current,item),observed=adoptionNativeInspection.parse(await runAdoptionNative("inspect",native,options));files.push({id:item.id,path:item.path,state:classifyAdoptionFile(native.request,observed),observed});}
  const unchanged=await metadataUnchanged(current,options.signal),view={id:current.id,sha256,files,metadataUnchanged:unchanged,complete:unchanged&&files.every(file=>file.state==="applied")};await save(path.join(plan.home,"observations",randomUUID()+".json"),{version:1,at:Date.now(),...view});return view;
}
/** One prepared transaction is applied at most once. Any started transition needs
 * fresh recovery choices; it is never retried by overwriting a previous journal. */
export async function applyAdoptionTransaction(plan:AdoptionTransaction,sha256:string,options:Options){
  const current=await readAdoptionTransaction(plan.home,{id:plan.id,owner:plan.owner,sha256}),view=await inspectAdoptionTransaction(current,sha256,options);if(!view.metadataUnchanged||view.files.some(file=>file.state!=="notStarted"))throw Error("采用事务已开始或来源发生变化，请先核对恢复计划");await options.assertSource();await save(path.join(plan.home,"apply-started.json"),{version:1,id:plan.id,sha256,at:Date.now()});
  for(const item of current.files){options.signal?.throwIfAborted();if(!await metadataUnchanged(current,options.signal))throw Error("原项目暂存区或引用已变化，采用已停止并保留恢复记录");await runAdoptionNative("apply",await requestFor(current,item),options);}
  const result=await inspectAdoptionTransaction(current,sha256,options);if(!result.complete)throw Error("采用后的完整复核尚未通过，恢复记录已保留");await save(path.join(plan.home,"complete.json"),{version:1,id:plan.id,sha256,at:Date.now(),files:result.files.map(file=>({id:file.id,state:file.state}))});return result;
}
