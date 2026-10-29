import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomUUID,createHash} from "node:crypto";
import {adoptionNativeRequest,adoptionNativeReceipt,adoptionNativeInspection,type AdoptionNativeRequest,type AdoptionFileProof} from "../shared/handoff-adoption";
import {checkpointFingerprint,checkpointSourcePath,sameCheckpointPath,insideCheckpoint} from "./checkpoint-file";
import {spawnWindowsDomain,releaseWindowsDomain,windowsDomainHost,type DomainChild} from "../core/windows-domain";
import {terminateTree} from "../core/process";
const hash=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
export async function adoptionNativeFileProof(file:string,signal?:AbortSignal):Promise<AdoptionFileProof>{
  const proof=await checkpointFingerprint(file,{signal}),[dev,ino]=proof.identity.split(":");return{dev,ino,bytes:proof.bytes,sha256:proof.sha256};
}
export async function adoptionNativeDirectories(files:string[]){
  const names=new Map<string,string>();for(const file of files){let folder=path.dirname(path.resolve(file));for(;;){names.set(folder.toLowerCase(),folder);const next=path.dirname(folder);if(next===folder)break;folder=next;}}
  const result:AdoptionNativeRequest["directories"]=[];for(const folder of names.values()){const stat=await fs.lstat(folder,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!sameCheckpointPath(folder,await fs.realpath(folder)))throw Error("采用路径的目录归属已变化");result.push({path:folder,dev:String(stat.dev),ino:String(stat.ino)});}return result;
}
/** The caller creates and protects the transaction home before storing any bytes.
 * This writes control metadata only; source mutation requires a separately bound call. */
export async function writeAdoptionNativeRequest(input:Omit<AdoptionNativeRequest,"version"|"directories">){
  const home=await fs.realpath(input.home),root=await fs.realpath(input.root),stat=await fs.lstat(home);if(stat.isSymbolicLink()||!sameCheckpointPath(home,input.home)||!sameCheckpointPath(root,input.root)||sameCheckpointPath(home,root)||insideCheckpoint(root,home)||(await fs.stat(home,{bigint:true})).dev!==(await fs.stat(root,{bigint:true})).dev)throw Error("采用恢复目录必须独立并位于来源所在卷");
  const marker=JSON.parse(await fs.readFile(await checkpointSourcePath(home,".relay-adoption.json"),"utf8"));if(marker.version!==1||marker.id!==input.transactionId||marker.owner!==input.owner||!sameCheckpointPath(marker.root,root))throw Error("采用恢复目录归属已变化");
  // Parse the path/identity fields before constructing any filesystem target.
  const preliminary=adoptionNativeRequest.parse({version:1,...input,directories:[{path:home,dev:"0",ino:"0"}]}),file=await checkpointSourcePath(home,`requests/${preliminary.id}.json`).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return path.join(home,"requests",`${preliminary.id}.json`);});
  const files=[path.join(root,...preliminary.path.split("/")),file,path.join(home,"actual",preliminary.id),path.join(home,"before",preliminary.id),path.join(home,"receipts",preliminary.id+".json"),path.join(home,".relay-adoption.json"),...(preliminary.stage?[path.join(home,...preliminary.stage.split("/"))]:[]),...(preliminary.metadataSource?[path.join(home,...preliminary.metadataSource.path.split("/"))]:[])],request=adoptionNativeRequest.parse({...preliminary,directories:await adoptionNativeDirectories(files)}),json=JSON.stringify(request),output=await fs.open(file,"wx",0o600);
  try{await output.writeFile(json);await output.sync();}finally{await output.close();}if((await checkpointFingerprint(file)).sha256!==hash(json))throw Error("采用操作记录完整性未通过");return{request,file,sha256:hash(json)};
}
export async function prepareAdoptionNativeRequest(input:Omit<AdoptionNativeRequest,"version"|"directories"|"beforeMetadata"|"afterMetadata">,options:{signal?:AbortSignal;executable?:string}={}){
  const probe=await writeAdoptionNativeRequest({...input,id:randomUUID()}),view=adoptionNativeInspection.parse(await runAdoptionNative("inspect",probe,options));
  const matches=(actual:AdoptionFileProof|null,expected?:AdoptionFileProof)=>!actual&&!expected||!!actual&&!!expected&&actual.dev===expected.dev&&actual.ino===expected.ino&&actual.bytes===expected.bytes&&actual.sha256===expected.sha256;
  if(!matches(view.target,input.before)||!matches(view.stage,input.after)||input.before&&!view.targetMetadata||input.after&&!view.stageMetadata)throw Error("采用文件在核对权限前发生变化");
  if(input.creationSecurity&&JSON.stringify(input.creationSecurity)!==JSON.stringify(view.creationSecurity))throw Error("新文件的目标目录权限已变化，请重新核对");
  return writeAdoptionNativeRequest({...input,creationSecurity:view.creationSecurity,beforeMetadata:input.before?view.targetMetadata!:undefined,afterMetadata:input.after?view.stageMetadata!:undefined});
}
/** Runtime ownership is mandatory: helper processes terminate with their main
 * process or cancellation, leaving the transaction journal available to inspect. */
