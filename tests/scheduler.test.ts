import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/core/scheduler";
import { Store } from "../src/core/store";
import { ProcessSafetyError } from "../src/core/process-safety-error";
import type { Worker, WorkerContext, Outcome } from "../src/core/worker";
import type { Account, NewJob } from "../src/shared/types";
import { taskPrompt } from "../src/core/completion";
import { Rpc } from "../src/core/rpc";
import { deliveryAccepted } from "../src/shared/delivery";
import { respondApproval } from "../src/core/approval-command";
class FakeWorker extends EventEmitter implements Worker {
  submitted = "";
  steer = vi.fn(async () => {});
  agentControl = vi.fn(
    async (
      _threadId: string,
      _action: "send" | "interrupt",
      _text?: string,
    ): Promise<unknown> => ({}),
  );
  operation = vi.fn(
    async (
      _method: string,
      _params: Record<string, unknown>,
    ): Promise<unknown> => ({}),
  );
  settle!: (o: Outcome) => void;
  done = new Promise<Outcome>((r) => {
    this.settle = r;
  });
  started = false;
  failClose = false;
  constructor(public ctx: WorkerContext) {
    super();
  }
  async start() {
    this.submitted = taskPrompt(this.ctx);
    await this.ctx.checkpoint(
      this.ctx.job.threadId || "stable-thread",
      this.ctx.job.turnId ?? "first-turn",
    );
    this.started = true;
  }
  async stop() {
    this.settle({ kind: "interrupted" });
  }
  async close() {
    if (this.failClose) throw new Error("Still running");
  }
  async quota() {
    return {};
  }
  respond() {}
}
it("recovers a successful turn after cleanup failed without starting another worker",async()=>{
 const job=await scheduler.add({...input,cwd:root,interactive:true});await until(()=>workers[0]?.started);
 workers[0].failClose=true;workers[0].settle({kind:"completed"});await(scheduler as any).currentRun;
 expect(job.recoveryRequired).toBe(true);workers[0].failClose=false;job.autoRecovery!.nextAttemptAt=0;
 await(scheduler as any).tick();await until(()=>!job.recoveryRequired);await until(()=>!(scheduler as any).recoveryTasks.size);
 await(scheduler as any).tick();expect(job.state).toBe("completed");expect(workers).toHaveLength(1);expect(job.completion?.revision).toBe(1);
});
it("automatically flushes a retained completed answer after storage recovers without another worker or UI read",async()=>{
 const job=await scheduler.add({...input,cwd:root,interactive:true});await until(()=>workers[0]?.started);
 const append=fs.appendFile.bind(fs);let offline=true,release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),writing=new Promise<void>(r=>{entered=r;});
 const fault=vi.spyOn(fs,"appendFile").mockImplementation(async(file,data,options)=>{
  if(String(file)===scheduler.chats.file(job.id)&&offline){if(String(data).includes('"kind":"plan"')){entered();await gate;}throw Error("journal storage offline");}await append(file,data,options);
 });
 let restoreClock=()=>{};
 try{
 workers[0].emit("chat","turn/plan/updated",{turnId:job.turnId,plan:[]});await writing;
 workers[0].emit("chat","item/completed",{turnId:job.turnId,item:{id:"final",type:"agentMessage",text:"Recovered exact answer"}});workers[0].settle({kind:"completed"});
 await until(()=>!!job.completionPending);const checkpointAt=job.completion!.finishedAt,originalNow=Date.now.bind(Date),clock=vi.spyOn(Date,"now").mockImplementation(()=>originalNow()+1000);restoreClock=()=>clock.mockRestore();
 release();await(scheduler as any).currentRun;
 expect(job.recoveryRequired).toBe(true);expect(job.completionPending).toBe(true);offline=false;job.autoRecovery!.nextAttemptAt=0;
 await(scheduler as any).tick();await until(()=>!(scheduler as any).recoveryTasks.size);await(scheduler as any).tick();expect(job.state).toBe("completed");expect(workers).toHaveLength(1);
 const answer=await scheduler.chats.latestAssistant(job.id,job.completion);expect(answer).toMatchObject({text:"Recovered exact answer",status:"completed",turnId:job.turnId});expect(answer!.at).toBeGreaterThan(checkpointAt);
 }finally{offline=false;release();restoreClock();fault.mockRestore();}
});
it.each([true,false])("recovers the saved success then rechecks delivery (artifact exists: %s) without inference",async(exists)=>{
 const job=await scheduler.add({...input,cwd:root,interactive:true,deliveryChecks:[{kind:"file",path:"artifact",label:"Artifact",minBytes:1}]});await until(()=>workers[0]?.started);
 if(exists)await fs.writeFile(path.join(root,"artifact"),"done");workers[0].failClose=true;workers[0].settle({kind:"completed"});await(scheduler as any).currentRun;
 expect(job.delivery?.reports).toHaveLength(0);workers[0].failClose=false;job.autoRecovery!.nextAttemptAt=0;
 await(scheduler as any).tick();await until(()=>!(scheduler as any).recoveryTasks.size);await(scheduler as any).tick();
 expect(job.state).toBe(exists?"completed":"needs_attention");expect(job.delivery?.reports.at(-1)).toMatchObject({source:"recovery",status:exists?"passed":"failed"});expect(workers).toHaveLength(1);
 expect(job.completionPending).toBeUndefined();expect(job.completion?.revision).toBe(1);
});
it.each(["pause","cancel"] as const)("keeps a later %s authoritative while recovering a saved completion",async(action)=>{
 const job=await scheduler.add({...input,cwd:root,interactive:true});await until(()=>workers[0]?.started);
 workers[0].failClose=true;workers[0].settle({kind:"completed"});await(scheduler as any).currentRun;workers[0].failClose=false;
 let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(r=>{release=r;}),checking=new Promise<void>(r=>{entered=r;});
 (scheduler as any).recover=async()=>{entered();await blocked;};job.autoRecovery!.nextAttemptAt=0;await(scheduler as any).tick();await checking;
 const stopped=scheduler.control(job.id,action);await until(()=>job.stopIntent===action);release();await stopped;
 await until(()=>!(scheduler as any).recoveryTasks.size);await(scheduler as any).tick();expect(job.state).toBe(action==="pause"?"paused":"cancelled");expect(workers).toHaveLength(1);expect(job.completionPending).toBeUndefined();
});
it("lets an explicit resume finalize a saved success after failed cleanup without another worker",async()=>{
 const job=await scheduler.add({...input,cwd:root,interactive:true});await until(()=>workers[0]?.started);workers[0].failClose=true;workers[0].settle({kind:"completed"});await(scheduler as any).currentRun;
 workers[0].failClose=false;await scheduler.control(job.id,"resume");await(scheduler as any).tick();expect(job.state).toBe("completed");expect(workers).toHaveLength(1);
});
it("retains the completion receipt after final state persistence fails",async()=>{
 const job=await scheduler.add({...input,cwd:root,interactive:true});await until(()=>workers[0]?.started);
 const original=store.save.bind(store);let failed=false;vi.spyOn(store,"save").mockImplementation(async()=>{if(!failed&&job.state==="completed"&&!job.completionPending){failed=true;throw Error("final state interrupted");}await original();});
 workers[0].settle({kind:"completed"});await(scheduler as any).currentRun;expect(failed).toBe(true);expect(job.completionPending).toBe(true);
 job.autoRecovery!.nextAttemptAt=0;await(scheduler as any).tick();await until(()=>!(scheduler as any).recoveryTasks.size);await(scheduler as any).tick();expect(job.state).toBe("completed");expect(workers).toHaveLength(1);
});
it("rolls back a failed completion handoff while preserving a newly accepted queue message",async()=>{
 const job=await scheduler.add({...input,cwd:root,interactive:true});await until(()=>workers[0]?.started);
 await scheduler.send({id:job.id,text:"NEXT INPUT",attachments:[],action:"queue"});const nextId=job.queuedMessages![0].id;
 const original=store.save.bind(store);let failed=false,release!:()=>void,entered!:()=>void;
 const blocked=new Promise<void>(r=>{release=r;}),writing=new Promise<void>(r=>{entered=r;});
 vi.spyOn(store,"save").mockImplementation(async()=>{if(!failed&&job.state==="queued"&&!job.completionPending&&job.pendingMessage==="NEXT INPUT"){failed=true;entered();await blocked;throw Error("handoff state interrupted");}await original();});
 workers[0].settle({kind:"completed"});await writing;
 await scheduler.send({id:job.id,text:"LATER INPUT",attachments:[],action:"queue"},crypto.randomUUID());release();await(scheduler as any).currentRun;
 expect(job.completionPending).toBe(true);expect(job.pendingMessage).toBeUndefined();expect(job.queuedMessages?.map(m=>m.text)).toEqual(["NEXT INPUT","LATER INPUT"]);expect(job.queuedMessages?.[0].id).toBe(nextId);expect(job.messageReceipts).toHaveLength(1);
 job.autoRecovery!.nextAttemptAt=0;await(scheduler as any).tick();await until(()=>!(scheduler as any).recoveryTasks.size);await(scheduler as any).tick();await until(()=>workers[1]?.started);
 expect(workers).toHaveLength(2);expect(workers[1].submitted).toBe("NEXT INPUT");expect(job.queuedMessages?.map(m=>m.text)).toEqual(["LATER INPUT"]);expect(job.completion?.revision).toBe(1);
});
it("persists a completion receipt before cleanup so a restart only finalizes the known result",async()=>{
 const job=await scheduler.add({...input,cwd:root,interactive:true});await until(()=>workers[0]?.started);
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),closing=new Promise<void>(r=>{entered=r;});
 workers[0].close=async()=>{entered();await gate;};workers[0].settle({kind:"completed"});
 let saved:string;
 try{await closing;saved=await fs.readFile(path.join(root,"state.json"),"utf8");expect(JSON.parse(saved).jobs[0].completionPending).toBe(true);}
 finally{release();await(scheduler as any).currentRun;}
 await fs.writeFile(path.join(root,"state.json"),saved!);const disk=new Store(root);await disk.load();store.data=disk.data;
 const restored=store.data.jobs[0];expect(restored.recoveryRequired).toBe(true);restored.autoRecovery!.nextAttemptAt=0;
 const recover=vi.fn(async()=>{});(scheduler as any).recover=recover;await(scheduler as any).tick();await until(()=>!restored.recoveryRequired);await until(()=>!(scheduler as any).recoveryTasks.size);
 await(scheduler as any).tick();expect(recover).toHaveBeenCalledOnce();expect(restored.state).toBe("completed");expect(restored.completionPending).toBeUndefined();expect(workers).toHaveLength(1);
 const verified=new Store(root);await verified.load();expect(verified.data.jobs[0].state).toBe("completed");
});
it("persists distinct completed worker generations with reused turn IDs but does not count a stopped worker",async()=>{
 const job=await scheduler.add({...input,cwd:root,interactive:true});await until(()=>workers[0]?.started);
 workers[0].settle({kind:"completed"});await(scheduler as any).currentRun;
 expect(job.completion?.revision).toBe(1);expect(job.completion?.turnId).toBe("first-turn");
 expect(job.completion!.finishedAt).toBeGreaterThanOrEqual(job.completion!.startedAt);
 const first={...job.completion!};await scheduler.send({id:job.id,text:"Second turn",attachments:[],action:"queue"});
 await(scheduler as any).tick();await until(()=>workers[1]?.started);workers[1].settle({kind:"completed"});await(scheduler as any).currentRun;
 expect(job.completion?.revision).toBe(2);expect(job.completion?.turnId).toBe(first.turnId);
 const disk=new Store(root);await disk.load();expect(disk.data.jobs[0].completion).toEqual(job.completion);
 await scheduler.send({id:job.id,text:"Stop this turn",attachments:[],action:"queue"});await(scheduler as any).tick();await until(()=>workers[2]?.started);
 await scheduler.control(job.id,"pause");expect(job.state).toBe("paused");expect(job.completion?.revision).toBe(2);
});
it("reports real scheduler ownership and captures distinct changes before renderer snapshot coalescing",async()=>{
  scheduler.runtimeReady=()=>false;const job=await scheduler.add({...input,cwd:root,interactive:true});
  expect(scheduler.operations().cards.find(c=>c.id===job.id)?.gates.map(g=>g.code)).toContain("cli");
  const seen:string[]=[];scheduler.on("operationsObserved",()=>{seen.push(scheduler.operationsObservation().facts.find(f=>f.id===job.id)!.state);});
  job.state="preparing";scheduler.changed();job.state="running";scheduler.changed();expect(seen).toEqual(["preparing","running"]);job.state="paused";
  const controls:boolean[]=[];scheduler.on("operationsObserved",()=>controls.push(scheduler.operationsObservation().facts.find(f=>f.id===job.id)!.controlling));
  let release!:()=>void;(scheduler as any).controls=new Promise<void>(resolve=>{release=resolve;});
  try{const pause=scheduler.control(job.id,"pause");expect(controls).toEqual([true]);release();await pause;expect(controls.at(-1)).toBe(false);}finally{release();}
});
it("never reads task prompts or exposes absolute runtime paths in operational projections",async()=>{
  scheduler.runtimeReady=()=>false;const job=await scheduler.add({...input,cwd:root,interactive:true}),original=job.prompt;
  Object.defineProperty(job,"prompt",{configurable:true,get(){throw Error("Operational projection must not clone prompts");}});
  try{const current=scheduler.operations(),observation=scheduler.operationsObservation();expect(current.cards[0].familyId).toBe(job.id);expect(observation.facts[0].familyId).toBe(job.id);expect(JSON.stringify(current)).not.toContain(root);expect(JSON.stringify(observation)).not.toContain(root);}
  finally{Object.defineProperty(job,"prompt",{configurable:true,writable:true,enumerable:true,value:original});}
});
it("guards every approval kind with a fresh review identity when the protocol reuses a request ID",async()=>{
  const job=await scheduler.add({...input,cwd:root,interactive:true});await until(()=>workers[0]?.started);
  workers[0].emit("approval",{id:"77",jobId:job.id,kind:"command",method:"approval",params:{command:"first"}});
  const old=scheduler.approvals[0];expect(old.reviewId).toBeTruthy();workers[0].emit("approvalResolved","77");
  workers[0].emit("approval",{id:"77",jobId:job.id,kind:"command",method:"approval",params:{command:"different"}});
  const fresh=scheduler.approvals[0],respond=vi.spyOn(workers[0],"respond");expect(fresh.reviewId).not.toBe(old.reviewId);
  expect(()=>respondApproval(scheduler,{id:old.id,jobId:job.id,reviewId:old.reviewId,value:{decision:"accept"}})).toThrow("请求已更新");expect(respond).not.toHaveBeenCalled();
  expect(()=>scheduler.reviewApproval(job.id,old.id,old.reviewId!)).toThrow("请求已更新");
  respondApproval(scheduler,{id:fresh.id,jobId:job.id,reviewId:fresh.reviewId,value:{decision:"decline"}});expect(respond).toHaveBeenCalledOnce();
});
it("invalidates stale delivery evidence durably, holds dependents and releases them only after explicit reacceptance", async () => {
  await fs.writeFile(path.join(root,"result.txt"),"original");
  const parent=await scheduler.add({...input,cwd:root,interactive:true,deliveryChecks:[{kind:"file",path:"result.txt",label:"Artifact",minBytes:1}]});
  await until(()=>workers[0]?.started);workers[0].settle({kind:"completed"});await (scheduler as any).currentRun;
  const baseline=parent.delivery!.reports.at(-1)!;
  await fs.writeFile(path.join(root,"result.txt"),"modified");
  await scheduler.flagDeliveryEvidence(parent.id,1,baseline.id,"changed");
  expect(parent.state).toBe("needs_attention");expect(deliveryAccepted(parent.delivery)).toBe(false);
  const disk=new Store(root);await disk.load();expect(disk.data.jobs[0].delivery?.staleEvidence?.reportId).toBe(baseline.id);
  await scheduler.dispatch(true);
  const dependent=await scheduler.add({...input,cwd:root,interactive:true});await scheduler.dependencies(dependent.id,[parent.id]);
  await scheduler.dispatch(false);await (scheduler as any).tick();expect(workers).toHaveLength(1);
  await scheduler.checkDelivery(parent.id);expect(parent.delivery?.staleEvidence).toBeUndefined();expect(deliveryAccepted(parent.delivery)).toBe(true);
  await (scheduler as any).tick();await until(()=>workers[1]?.started);
});
it("rejects an old evidence invalidation and restores the full completed job after a hold cannot be saved", async () => {
  await fs.writeFile(path.join(root,"result.txt"),"original");
  const job=await scheduler.add({...input,cwd:root,interactive:true,deliveryChecks:[{kind:"file",path:"result.txt",label:"Artifact",minBytes:1}]});
  await until(()=>workers[0]?.started);workers[0].settle({kind:"completed"});await (scheduler as any).currentRun;
  const old=job.delivery!.reports.at(-1)!;await scheduler.checkDelivery(job.id);
  await expect(scheduler.flagDeliveryEvidence(job.id,1,old.id,"changed")).rejects.toThrow("已更新");
  const before=structuredClone(job);const fail=vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));
  await expect(scheduler.flagDeliveryEvidence(job.id,1,job.delivery!.reports.at(-1)!.id,"unverified")).rejects.toThrow("disk full");
  fail.mockRestore();expect(job).toEqual(before);expect(deliveryAccepted(job.delivery)).toBe(true);
});
it("guards batch verification by contract/report identity and does not record a pre-aborted check", async () => {
  await fs.writeFile(path.join(root,"result.txt"),"original");
  const job=await scheduler.add({...input,cwd:root,interactive:true,deliveryChecks:[{kind:"file",path:"result.txt",label:"Artifact",minBytes:1}]});
  await until(()=>workers[0]?.started);expect(()=>scheduler.deliveryTarget(job.id)).toThrow("正在运行");
  workers[0].settle({kind:"completed"});await (scheduler as any).currentRun;
  const report=job.delivery!.reports.at(-1)!,before=structuredClone(job);
  const controller=new AbortController();controller.abort();
  await expect(scheduler.checkDelivery(job.id,"manual",controller.signal)).rejects.toThrow();expect(job).toEqual(before);
  await expect(scheduler.checkDelivery(job.id,"manual",undefined,{revision:0,reportId:report.id})).rejects.toThrow("已更新");
  expect(job).toEqual(before);
});
it("verifies delivery only after the worker closes and includes the contract in the prompt", async () => {
  const job = await scheduler.add({...input,cwd:root,interactive:true,deliveryChecks:[{kind:"contains",path:"result.txt",label:"Result",text:"verified"}]});
  await until(()=>workers[0]?.started);
  expect(workers[0].submitted).toContain('"result.txt"');
  vi.spyOn(workers[0],"close").mockImplementation(async()=>{await fs.writeFile(path.join(root,"result.txt"),"verified");});
  workers[0].settle({kind:"completed"});await (scheduler as any).currentRun;
  expect(job.state).toBe("completed");expect(job.delivery?.reports.at(-1)).toMatchObject({status:"passed",source:"automatic"});
  const disk=new Store(root);await disk.load();expect(disk.data.jobs.find(j=>j.id===job.id)?.delivery?.reports.at(-1)?.status).toBe("passed");
});
it("blocks dependent tasks on failed delivery and releases them after explicit successful recheck", async () => {
  scheduler.runtimeReady=()=>false;
  const job=await scheduler.add({...input,cwd:root,deliveryChecks:[{kind:"file",path:"result.txt",label:"Result",minBytes:1}]});
  const dependent=await scheduler.add({...input,cwd:root,title:"Dependent"});dependent.dependsOn=[job.id];
  scheduler.runtimeReady=()=>true;await (scheduler as any).tick();await until(()=>workers[0]?.started);
  workers[0].settle({kind:"completed"});await (scheduler as any).currentRun;
  expect(job.state).toBe("needs_attention");expect(job.delivery?.reports.at(-1)?.status).toBe("failed");
  await (scheduler as any).tick();expect(workers).toHaveLength(1);expect(scheduler.deliveryPrompt(job.id)).toContain("result.txt");
  await fs.writeFile(path.join(root,"result.txt"),"done");await scheduler.checkDelivery(job.id);
  expect(job.state).toBe("completed");await (scheduler as any).tick();await until(()=>workers[1]?.started);expect(workers[1].ctx.job.id).toBe(dependent.id);
});
it("preserves follow-ups on failed acceptance and advances one queued message after repair", async () => {
  const job=await scheduler.add({...input,cwd:root,interactive:true,deliveryChecks:[{kind:"file",path:"result.txt",label:"Result",minBytes:1}]});
  await until(()=>workers[0]?.started);job.queuedMessages=[{id:crypto.randomUUID(),text:"Follow-up",attachments:[]}];
  workers[0].settle({kind:"completed"});await (scheduler as any).currentRun;
  expect(job.queuedMessages).toHaveLength(1);expect(job.state).toBe("needs_attention");
  await fs.writeFile(path.join(root,"result.txt"),"done");await scheduler.checkDelivery(job.id);
  expect(job.state).toBe("queued");expect(job.pendingMessage).toBe("Follow-up");expect(job.queuedMessages).toHaveLength(0);
  expect((await scheduler.chats.read(job.id)).items.filter(i=>i.role==="user"&&i.text==="Follow-up")).toHaveLength(1);
});
it("does not publish passing delivery evidence when persistence fails", async () => {
  scheduler.runtimeReady=()=>false;const job=await scheduler.add({...input,cwd:root,deliveryChecks:[{kind:"file",path:"result.txt",label:"Result",minBytes:1}]});
  job.state="needs_attention";job.delivery!.blockedCompletion=true;await fs.writeFile(path.join(root,"result.txt"),"done");await store.save();
  const save=vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk unavailable"));
  await expect(scheduler.checkDelivery(job.id)).rejects.toThrow("disk unavailable");save.mockRestore();
  expect(job.state).toBe("needs_attention");expect(job.delivery?.reports).toHaveLength(0);expect(job.delivery?.blockedCompletion).toBe(true);
});
it("uses optimistic contract revisions and rejects changes while the family is active", async () => {
  scheduler.runtimeReady=()=>false;const job=await scheduler.add({...input,cwd:root});
  await scheduler.saveDelivery(job.id,0,[{kind:"file",path:"result.txt",label:"Result",minBytes:1}]);
  await expect(scheduler.saveDelivery(job.id,0,[])).rejects.toThrow("已更改");
  scheduler.runtimeReady=()=>true;await (scheduler as any).tick();await until(()=>workers[0]?.started);
  await expect(scheduler.saveDelivery(job.id,1,[])).rejects.toThrow("暂停");
});
it("recovers a persisted post-close verification without sending a new model turn", async () => {
  scheduler.runtimeReady=()=>false;const job=await scheduler.add({...input,cwd:root,deliveryChecks:[{kind:"file",path:"result.txt",label:"Result",minBytes:1}]});
  job.state="running";job.delivery!.pendingCompletion=true;await fs.writeFile(path.join(root,"result.txt"),"done");await store.save();
  const disk=new Store(root);await disk.load();expect(disk.data.jobs[0]).toMatchObject({state:"needs_attention",recoveryRequired:false});
  store.data=disk.data;scheduler.start();await until(()=>store.data.jobs[0].state==="completed");expect(workers).toHaveLength(0);
  expect(store.data.jobs[0].delivery?.reports.at(-1)).toMatchObject({source:"recovery",status:"passed"});
});
it("does not treat an earlier accepted execution as completion after a later execution error", async()=>{
  const job=await scheduler.add({...input,cwd:root,deliveryChecks:[{kind:"file",path:"artifact",label:"Artifact",minBytes:1}]});
  await until(()=>workers[0]?.started);workers[0].settle({kind:"completed"});await (scheduler as any).currentRun;
  expect(job.delivery?.blockedCompletion).toBe(true);await scheduler.control(job.id,"resume");await (scheduler as any).tick();await until(()=>workers[1]?.started);
  workers[1].settle({kind:"error",error:Error("permanent task failure")});await (scheduler as any).currentRun;expect(job.state).toBe("needs_attention");expect(job.delivery?.blockedCompletion).toBe(false);
  await fs.writeFile(path.join(root,"artifact"),"done");await scheduler.checkDelivery(job.id);expect(job.delivery?.reports.at(-1)?.status).toBe("passed");expect(job.state).toBe("needs_attention");
});
it("releases only its own acceptance hold when the user removes all checks",async()=>{
  scheduler.runtimeReady=()=>false;const job=await scheduler.add({...input,cwd:root,deliveryChecks:[{kind:"file",path:"artifact",label:"Artifact",minBytes:1}]});
  job.state="needs_attention";job.delivery!.blockedCompletion=true;job.queuedMessages=[{id:crypto.randomUUID(),text:"Previously queued follow-up",attachments:[]}];
  await scheduler.saveDelivery(job.id,1,[]);expect(job.state).toBe("queued");expect(job.pendingMessage).toBe("Previously queued follow-up");expect(job.delivery?.checks).toEqual([]);expect(workers).toHaveLength(0);
});
it("cancels one verification without cancelling another task's evidence",async()=>{
  scheduler.runtimeReady=()=>false;await fs.writeFile(path.join(root,"artifact"),"done");
  const first=await scheduler.add({...input,cwd:root,deliveryChecks:[{kind:"file",path:"artifact",label:"One",minBytes:1}]}),second=await scheduler.add({...input,cwd:root,deliveryChecks:[{kind:"file",path:"artifact",label:"Two",minBytes:1}]});
  const verifier=await import("../src/core/delivery"),original=verifier.verifyDelivery;
  let signalStarted!:()=>void,release!:()=>void;const started=new Promise<void>(r=>signalStarted=r),gate=new Promise<void>(r=>release=r);
  const intercepted=vi.spyOn(verifier,"verifyDelivery").mockImplementation(async(cwd,checks,options)=>{if(checks[0].label==="One"){signalStarted();await gate;}return original(cwd,checks,options);});
  try{const checking=scheduler.checkDelivery(first.id);await started;expect(scheduler.cancelDelivery(first.id)).toEqual({cancelled:true});const other=await scheduler.checkDelivery(second.id);expect(other?.reports.at(-1)?.status).toBe("passed");release();const cancelled=await checking;expect(cancelled?.reports.at(-1)?.findings[0].code).toBe("cancelled");}
  finally{release();intercepted.mockRestore();}
});
it("keeps queued work intact until startup CLI preparation is ready", async () => {
  scheduler.runtimeReady = () => false;
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await (scheduler as any).tick();
  expect(workers).toHaveLength(0);
  expect(job.state).toBe("queued");
  scheduler.runtimeReady = () => true;
  await (scheduler as any).tick();
  await until(() => workers[0]?.started);
  expect(job.state).toBe("running");
});
it("keeps question answers pending until the native request is resolved, then records the acknowledged answer", async () => {
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await until(() => workers[0]?.started);
  const request: any = {
    jobId: job.id,
    id: "71",
    method: "item/tool/requestUserInput",
    kind: "input",
    params: {
      threadId: job.threadId,
      turnId: "turn",
      questions: [
        {
          id: "direction",
          header: "Direction",
          question: "Which?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Small", description: "Fast" }],
        },
      ],
    },
  };
  workers[0].emit("approval", request);
  const respond = vi.spyOn(workers[0], "respond");
  scheduler.respond("71", { answers: { direction: { answers: ["Small"] } } });
  expect(respond).toHaveBeenCalledTimes(1);
  expect(scheduler.approvals[0].responsePending).toBe(true);
  expect((await scheduler.chats.questions(job.id)).items[0].status).toBe(
    "pending",
  );
  expect(() => scheduler.respond("71", { answers: {} })).toThrow(
    "等待服务器确认",
  );
  workers[0].emit("approvalResolved", "71");
  await until(
    async () =>
      (await scheduler.chats.questions(job.id)).items[0]?.status === "answered",
  );
  expect(scheduler.approvals).toHaveLength(0);
  expect((await scheduler.chats.questions(job.id)).items[0].answers).toEqual({
    direction: { answers: ["Small"] },
  });
  workers[0].emit("approval", {
    ...request,
    id: "73",
    historyId: undefined,
    responsePending: false,
  });
  (scheduler as any).active.get(job.id).reason = "pause";
  expect(() =>
    scheduler.respond("73", { answers: { direction: { answers: ["Small"] } } }),
  ).toThrow("会话正在停止");
  (scheduler as any).active.get(job.id).reason = undefined;
});
it("expires a pending question on stop and does not claim an unacknowledged answer succeeded", async () => {
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await until(() => workers[0]?.started);
  const request: any = {
    jobId: job.id,
    id: "72",
    method: "item/tool/requestUserInput",
    kind: "input",
    params: {
      threadId: job.threadId,
      turnId: "turn",
      questions: [
        {
          id: "private",
          header: "Private",
          question: "Secret?",
          isOther: false,
          isSecret: true,
          options: null,
        },
      ],
    },
  };
  workers[0].emit("approval", request);
  scheduler.respond("72", {
    answers: { private: { answers: ["SYNTHETIC_PRIVATE_REPLY"] } },
  });
  const originalStop = workers[0].stop.bind(workers[0]);
  vi.spyOn(workers[0], "stop").mockImplementation(async () => {
    // Native resolution can mean the stop cleared a pending request, rather
    // than confirming that the model consumed the submitted answer.
    workers[0].emit("approvalResolved", "72");
    return originalStop();
  });
  await scheduler.control(job.id, "pause");
  expect((await scheduler.chats.questions(job.id)).items[0].status).toBe(
    "unconfirmed",
  );
  expect(await fs.readFile(scheduler.chats.file(job.id), "utf8")).not.toContain(
    "SYNTHETIC_PRIVATE_REPLY",
  );
  expect(() => scheduler.respond("72", { answers: {} })).toThrow("过期");
});
it("persists pending user input across native admission and clears it only after submission acknowledgement", async () => {
  let admitted = false,
    release!: () => void;
  const ack = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = vi
    .spyOn(FakeWorker.prototype, "start")
    .mockImplementationOnce(async function (this: FakeWorker) {
      await this.ctx.checkpoint("goal-thread", "native-goal-turn", false);
      admitted = true;
      await ack;
      await this.ctx.checkpoint("goal-thread", "native-goal-turn", true);
      this.started = true;
    });
  try {
    const job = await scheduler.add({
      ...input,
      cwd: root,
      interactive: true,
      prompt: "FOLLOWUP_KEEP_42",
      attachments: [
        {
          type: "mention",
          path: path.join(root, "note.txt"),
          name: "note.txt",
        },
      ],
    });
    await until(() => admitted);
    expect(job.turnId).toBe("native-goal-turn");
    expect(job.pendingMessage).toBe("FOLLOWUP_KEEP_42");
    expect(job.attachments).toHaveLength(1);
    const saved = JSON.parse(
      await fs.readFile(path.join(root, "state.json"), "utf8"),
    );
    expect(saved.jobs[0].pendingMessage).toBe("FOLLOWUP_KEEP_42");
    expect(saved.jobs[0].attachments).toHaveLength(1);
    release();
    await until(() => workers[0]?.started);
    expect(job.pendingMessage).toBeUndefined();
    expect(job.attachments).toBeUndefined();
  } finally {
    release();
    start.mockRestore();
  }
});
it("dispatches using account value, and permits an explicit switch back to ordered rotation", async () => {
  store.data.accounts[1].expiresAt = Date.now() + 3600000;
  store.data.settings.accountSelection = "smart";
  const first = await scheduler.add({ ...input, cwd: root, interactive: true });
  await until(() => workers[0]?.started);
  expect(first.accountId).toBe("b");
  workers[0].settle({ kind: "completed" });
  await until(() => first.state === "completed");
  store.data.cursor = 0;
  store.data.settings.accountSelection = "roundRobin";
  const second = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
  });
  await until(() => workers[1]?.started);
  expect(second.accountId).toBe("a");
});
it("automatically skips an account without the requested model while preserving the pending task", async () => {
  store.data.accounts[0].expiresAt = Date.now() + 3600000;
  const inspected: string[] = [];
  vi.spyOn(scheduler.accounts, "inspect").mockImplementation(
    async (id: string) => {
      inspected.push(id);
      const a = store.data.accounts.find((a) => a.id === id)!;
      const models = [
        {
          id: id === "a" ? "other" : "wanted-alias",
          model: id === "a" ? "other-model" : "wanted-model",
        },
      ];
      Object.assign(a, {
        modelAccess: {
          ids: models.flatMap((m) => [m.id, m.model]),
          complete: true,
          observedAt: Date.now(),
        },
      });
      a.quotas.codex.observedAt = Date.now();
      return {
        auth: { tokens: { access_token: "synthetic" } },
        quotas: a.quotas,
        models,
        modelAccess: (a as any).modelAccess,
      } as any;
    },
  );
  const job = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
    prompt: "KEEP_TASK_42",
    model: "wanted-model",
  });
  scheduler.start();
  await until(
    () =>
      !!workers[0]?.started ||
      ["needs_attention", "waiting"].includes(job.state),
  );
  expect(workers[0]?.ctx.job.accountId).toBe("b");
  expect(workers[0].submitted).toBe("KEEP_TASK_42");
  expect(job.model).toBe("wanted-model");
  expect(job.rotations).toBe(0);
  expect(inspected).toEqual(["a", "b"]);
  expect(store.data.accounts[0].status).toBe("ready");
});
it("uses cached model permissions before value scoring and preserves alias support", async () => {
  store.data.accounts[0].expiresAt = Date.now() + 3600000;
  Object.assign(store.data.accounts[0], {
    modelAccess: { ids: ["other"], complete: true, observedAt: Date.now() },
  });
  Object.assign(store.data.accounts[1], {
    modelAccess: {
      ids: ["wanted-model", "wanted-alias"],
      complete: true,
      observedAt: Date.now(),
    },
  });
  const job = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
    model: "wanted-alias",
  });
  await until(() => !!workers[0]?.started);
  expect(job.accountId).toBe("b");
  expect(scheduler.accounts.inspect).toHaveBeenCalledWith("b", true);
  expect(scheduler.accounts.inspect).not.toHaveBeenCalledWith("a", true);
});
it("waits with pending input intact when every enabled account has an actual model rejection", async () => {
  for (const a of store.data.accounts)
    Object.assign(a, {
      modelAccess: { ids: ["other"], complete: true, observedAt: Date.now() },
      modelDenials: { wanted: Date.now(), "wanted-model": Date.now() },
    });
  const job = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
    prompt: "KEEP_TASK_42",
    model: "wanted-model",
  });
  scheduler.start();
  await until(() =>
    ["waiting", "running", "needs_attention"].includes(job.state),
  );
  expect(job.state).toBe("waiting");
  expect((job as any).waitingFor).toBe("model");
  expect(job.pendingMessage).toBe("KEEP_TASK_42");
  expect(workers).toHaveLength(0);
});
it("wakes a model-waiting task when a matching account becomes known before the retry deadline", async () => {
  for (const a of store.data.accounts)
    Object.assign(a, {
      modelAccess: { ids: ["other"], complete: true, observedAt: Date.now() },
      modelDenials: { wanted: Date.now(), "wanted-model": Date.now() },
    });
  const job = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
    prompt: "KEEP_TASK_42",
    model: "wanted",
  });
  scheduler.start();
  await until(() => job.state === "waiting");
  const deadline = job.nextWakeAt!;
  Object.assign(store.data.accounts[1], {
    modelAccess: { ids: ["wanted"], complete: true, observedAt: Date.now() },
    modelDenials: undefined,
  });
  await until(() => !!workers[0]?.started);
  expect(job.accountId).toBe("b");
  expect(workers[0].submitted).toBe("KEEP_TASK_42");
  expect(Date.now()).toBeLessThan(deadline);
});
it("waits for quota rather than model permissions when a compatible account is exhausted", async () => {
  const [a, b] = store.data.accounts;
  Object.assign(a, {
    modelAccess: { ids: ["other"], complete: true, observedAt: Date.now() },
    modelDenials: { wanted: Date.now(), "wanted-model": Date.now() },
  });
  Object.assign(b, {
    modelAccess: { ids: ["wanted"], complete: true, observedAt: Date.now() },
  });
  b.quotas.codex.primary!.usedPercent = 100;
  b.quotas.codex.primary!.resetsAt = Date.now() + 300000;
  const job = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
    model: "wanted",
  });
  scheduler.start();
  await until(() => job.state === "waiting");
  expect(job.waitingFor).toBeUndefined();
  expect(workers).toHaveLength(0);
  b.quotas.codex.primary!.usedPercent = 0;
  b.quotas.codex.observedAt = Date.now();
  await until(() => !!workers[0]?.started);
  expect(job.accountId).toBe("b");
});
it("switches a model-waiting task without losing its thread, pending input, or attachment", async () => {
  for (const a of store.data.accounts)
    Object.assign(a, {
      modelAccess: { ids: ["other"], complete: true, observedAt: Date.now() },
      modelDenials: { wanted: Date.now(), "wanted-model": Date.now() },
    });
  const job = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
    prompt: "KEEP_TASK_42",
    model: "wanted",
    attachments: [
      { type: "mention", path: path.join(root, "note.txt"), name: "note.txt" },
    ],
  });
  scheduler.start();
  await until(() => job.state === "waiting");
  job.threadId = "saved-thread";
  await store.save();
  const restored = new Store(root);
  await restored.load();
  expect(restored.data.jobs[0].waitingFor).toBe("model");
  expect(restored.data.jobs[0].pendingMessage).toBe("KEEP_TASK_42");
  expect(await scheduler.model(job.id, "other", "low")).toEqual({
    applied: true,
  });
  await until(() => !!workers[0]?.started);
  expect(job.threadId).toBe("saved-thread");
  expect(job.model).toBe("other");
  expect(job.effort).toBe("low");
  expect(workers[0].submitted).toBe("KEEP_TASK_42");
  expect(job.waitingFor).toBeUndefined();
});
it("does not let a model retry bypass an explicit user pause", async () => {
  for (const a of store.data.accounts) a.modelDenials = { wanted: Date.now() };
  const job = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
    model: "wanted",
  });
  await until(() => job.state === "waiting");
  job.goalResumeAfterModelChange = true;
  await scheduler.control(job.id, "pause");
  expect(job.goalResumeAfterModelChange).toBe(false);
  expect(await scheduler.model(job.id, "other", "low")).toEqual({
    applied: false,
  });
  expect(job.state).toBe("paused");
  expect(workers).toHaveLength(0);
});
it("leaves an already running task unchanged when a model selection races its start", async () => {
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await until(() => !!workers[0]?.started);
  expect(await scheduler.model(job.id, "other", "high")).toEqual({
    applied: false,
  });
  expect(job.model).toBe("");
  expect(workers).toHaveLength(1);
});
it("routes an actual model rejection to another account on the same thread without exhausting the first account", async () => {
  const job = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
    model: "wanted",
  });
  await until(() => !!workers[0]?.started);
  const first = store.data.accounts.find((a) => a.id === job.accountId)!;
  job.goal = { threadId: job.threadId!, status: "blocked" } as any;
  workers[0].settle({ kind: "modelUnavailable" });
  await (scheduler as any).currentRun;
  expect(first.modelDenials?.wanted).toBeGreaterThan(0);
  expect(first.status).toBe("ready");
  expect(first.blockedUntil).toBeNull();
  expect(job.goalResumeAfterModelChange).toBe(true);
  await (scheduler as any).tick();
  await until(() => !!workers[1]?.started);
  expect(job.accountId).not.toBe(first.id);
  expect(job.threadId).toBe("stable-thread");
  expect(job.rotations).toBe(0);
  expect(job.pendingMessage).toBeUndefined();
});
it("sends follow-up text on the same thread instead of replaying the recovery prompt", async () => {
  const job = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
    prompt: "first user request",
  });
  await until(() => workers[0]?.started);
  expect(workers[0].submitted).toBe("first user request");
  workers[0].settle({ kind: "completed" });
  await until(() => job.state === "completed");
  const thread = job.threadId;
  await scheduler.send({
    id: job.id,
    text: "second user request",
    attachments: [],
    action: "send",
  });
  await (scheduler as any).tick();
  await until(() => workers[1]?.started);
  expect(workers[1].submitted).toBe("second user request");
  expect(job.threadId).toBe(thread);
  expect(job.pendingMessage).toBeUndefined();
  expect((await scheduler.chats.read(job.id)).items.map((i) => i.text)).toEqual(
    ["first user request", "second user request"],
  );
});
it("reads and edits a stored Goal without loading a thread or logging in", async () => {
  store.data.accounts = [];
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  job.threadId = "stable-thread";
  job.state = "completed";
  const goal = {
    threadId: job.threadId,
    objective: "Evidence stays",
    status: "active",
    tokenBudget: 2000,
    tokensUsed: 42,
    timeUsedSeconds: 10,
    createdAt: 1,
    updatedAt: 2,
  };
  const rpc = new EventEmitter() as any;
  rpc.call = vi.fn(async (method: string, params: any) => {
    if (method === "thread/goal/clear") return { cleared: true };
    if (method === "thread/goal/set")
      Object.assign(goal, { tokenBudget: params.tokenBudget });
    return { goal: { ...goal } };
  });
  rpc.close = vi.fn(async () => {});
  rpc.reject = vi.fn();
  const open = vi.spyOn(Rpc, "open").mockResolvedValue(rpc);
  try {
    expect((await scheduler.goal(job.id, "thread/goal/get")).goal).toEqual(
      goal,
    );
    await scheduler.operation(job.id, "thread/goal/set", {
      tokenBudget: 4000,
      threadId: "wrong-thread",
      origin: "automatic",
    });
    expect(rpc.call).toHaveBeenLastCalledWith("thread/goal/set", {
      tokenBudget: 4000,
      threadId: job.threadId,
      origin: "user",
    });
    expect(job.goal?.tokensUsed).toBe(42);
    expect(job.goal?.objective).toBe("Evidence stays");
    const reloaded = new Store(root);
    await reloaded.load();
    expect(reloaded.data.jobs.find((j) => j.id === job.id)?.goal).toEqual(
      job.goal,
    );
    await scheduler.goal(job.id, "thread/goal/clear");
    expect(job.goal).toBeNull();
    expect(rpc.call.mock.calls.map((call: any) => call[0])).toEqual([
      "thread/goal/get",
      "thread/goal/set",
      "thread/goal/clear",
    ]);
    expect(rpc.close).toHaveBeenCalledTimes(3);
  } finally {
    open.mockRestore();
  }
});
it("suppresses native Goal dispatch while paging local history", async () => {
  store.data.accounts = [];
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  job.threadId = "history-thread";
  job.state = "completed";
  const rpc = new EventEmitter() as any;
  rpc.call = vi.fn(async (method: string) =>
    method === "thread/resume"
      ? { thread: { id: job.threadId } }
      : { data: [] },
  );
  rpc.close = vi.fn(async () => {});
  const open = vi.spyOn(Rpc, "open").mockResolvedValue(rpc);
  try {
    await scheduler.turns(job.id);
    expect(rpc.call).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({
        threadId: job.threadId,
        config: { "features.goals": false },
      }),
    );
    expect(rpc.call.mock.calls.map((call: any) => call[0])).toEqual([
      "thread/resume",
      "thread/turns/list",
    ]);
  } finally {
    open.mockRestore();
  }
});
function nativeGoals(initial: any = null) {
  let current = initial;
  const rpc = new EventEmitter() as any;
  rpc.call = vi.fn(async (method: string, params: any) => {
    if (["thread/start", "thread/resume"].includes(method))
      return { thread: { id: "new-goal-thread" } };
    if (method === "thread/goal/clear") {
      current = null;
      return { cleared: true };
    }
    if (method === "thread/goal/set") {
      current ||= {
        threadId: params.threadId,
        objective: "",
        tokensUsed: 0,
        tokenBudget: null,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      for (const key of ["objective", "status", "tokenBudget"])
        if (Object.hasOwn(params, key)) current[key] = params[key];
      if (Object.hasOwn(params, "objective")) {
        current.tokensUsed = 0;
        current.timeUsedSeconds = 0;
      }
    }
    return { goal: structuredClone(current) };
  });
  rpc.close = vi.fn(async () => {});
  rpc.reject = vi.fn();
  return rpc;
}
it("creates a paused Goal without a signed-in account, user message, or model turn", async () => {
  store.data.accounts = [];
  const rpc = nativeGoals(),
    open = vi.spyOn(Rpc, "open").mockResolvedValue(rpc);
  try {
    const job = await scheduler.createGoal(
      { ...input, cwd: root, prompt: "Verify the finished result" },
      3000,
      false,
    );
    expect(job.state).toBe("paused");
    expect(job.threadId).toBe("new-goal-thread");
    expect(job.pendingMessage).toBeUndefined();
    expect(job.prompt).toBe("");
    expect(job.goal).toMatchObject({
      objective: "Verify the finished result",
      status: "paused",
      tokenBudget: 3000,
      tokensUsed: 0,
    });
    expect((await scheduler.chats.read(job.id)).total).toBe(0);
    expect(
      rpc.call.mock.calls.some(([m]: [string]) =>
        ["account/login/start", "turn/start"].includes(m),
      ),
    ).toBe(false);
    expect(rpc.call).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({ config: { "features.goals": false } }),
    );
    const reloaded = new Store(root);
    await reloaded.load();
    expect(reloaded.data.jobs[0].goal).toEqual(job.goal);
    expect(workers).toHaveLength(0);
  } finally {
    open.mockRestore();
  }
});
it("unloads a new Goal before activating it and persists its explicit queue admission", async () => {
  store.data.accounts = [];
  const rpc = nativeGoals(),
    open = vi.spyOn(Rpc, "open").mockResolvedValue(rpc);
  let unloaded = false;
  rpc.close.mockImplementation(async () => {
    unloaded = true;
  });
  const call = rpc.call.getMockImplementation();
  rpc.call.mockImplementation(async (method: string, params: any) => {
    if (method === "thread/goal/set" && params.status === "active")
      expect(unloaded).toBe(true);
    return call(method, params);
  });
  try {
    const job = await scheduler.createGoal({ ...input, cwd: root }, null, true);
    expect(job.state).toBe("queued");
    expect(job.goalStartRequested).toBe(true);
    expect(job.goal?.status).toBe("active");
    expect(open).toHaveBeenCalledTimes(2);
    expect(rpc.close).toHaveBeenCalledTimes(2);
    await scheduler.goal(job.id, "thread/goal/set", { status: "paused" });
    expect(job.state).toBe("paused");
    expect(job.goalStartRequested).toBe(false);
  } finally {
    open.mockRestore();
  }
});
it("retains uncertain Goal creation for recovery and refuses to discard attachments", async () => {
  store.data.accounts = [];
  const rpc = nativeGoals(),
    open = vi.spyOn(Rpc, "open").mockResolvedValue(rpc);
  try {
    await expect(
      scheduler.createGoal(
        {
          ...input,
          cwd: root,
          attachments: [
            {
              type: "mention",
              path: path.join(root, "notes.txt"),
              name: "notes.txt",
            },
          ],
        },
        null,
        true,
      ),
    ).rejects.toThrow("补充文件");
    expect(open).not.toHaveBeenCalled();
    rpc.close.mockRejectedValue(
      new ProcessSafetyError("Uncertain close", Error("fixture")),
    );
    await expect(
      scheduler.createGoal({ ...input, cwd: root }, null, true),
    ).rejects.toThrow("Uncertain close");
    expect(store.data.jobs).toHaveLength(1);
    expect(store.data.jobs[0]).toMatchObject({
      state: "needs_attention",
      recoveryRequired: true,
      threadId: "new-goal-thread",
    });
    expect(workers).toHaveLength(0);
    // Fake process only; no process remains to recover in fixture teardown.
    store.data.jobs[0].recoveryRequired = false;
  } finally {
    open.mockRestore();
  }
});
it("persists explicit Goal admission, permits pause before dispatch, and clears admission only on a real checkpoint", async () => {
  store.data.accounts = [];
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await (scheduler as any).tickInFlight;
  job.state = "completed";
  job.threadId = "stable-thread";
  job.pendingMessage = undefined;
  const rpc = nativeGoals(),
    open = vi.spyOn(Rpc, "open").mockResolvedValue(rpc);
  try {
    await scheduler.goal(
      job.id,
      "thread/goal/set",
      {
        objective: "Complete and verify the requested work",
        status: "paused",
        tokenBudget: 5000,
      },
      "create",
    );
    expect(job.state).toBe("completed");
    expect(job.goal?.status).toBe("paused");
    await scheduler.goal(
      job.id,
      "thread/goal/set",
      { status: "active" },
      "start",
    );
    expect(job.state).toBe("queued");
    const saved = new Store(root);
    await saved.load();
    expect(saved.data.jobs[0].goalStartRequested).toBe(true);
    expect(saved.data.jobs[0].goal?.objective).toBe(
      "Complete and verify the requested work",
    );
    await scheduler.goal(job.id, "thread/goal/set", { status: "paused" });
    expect(job.state).toBe("paused");
    expect(job.goalStartRequested).toBe(false);
    expect(
      rpc.call.mock.calls.some(([m]: [string]) =>
        ["thread/resume", "turn/start", "account/login/start"].includes(m),
      ),
    ).toBe(false);
    await scheduler.goal(
      job.id,
      "thread/goal/set",
      { status: "active" },
      "start",
    );
    store.data.accounts = [account("a")];
    await (scheduler as any).tick();
    await until(() => workers[0]?.started);
    expect(job.goalStartRequested).toBe(false);
    expect(job.accountId).toBe("a");
  } finally {
    open.mockRestore();
  }
});
it("rechecks native Goal existence and budget before mutation and preserves pending messages", async () => {
  store.data.accounts = [];
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await (scheduler as any).tickInFlight;
  job.state = "completed";
  job.threadId = "stable-thread";
  job.pendingMessage = undefined;
  const rpc = nativeGoals({
      threadId: job.threadId,
      objective: "Keep this objective",
      status: "budgetLimited",
      tokenBudget: 1000,
      tokensUsed: 1000,
    }),
    open = vi.spyOn(Rpc, "open").mockResolvedValue(rpc);
  try {
    await expect(
      scheduler.goal(job.id, "thread/goal/set", { status: "active" }, "start"),
    ).rejects.toThrow("预算已用尽");
    await expect(
      scheduler.goal(
        job.id,
        "thread/goal/set",
        { objective: "Unexpected replacement", status: "paused" },
        "create",
      ),
    ).rejects.toThrow("已有目标");
    expect(
      rpc.call.mock.calls.some(([m]: [string]) => m === "thread/goal/set"),
    ).toBe(false);
    job.pendingMessage = "This input must not be discarded";
    await expect(
      scheduler.goal(job.id, "thread/goal/set", { status: "active" }, "start"),
    ).rejects.toThrow("待发送");
    expect(job.pendingMessage).toBe("This input must not be discarded");
    expect(job.state).toBe("completed");
    job.pendingMessage = undefined;
    await scheduler.goal(
      job.id,
      "thread/goal/set",
      { objective: "Edited acceptance criteria" },
      "edit",
    );
    expect(job.goal).toMatchObject({
      objective: "Edited acceptance criteria",
      status: "budgetLimited",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      tokenBudget: 1000,
    });
  } finally {
    open.mockRestore();
  }
});
it("serializes child messages with parent pause and rejects further child work after pausing", async () => {
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await until(() => workers[0]?.started);
  job.agents = [
    {
      threadId: "child",
      parentThreadId: job.threadId,
      name: "Child",
      status: "completed",
      updatedAt: Date.now(),
    },
  ];
  let release!: (value: unknown) => void;
  workers[0].agentControl.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const stop = vi.spyOn(workers[0], "stop");
  const sending = scheduler.agentControl(
    job.id,
    "child",
    "send",
    "one message",
  );
  await until(() => workers[0].agentControl.mock.calls.length === 1);
  const pausing = scheduler.control(job.id, "pause");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stop).not.toHaveBeenCalled();
  release({});
  await sending;
  await pausing;
  expect(job.state).toBe("paused");
  expect(
    (await scheduler.chats.read("child")).items.map((item) => item.text),
  ).toEqual(["one message"]);
  await expect(
    scheduler.agentControl(job.id, "child", "send", "too late"),
  ).rejects.toThrow("未运行");
  expect(workers[0].agentControl).toHaveBeenCalledTimes(1);
});
it("queues an adopted child behind the current family owner, then rotates accounts on the same child thread", async () => {
  const parent = await scheduler.add({
    ...input,
    cwd: root,
    interactive: true,
  });
  await until(() => workers[0]?.started);
  const childId = "33333333-3333-4333-8333-333333333333";
  parent.agents = [
    {
      threadId: childId,
      parentThreadId: parent.threadId,
      name: "Child",
      status: "completed",
      updatedAt: 1,
    },
  ];
  const child = {
    ...parent,
    id: childId,
    threadId: childId,
    turnId: undefined,
    prompt: "",
    pendingMessage: undefined,
    accountId: undefined,
    state: "completed" as const,
    runtimeHomeId: parent.id,
    agentOrigin: { jobId: parent.id, parentThreadId: parent.threadId! },
    agents: [],
  };
  store.data.jobs.push(child);
  await expect(
    scheduler.send({
      id: childId,
      text: "unsafe overlap",
      attachments: [],
      action: "send",
    }),
  ).rejects.toThrow("同组会话");
  await scheduler.send({
    id: childId,
    text: "queued independent continuation",
    attachments: [],
    action: "queue",
  });
  await (scheduler as any).tick();
  expect(workers).toHaveLength(1);
  workers[0].settle({ kind: "completed" });
  await (scheduler as any).currentRun;
  await (scheduler as any).tick();
  await until(() => workers[1]?.started);
  expect(workers[1].ctx.home).toBe(workers[0].ctx.home);
  expect(child.threadId).toBe(childId);
  expect(parent.agents[0].status).toBe("running");
  const firstAccount = child.accountId;
  workers[1].settle({ kind: "quota" });
  await (scheduler as any).currentRun;
  await (scheduler as any).tick();
  await until(() => workers[2]?.started);
  expect(child.accountId).not.toBe(firstAccount);
  expect(child.threadId).toBe(childId);
  expect(workers[2].ctx.home).toBe(workers[0].ctx.home);
  expect(parent.state).toBe("completed");
  workers[2].settle({ kind: "completed" });
  await (scheduler as any).currentRun;
  expect(parent.agents[0].status).toBe("completed");
});
it("keeps running Goal mutations on the owned worker and serializes them before pause", async () => {
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await until(() => job.state === "running");
  const goal = {
    threadId: job.threadId!,
    objective: "Stay on target",
    status: "active" as const,
    tokenBudget: 1000,
    tokensUsed: 42,
    timeUsedSeconds: 20,
    createdAt: 1,
    updatedAt: 2,
  };
  workers[0].emit("goal", goal);
  expect(job.goal).toEqual(goal);
  workers[0].emit("goal", { ...goal, threadId: "foreign-thread" });
  expect(job.goal).toEqual(goal);
  let release!: (value: unknown) => void;
  workers[0].operation.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const stop = vi.spyOn(workers[0], "stop");
  const updating = scheduler.goal(job.id, "thread/goal/set", {
    status: "paused",
  });
  await until(() => workers[0].operation.mock.calls.length === 1);
  const pausing = scheduler.control(job.id, "pause");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stop).not.toHaveBeenCalled();
  release({ goal: { ...goal, status: "paused" } });
  await updating;
  await pausing;
  expect(job.goal?.status).toBe("paused");
  expect(job.goal?.tokensUsed).toBe(42);
  expect(workers[0].operation).toHaveBeenCalledWith("thread/goal/set", {
    threadId: job.threadId,
    status: "paused",
    origin: "user",
  });
  expect(job.state).toBe("paused");
});
it("refuses a child from a different parent even if the worker exposes a generic child operation", async () => {
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => workers[0]?.started);
  await expect(
    scheduler.agentControl(job.id, "unrelated", "send", "no"),
  ).rejects.toThrow("不属于");
  expect(workers[0].agentControl).not.toHaveBeenCalled();
});
it("keeps a Goal budget stop unfinished without rotating accounts or draining queued messages", async () => {
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await until(() => job.state === "running");
  job.goal = {
    threadId: job.threadId!,
    objective: "Evidence",
    status: "budgetLimited",
    tokenBudget: 100,
    tokensUsed: 100,
    timeUsedSeconds: 1,
    createdAt: 1,
    updatedAt: 2,
  };
  job.queuedMessages = [{ text: "Wait for user", attachments: [] }];
  workers[0].settle({ kind: "goalStopped" });
  await until(() => job.state === "needs_attention");
  expect(job.rotations).toBe(0);
  expect(job.queuedMessages).toHaveLength(1);
  expect(job.lastError).toContain("预算");
});
it("pauses Goal continuation before stopping the user's task and cancels automatic quota recovery", async () => {
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await until(() => job.state === "running");
  job.goal = {
    threadId: job.threadId!,
    objective: "Evidence",
    status: "active",
    tokenBudget: null,
    tokensUsed: 4,
    timeUsedSeconds: 1,
    createdAt: 1,
    updatedAt: 2,
  };
  job.goalResumeAfterQuota = true;
  workers[0].operation.mockResolvedValue({
    goal: { ...job.goal, status: "paused" },
  });
  await scheduler.control(job.id, "pause");
  expect(workers[0].operation).toHaveBeenCalledWith("thread/goal/set", {
    status: "paused",
    origin: "user",
  });
  expect(job.goal.status).toBe("paused");
  expect(job.goalResumeAfterQuota).toBe(false);
  expect(job.state).toBe("paused");
});
it("queues inputs until normal completion and steers only a running turn", async () => {
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  await until(() => job.state === "running");
  await scheduler.send({
    id: job.id,
    text: "steering",
    attachments: [],
    action: "steer",
  });
  expect(workers[0].steer).toHaveBeenCalledWith("steering", []);
  await scheduler.send({
    id: job.id,
    text: "queued question",
    attachments: [],
    action: "queue",
    model: "gpt-6-astra",
    effort: "high",
  });
  expect(job.queuedMessages).toHaveLength(1);
  workers[0].settle({ kind: "completed" });
  await until(() => job.state === "queued");
  await until(() => !(scheduler as any).active.has(job.id));
  await (scheduler as any).tick();
  await until(() => workers[1]?.started);
  expect(workers[1].submitted).toBe("queued question");
  expect(job.model).toBe("gpt-6-astra");
  expect(job.effort).toBe("high");
});
it("blocks follow-up for unsafe imported dependencies and stops raw lifecycle bypass", async () => {
  store.data.accounts = [];
  const job = await scheduler.add({ ...input, cwd: root, interactive: true });
  job.state = "completed";
  job.historySource = {
    source: "vscode",
    threadId: "source",
    issue: "Desktop-only tools",
  };
  await expect(
    scheduler.send({
      id: job.id,
      text: "next",
      attachments: [],
      action: "send",
    }),
  ).rejects.toThrow("Desktop-only");
  await expect(scheduler.operation(job.id, "account/read", {})).rejects.toThrow(
    "界面",
  );
  await expect(scheduler.operation(job.id, "turn/start", {})).rejects.toThrow(
    "界面",
  );
});
let root: string;
let store: Store;
let scheduler: Scheduler;
let workers: FakeWorker[];
const input: NewJob = {
  title: "Test",
  prompt: "Finish original task",
  cwd: "",
  mode: "cli",
  model: "",
  effort: "",
  bucket: "codex",
  approvalPolicy: "on-request",
  sandbox: "workspaceWrite",
};
it("creates checkpoint tasks paused without inference, keeps source intent and deduplicates after persistence",async()=>{
  scheduler.runtimeReady=()=>false;const source=await scheduler.add({...input,cwd:root,interactive:true,deliveryChecks:[{kind:"file",path:"result.txt",label:"Result",minBytes:1}]});source.state="cancelled";source.stopIntent="cancel";source.threadId="source-thread";
  const restore:any={id:crypto.randomUUID(),checkpointId:crypto.randomUUID(),manifestSha256:"a".repeat(64),status:"ready",target:root,branch:"checkpoint/test",mode:"independent"},manifest:any={id:restore.checkpointId,source:root,context:{jobId:source.id,delivery:{revision:1,status:"pending",checks:structuredClone(source.delivery!.checks)}}};
  source.delivery!.checks[0].label="Changed after capture";const before=structuredClone(source);
  const branch=await scheduler.addCheckpointTask({restore,manifest,title:"Branch",prompt:"Inspect restored files"});expect(branch.state).toBe("paused");expect(branch.stopIntent).toBe("pause");expect(branch.threadId).toBeUndefined();expect(branch.runtimeHomeId).toBeUndefined();expect(branch.delivery?.reports).toEqual([]);expect(branch.delivery?.checks).toEqual(manifest.context.delivery.checks);expect(branch.delivery?.checks).not.toEqual(source.delivery?.checks);expect(branch.checkpoint?.sourceJobId).toBe(source.id);expect(source).toEqual(before);
  scheduler.runtimeReady=()=>true;await(scheduler as any).tick();expect(workers).toHaveLength(0);expect((await scheduler.addCheckpointTask({restore,manifest,title:"Retry",prompt:"Retry"})).id).toBe(branch.id);
  const loaded=new Store(root);await loaded.load();expect(loaded.data.jobs.find(j=>j.id===branch.id)?.checkpoint?.restoreId).toBe(restore.id);
});
it("does not admit a checkpoint task if persistence fails",async()=>{
  const restore:any={id:crypto.randomUUID(),checkpointId:crypto.randomUUID(),manifestSha256:"a".repeat(64),status:"ready",target:root,branch:"checkpoint/test",mode:"independent"},manifest:any={id:restore.checkpointId,source:root};
  const write=vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));await expect(scheduler.addCheckpointTask({restore,manifest,title:"Branch",prompt:"Inspect"})).rejects.toThrow("disk full");write.mockRestore();expect(store.data.jobs).toHaveLength(0);expect(workers).toHaveLength(0);
});
function account(id: string): Account {
  return {
    id,
    identity: id,
    label: id,
    email: id,
    plan: "plus",
    enabled: true,
    status: "ready",
    quotas: {
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: Date.now() + 60_000,
        },
        secondary: null,
        observedAt: Date.now(),
        reached: false,
      },
    },
    blockedUntil: null,
    failureCount: 0,
  };
}
const until = async (fn: () => boolean | Promise<boolean>) => {
  await vi.waitFor(async () => expect(await fn()).toBe(true), {
    timeout: 5000,
    interval: 5,
  });
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-test-"));
  store = new Store(root);
  store.data.accounts = [account("a"), account("b")];
  workers = [];
  const accounts = {
    busy: new Set(),
    inspect: vi.fn(async (id: string) => {
      const a = store.data.accounts.find((a) => a.id === id)!;
      a.quotas.codex.observedAt = Date.now();
      return {
        auth: { tokens: { access_token: "synthetic" } },
        quotas: a.quotas,
        models: [],
      };
    }),
    cancelLogin: async () => {},
  };
  const factory = (ctx: WorkerContext) => {
    const w = new FakeWorker(ctx);
    workers.push(w);
    return w;
  };
  scheduler = new Scheduler(store, accounts as any, {
    cli: factory,
    desktop: factory,
  });
});
afterEach(async () => {
  for (const w of workers) {
    w.failClose = false;
    w.settle({ kind: "interrupted" });
  }
  await scheduler.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});
