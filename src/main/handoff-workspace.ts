import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import {atomicWrite} from "../core/store";
import {checkpointDigest,checkpointOid,checkpointPath} from "../shared/checkpoints";
import {handoffWorkspace,type HandoffWorkspace,type HandoffWorkspaceFile,type HandoffMergeResult,type HandoffTreeSnapshot,type HandoffObjectFormat,type HandoffProgress,type HandoffWorkspaceVerification,type HandoffResolution} from "../shared/handoff";
import {checkpointFingerprint,checkpointOutputPath,checkpointSourcePath,insideCheckpoint,sameCheckpointPath} from "./checkpoint-file";
import {extractHandoffBlobs,type HandoffBlob,type HandoffExtractedBlob} from "./handoff-payload";
import {handoffRecords,handoffWriteAll} from "./handoff-stream";
import type {CheckpointGit} from "./checkpoint-git";
import type {HandoffComposition} from "../shared/handoff-assembly";
import type {HandoffRepository} from "./handoff-repository";

export interface HandoffWorkspaceInput {
  id:string;mergeId:string;sourceSnapshotId:string;taskSnapshotId:string;baselineSnapshotId?:string;resolutionId?:string;compositionId?:string;
}
/** Capability supplied only by an ownership-checked private object repository. */
export interface HandoffWorkspaceContext {
  directory:string;familyRoot?:string;format:HandoffObjectFormat;namespace:string;signal?:AbortSignal;
  progress?:(value:HandoffProgress)=>void;
  assertOwned:()=>Promise<void>;
  call:(args:string[],options?:Parameters<CheckpointGit["run"]>[2])=>Promise<Buffer>;
  readSnapshot:(id:string)=>Promise<HandoffTreeSnapshot>;
  readMerge:(id:string)=>Promise<HandoffMergeResult>;
  readResolution:(id:string)=>Promise<HandoffResolution>;
  readComposition?:(id:string)=>Promise<HandoffComposition>;
  attachmentRepository?:(id:string)=>Promise<HandoffRepository>;
  archiveMetadata?:(id:string)=>ReturnType<HandoffRepository["archiveMetadata"]>;
  pin:(refs:Record<string,string>)=>Promise<void>;
}
type Context=HandoffWorkspaceContext;
const digest=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const requestSchema=z.object({id:z.string().uuid(),mergeId:z.string().uuid(),sourceSnapshotId:z.string().uuid(),taskSnapshotId:z.string().uuid(),baselineSnapshotId:z.string().uuid().optional(),resolutionId:z.string().uuid().optional(),compositionId:z.string().uuid().optional()}).strict();
const receiptSchema=z.object({id:z.string().uuid(),sha256:checkpointDigest,at:z.number().finite()}).strict();
async function identity(folder:string){const stat=await fs.lstat(folder,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!sameCheckpointPath(folder,await fs.realpath(folder)))throw Error("交接工作区目录归属已变化");return[stat.dev,stat.ino].map(String).join(":");}
const text=async(context:Context,args:string[],options?:Parameters<CheckpointGit["run"]>[2])=>(await context.call(args,options)).toString("utf8").trim();
async function recordBytes(context:Context,relative:string){const file=await checkpointSourcePath(context.directory,relative),actual=await checkpointFingerprint(file,{signal:context.signal}),bytes=await fs.readFile(file);if(digest(bytes)!==actual.sha256)throw Error("交接工作区记录在读取时发生变化");return bytes;}
async function at(context:Context,target:string,args:string[],options?:Parameters<CheckpointGit["run"]>[2]){await context.assertOwned();await identity(target);return context.call(["-C",target,...args],options);}

