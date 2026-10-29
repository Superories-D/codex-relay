import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {z} from "zod";
import {atomicWrite} from "../core/store";
import {checkpointManifest,checkpointDigest,type CheckpointManifest,type CheckpointStoredFile} from "../shared/checkpoints";
import {handoffArchive,handoffRole,type HandoffRole} from "../shared/handoff";
import {checkpointFingerprint,checkpointOutputPath,checkpointSourcePath,sameCheckpointPath} from "./checkpoint-file";
import type {HandoffWorkspaceContext} from "./handoff-workspace";
export interface HandoffArchiveInput {id:string;role:HandoffRole;root:string;manifestSha256:string}
const hash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
async function directoryIdentity(folder:string){const stat=await fs.lstat(folder,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!sameCheckpointPath(folder,await fs.realpath(folder)))throw Error("交接封存目录归属已变化");return[stat.dev,stat.ino].map(String).join(":");}
async function bytes(root:string,relative:string){const target=await checkpointSourcePath(root,relative),before=await checkpointFingerprint(target),data=await fs.readFile(target);if(hash(data)!==before.sha256)throw Error("交接封存记录在读取时发生变化");return data;}
async function manifest(root:string,expected:string){const data=await bytes(root,"manifest.json");if(hash(data)!==expected)throw Error("交接封存清单完整性未通过");return{manifest:checkpointManifest.parse(JSON.parse(data.toString("utf8"))),bytes:data};}
function inventory(manifest:CheckpointManifest){
  const files=new Map<string,CheckpointStoredFile>();
  const add=(file:CheckpointStoredFile|undefined)=>{if(!file)return;const before=files.get(file.path);if(before&&(before.bytes!==file.bytes||before.sha256!==file.sha256))throw Error("交接封存中存在重复且不一致的对象路径");files.set(file.path,file);};
  for(const node of manifest.repos){for(const file of node.files)add(file.stored);for(const file of [node.pack,node.index,node.sharedIndex,node.shallow,node.sparse,node.exclude,node.globalExclude])add(file);}
  return[...files.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
/** Copies every raw payload/index/pack independently of the original checkpoint. */
export async function retainHandoffArchive(context:HandoffWorkspaceContext,input:HandoffArchiveInput){
  z.string().uuid().parse(input.id);handoffRole.parse(input.role);checkpointDigest.parse(input.manifestSha256);if(!path.isAbsolute(input.root))throw Error("交接封存来源必须是绝对路径");await context.assertOwned();
  const requestSha256=hash(JSON.stringify({role:input.role,manifestSha256:input.manifestSha256}));
  try{const saved=await readHandoffArchive(context,input.id);if(saved.archive.requestSha256!==requestSha256)throw Error("交接封存请求已用于其他内容");return saved;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const source=await manifest(input.root,input.manifestSha256),files=inventory(source.manifest),folder=path.dirname(await checkpointOutputPath(context.directory,`archives/${input.id}/.placeholder`)),payload=path.join(folder,"payload"),createdAt=Date.now();
  const plan=await fs.open(path.join(folder,"plan.json"),"wx",0o600);try{await plan.writeFile(JSON.stringify({version:1,...input,requestSha256,createdAt}));await plan.sync();}finally{await plan.close();}await fs.mkdir(payload,{mode:0o700});
  let totalBytes=0,count=0;
  for(const file of files){
    context.signal?.throwIfAborted();await context.assertOwned();const from=await checkpointSourcePath(input.root,file.path),to=await checkpointOutputPath(payload,file.path),actual=await checkpointFingerprint(from,{signal:context.signal,output:to,progress:bytes=>context.progress?.({phase:"snapshotting",role:input.role,path:file.path,bytes:totalBytes+bytes,files:count,totalFiles:files.length})});
    if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)throw Error("交接封存对象与原始清单不一致");totalBytes+=actual.bytes;if(!Number.isSafeInteger(totalBytes))throw Error("交接封存总字节数无法精确表示");count++;
  }
  const current=await manifest(input.root,input.manifestSha256);if(!current.bytes.equals(source.bytes))throw Error("交接封存清单在复制时发生变化");
  const manifestFile=await fs.open(path.join(payload,"manifest.json"),"wx",0o600);try{await manifestFile.writeFile(source.bytes);await manifestFile.sync();}finally{await manifestFile.close();}
  const archive=handoffArchive.parse({version:1,id:input.id,role:input.role,checkpointId:source.manifest.id,manifestSha256:input.manifestSha256,requestSha256,createdAt,payloadIdentity:await directoryIdentity(payload),files,totalBytes});
  // Re-read every copied byte before publication. The source may be removed
  // immediately after this succeeds, including its .git and checkpoint root.
  for(const file of files){const actual=await checkpointFingerprint(await checkpointSourcePath(payload,file.path),{signal:context.signal});if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw Error("交接封存写入后的完整校验未通过");}
  context.signal?.throwIfAborted();await context.assertOwned();const json=JSON.stringify(archive);await atomicWrite(path.join(folder,"archive.json"),json);await atomicWrite(path.join(folder,"receipt.json"),JSON.stringify({id:input.id,sha256:hash(json),at:Date.now()}));return{archive,root:payload,manifest:source.manifest};
}
export async function readHandoffArchive(context:HandoffWorkspaceContext,id:string,options:{verifyPayload?:boolean}={}){
  z.string().uuid().parse(id);await context.assertOwned();const folder=path.join(context.directory,"archives",id),payload=path.join(folder,"payload");await directoryIdentity(folder);
  const receipt=z.object({id:z.literal(id),sha256:checkpointDigest,at:z.number().finite()}).strict().parse(JSON.parse((await bytes(folder,"receipt.json")).toString("utf8"))),json=await bytes(folder,"archive.json");if(hash(json)!==receipt.sha256)throw Error("交接封存回执完整性未通过");
  const archive=handoffArchive.parse(JSON.parse(json.toString("utf8")));if(archive.id!==id||archive.payloadIdentity!==await directoryIdentity(payload))throw Error("交接封存目录归属已变化");
  const saved=await manifest(payload,archive.manifestSha256);if(saved.manifest.id!==archive.checkpointId||JSON.stringify(inventory(saved.manifest))!==JSON.stringify(archive.files)||archive.files.reduce((total,file)=>total+file.bytes,0)!==archive.totalBytes)throw Error("交接封存对象清单不一致");
  if(options.verifyPayload!==false)for(const file of archive.files){const actual=await checkpointFingerprint(await checkpointSourcePath(payload,file.path),{signal:context.signal});if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw Error("交接封存对象完整性未通过");}
  return{archive,root:payload,manifest:saved.manifest};
}

/** Finish a lost final seal only from a complete owned archive and its durable plan. */
export async function recoverHandoffArchive(context:HandoffWorkspaceContext,id:string){
  z.string().uuid().parse(id);await context.assertOwned();const folder=path.join(context.directory,"archives",id),payload=path.join(folder,"payload"),receiptPath=path.join(folder,"receipt.json");await directoryIdentity(folder);
  let present=true;try{await fs.lstat(receiptPath);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;present=false;}if(present)return readHandoffArchive(context,id);
  const planBytes=await bytes(folder,"plan.json"),plan=z.object({version:z.literal(1),id:z.literal(id),role:handoffRole,root:z.string(),manifestSha256:checkpointDigest,requestSha256:checkpointDigest,createdAt:z.number().finite()}).strict().parse(JSON.parse(planBytes.toString("utf8"))),json=await bytes(folder,"archive.json"),archive=handoffArchive.parse(JSON.parse(json.toString("utf8")));
  const expected=hash(JSON.stringify({role:plan.role,manifestSha256:plan.manifestSha256}));
  if(!path.isAbsolute(plan.root)||plan.requestSha256!==expected||archive.requestSha256!==expected||archive.id!==id||archive.role!==plan.role||archive.createdAt!==plan.createdAt||archive.manifestSha256!==plan.manifestSha256||archive.payloadIdentity!==await directoryIdentity(payload))throw Error("中断的交接封存与原始计划不一致");
  const saved=await manifest(payload,plan.manifestSha256);if(saved.manifest.id!==archive.checkpointId||JSON.stringify(inventory(saved.manifest))!==JSON.stringify(archive.files)||archive.files.reduce((total,file)=>total+file.bytes,0)!==archive.totalBytes)throw Error("中断的交接封存与原始计划不一致");
  let total=0,count=0;for(const file of archive.files){context.signal?.throwIfAborted();const actual=await checkpointFingerprint(await checkpointSourcePath(payload,file.path),{signal:context.signal,progress:bytes=>context.progress?.({phase:"verifying",role:archive.role,path:file.path,bytes:total+bytes,files:count,totalFiles:archive.files.length})});if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)throw Error("交接封存对象完整性未通过");total+=actual.bytes;count++;}
  if(!(await bytes(folder,"plan.json")).equals(planBytes)||!(await bytes(folder,"archive.json")).equals(json)||!(await manifest(payload,plan.manifestSha256)).bytes.equals(saved.bytes))throw Error("中断的交接封存在核对期间发生变化");
  context.signal?.throwIfAborted();await context.assertOwned();
  // wx prevents recovery from replacing a receipt created by another actor.
  let handle:Awaited<ReturnType<typeof fs.open>>|undefined;try{handle=await fs.open(receiptPath,"wx",0o600);await handle.writeFile(JSON.stringify({id,sha256:hash(json),at:Date.now()}));await handle.sync();}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}finally{await handle?.close();}
  return readHandoffArchive(context,id,{verifyPayload:false});
}