describe("supervisor state transitions", () => {
  it.each(["interrupted", "recoverable"] as const)(
    "automatically continues %s on the same thread only after its backoff",
    async (kind) => {
      const job = await scheduler.add({
        ...input,
        cwd: root,
        interactive: true,
      });
      await until(() => workers[0]?.started);
      workers[0].settle({ kind });
      await (scheduler as any).currentRun;
      expect(job).toMatchObject({
        state: "waiting",
        waitingFor: "recovery",
        threadId: "stable-thread",
      });
      await (scheduler as any).tick();
      expect(workers).toHaveLength(1); // A healthy account cannot bypass backoff.
      job.autoRecovery!.nextAttemptAt = 0;
      await (scheduler as any).tick();
      await until(() => !job.autoRecovery);
      await until(() => !(scheduler as any).recoveryTasks.size);
      await (scheduler as any).tick();
      await until(() => workers[1]?.started);
      expect(workers[1].submitted).toBe(store.data.settings.resumePrompt);
      expect(job.threadId).toBe("stable-thread");
      expect(job.rotations).toBe(0);
      workers[1].settle({ kind: "completed" });
      await (scheduler as any).currentRun;
      expect(job.state).toBe("completed");
      expect(job.recoveryAttempts).toBe(0);
    },
  );
  it("keeps retrying failed process cleanup automatically without admitting a duplicate", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    workers[0].failClose = true;
    workers[0].settle({ kind: "recoverable" });
    await (scheduler as any).currentRun;
    job.autoRecovery!.nextAttemptAt = 0;
    await (scheduler as any).tick();
    await until(() => job.autoRecovery?.attempt === 2);
    expect(job.recoveryRequired).toBe(true);
    expect(workers).toHaveLength(1);
    workers[0].failClose = false;
    job.autoRecovery!.nextAttemptAt = 0;
    await until(() => !(scheduler as any).recoveryTasks.size);
    await (scheduler as any).tick();
    await until(() => !job.recoveryRequired);
    await until(() => !(scheduler as any).recoveryTasks.size);
    await (scheduler as any).tick();
    await until(() => workers[1]?.started);
    expect(workers[1].ctx.job.threadId).toBe("stable-thread");
  });
  it.each(["pause", "cancel"] as const)(
    "%s cancels automatic continuation during a retry countdown",
    async (action) => {
      const job = await scheduler.add({ ...input, cwd: root });
      await until(() => workers[0]?.started);
      workers[0].settle({ kind: "interrupted" });
      await (scheduler as any).currentRun;
      await scheduler.control(job.id, action);
      expect(job.state).toBe(action === "pause" ? "paused" : "cancelled");
      expect(job.autoRecovery).toBeUndefined();
      await (scheduler as any).tick();
      expect(workers).toHaveLength(1);
      const restored = new Store(root);
      await restored.load();
      expect(restored.data.jobs[0].stopIntent).toBe(action);
      expect(restored.data.jobs[0].autoRecovery).toBeUndefined();
    },
  );
  it.each(["pause", "cancel"] as const)(
    "persists %s immediately while ownership recovery is still pending",
    async (action) => {
      const job = await scheduler.add({ ...input, cwd: root });
      await until(() => workers[0]?.started);
      workers[0].settle({ kind: "recoverable" });
      await (scheduler as any).currentRun;
      let finishRecovery!: () => void;
      const recovering = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRecovery = resolve;
          }),
      );
      (scheduler as any).recover = recovering;
      job.autoRecovery!.nextAttemptAt = 0;
      await (scheduler as any).tick();
      await until(() => recovering.mock.calls.length === 1);
      const stopping = scheduler.control(job.id, action);
      try {
        // The request must survive a restart before the ownership check finishes.
        const restored = new Store(root);
        await until(async () => {
          await restored.load();
          return restored.data.jobs[0].stopIntent === action;
        });
        await (scheduler as any).tick();
        expect(workers).toHaveLength(1);
      } finally {
        finishRecovery();
      }
      await stopping;
      await until(() => !(scheduler as any).recoveryTasks.size);
      await (scheduler as any).tick();
      expect(job.state).toBe(action === "pause" ? "paused" : "cancelled");
      expect(workers).toHaveLength(1);
    },
  );
  it("honors Cancel after failed cleanup even if recovery later succeeds", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    workers[0].failClose = true;
    workers[0].settle({ kind: "recoverable" });
    await (scheduler as any).currentRun;
    await expect(scheduler.control(job.id, "cancel")).rejects.toThrow();
    expect(job.stopIntent).toBe("cancel");
    workers[0].failClose = false;
    job.autoRecovery!.nextAttemptAt = 0;
    await (scheduler as any).tick();
    await until(() => job.state === "cancelled");
    expect(job.recoveryRequired).toBe(false);
    await (scheduler as any).tick();
    expect(workers).toHaveLength(1);
  });
  it("does not release the process gate until recovery is durably saved", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    workers[0].failClose = true;
    workers[0].settle({ kind: "recoverable" });
    await (scheduler as any).currentRun;
    workers[0].failClose = false;
    vi.spyOn(store, "save").mockRejectedValueOnce(Error("disk unavailable"));
    job.autoRecovery!.nextAttemptAt = 0;
    await (scheduler as any).tick();
    await until(() => job.autoRecovery?.attempt === 2);
    expect(job.recoveryRequired).toBe(true);
    expect(workers).toHaveLength(1);
    expect(job.lastError).toContain("disk unavailable");
  });
  it("does not auto-answer approvals or retry configuration failures", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    const respond = vi.spyOn(workers[0], "respond");
    workers[0].emit("approval", {
      id: "approval",
      jobId: job.id,
      kind: "command",
      params: {},
    });
    await (scheduler as any).tick();
    expect(respond).not.toHaveBeenCalled();
    expect(job.autoRecovery).toBeUndefined();
    workers[0].settle({ kind: "error", error: Error("invalid configuration") });
    await (scheduler as any).currentRun;
    await (scheduler as any).tick();
    expect(job.state).toBe("needs_attention");
    expect(job.autoRecovery).toBeUndefined();
    expect(workers).toHaveLength(1);
  });
  it("rotates on exhaustion, keeps the thread and finishes only after a successful run", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    const q = store.data.accounts[0].quotas.codex;
    q.primary!.usedPercent = 100;
    workers[0].settle({ kind: "quota" });
    await (scheduler as any).currentRun;
    expect(job.state).toBe("queued");
    expect(job.rotations).toBe(1);
    expect(job.threadId).toBe("stable-thread");
    await (scheduler as any).tick();
    await until(() => workers[1]?.started);
    expect(job.accountId).toBe("b");
    workers[1].settle({ kind: "completed" });
    await (scheduler as any).currentRun;
    expect(job.state).toBe("completed");
  });
  it("waits rather than marking the task complete when every account is exhausted", async () => {
    for (const a of store.data.accounts)
      a.quotas.codex.primary!.usedPercent = 100;
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => job.state === "waiting");
    expect(workers).toHaveLength(0);
    expect(job.nextWakeAt).toBeGreaterThan(Date.now());
  });
  it("resumes a waiting task only after a fresh positive quota observation", async () => {
    for (const a of store.data.accounts)
      a.quotas.codex.primary!.usedPercent = 100;
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => job.state === "waiting");
    job.nextWakeAt = Date.now() - 1;
    await (scheduler as any).tick();
    expect(workers).toHaveLength(0);
    store.data.accounts[1].quotas.codex.primary!.usedPercent = 0;
    store.data.accounts[1].quotas.codex.observedAt = Date.now();
    job.nextWakeAt = Date.now() - 1;
    await (scheduler as any).tick();
    await until(() => workers[0]?.started);
    expect(job.accountId).toBe("b");
  });
  it("manual pause has priority over quota rotation", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    await scheduler.control(job.id, "pause");
    await (scheduler as any).currentRun;
    expect(job.state).toBe("paused");
    expect(job.rotations).toBe(0);
  });
  it("never starts another worker when the old process cannot be confirmed closed", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    workers[0].failClose = true;
    workers[0].settle({ kind: "quota" });
    await (scheduler as any).currentRun;
    expect(job.state).toBe("needs_attention");
    await (scheduler as any).tick();
    expect(workers).toHaveLength(1);
    workers[0].failClose = false;
    await scheduler.control(job.id, "resume");
    await (scheduler as any).tick();
    await until(() => workers[1]?.started);
  });
  it("freezes the entire queue until interrupted jobs are explicitly recovered", async () => {
    store.data.jobs.push({
      ...input,
      id: "old",
      state: "needs_attention",
      recoveryRequired: true,
      rotations: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const job = await scheduler.add({ ...input, cwd: root });
    await (scheduler as any).tick();
    expect(workers).toHaveLength(0);
    expect(job.state).toBe("queued");
    await scheduler.control("old", "cancel");
    await (scheduler as any).tick();
    await until(() => workers[0]?.started);
    expect(store.data.jobs[0].recoveryRequired).toBe(false);
  });
  it("shutdown waits for the running worker to finish saving", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    await scheduler.shutdown();
    expect(job.state).toBe("paused");
    const persisted = JSON.parse(
      await fs.readFile(path.join(root, "state.json"), "utf8"),
    );
    expect(persisted.jobs[0].state).toBe("paused");
  });
});