async function verifyOwnership(context:Context,workspace:HandoffWorkspace){
  await context.assertOwned();let expected=path.join(context.directory,"workspaces",workspace.id,"worktree");
  if(workspace.replica){const replica=workspace.replica;if(!path.isAbsolute(replica.parentRoot)||!insideCheckpoint(context.familyRoot||context.directory,replica.parentRoot)||await identity(replica.parentRoot)!==replica.parentIdentity)throw Error("交接工作区目录归属已变化");expected=await checkpointSourcePath(replica.parentRoot,replica.relative);}
  if(!sameCheckpointPath(expected,workspace.target)||await identity(expected)!==workspace.identity)throw Error("交接工作区目录归属已变化");
  if((await checkpointFingerprint(path.join(expected,".git"),{signal:context.signal})).sha256!==workspace.gitFileSha256)throw Error("交接工作区 Git 归属已变化");
  const common=await text(context,["-C",expected,"rev-parse","--path-format=absolute","--git-common-dir"]),admin=await text(context,["-C",expected,"rev-parse","--absolute-git-dir"]);
  if(!sameCheckpointPath(common,path.join(context.directory,".git"))||!sameCheckpointPath(admin,workspace.adminDirectory)||!insideCheckpoint(path.join(common,"worktrees"),admin)||await identity(admin)!==workspace.adminIdentity)throw Error("交接工作区 Git 布局已变化");
  const back=await checkpointFingerprint(path.join(admin,"gitdir")),bytes=await fs.readFile(path.join(admin,"gitdir"));if(digest(bytes)!==back.sha256||!sameCheckpointPath(bytes.toString("utf8").trim(),path.join(expected,".git")))throw Error("交接工作区反向归属已变化");
  // Worktree-specific configuration must not inject filters/merge drivers into
  // future verification. Our preview never creates such a file.
  try{await fs.lstat(path.join(admin,"config.worktree"));throw Error("交接工作区配置已变化");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}

export async function readHandoffWorkspace(context:Context,id:string){
  z.string().uuid().parse(id);await context.assertOwned();
  const receipt=receiptSchema.parse(JSON.parse((await recordBytes(context,`workspaces/${id}/receipt.json`)).toString("utf8"))),json=await recordBytes(context,`workspaces/${id}/workspace.json`);
  if(receipt.id!==id||digest(json)!==receipt.sha256)throw Error("交接工作区回执完整性未通过");
  return validateRecord(context,id,json);
}
async function validateRecord(context:Context,id:string,json:Buffer){
  const workspace=handoffWorkspace.parse(JSON.parse(json.toString("utf8")));
  if(workspace.id!==id||workspace.format!==context.format||await text(context,["rev-parse","--verify",`${context.namespace}/workspaces/${id}/candidate`])!==workspace.commit)throw Error("交接工作区固定对象不一致");
  const commit=(await context.call(["cat-file","commit",workspace.commit])).toString("utf8").split("\n\n",1)[0].split("\n");if(commit[0]!==`tree ${workspace.tree}`||JSON.stringify(commit.filter(line=>line.startsWith("parent ")).map(line=>line.slice(7)))!==JSON.stringify(workspace.parents))throw Error("交接工作区提交关系不一致");
  if(workspace.compositionId){const composition=await context.readComposition?.(workspace.compositionId);if(!composition||composition.tree!==workspace.tree||JSON.stringify(composition.attachments.map(({workspaceId,...value})=>{void workspaceId;return value;}))!==JSON.stringify((workspace.attachments||[]).map(({workspaceId,...value})=>{void workspaceId;return value;})))throw Error("组装提案与原始候选不一致");}
  if(workspace.replica){if(workspace.replica.sourceWorkspaceId===id)throw Error("组装子仓库与核验记录不一致");const source=await readHandoffWorkspace(context,workspace.replica.sourceWorkspaceId);if(hashWorkspace(source)!==workspace.replica.sourceSha256||source.commit!==workspace.commit||source.tree!==workspace.tree||source.compositionId!==workspace.compositionId)throw Error("组装子仓库与核验记录不一致");}
  await verifyOwnership(context,workspace);return workspace;
}
const hashWorkspace=(workspace:HandoffWorkspace)=>digest(JSON.stringify(workspace));

/** Reconcile only a fully written candidate; partial/edited attempts stay intact. */
export async function recoverHandoffWorkspace(context:Context,id:string){
  z.string().uuid().parse(id);let workspace:HandoffWorkspace;
  try{workspace=await readHandoffWorkspace(context,id);}catch(error){
    if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
    const json=await recordBytes(context,`workspaces/${id}/workspace.json`);workspace=await validateRecord(context,id,json);
    const plan=JSON.parse((await recordBytes(context,`workspaces/${id}/plan.json`)).toString("utf8"));if(plan.requestSha256!==workspace.requestSha256||plan.id!==id||plan.target!==workspace.target)throw Error("中断的交接工作区与原始计划不一致");
    const verified=await verifyHandoffWorkspace(context,workspace);if(!verified.unchanged)throw Error("中断的交接目标已发生变化，原文件已保留，请创建新目标");
    await context.readMerge(workspace.mergeId);await context.readSnapshot(workspace.sourceSnapshotId);await context.readSnapshot(workspace.taskSnapshotId);if(workspace.baselineSnapshotId)await context.readSnapshot(workspace.baselineSnapshotId);if(workspace.resolutionId)await context.readResolution(workspace.resolutionId);
    context.signal?.throwIfAborted();await context.assertOwned();await atomicWrite(path.join(context.directory,"workspaces",id,"receipt.json"),JSON.stringify({id,sha256:digest(json),at:Date.now()}));
  }
  return workspace;
}

async function treeEntries(context:Context,tree:string,folder:string){
  const file=path.join(folder,`tree-${randomUUID()}.nul`);await context.call(["ls-tree","-r","-z",tree],{output:file});
  const entries:{path:string;oid:string;mode:HandoffWorkspaceFile["mode"]}[]=[],names=new Set<string>();
  for await(const record of handoffRecords(file,0,context.signal)){
    const match=/^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record);if(!match)throw Error("交接提案树记录无法验证");
    const name=checkpointPath.parse(match[4]),oid=checkpointOid.parse(match[3]),key=process.platform==="win32"?name.toLowerCase():name;
    if(names.has(key)||oid.length!==(context.format==="sha1"?40:64)||(match[1]==="160000")!==(match[2]==="commit"))throw Error("交接提案树存在冲突或无效对象");names.add(key);entries.push({path:name,mode:match[1] as HandoffWorkspaceFile["mode"],oid});
  }
  for(const name of names){let parent=name;while(parent.includes("/")){parent=parent.slice(0,parent.lastIndexOf("/"));if(names.has(parent))throw Error("交接提案树存在文件与目录冲突");}}
  return entries;
}
async function snapshotCommit(context:Context,snapshot:HandoffTreeSnapshot){
  const args=["commit-tree",snapshot.tree];if(snapshot.head){if(await text(context,["cat-file","-t",snapshot.head])!=="commit")throw Error("交接快照历史对象无法验证");args.push("-p",snapshot.head);}
  return text(context,args,{input:`Codex Relay raw ${snapshot.role} snapshot ${snapshot.id}\n\nCheckpoint: ${snapshot.checkpointId}\nManifest-SHA256: ${snapshot.manifestSha256}\n`,env:commitEnvironment(snapshot.createdAt)});
}
function commitEnvironment(at:number){const date=`${Math.floor(at/1000)} +0000`;return{GIT_AUTHOR_NAME:"Codex Relay",GIT_AUTHOR_EMAIL:"handoff@localhost",GIT_COMMITTER_NAME:"Codex Relay",GIT_COMMITTER_EMAIL:"handoff@localhost",GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date};}

