import {EventEmitter} from "node:events";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {expect,it,vi} from "vitest";
import {ServerRuntime} from "../src/server/runtime";
import type {Worker,WorkerContext,Outcome} from "../src/core/worker";

class Peer extends EventEmitter implements Worker {
  settle!:(outcome:Outcome)=>void;done=new Promise<Outcome>(resolve=>{this.settle=resolve;});started=false;
  requested:boolean;
  constructor(readonly ctx:WorkerContext){super();this.requested=!!ctx.job.goalStartRequested;}
  async start(){await this.ctx.checkpoint(this.ctx.job.threadId||"server-thread","turn");this.started=true;}
  async stop(){this.settle({kind:"interrupted"});}
  async close(){}
  async quota(){return {};}
  respond(){}
  operation=vi.fn(async(_method:string,params:any):Promise<unknown>=>({goal:{...this.ctx.job.goal,status:params.status}}));
}
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-server-shutdown-intent-")),workspace=path.join(root,"workspace"),data=path.join(root,"data");await fs.mkdir(workspace);
 let runtime=await ServerRuntime.open(data,undefined,[workspace]);const peers:Peer[]=[];
 const prepare=async()=>{
  await runtime.scheduler.dispatch(true);runtime.store.data.settings.resetWarmupEnabled=false;
  runtime.store.data.accounts=[{id:"a",identity:"synthetic",label:"test",email:"",plan:"test",enabled:true,status:"ready",failureCount:0,blockedUntil:null,quotas:{codex:{limitId:"codex",reached:false,observedAt:Date.now(),primary:{usedPercent:10,windowDurationMins:300,resetsAt:Date.now()+3600000},secondary:null}}}];
  vi.spyOn(runtime.accounts,"inspect").mockImplementation(async()=>({auth:{tokens:{access_token:"synthetic"}},models:[],quotas:runtime.store.data.accounts[0].quotas}) as any);
  (runtime.scheduler as any).factories={cli:(ctx:WorkerContext)=>{const peer=new Peer(ctx);peers.push(peer);return peer;},desktop:()=>{throw Error("No desktop inference");}};
 };
 await prepare();
 return {root,workspace,data,peers,get runtime(){return runtime;},async reopen(){runtime=await ServerRuntime.open(data,undefined,[workspace]);await prepare();return runtime;},async close(){await runtime.close();await fs.rm(root,{recursive:true,force:true});}};
}
it.skipIf(process.platform!=="linux")("preserves an active Goal and an authorized deferred input through a complete service restart",async()=>{
 const f=await fixture();
 try{
  const job=await f.runtime.scheduler.add({title:"Restart Goal",prompt:"Work",cwd:f.workspace,mode:"cli",model:"",effort:"",bucket:"codex",sandbox:"workspaceWrite",approvalPolicy:"on-request",interactive:true});await f.runtime.scheduler.dispatch(false);await(f.runtime.scheduler as any).tick();await vi.waitFor(()=>expect(f.peers[0]?.started).toBe(true));
  job.goal={threadId:job.threadId!,status:"active"} as any;job.controlRevision=7;await f.runtime.scheduler.dispatch(true);await f.runtime.close();expect(f.peers[0].operation).not.toHaveBeenCalled();expect(job.goal?.status).toBe("active");expect(job.controlRevision).toBe(7);expect(job.stopIntent).toBeUndefined();
  await f.reopen();const restored=f.runtime.store.data.jobs[0];expect(restored.goal?.status).toBe("active");expect(restored.goalStartRequested).toBe(true);
  await f.runtime.command("chat.confirmedSubmit",{requestId:randomUUID(),controlRevision:7,input:{id:restored.id,text:"Original deferred input",attachments:[],action:"queue"}});expect(restored.messageReceipts).toHaveLength(1);expect(restored.queuedMessages?.map(message=>message.text)).toEqual(["Original deferred input"]);
  await f.runtime.scheduler.dispatch(false);await(f.runtime.scheduler as any).tick();await vi.waitFor(()=>expect(f.peers[1]?.started).toBe(true));expect(f.peers[1].requested).toBe(true);expect(f.peers[1].ctx.job.threadId).toBe("server-thread");expect(f.peers[1].ctx.job.goal?.status).toBe("active");
 }finally{await f.close();}
});
it.skipIf(process.platform!=="linux")("restores a known success after service shutdown during cleanup without another worker",async()=>{
 const f=await fixture();let release!:()=>void;
 try{
  await fs.writeFile(path.join(f.workspace,"artifact"),"done");const job=await f.runtime.scheduler.add({title:"Recorded success",prompt:"Work",cwd:f.workspace,mode:"cli",model:"",effort:"",bucket:"codex",sandbox:"workspaceWrite",approvalPolicy:"on-request",interactive:true,deliveryChecks:[{kind:"file",path:"artifact",label:"Artifact",minBytes:1}]});await f.runtime.scheduler.dispatch(false);await(f.runtime.scheduler as any).tick();await vi.waitFor(()=>expect(f.peers[0]?.started).toBe(true));await f.runtime.scheduler.dispatch(true);
  let entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),cleaning=new Promise<void>(resolve=>{entered=resolve;});f.peers[0].close=async()=>{entered();await gate;};f.peers[0].settle({kind:"completed"});await cleaning;
  const closing=f.runtime.close();await vi.waitFor(()=>expect(job.state).toBe("pausing"));release();await closing;expect(job.completionPending).toBe(true);expect(job.stopIntent).toBeUndefined();
  await f.reopen();const restored=f.runtime.store.data.jobs[0];restored.autoRecovery!.nextAttemptAt=0;await(f.runtime.scheduler as any).tick();await vi.waitFor(()=>expect(restored.state).toBe("completed"));expect(restored.delivery?.reports.at(-1)).toMatchObject({source:"recovery",status:"passed"});expect(restored.completion?.revision).toBe(1);expect(restored.resumeAfterShutdown).toBeUndefined();expect(f.peers).toHaveLength(1);
 }finally{release?.();await f.close();}
});