// These regressions exercise public controls while asynchronous preparation is pending.
it("completed jobs cannot be resurrected through pause then resume", async () => {
  store.data.jobs.push({
    ...input,
    id: "done",
    state: "completed",
    rotations: 0,
    createdAt: 0,
    updatedAt: 0,
  });
  await expect(scheduler.control("done", "pause")).rejects.toThrow();
  expect(store.data.jobs[0].state).toBe("completed");
});
it("shutdown waits for an idle quota probe and never starts a worker afterwards", async () => {
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const inspect = scheduler.accounts.inspect.bind(scheduler.accounts);
  vi.spyOn(scheduler.accounts, "inspect").mockImplementationOnce(async (id) => {
    entered = true;
    await gate;
    return inspect(id);
  });
  await scheduler.add({ ...input, cwd: root });
  await until(() => entered);
  const ended = vi.fn();
  const shutdown = scheduler.shutdown().then(ended);
  await new Promise((r) => setTimeout(r, 10));
  const returnedBeforeProbeEnded = ended.mock.calls.length > 0;
  release();
  await shutdown;
  await until(() => (scheduler as any).ticking === false);
  expect(returnedBeforeProbeEnded).toBe(false);
  expect(workers).toHaveLength(0);
});

it("a newly available account wakes a job before the old reset deadline", async () => {
  for (const a of store.data.accounts)
    a.quotas.codex.primary!.usedPercent = 100;
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => job.state === "waiting");
  await (scheduler as any).tick();
  job.nextWakeAt = Date.now() + 7 * 86400000;
  store.data.accounts.push(account("new"));
  await (scheduler as any).tick();
  await until(() => workers[0]?.started);
  expect(job.accountId).toBe("new");
});
it("failed close persists the global recovery gate across restart", async () => {
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => workers[0]?.started);
  workers[0].failClose = true;
  workers[0].settle({ kind: "quota" });
  await (scheduler as any).currentRun;
  const restored = new Store(root);
  await restored.load();
  expect(restored.data.jobs[0].recoveryRequired).toBe(true);
  expect(
    restored.data.logs.some(
      (entry) =>
        entry.jobId === job.id &&
        entry.level === "error" &&
        entry.message.includes("Still running"),
    ),
  ).toBe(true);
  workers[0].failClose = false;
});
it("an unconfirmed process left by preparation freezes the entire queue", async () => {
  const original = vi
    .mocked(scheduler.accounts.inspect)
    .getMockImplementation()!;
  vi.spyOn(scheduler.accounts, "inspect").mockImplementation(
    async (id, force) => {
      if (force)
        throw new ProcessSafetyError(
          "cannot stop initialization process",
          new Error("test"),
        );
      return original(id, force);
    },
  );
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => job.state === "needs_attention");
  await (scheduler as any).currentRun;
  expect(job.recoveryRequired).toBe(true);
  await (scheduler as any).tick();
  expect(workers).toHaveLength(0);
});
it("shutdown waits for completion persistence without trying to pause a terminal job", async () => {
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => workers[0]?.started);
  const originalSave = store.save.bind(store);
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(store, "save").mockImplementation(async () => {
    if (job.state === "completed") {
      entered = true;
      await gate;
    }
    return originalSave();
  });
  workers[0].settle({ kind: "completed" });
  await until(() => entered);
  const result = scheduler.shutdown().then(
    () => "ok",
    (error) => error,
  );
  release();
  expect(await result).toBe("ok");
  expect(job.state).toBe("completed");
});

