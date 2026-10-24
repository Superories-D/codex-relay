import { expect,it } from "vitest";
import { operationCard, accountGateReasons, type OperationsRuntime } from "../src/core/operations";
import type { Account } from "../src/shared/types";
import type { Snapshot,Job } from "../src/shared/types";
const job=(id:string,state:Job["state"]="queued")=>({id,title:id,cwd:"D:\\project",state,mode:"cli"} as Job);
const snapshot=(jobs:Job[]):Snapshot=>({jobs,accounts:[],approvals:[],settings:{maxConcurrentTasks:3},platform:"win32"} as unknown as Snapshot);
const runtime=():OperationsRuntime=>({cliReady:true,closing:false,maintaining:false,active:[],controls:[],recovering:[],home:id=>id,selectable:()=>true});
it("explains global ownership holds from a different project instead of reporting a falsely runnable queue",()=>{
  const queued=job("queued"),owner=job("owner","needs_attention");owner.cwd="E:\\other";owner.recoveryRequired=true;
  const card=operationCard(snapshot([queued,owner]),queued,runtime());expect(card.ready).toBe(false);expect(card.gates).toEqual([{code:"ownership",related:[owner.id],scope:"admission"}]);
});
it("does not require a task to have produced accepted artifacts before admitting its initial run",()=>{
  const queued=job("new");queued.delivery={revision:1,checks:[{kind:"file",path:"future.bin",label:"Future output",minBytes:1}],reports:[]};
  const card=operationCard(snapshot([queued]),queued,runtime());expect(card.ready).toBe(true);expect(card.acceptance).toBe("held");expect(card.gates[0].scope).toBe("review");
});
it("identifies every occupied project slot and a still-settling recovery whose task was removed",()=>{
  const queued=job("queued"),one=job("one","running"),two=job("two","running"),state=snapshot([queued,one,two]);state.projectLimits=[{cwd:queued.cwd,limit:2}];
  const card=operationCard(state,queued,{...runtime(),active:[one.id,two.id],recovering:["removed-owner"]});
  expect(card.gates.find(g=>g.code==="projectCapacity")?.related).toEqual([one.id,two.id]);expect(card.gates.find(g=>g.code==="ownership")?.related).toEqual(["removed-owner"]);
});
it("uses actual runtime family ownership and pending controls, including a completed predecessor still closing",()=>{
  const queued=job("queued"),parent=job("parent","completed");queued.dependsOn=[parent.id];
  const live={...runtime(),active:[parent.id],controls:[parent.id],home:(id:string)=>id===queued.id?parent.id:id};
  const card=operationCard(snapshot([queued,parent]),queued,live);expect(card.gates.map(g=>g.code)).toEqual(expect.arrayContaining(["dependencies","family","control"]));
});
it("preserves explicit pause and exposes only request identities, never secret question params",()=>{
  const paused=job("paused","paused");paused.stopIntent="pause";const state=snapshot([paused]);
  state.approvals=[{id:"request",jobId:paused.id,kind:"input",method:"input",params:{secret:"DO NOT EXPORT"}}];
  const card=operationCard(state,paused,runtime());expect(card.ready).toBe(false);expect(card.pausedByUser).toBe(true);expect(card.approvals[0].id).toBe("request");expect(JSON.stringify(card)).not.toContain("DO NOT EXPORT");expect(paused.state).toBe("paused");
});
it("keeps completed state separate from missing acceptance evidence and shows all simultaneous queue gates",()=>{
  const done=job("done","completed");done.delivery={revision:1,checks:[{kind:"file",path:"artifact",label:"Artifact",minBytes:1}],reports:[]};
  const completed=operationCard(snapshot([done]),done,runtime());expect(completed.state).toBe("completed");expect(completed.acceptance).toBe("held");expect(completed.ready).toBe(false);
  const queued=job("queued"),state=snapshot([queued,done]);state.dispatch={paused:true,projects:[],updatedAt:1};queued.dependsOn=[done.id];
  const card=operationCard(state,queued,{...runtime(),cliReady:false,selectable:()=>false});expect(card.gates.map(g=>g.code)).toEqual(expect.arrayContaining(["cli","globalDispatch","dependencies","accounts"]));
});
it("reports warmup ownership recovery separately from queue capacity and never exposes account identities",()=>{
  const queued=job("queued"),card=operationCard(snapshot([queued]),queued,{...runtime(),priming:true,selectable:()=>false,accountReasons:()=>({ownership:2,quotaStale:1})});
  expect(card.ready).toBe(false);expect(card.gates.map(g=>g.code)).toContain("warmupRecovery");expect(card.accountReasons).toEqual({ownership:2,quotaStale:1});
});
it("explains all actual account eligibility constraints without treating elapsed reset time as replenished quota",()=>{
  const now=Date.now(),queued={...job("queued"),bucket:"codex",model:"model-x"};
  const account={id:"account",identity:"private",label:"private",email:"private",plan:"plus",failureCount:0,enabled:true,status:"ready",expiresAt:now+1000,blockedUntil:now+500,quotas:{codex:{primary:{usedPercent:100,resetsAt:now-1,windowDurationMins:300},secondary:null,observedAt:now-121000,reached:false,limitId:"codex"}},warmups:{}} as Account;
  expect(accountGateReasons(account,queued,true,now)).toEqual(expect.arrayContaining(["ownership","cooldown","quotaStale","quotaSpent"]));
  account.enabled=false;account.status="reauth";account.expiresAt=now;expect(accountGateReasons(account,queued,false,now)).toEqual(expect.arrayContaining(["disabled","reauth","expired"]));
});
