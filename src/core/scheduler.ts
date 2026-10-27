import { dispatchHeld, projectKey, projectHasCapacity } from "../shared/dispatch";
import {taskControlSignature} from "../shared/task-control";
import { operationCard, accountGateReasons,indexOperations, type AccountGateCode } from "./operations";
import { operationObservation } from "./operations-observation";
import {RecoveryDomains,captureWindowsDomain} from "./recovery-domains";
import type {RecoveryPlan} from "../shared/recovery";
import { verifyDelivery } from "./delivery";
import { deliveryChecksSchema, deliveryRepairPrompt, type DeliveryCheck, type DeliveryReport } from "../shared/delivery";
import { dependencyBlockers, validateDependencies } from "../shared/task-dependencies";
import { EventEmitter } from "node:events";
import { orderTasks } from "../shared/task-order";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Account,
  Approval,
  Job,
  NewJob,
  ExistingLink,
  Quota,
  Snapshot,
  ThreadGoal,
  QuestionRecord,
} from "../shared/types";
import { Accounts } from "./accounts";
import { Store } from "./store";
import {
  errorKind,
  hasQuotaEvidence,
  isExhausted,
  nextWake,
  pickAccount,
  resetDeadline,
} from "./quota";
import type { Outcome, Worker, WorkerFactory } from "./worker";
import { redact } from "./redact";
import { ProcessSafetyError } from "./process-safety-error";
import { Chats, protocolItem } from "./chat";
import type { ChatAttachment } from "../shared/types";
import { capabilities } from "../shared/capabilities";
import { Rpc } from "./rpc";
import { prepareThread } from "./thread";
import { isModelRejection } from "./model-error";
import { ensureWindowsSandbox } from "./windows-sandbox";
import { AccountWarmups } from "./account-warmups";
import { WarmupRunner } from "./warmup-runner";
import { validateQuestionAnswers } from "../shared/user-questions";
import {
  clearRecovery,
  scheduleRecovery,
  RecoveryError,
  recordRecovery,
} from "./auto-recovery";
import {
  MODEL_ACCESS_TTL,
  freshModelAccess,
  supportsModel,
  modelRank,
  denyModel,
} from "../shared/model-access";
class ModelRoutingError extends Error {}
interface ActiveRun {
  job: Job;
  worker?: Worker;
  reason?: "pause" | "cancel" | "shutdown";
  failedStop?: boolean;
  done?: Promise<void>;
}
export class Scheduler extends EventEmitter {
  runtimeReady: () => boolean = () => true;
  readonly chats: Chats;
  approvals: Approval[] = [];
  private active = new Map<string, ActiveRun>();
  private jobControls = new Map<string, Promise<unknown>>();
  private recoveryTasks = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private tickInFlight?: Promise<void>;
  private controls: Promise<unknown> = Promise.resolve();
  private closing = false;
  private resumeOnShutdown=false;
  private verification = new AbortController();
  private deliveryRecovery?: Promise<void>;
  private deliveryControllers = new Map<string, AbortController>();
  private maintaining = false;
  private get currentRun() {
    return Promise.all([...this.active.values()].map((run) => run.done));
  }
  private familyActive(id: string) {
    const home = this.store.jobHome(id);
    return [...this.active.values()].some(
      (run) => this.store.jobHome(run.job.id) === home,
    );
  }
  notificationSettled(id:string){
    return !this.familyActive(id)&&!this.jobControls.has(this.store.jobHome(id))&&!this.recoveryTasks.has(id);
  }
  private accountActive(id: string, runningOnly = false) {
    return [...this.active.values()].some(
      (run) =>
        run.job.accountId === id &&
        (!runningOnly || run.job.state === "running"),
    );
  }
  private queueWrites = new Map<string, Promise<void>>();
  private queueControl<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const key = this.store.jobHome(id);
    const dependencies = [this.controls, this.jobControls.get(key)];
    const task = Promise.allSettled(dependencies).then(fn);
    this.jobControls.set(key, task);
    this.changed();
    void task
      .finally(() => {
        if (this.jobControls.get(key) === task) {this.jobControls.delete(key);this.changed();}
      })
      .catch(() => {});
    return task;
  }
  private queueMaintenance<T>(fn: () => Promise<T>): Promise<T> {
    const task = Promise.allSettled([
      this.controls,
      ...this.jobControls.values(),
    ]).then(fn);
    this.controls = task;
    return task;
  }
  private dependenciesBlocked(job: Job) {
    return dependencyBlockers(job, this.store.data.jobs).length > 0 || (job.dependsOn || []).some(id => this.active.has(id) || this.jobControls.has(this.store.jobHome(id)));
  }
  private selectionPool(job: Job) {
    // Keep array indexes stable for round-robin cursors. CLI runtimes share only
    // access tokens; a Desktop runtime must exclusively own its account profile.
    const held=this.domains?.blockedAccounts([...this.recoveryTasks.keys()]);
    return this.store.data.accounts.map((account) => {
      const conflict =
        held?.has(account.id)||
        this.accounts.busy.has(account.id) ||
        [...this.active.values()].some(
          (run) =>
            run.job.id !== job.id &&
            run.job.accountId === account.id &&
            (job.mode === "desktop" || run.job.mode === "desktop"),
        );
      return conflict ? { ...account, enabled: false } : account;
    });
  }
  private selectAccount(job: Job) {
    return pickAccount(
      this.selectionPool(job),
      this.store.data.cursor,
      job.bucket,
      Date.now(),
      this.store.data.settings.accountSelection || "smart",
      job.model,
    );
  }
  private probes = new Map<string, number>();
  private publishTimer?: NodeJS.Timeout;
  readonly warmups: AccountWarmups;
  private warmupRecovery: Promise<void>;
  private warmupRecoveryCount = 0;
  private awaitingWarmups = false;
  private backgroundProbe?: Promise<void>;
  private lastWarmupRecovery = 0;
  private questionReplies = new Map<string, QuestionRecord["answers"]>();
  private syncAgentRoot(
    job: Job,
    patch: Partial<import("../shared/types").AgentState>,
  ) {
    if (!job.agentOrigin || !job.threadId) return;
    for (const owner of this.store.data.jobs) {
      if (this.store.jobHome(owner.id) !== this.store.jobHome(job.id)) continue;
      const agent = owner.agents?.find(
        (agent) => agent.threadId === job.threadId,
      );
      if (agent)
        Object.assign(agent, { model: job.model, effort: job.effort }, patch, {
          updatedAt: Date.now(),
        });
    }
  }
  private recordQuestion(
    a: Approval,
    status: QuestionRecord["status"],
    answers?: QuestionRecord["answers"],
  ) {
    a.historyId ||= `question:${randomUUID()}`;
    a.createdAt ||= Date.now();
    return this.chats
      .question(a, status, answers)
      .then(() => this.emit("chatChanged", a.jobId));
  }
  constructor(
    readonly store: Store,
    readonly accounts: Accounts,
    private factories: Record<"cli" | "desktop", WorkerFactory>,
    private recover: (job: Job) => Promise<void> = async () => {},
    private beforeStart: (job: Job) => Promise<void> = async () => {},
    private domains?:RecoveryDomains,
  ) {
    super();
    this.chats = new Chats(store.root);
    this.warmups = new AccountWarmups(
      store,
      () => this.changed(),
      (account, record) =>
        new WarmupRunner(
          store,
          accounts,
          account,
          async (home) => {
            record.home = home;
            record.processSafe = false;
            await store.save();
          },
          record.resetAt,
        ),
      (account) => {
        if (
          !this.runtimeReady() || this.closing ||
          this.maintaining ||
          this.recoveryTasks.size > 0 ||
          accounts.busy.has(account.id) ||
          store.data.jobs.some((j) => j.recoveryRequired)
        )
          return false;
        if (
          store.data.jobs.some(
            (j) =>
              j.accountId === account.id &&
              ["preparing", "running", "pausing"].includes(j.state),
          )
        )
          return false;
        return this.active.size
          ? !this.accountActive(account.id)
          : !store.data.jobs.some(
              (j) =>
                ["queued", "preparing", "running", "pausing"].includes(
                  j.state,
                ) ||
                (j.state === "waiting" && (j.nextWakeAt || 0) <= Date.now()),
            );
      },
      (account) => accounts.busy.delete(account.id),
    );
    this.warmupRecovery = this.recoverWarmups();
    accounts.quotaObserved = (account, previous, fresh) =>
      this.warmups.observe(
        account,
        previous,
        fresh,
        this.accountActive(account.id, true),
      );
  }
  snapshot(): Snapshot {
    return structuredClone({
      ...this.store.data,
      approvals: this.approvals,
      login: this.accounts.loginDisplay,
      loginError: this.accounts.loginError,
      loginResult: this.accounts.loginResult,
      platform: process.platform,
    });
  }
  private recoverWarmups() {
    this.warmupRecoveryCount++;
    return this.warmups.recover().catch(error=>this.log(error,"warning")).finally(()=>{
      this.warmupRecoveryCount--;this.changed();
    });
  }
  operations() {
    // Read only the fields used by the inspector; do not clone prompts, large
    // transcripts or account login payloads for a periodic operations refresh.
    const snapshot:Snapshot={...this.store.data,approvals:this.approvals,platform:process.platform},now=Date.now();
    const jobs=new Map(snapshot.jobs.map(job=>[job.id,job])),homes=new Map<string,string>();
    const runtime=indexOperations(snapshot,{cliReady:this.runtimeReady(),closing:this.closing,maintaining:this.maintaining,priming:this.warmupRecoveryCount>0,primeBlocking:!this.ticking||this.awaitingWarmups,
      active:[...this.active.keys()],controls:[...this.jobControls.keys()],recovering:[...this.recoveryTasks.keys()],ownership:job=>this.ownershipBlockers(job),
      home:(id:string)=>{let home=homes.get(id);if(!home){home=this.store.jobHome(id,jobs);homes.set(id,home);}return home;},selectable:(job:Job)=>!!this.selectAccount(job),
      accountReasons:(job:Job)=>{
        const counts:Partial<Record<AccountGateCode,number>>={},pool=this.selectionPool(job);
        this.store.data.accounts.forEach((account,i)=>{
          for(const reason of accountGateReasons(account,job,account.enabled&&!pool[i].enabled,now))counts[reason]=(counts[reason]||0)+1;
        });return counts;
      }});
    return {at:now,cards:snapshot.jobs.map(job=>operationCard(snapshot,job,runtime))};
  }
  operationsObservation() {
    const jobs=new Map(this.store.data.jobs.map(job=>[job.id,job]));
    return operationObservation(this.store.data,this.approvals,{active:new Set(this.active.keys()),controls:new Set(this.jobControls.keys()),home:id=>this.store.jobHome(id,jobs)},process.platform);
  }
  private observerFailures=new WeakSet<Function>();
  private notifyObservers(event:"operationsObserved"|"snapshot",...args:unknown[]) {
    for(const listener of this.rawListeners(event)){
      const failed=(error:unknown)=>{
        if(this.observerFailures.has(listener))return;
        this.observerFailures.add(listener);
        this.store.data.logs.push({id:randomUUID(),at:Date.now(),level:"warning",message:`状态订阅处理失败（${event}）：${redact(error instanceof Error?error.message:String(error),2000)}`});
        this.trimLogs();
      };
      try{
        // rawListeners preserves once wrappers and isolates each subscriber.
        const result=listener.apply(this,args);
        if(result&&typeof result.then==="function")void Promise.resolve(result).catch(failed);
      }catch(error){failed(error);}
    }
  }
  private trimLogs(){
    let characters = 0;
    this.store.data.logs = this.store.data.logs
      .slice(-500).reverse().filter((log) => {characters += log.message.length;return characters <= 500_000;}).reverse();
  }
  changed() {
    // Separate from the coalesced renderer snapshots: observers can retain
    // distinct scheduler facts even when several changes occur within100ms.
    if(this.listenerCount("operationsObserved"))this.notifyObservers("operationsObserved");
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      if (this.listenerCount("snapshot"))
        this.notifyObservers("snapshot", this.snapshot());
    }, 100);
    this.publishTimer.unref?.();
  }
  log(
    message: unknown,
    level: "info" | "warning" | "error" | "output" = "info",
    jobId?: string,
  ) {
    const redacted = redact(message);
    const value =
      redacted.length > 12000
        ? redacted.slice(0, 12000) +
          "\n[本条输出过长，后续内容请查看 Codex 会话]"
        : redacted;
    if (!value.trim()) return;
    const last = this.store.data.logs.at(-1);
    if (
      level === "output" &&
      last?.level === "output" &&
      last.jobId === jobId &&
      last.message.length + value.length <= 12000
    )
      last.message = redact(last.message + value);
    else
      this.store.data.logs.push({
        id: randomUUID(),
        at: Date.now(),
        level,
        message: value,
        jobId,
      });
    this.trimLogs();
    this.changed();
  }
  add(input: NewJob, existing?: { link: ExistingLink; threadId: string; turnId?: string }, schedule?: Job["schedule"], requestId?: string): Promise<Job> {
    if (!requestId) return this.addOnce(input, existing, schedule);
    return this.queueMaintenance(async () => {
      this.maintaining = true;
      try { await this.tickInFlight; return await this.addOnce(input, existing, schedule, requestId); }
      finally { this.maintaining = false; }
    });
  }
  saveDelivery(id: string, revision: number, input: DeliveryCheck[]) {
    const checks = deliveryChecksSchema.parse(input);
    return this.queueControl(id, async () => {
      const job = this.store.data.jobs.find(j => j.id === id);
      if (!job) throw Error("任务不存在");
      if (this.closing || this.familyActive(id) || job.recoveryRequired) throw Error("请先暂停任务，再修改验收条件");
      if ((job.delivery?.revision || 0) !== revision) throw Error("验收条件已更改，请重新打开后再保存");
      const previous = job.delivery, state = job.state, before = structuredClone(job);
      job.delivery = {revision: revision + 1, checks, reports: previous?.reports || [],
        blockedCompletion: !!checks.length && (state === "completed" || previous?.blockedCompletion), pendingCompletion: false};
      if (job.delivery.blockedCompletion && state === "completed") {job.state = "needs_attention"; job.lastError = "验收条件已更改，请重新验收交付产物";}
      try {
        if(!checks.length && previous?.blockedCompletion && state === "needs_attention" && !job.stopIntent) {
          job.state="completed";job.lastError=undefined;
          await this.advanceDeliveryQueue(job);
        }
        await this.store.save();
      } catch (failure) {
        for(const key of Object.keys(job))if(!Object.hasOwn(before,key))delete (job as any)[key];
        Object.assign(job,before);throw failure;
      }
      this.changed();
      return structuredClone(job.delivery);
    });
  }
  readDelivery(id: string) {
    const job = this.store.data.jobs.find(j => j.id === id);
    if (!job) throw Error("任务不存在");
    return structuredClone(job.delivery || {revision: 0, checks: [], reports: []});
  }
  deliveryTarget(id: string) {
    const job = this.store.data.jobs.find(j => j.id === id);
    if (!job) throw Error("任务不存在");
    if (this.closing || this.familyActive(id) || job.recoveryRequired) throw Error("任务正在运行或恢复，无法更新交付证据");
    return structuredClone(job);
  }
  deliveryPrompt(id: string) {
    const delivery = this.readDelivery(id), report = delivery.reports.at(-1);
    if (!report || report.revision !== delivery.revision || report.status === "passed") throw Error("没有当前版本的失败验收结果");
    return deliveryRepairPrompt(report);
  }
  cancelDelivery(id:string) {
    if(!this.store.data.jobs.some(job=>job.id===id))throw Error("任务不存在");
    const controller=this.deliveryControllers.get(id);controller?.abort();return {cancelled:!!controller};
  }
  interruptDeliveryChecks() {
    this.verification.abort();
  }
  flagDeliveryEvidence(id: string, revision: number, reportId: string, reason: "changed" | "unverified") {
    return this.queueControl(id, async () => {
      const job = this.store.data.jobs.find(j => j.id === id);
      if (!job) throw Error("任务不存在");
      if (this.closing || this.familyActive(id) || job.recoveryRequired) throw Error("任务正在运行或恢复，无法更新交付证据");
      const delivery = job.delivery;
      if (!delivery || delivery.revision !== revision || delivery.reports.at(-1)?.id !== reportId)
        throw Error("交付证据已更新，请重新检查");
      const before = structuredClone(job);
      delivery.staleEvidence = {reportId, at: Date.now(), reason};
      job.stage = "交付证据已失效";
      if (job.state === "completed") {
        job.state = "needs_attention"; delivery.blockedCompletion = true;
        job.lastError = "交付证据已失效，请重新验收产物";
      }
      try {await this.store.save();}
      catch (error) {
        for (const key of Object.keys(job)) if (!Object.hasOwn(before, key)) delete (job as any)[key];
        Object.assign(job, before); throw error;
      }
      this.changed(); return structuredClone(job.delivery);
    });
  }
  checkDelivery(id: string, source: "manual" | "recovery" = "manual", signal?: AbortSignal, expected?: {revision: number; reportId?: string}) {
    return this.queueControl(id, async () => {
      const job = this.store.data.jobs.find(j => j.id === id);
      if (!job) throw Error("任务不存在");
      signal?.throwIfAborted();
      if (this.closing || this.familyActive(id) || job.recoveryRequired) throw Error("请先暂停任务，再检查交付产物");
      const delivery = job.delivery;
      if (!delivery?.checks.length) throw Error("请先设置交付验收条件");
      if (expected && (delivery.revision !== expected.revision || delivery.reports.at(-1)?.id !== expected.reportId))
        throw Error("交付证据已更新，请重新检查");
      const previous = structuredClone(job);
      try {
      const wasBlocked = delivery.blockedCompletion || delivery.pendingCompletion;
      const report = await this.recordDelivery(job, source, signal);
      if (report.status !== "passed" && job.state === "completed") {
        job.state = "needs_attention"; delivery.blockedCompletion = true;
        job.lastError = "交付验收未通过，请检查结果并修正产物";
      }
      if (wasBlocked && report.status === "passed" && job.state === "needs_attention" && !job.stopIntent) {
        job.state = "completed"; job.lastError = undefined; delivery.blockedCompletion = false;
        await this.advanceDeliveryQueue(job);
      }
      await this.store.save(); this.changed();
      return structuredClone(delivery);
      } catch (error) {
        for (const key of Object.keys(job)) if (!Object.hasOwn(previous, key)) delete (job as any)[key];
        Object.assign(job, previous);
        this.changed();
        throw error;
      }
    });
  }
  private async recordDelivery(job: Job, source: DeliveryReport["source"], signal?: AbortSignal) {
    const delivery = job.delivery!;
    const controller=new AbortController();this.deliveryControllers.set(job.id,controller);
    try {
    if (source !== "manual") {delivery.pendingCompletion = true; await this.store.save();}
    job.stage = "正在验收交付产物"; this.changed();
    const report = await verifyDelivery(job.cwd, delivery.checks, {revision: delivery.revision, source, turnId: job.turnId, signal: AbortSignal.any([this.verification.signal,controller.signal,...(signal ? [signal] : [])])});
    delivery.reports = [...delivery.reports, report].slice(-10);
    // A service shutdown is an interrupted read, not failed artifact evidence.
    // Recheck it on restart unless the user deliberately paused/cancelled work.
    delivery.pendingCompletion = !job.stopIntent && this.verification.signal.aborted && report.findings.some(f=>f.code === "cancelled");
    delete delivery.staleEvidence;
    if (source !== "manual") delivery.blockedCompletion = report.status !== "passed";
    job.stage = report.status === "passed" ? "交付验收通过" : "交付验收未通过";
    return report;
    } finally {if(this.deliveryControllers.get(job.id)===controller)this.deliveryControllers.delete(job.id);}
  }
  private async advanceDeliveryQueue(job: Job) {
    const next = job.queuedMessages?.[0];
    if (!next) return;
    const before={pendingMessage:job.pendingMessage,attachments:job.attachments,model:job.model,effort:job.effort,
      planMode:job.planMode,multiAgent:job.multiAgent,serviceTier:job.serviceTier,review:job.review,
      completionMarker:job.completionMarker,completionRetries:job.completionRetries,enqueuedAt:job.enqueuedAt};
    const undo=()=>{
      Object.assign(job,before);
      if(!job.queuedMessages?.some(message=>message.id===next.id))job.queuedMessages=[next,...(job.queuedMessages||[])];
      job.queueRevision=(job.queueRevision||0)+1;
    };
    job.queuedMessages = job.queuedMessages!.slice(1);
    job.queueRevision = (job.queueRevision || 0) + 1;
    try {await this.chats.user(job.id, next.text, next.attachments.map(a => a.path).join("\n"), next.id);}
    catch(error){undo();throw error;}
    job.pendingMessage = next.text; job.attachments = next.attachments;
    if (next.model !== undefined) job.model = next.model;
    if (next.effort !== undefined) job.effort = next.effort;
    if (next.planMode !== undefined) job.planMode = next.planMode;
    if (next.multiAgent !== undefined) job.multiAgent = next.multiAgent;
    if (next.serviceTier !== undefined) job.serviceTier = next.serviceTier;
    job.review = next.review; job.completionMarker = undefined; job.completionRetries = 0;
    job.state = "queued"; job.enqueuedAt = Date.now();
    return undo;
  }
  private async finishRecordedCompletion(job:Job, source:"automatic"|"recovery") {
    if(source === "recovery") {
      await this.chats.flush(job.id);
      for(const agent of job.agents||[])await this.chats.flush(agent.threadId);
      // The protocol reducer can finish after the success checkpoint. Once
      // the old owner is idle, include its retained final records in the window.
      if(job.completionPending && job.completion)
        job.completion.finishedAt=Math.max(job.completion.finishedAt,Date.now());
    }
    let failed=false,undo:undefined|(()=>void);
    if (!job.stopIntent && !this.closing && job.delivery?.checks.length)
      failed=(await this.recordDelivery(job,source)).status !== "passed";
    if (job.stopIntent === "cancel") job.state="cancelled";
    else if (job.stopIntent || job.archived || this.closing) job.state="paused";
    else if (failed) {
      job.state="needs_attention";
      job.lastError="交付验收未通过，请检查结果并修正产物";
      this.log(job.lastError,"warning",job.id);
    } else {
      job.state="completed";job.lastError=undefined;
      if(job.recoveryAttempts)recordRecovery(job,"completed");
      this.log(source === "recovery" ? "已恢复完成回执，仅补充验收和结果收尾，未重新执行本轮" : "Codex 正常完成本轮任务，未检测到额度中断","info",job.id);
      undo=await this.advanceDeliveryQueue(job);
    }
    if(job.stopIntent){
      job.goalResumeAfterQuota=false;job.goalResumeAfterModelChange=false;
      if(job.recoveryAttempts)recordRecovery(job,"stopped");
    }
    if(source === "recovery") {
      // advanceDeliveryQueue may have changed completed to queued.
      const state=job.state as Job["state"];
      this.syncAgentRoot(job,{turnId:job.turnId,status:state === "completed" ? "completed" :
        state === "queued" ? "waiting" : state === "paused" || state === "cancelled" ? "interrupted" : "errored"});
    }
    clearRecovery(job);job.recoveryAttempts=0;
    if(!(this.closing&&this.resumeOnShutdown&&!job.stopIntent&&job.state==="paused"))job.completionPending=undefined;
    return undo;
  }
  private async addOnce(
    input: NewJob,
    existing?: { link: ExistingLink; threadId: string; turnId?: string },
    schedule?: Job["schedule"],
    requestId?: string,
  ) {
    const fingerprint = requestId ? createHash("sha256").update(JSON.stringify(input)).digest("hex") : undefined;
    if (requestId) {
      if (this.closing) throw Error("客户端正在关闭");
      const existingRequest = this.store.data.jobs.find(j => j.clientRequest?.id === requestId);
      if (existingRequest) {
        if (existingRequest.clientRequest!.fingerprint !== fingerprint) throw Error("请求标识已用于不同任务");
        return existingRequest;
      }
    }
    if (schedule) {
      const admitted = this.store.data.jobs.find(
        (job) =>
          job.schedule?.taskId === schedule.taskId &&
          job.schedule.runId === schedule.runId,
      );
      if (admitted) {
        await this.store.save();
        return admitted;
      }
    }
    const stat = await fs.stat(input.cwd);
    if (!stat.isDirectory()) throw new Error("工作目录不存在");
    if (
      existing &&
      (this.active.size ||
        this.store.data.jobs.some(
          (j) =>
            j.recoveryRequired ||
            [
              "queued",
              "waiting",
              "watching",
              "preparing",
              "running",
              "pausing",
              "rotating",
            ].includes(j.state),
        ))
    )
      throw new Error("另一任务已开始，请先暂停它再接入原会话");
    const {deliveryChecks, ...jobInput} = input;
    const checks = deliveryChecksSchema.parse(deliveryChecks || []);
    const job: Job = {
      ...jobInput,
      ...(checks.length ? {delivery: {revision: 1, checks, reports: []}} : {}),
      ...(requestId ? {clientRequest: {id: requestId, fingerprint: fingerprint!}} : {}),
      ...(schedule ? { schedule,...(schedule.sourceCwd?{projectCwd:schedule.sourceCwd}:{}) } : {}),
      ...(input.interactive ? { pendingMessage: input.prompt } : {}),
      id: randomUUID(),
      state: existing ? "watching" : "queued",
      ...(existing
        ? {
            existing: existing.link,
            threadId: existing.threadId,
            turnId: existing.turnId,
            stage: "接入已有会话，等待核实原进程",
          }
        : {}),
      rotations: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (input.interactive)
      await this.chats.user(
        job.id,
        input.prompt,
        input.attachments?.map((a) => a.path).join("\n"),
      );
    this.store.data.jobs.push(job);
    try { await this.store.save(); } catch(error) { this.store.data.jobs = this.store.data.jobs.filter(j => j !== job); throw error; }
    this.changed();
    void this.tick().catch((error) => this.log(error, "error"));
    return job;
  }
  start() {
    if (this.verification.signal.aborted) this.verification = new AbortController();
    if (!this.deliveryRecovery) {
      this.deliveryRecovery = (async () => {
        for (const job of this.store.data.jobs.filter(j => j.delivery?.pendingCompletion && !j.completionPending && !j.stopIntent)) {
          if (this.closing) break;
          try { await this.checkDelivery(job.id, "recovery"); }
          catch (error) { this.log(error, "warning", job.id); }
        }
      })().finally(() => {this.deliveryRecovery = undefined;});
    }
    this.warmups.start();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(
      () => void this.tick().catch((error) => this.log(error, "error")),
      1000,
    );
    void this.tick().catch((error) => this.log(error, "error"));
  }
  createGoal(input: NewJob, tokenBudget: number | null, start: boolean) {
    return this.queueMaintenance(async () => {
      await this.tickInFlight;
      if (this.closing || this.maintaining)
        throw new Error("客户端正在处理其他会话操作，请稍后再创建目标");
      if (input.mode !== "cli" || input.attachments?.length || input.review)
        throw new Error("请先创建持续目标，再在聊天中补充文件或发起审查");
      if (!(await fs.stat(input.cwd)).isDirectory())
        throw new Error("工作目录不存在");
      this.maintaining = true;
      const {deliveryChecks, ...jobInput} = input;
      const checks = deliveryChecksSchema.parse(deliveryChecks || []);
      const job: Job = {
        ...jobInput,
        ...(checks.length ? {delivery: {revision: 1, checks, reports: []}} : {}),
        prompt: "",
        interactive: true,
        id: randomUUID(),
        state: "paused",
        rotations: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      let rpc: Rpc | undefined;
      try {
        const home = this.store.jobHome(job.id);
        await fs.mkdir(home, { recursive: true, mode: 0o700 });
        rpc = await Rpc.open(this.store.data.settings.cliPath, home);
        rpc.on("request", (m) =>
          rpc?.reject(m.id!, "创建目标不执行模型或工具"),
        );
        const result = await prepareThread(rpc, undefined, {
          cwd: input.cwd,
          approvalPolicy: input.approvalPolicy,
          sandbox: "read-only",
          ...(input.model ? { model: input.model } : {}),
          config: { "features.goals": false },
        });
        job.threadId = result.thread.id;
        const saved = await rpc.call("thread/goal/set", {
          threadId: job.threadId,
          objective: input.prompt,
          tokenBudget,
          status: "paused",
          origin: "user",
        });
        if (
          saved.goal?.threadId !== job.threadId ||
          saved.goal.status !== "paused"
        )
          throw new Error("目标保存状态未确认，请检查新建会话");
        job.goal = saved.goal;
        await rpc.close();
        rpc = undefined;
        if (start) {
          // Only activate after unloading. A loaded active Goal can start its
          // own turn before the Scheduler selects and authenticates an account.
          rpc = await Rpc.open(this.store.data.settings.cliPath, home);
          rpc.on("request", (m) => rpc?.reject(m.id!, "目标等待调度后执行"));
          const activated = await rpc.call("thread/goal/set", {
            threadId: job.threadId,
            status: "active",
            origin: "user",
          });
          if (
            activated.goal?.threadId !== job.threadId ||
            activated.goal.status !== "active"
          )
            throw new Error("目标尚未确认激活，未排队执行");
          job.goal = activated.goal;
          await rpc.close();
          rpc = undefined;
          job.goalStartRequested = true;
          job.state = "queued";
        }
        this.store.data.jobs.push(job);
        await this.store.save();
        this.changed();
        return job;
      } catch (error) {
        if (job.threadId || error instanceof ProcessSafetyError) {
          job.state = "needs_attention";
          if (error instanceof ProcessSafetyError) job.recoveryRequired = true;
          job.lastError = redact(
            error instanceof Error ? error.message : String(error),
          );
          if (!this.store.data.jobs.some((j) => j.id === job.id))
            this.store.data.jobs.push(job);
          await this.store.save();
          this.changed();
        }
        throw error;
      } finally {
        try {
          await rpc?.close();
        } catch (error) {
          job.state = "needs_attention";
          job.recoveryRequired = true;
          job.lastError = "目标创建进程停止尚未确认，请先处理恢复状态";
          if (!this.store.data.jobs.some((j) => j.id === job.id))
            this.store.data.jobs.push(job);
          await this.store.save();
          this.changed();
          throw error;
        } finally {
          this.maintaining = false;
        }
      }
    });
  }
  private async refreshDue(now: number) {
    for (const a of this.store.data.accounts) {
      if (
        !a.enabled ||
        (typeof a.expiresAt === "number" && a.expiresAt <= now) ||
        a.status === "reauth" ||
        this.accounts.busy.has(a.id) ||
        this.domains?.blockedAccounts([...this.recoveryTasks.keys()]).has(a.id) ||
        Object.values(a.warmups || {}).some(
          (w) => w.status === "running" || w.processSafe === false,
        ) ||
        this.accountActive(a.id)
      )
        continue;
      const last = this.probes.get(a.id) ?? 0;
      if (
        now - last < this.store.data.settings.pollSeconds * 1000 ||
        (a.blockedUntil ?? 0) > now
      )
        continue;
      this.probes.set(a.id, now);
      await this.accounts
        .inspect(
          a.id,
          !freshModelAccess(a, now) &&
            this.store.data.jobs.some(
              (j) => ["queued", "waiting"].includes(j.state) && !!j.model,
            ),
        )
        .catch((error) =>
          this.log(
            `${a.label}: ${redact(error instanceof Error ? error.message : error)}`,
            "warning",
          ),
        );
      return; // At most one background account probe per tick; keep dispatch responsive.
    }
  }
  private tick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.tickOnce().finally(() => {
      this.tickInFlight = undefined;
    });
    return this.tickInFlight;
  }
  private ownershipIds(){return [...new Set([...this.recoveryTasks.keys(),...this.store.data.jobs.filter(j=>j.recoveryRequired).map(j=>j.id)])];}
  private ownershipBlockers(job:Job){return this.domains?this.domains.blockers(job,[...this.recoveryTasks.keys()]):this.ownershipIds();}
  private globalOwnership(){return this.domains?this.domains.global([...this.recoveryTasks.keys()]):this.ownershipIds();}
  private async refreshRecoveryDomains(){if(this.domains){await this.domains.refresh([...this.recoveryTasks.keys()]);this.changed();}}
  recoveryPlan():RecoveryPlan{
    const recovering=[...this.recoveryTasks.keys()],entries=this.domains?.view(recovering)||this.ownershipIds().map(id=>({id,title:this.store.data.jobs.find(j=>j.id===id)?.title||id,status:"global" as const,reason:"missingProof" as const,affected:this.store.data.jobs.filter(j=>["queued","waiting"].includes(j.state)).map(j=>j.id),accounts:[],projects:[]}));
    return {id:this.domains?.identity(recovering)||createHash("sha256").update(JSON.stringify(entries)).digest("hex"),at:Date.now(),entries};
  }
  async inspectRecovery(expected?:string){
    if(expected&&this.recoveryPlan().id!==expected)throw Error("恢复计划已变化，请重新查看");
    await this.refreshRecoveryDomains();return this.recoveryPlan();
  }
  private pumpRecovery(now: number) {
    for (const job of this.store.data.jobs) {
      if (
        !job.autoRecovery ||
        job.autoRecovery.nextAttemptAt > now ||
        this.recoveryTasks.has(job.id) ||
        this.jobControls.has(this.store.jobHome(job.id)) ||
        (this.familyActive(job.id) && !this.active.get(job.id)?.failedStop) ||
        job.historySource?.issue ||
        (job.existing && job.existing.phase !== "managed")
      )
        continue;
      // Do not await a control from tick: maintenance controls may themselves
      // be waiting for this tick. The persisted gate prevents early dispatch.
      const task = this.queueControl(job.id, async () => {
        if (this.closing || this.maintaining || !job.autoRecovery) return;
        try {
          const active = this.active.get(job.id);
          if (active) {
            await active.done;
            await active.worker?.close();
          }
          await this.recover(job);
          // Close/ownership checks must complete before releasing the global
          // gate, including when Pause or Cancel was requested before a crash.
          const previous = structuredClone(job), recorded = !!job.completionPending;
          try {
            job.recoveryRequired = false;
            clearRecovery(job);
            if (recorded) await this.finishRecordedCompletion(job,"recovery");
            else {
              const budgetHeld=job.resumeAfterShutdown&&job.goal?.status==="budgetLimited"&&!job.pendingMessage&&!job.review;
              job.state = job.stopIntent === "cancel" ? "cancelled"
                : job.stopIntent || job.archived || this.closing ? "paused" : budgetHeld?"needs_attention":"queued";
              if (job.state === "queued" && job.goal?.status === "active" &&
                !job.pendingMessage && !job.review && !job.submissionUncertain)
                job.goalStartRequested = true;
              job.stage = job.state === "queued" ? "已恢复，等待继续原会话" : undefined;
              job.lastError = budgetHeld?"已达到目标 Token 预算，尚未标记目标完成":undefined;
              recordRecovery(job, job.state === "queued" ? "resumed" : "stopped");
            }
            job.updatedAt=Date.now();
            job.resumeAfterShutdown=undefined;
            await this.store.save();
          } catch (error) {
            const stop = {stopIntent:job.stopIntent,controlRevision:job.controlRevision};
            for(const key of Object.keys(job))if(!Object.hasOwn(previous,key))delete (job as any)[key];
            Object.assign(job, previous);
            if((stop.controlRevision||0)>(previous.controlRevision||0))Object.assign(job,stop);
            throw error;
          }
          this.active.delete(job.id);
          this.log(
            recorded ? "已恢复原完成回执，未重复执行已完成回合" : job.state === "queued"
              ? "中断会话已自动恢复，将继续原任务"
              : "已确认中断会话停止，保留用户的停止状态",
            "info",
            job.id,
          );
        } catch (error) {
          job.lastError = redact(
            error instanceof Error ? error.message : error,
          );
          job.recoveryRequired = true;
          job.state = "needs_attention";
          scheduleRecovery(job, "process");
          this.log(
            `自动恢复暂未完成，将稍后重试：${job.lastError}`,
            "warning",
            job.id,
          );
          await this.store.save();
        } finally {
          this.changed();
        }
      });
      this.recoveryTasks.set(job.id, task);
      void task
        .catch((error) => this.log(error, "error", job.id))
        .finally(() => {
          this.recoveryTasks.delete(job.id);this.changed();
        });
    }
  }
  private async tickOnce() {
    if (!this.runtimeReady() || this.ticking || this.closing || this.maintaining) return;
    this.ticking = true;
    try {
      this.awaitingWarmups=true;
      try{await this.warmupRecovery;}finally{this.awaitingWarmups=false;}
      const now = Date.now();
      if (this.closing || this.maintaining) return;
      this.pumpRecovery(now);
      await this.refreshRecoveryDomains();
      if (
        this.globalOwnership().length > 0 ||
        this.store.data.jobs.some(
          (j) =>
            (j.existing &&
              j.existing.phase !== "managed" &&
              !["cancelled", "completed"].includes(j.state)),
        )
      )
        return;
      const findRunnable = () =>
        orderTasks(this.store.data.jobs).find(
          (j) =>
            ["queued", "waiting"].includes(j.state) &&
            !j.autoRecovery &&
            !this.ownershipBlockers(j).length &&
            !dispatchHeld(this.store.data, j, process.platform) &&
            projectHasCapacity(this.store.data, j, [...this.active.values()].map(r => r.job), process.platform) &&
            !dependencyBlockers(j, this.store.data.jobs).length &&
            !this.jobControls.has(this.store.jobHome(j.id)) &&
            !this.familyActive(j.id) &&
            this.selectAccount(j),
        );
      let runnable = findRunnable();
      if (
        !this.active.size &&
        !runnable &&
        this.store.data.jobs.some(
          (j) =>
            j.state === "queued" ||
            (j.state === "waiting" && (j.nextWakeAt || 0) <= now),
        )
      ) {
        await this.warmups.yieldToTask();
        runnable = findRunnable();
      }
      if (!this.active.size && !runnable) await this.refreshDue(now);
      else if (this.active.size && !this.backgroundProbe) {
        this.backgroundProbe = this.refreshDue(now)
          .catch((error) => this.log(error, "warning"))
          .finally(() => {
            this.backgroundProbe = undefined;
          });
      }
      if (now - this.lastWarmupRecovery > 30000) {
        this.lastWarmupRecovery = now;
        this.warmupRecovery = this.recoverWarmups();
      }
      this.warmups.pump();
      await this.refreshRecoveryDomains();
      if (this.closing || this.globalOwnership().length)
        return;
      const limit = Math.max(
        1,
        Math.min(8, this.store.data.settings.maxConcurrentTasks ?? 3),
      );
      for (const job of orderTasks(this.store.data.jobs)) {
        if (this.closing || this.maintaining || this.active.size >= limit)
          break;
        if (
          this.familyActive(job.id) ||
          this.ownershipBlockers(job).length>0 ||
          dispatchHeld(this.store.data, job, process.platform) ||
          !projectHasCapacity(this.store.data, job, [...this.active.values()].map(r => r.job), process.platform) ||
          this.dependenciesBlocked(job) ||
          job.autoRecovery ||
          this.jobControls.has(this.store.jobHome(job.id)) ||
          !["queued", "waiting"].includes(job.state)
        )
          continue;
        const selection = this.selectAccount(job);
        if (
          job.state === "waiting" &&
          (job.nextWakeAt ?? 0) > now &&
          !selection
        )
          continue;
        if (!selection) {
          const pool = this.store.data.accounts.filter(
            (a) =>
              a.enabled &&
              a.status !== "reauth" &&
              !(a.expiresAt && a.expiresAt <= now),
          );
          const modelWait =
            !!job.model &&
            pool.length > 0 &&
            pool.every((a) => supportsModel(a, job.model, now) === false);
          job.state = "waiting";
          job.waitingFor = modelWait ? "model" : undefined;
          job.stage = modelWait ? "等待支持所选模型的账户" : "等待可用账户";
          job.lastError = modelWait
            ? "暂时没有参与轮换的账户支持所选模型。会自动复查，也可以切换模型继续原任务。"
            : undefined;
          job.nextWakeAt = modelWait
            ? Math.max(
                now + 1000,
                Math.min(
                  ...pool.map(
                    (a) => a.modelDenials![job.model!] + MODEL_ACCESS_TTL,
                  ),
                ),
              )
            : nextWake(
                this.store.data.accounts,
                job.bucket,
                Date.now(),
                this.store.data.settings.retrySeconds * 1000,
                job.model,
              );
          this.log(
            modelWait
              ? "暂时没有参与轮换的账户支持所选模型。会自动复查，也可以切换模型继续原任务。"
              : `暂无可用账户，等待到 ${new Date(job.nextWakeAt).toLocaleString()} 后重新向服务器核实额度`,
            "info",
            job.id,
          );
          await this.store.save();
          this.changed();
          continue;
        }
        this.store.data.cursor = selection.cursor;
        const active: ActiveRun = { job };
        this.active.set(job.id, active);
        this.changed();
        active.done = this.run(job, selection.account).catch((error) => {
          job.state = "needs_attention";
          job.recoveryRequired = true;
          job.lastError = redact(error);
          active.failedStop = true;
          scheduleRecovery(job, "process");
          this.log(error, "error", job.id);
          void this.store.save().catch((e) => this.log(e, "error", job.id));
          this.changed();
        });
      }
    } finally {
      this.ticking = false;
    }
  }
  private updateQuota(account: Account, quotas: Record<string, Quota>) {
    if (!Object.keys(quotas).length) return;
    const previous = account.quotas;
    account.quotas = { ...account.quotas, ...quotas };
    account.status = Object.values(account.quotas).some(isExhausted)
      ? "limited"
      : Object.values(account.quotas).some(hasQuotaEvidence)
        ? "ready"
        : "unknown";
    this.warmups.observe(
      account,
      previous,
      account.quotas,
      this.accountActive(account.id, true),
    );
    this.changed();
  }
  private async run(job: Job, account: Account) {
    const active = this.active.get(job.id)!;
    const startedAt = Date.now();
    let poll: NodeJS.Timeout | undefined;
    let outcome: Outcome | undefined;
    try {
      job.state = "preparing";
      if(this.domains)job.runtimeDomain=undefined;
      if(job.delivery) {job.delivery.blockedCompletion=false;job.delivery.pendingCompletion=false;}
      job.waitingFor = undefined;
      this.syncAgentRoot(job, { status: "pendingInit" });
      job.accountId = account.id;
      job.nextWakeAt = undefined;
      job.lastError = undefined;
      job.stage = "核实账户额度与模型权限";
      await this.store.save();
      this.changed();
      const prepared = await this.accounts.inspect(account.id, true);
      if (active.reason || this.closing) {
        outcome = { kind: "interrupted" };
      } else {
        if (isExhausted(prepared.quotas[job.bucket]))
          throw {
            codexErrorInfo: "usageLimitExceeded",
            message: "额度在准备会话时已用尽",
          };
        const preferred = this.selectAccount(job);
        if (
          job.model &&
          (supportsModel(account, job.model) === false ||
            (preferred &&
              modelRank(preferred.account, job.model) >
                modelRank(account, job.model)))
        )
          throw new ModelRoutingError("优先使用目录中列有所选模型的账户");
        await this.beforeStart(job);
        await this.refreshRecoveryDomains();
        if(this.ownershipBlockers(job).length||this.domains?.blockedAccounts([...this.recoveryTasks.keys()]).has(account.id))throw new RecoveryError("相关资源正在恢复，等待归属核查后继续");
        if (active.reason || this.closing) {
          throw Error("任务准备已取消");
        }
        const home = this.store.jobHome(job.id);
        await fs.mkdir(home, { recursive: true, mode: 0o700 });
        // New chats inherit the client's configured MCP servers and installed tools.
        // Existing chat-specific settings remain local to that chat.
        const commonHome = path.join(this.store.root, "cli-profile");
        try {
          await fs.copyFile(
            path.join(commonHome, "config.toml"),
            path.join(home, "config.toml"),
            fs.constants.COPYFILE_EXCL,
          );
        } catch (e: any) {
          if (!["ENOENT", "EEXIST"].includes(e.code)) throw e;
        }
        try {
          await fs.copyFile(
            path.join(commonHome, "AGENTS.md"),
            path.join(home, "AGENTS.md"),
          );
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
        for (const directory of ["skills", "plugins"]) {
          try {
            const source = await fs.realpath(path.join(commonHome, directory));
            await fs.symlink(
              source,
              path.join(home, directory),
              process.platform === "win32" ? "junction" : "dir",
            );
          } catch (e: any) {
            if (!["ENOENT", "EEXIST"].includes(e.code)) throw e;
          }
        }
        const tokens = {
          accessToken: prepared.auth.tokens.access_token,
          chatgptAccountId: account.identity,
          chatgptPlanType: account.plan,
        };
        active.worker = this.factories[job.mode]({
          job,
          home,
          domain:this.domains?owner=>captureWindowsDomain(this.store,job,owner):undefined,
          cli: this.store.data.settings.cliPath,
          resumePrompt: this.store.data.settings.resumePrompt,
          checkpoint: async (threadId, turnId, submitted = true) => {
            job.threadId = threadId;
            job.importedRollout = undefined;
            if (turnId) {
              this.syncAgentRoot(job, { turnId, status: "running" });
              job.turnId = turnId;
              if (submitted) {
                job.pendingMessage = undefined;
                job.attachments = undefined;
                job.review = undefined;
                job.desktopSubmissionPending = false;
                job.goalStartRequested = false;
              }
            }
            await this.store.save();
            this.changed();
          },
          shouldStart: () => !active.reason && !this.closing,
          refresh: async () => {
            const auth = await this.accounts.refreshTokens(account.id);
            return {
              accessToken: auth.tokens.access_token,
              chatgptAccountId: account.identity,
              chatgptPlanType: account.plan,
            };
          },
        });
        const worker = active.worker;
        worker.on("chat", (method, params) => {
          if (
            method === "item/completed" &&
            params.item?.type === "agentMessage"
          )
            this.syncAgentRoot(job, { message: params.item.text });
          void this.chats
            .event(job.id, method, params)
            .then(() => this.emit("chatChanged", job.id))
            .catch((error) => this.log(error, "error", job.id));
        });
        worker.on("childChat", (threadId, method, params) => {
          void this.chats
            .event(threadId, method, params)
            .then(() => this.emit("chatChanged", threadId))
            .catch((error) => this.log(error, "error", job.id));
        });
        worker.on("agent", (agent) => {
          const agents = (job.agents ??= []);
          const previous = agents.find((a) => a.threadId === agent.threadId);
          if (previous) Object.assign(previous, agent);
          else agents.push(agent);
          // Independently continued descendants remain visible in every saved
          // ancestor tree, rather than forking a second status history.
          for (const owner of this.store.data.jobs) {
            if (
              owner === job ||
              owner.threadId === agent.threadId ||
              this.store.jobHome(owner.id) !== this.store.jobHome(job.id)
            )
              continue;
            const known = owner.agents?.find(
              (a) => a.threadId === agent.threadId,
            );
            if (known) Object.assign(known, agent);
            else if (owner.agents?.some((a) => a.threadId === job.threadId))
              (owner.agents ??= []).push({ ...agent });
          }
          void this.store
            .save()
            .catch((error) => this.log(error, "error", job.id));
          this.changed();
        });
        worker.on("usage", (usage) => {
          job.tokenUsage = usage;
          this.changed();
        });
        worker.on("goal", (goal: ThreadGoal | null) => {
          if (goal && goal.threadId !== job.threadId) return;
          job.goal = goal;
          void this.store
            .save()
            .catch((error) => this.log(error, "error", job.id));
          this.changed();
        });
        worker.on("stage", (stage: string) => {
          job.stage = stage;
          this.changed();
        });
        worker.on("heartbeat", () => {
          job.lastHeartbeatAt = Date.now();
          this.changed();
        });
        worker.on("quota", (quotas) => this.updateQuota(account, quotas));
        worker.on("output", (text) => {
          job.lastActivityAt = Date.now();
          this.log(text, "output", job.id);
        });
        worker.on("log", (text) => this.log(text, "info", job.id));
        worker.on("approval", (approval) => {
          approval.reviewId=randomUUID();
          if (approval.kind === "input")
            void this.recordQuestion(approval, "pending").catch((e) =>
              this.log(e, "error", job.id),
            );
          this.approvals.push(approval);
          this.log(
            "Codex 等待你的审批或输入，任务和账户保持不变",
            "info",
            job.id,
          );
        });
        worker.on("approvalResolved", (id) => {
          const a = this.approvals.find(
            (a) => a.jobId === job.id && a.id === id,
          );
          if (a?.kind === "input") {
            const answers = this.questionReplies.get(a.historyId!);
            this.questionReplies.delete(a.historyId!);
            void this.recordQuestion(
              a,
              answers
                ? active.reason || this.closing
                  ? "unconfirmed"
                  : "answered"
                : "expired",
              active.reason || this.closing ? undefined : answers,
            ).catch((e) => this.log(e, "error", job.id));
          }
          this.approvals = this.approvals.filter(
            (a) => !(a.jobId === job.id && a.id === id),
          );
          this.changed();
        });
        worker.on("stopError", (error) => {
          active.failedStop = true;
          this.log(error, "error", job.id);
        });
        await worker.start(tokens);
        if (active.reason || this.closing) {
          job.state = "pausing";
          await worker.stop();
        } else {
          job.state = "running";
          this.log(
            `使用 ${account.label} 继续会话 ${job.threadId}`,
            "info",
            job.id,
          );
        }
        await this.store.save();
        this.changed();
        let polling = false;
        poll = setInterval(() => {
          if (polling || active.reason) return;
          polling = true;
          void worker
            .quota()
            .catch((error) =>
              this.log(`额度读取暂时失败：${redact(error)}`, "warning", job.id),
            )
            .finally(() => {
              polling = false;
            });
        }, this.store.data.settings.pollSeconds * 1000);
        outcome = await worker.done;
        if (active.failedStop)
          throw new Error("停止确认失败，保留任务等待检查");
        if (outcome.kind === "completed" && (!active.reason||active.reason==="shutdown") && !job.stopIntent && (!this.closing||this.resumeOnShutdown)) {
          job.completion = {
            revision:(job.completion?.revision ?? 0)+1,
            startedAt,finishedAt:Date.now(),threadId:job.threadId,turnId:job.turnId,
          };
          job.completionPending=true;
          await this.store.save();
        }
      }
    } catch (error) {
      if (error instanceof ProcessSafetyError) active.failedStop = true;
      outcome = {
        kind:
          error instanceof RecoveryError
            ? "recoverable"
            : error instanceof ModelRoutingError
              ? "modelRoute"
              : errorKind(error) === "quota"
                ? "quota"
                : isModelRejection(error, job.model)
                  ? "modelUnavailable"
                  : "error",
        error,
      };
    } finally {
      if (poll) clearInterval(poll);
      try {
        if (active.worker) await active.worker.close();
      } catch (error) {
        active.failedStop = true;
        outcome = { kind: "error", error };
        this.log(`任务进程清理失败：${redact(error)}`, "error", job.id);
      }
      for (const a of this.approvals.filter(
        (a) => a.jobId === job.id && a.kind === "input",
      )) {
        const submitted = this.questionReplies.has(a.historyId!);
        this.questionReplies.delete(a.historyId!);
        await this.recordQuestion(
          a,
          submitted ? "unconfirmed" : "expired",
        ).catch((e) => this.log(e, "error", job.id));
      }
      this.approvals = this.approvals.filter((a) => a.jobId !== job.id);
      await this.chats.flush(job.id);
      for (const agent of job.agents ?? [])
        await this.chats.flush(agent.threadId);
    }
    await this.queueWrites.get(job.id)?.catch(() => {});
    if (job.completionPending && job.completion && !active.failedStop)
      job.completion.finishedAt=Date.now();
    const hadCompletion=!!job.completionPending;
    let undoCompletionQueue:undefined|(()=>void);
    const stopReason = job.stopIntent || active.reason;
    const serviceExit=this.closing&&this.resumeOnShutdown&&!job.stopIntent;
    const resumeSystemPause=serviceExit&&(hadCompletion||!outcome||["completed","interrupted","recoverable"].includes(outcome.kind));
    if (stopReason&&stopReason!=="shutdown") {
      job.goalResumeAfterQuota = false;
      job.goalResumeAfterModelChange = false;
    }
    if (stopReason === "cancel" && !active.failedStop) job.state = "cancelled";
    else if ((stopReason === "pause" || this.closing&&(!serviceExit||resumeSystemPause)) && !active.failedStop)
      job.state = "paused";
    else if (active.failedStop) {
      job.recoveryRequired = true;
      job.state = "needs_attention";
      job.lastError = "无法确认原进程停止，禁止启动第二个任务进程";
      scheduleRecovery(job, "process");
    } else if (outcome?.kind === "quota") {
      account.status = "limited";
      account.blockedUntil = resetDeadline(
        account.quotas[job.bucket],
        Date.now(),
        this.store.data.settings.retrySeconds * 1000,
      );
      job.state = "rotating";
      job.rotations++;
      this.log(
        "检测到额度中断：会话已保存，准备轮换账户。任务尚未完成。",
        "warning",
        job.id,
      );
      await this.store.save();
      this.changed();
      job.state = "queued";
    } else if (
      outcome?.kind === "modelUnavailable" ||
      outcome?.kind === "modelRoute"
    ) {
      if (outcome.kind === "modelUnavailable" && job.model)
        denyModel(account, job.model);
      if (
        outcome.kind === "modelUnavailable" &&
        job.goal &&
        ["active", "blocked"].includes(job.goal.status)
      )
        job.goalResumeAfterModelChange = true;
      job.state = "queued";
      job.lastError =
        outcome.kind === "modelUnavailable"
          ? "该账户不支持所选模型，正在自动选择其他账户"
          : "优先使用目录中列有所选模型的账户";
      this.log(`${account.label}: ${job.lastError}`, "info", job.id);
    } else if (outcome?.kind === "goalStopped") {
      job.state = job.goal?.status === "paused" ? "paused" : "needs_attention";
      job.lastError =
        (
          {
            paused: "目标已暂停，保留原会话",
            blocked: "目标受阻，请检查现有结果后继续",
            budgetLimited: "已达到目标 Token 预算，尚未标记目标完成",
            usageLimited: "目标因额度限制停止，请检查账户后继续",
          } as Record<string, string>
        )[job.goal?.status || ""] || "目标已停止，请检查会话状态";
      this.log(job.lastError, "info", job.id);
    } else if (outcome?.kind === "incomplete") {
      const retries = job.completionRetries ?? 0;
      const limit = job.maxCompletionRetries ?? 3;
      if (retries < limit) {
        job.completionRetries = retries + 1;
        job.state = "queued";
        job.lastError = `未满足完成标记，将继续原会话检查（${retries + 1}/${limit}）`;
      } else {
        job.state = "needs_attention";
        job.lastError = `完成标记仍未满足，已达到 ${limit} 次自动补完上限；请检查原会话后手动继续`;
      }
      this.log(job.lastError, "warning", job.id);
    } else if (outcome?.kind === "completed" || job.completionPending) {
      undoCompletionQueue=await this.finishRecordedCompletion(job,"automatic");
    } else if (
      outcome?.kind === "recoverable" ||
      outcome?.kind === "interrupted"
    ) {
      if (job.mode === "cli" && !job.historySource?.issue) {
        job.lastError = outcome.error
          ? redact(
              outcome.error instanceof Error
                ? outcome.error.message
                : outcome.error,
            )
          : "会话意外中断，将自动继续原任务";
        scheduleRecovery(
          job,
          outcome.kind === "interrupted" ? "interrupted" : "unknown",
        );
        this.log(job.lastError, "warning", job.id);
      } else job.state = "paused";
    } else if (outcome?.kind === "error") {
      const kind = errorKind(outcome.error);
      job.lastError = redact(
        outcome.error instanceof Error
          ? outcome.error.message
          : JSON.stringify(outcome.error),
      );
      if (kind === "transient" || kind === "auth") {
        if (kind === "auth") account.status = "reauth";
        else
          account.blockedUntil =
            Date.now() + this.store.data.settings.retrySeconds * 1000;
        job.state = "queued";
        this.log(`任务保留，将重新调度：${job.lastError}`, "warning", job.id);
      } else {
        job.state = "needs_attention";
        this.log(job.lastError, "error", job.id);
      }
    } else {
      job.state = "paused";
    }
    const systemPaused=resumeSystemPause&&job.state==="paused";
    if(systemPaused)job.resumeAfterShutdown=true;
    else if(serviceExit&&!active.failedStop&&!["queued","waiting"].includes(job.state))job.resumeAfterShutdown=undefined;
    if (!active.failedStop&&!systemPaused) job.completionPending=undefined;
    job.updatedAt = Date.now();
    this.syncAgentRoot(job, {
      turnId: job.turnId,
      status:
        job.state === "completed"
          ? "completed"
          : job.state === "paused" || job.state === "cancelled"
            ? "interrupted"
            : job.state === "queued"
              ? "waiting"
              : "errored",
    });
    try {await this.store.save();}
    catch(error){
      if(hadCompletion)job.completionPending=true;
      undoCompletionQueue?.();
      throw error;
    }
    if (!active.failedStop) this.active.delete(job.id);
    this.changed();
  }
  async controlMany(ids: string[], action: "pause" | "resume") {
    if (ids.length > 100) throw Error("一次最多操作 100 个任务");
    const results = await Promise.all([...new Set(ids)].map(async (id) => {
      try {
        const job = this.store.data.jobs.find((j) => j.id === id);
        if (!job || (job.existing && job.existing.phase !== "managed")) throw Error("该任务需要单独完成接入检查");
        if (action === "resume" && !["paused", "needs_attention"].includes(job.state)) throw Error("仅能批量恢复暂停或待处理的任务");
        await this.control(id, action);
        return { id, ok: true };
      } catch (error) {
        return { id, ok: false, error: redact(error instanceof Error ? error.message : error) };
      }
    }));
    return { results };
  }
  controlObserved(id:string,action:"pause"|"resume"|"cancel",expected:string):Promise<{applied:boolean}> {
    const matches=()=>{const job=this.store.data.jobs.find(job=>job.id===id);return !!job&&taskControlSignature(job)===expected;};
    if(action!=="resume"&&(this.recoveryTasks.has(id)||this.closing&&this.resumeOnShutdown)) {
      // Preserve the existing immediate stop-intent path while ownership is
      // checked. The observed state is checked before publishing that intent.
      if(!matches())return Promise.resolve({applied:false});
      return this.control(id,action).then(()=>({applied:true}));
    }
    return this.queueControl(id,async()=>{
      if(!matches())return {applied:false};
      await this.controlOnce(id,action);return {applied:true};
    });
  }
  control(id: string, action: "pause" | "resume" | "cancel"): Promise<void> {
    if (action !== "resume" && (this.recoveryTasks.has(id)||this.closing&&this.resumeOnShutdown)) {
      const job = this.store.data.jobs.find((j) => j.id === id);
      if (job && !["completed", "cancelled"].includes(job.state)) {
        // Ownership checks can take time. Remember Stop immediately instead of
        // leaving it behind that check, where an app restart could lose it.
        if (job.stopIntent !== "cancel") job.stopIntent = action;
        job.resumeAfterShutdown=undefined;
        if(this.closing&&this.resumeOnShutdown){const active=this.active.get(id);if(active)active.reason=job.stopIntent;}
        job.controlRevision=(job.controlRevision||0)+1;
        const saved = this.store.save();
        void saved.catch(() => {}); // Observed below after the recovery control.
        this.changed();
        return this.queueControl(id, async () => {
          await saved;
          // Recovery itself may have fulfilled a queued cancellation.
          if (job.state === "cancelled" && job.stopIntent === "cancel") return;
          return this.controlOnce(id, action);
        });
      }
    }
    return this.queueControl(id, () => this.controlOnce(id, action));
  }
  model(id: string, model: string, effort: string) {
    return this.queueControl(id, async () => {
      const job = this.store.data.jobs.find((j) => j.id === id);
      if (!job) throw Error("会话不存在");
      if (
        this.active.has(id) ||
        job.state !== "waiting" ||
        job.waitingFor !== "model"
      )
        return { applied: false };
      if (model === job.model) {
        for (const account of this.store.data.accounts) {
          if (account.modelAccess && supportsModel(account, model) === false)
            account.modelAccess.observedAt = 0;
          if (
            account.modelDenials &&
            Object.hasOwn(account.modelDenials, model)
          )
            delete account.modelDenials[model];
        }
      }
      job.model = model;
      job.effort = effort;
      job.waitingFor = undefined;
      job.state = "queued";
      job.nextWakeAt = undefined;
      job.lastError = undefined;
      job.updatedAt = Date.now();
      await this.store.save();
      this.changed();
      void this.tick().catch((error) => this.log(error, "error", id));
      return { applied: true };
    });
  }
  send(input: {
    id: string;
    text: string;
    attachments: ChatAttachment[];
    action: "send" | "queue" | "steer";
    model?: string;
    effort?: string;
    review?: boolean;
    planMode?: boolean;
    multiAgent?: boolean;
    serviceTier?: string;
  }, requestId?: string, expectedControlRevision?:number) {
    return this.queueControl(input.id, async () => {
      const job = this.store.data.jobs.find((j) => j.id === input.id);
      if (this.closing) throw new Error("Scheduler is shutting down");
      if (!job || job.mode !== "cli") throw new Error("请选择 CLI 会话");
      const fingerprint = requestId ? createHash("sha256").update(JSON.stringify(input)).digest("hex") : undefined;
      const receipt = requestId && job.messageReceipts?.find(r => r.id === requestId);
      if (receipt) {
        // Confirming an existing acceptance must not resume or rewrite a task
        // that the operator has since paused/cancelled.
        if (receipt.fingerprint !== fingerprint) throw Error("请求标识已用于不同消息");
        return;
      }
      if(expectedControlRevision!==undefined&&(job.controlRevision||0)!==expectedControlRevision)throw Error("任务控制状态已变化，确认的追问未投递。");
      if (requestId && (input.action !== "queue" || (job.messageReceipts?.length || 0) >= 1000)) throw Error("可靠投递仅支持排队消息，每个会话最多保留 1000 个投递回执");
      if (
        this.active.has(job.id) &&
        ["completed", "cancelled", "paused"].includes(job.state)
      )
        await this.active.get(job.id)?.done;
      if (job.historySource?.issue) throw new Error(job.historySource.issue);
      if (
        job.recoveryRequired ||
        (job.existing && job.existing.phase !== "managed")
      )
        throw new Error("请先在任务管理中完成安全恢复或交接");
      if (job.archived) throw new Error("请先取消归档");
      if (
        !this.active.has(job.id) &&
        this.familyActive(job.id) &&
        input.action !== "queue"
      )
        throw Error("同组会话正在运行，请排队发送或在主会话的代理面板操作");
      const active =
        this.active.has(job.id) ||
        [
          "queued",
          "waiting",
          "rotating",
          "preparing",
          "running",
          "pausing",
        ].includes(job.state);
      const previous = !active && requestId ? structuredClone(job) : undefined;
      if (input.action === "steer") {
        const running = this.active.get(job.id);
        if (!running || !running.worker?.steer || job.state !== "running")
          throw new Error("当前没有可补充指令的运行轮次");
        await running.worker.steer(input.text, input.attachments);
      } else if (active) {
        if (input.action !== "queue")
          throw new Error("本轮仍在运行，请选择排队发送或立即补充");
        if ((job.queuedMessages?.length ?? 0) >= 100)
          throw new Error("待发送消息已达上限");
        const receipts = job.messageReceipts;
        if (requestId) job.messageReceipts = [...(receipts || []), {id:requestId,fingerprint:fingerprint!}];
        try { await this.persistQueue(job, [...(job.queuedMessages || []), {
          id: randomUUID(),
          text: input.text,
          attachments: input.attachments,
          model: input.model,
          effort: input.effort,
          review: input.review,
          planMode: input.planMode,
          multiAgent: input.multiAgent,
          serviceTier: input.serviceTier,
        }]); } catch(error) {job.messageReceipts=receipts;throw error;}
        return;
      } else {
        if (!(await fs.stat(job.cwd)).isDirectory())
          throw new Error("项目目录不存在，请先重新选择目录");
        job.pendingMessage = input.text;
        job.attachments = input.attachments;
        job.review = input.review;
        if (input.planMode !== undefined) job.planMode = input.planMode;
        if (input.multiAgent !== undefined) job.multiAgent = input.multiAgent;
        if (input.serviceTier !== undefined)
          job.serviceTier = input.serviceTier;
        job.state = "queued";
        job.enqueuedAt = Date.now();
        job.lastError = undefined;
        job.nextWakeAt = undefined;
        job.completionRetries = 0;
        job.completionMarker = undefined;
        clearRecovery(job);
        job.recoveryAttempts = 0;
        job.stopIntent = undefined;
        job.submissionUncertain = false;
        if (input.model !== undefined) job.model = input.model;
        if (input.effort !== undefined) job.effort = input.effort;
      }
      job.interactive = true;
      job.updatedAt = Date.now();
      if (requestId) {
        job.messageReceipts = [...(job.messageReceipts || []), {id:requestId,fingerprint:fingerprint!}];
        try { await this.store.save(); }
        catch(error) {
          if (previous) {for (const key of Object.keys(job)) if (!(key in previous)) delete (job as any)[key];Object.assign(job,previous);}
          throw error;
        }
        try {await this.chats.user(job.id,input.text,input.attachments.map(a=>a.path).join("\n"),`request:${requestId}`);}
        catch(error) {this.log(error,"warning",job.id);}
        this.changed();return;
      }
      await this.chats.user(
        job.id,
        input.text,
        input.attachments.map((a) => a.path).join("\n"),
      );
      await this.store.save();
      this.changed();
    });
  }
  addWorkflow(requestId: string, title: string, inputs: NewJob[], source?: {id:string;step:number}) {
    return this.queueMaintenance(async () => {
      this.maintaining = true;
      const created: Job[] = [];
      try {
        await this.tickInFlight;
        if (this.closing || inputs.length < (source ? 1 : 2) || inputs.length > 12 || inputs.some(i => i.mode !== "cli" || i.attachments?.length)) throw Error("工作流需要 2 至 12 个 CLI 阶段，附件请在创建后添加");
        const fingerprint = createHash("sha256").update(JSON.stringify({title,inputs,...(source?{source}:{})})).digest("hex");
        const existing = this.store.data.jobs.filter(j => j.workflow?.id === requestId);
        if (existing.length) {
          if (existing.some(j => j.workflow?.fingerprint !== fingerprint) || existing.length !== inputs.length) throw Error("该创建请求已被处理，请检查现有工作流");
          return existing.sort((a,b) => a.workflow!.step - b.workflow!.step);
        }
        for (const input of inputs) {
          if (!(await fs.stat(input.cwd)).isDirectory()) throw Error("工作目录不存在");
          const {deliveryChecks,...jobInput}=input,checks=deliveryChecksSchema.parse(deliveryChecks||[]);
          const now = Date.now();
          created.push({ ...jobInput, ...(checks.length?{delivery:{revision:1,checks,reports:[]}}:{}),interactive: true, pendingMessage: input.prompt, id: randomUUID(), state: source ? "paused" : "queued", ...(source?{stopIntent:"pause" as const}:{}), rotations: 0, createdAt: now, updatedAt: now, enqueuedAt: now,
            workflow: {id: requestId, title, step: created.length + 1, total: inputs.length, fingerprint,...(source?{source:{id:source.id,step:source.step+created.length}}:{})},
            dependsOn: created.length ? [created.at(-1)!.id] : [] });
        }
        // Prepare journals before publishing any executable task. Failed batches
        // leave no admitted tasks and never begin a worker.
        for (const job of created) await this.chats.user(job.id, job.prompt);
        this.store.data.jobs.push(...created);
        try { await this.store.save(); }
        catch (error) { this.store.data.jobs = this.store.data.jobs.filter(j => !created.includes(j)); throw error; }
        this.changed();
        return created;
      } catch (error) {
        for (const job of created) await fs.rm(this.chats.file(job.id), {force: true}).catch(() => {});
        throw error;
      } finally { this.maintaining = false; }
    });
  }
  addCheckpointTask(value:{restore:import("../shared/checkpoints").CheckpointRestore;manifest:import("../shared/checkpoints").CheckpointManifest;title:string;prompt:string}) {
    return this.queueMaintenance(async()=>{
      this.maintaining=true;
      try{
        await this.tickInFlight;if(this.closing)throw Error("客户端正在关闭");
        const existing=this.store.data.jobs.find(job=>job.checkpoint?.restoreId===value.restore.id);
        if(existing){if(existing.checkpoint!.manifestSha256!==value.restore.manifestSha256||existing.cwd!==value.restore.target)throw Error("恢复目标已经关联其他任务");return existing;}
        if(value.restore.status!=="ready"||!(await fs.stat(value.restore.target)).isDirectory())throw Error("请先核对恢复目标");
        const source=value.manifest.context?this.store.data.jobs.find(job=>job.id===value.manifest.context!.jobId):undefined,now=Date.now();
        const job:Job={id:randomUUID(),title:value.title,prompt:value.prompt,cwd:value.restore.target,mode:"cli",interactive:true,pendingMessage:value.prompt,
          model:source?.model||"",effort:source?.effort||"medium",bucket:source?.bucket||"codex",approvalPolicy:source?.approvalPolicy||"on-request",sandbox:source?.sandbox||"workspaceWrite",
          review:source?.review,planMode:source?.planMode,multiAgent:source?.multiAgent,serviceTier:source?.serviceTier,
          state:"paused",stopIntent:"pause",rotations:0,createdAt:now,updatedAt:now,
          checkpoint:{id:value.manifest.id,restoreId:value.restore.id,manifestSha256:value.restore.manifestSha256,sourceJobId:value.manifest.context?.jobId,sourceCwd:value.manifest.source,branch:value.restore.branch,mode:value.restore.mode},
          ...(value.manifest.context?.delivery?.checks.length?{delivery:{revision:1,checks:structuredClone(value.manifest.context.delivery.checks),reports:[]}}:{})};
        await this.chats.user(job.id,job.prompt);this.store.data.jobs.push(job);
        try{await this.store.save();}catch(error){this.store.data.jobs=this.store.data.jobs.filter(item=>item!==job);await fs.rm(this.chats.file(job.id),{force:true}).catch(()=>{});throw error;}
        this.changed();return job;
      }finally{this.maintaining=false;}
    });
  }
  configure(settings: import("../shared/types").Settings) {
    return this.queueMaintenance(async () => {
      this.maintaining = true;
      try {
        await this.tickInFlight;
        if (this.closing || this.active.size || this.store.data.jobs.some(j => j.recoveryRequired || ["preparing","running","pausing","rotating"].includes(j.state)))
          throw Error("Pause tasks and finish process recovery before changing runtime settings");
        const previous = this.store.data.settings;
        this.store.data.settings = structuredClone(settings);
        try { await this.store.save(); } catch (error) { this.store.data.settings = previous; throw error; }
        this.changed();
        return this.store.data.settings;
      } finally { this.maintaining = false; }
    });
  }
  projectLimit(cwd: string, limit: number | null) {
    return this.queueMaintenance(async () => {
      this.maintaining = true;
      try {
        await this.tickInFlight;
        if (this.closing || limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 8)) throw Error("项目并发上限必须为 1 至 8");
        const key = projectKey(cwd, process.platform);
        const previous = this.store.data.projectLimits;
        const next = (previous || []).filter(p => projectKey(p.cwd, process.platform) !== key);
        if (limit !== null) {
          if (!this.store.data.jobs.some(j => projectKey(j.projectCwd || j.cwd, process.platform) === key)) throw Error("项目不存在");
          if (next.length >= 100) throw Error("最多为 100 个项目设置并发上限");
          next.push({cwd,limit});
        }
        this.store.data.projectLimits = next;
        try { await this.store.save(); } catch(error) { this.store.data.projectLimits = previous; throw error; }
        this.changed();
      } finally { this.maintaining = false; }
    });
  }
  dispatch(paused: boolean, cwd?: string) {
    return this.queueMaintenance(async () => {
      this.maintaining = true;
      try {
        await this.tickInFlight;
        if (this.closing) throw Error("客户端正在关闭");
        const previous = this.store.data.dispatch;
        const next = structuredClone(previous || { paused: false, projects: [], updatedAt: 0 });
        if (cwd !== undefined) {
          const key = projectKey(cwd, process.platform);
          next.projects = next.projects.filter(p => projectKey(p, process.platform) !== key);
          if (paused) {
            if (!this.store.data.jobs.some(j => projectKey(j.projectCwd || j.cwd, process.platform) === key)) throw Error("项目不存在");
            if (next.projects.length >= 100) throw Error("最多暂停 100 个项目的调度");
            next.projects.push(cwd);
          }
        } else next.paused = paused;
        next.updatedAt = Date.now();
        this.store.data.dispatch = next;
        try { await this.store.save(); } catch (error) { this.store.data.dispatch = previous; throw error; }
        this.changed();
        return next;
      } finally { this.maintaining = false; }
    });
  }
  dependencies(id: string, ids: string[]) {
    return this.queueMaintenance(async () => {
      this.maintaining = true;
      try {
        await this.tickInFlight;
        const job = this.store.data.jobs.find(j => j.id === id);
        if (!job || this.closing || this.familyActive(id) || job.recoveryRequired || job.existing && job.existing.phase !== "managed" || !["queued", "waiting", "paused"].includes(job.state)) throw Error("只能调整尚未运行或已暂停任务的依赖");
        validateDependencies(this.store.data.jobs, id, ids);
        const previous = job.dependsOn;
        job.dependsOn = [...ids];
        try { await this.store.save(); } catch (error) { job.dependsOn = previous; throw error; }
        this.changed();
      } finally { this.maintaining = false; }
    });
  }
  metadata(id:string, patch:Partial<Pick<Job,"title"|"pinned"|"archived">>) {
    return this.queueControl(id,async()=>{
      const job=this.store.data.jobs.find(j=>j.id===id);
      if(!job || this.closing)throw Error("Task is unavailable");
      if(patch.archived && (this.familyActive(id)||job.recoveryRequired||job.autoRecovery||!["paused","completed","cancelled","needs_attention"].includes(job.state)))throw Error("Pause the task before archiving");
      const previous={title:job.title,pinned:job.pinned,archived:job.archived};
      Object.assign(job,patch);
      try{await this.store.save();}catch(error){Object.assign(job,previous);throw error;}
      this.changed();
    });
  }
  priority(id: string, priority: NonNullable<Job["priority"]>) {
    return this.queueControl(id, async () => {
      const job = this.store.data.jobs.find((j) => j.id === id);
      if (!job || this.closing) throw Error("会话不可用");
      const previous = job.priority;
      job.priority = priority;
      try { await this.store.save(); }
      catch (error) { job.priority = previous; throw error; }
      this.changed();
    });
  }
  editQueue(input: { id: string; messageId: string; revision: number; action: "edit" | "remove" | "up" | "down"; text?: string }) {
    return this.queueControl(input.id, async () => {
      const job = this.store.data.jobs.find((j) => j.id === input.id);
      if (!job || this.closing) throw Error("会话不可用");
      if ((job.queueRevision || 0) !== input.revision) throw Error("队列已变化，请查看最新队列后重试");
      const previous = job.queuedMessages || [];
      const index = previous.findIndex((m) => m.id === input.messageId);
      if (index < 0) throw Error("该消息已发送或移除");
      const next = previous.map((m) => ({ ...m }));
      if (input.action === "remove") next.splice(index, 1);
      else if (input.action === "edit") {
        if (!input.text?.trim() || input.text.length > 100000) throw Error("消息不能为空或过长");
        next[index].text = input.text.trim();
      } else {
        const target = index + (input.action === "up" ? -1 : 1);
        if (target < 0 || target >= next.length) return;
        [next[index], next[target]] = [next[target], next[index]];
      }
      await this.persistQueue(job, next);
    });
  }
  private async persistQueue(job: Job, next: NonNullable<Job["queuedMessages"]>) {
    const previous = job.queuedMessages, revision = job.queueRevision;
    const interactive = job.interactive, updatedAt = job.updatedAt;
    job.interactive = true;
    job.updatedAt = Date.now();
    job.queuedMessages = next;
    job.queueRevision = (revision || 0) + 1;
    const write = this.store.save().catch((error) => {
      job.queuedMessages = previous;
      job.queueRevision = revision;
      job.interactive = interactive;
      job.updatedAt = updatedAt;
      throw error;
    });
    this.queueWrites.set(job.id, write);
    try { await write; }
    finally { this.queueWrites.delete(job.id); this.changed(); }
  }

  operation(id: string, method: string, params: Record<string, unknown>) {
    if (!capabilities.some((c) => c.method === method))
      return Promise.reject(new Error("此操作须通过会话或账户界面执行"));
    if (
      ["thread/goal/get", "thread/goal/set", "thread/goal/clear"].includes(
        method,
      )
    )
      return this.goal(
        id,
        method as "thread/goal/get" | "thread/goal/set" | "thread/goal/clear",
        params,
      );
    return this.queueMaintenance(async () => {
      await this.tickInFlight;
      if (this.closing || this.familyActive(id) || this.maintaining)
        throw new Error("请等待当前任务结束或暂停后再执行 CLI 操作");
      const job = this.store.data.jobs.find((j) => j.id === id);
      if (
        !job ||
        job.mode !== "cli" ||
        !job.threadId ||
        job.recoveryRequired ||
        job.historySource?.issue ||
        (job.existing && job.existing.phase !== "managed")
      )
        throw new Error("当前会话尚不可操作，请先发送一条消息或完成安全恢复");
      this.maintaining = true;
      let rpc: Rpc | undefined;
      try {
        const account = pickAccount(
          this.store.data.accounts,
          this.store.data.cursor,
          job.bucket,
          Date.now(),
          this.store.data.settings.accountSelection || "smart",
        )?.account;
        if (!account) throw new Error("暂无可用账户");
        const prepared = await this.accounts.inspect(account.id);
        rpc = await Rpc.open(
          this.store.data.settings.cliPath,
          this.store.jobHome(id),
        );
        rpc.on("request", (m) =>
          rpc?.reject(m.id, "请在对话中执行需要交互审批的操作"),
        );
        await rpc.call("account/login/start", {
          type: "chatgptAuthTokens",
          accessToken: prepared.auth.tokens.access_token,
          chatgptAccountId: account.identity,
          chatgptPlanType: account.plan,
        });
        await ensureWindowsSandbox(rpc, job.cwd, job.sandbox);
        const resumed = await prepareThread(
          rpc,
          job.threadId,
          {
            cwd: job.cwd,
            ...(job.preserveNativePermissions
              ? {}
              : {
                  approvalPolicy: job.approvalPolicy,
                  sandbox: {
                    workspaceWrite: "workspace-write",
                    readOnly: "read-only",
                    dangerFullAccess: "danger-full-access",
                  }[job.sandbox],
                }),
            // Loading a thread for inspection must never dispatch its active
            // Goal. The override is local to this maintenance process.
            config: { "features.goals": false },
          },
          job.importedRollout,
        );
        const args = {
          ...params,
          threadId: job.threadId,
          ...(method === "command/exec" || method === "gitDiffToRemote"
            ? { cwd: job.cwd }
            : {}),
        };
        // Commands use the same sandbox as the conversation; no arbitrary policy override.
        if (method === "command/exec") {
          if (
            job.preserveNativePermissions &&
            ![
              "readOnly",
              "workspaceWrite",
              "dangerFullAccess",
              "externalSandbox",
            ].includes(resumed.sandbox?.type)
          )
            throw Error("无法核实子代理原生权限，未执行命令");
          delete (args as any).disableTimeout;
          Object.assign(args, {
            sandboxPolicy: job.preserveNativePermissions
              ? resumed.sandbox
              : job.sandbox === "dangerFullAccess"
                ? { type: "dangerFullAccess" }
                : job.sandbox === "readOnly"
                  ? { type: "readOnly", networkAccess: false }
                  : {
                      type: "workspaceWrite",
                      writableRoots: [job.cwd],
                      networkAccess: false,
                      excludeTmpdirEnvVar: false,
                      excludeSlashTmp: false,
                    },
            timeoutMs: Math.min(Number(params.timeoutMs) || 10000, 60000),
            tty: false,
            streamStdin: false,
            streamStdoutStderr: false,
          });
        }
        if (method === "thread/compact/start") {
          const done = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("压缩等待超时，请检查会话后重试")),
              60000,
            );
            rpc!.once("turn/completed", () => {
              clearTimeout(timer);
              resolve();
            });
            rpc!.once("disconnected", () => {
              clearTimeout(timer);
              reject(new Error("压缩连接断开"));
            });
          });
          // Attach rejection before awaiting the RPC to avoid an unhandled timer.
          const result = await Promise.all([rpc.call(method, args), done]);
          return result[0];
        }
        return JSON.parse(redact(JSON.stringify(await rpc.call(method, args))));
      } finally {
        try {
          await rpc?.close();
        } finally {
          this.maintaining = false;
          this.changed();
        }
      }
    });
  }
  private localHistory<T>(
    id: string,
    run: (rpc: Rpc, job: Job) => Promise<T>,
    resume = true,
    commit?: (result: T, job: Job) => Promise<void>,
  ) {
    return this.queueMaintenance(async () => {
      await this.tickInFlight;
      if (this.closing || this.familyActive(id) || this.maintaining)
        throw new Error("请等待当前任务结束或暂停后再查看会话历史");
      const job = this.store.data.jobs.find((job) => job.id === id);
      if (
        !job?.threadId ||
        job.mode !== "cli" ||
        !(
          ["completed", "paused", "cancelled", "needs_attention"].includes(
            job.state,
          ) ||
          (!resume &&
            job.goalStartRequested &&
            ["queued", "waiting"].includes(job.state))
        ) ||
        job.recoveryRequired ||
        job.historySource?.issue ||
        (job.existing && job.existing.phase !== "managed")
      )
        throw new Error("当前会话尚不可操作，请先发送一条消息或完成安全恢复");
      this.maintaining = true;
      let rpc: Rpc | undefined;
      const close = async () => {
        const owned = rpc;
        rpc = undefined;
        try {
          await owned?.close();
        } catch (error) {
          if (error instanceof ProcessSafetyError) {
            job.recoveryRequired = true;
            job.state = "needs_attention";
            job.lastError = redact(error);
            await this.store.save();
          }
          throw error;
        }
      };
      try {
        // Metadata, paging, and forks are local operations: never log in or start a turn.
        rpc = await Rpc.open(
          this.store.data.settings.cliPath,
          this.store.jobHome(id),
        );
        rpc.on("request", (request) =>
          rpc?.reject(request.id, "历史操作不执行交互式工具"),
        );
        if (resume)
          await prepareThread(
            rpc,
            job.threadId,
            {
              cwd: job.cwd,
              excludeTurns: true,
              config: { "features.goals": false },
            },
            job.importedRollout,
          );
        const result = await run(rpc, job);
        await close();
        await commit?.(result, job);
        return result;
      } finally {
        try {
          await close();
        } finally {
          this.maintaining = false;
          this.changed();
        }
      }
    });
  }
  goal(
    id: string,
    method: "thread/goal/get" | "thread/goal/set" | "thread/goal/clear",
    params: Record<string, unknown> = {},
    intent?: "create" | "start" | "createAndStart" | "edit",
  ) {
    const run = async (
      rpc: {
        call(method: string, params: Record<string, unknown>): Promise<any>;
      },
      job: Job,
    ) => {
      const activate = intent === "start" || intent === "createAndStart";
      const live = this.active.has(job.id);
      let mutation = params;
      if (intent) {
        if (job.recoveryRequired || (live && job.state !== "running"))
          throw new Error("会话正在恢复或停止，请稍后再操作目标");
        if (
          !live &&
          !["completed", "paused", "cancelled", "needs_attention"].includes(
            job.state,
          )
        )
          throw new Error("请等待当前会话结束或暂停后再开始目标");
        if (
          activate &&
          !live &&
          (job.pendingMessage || job.attachments?.length)
        )
          throw new Error("会话中有待发送的消息，请先继续或处理它，再开始目标");
        const current = (
          await rpc.call("thread/goal/get", { threadId: job.threadId })
        ).goal as ThreadGoal | null;
        if (["create", "createAndStart"].includes(intent) && current)
          throw new Error("会话已有目标，请先编辑或清除原目标");
        if (["start", "edit"].includes(intent) && !current)
          throw new Error("会话尚未设置目标");
        if (intent === "edit")
          mutation = {
            ...params,
            status: current!.status === "complete" ? "paused" : current!.status,
          };
        if (intent === "start" && current?.status === "complete")
          throw new Error("目标已完成，请设置新的目标");
        if (
          activate &&
          current?.tokenBudget != null &&
          current.tokensUsed >= current.tokenBudget
        )
          throw new Error("目标预算已用尽，请先增加或取消预算限制");
      }
      // Native goal methods work on stored, unloaded threads. Do not resume
      // here: loading an active Goal can start a turn without a turn/start call.
      const result = await rpc.call(method, {
        ...mutation,
        ...(method === "thread/goal/set" ? { origin: "user" } : {}),
        threadId: job.threadId,
      });
      const goal = method === "thread/goal/clear" ? null : result.goal;
      if (goal && goal.threadId !== job.threadId)
        throw new Error("目标会话 ID 不匹配");
      job.goal = goal ?? null;
      if (
        method === "thread/goal/clear" ||
        (method === "thread/goal/set" && goal?.status === "paused")
      ) {
        if (
          (job.goalStartRequested ||
            job.goalResumeAfterQuota ||
            job.goalResumeAfterModelChange) &&
          ["queued", "waiting"].includes(job.state)
        ) {
          job.state = "paused";
          job.nextWakeAt = undefined;
        }
        job.goalStartRequested = false;
        job.goalResumeAfterQuota = false;
        job.goalResumeAfterModelChange = false;
      }
      if (activate) {
        if (goal?.status !== "active") {
          await this.store.save();
          this.changed();
          throw new Error("目标尚未确认激活，未排队执行");
        }
        job.goalResumeAfterQuota = false;
        job.goalResumeAfterModelChange = false;
        job.stopIntent = undefined;
        if (!live) {
          job.goalStartRequested = true;
          job.review = undefined;
          job.state = "queued";
          job.nextWakeAt = undefined;
          job.lastError = undefined;
          job.completionRetries = 0;
          job.updatedAt = Date.now();
        }
      }
      await this.store.save();
      this.changed();
      return { goal: job.goal };
    };
    // The same control chain also owns user pause/send. Never open a second
    // process for the active runtime or race a thread's stopping state.
    if (this.active.has(id)) {
      return this.queueControl(id, async () => {
        const active = this.active.get(id);
        if (
          this.closing ||
          active?.job.id !== id ||
          active.reason ||
          active.failedStop ||
          !active.worker?.operation
        )
          throw new Error("会话正在停止，请稍后再操作目标");
        return run(
          { call: (name, args) => active.worker!.operation!(name, args) },
          active.job,
        );
      });
    }
    return this.localHistory(id, run, false);
  }
  turns(id: string, cursor?: string) {
    return this.localHistory(id, (rpc, job) =>
      rpc.call("thread/turns/list", {
        threadId: job.threadId,
        cursor,
        limit: 20,
        sortDirection: "desc",
        itemsView: "full",
      }),
    );
  }
  openAgent(id: string, threadId: string) {
    const source = this.store.data.jobs.find((job) => job.id === id);
    if (!source?.agents?.some((agent) => agent.threadId === threadId))
      return Promise.reject(Error("该子代理不属于当前会话"));
    const existing = this.store.data.jobs.find((job) => job.id === threadId);
    if (existing) {
      if (
        existing.threadId !== threadId ||
        this.store.jobHome(existing.id) !== this.store.jobHome(source.id)
      )
        return Promise.reject(Error("子代理会话标识已被其他运行目录占用"));
      // Opening an already adopted chat is read-only, including while its
      // original worker is active. Never launch a second process to inspect it.
      return Promise.resolve(existing);
    }
    return this.localHistory(
      id,
      async (rpc, parent) => {
        const read = async (target: string) => {
          const value = (
            await rpc.call("thread/read", {
              threadId: target,
              includeTurns: false,
            })
          ).thread;
          if (value?.id !== target) throw Error("原生子代理会话身份不匹配");
          return value;
        };
        const child = await read(threadId);
        const parentOf = (value: any) =>
          value.parentThreadId ||
          value.source?.subAgent?.thread_spawn?.parent_thread_id;
        const directParent = parentOf(child);
        let ancestor = directParent;
        const seen = new Set([threadId]);
        while (ancestor !== parent.threadId) {
          if (!ancestor || seen.has(ancestor) || seen.size > 256)
            throw Error("无法核实原生子代理的父子关系");
          seen.add(ancestor);
          ancestor = parentOf(await read(ancestor));
        }
        if (child.ephemeral) throw Error("临时子代理没有可恢复的持久化历史");
        // No login and Goals explicitly disabled: inspecting saved permissions
        // must not admit a model turn, even if this child has an active Goal.
        const resumed = await rpc.call("thread/resume", {
          threadId,
          excludeTurns: true,
          config: { "features.goals": false },
        });
        if (resumed.thread?.id !== threadId)
          throw Error("原生子代理恢复后的身份不匹配");
        const cwd = resumed.cwd || child.cwd;
        if (typeof cwd !== "string" || !path.isAbsolute(cwd))
          throw Error("子代理的原生项目目录无效");
        const agent = parent.agents!.find(
          (agent) => agent.threadId === threadId,
        )!;
        const rows: import("../shared/types").ChatItem[] = [];
        let cursor: string | undefined, turnId: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await rpc.call("thread/turns/list", {
            threadId,
            cursor,
            limit: 20,
            sortDirection: "asc",
            itemsView: "full",
          });
          for (const turn of page.data) {
            turnId = turn.id;
            for (const item of turn.items)
              rows.push({
                ...protocolItem(item, `${turn.id}:${item.id}`),
                turnId: turn.id,
                status: turn.status,
                at: turn.startedAt
                  ? turn.startedAt * 1000
                  : child.createdAt * 1000 || Date.now(),
              });
          }
          cursor = page.nextCursor || undefined;
          if (cursor && cursors.has(cursor))
            throw Error("原生历史分页游标重复，停止打开子代理");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        await this.chats.hydrate(threadId, rows);
        const descendants = new Set([threadId]);
        let added = true;
        while (added) {
          added = false;
          for (const a of parent.agents || [])
            if (
              a.parentThreadId &&
              descendants.has(a.parentThreadId) &&
              !descendants.has(a.threadId)
            ) {
              descendants.add(a.threadId);
              added = true;
            }
        }
        const now = Date.now();
        return {
          id: threadId,
          threadId,
          runtimeHomeId: parent.runtimeHomeId || parent.id,
          agentOrigin: { jobId: parent.id, parentThreadId: directParent },
          preserveNativePermissions: true,
          title: (
            child.name ||
            agent.name ||
            child.agentNickname ||
            threadId.slice(0, 8)
          ).slice(0, 120),
          prompt: "",
          cwd,
          mode: "cli" as const,
          model: resumed.model || child.model || agent.model || parent.model,
          effort:
            resumed.reasoningEffort ??
            child.reasoningEffort ??
            agent.effort ??
            "",
          serviceTier: resumed.serviceTier ?? undefined,
          sandbox: (resumed.sandbox?.type === "dangerFullAccess"
            ? "dangerFullAccess"
            : resumed.sandbox?.type === "workspaceWrite"
              ? "workspaceWrite"
              : "readOnly") as Job["sandbox"],
          approvalPolicy: (resumed.approvalPolicy === "never"
            ? "never"
            : "on-request") as Job["approvalPolicy"],
          bucket: parent.bucket,
          interactive: true,
          state: "completed" as const,
          multiAgent: parent.multiAgent,
          turnId,
          rotations: 0,
          createdAt: now,
          updatedAt: now,
          agents: parent
            .agents!.filter(
              (a) => a.threadId !== threadId && descendants.has(a.threadId),
            )
            .map((a) => ({ ...a })),
        };
      },
      false,
      async (child) => {
        this.store.data.jobs.push(child);
        const links: {
          agent: import("../shared/types").AgentState;
          previous?: string;
        }[] = [];
        for (const owner of this.store.data.jobs)
          for (const agent of owner.agents || [])
            if (
              agent.threadId === child.threadId &&
              this.store.jobHome(owner.id) === this.store.jobHome(child.id)
            ) {
              links.push({ agent, previous: agent.conversationId });
              agent.conversationId = child.id;
            }
        try {
          await this.store.save();
        } catch (error) {
          for (const link of links) link.agent.conversationId = link.previous;
          this.store.data.jobs = this.store.data.jobs.filter(
            (job) => job !== child,
          );
          throw error;
        }
        this.emit("chatChanged", child.id);
      },
    );
  }
  fork(id: string, at?: { beforeTurnId?: string; lastTurnId?: string }) {
    return this.localHistory(id, async (rpc, source) => {
      const response = await rpc.call("thread/fork", {
        threadId: source.threadId,
        ...(at?.lastTurnId ? { lastTurnId: at.lastTurnId } : {}),
        excludeTurns: true,
      });
      const threadId = response.thread.id;
      if (!threadId || threadId === source.threadId)
        throw new Error("CLI 没有创建独立会话分支");
      if (at?.beforeTurnId)
        await rpc.call("thread/revert", {
          threadId,
          beforeTurnId: at.beforeTurnId,
        });
      const fork: Job = {
        id: randomUUID(),
        runtimeHomeId: source.runtimeHomeId || source.id,
        checkpoint:source.checkpoint?structuredClone(source.checkpoint):undefined,
        title: `${source.title.slice(0, 100)} · 分支`,
        prompt: "",
        cwd: source.cwd,
        mode: "cli",
        model: source.model,
        effort: source.effort,
        bucket: source.bucket,
        state: "completed",
        interactive: true,
        threadId,
        rotations: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        approvalPolicy: source.approvalPolicy,
        sandbox: source.sandbox,
        planMode: source.planMode,
        multiAgent: source.multiAgent,
        serviceTier: source.serviceTier,
      };
      // Paginated CLI histories live in its local database. Keep an owned runtime
      // for the thread family; copying a metadata-only rollout would lose context.
      let cursor: string | undefined;
      do {
        const page = await rpc.call("thread/turns/list", {
          threadId,
          cursor,
          limit: 20,
          sortDirection: "asc",
          itemsView: "full",
        });
        for (const turn of page.data)
          for (const item of turn.items) {
            const record = protocolItem(item, `${turn.id}:${item.id}`);
            record.turnId = turn.id;
            record.status = "completed";
            await this.chats.append(fork.id, record);
          }
        cursor = page.nextCursor || undefined;
      } while (cursor);
      this.store.data.jobs.push(fork);
      await this.store.save();
      this.changed();
      return fork;
    });
  }
  agentControl(
    id: string,
    threadId: string,
    action: "send" | "interrupt",
    text?: string,
  ) {
    return this.queueControl(id, async () => {
      const active = this.active.get(id);
      if (
        this.closing ||
        !active ||
        active.reason ||
        active.failedStop ||
        active.job.state !== "running" ||
        !active.worker?.agentControl
      )
        throw new Error("主会话当前未运行，请在主会话中继续任务");
      if (!active.job.agents?.some((agent) => agent.threadId === threadId))
        throw Error("该子代理不属于当前会话");
      const result = await active.worker.agentControl(threadId, action, text);
      if (action === "send") await this.chats.user(threadId, text || "");
      return result;
    });
  }
  private async controlOnce(id: string, action: "pause" | "resume" | "cancel",shutdown=false) {
    const job = this.store.data.jobs.find((j) => j.id === id);
    if (!job) throw new Error("任务不存在");
    if(shutdown&&!this.active.has(id))return;
    if(shutdown&&["completed","cancelled"].includes(job.state))return;
    if(shutdown&&job.stopIntent){shutdown=false;action=job.stopIntent;}
    if (["completed", "cancelled"].includes(job.state))
      throw new Error("终止任务不可再次操作，请新建任务");
    if(!shutdown){job.controlRevision=(job.controlRevision||0)+1;job.resumeAfterShutdown=undefined;}
    if (action !== "resume") {
      if(shutdown)job.resumeAfterShutdown=true;else job.stopIntent = action;
      if (!shutdown&&job.autoRecovery) recordRecovery(job, "stopped");
      const active = this.active.get(id);
      if (active) {active.reason = shutdown?"shutdown":action;if(!active.failedStop)job.state="pausing";}
      this.deliveryControllers.get(id)?.abort();
      // Keep the process-check loop alive after a failed stop, but never resume
      // inference once the user has asked to pause/cancel.
      if (!job.recoveryRequired) clearRecovery(job);
      await this.store.save();
    }
    if(shutdown&&!this.active.has(id))return;
    if (this.active.has(id) && this.active.get(id)!.failedStop) {
      await this.active.get(id)?.done;
      await this.active.get(id)?.worker?.close();
      await this.recover(job);
      this.active.delete(id);
      job.recoveryRequired = false;
    }
    if (job.recoveryRequired) {
      await this.recover(job);
      job.recoveryRequired = false;
    }
    if (action === "resume") {
      if (this.active.has(id)) throw new Error("任务仍在执行或正在停止");
      if (["completed", "cancelled"].includes(job.state))
        throw new Error("终止任务不可恢复，请新建任务");
      job.state = "queued";
      job.enqueuedAt = Date.now();
      job.stopIntent = undefined;
      if(job.completionPending) {
        let undo:undefined|(()=>void);
        try {
          undo=await this.finishRecordedCompletion(job,"recovery");
          job.updatedAt=Date.now();await this.store.save();this.changed();return;
        } catch(error) {
          undo?.();job.completionPending=true;job.recoveryRequired=true;job.state="needs_attention";
          job.lastError=redact(error);scheduleRecovery(job,"process");
          await this.store.save();this.changed();throw error;
        }
      }
      clearRecovery(job);
      job.recoveryAttempts = 0;
      job.completionRetries = 0;
      job.lastError = undefined;
      job.nextWakeAt = undefined;
    } else if (this.active.has(id)) {
      this.changed();
      try {
        // User pause/cancel also pauses Goal continuation. Quota-driven stops
        // bypass this path, preserving their automatic recovery authority.
        const worker = this.active.get(id)?.worker;
        if (!shutdown&&job.goal?.status === "active" && worker?.operation) {
          try {
            const result = (await worker.operation("thread/goal/set", {
              status: "paused",
              origin: "user",
            })) as { goal?: Job["goal"] };
            if (result.goal) job.goal = result.goal;
          } catch (error) {
            this.log(
              `目标暂停状态暂未确认，继续安全停止任务：${redact(error)}`,
              "warning",
              job.id,
            );
          }
        }
        await this.active.get(id)!.worker?.stop();
        await this.active.get(id)?.done;
        if (this.active.get(id)?.failedStop)
          throw new Error("任务未能安全停止，请处理恢复状态");
      } catch (error) {
        if (this.active.has(id)) this.active.get(id)!.failedStop = true;
        throw error;
      }
    } else {
      job.state = action === "pause" ? "paused" : "cancelled";
      if(!shutdown){job.goalStartRequested = false;job.goalResumeAfterQuota = false;job.goalResumeAfterModelChange = false;}
    }
    if (!job.recoveryRequired) {clearRecovery(job);if(!shutdown)job.completionPending=undefined;}
    await this.store.save();
    this.changed();
  }
  async showDesktop(id: string) {
    const worker = this.active.get(id)?.worker;
    if (!worker?.show) throw new Error("受管客户端尚未启动");
    await worker.show();
  }
  async inspectDesktop(id: string) {
    const worker = this.active.get(id)?.worker;
    if (!worker?.inspect)
      throw new Error("该任务没有已连接的受管客户端，请先启动 Desktop 任务");
    return worker.inspect();
  }
  respond(id: string, value: unknown, jobId?: string) {
    const matches = this.approvals.filter(
      (a) => a.id === id && (!jobId || a.jobId === jobId),
    );
    if (matches.length > 1) throw new Error("请选择要回复的会话");
    const approval = matches[0];
    const active = approval && this.active.get(approval.jobId);
    if (!approval || !active?.worker) throw new Error("请求已过期");
    if (active.reason || active.failedStop || this.closing)
      throw Error("会话正在停止，请等待停止确认后继续");
    if (approval.kind === "input") {
      if (approval.responsePending)
        throw Error("回答已发送，正在等待服务器确认");
      const answers = validateQuestionAnswers(approval.params, value);
      approval.historyId ||= `question:${randomUUID()}`;
      approval.responsePending = true;
      this.questionReplies.set(approval.historyId, answers);
      try {
        active.worker.respond(id, { answers });
      } catch (error) {
        approval.responsePending = false;
        this.questionReplies.delete(approval.historyId);
        throw error;
      }
      this.changed();
      return;
    }
    active.worker.respond(id, value);
    this.approvals = this.approvals.filter((a) => a !== approval);
    this.changed();
  }
  reviewApproval(jobId:string,id:string,reviewId:string) {
    const matches=this.approvals.filter(a=>a.jobId===jobId&&a.id===id);
    const approval=matches[0],active=this.active.get(jobId);
    if(matches.length!==1||!approval||approval.reviewId!==reviewId||!active?.worker)throw Error("审批请求已更新，请重新查看");
    if(active.reason||active.failedStop||this.closing)throw Error("会话正在停止，请等待停止确认后继续");
    return structuredClone(approval);
  }
  private resumeShutdownJobs(failed=false){
    for(const job of this.store.data.jobs){
      if(!job.resumeAfterShutdown)continue;
      if(job.stopIntent){job.resumeAfterShutdown=undefined;continue;}
      if(job.completionPending){
        if(failed&&!job.autoRecovery){job.recoveryRequired=true;job.state="needs_attention";job.lastError="服务退出收尾未完成，正在核查原进程后恢复结果";scheduleRecovery(job,"process");}
        continue;
      }
      if(job.goal?.status==="budgetLimited"&&!job.pendingMessage&&!job.review){
        job.state="needs_attention";job.lastError="已达到目标 Token 预算，尚未标记目标完成";job.resumeAfterShutdown=undefined;continue;
      }
      if(job.state==="paused"&&!job.recoveryRequired){
        job.state="queued";job.stage="等待服务重启后继续";
        if(job.goal?.status==="active"&&!job.pendingMessage&&!job.review&&!job.submissionUncertain)job.goalStartRequested=true;
      }
      if(["queued","completed","cancelled"].includes(job.state))job.resumeAfterShutdown=undefined;
    }
  }
  async shutdown(options:{resumeOnRestart?:boolean}={}) {
    this.resumeOnShutdown=options.resumeOnRestart===true;
    this.closing = true;
    this.interruptDeliveryChecks();
    if (this.timer) clearInterval(this.timer);
    try {
      await this.warmups.shutdown();
      await this.backgroundProbe;
      await this.controls.catch(() => {});
      await this.tickInFlight;
      await this.deliveryRecovery;
      await Promise.allSettled([...this.jobControls.values()]);
      const stopped = await Promise.allSettled(
        [...this.active.values()]
          .filter((run) => !["completed", "cancelled"].includes(run.job.state))
          .map((run) => this.resumeOnShutdown&&!run.job.stopIntent
            ? this.queueControl(run.job.id,()=>this.controlOnce(run.job.id,"pause",true))
            : this.control(run.job.id,run.job.stopIntent==="cancel"?"cancel":"pause")),
      );
      await this.currentRun;
      if (
        stopped.some((result) => result.status === "rejected") ||
        [...this.active.values()].some((run) => run.failedStop)
      )
        throw new Error("受管进程未确认停止，暂不退出");
      await this.accounts.cancelLogin();
      if (this.accounts.drain) await this.accounts.drain();
      if(this.resumeOnShutdown)this.resumeShutdownJobs();
      await this.store.save();
    } catch (error) {
      this.closing = false;
      if(this.resumeOnShutdown)this.resumeShutdownJobs(true);
      this.start();
      throw error;
    }finally{this.resumeOnShutdown=false;}
  }
}
