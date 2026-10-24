import {spawn,execFile,type ChildProcessWithoutNullStreams} from "node:child_process";
import {promisify} from "node:util";
import {promises as fs} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {atomicWrite} from "./store";

const ownerSchema=z.object({version:z.literal(2),kind:z.literal("windows-job"),nonce:z.string().uuid(),pid:z.number().int().nonnegative(),launcherPid:z.number().int().positive(),launcherCreated:z.string().regex(/^[1-9]\d+$/),home:z.string()});
const viewSchema=z.object({nonce:z.string().uuid(),active:z.number().int().nonnegative(),attested:z.literal(true),phase:z.enum(["prepared","running","stopped","stopping","closed"])});
export type WindowsDomainOwner=z.infer<typeof ownerSchema>;
export type DomainChild=ChildProcessWithoutNullStreams&{relayDomain?:{owner:WindowsDomainOwner;ownerFile:string}};
let launcherIdentity:Promise<string>|undefined;
async function launcherCreated(host:string){
  launcherIdentity??=promisify(execFile)(host,["identity",String(process.pid)],{windowsHide:true,timeout:10000,maxBuffer:65536}).then(({stdout})=>{const value=z.object({pid:z.literal(process.pid),created:z.string().regex(/^[1-9]\d+$/)}).parse(JSON.parse(stdout));return value.created;}).catch(error=>{launcherIdentity=undefined;throw error;});
  return launcherIdentity;
}
export async function windowsDomainHost(){
  const resources=(process as NodeJS.Process&{resourcesPath?:string}).resourcesPath;
  const candidates=[resources&&path.join(resources,"windows","RelayJobHost.exe"),path.resolve(__dirname,"../native/RelayJobHost.exe"),path.resolve(__dirname,"../../dist/native/RelayJobHost.exe")].filter((v):v is string=>!!v);
  for(const file of candidates)try{if((await fs.stat(file)).isFile())return await fs.realpath(file);}catch{}
  throw Error("Windows 进程管理组件缺失，请重新安装完整程序包");
}
export async function inspectWindowsDomain(home:string,expectedNonce?:string,stop=false){
  const actual=await fs.realpath(home),ownerFile=path.join(actual,"relay-owner.json"),owner=ownerSchema.parse(JSON.parse(await fs.readFile(ownerFile,"utf8")));
  if(path.resolve(owner.home).toLowerCase()!==actual.toLowerCase()||expectedNonce&&owner.nonce!==expectedNonce)throw Error("进程归属记录已变化");
  const {stdout}=await promisify(execFile)(await windowsDomainHost(),[stop?"stop":"inspect",ownerFile],{windowsHide:true,timeout:20000,maxBuffer:65536});
  const view=viewSchema.parse(JSON.parse(stdout));if(view.nonce!==owner.nonce)throw Error("进程归属回执不匹配");return view;
}
export async function releaseWindowsDomain(home:string,nonce:string){
  if(!z.string().uuid().safeParse(nonce).success)throw Error("进程归属回执不匹配");
  const {stdout}=await promisify(execFile)(await windowsDomainHost(),["release",path.join(await fs.realpath(home),"relay-owner.json"),nonce],{windowsHide:true,timeout:20000,maxBuffer:65536});
  const view=viewSchema.parse(JSON.parse(stdout));if(view.nonce!==nonce||view.active)throw Error("受管进程域仍在使用");return view;
}
export async function stopWindowsDomain(home:string,nonce:string){
  if(!z.string().uuid().safeParse(nonce).success)throw Error("进程归属回执不匹配");
  const {stdout}=await promisify(execFile)(await windowsDomainHost(),["stop-run",path.join(await fs.realpath(home),"relay-owner.json"),nonce],{windowsHide:true,timeout:20000,maxBuffer:65536});
  const view=viewSchema.parse(JSON.parse(stdout));if(view.nonce!==nonce||view.active)throw Error("受管进程域仍在使用");return view;
}
export async function spawnWindowsDomain(executable:string,args:string[],home:string,env:NodeJS.ProcessEnv,nonce:string=randomUUID()):Promise<DomainChild>{
  const host=await windowsDomainHost(),actual=await fs.realpath(home),target=await fs.realpath(executable);
  const ownerFile=path.join(actual,"relay-owner.json"),requestFile=path.join(actual,`relay-domain-${nonce}.request.json`);
  const owner:WindowsDomainOwner={version:2,kind:"windows-job",nonce,pid:0,launcherPid:process.pid,launcherCreated:await launcherCreated(host),home:actual};
  // Exclusive durable claim closes the check-then-launch race for a runtime home.
  const lease=await fs.open(ownerFile,"wx",0o600);
  try{await lease.writeFile(JSON.stringify(owner));await lease.sync();}finally{await lease.close();}
  let child:DomainChild|undefined;
  try{
    await atomicWrite(requestFile,JSON.stringify({version:1,nonce,home:actual,executable:target,args}));
    child=spawn(host,["run",requestFile],{env,cwd:actual,shell:false,windowsHide:true,stdio:["pipe","pipe","pipe"]}) as DomainChild;
    let failure:Error|undefined;child.once("error",error=>{failure=error;});
    child.relayDomain={owner,ownerFile};
    if(!child.pid){await new Promise(resolve=>child!.once("error",resolve));throw failure||Error("Windows 进程管理组件无法启动");}
    owner.pid=child.pid;await atomicWrite(ownerFile,JSON.stringify(owner));return child;
  }catch(error){
    // A started host may own a live job: retain its durable marker for recovery.
    if(!child?.pid){const current=JSON.parse(await fs.readFile(ownerFile,"utf8").catch(()=>"{}"));if(current.nonce===nonce)await fs.rm(ownerFile);}
    throw error;
  }
}
