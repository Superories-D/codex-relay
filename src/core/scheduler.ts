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
  reason?: "pause" | "cancel";
  failedStop?: boolean;
  done?: Promise<void>;
}
export class Scheduler extends EventEmitter {
  readonly chats: Chats;
  approvals: Approval[] = [];
  private active = new Map<string, ActiveRun>();
  private jobControls = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private tickInFlight?: Promise<void>;
  private controls: Promise<unknown> = Promise.resolve();
  private closing = false;
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
  private accountActive(id: string, runningOnly = false) {
    return [...this.active.values()].some(
      (run) =>
        run.job.accountId === id &&
        (!runningOnly || run.job.state === "running"),
    );
  }
  private queueControl<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const key = this.store.jobHome(id);
    const dependencies = [this.controls, this.jobControls.get(key)];
    const task = Promise.allSettled(dependencies).then(fn);
    this.jobControls.set(key, task);
    void task
      .finally(() => {
        if (this.jobControls.get(key) === task) this.jobControls.delete(key);
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
  private selectAccount(job: Job) {
    // Keep array indexes stable for round-robin cursors. CLI runtimes share only
    // access tokens; a Desktop runtime must exclusively own its account profile.
    const pool = this.store.data.accounts.map((account) => {
      const conflict =
        this.accounts.busy.has(account.id) ||
        [...this.active.values()].some(
          (run) =>
            run.job.id !== job.id &&
            run.job.accountId === account.id &&
            (job.mode === "desktop" || run.job.mode === "desktop"),
        );
      return conflict ? { ...account, enabled: false } : account;
    });
    return pickAccount(
      pool,
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
          this.closing ||
          this.maintaining ||
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
    this.warmupRecovery = this.warmups
      .recover()
      .catch((error) => this.log(error, "warning"));
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
    schedule?: Job["schedule"],
  ) {
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
    const job: Job = {
      ...input,
      ...(schedule ? { schedule } : {}),
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
      const job: Job = {
        ...input,
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
  private async tickOnce() {
    if (this.ticking || this.closing || this.maintaining) return;
    this.ticking = true;
    try {
      await this.warmupRecovery;
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
      const findRunnable = () =>
        this.store.data.jobs.find(
          (j) =>
            ["queued", "waiting"].includes(j.state) &&
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
        this.warmupRecovery = this.warmups
          .recover()
          .catch((error) => this.log(error, "warning"));
      }
      this.warmups.pump();
      if (this.closing || this.store.data.jobs.some((j) => j.recoveryRequired))
        return;
      const limit = Math.max(
        1,
        Math.min(8, this.store.data.settings.maxConcurrentTasks ?? 3),
      );
      for (const job of this.store.data.jobs) {
        if (this.closing || this.maintaining || this.active.size >= limit)
          break;
        if (
          this.familyActive(job.id) ||
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
        active.done = this.run(job, selection.account).catch((error) => {
          job.state = "needs_attention";
          job.recoveryRequired = true;
          job.lastError = redact(error);
          active.failedStop = true;
          this.log(error, "error", job.id);
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
    let poll: NodeJS.Timeout | undefined;
    let outcome: Outcome | undefined;
    try {
      job.state = "preparing";
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
      }
    } catch (error) {
      if (error instanceof ProcessSafetyError) active.failedStop = true;
      outcome = {
        kind:
          error instanceof ModelRoutingError
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
    if (active.reason) {
      job.goalResumeAfterQuota = false;
      job.goalResumeAfterModelChange = false;
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
    await this.store.save();
    if (!active.failedStop) this.active.delete(job.id);
    this.changed();
  }
  control(id: string, action: "pause" | "resume" | "cancel"): Promise<void> {
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
  }) {
    return this.queueControl(input.id, async () => {
      const job = this.store.data.jobs.find((j) => j.id === input.id);
      if (this.closing) throw new Error("Scheduler is shutting down");
      if (!job || job.mode !== "cli") throw new Error("请选择 CLI 会话");
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
  private async controlOnce(id: string, action: "pause" | "resume" | "cancel") {
    const job = this.store.data.jobs.find((j) => j.id === id);
    if (!job) throw new Error("任务不存在");
    if (["completed", "cancelled"].includes(job.state))
      throw new Error("终止任务不可再次操作，请新建任务");
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
      job.completionRetries = 0;
      job.lastError = undefined;
      job.nextWakeAt = undefined;
    } else if (this.active.has(id)) {
      this.active.get(id)!.reason = action;
      job.state = "pausing";
      this.changed();
      try {
        // User pause/cancel also pauses Goal continuation. Quota-driven stops
        // bypass this path, preserving their automatic recovery authority.
        const worker = this.active.get(id)?.worker;
        if (job.goal?.status === "active" && worker?.operation) {
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
      job.goalStartRequested = false;
      job.goalResumeAfterQuota = false;
      job.goalResumeAfterModelChange = false;
    }
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
  async shutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    try {
      await this.warmups.shutdown();
      await this.backgroundProbe;
      await this.controls.catch(() => {});
      await this.tickInFlight;
      await Promise.allSettled([...this.jobControls.values()]);
      const stopped = await Promise.allSettled(
        [...this.active.values()]
          .filter((run) => !["completed", "cancelled"].includes(run.job.state))
          .map((run) => this.control(run.job.id, "pause")),
      );
      await this.currentRun;
      if (
        stopped.some((result) => result.status === "rejected") ||
        [...this.active.values()].some((run) => run.failedStop)
      )
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
