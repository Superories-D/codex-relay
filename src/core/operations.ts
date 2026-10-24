import type { Account, Job, Snapshot,Approval } from "../shared/types";
import { dependencyBlockers } from "../shared/task-dependencies";
import { dispatchHeld, projectHasCapacity, projectKey } from "../shared/dispatch";
import { deliveryAccepted } from "../shared/delivery";
import { hasQuotaEvidence, isExhausted } from "./quota";
import { supportsModel } from "../shared/model-access";

export type OperationGateCode = "cli" | "closing" | "maintenance" | "warmupRecovery" | "ownership" | "handoff" | "recovery" |
  "globalDispatch" | "projectDispatch" | "dependencies" | "family" | "control" | "globalCapacity" | "projectCapacity" | "accounts" | "delivery";
export interface OperationGate {code:OperationGateCode; related:string[]; scope:"admission"|"review"}
export interface OperationsRuntime {
  cliReady:boolean;
  closing:boolean;
  maintaining:boolean;
  priming?:boolean;
  primeBlocking?:boolean;
  active:string[];
  controls:string[];
  recovering:string[];
  home:(id:string)=>string;
  selectable:(job:Job)=>boolean;
  accountReasons?:(job:Job)=>Partial<Record<AccountGateCode,number>>;
  index?:{jobs:ReadonlyMap<string,Job>;approvals:ReadonlyMap<string,Approval[]>;owners:string[];handoffs:string[];activeJobs:Job[]};
}
export function indexOperations(snapshot:Snapshot,runtime:OperationsRuntime):OperationsRuntime {
  const jobs=new Map(snapshot.jobs.map(job=>[job.id,job])),approvals=new Map<string,Approval[]>();
  for(const approval of snapshot.approvals){const values=approvals.get(approval.jobId)||[];values.push(approval);approvals.set(approval.jobId,values);}
  return {...runtime,index:{jobs,approvals,owners:[...new Set([...runtime.recovering,...snapshot.jobs.filter(j=>j.recoveryRequired).map(j=>j.id)])],
    handoffs:snapshot.jobs.filter(j=>j.existing&&j.existing.phase!=="managed"&&!["cancelled","completed"].includes(j.state)).map(j=>j.id),
    activeJobs:runtime.active.map(id=>jobs.get(id)).filter((job):job is Job=>!!job)}};
}
export type AccountGateCode = "disabled"|"reauth"|"offline"|"expired"|"ownership"|"warmup"|"cooldown"|"model"|"quotaMissing"|"quotaStale"|"quotaSpent";
export function accountGateReasons(account:Account,job:Job,owned:boolean,now=Date.now()):AccountGateCode[] {
  const reasons:AccountGateCode[]=[];
  if(!account.enabled)reasons.push("disabled");
  if(account.status==="reauth")reasons.push("reauth");
  if(account.status==="offline")reasons.push("offline");
  if(typeof account.expiresAt==="number"&&account.expiresAt<=now)reasons.push("expired");
  if(owned)reasons.push("ownership");
  if(Object.values(account.warmups||{}).some(w=>w.status==="running"||w.processSafe===false))reasons.push("warmup");
  if((account.blockedUntil??0)>now)reasons.push("cooldown");
  if(supportsModel(account,job.model,now)===false)reasons.push("model");
  const quota=account.quotas[job.bucket];
  if(!hasQuotaEvidence(quota))reasons.push("quotaMissing");
  else {if(quota.observedAt>now||now-quota.observedAt>120000)reasons.push("quotaStale");if(isExhausted(quota))reasons.push("quotaSpent");}
  return reasons;
}

/** Current facts only. This does not reconstruct history or authorize a resume.
 * Runtime ownership/selection inputs come from the scheduler itself so a UI
 * cannot claim a task is runnable from a completed badge or cached quota alone.
 */
export function operationCard(snapshot:Snapshot, job:Job, runtime:OperationsRuntime) {
  const gates:OperationGate[]=[];
  const add=(code:OperationGateCode,related:string[]=[],scope:OperationGate["scope"]="admission")=>gates.push({code,related,scope});
  const approvals=(runtime.index?runtime.index.approvals.get(job.id)||[]:snapshot.approvals.filter(a=>a.jobId===job.id)).map(a=>({id:a.id,reviewId:a.reviewId,historyId:a.historyId,kind:a.kind,responsePending:!!a.responsePending}));
  const dispatchable=["queued","waiting"].includes(job.state);
  if(job.delivery?.checks.length&&!deliveryAccepted(job.delivery))add("delivery",[],"review");
  if(job.autoRecovery||job.recoveryRequired)add("recovery",[job.id]);
  if(dispatchable) {
    if(!runtime.cliReady)add("cli");
    if(runtime.closing)add("closing");
    if(runtime.maintaining)add("maintenance");
    if(runtime.priming)add("warmupRecovery",[],runtime.primeBlocking===false?"review":"admission");
    const owners=runtime.index?.owners||[...new Set([...runtime.recovering,...snapshot.jobs.filter(j=>j.recoveryRequired).map(j=>j.id)])];
    if(owners.length)add("ownership",owners);
    const external=runtime.index?.handoffs||snapshot.jobs.filter(j=>j.existing&&j.existing.phase!=="managed"&&!["cancelled","completed"].includes(j.state)).map(j=>j.id);
    if(external.length)add("handoff",external);
    if(dispatchHeld(snapshot,job,snapshot.platform))add(snapshot.dispatch?.paused?"globalDispatch":"projectDispatch");
    const dependencies=dependencyBlockers(job,snapshot.jobs,runtime.index?.jobs).concat((job.dependsOn||[]).filter(id=>runtime.active.includes(id)||runtime.controls.includes(runtime.home(id))));
    if(dependencies.length)add("dependencies",[...new Set(dependencies)]);
    const family=runtime.active.filter(id=>runtime.home(id)===runtime.home(job.id));if(family.length)add("family",family);
    if(runtime.controls.includes(runtime.home(job.id)))add("control");
    const limit=Math.max(1,Math.min(8,snapshot.settings.maxConcurrentTasks??3));
    if(runtime.active.length>=limit)add("globalCapacity",runtime.active);
    const active=runtime.index?.activeJobs||snapshot.jobs.filter(j=>runtime.active.includes(j.id));
    if(!projectHasCapacity(snapshot,job,active,snapshot.platform))add("projectCapacity",active.filter(j=>projectKey(j.projectCwd||j.cwd,snapshot.platform)===projectKey(job.projectCwd||job.cwd,snapshot.platform)).map(j=>j.id));
    if(!runtime.selectable(job))add("accounts");
  }
  return {
    id:job.id,title:job.title,state:job.state,at:Date.now(),dispatchable,familyId:job.runtimeHomeId||job.id,
    accountReasons:dispatchable&&gates.some(g=>g.code==="accounts")?runtime.accountReasons?.(job):undefined,
    nextWakeAt:job.nextWakeAt,
    // Ready is an instantaneous admission observation, never a promise that a
    // worker started, nor evidence that a task or its artifacts are complete.
    ready:dispatchable&&!gates.some(g=>g.scope==="admission")&&!approvals.length,
    gates,approvals,pausedByUser:job.stopIntent==="pause",cancelledByUser:job.stopIntent==="cancel",
    acceptance:!job.delivery?.checks.length?"none" as const:deliveryAccepted(job.delivery)?"passed" as const:"held" as const,
  };
}