export async function runAdoptionNative(command:"apply"|"inspect",plan:{request:AdoptionNativeRequest;file:string;sha256:string},options:{signal?:AbortSignal;executable?:string}={}){
  if(process.platform!=="win32")throw Error("此采用操作需要 Windows 文件组件");options.signal?.throwIfAborted();adoptionNativeRequest.parse(plan.request);
  if(command==="apply"&&(plan.request.before&&!plan.request.beforeMetadata||plan.request.after&&!plan.request.afterMetadata))throw Error("采用操作尚未核对文件权限和属性");
  const json=await fs.readFile(plan.file);if(hash(json)!==plan.sha256||JSON.stringify(adoptionNativeRequest.parse(JSON.parse(json.toString("utf8"))))!==JSON.stringify(plan.request))throw Error("采用操作记录完整性未通过");
  const executable=await fs.realpath(options.executable||path.join(path.dirname(await windowsDomainHost()),"RelayAdoptionHost.exe")),parent=await fs.realpath(os.tmpdir()),home=await fs.mkdtemp(path.join(parent,"relay-adopt-run-")),claim=randomUUID();await fs.writeFile(path.join(home,".relay-adoption-process.json"),JSON.stringify({version:1,claim}),{flag:"wx",mode:0o600});
  let child:DomainChild|undefined,operationError:unknown,stopping:Promise<void>|undefined,bootstrapTimer:ReturnType<typeof setTimeout>|undefined,bootstrapError:Error|undefined;const stop=()=>{if(child){stopping??=terminateTree(child);void stopping.catch(()=>{});}};
  try{
    const standard=/^(SystemRoot|windir|SystemDrive|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|CommonProgramFiles|CommonProgramFiles\(x86\)|USERDOMAIN|USERNAME|COMPUTERNAME|HOMEDRIVE|HOMEPATH|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|NUMBER_OF_PROCESSORS|OS)$/i;
    const env:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>standard.test(key)));env.PATH=path.join(process.env.SystemRoot||"C:/Windows","System32");
    child=await spawnWindowsDomain(executable,[command,plan.file,plan.sha256],home,env);const running=child,closed=new Promise<number|null>((resolve,reject)=>{running.once("error",reject);running.once("close",resolve);if(running.exitCode!==null)resolve(running.exitCode);});let stderr="";running.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-16000);});
    // A loader failure can display a Windows dialog before the managed host enters
    // Main. Require its durable pre-child receipt; this is a startup deadline,
    // not a limit on hashing or applying large files. Killing this owned host also
    // closes any contained job if receipt publication races with the check.
    bootstrapTimer=setTimeout(()=>{void(async()=>{if(running.exitCode!==null||running.signalCode!==null)return;const domain=running.relayDomain!;try{await fs.lstat(path.join(domain.owner.home,`relay-domain-${domain.owner.nonce}.json`));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")return;bootstrapError=Error("采用组件未完成受管启动，恢复记录已保留");running.kill();}})();},20000);
    options.signal?.addEventListener("abort",stop,{once:true});if(options.signal?.aborted)stop();running.stdin.end();let bytes=0;const chunks:Buffer[]=[];
    const read=(async()=>{for await(const chunk of running.stdout){bytes+=chunk.length;if(!Number.isSafeInteger(bytes))throw Error("采用组件返回了无法验证的控制记录");chunks.push(Buffer.from(chunk));}})().catch(error=>{stop();throw error;});
    const results=await Promise.allSettled([read,closed]);await stopping;options.signal?.throwIfAborted();if(bootstrapError)throw bootstrapError;for(const result of results)if(result.status==="rejected")throw result.reason;const code=(results[1]as PromiseFulfilledResult<number|null>).value;if(code!==0)throw Error("Windows 文件采用未完成，完整备份和中断记录已保留",{cause:Error(stderr)});
    const result=JSON.parse(Buffer.concat(chunks).toString("utf8")),view=command==="apply"?adoptionNativeReceipt.parse(result):adoptionNativeInspection.parse(result);if(view.id!==plan.request.id||view.transactionId!==plan.request.transactionId||"requestSha256"in view&&view.requestSha256!==plan.sha256)throw Error("采用操作回执与当前计划不一致");return view;
  }catch(error){operationError=error;throw error;}finally{
    if(bootstrapTimer)clearTimeout(bootstrapTimer);
    options.signal?.removeEventListener("abort",stop);if(child?.relayDomain){const domain=child.relayDomain;try{await releaseWindowsDomain(domain.owner.home,domain.owner.nonce);}catch(error){throw operationError?new AggregateError([operationError,error],"采用组件进程归属无法释放，恢复记录已保留"):error;}}
    const actual=await fs.realpath(home),marker=JSON.parse(await fs.readFile(path.join(actual,".relay-adoption-process.json"),"utf8"));if(path.dirname(actual)!==parent||!path.basename(actual).startsWith("relay-adopt-run-")||(await fs.lstat(home)).isSymbolicLink()||marker.claim!==claim)throw Error("采用临时进程目录归属已变化");await fs.rm(actual,{recursive:true,force:true});
  }
}
