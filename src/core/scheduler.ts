import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type {
  Account,
  Approval,
  Job,
  NewJob,
  Quota,
  Snapshot,
} from "../shared/types";
import { Accounts } from "./accounts";
import { Store } from "./store";
import {
  errorKind,
  isExhausted,
  nextWake,
  pickAccount,
  resetDeadline,
} from "./quota";
import type { Outcome, Worker, WorkerFactory } from "./worker";
import { redact } from "./redact";
export class Scheduler extends EventEmitter {
  approvals: Approval[] = [];
  private active?: {
    job: Job;
    worker?: Worker;
    reason?: "pause" | "cancel";
    failedStop?: boolean;
  };
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private closing = false;
  private currentRun?: Promise<void>;
  private probes = new Map<string, number>();
  constructor(
    readonly store: Store,
    readonly accounts: Accounts,
    private factories: Record<"cli" | "desktop", WorkerFactory>,
    private recover: (job: Job) => Promise<void> = async () => {},
  ) {
    super();
  }
  snapshot(): Snapshot {
    return structuredClone({
      ...this.store.data,
      approvals: this.approvals,
      login: this.accounts.loginDisplay,
      loginError: this.accounts.loginError,
      platform: process.platform,
    });
  }
  changed() {
    this.emit("snapshot", this.snapshot());
  }
  log(
    message: unknown,
    level: "info" | "warning" | "error" | "output" = "info",
    jobId?: string,
  ) {
    const value = redact(message);
    if (!value.trim()) return;
    const last = this.store.data.logs.at(-1);
    if (
      level === "output" &&
      last?.level === "output" &&
      last.jobId === jobId &&
      last.message.length < 12000
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
    this.store.data.logs = this.store.data.logs.slice(-1000);
    this.changed();
  }
  async add(input: NewJob) {
    const stat = await fs.stat(input.cwd);
    if (!stat.isDirectory()) throw new Error("工作目录不存在");
    const job: Job = {
      ...input,
      id: randomUUID(),
      state: "queued",
      rotations: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.data.jobs.push(job);
    await this.store.save();
    this.changed();
    void this.tick();
    return job;
  }
  start() {
    this.timer = setInterval(
      () => void this.tick().catch((error) => this.log(error, "error")),
      1000,
    );
    void this.tick().catch((error) => this.log(error, "error"));
  }
  private async refreshDue(now: number) {
    for (const a of this.store.data.accounts) {
      if (
        !a.enabled ||
        a.status === "reauth" ||
        this.accounts.busy.has(a.id) ||
        this.active?.job.accountId === a.id
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
        .inspect(a.id)
        .catch((error) =>
          this.log(
            `${a.label}: ${redact(error instanceof Error ? error.message : error)}`,
            "warning",
          ),
        );
      if (this.closing) return;
    }
  }
  private async tick() {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      const now = Date.now();
      if (this.store.data.jobs.some((j) => j.recoveryRequired)) return;
      if (!this.active) await this.refreshDue(now);
      if (this.active) return;
      const job = this.store.data.jobs.find(
        (j) =>
          j.state === "queued" ||
          (j.state === "waiting" && (j.nextWakeAt ?? 0) <= now),
      );
      if (!job) return;
      const selection = pickAccount(
        this.store.data.accounts,
        this.store.data.cursor,
        job.bucket,
        Date.now(),
      );
      if (!selection) {
        job.state = "waiting";
        job.nextWakeAt = nextWake(
          this.store.data.accounts,
          job.bucket,
          Date.now(),
          this.store.data.settings.retrySeconds * 1000,
        );
        this.log(
          `暂无可用账户，等待到 ${new Date(job.nextWakeAt).toLocaleString()} 后重新向服务器核实额度`,
          "info",
          job.id,
        );
        await this.store.save();
        this.changed();
        return;
      }
      this.store.data.cursor = selection.cursor;
      this.active = { job };
      this.currentRun = this.run(job, selection.account).catch((error) => {
        job.state = "needs_attention";
        job.lastError = redact(error);
        if (this.active) this.active.failedStop = true;
        this.log(error, "error", job.id);
        this.changed();
      });
    } finally {
      this.ticking = false;
    }
  }
  private updateQuota(account: Account, quotas: Record<string, Quota>) {
    if (!Object.keys(quotas).length) return;
    account.quotas = { ...account.quotas, ...quotas };
    account.status = Object.values(account.quotas).some(isExhausted)
      ? "limited"
      : "ready";
    this.changed();
  }
  private async run(job: Job, account: Account) {
    const active = this.active!;
    let poll: NodeJS.Timeout | undefined;
    let outcome: Outcome | undefined;
    try {
      job.state = "preparing";
      job.accountId = account.id;
      job.nextWakeAt = undefined;
      job.lastError = undefined;
      await this.store.save();
      this.changed();
      const prepared = await this.accounts.inspect(account.id, true);
      if (isExhausted(prepared.quotas[job.bucket]))
        throw {
          codexErrorInfo: "usageLimitExceeded",
          message: "额度在准备会话时已用尽",
        };
      if (
        job.model &&
        prepared.models.length &&
        !prepared.models.some(
          (m) => m.model === job.model || m.id === job.model,
        )
      )
        throw new Error(
          `该账户没有模型 ${job.model} 的权限；请选择所有轮换账户都可用的模型`,
        );
      const home = this.store.jobHome(job.id);
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      const tokens = {
        accessToken: prepared.auth.tokens.access_token,
        chatgptAccountId: account.identity,
        chatgptPlanType: account.plan,
      };
      active.worker = this.factories[job.mode]({
        job,
        home,
        cli: this.store.data.settings.cliPath,
        resumePrompt: this.store.data.settings.resumePrompt,
        checkpoint: async (threadId, turnId) => {
          job.threadId = threadId;
          if (turnId) job.turnId = turnId;
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
      worker.on("quota", (quotas) => this.updateQuota(account, quotas));
      worker.on("output", (text) => this.log(text, "output", job.id));
      worker.on("log", (text) => this.log(text, "info", job.id));
      worker.on("approval", (approval) => {
        this.approvals.push(approval);
        this.log(
          "Codex 等待你的审批或输入，任务和账户保持不变",
          "info",
          job.id,
        );
      });
      worker.on("approvalResolved", (id) => {
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
      if (active.failedStop) throw new Error("停止确认失败，保留任务等待检查");
    } catch (error) {
      outcome = {
        kind: errorKind(error) === "quota" ? "quota" : "error",
        error,
      };
    } finally {
      if (poll) clearInterval(poll);
      try {
        if (active.worker) await active.worker.close();
      } catch (error) {
        active.failedStop = true;
        outcome = { kind: "error", error };
      }
      this.approvals = this.approvals.filter((a) => a.jobId !== job.id);
    }
    if (active.reason === "cancel" && !active.failedStop)
      job.state = "cancelled";
    else if ((active.reason === "pause" || this.closing) && !active.failedStop)
      job.state = "paused";
    else if (active.failedStop) {
      job.state = "needs_attention";
      job.lastError = "无法确认原进程停止，禁止启动第二个任务进程";
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
    } else if (outcome?.kind === "completed") {
      job.state = "completed";
      this.log("Codex 正常完成本轮任务，未检测到额度中断", "info", job.id);
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
    job.updatedAt = Date.now();
    await this.store.save();
    if (!active.failedStop) this.active = undefined;
    this.changed();
  }
  async control(id: string, action: "pause" | "resume" | "cancel") {
    const job = this.store.data.jobs.find((j) => j.id === id);
    if (!job) throw new Error("任务不存在");
    if (job.recoveryRequired) {
      await this.recover(job);
      job.recoveryRequired = false;
    }
    if (action === "resume") {
      if (this.active?.job.id === id && this.active.failedStop) {
        await this.active.worker?.close();
        this.active = undefined;
      }
      if (this.active?.job.id === id) throw new Error("任务仍在执行或正在停止");
      if (["completed", "cancelled"].includes(job.state))
        throw new Error("终止任务不可恢复，请新建任务");
      job.state = "queued";
      job.lastError = undefined;
      job.nextWakeAt = undefined;
    } else if (this.active?.job.id === id) {
      if (this.active.failedStop) {
        await this.active.worker?.close();
        this.active = undefined;
        job.state = action === "pause" ? "paused" : "cancelled";
        await this.store.save();
        this.changed();
        return;
      }
      this.active.reason = action;
      job.state = "pausing";
      this.changed();
      try {
        await this.active.worker?.stop();
      } catch (error) {
        if (this.active) this.active.failedStop = true;
        throw error;
      }
    } else job.state = action === "pause" ? "paused" : "cancelled";
    await this.store.save();
    this.changed();
  }
  respond(id: string, value: unknown) {
    const approval = this.approvals.find((a) => a.id === id);
    if (!approval || !this.active?.worker) throw new Error("请求已过期");
    this.active.worker.respond(id, value);
    this.approvals = this.approvals.filter((a) => a !== approval);
    this.changed();
  }
  async shutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    try {
      if (this.active) await this.control(this.active.job.id, "pause");
      await this.currentRun;
      if (this.active?.failedStop)
        throw new Error("受管进程未确认停止，暂不退出");
      await this.accounts.cancelLogin();
      await this.store.save();
    } catch (error) {
      this.closing = false;
      this.start();
      throw error;
    }
  }
}