it("does not probe an unavailable account before dispatching a known available one", async () => {
  store.data.accounts[0].status = "offline";
  store.data.accounts[0].quotas = {};
  const inspect = vi.mocked(scheduler.accounts.inspect);
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => workers[0]?.started);
  expect(job.accountId).toBe("b");
  expect(inspect.mock.calls.every(([id]) => id === "b")).toBe(true);
});
it("dispatches another available account without waiting for a background warmup", async () => {
  const a = store.data.accounts[0];
  a.warmups = {
    codex: {
      resetAt: Date.now() - 1000,
      queuedAt: Date.now(),
      status: "running",
    },
  };
  // Let recovery finish before emulating the in-memory active warmup.
  await (scheduler as any).warmupRecovery;
  a.warmups.codex.status = "running";
  const yieldWarmup = vi.spyOn(scheduler.warmups, "yieldToTask");
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => workers[0]?.started);
  expect(job.accountId).toBe("b");
  expect(yieldWarmup).not.toHaveBeenCalled();
  a.warmups.codex.status = "sent";
});
it("limits idle quota refresh to one account per dispatch cycle", async () => {
  const inspect = vi.mocked(scheduler.accounts.inspect);
  await (scheduler as any).tick();
  expect(inspect).toHaveBeenCalledTimes(1);
  await (scheduler as any).tick();
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(inspect.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
});

it("bounds completion repair attempts while retaining the thread and keeping quota rotation separate", async () => {
  const job = await scheduler.add({
    ...input,
    cwd: root,
    completionMarker: "[DONE]",
    maxCompletionRetries: 1,
  });
  await until(() => workers[0]?.started);
  workers[0].settle({ kind: "incomplete" });
  await (scheduler as any).currentRun;
  expect(job.state).toBe("queued");
  expect(job.completionRetries).toBe(1);
  expect(job.rotations).toBe(0);
  await (scheduler as any).tick();
  await until(() => workers[1]?.started);
  expect(job.threadId).toBe("stable-thread");
  workers[1].settle({ kind: "incomplete" });
  await (scheduler as any).currentRun;
  expect(job.state).toBe("needs_attention");
  await (scheduler as any).tick();
  expect(workers).toHaveLength(2);
  await scheduler.control(job.id, "resume");
  expect(job.completionRetries).toBe(0);
});

async function queuedJobs(count: number) {
  store.data.accounts = [];
  const jobs = [];
  for (let i = 0; i < count; i++) {
    jobs.push(
      await scheduler.add({
        ...input,
        cwd: root,
        interactive: true,
        title: `Parallel ${i}`,
      }),
    );
    await (scheduler as any).tickInFlight;
  }
  store.data.accounts = [account("a")];
  return jobs;
}

it("runs three independent CLI conversations on one account and respects a reduced limit without interrupting them", async () => {
  const jobs = await queuedJobs(4);
  await (scheduler as any).tick();
  await until(() => workers.length === 3 && workers.every((w) => w.started));
  expect(jobs.slice(0, 3).map((j) => j.accountId)).toEqual(["a", "a", "a"]);
  expect(new Set(workers.map((w) => w.ctx.home)).size).toBe(3);
  store.data.settings.maxConcurrentTasks = 1;
  workers[0].settle({ kind: "completed" });
  await (scheduler as any).active.get(jobs[0].id).done;
  await (scheduler as any).tick();
  expect(workers).toHaveLength(3);
  expect(jobs[1].state).toBe("running");
  expect(jobs[2].state).toBe("running");
  store.data.settings.maxConcurrentTasks = 3;
  await (scheduler as any).tick();
  await until(() => workers[3]?.started);
  expect(jobs[3].state).toBe("running");
});

it("keeps another conversation responsive during a delayed pause and routes colliding approval IDs by job", async () => {
  const [a, b] = await queuedJobs(2);
  await (scheduler as any).tick();
  await until(() => workers.length === 2 && workers.every((w) => w.started));
  for (const worker of workers)
    worker.emit("approval", {
      jobId: worker.ctx.job.id,
      id: "7",
      method: "item/commandExecution/requestApproval",
      kind: "command",
      params: {},
    });
  const replies = workers.map((w) => vi.spyOn(w, "respond"));
  expect(() => scheduler.respond("7", { decision: "accept" })).toThrow();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(workers[0], "stop").mockImplementationOnce(async () => {
    await gate;
    workers[0].settle({ kind: "interrupted" });
  });
  const pause = scheduler.control(a.id, "pause");
  try {
    await until(() => a.state === "pausing");
    await scheduler.send({
      id: b.id,
      text: "continue independently",
      attachments: [],
      action: "steer",
    });
    expect(workers[1].steer).toHaveBeenCalledWith("continue independently", []);
    scheduler.respond("7", { decision: "accept" }, b.id);
    expect(replies[1]).toHaveBeenCalledExactlyOnceWith("7", {
      decision: "accept",
    });
    expect(replies[0]).not.toHaveBeenCalled();
    expect(scheduler.approvals.map((a) => a.jobId)).toEqual([a.id]);
    expect(() =>
      scheduler.respond("7", { decision: "accept" }, a.id),
    ).toThrow();
    expect(b.state).toBe("running");
  } finally {
    release();
    await pause;
  }
  expect(a.state).toBe("paused");
  expect(b.state).toBe("running");
});

it("serializes a parent and adopted child while admitting unrelated queued work", async () => {
  const [parent, child, unrelated] = await queuedJobs(3);
  child.runtimeHomeId = parent.id;
  child.threadId = "child-thread";
  await (scheduler as any).tick();
  await until(() => workers.length === 2 && workers.every((w) => w.started));
  expect(workers.map((w) => w.ctx.job.id)).toEqual([parent.id, unrelated.id]);
  expect(child.state).not.toBe("running");
  await scheduler.control(parent.id, "pause");
  await (scheduler as any).tick();
  await until(() => workers[2]?.started);
  expect(workers[2].ctx.job.id).toBe(child.id);
  expect(child.threadId).toBe("child-thread");
  expect(unrelated.state).toBe("running");
});

it("rotates only the exhausted conversation and keeps its thread while another worker continues", async () => {
  const [a, b] = await queuedJobs(2);
  await (scheduler as any).tick();
  await until(() => workers.length === 2 && workers.every((w) => w.started));
  const thread = a.threadId;
  store.data.accounts.push(account("b"));
  workers[0].settle({ kind: "quota" });
  await (scheduler as any).active.get(a.id).done;
  await (scheduler as any).tick();
  await until(() => workers[2]?.started);
  expect(a.rotations).toBe(1);
  expect(a.accountId).toBe("b");
  expect(a.threadId).toBe(thread);
  expect(b.state).toBe("running");
  expect(b.accountId).toBe("a");
  expect(b.rotations).toBe(0);
});

it("reserves Desktop accounts exclusively without blocking other CLI slots", async () => {
  const [first, desktop, last] = await queuedJobs(3);
  desktop.mode = "desktop";
  await (scheduler as any).tick();
  await until(() => workers.length === 2 && workers.every((w) => w.started));
  expect(workers.map((w) => w.ctx.job.id)).toEqual([first.id, last.id]);
  expect(desktop.state).toBe("waiting");
  await scheduler.control(first.id, "pause");
  await scheduler.control(last.id, "pause");
  await (scheduler as any).tick();
  await until(() => workers[2]?.started);
  await scheduler.control(first.id, "resume");
  await (scheduler as any).tick();
  expect(workers).toHaveLength(3);
  expect(desktop.state).toBe("running");
  expect(first.state).toBe("waiting");
});

it("stops every parallel worker even when one fails to close and retains the recovery gate", async () => {
  const [a, b] = await queuedJobs(2);
  await (scheduler as any).tick();
  await until(() => workers.length === 2 && workers.every((w) => w.started));
  workers[0].failClose = true;
  await expect(scheduler.shutdown()).rejects.toThrow();
  expect(a.recoveryRequired).toBe(true);
  expect(a.state).toBe("needs_attention");
  expect(b.state).toBe("paused");
  expect((scheduler as any).active.size).toBe(1);
});


describe("editable message queue", () => {
  async function queued() {
    const job = await scheduler.add({ ...input, cwd: root, interactive: true });
    await until(() => workers[0]?.started);
    for (const text of ["first", "second"])
      await scheduler.send({ id: job.id, text, attachments: [], action: "queue" });
    return job;
  }
  it("edits, reorders and removes stable messages without accepting a stale queue", async () => {
    const job = await queued();
    const [first, second] = job.queuedMessages!;
    await scheduler.editQueue({ id: job.id, messageId: second.id!, revision: job.queueRevision!, action: "up" });
    expect(job.queuedMessages![0].text).toBe("second");
    await expect(scheduler.editQueue({ id: job.id, messageId: first.id!, revision: 2, action: "remove" })).rejects.toThrow("队列已变化");
    await scheduler.editQueue({ id: job.id, messageId: second.id!, revision: job.queueRevision!, action: "edit", text: "updated" });
    await scheduler.editQueue({ id: job.id, messageId: first.id!, revision: job.queueRevision!, action: "remove" });
    workers[0].settle({ kind: "completed" });
    await (scheduler as any).currentRun;
    expect(job.pendingMessage).toBe("updated");
    expect(job.queuedMessages).toHaveLength(0);
  });
  it("does not drain an edit until it is durable and restores the old message after a failed save", async () => {
    const job = await queued();
    let reject!: (error: Error) => void;
    vi.spyOn(store, "save").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const editing = scheduler.editQueue({ id: job.id, messageId: job.queuedMessages![0].id!, revision: job.queueRevision!, action: "edit", text: "not saved" });
    const failed = expect(editing).rejects.toThrow("disk full");
    await until(() => !!reject);
    workers[0].settle({ kind: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(job.pendingMessage).not.toBe("not saved");
    reject(Error("disk full"));
    await failed;
    await (scheduler as any).currentRun;
    expect(job.pendingMessage).toBe("first");
    expect(job.queuedMessages!.map((m) => m.text)).toEqual(["second"]);
  });
});


it("admits high-priority eligible tasks first without preempting an active worker", async () => {
  const [first, high, low] = await queuedJobs(3);
  store.data.settings.maxConcurrentTasks = 1;
  await scheduler.priority(high.id, "high");
  await scheduler.priority(low.id, "low");
  await (scheduler as any).tick();
  await until(() => workers[0]?.started);
  expect(workers[0].ctx.job.id).toBe(high.id);
  await scheduler.priority(first.id, "high");
  await (scheduler as any).tick();
  expect(workers).toHaveLength(1);
  workers[0].settle({ kind: "completed" });
  await (scheduler as any).currentRun;
  await (scheduler as any).tick();
  await until(() => workers[1]?.started);
  expect(workers[1].ctx.job.id).toBe(first.id);
});
it("rolls back an unsaved priority and never bypasses recovery backoff", async () => {
  const [first, second] = await queuedJobs(2);
  store.data.settings.maxConcurrentTasks = 1;
  vi.spyOn(store, "save").mockRejectedValueOnce(Error("disk full"));
  await expect(scheduler.priority(first.id, "high")).rejects.toThrow("disk full");
  expect(first.priority).toBeUndefined();
  first.priority = "high";
  first.autoRecovery = { reason: "unknown", attempt: 1, nextAttemptAt: Date.now() + 60000 };
  await (scheduler as any).tick();
  await until(() => workers[0]?.started);
  expect(workers[0].ctx.job.id).toBe(second.id);
});


it("bulk controls report partial failures and deduplicate IDs without blocking other tasks", async () => {
  const [first, second] = await queuedJobs(2);
  await (scheduler as any).tick();
  await until(() => workers.length === 2 && workers.every((w) => w.started));
  const result = await scheduler.controlMany([first.id, "missing", second.id, first.id], "pause");
  expect(result.results.map((r) => r.ok)).toEqual([true, false, true]);
  expect([first.state, second.state]).toEqual(["paused", "paused"]);
  const resumed = await scheduler.controlMany([first.id, second.id], "resume");
  expect(resumed.results.every((r) => r.ok)).toBe(true);
  expect([first.state, second.state]).toEqual(["queued", "queued"]);
});
it("bulk resume does not take over unmanaged windows or rerun completed work", async () => {
  const [job] = await queuedJobs(1);
  job.state = "completed";
  expect((await scheduler.controlMany([job.id], "resume")).results[0].ok).toBe(false);
  job.state = "paused";
  job.existing = { phase: "watching" } as any;
  expect((await scheduler.controlMany([job.id], "resume")).results[0].ok).toBe(false);
  expect(workers).toHaveLength(0);
});

it("dispatches dependent tasks only after every prerequisite completes", async () => {
  const [first, second, third] = await queuedJobs(3);
  await scheduler.dependencies(second.id, [first.id]);
  await scheduler.dependencies(third.id, [first.id, second.id]);
  await (scheduler as any).tick();
  await until(() => workers[0]?.started);
  expect(workers.map(w => w.ctx.job.id)).toEqual([first.id]);
  workers[0].settle({ kind: "completed" });
  await until(() => first.state === "completed");
  await (scheduler as any).currentRun;
  await (scheduler as any).tick();
  await until(() => workers[1]?.started);
  expect(workers[1].ctx.job.id).toBe(second.id);
  expect(["queued", "waiting"]).toContain(third.state);
  await scheduler.control(second.id, "cancel");
  await (scheduler as any).tick();
  expect(workers).toHaveLength(2);
});
it("rejects dependency cycles and restores dependencies when persistence fails", async () => {
  const [a,b] = await queuedJobs(2);
  await scheduler.dependencies(a.id, [b.id]);
  await expect(scheduler.dependencies(b.id,[a.id])).rejects.toThrow("循环");
  await expect(scheduler.dependencies(a.id,[a.id])).rejects.toThrow("循环");
  await expect(scheduler.dependencies(a.id,["missing"])).rejects.toThrow("不存在");
  vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));
  await expect(scheduler.dependencies(a.id,[])).rejects.toThrow("disk full");
  expect(a.dependsOn).toEqual([b.id]);
  store.data.jobs = [a];
  await (scheduler as any).tick();
  expect(workers).toHaveLength(0);
});

it("persists global dispatch holds while allowing active workers to finish", async () => {
  const [a,b] = await queuedJobs(2); store.data.settings.maxConcurrentTasks = 1;
  await (scheduler as any).tick(); await until(() => workers[0]?.started);
  await scheduler.dispatch(true);
  const loaded = new Store(root); await loaded.load();
  expect(loaded.data.dispatch?.paused).toBe(true);
  workers[0].settle({kind:"completed"}); await until(() => a.state === "completed");
  await (scheduler as any).currentRun; await (scheduler as any).tick();
  expect(workers).toHaveLength(1);
  await scheduler.dispatch(false); await (scheduler as any).tick();
  await until(() => workers[1]?.started); expect(workers[1].ctx.job.id).toBe(b.id);
});
it("holds only the selected project and rolls back failed dispatch saves", async () => {
  const [a,b] = await queuedJobs(2); a.projectCwd = root + "/project-a";
  await scheduler.dispatch(true, a.projectCwd);
  vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));
  await expect(scheduler.dispatch(false,a.projectCwd)).rejects.toThrow("disk full");
  expect(store.data.dispatch?.projects).toEqual([a.projectCwd]);
  await (scheduler as any).tick(); await until(() => workers[0]?.started);
  expect(workers).toHaveLength(1); expect(workers[0].ctx.job.id).toBe(b.id);
});

