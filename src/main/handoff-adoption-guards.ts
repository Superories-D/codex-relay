import {promises as fs} from "node:fs";
import path from "node:path";
import {randomUUID,createHash} from "node:crypto";
import type {Writable} from "node:stream";
import {z} from "zod";
import type {CheckpointManifest,CheckpointRepo} from "../shared/checkpoints";
import {checkpointOid,checkpointManifest} from "../shared/checkpoints";
import {CheckpointGit} from "./checkpoint-git";
import {checkpointFingerprint,sameCheckpointPath} from "./checkpoint-file";
import {handoffGitEnvironment} from "./handoff-merge";
import {withWindowsRepositoryLease,type RepositoryLeaseOptions} from "./handoff-repository-lease";
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex"),key=(value:string)=>path.resolve(value).toLowerCase();
export const adoptionRepositoryGuard=z.object({source:z.string(),gitDir:z.string(),commonDir:z.string(),identity:z.string(),format:z.enum(["sha1","sha256"]),head:checkpointOid.optional(),branch:z.string(),index:z.string(),lockPaths:z.array(z.string()),refs:z.array(z.object({name:z.string(),oid:checkpointOid.optional()}).strict()),metadata:z.array(z.object({file:z.string(),identity:z.string().optional(),bytes:z.number().int().nonnegative().safe().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict())}).strict();
export type AdoptionRepositoryGuard=z.infer<typeof adoptionRepositoryGuard>;
type Options={native?:boolean;signal?:AbortSignal}&RepositoryLeaseOptions;
async function fileGuard(file:string,signal?:AbortSignal){try{const actual=await checkpointFingerprint(file,{signal});return{file,identity:actual.identity,bytes:actual.bytes,sha256:actual.sha256};}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return{file};}}
async function repositoryIdentity(folder:string){const stat=await fs.lstat(folder,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!sameCheckpointPath(folder,await fs.realpath(folder)))throw Error("原项目仓库目录归属已变化");return`${stat.dev}:${stat.ino}`;}
/** Compare semantic source contents across independently copied manifests. Storage
 * IDs, pack encodings and capture timestamps do not change the reviewed source. */
export function adoptionSourceSignature(manifest:CheckpointManifest){
  // Archives are schema-normalized on read. Normalize a fresh capture too, so
  // property insertion order cannot masquerade as a changed source file.
  manifest=checkpointManifest.parse(manifest);
  const stored=(value:CheckpointRepo["index"])=>value?{bytes:value.bytes,sha256:value.sha256}:undefined;
  return hash(JSON.stringify({source:key(manifest.source),projectRelative:manifest.projectRelative,ignored:[...manifest.ignored].sort(),repos:manifest.repos.map(node=>({relative:node.relative,source:key(node.source),gitDir:key(node.gitDir),commonDir:key(node.commonDir),identity:node.identity,format:node.format,head:node.head,branch:node.branch,config:Object.fromEntries(Object.entries(node.config).sort(([a],[b])=>a.localeCompare(b))),index:stored(node.index),sharedIndex:stored(node.sharedIndex),sharedName:node.sharedName,shallow:stored(node.shallow),sparse:stored(node.sparse),exclude:stored(node.exclude),globalExclude:stored(node.globalExclude),stages:node.stages,undo:node.undo,flags:node.flags,files:node.files.map(file=>({...file,stored:stored(file.stored)})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),dependencies:node.dependencies})).sort((a,b)=>a.relative<b.relative?-1:a.relative>b.relative?1:0)}));
}
export async function captureAdoptionRepositoryGuards(manifest:CheckpointManifest,scratch:string,options:Options={}){
  const git=new CheckpointGit(scratch,options),guards:AdoptionRepositoryGuard[]=[];
  for(const node of manifest.repos){
    options.signal?.throwIfAborted();if(await repositoryIdentity(node.commonDir)!==node.identity)throw Error("原项目仓库目录归属已变化");const gitDir=await fs.realpath(await git.text(node.source,["rev-parse","--absolute-git-dir"])),commonDir=await fs.realpath(await git.text(node.source,["rev-parse","--path-format=absolute","--git-common-dir"]));if(!sameCheckpointPath(gitDir,node.gitDir)||!sameCheckpointPath(commonDir,node.commonDir))throw Error("原项目仓库目录归属已变化");
    const index=await git.text(node.source,["rev-parse","--path-format=absolute","--git-path","index"]),files=new Set([index,path.join(gitDir,"HEAD"),path.join(commonDir,"config"),path.join(gitDir,"config.worktree"),path.join(commonDir,"packed-refs"),path.join(commonDir,"shallow"),path.join(gitDir,"info/sparse-checkout"),path.join(gitDir,"info/exclude")]);if(node.sharedName)files.add(path.join(path.dirname(index),node.sharedName));if(node.branch)files.add(await git.text(node.source,["rev-parse","--path-format=absolute","--git-path",node.branch]));
    // A prepared branch verification also locks the primary worktree's HEAD.
    // Linked worktrees have a separate HEAD that needs its own lease.
    const metadata=[];for(const file of files)metadata.push(await fileGuard(file,options.signal));const lockPaths=[index+".lock",path.join(commonDir,"config.lock"),path.join(gitDir,"config.worktree.lock"),path.join(commonDir,"packed-refs.lock"),path.join(commonDir,"shallow.lock")];if(node.branch&&!sameCheckpointPath(gitDir,commonDir))lockPaths.push(path.join(gitDir,"HEAD.lock"));
    guards.push(adoptionRepositoryGuard.parse({source:node.source,gitDir,commonDir,identity:node.identity,format:node.format,head:node.head,branch:node.branch,index,lockPaths,refs:[{name:node.branch||"HEAD",oid:node.head}],metadata}));
  }return guards;
}
export async function assertAdoptionRepositoryGuards(guards:AdoptionRepositoryGuard[],scratch:string,options:Options={}){
  const git=new CheckpointGit(scratch,options);for(const guard of guards){
    if(await repositoryIdentity(guard.commonDir)!==guard.identity||!sameCheckpointPath(await fs.realpath(await git.text(guard.source,["rev-parse","--absolute-git-dir"])),guard.gitDir))throw Error("原项目仓库目录归属已变化");
    for(const expected of guard.metadata){const actual=await fileGuard(expected.file,options.signal);if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error("原项目索引、配置或引用在审阅后发生变化");}
    let head:string|undefined;try{head=await git.text(guard.source,["rev-parse","--verify","--quiet","HEAD"]);}catch(error){if(guard.head)throw error;}if(head!==guard.head)throw Error("原项目索引、配置或引用在审阅后发生变化");
  }
}
function write(stream:Writable,value:string){return new Promise<void>((resolve,reject)=>stream.write(value,error=>error?reject(error):resolve()));}
/** Keep a real prepared Git verify transaction alive across the callback. Git
 * owns ref locking/cleanup; abort never changes source refs or their reflogs. */
async function withRefLease<T>(scratch:string,cwd:string,refs:{name:string;oid?:string}[],options:Options,action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const git=new CheckpointGit(scratch,{native:options.native}),lost=new AbortController(),activeSignal=options.signal?AbortSignal.any([options.signal,lost.signal]):lost.signal;let readyResolve!:()=>void,readyReject!:(error:unknown)=>void,closing=false,prepared=false,result:T|undefined,reached=false,actionError:unknown;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>{});
  await git.run(cwd,["update-ref","--stdin"],{env:handoffGitEnvironment,produceInput:async input=>{
    try{await write(input,"start\n"+refs.map(ref=>{if(!/^(?:HEAD|refs\/[^\s\x00-\x20]+)$/.test(ref.name))throw Error("原项目引用名称无法安全核对");if(ref.oid)checkpointOid.parse(ref.oid);return`verify ${ref.name} ${ref.oid||"0".repeat(40)}\n`;}).join("")+"prepare\n");await ready;activeSignal.throwIfAborted();result=await action(activeSignal);reached=true;}catch(error){actionError=error;}
    finally{closing=true;try{if(prepared&&!input.destroyed)await write(input,"abort\n");}finally{input.end();}}
  },consumeOutput:async output=>{
    let pending="";try{for await(const chunk of output){pending+=chunk.toString("utf8");let at:number;while((at=pending.indexOf("\n"))>=0){const line=pending.slice(0,at).replace(/\r$/,"");pending=pending.slice(at+1);if(line==="prepare: ok"){prepared=true;readyResolve();}else if(!["start: ok","abort: ok",""].includes(line))throw Error("Git 引用租约返回了无法验证的状态");}}}
    finally{if(!closing){const error=Error("原项目引用租约已丢失，采用已停止");lost.abort(error);readyReject(error);}}
  }});if(actionError)throw actionError;if(!reached)throw Error("原项目引用租约未完成");return result!;
}
/** Index/config/HEAD leases and prepared ref transactions span the entire action.
 * Every lease is exclusive, and cleanup only removes the exact created inode. */