/** A detached private candidate; never updates original HEAD/index/work files. */
export async function createHandoffWorkspace(context:Context,request:HandoffWorkspaceInput){
  const input=requestSchema.parse(request),requestSha256=digest(JSON.stringify(input));await context.assertOwned();
  try{const saved=await readHandoffWorkspace(context,input.id);if(saved.requestSha256!==requestSha256)throw Error("交接工作区请求已用于其他内容");return saved;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const merge=await context.readMerge(input.mergeId),source=await context.readSnapshot(input.sourceSnapshotId),task=await context.readSnapshot(input.taskSnapshotId);
  if(source.role!=="source"||task.role!=="task"||merge.source!==source.tree||merge.task!==task.tree||source.relative!==task.relative)throw Error("交接提案与来源快照不一致");
  if(merge.baseline.kind==="checkpointWorking"){
    if(!input.baselineSnapshotId)throw Error("交接提案缺少工作快照基准");const base=await context.readSnapshot(input.baselineSnapshotId);if(base.role!=="base"||base.tree!==merge.baseline.oid||base.relative!==source.relative)throw Error("交接提案与基准快照不一致");
  }else if(input.baselineSnapshotId)throw Error("历史基准提案不能隐式替换为工作快照");
  const resolution=input.resolutionId?await context.readResolution(input.resolutionId):undefined;
  if(resolution){const original=await readHandoffWorkspace(context,resolution.workspaceId);if(resolution.mergeId!==merge.id||resolution.parentCommit!==original.commit||original.sourceSnapshotId!==source.id||original.taskSnapshotId!==task.id)throw Error("冲突解决与交接来源不一致");}
  const composition=input.compositionId?await context.readComposition?.(input.compositionId):undefined;if(input.compositionId&&!composition)throw Error("组装提案缺少完整核验记录");if(composition){const original=await readHandoffWorkspace(context,composition.baseWorkspaceId);if(original.mergeId!==merge.id||original.resolutionId!==input.resolutionId||original.sourceSnapshotId!==source.id||original.taskSnapshotId!==task.id)throw Error("组装提案与原始候选不一致");}
  const tree=composition?.tree||resolution?.tree||merge.tree,unresolved=merge.status==="conflicted"&&!resolution;
  const folder=path.dirname(await checkpointOutputPath(context.directory,`workspaces/${input.id}/.placeholder`)),target=path.join(folder,"worktree"),createdAt=Date.now();
  const plan=await fs.open(path.join(folder,"plan.json"),"wx",0o600);try{await plan.writeFile(JSON.stringify({version:1,...input,requestSha256,createdAt,target}));await plan.sync();}finally{await plan.close();}
  const parents=[await snapshotCommit(context,source),await snapshotCommit(context,task)];
  const commit=await text(context,["commit-tree",tree,"-p",parents[0],"-p",parents[1]],{input:`Codex Relay ${unresolved?"UNRESOLVED integration candidate":"integration proposal"} ${input.id}\n\nMerge: ${merge.id}\nSource-Snapshot: ${source.id}\nTask-Snapshot: ${task.id}\nBaseline: ${merge.baseline.kind} ${merge.baseline.oid}\n${resolution?`Resolution: ${resolution.id}\n`:""}`,env:commitEnvironment(createdAt)});
  await context.pin({[`workspaces/${input.id}/source`]:parents[0],[`workspaces/${input.id}/task`]:parents[1],[`workspaces/${input.id}/candidate`]:commit});
  await context.call(["worktree","add","--detach","--no-checkout",target,commit]);await identity(target);
  await at(context,target,["read-tree",tree]);
  const entries=await treeEntries(context,tree,folder),sourceByPath=new Map(source.members.map(member=>[member.path,member])),taskByPath=new Map(task.members.map(member=>[member.path,member])),conflicts=unresolved?merge.conflicts:[],conflictPaths=new Set(conflicts.map(entry=>entry.path));
  const blobs:HandoffBlob[]=[],descriptors=new Map<string,HandoffWorkspaceFile>(),dependencies=[...source.dependencies,...task.dependencies].filter((item,index,all)=>all.findIndex(other=>JSON.stringify(other)===JSON.stringify(item))===index);
  for(const entry of entries){
    if(entry.mode==="160000"){descriptors.set(entry.path,{...entry,bytes:0,disposition:"gitlink"});continue;}
    const known=[sourceByPath.get(entry.path),taskByPath.get(entry.path)].filter(member=>member?.oid===entry.oid&&member.mode===entry.mode),link=known.find(member=>member?.kind==="link"),virtual=sourceByPath.get(entry.path),sparse=virtual?.kind==="index"&&virtual.oid===entry.oid&&virtual.mode===entry.mode&&!conflictPaths.has(entry.path),nativeLink=entry.mode==="120000"&&!!link;
    blobs.push({...entry,mode:entry.mode,kind:nativeLink?"link":sparse?"index":"file",materialize:!sparse,expectedBytes:known[0]?.bytes,expectedSha256:known[0]?.sha256});
    descriptors.set(entry.path,{...entry,bytes:0,disposition:nativeLink?"deferredLink":sparse?"sparse":"file",...(nativeLink?{directory:link!.link!.directory}:{})});
  }
  const inputFile=path.join(folder,"blob-inputs.txt"),handle=await fs.open(inputFile,"wx",0o600);try{for(const blob of blobs)await handoffWriteAll(handle,blob.oid+"\n");await handle.sync();}finally{await handle.close();}
  context.progress?.({phase:"materializing",bytes:0,files:0,totalFiles:blobs.length});let extracted:HandoffExtractedBlob[]=[],completed=0,completedBytes=0,lastName="",lastBytes=0;
  await context.call(["cat-file","--batch"],{stdinFile:inputFile,consumeOutput:async stream=>{extracted=await extractHandoffBlobs(stream,context.format,target,blobs,{signal:context.signal,progress:(name,bytes)=>{if(lastName&&lastName!==name){completed++;completedBytes+=lastBytes;}lastName=name;lastBytes=bytes;context.progress?.({phase:"materializing",path:name,bytes:completedBytes+bytes,files:completed,totalFiles:blobs.length});}});}});
  context.progress?.({phase:"materializing",bytes:extracted.reduce((total,file)=>total+file.bytes,0),files:blobs.length,totalFiles:blobs.length});
  for(const blob of extracted){const file=descriptors.get(blob.path)!;file.bytes=blob.bytes;file.sha256=blob.sha256;if(blob.linkTarget!==undefined)file.linkTarget=blob.linkTarget;}
  // Do not follow links during extraction. Native links are installed last, and
  // external/unknown dependencies remain explicit until the user resolves them.
  for(const file of descriptors.values())if(file.disposition==="deferredLink"){
    const linkTarget=path.resolve(path.dirname(path.join(target,...file.path.split("/"))),file.linkTarget!);
    if(sameCheckpointPath(target,linkTarget)||insideCheckpoint(target,linkTarget)){
      const relative=path.relative(target,linkTarget).split(path.sep).join("/"),represented=!relative||descriptors.has(relative)||[...descriptors.keys()].some(name=>name.startsWith(relative+"/"));if(!represented)dependencies.push({path:file.path,kind:"excludedLinkTarget",detail:"集成结果中的内部链接目标未包含在已封存树中，需要明确补齐或移除链接。"});
      const destination=await checkpointOutputPath(target,file.path);await fs.symlink(file.directory?linkTarget:file.linkTarget!,destination,file.directory?"junction":"file");file.disposition="link";
    }else dependencies.push({path:file.path,kind:"externalLink",detail:"外部链接依赖保留完整目标记录，等待明确接入；没有复制或读取外部内容。"});
  }
  const sparseNames=[...descriptors.values()].filter(file=>file.disposition==="sparse").map(file=>file.path);
  if(sparseNames.length){const file=path.join(folder,"sparse-paths.nul"),out=await fs.open(file,"wx",0o600);try{for(const name of sparseNames)await handoffWriteAll(out,name+"\0");await out.sync();}finally{await out.close();}await at(context,target,["update-index","--skip-worktree","-z","--stdin"],{stdinFile:file});}
  if(conflicts.length){
    const file=path.join(folder,"conflicts.nul"),out=await fs.open(file,"wx",0o600),zero="0".repeat(context.format==="sha1"?40:64);
    try{for(const name of conflictPaths)await handoffWriteAll(out,`0 ${zero}\t${name}\0`);for(const entry of conflicts)await handoffWriteAll(out,`${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}\0`);await out.sync();}finally{await out.close();}
    await at(context,target,["update-index","-z","--index-info"],{stdinFile:file});
  }
  const expectedIndex=new Map<string,{mode:string;oid:string}>();for(const entry of entries)if(!conflictPaths.has(entry.path))expectedIndex.set(`0\0${entry.path}`,entry);for(const entry of conflicts)expectedIndex.set(`${entry.stage}\0${entry.path}`,entry);
  const staged=path.join(folder,"verified-index.nul");await at(context,target,["ls-files","--stage","-z"],{output:staged});
  for await(const row of handoffRecords(staged,0,context.signal)){const match=/^(\d{6}) ([a-f0-9]{40,64}) ([0123])\t([\s\S]+)$/.exec(row),key=match?`${match[3]}\0${match[4]}`:"",entry=expectedIndex.get(key);if(!match||!entry||entry.mode!==match[1]||entry.oid!==match[2])throw Error("交接工作区完整索引与提案阶段记录不一致");expectedIndex.delete(key);}if(expectedIndex.size)throw Error("交接工作区索引缺少提案文件或冲突阶段");
  const adminDirectory=(await at(context,target,["rev-parse","--absolute-git-dir"])).toString("utf8").trim(),files=[...descriptors.values()];
  const attachments=composition?structuredClone(composition.attachments):undefined,attached=new Set(attachments?.map(value=>value.path)||[]),remainingDependencies=dependencies.filter(value=>!(value.kind==="nestedRepository"&&attached.has(value.path))&&!(value.kind==="ignoredSetup"&&composition?.setup.paths.includes(value.path)));
  if(composition)for(const setup of composition.setup.files){const saved=await context.archiveMetadata?.(setup.archiveId);if(!saved)throw Error("组装提案缺少完整核验记录");const output=await checkpointOutputPath(target,setup.path),actual=await checkpointFingerprint(await checkpointSourcePath(saved.root,setup.storedPath),{signal:context.signal,output,gitFormat:context.format});if(actual.bytes!==setup.bytes||actual.sha256!==setup.sha256)throw Error("内容来源与交接封存不一致");const oid=await text(context,["hash-object","--no-filters","-w","--",output]);if(oid!==actual.gitOid)throw Error("组装子仓库与核验记录不一致");files.push({path:setup.path,mode:"100644",oid,bytes:actual.bytes,sha256:actual.sha256,disposition:"file",untracked:true});}
  if(attachments)for(const attachment of attachments){const repository=await context.attachmentRepository?.(attachment.repositoryId);if(!repository)throw Error("组装提案缺少完整核验记录");await repository.replicateWorkspace({id:attachment.workspaceId,sourceWorkspaceId:attachment.sourceWorkspaceId,parentRoot:target,relative:attachment.path});}
  const pending=files.some(file=>file.disposition==="deferredLink"||file.disposition==="gitlink"&&!attached.has(file.path))||remainingDependencies.some(item=>["nestedRepository","excludedLinkTarget","ignoredSetup"].includes(item.kind));
  const workspace=handoffWorkspace.parse({version:1,...input,requestSha256,createdAt,format:context.format,state:unresolved?"needsResolution":pending?"needsDependencies":"reviewable",tree,commit,parents,target,identity:await identity(target),gitFileSha256:(await checkpointFingerprint(path.join(target,".git"))).sha256,adminDirectory,adminIdentity:await identity(adminDirectory),indexSha256:(await checkpointFingerprint(path.join(adminDirectory,"index"))).sha256,files,conflicts,messages:merge.messages,dependencies:remainingDependencies,...(attachments?{attachments}:{})});
  const verified=await verifyHandoffWorkspace(context,workspace);if(!verified.unchanged)throw Error("交接工作区写入后的完整校验未通过");
  context.signal?.throwIfAborted();context.progress?.({phase:"sealing",bytes:0,files:files.length,totalFiles:files.length});
  const json=JSON.stringify(workspace);await atomicWrite(path.join(folder,"workspace.json"),json);await atomicWrite(path.join(folder,"receipt.json"),JSON.stringify({id:input.id,sha256:digest(json),at:Date.now()}));return workspace;
}

/** Full raw-byte readback, including ignored/untracked additions; never git add. */
export async function verifyHandoffWorkspace(context:Context,workspace:HandoffWorkspace):Promise<HandoffWorkspaceVerification>{
  await verifyOwnership(context,workspace);const changes:HandoffWorkspaceVerification["changes"]=[],seen=new Set<string>(),expected=new Map(workspace.files.map(file=>[file.path,file]));
  let verifiedBytes=0,verifiedFiles=0;const progress=(name:string,bytes=0)=>context.progress?.({phase:"verifying",path:name,bytes:verifiedBytes+bytes,files:verifiedFiles,totalFiles:workspace.files.length});
  if((await at(context,workspace.target,["rev-parse","HEAD"])).toString("utf8").trim()!==workspace.commit)changes.push({path:"HEAD",reason:"head"});
  if((await checkpointFingerprint(path.join(workspace.adminDirectory,"index"),{signal:context.signal})).sha256!==workspace.indexSha256)changes.push({path:"index",reason:"index"});
  async function walk(folder:string,prefix:string){for(const item of await fs.readdir(folder,{withFileTypes:true})){
    context.signal?.throwIfAborted();const name=prefix?`${prefix}/${item.name}`:item.name;if(!prefix&&item.name===".git")continue;checkpointPath.parse(name);const physical=path.join(folder,item.name),stat=await fs.lstat(physical),file=expected.get(name);
    if(stat.isDirectory()&&!stat.isSymbolicLink()){const attachment=workspace.attachments?.find(value=>value.path===name);if(attachment){seen.add(name);if(!sameCheckpointPath(physical,await fs.realpath(physical)))throw Error("交接工作区目录归属已变化");const repository=await context.attachmentRepository?.(attachment.repositoryId);if(!repository)throw Error("组装提案缺少完整核验记录");const child=await repository.readWorkspace(attachment.workspaceId);if(!sameCheckpointPath(child.target,physical)||child.commit!==attachment.commit||child.tree!==attachment.tree||child.replica?.sourceWorkspaceId!==attachment.sourceWorkspaceId)throw Error("组装子仓库与核验记录不一致");const verified=await repository.verifyWorkspace(child.id);for(const item of verified.changes)changes.push({path:`${name}/${item.path}`,reason:item.reason});continue;}if(file){changes.push({path:name,reason:"layout"});seen.add(name);}else{const legitimate=workspace.files.some(member=>member.path.startsWith(name+"/"))||workspace.attachments?.some(member=>member.path.startsWith(name+"/"));if(!legitimate)changes.push({path:name,reason:"unexpected"});}if(!sameCheckpointPath(physical,await fs.realpath(physical)))throw Error("交接工作区目录归属已变化");await walk(physical,name);continue;}
    seen.add(name);if(!file){changes.push({path:name,reason:"unexpected"});continue;}
    if(file.disposition==="link"){
      if(!stat.isSymbolicLink()){changes.push({path:name,reason:"layout"});continue;}const actual=await fs.readlink(physical),actualTarget=path.resolve(path.dirname(physical),actual),expectedTarget=path.resolve(path.dirname(physical),file.linkTarget!);if(!sameCheckpointPath(actualTarget,expectedTarget))changes.push({path:name,reason:"content"});
    }else if(file.disposition!=="file"||!stat.isFile()||stat.isSymbolicLink())changes.push({path:name,reason:"layout"});
    else{const actual=await checkpointFingerprint(physical,{signal:context.signal,gitFormat:context.format,progress:bytes=>progress(name,bytes)});if(actual.sha256!==file.sha256||actual.bytes!==file.bytes||actual.gitOid!==file.oid)changes.push({path:name,reason:"content"});verifiedBytes+=actual.bytes;}verifiedFiles++;progress(name);
  }}
  await walk(workspace.target,"");for(const file of workspace.files)if(["file","link"].includes(file.disposition)&&!seen.has(file.path))changes.push({path:file.path,reason:"missing"});
  for(const attachment of workspace.attachments||[])if(!seen.has(attachment.path))changes.push({path:attachment.path,reason:"missing"});
  // Sparse and deferred bytes still have to survive in the object database.
  const deferred=workspace.files.filter(file=>file.disposition==="sparse"||file.disposition==="deferredLink");if(deferred.length){
    const input=path.join(context.directory,"workspaces",workspace.id,`verify-${randomUUID()}.txt`),out=await fs.open(input,"wx",0o600);try{for(const file of deferred)await handoffWriteAll(out,file.oid+"\n");await out.sync();}finally{await out.close();}
    await context.call(["cat-file","--batch"],{stdinFile:input,consumeOutput:async stream=>{await extractHandoffBlobs(stream,context.format,workspace.target,deferred.map(file=>({path:file.path,mode:file.mode as HandoffBlob["mode"],oid:file.oid,kind:file.disposition==="deferredLink"?"link":"index",materialize:false,expectedBytes:file.bytes,expectedSha256:file.sha256})),{signal:context.signal});}});
  }
  if((await at(context,workspace.target,["rev-parse","HEAD"])).toString("utf8").trim()!==workspace.commit&&!changes.some(item=>item.reason==="head"))changes.push({path:"HEAD",reason:"head"});
  if((await checkpointFingerprint(path.join(workspace.adminDirectory,"index"),{signal:context.signal})).sha256!==workspace.indexSha256&&!changes.some(item=>item.reason==="index"))changes.push({path:"index",reason:"index"});
  await verifyOwnership(context,workspace);return{id:workspace.id,at:Date.now(),unchanged:!changes.length,changes};
}