it("admits an entire workflow once and preserves its chain after restart", async () => {
  await scheduler.dispatch(true);
  const steps = [{...input,cwd:root,prompt:"implement"},{...input,cwd:root,prompt:"verify"}];
  const jobs = await scheduler.addWorkflow("workflow-id","Release",steps);
  const retried = await scheduler.addWorkflow("workflow-id","Release",steps);
  expect(retried.map(j=>j.id)).toEqual(jobs.map(j=>j.id));
  expect(store.data.jobs).toHaveLength(2);
  expect(jobs[1].dependsOn).toEqual([jobs[0].id]);
  const loaded = new Store(root); await loaded.load();
  expect(loaded.data.jobs[1].workflow?.step).toBe(2);
  expect(loaded.data.jobs[1].dependsOn).toEqual([jobs[0].id]);
  await expect(scheduler.addWorkflow("workflow-id","Changed",steps)).rejects.toThrow("已被处理");
  await (scheduler as any).tick(); expect(workers).toHaveLength(0);
  await scheduler.dispatch(false); await (scheduler as any).tick();
  await until(()=>workers[0]?.started); expect(workers).toHaveLength(1);
});
it("never admits a partial workflow after validation or persistence failures", async () => {
  const steps = [{...input,cwd:root},{...input,cwd:root+"/missing"}];
  await expect(scheduler.addWorkflow("bad","Bad",steps)).rejects.toThrow();
  expect(store.data.jobs).toHaveLength(0);
  steps[1].cwd=root;
  vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));
  await expect(scheduler.addWorkflow("retry","Retry",steps)).rejects.toThrow("disk full");
  expect(store.data.jobs).toHaveLength(0);
  expect(await fs.readdir(path.join(root,"chats"))).toHaveLength(0);
  await (scheduler as any).tick(); expect(workers).toHaveLength(0);
  expect(await scheduler.addWorkflow("retry","Retry",steps)).toHaveLength(2);
});