export async function withAdoptionRepositoryLeases<T>(guards:AdoptionRepositoryGuard[],scratch:string,options:Options,action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(process.platform==="win32"&&options.native!==false){
    await assertAdoptionRepositoryGuards(guards,scratch,options);const git=new CheckpointGit(scratch,options);for(const guard of guards)if(await git.text(guard.source,["rev-parse","--show-ref-format"])!=="files")throw Error("当前仓库引用后端需要先明确崩溃恢复策略");
    return withWindowsRepositoryLease(guards,scratch,options,async signal=>{await assertAdoptionRepositoryGuards(guards,scratch,{...options,signal});signal.throwIfAborted();return action(signal);});
  }
  await assertAdoptionRepositoryGuards(guards,scratch,options);const held:{file:string;identity:string;sha256:string;handle:Awaited<ReturnType<typeof fs.open>>}[]=[];
  try{
    const names=[...new Set(guards.flatMap(guard=>guard.lockPaths))].sort();for(const file of names){options.signal?.throwIfAborted();const handle=await fs.open(file,"wx",0o600);let recorded=false;try{const value=`Codex Relay adoption lease ${randomUUID()}\n`;await handle.writeFile(value);await handle.sync();const stat=await handle.stat({bigint:true});held.push({file,identity:`${stat.dev}:${stat.ino}`,sha256:hash(value),handle});recorded=true;}finally{if(!recorded)await handle.close();}}
    await assertAdoptionRepositoryGuards(guards,scratch,options);const groups=new Map<string,{cwd:string;refs:Map<string,{name:string;oid?:string}>}>();
    for(const guard of guards){const cwd=guard.branch?guard.commonDir:guard.gitDir;let group=groups.get(key(cwd));if(!group){group={cwd,refs:new Map()};groups.set(key(cwd),group);}for(const ref of guard.refs){const value={...ref,oid:ref.oid||"0".repeat(guard.format==="sha1"?40:64)},previous=group.refs.get(ref.name);if(previous&&previous.oid!==value.oid)throw Error("同一原项目引用绑定了不同的审阅状态");group.refs.set(ref.name,value);}}
    const values=[...groups.values()].sort((a,b)=>key(a.cwd)<key(b.cwd)?-1:1),enter=async(index:number,signal:AbortSignal):Promise<T>=>{if(index===values.length){await assertAdoptionRepositoryGuards(guards,scratch,{...options,signal});signal.throwIfAborted();return action(signal);}return withRefLease(scratch,values[index].cwd,[...values[index].refs.values()],{native:options.native,signal},next=>enter(index+1,next));};
    // Preparing refs can race an earlier checkout. Recheck HEAD and metadata
    // after all Git-owned locks are held, before any source mutation starts.
    return await enter(0,options.signal||new AbortController().signal);
  }finally{
    const errors:unknown[]=[];for(const lease of held.reverse())try{await lease.handle.close();const stat=await fs.lstat(lease.file,{bigint:true});if(`${stat.dev}:${stat.ino}`!==lease.identity||(await checkpointFingerprint(lease.file)).sha256!==lease.sha256)throw Error("原项目锁文件归属已变化，已保留现场");await fs.unlink(lease.file);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,"原项目采用租约未能完整释放，已保留现场");
  }
}
