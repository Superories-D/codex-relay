import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
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
import { ensureWindowsSandbox } from "./windows-sandbox";
export class Scheduler extends EventEmitter {
  readonly chats: Chats;
  approvals: Approval[] = [];
  private active?: {
    job: Job;
    worker?: Worker;
    reason?: "pause" | "cancel";
    failedStop?: boolean;
  };
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private tickInFlight?: Promise<void>;
  private controls: Promise<unknown> = Promise.resolve();
  private closing = false;
  private maintaining = false;
  private currentRun?: Promise<void>;
  private probes = new Map<string, number>();
  private publishTimer?: NodeJS.Timeout;
  constructor(
    readonly store: Store,
    readonly accounts: Accounts,
    private factories: Record<"cli" | "desktop", WorkerFactory>,
    private recover: (job: Job) => Promise<void> = async () => {},
    private beforeStart: (job: Job) => Promise<void> = async () => {},
  ) {
    super();
    this.chats = new Chats(store.root);
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
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      if (this.listenerCount("snapshot"))
        this.emit("snapshot", this.snapshot());
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
    let characters = 0;
    this.store.data.logs = this.store.data.logs
      .slice(-500)
      .reverse()
      .filter((log) => {
        characters += log.message.length;
        return characters <= 500_000;
      })
      .reverse();
    this.changed();
  }
  async add(
    input: NewJob,
    existing?: { link: ExistingLink; threadId: string; turnId?: string },
  ) {
    const stat = await fs.stat(input.cwd);
    if (!stat.isDirectory()) throw new Error("工作目录不存在");
    if (
      existing &&
      (this.active ||
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
    const job: Job = {
      ...input,
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
    await this.store.save();
    this.changed();
    void this.tick().catch((error) => this.log(error, "error"));
    return job;
  }
  start() {
    if (this.timer) clearInterval(this.timer);
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
  private async tickOnce() {
    if (this.ticking || this.closing || this.maintaining) return;
    this.ticking = true;
    try {
      const now = Date.now();
      if (
        this.store.data.jobs.some(
          (j) =>
            j.recoveryRequired ||
            (j.existing &&
              j.existing.phase !== "managed" &&
              !["cancelled", "completed"].includes(j.state)),
        )
      )
        return;
      const runnable = this.store.data.jobs.find(
        (j) =>
          ["queued", "waiting"].includes(j.state) &&
          pickAccount(
            this.store.data.accounts,
            this.store.data.cursor,
            j.bucket,
            now,
          ),
      );
      if (!this.active && !runnable) await this.refreshDue(now);
      if (
        this.active ||
        this.closing ||
        this.store.data.jobs.some((j) => j.recoveryRequired)
      )
        return;
      const job = this.store.data.jobs.find(
        (j) =>
          j.state === "queued" ||
          (j.state === "waiting" &&
            ((j.nextWakeAt ?? 0) <= now ||
              pickAccount(
                this.store.data.accounts,
                this.store.data.cursor,
                j.bucket,
                Date.now(),
              ) !== null)),
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
        job.recoveryRequired = true;
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
      : Object.values(account.quotas).some(hasQuotaEvidence)
        ? "ready"
        : "unknown";
    this.changed();
  }
  private async run(job: Job, account: Account) {
    const active = this.active!;
    let poll: NodeJS.Timeout | undefined;
    let outcome: Outcome | undefined;
    try {
      job.state = "preparing";
      await this.beforeStart(job);
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
          cli: this.store.data.settings.cliPath,
          resumePrompt: this.store.data.settings.resumePrompt,
          checkpoint: async (threadId, turnId) => {
            job.threadId = threadId;
            job.importedRollout = undefined;
            if (turnId) {
              job.turnId = turnId;
              job.pendingMessage = undefined;
              job.attachments = undefined;
              job.review = undefined;
              job.desktopSubmissionPending = false;
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
        if (active.failedStop)
          throw new Error("停止确认失败，保留任务等待检查");
      }
    } catch (error) {
      if (error instanceof ProcessSafetyError) active.failedStop = true;
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
      await this.chats.flush(job.id);
      for (const agent of job.agents ?? [])
        await this.chats.flush(agent.threadId);
    }
    if (active.reason === "cancel" && !active.failedStop)
      job.state = "cancelled";
    else if ((active.reason === "pause" || this.closing) && !active.failedStop)
      job.state = "paused";
    else if (active.failedStop) {
      job.recoveryRequired = true;
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
    } else if (outcome?.kind === "completed") {
      job.state = "completed";
      this.log("Codex 正常完成本轮任务，未检测到额度中断", "info", job.id);
      const next = job.queuedMessages?.shift();
      if (next) {
        job.pendingMessage = next.text;
        job.attachments = next.attachments;
        if (next.model !== undefined) job.model = next.model;
        if (next.effort !== undefined) job.effort = next.effort;
        if (next.planMode !== undefined) job.planMode = next.planMode;
        if (next.multiAgent !== undefined) job.multiAgent = next.multiAgent;
        if (next.serviceTier !== undefined) job.serviceTier = next.serviceTier;
        job.review = next.review;
        job.completionMarker = undefined;
        job.completionRetries = 0;
        job.state = "queued";
      }
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
  control(id: string, action: "pause" | "resume" | "cancel"): Promise<void> {
    const next = this.controls
      .catch(() => {})
      .then(() => this.controlOnce(id, action));
    this.controls = next;
    return next;
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
  }) {
    const next = this.controls
      .catch(() => {})
      .then(async () => {
        const job = this.store.data.jobs.find((j) => j.id === input.id);
        if (!job || job.mode !== "cli") throw new Error("请选择 CLI 会话");
        if (
          this.active?.job.id === job.id &&
          ["completed", "cancelled", "paused"].includes(job.state)
        )
          await this.currentRun;
        if (job.historySource?.issue) throw new Error(job.historySource.issue);
        if (
          job.recoveryRequired ||
          (job.existing && job.existing.phase !== "managed")
        )
          throw new Error("请先在任务管理中完成安全恢复或交接");
        if (job.archived) throw new Error("请先取消归档");
        const active =
          this.active?.job.id === job.id ||
          [
            "queued",
            "waiting",
            "rotating",
            "preparing",
            "running",
            "pausing",
          ].includes(job.state);
        if (input.action === "steer") {
          if (
            this.active?.job.id !== job.id ||
            !this.active.worker?.steer ||
            job.state !== "running"
          )
            throw new Error("当前没有可补充指令的运行轮次");
          await this.active.worker.steer(input.text, input.attachments);
        } else if (active) {
          if (input.action !== "queue")
            throw new Error("本轮仍在运行，请选择排队发送或立即补充");
          if ((job.queuedMessages?.length ?? 0) >= 100)
            throw new Error("待发送消息已达上限");
          (job.queuedMessages ??= []).push({
            text: input.text,
            attachments: input.attachments,
            model: input.model,
            effort: input.effort,
            review: input.review,
            planMode: input.planMode,
            multiAgent: input.multiAgent,
            serviceTier: input.serviceTier,
          });
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
          job.lastError = undefined;
          job.nextWakeAt = undefined;
          job.completionRetries = 0;
          job.completionMarker = undefined;
          if (input.model !== undefined) job.model = input.model;
          if (input.effort !== undefined) job.effort = input.effort;
        }
        job.interactive = true;
        job.updatedAt = Date.now();
        await this.chats.user(
          job.id,
          input.text,
          input.attachments.map((a) => a.path).join("\n"),
        );
        await this.store.save();
        this.changed();
      });
    this.controls = next;
    return next;
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
    const task = this.controls
      .catch(() => {})
      .then(async () => {
        await this.tickInFlight;
        if (this.closing || this.active || this.maintaining)
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
          await prepareThread(
            rpc,
            job.threadId,
            {
              cwd: job.cwd,
              approvalPolicy: job.approvalPolicy,
              sandbox: {
                workspaceWrite: "workspace-write",
                readOnly: "read-only",
                dangerFullAccess: "danger-full-access",
              }[job.sandbox],
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
            delete (args as any).disableTimeout;
            Object.assign(args, {
              sandboxPolicy:
                job.sandbox === "dangerFullAccess"
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
          return JSON.parse(
            redact(JSON.stringify(await rpc.call(method, args))),
          );
        } finally {
          try {
            await rpc?.close();
          } finally {
            this.maintaining = false;
            this.changed();
          }
        }
      });
    this.controls = task;
    return task;
  }
  private localHistory<T>(
    id: string,
    run: (rpc: Rpc, job: Job) => Promise<T>,
    resume = true,
  ) {
    const task = this.controls
      .catch(() => {})
      .then(async () => {
        await this.tickInFlight;
        if (this.closing || this.active || this.maintaining)
          throw new Error("请等待当前任务结束或暂停后再查看会话历史");
        const job = this.store.data.jobs.find((job) => job.id === id);
        if (
          !job?.threadId ||
          job.mode !== "cli" ||
          !["completed", "paused", "cancelled", "needs_attention"].includes(
            job.state,
          ) ||
          job.recoveryRequired ||
          job.historySource?.issue ||
          (job.existing && job.existing.phase !== "managed")
        )
          throw new Error("当前会话尚不可操作，请先发送一条消息或完成安全恢复");
        this.maintaining = true;
        let rpc: Rpc | undefined;
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
          return await run(rpc, job);
        } finally {
          try {
            await rpc?.close();
          } finally {
            this.maintaining = false;
            this.changed();
          }
        }
      });
    this.controls = task;
    return task;
  }
  goal(
    id: string,
    method: "thread/goal/get" | "thread/goal/set" | "thread/goal/clear",
    params: Record<string, unknown> = {},
  ) {
    const run = async (
      rpc: {
        call(method: string, params: Record<string, unknown>): Promise<any>;
      },
      job: Job,
    ) => {
      // Native goal methods work on stored, unloaded threads. Do not resume
      // here: loading an active Goal can start a turn without a turn/start call.
      const result = await rpc.call(method, {
        ...params,
        ...(method === "thread/goal/set" ? { origin: "user" } : {}),
        threadId: job.threadId,
      });
      const goal = method === "thread/goal/clear" ? null : result.goal;
      if (goal && goal.threadId !== job.threadId)
        throw new Error("目标会话 ID 不匹配");
      job.goal = goal ?? null;
      await this.store.save();
      this.changed();
      return { goal: job.goal };
    };
    // The same control chain also owns user pause/send. Never open a second
    // process for the active runtime or race a thread's stopping state.
    if (this.active?.job.id === id) {
      const task = this.controls
        .catch(() => {})
        .then(async () => {
          const active = this.active;
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
      this.controls = task;
      return task;
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
    const operation = this.controls
      .catch(() => {})
      .then(async () => {
        if (
          this.closing ||
          this.active?.job.id !== id ||
          this.active.reason ||
          this.active.failedStop ||
          this.active.job.state !== "running" ||
          !this.active.worker?.agentControl
        )
          throw new Error("主会话当前未运行，请在主会话中继续任务");
        if (
          !this.active.job.agents?.some((agent) => agent.threadId === threadId)
        )
          throw Error("该子代理不属于当前会话");
        const result = await this.active.worker.agentControl(
          threadId,
          action,
          text,
        );
        if (action === "send") await this.chats.user(threadId, text || "");
        return result;
      });
    this.controls = operation;
    return operation;
  }
  private async controlOnce(id: string, action: "pause" | "resume" | "cancel") {
    const job = this.store.data.jobs.find((j) => j.id === id);
    if (!job) throw new Error("任务不存在");
    if (["completed", "cancelled"].includes(job.state))
      throw new Error("终止任务不可再次操作，请新建任务");
    if (this.active?.job.id === id && this.active.failedStop) {
      await this.currentRun;
      await this.active?.worker?.close();
      await this.recover(job);
      this.active = undefined;
      job.recoveryRequired = false;
    }
    if (job.recoveryRequired) {
      await this.recover(job);
      job.recoveryRequired = false;
    }
    if (action === "resume") {
      if (this.active?.job.id === id) throw new Error("任务仍在执行或正在停止");
      if (["completed", "cancelled"].includes(job.state))
        throw new Error("终止任务不可恢复，请新建任务");
      job.state = "queued";
      job.completionRetries = 0;
      job.lastError = undefined;
      job.nextWakeAt = undefined;
    } else if (this.active?.job.id === id) {
      this.active.reason = action;
      job.state = "pausing";
      this.changed();
      try {
        await this.active.worker?.stop();
        await this.currentRun;
        if (this.active?.failedStop)
          throw new Error("任务未能安全停止，请处理恢复状态");
      } catch (error) {
        if (this.active) this.active.failedStop = true;
        throw error;
      }
    } else job.state = action === "pause" ? "paused" : "cancelled";
    await this.store.save();
    this.changed();
  }
  async showDesktop(id: string) {
    if (this.active?.job.id !== id || !this.active.worker?.show)
      throw new Error("受管客户端尚未启动");
    await this.active.worker.show();
  }
  async inspectDesktop(id: string) {
    if (this.active?.job.id !== id || !this.active.worker?.inspect)
      throw new Error("该任务没有已连接的受管客户端，请先启动 Desktop 任务");
    return this.active.worker.inspect();
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
      await this.controls.catch(() => {});
      await this.tickInFlight;
      if (
        this.active &&
        !["completed", "cancelled"].includes(this.active.job.state)
      )
        await this.control(this.active.job.id, "pause");
      await this.currentRun;
      if (this.active?.failedStop)
        throw new Error("受管进程未确认停止，暂不退出");
      await this.accounts.cancelLogin();
      if (this.accounts.drain) await this.accounts.drain();
      await this.store.save();
    } catch (error) {
      this.closing = false;
      this.start();
      throw error;
    }
  }
}