it("serializes one project while other projects keep running and admits the next task automatically", async () => {
  const [a,b,c] = await queuedJobs(3); c.projectCwd=root+"/other";
  await scheduler.projectLimit(root,1); await (scheduler as any).tick();
  await until(()=>workers.length===2 && workers.every(w=>w.started));
  expect(workers.map(w=>w.ctx.job.id)).toEqual([a.id,c.id]);
  workers[0].settle({kind:"completed"}); await until(()=>a.state==="completed");
  await until(() => !(scheduler as any).active.has(a.id));
  await (scheduler as any).tick(); await until(()=>workers[2]?.started);
  expect(workers[2].ctx.job.id).toBe(b.id);
});
it("persists project limits and does not preempt running work when reduced", async () => {
  const jobs=await queuedJobs(3); store.data.settings.maxConcurrentTasks=2;
  await (scheduler as any).tick(); await until(()=>workers.length===2 && workers.every(w=>w.started));
  await scheduler.projectLimit(root,1);
  expect(jobs[0].state).toBe("running"); expect(jobs[1].state).toBe("running");
  const loaded=new Store(root); await loaded.load(); expect(loaded.data.projectLimits).toEqual([{cwd:root,limit:1}]);
  vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));
  await expect(scheduler.projectLimit(root,null)).rejects.toThrow("disk full");
  expect(store.data.projectLimits).toEqual([{cwd:root,limit:1}]);
  workers[0].settle({kind:"completed"}); await until(()=>!(scheduler as any).active.has(jobs[0].id));
  await (scheduler as any).tick(); expect(workers).toHaveLength(2);
  await scheduler.projectLimit(root,2); await (scheduler as any).tick();
  await until(()=>workers[2]?.started);
});

it("never admits unsaved idempotent submissions and accepts an exact retry after save failure",async()=>{
  store.data.accounts=[];
  vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));
  await expect(scheduler.add({...input,cwd:root},undefined,undefined,"request-id")).rejects.toThrow("disk full");
  expect(store.data.jobs).toHaveLength(0);
  const job=await scheduler.add({...input,cwd:root},undefined,undefined,"request-id");
  const retry=await scheduler.add({...input,cwd:root},undefined,undefined,"request-id");
  expect(retry.id).toBe(job.id);expect(store.data.jobs).toHaveLength(1);
});

it("deduplicates follow-up receipts before and after restart without adding two queue entries",async()=>{
 const [job]=await queuedJobs(1);
 const message={id:job.id,text:"Follow-up once",attachments:[],action:"queue" as const};
 await Promise.all([scheduler.send(message,"message-id"),scheduler.send(message,"message-id")]);
 expect(job.queuedMessages).toHaveLength(1);expect(job.messageReceipts).toHaveLength(1);
 const loaded=new Store(root);await loaded.load();expect(loaded.data.jobs[0].messageReceipts).toEqual(job.messageReceipts);
 await expect(scheduler.send({...message,text:"Changed"},"message-id")).rejects.toThrow("不同消息");
});
it("rolls back uncommitted follow-up receipts and inactive task state on disk failure",async()=>{
 const [job]=await queuedJobs(1);await scheduler.control(job.id,"pause");
 const message={id:job.id,text:"Durable follow-up",attachments:[],action:"queue" as const};
 vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));
 await expect(scheduler.send(message,"retry-message")).rejects.toThrow("disk full");
 expect(job.state).toBe("paused");expect(job.messageReceipts).toBeUndefined();
 await scheduler.send(message,"retry-message");await scheduler.send(message,"retry-message");
 expect(job.state).toBe("queued");expect(job.pendingMessage).toBe(message.text);
 const page=await scheduler.chats.read(job.id);expect(page.items.filter(i=>i.text===message.text)).toHaveLength(1);
});

it("rolls back runtime settings on persistence failure and rejects changes with active ownership", async () => {
  await scheduler.dispatch(true);
  const previous = structuredClone(store.data.settings);
  const save = vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));
  await expect(scheduler.configure({...previous,retrySeconds:120})).rejects.toThrow("disk full");
  expect(store.data.settings).toEqual(previous);
  save.mockRestore();
  await scheduler.configure({...previous,retrySeconds:120});
  expect(store.data.settings.retrySeconds).toBe(120);
  await scheduler.dispatch(false);
  await scheduler.add({...input,cwd:root});
  await until(() => workers[0]?.started);
  await expect(scheduler.configure(previous)).rejects.toThrow("Pause tasks");
});

it("persists task organization atomically and cannot archive active work",async()=>{
 const job=await scheduler.add({...input,cwd:root});await until(()=>workers[0]?.started);
 await expect(scheduler.metadata(job.id,{archived:true})).rejects.toThrow("Pause");
 await scheduler.metadata(job.id,{title:"Renamed",pinned:true});expect(job.title).toBe("Renamed");
 const save=vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));
 await expect(scheduler.metadata(job.id,{title:"Lost"})).rejects.toThrow("disk full");expect(job.title).toBe("Renamed");save.mockRestore();
});
it("keeps batch workflow delivery gates durable and blocks dependent stages until actual verification",async()=>{
 await scheduler.dispatch(true);
 const check={kind:"file" as const,path:"result.txt",label:"Required output",minBytes:1};
 const jobs=await scheduler.addWorkflow("gated-workflow","Gated",[{...input,cwd:root,deliveryChecks:[check]},{...input,cwd:root}]);
 expect(jobs[0].delivery).toEqual({revision:1,checks:[check],reports:[]});expect((jobs[0] as any).deliveryChecks).toBeUndefined();
 jobs[0].state="completed";expect((scheduler as any).dependenciesBlocked(jobs[1])).toBe(true);
 await fs.writeFile(path.join(root,"result.txt"),"verified");await scheduler.checkDelivery(jobs[0].id);expect((scheduler as any).dependenciesBlocked(jobs[1])).toBe(false);
 const loaded=new Store(root);await loaded.load();expect(loaded.data.jobs[0].delivery?.reports.at(-1)?.status).toBe("passed");
});
it("counts isolated schedule worktrees against their source project's concurrency limit",async()=>{
 await scheduler.dispatch(true);
 const folders=["isolated-a","isolated-b","unrelated"].map(name=>path.join(root,name));for(const folder of folders)await fs.mkdir(folder);
 const occurrence=(id:string)=>({taskId:id,runId:id,requestedAt:Date.now(),sourceCwd:root});
 const a=await scheduler.add({...input,cwd:folders[0]},undefined,occurrence("a")),b=await scheduler.add({...input,cwd:folders[1]},undefined,occurrence("b")),c=await scheduler.add({...input,cwd:folders[2]});
 await scheduler.projectLimit(root,1);await scheduler.dispatch(false);await (scheduler as any).tick();await until(()=>workers.length===2&&workers.every(w=>w.started));
 expect(workers.map(w=>w.ctx.job.id)).toEqual([a.id,c.id]);expect(b.state).toBe("queued");
 const loaded=new Store(root);await loaded.load();expect(loaded.data.jobs[1].projectCwd).toBe(root);
 await scheduler.dispatch(true,root);
 workers[0].settle({kind:"completed"});await until(()=>!(scheduler as any).active.has(a.id));await (scheduler as any).tick();expect(workers).toHaveLength(2);
 await scheduler.dispatch(false,root);await (scheduler as any).tick();await until(()=>workers[2]?.started);expect(workers[2].ctx.job.id).toBe(b.id);
});
it("isolates throwing state observers without rejecting committed workflows or deleting their journals",async()=>{
 await scheduler.dispatch(true);let healthy=0;
 scheduler.on("operationsObserved",()=>{throw Error("api_key: observer-secret");});scheduler.on("operationsObserved",()=>{healthy++;});
 const steps=[{...input,cwd:root},{...input,cwd:root}];const jobs=await scheduler.addWorkflow("observer-flow","Observed",steps);
 expect(healthy).toBeGreaterThan(0);expect(store.data.jobs).toHaveLength(2);expect((await scheduler.chats.read(jobs[0].id)).items.some(i=>i.role==="user")).toBe(true);
 const repeated=await scheduler.addWorkflow("observer-flow","Observed",steps);expect(repeated.map(j=>j.id)).toEqual(jobs.map(j=>j.id));
 scheduler.changed();scheduler.changed();expect(store.data.logs.filter(l=>l.message.includes("状态订阅处理失败"))).toHaveLength(1);expect(JSON.stringify(store.data.logs)).not.toContain("observer-secret");
});
it("keeps healthy and once snapshot listeners working after synchronous and asynchronous listener failures",async()=>{
 let healthy=0,once=0;scheduler.on("snapshot",()=>{throw Error("sync observer");});scheduler.on("snapshot",async()=>{throw Error("async observer");});
 scheduler.on("snapshot",()=>{healthy++;});scheduler.once("snapshot",()=>{once++;});
 scheduler.changed();await until(()=>healthy===1&&store.data.logs.some(l=>l.message.includes("async observer")));
 scheduler.changed();await until(()=>healthy===2);expect(once).toBe(1);expect(store.data.logs.filter(l=>l.message.includes("状态订阅处理失败"))).toHaveLength(2);
});
