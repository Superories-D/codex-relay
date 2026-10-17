import { EventEmitter } from "node:events";
import { taskPrompt, completionOutcome } from "./completion";
import { prepareThread } from "./thread";
import { Rpc, type RpcMessage } from "./rpc";
import {
  errorKind,
  hasQuotaEvidence,
  isExhausted,
  isQuotaNotice,
  parseQuotas,
} from "./quota";
import {
  approvalFrom,
  type Outcome,
  type Worker,
  type WorkerContext,
} from "./worker";
import type {
  Quota,
  ChatAttachment,
  AgentState,
  ThreadGoal,
} from "../shared/types";
import { ensureWindowsSandbox } from "./windows-sandbox";
const activeAgentStatuses = new Set([
  "running",
  "pendingInit",
  "pending",
  "waiting",
  "interrupting",
]);
export class CliWorker extends EventEmitter implements Worker {
  private rpc?: Rpc;
  private threadId?: string;
  private turnId?: string;
  private turnEpoch = 0;
  private seenRootTurns = new Set<string>();
  private completedRootTurns = new Set<string>();
  private goal?: ThreadGoal | null;
  private goalRevision = 0;
  private waitingForGoal = false;
  private goalStopOutcome?: Outcome;
  private quotaSeen = false;
  private lastError: unknown;
  private terminal = false;
  private completing = false;
  private stopping?: Promise<void>;
  private stopRequested = false;
  private interruptingAgents = new Map<string, Promise<unknown>>();
  private activeAgentTurns = new Map<string, string>();
  private finalText = "";
  private quotas: Record<string, Quota> = {};
  private requests = new Map<string, number | string>();
  private agents = new Map<string, AgentState>();
  private parentEnded = false;
  private parentOutcome?: Outcome;
  private settle!: (outcome: Outcome) => void;
  done = new Promise<Outcome>((resolve) => {
    this.settle = resolve;
  });
  constructor(private ctx: WorkerContext) {
    super();
  }
  async start(auth: {
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType: string;
  }) {
    this.emit("stage", "连接 Codex CLI");
    this.rpc = await Rpc.open(this.ctx.cli, this.ctx.home);
    this.rpc.on(
      "notification",
      (msg) =>
        void this.notification(msg).catch((error) =>
          this.finish({ kind: "error", error }),
        ),
    );
    this.rpc.on("request", (msg) => void this.request(msg));
    this.rpc.on("diagnostic", (text) => this.emit("log", text));
    this.rpc.on("disconnected", () =>
      this.finish({
        kind: "error",
        error: new Error("Codex 连接中断，会话已保存"),
      }),
    );
    await this.rpc.call("account/login/start", {
      type: "chatgptAuthTokens",
      ...auth,
    });
    const sandbox = this.ctx.job.planMode ? "readOnly" : this.ctx.job.sandbox;
    await ensureWindowsSandbox(this.rpc, this.ctx.job.cwd, sandbox);
    const quota = await this.quota();
    if (isExhausted(quota[this.ctx.job.bucket]))
      throw new Error("Usage limit exceeded before turn start");
    const goalOnly =
      !!(
        this.ctx.job.goalStartRequested || this.ctx.job.goalResumeAfterQuota
      ) &&
      !this.ctx.job.pendingMessage &&
      !this.ctx.job.review;
    this.threadId = this.ctx.job.threadId;
    if (this.threadId) {
      await this.readGoal();
      if (
        this.ctx.job.goalResumeAfterQuota &&
        this.goal &&
        ["active", "usageLimited"].includes(this.goal.status)
      ) {
        // Recover an already-authorized Goal, retaining its original accounting.
        const response = await this.rpc.call("thread/goal/set", {
          threadId: this.threadId,
          status: "active",
          origin: "automatic",
        });
        this.setGoal(response.goal);
      }
      this.ctx.job.goalResumeAfterQuota = false;
    }
    if (goalOnly && this.goal?.status !== "active") {
      this.ctx.job.goalStartRequested = false;
      if (!this.goal) throw new Error("会话目标已不存在，未开始新的轮次");
      this.finish({
        kind: this.goal.status === "complete" ? "completed" : "goalStopped",
      });
      return;
    }
    if (!this.ctx.shouldStart()) {
      this.finish({ kind: "interrupted" });
      return;
    }
    const config = this.threadConfig();
    this.emit("stage", "创建或恢复本地会话");
    const result = await prepareThread(
      this.rpc,
      this.ctx.job.threadId,
      config,
      this.ctx.job.importedRollout,
    );
    this.threadId = result.thread.id;
    // Only restore descendants of this root, including nested descendants. The
    // old owned process was confirmed closed before a new worker was allowed.
    const pending = [...(this.ctx.job.agents || [])];
    while (pending.length) {
      const index = pending.findIndex(
        (agent) =>
          agent.parentThreadId === this.threadId ||
          (!!agent.parentThreadId && this.agents.has(agent.parentThreadId)),
      );
      if (index < 0) break;
      const [agent] = pending.splice(index, 1);
      this.agent(agent.threadId, {
        ...agent,
        status: activeAgentStatuses.has(agent.status)
          ? "interrupted"
          : agent.status,
      });
    }
    if (!this.ctx.job.model && typeof result.model === "string")
      this.ctx.job.model = result.model;
    await this.ctx.checkpoint(this.threadId!);
    if (!this.ctx.shouldStart()) {
      this.finish({ kind: "interrupted" });
      return;
    }
    if (goalOnly) {
      // Loading an active native Goal owns its first turn. Sending a second
      // turn/start here would inject a synthetic user prompt or steer it twice.
      await this.waitForRootTurn();
      if (!this.terminal) this.emit("stage", "Codex 正在执行目标");
      return;
    }
    this.emit("stage", "发送任务，等待执行确认");
    const review = this.ctx.job.review;
    const turn = await this.rpc
      .call(
        review ? "review/start" : "turn/start",
        review
          ? {
              threadId: this.threadId,
              target: { type: "uncommittedChanges" },
              delivery: "inline",
            }
          : {
              threadId: this.threadId,
              input: [
                {
                  type: "text",
                  text_elements: [],
                  text:
                    (this.ctx.job.planMode
                      ? "当前为规划模式：只调查、分析并提出计划，允许只读工具。不要修改文件、执行写入或采取外部行动。需要用户选择时请求输入。\n\n"
                      : "") +
                    taskPrompt(
                      this.ctx,
                      !!this.ctx.job.desktopSubmissionPending,
                    ),
                },
                ...(this.ctx.job.attachments ?? []).map(
                  ({ type, path, name }) =>
                    type === "localImage"
                      ? { type, path }
                      : { type, path, name },
                ),
              ],
              ...(this.ctx.job.effort ? { effort: this.ctx.job.effort } : {}),
              ...(this.ctx.job.serviceTier
                ? { serviceTier: this.ctx.job.serviceTier }
                : {}),
            },
      )
      .catch((error) => {
        if (!this.turnId && errorKind(error) === "transient")
          throw new Error("任务启动结果不确定，请检查保存的会话后再继续");
        throw error;
      });
    // Goal resume may already have admitted a turn. Its response must not
    // rewind a newer turn/started notification's ID.
    if (!this.turnId) await this.beginTurn(turn.turn.id);
    if (!this.completing && !this.terminal)
      this.emit("stage", "Codex 正在执行");
    if (this.quotaSeen && !this.terminal) await this.stop();
  }
  private setGoal(goal: ThreadGoal | null) {
    if (goal && goal.threadId !== this.threadId) return;
    this.goal = goal;
    this.goalRevision++;
    this.emit("goal", goal);
    this.settleWaitingGoal();
  }
  private settleWaitingGoal() {
    if (!this.waitingForGoal || this.terminal) return;
    if (this.goal?.status === "active") return;
    this.waitingForGoal = false;
    if (
      this.goal &&
      ["paused", "blocked", "usageLimited", "budgetLimited"].includes(
        this.goal.status,
      )
    ) {
      this.goalStopOutcome = { kind: "goalStopped" };
      this.completeAfterChildren(this.goalStopOutcome);
    } else {
      this.completeAfterChildren(
        completionOutcome(this.ctx.job, this.finalText),
      );
    }
  }
  private async readGoal() {
    if (!this.rpc || !this.threadId) return;
    try {
      const revision = this.goalRevision;
      const response = await this.rpc.call("thread/goal/get", {
        threadId: this.threadId,
      });
      if (revision === this.goalRevision && Object.hasOwn(response, "goal"))
        this.setGoal(response.goal);
    } catch {
      // Older CLI builds and explicitly disabled Goals still support chat.
    }
  }
  private async beginTurn(id: string) {
    if (this.terminal || this.seenRootTurns.has(id)) return;
    this.seenRootTurns.add(id);
    this.turnEpoch++;
    this.turnId = id;
    this.finalText = "";
    if (!this.quotaSeen) this.lastError = undefined;
    this.completing = false;
    this.parentEnded = false;
    this.parentOutcome = undefined;
    this.waitingForGoal = false;
    if (!this.stopRequested) this.goalStopOutcome = undefined;
    if (this.threadId) await this.ctx.checkpoint(this.threadId, id);
    this.emit("rootTurnStarted");
    if (this.stopRequested && this.rpc)
      await this.rpc.call("turn/interrupt", {
        threadId: this.threadId,
        turnId: id,
      });
  }
  private waitForRootTurn() {
    if (this.turnId) return Promise.resolve();
    if (this.terminal) return Promise.reject(new Error("目标启动前会话已终止"));
    return new Promise<void>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        this.off("rootTurnStarted", started);
        this.off("settled", ended);
      };
      const started = () => {
        clean();
        resolve();
      };
      const ended = () => {
        clean();
        reject(new Error("目标启动前会话已终止"));
      };
      const timer = setTimeout(() => {
        clean();
        reject(
          new Error("未收到目标自动启动事件，请检查会话后继续；不会补发任务"),
        );
      }, 10000);
      this.on("rootTurnStarted", started);
      this.on("settled", ended);
    });
  }
  private threadConfig(
    model = this.ctx.job.model,
    effort = this.ctx.job.effort,
    preserveNativeContext = false,
  ) {
    const sandbox = this.ctx.job.planMode ? "readOnly" : this.ctx.job.sandbox;
    return {
      ...(preserveNativeContext ? {} : { cwd: this.ctx.job.cwd }),
      ...((preserveNativeContext || this.ctx.job.preserveNativePermissions) &&
      !this.ctx.job.planMode
        ? {}
        : {
            approvalPolicy: this.ctx.job.approvalPolicy,
            sandbox: {
              workspaceWrite: "workspace-write",
              readOnly: "read-only",
              dangerFullAccess: "danger-full-access",
            }[sandbox],
          }),
      ...(model ? { model } : {}),
      ...(!preserveNativeContext && this.ctx.job.serviceTier
        ? { serviceTier: this.ctx.job.serviceTier }
        : {}),
      config: {
        "features.multi_agent": this.ctx.job.multiAgent !== false,
        "features.default_mode_request_user_input": true,
        ...(effort ? { model_reasoning_effort: effort } : {}),
        ...(this.goal?.status === "active" ? { "features.goals": true } : {}),
      },
    };
  }
  private finish(result: Outcome) {
    if (!this.terminal) {
      if (result.kind === "completed" && this.quotaSeen)
        result = { kind: "quota", error: this.lastError };
      else if (result.kind === "completed" && this.stopRequested)
        result = { kind: "interrupted" };
      if (
        result.kind === "quota" &&
        this.goal &&
        ["active", "usageLimited"].includes(this.goal.status)
      )
        this.ctx.job.goalResumeAfterQuota = true;
      this.terminal = true;
      this.settle(result);
      this.emit("settled", result);
    }
  }
  private agent(id: string, patch: Partial<AgentState>) {
    if (id === this.threadId) return;
    if (
      this.activeAgentTurns.has(id) &&
      patch.turnId === undefined &&
      patch.status &&
      !activeAgentStatuses.has(patch.status)
    ) {
      // A parent wait/close snapshot may arrive after a newer child turn starts.
      // Use that turn's terminal event (or thread/closed) as the authority.
      const { status, ...metadata } = patch;
      patch = metadata;
    }
    const previous = this.agents.get(id);
    const value: AgentState = {
      threadId: id,
      name: previous?.name || `Agent ${this.agents.size + 1}`,
      status: "running",
      ...previous,
      ...patch,
      updatedAt: Date.now(),
    };
    this.agents.set(id, value);
    this.emit("agent", value);
  }
  private agentsRunning() {
    return [...this.agents.values()].some((a) =>
      activeAgentStatuses.has(a.status),
    );
  }
  private completeAfterChildren(outcome: Outcome) {
    if (outcome.kind === "quota") this.quotaSeen = true;
    if (this.quotaSeen)
      outcome = { kind: "quota", error: this.lastError || outcome.error };
    else if (this.goalStopOutcome) outcome = this.goalStopOutcome;
    else if (this.stopRequested) outcome = { kind: "interrupted" };
    if (
      this.agentsRunning() &&
      (outcome.kind === "completed" ||
        outcome.kind === "goalStopped" ||
        outcome.kind === "quota" ||
        this.stopRequested)
    ) {
      this.parentOutcome = outcome;
      this.emit(
        "stage",
        this.stopRequested || outcome.kind === "quota"
          ? "等待子代理确认停止"
          : "主轮次已结束，等待子代理完成",
      );
      if (outcome.kind === "quota" || outcome.kind === "goalStopped")
        void this.stop().catch(() => {});
    } else this.finish(outcome);
  }
  private async notification(msg: RpcMessage) {
    const p = msg.params ?? {};
    if (msg.method === "serverRequest/resolved") {
      const id = String(p.requestId);
      this.requests.delete(id);
      this.emit("approvalResolved", id);
      return;
    }
    if (msg.method === "account/rateLimits/updated") {
      const quotas = parseQuotas(p, Date.now(), this.quotas, true);
      this.quotas = { ...this.quotas, ...quotas };
      this.emit("quota", quotas);
      if (isExhausted(quotas[this.ctx.job.bucket])) {
        this.quotaSeen = true;
        if (this.turnId && !this.terminal)
          void this.stop().catch((error) => this.emit("stopError", error));
      }
      return;
    }
    if (
      msg.method === "thread/started" &&
      p.thread?.source?.subAgent?.thread_spawn
    ) {
      const source = p.thread.source.subAgent.thread_spawn;
      if (
        source.parent_thread_id === this.threadId ||
        this.agents.has(source.parent_thread_id)
      ) {
        this.agent(p.thread.id, {
          parentThreadId: source.parent_thread_id,
          name:
            p.thread.agentNickname ||
            source.agent_nickname ||
            p.thread.id.slice(0, 8),
          role: p.thread.agentRole || source.agent_role,
        });
      }
    }
    const item = p.item;
    if (
      item?.type === "collabAgentToolCall" &&
      (!p.threadId ||
        p.threadId === this.threadId ||
        this.agents.has(p.threadId))
    ) {
      for (const id of item.receiverThreadIds ?? []) {
        const state = item.agentsStates?.[id];
        this.agent(id, {
          parentThreadId: item.senderThreadId,
          ...(item.prompt ? { prompt: item.prompt } : {}),
          ...(item.model ? { model: item.model } : {}),
          ...(item.reasoningEffort ? { effort: item.reasoningEffort } : {}),
          ...(state ? { status: state.status, message: state.message } : {}),
        });
      }
    }
    if (
      item?.type === "subAgentActivity" &&
      (!p.threadId ||
        p.threadId === this.threadId ||
        this.agents.has(p.threadId))
    ) {
      this.agent(item.agentThreadId, {
        name: item.agentPath || item.agentThreadId.slice(0, 8),
        parentThreadId: p.threadId,
        model: item.model,
        effort: item.reasoningEffort,
        status:
          item.kind === "completed"
            ? "completed"
            : item.kind === "interrupted"
              ? "interrupted"
              : "running",
      });
    }
    if (p.threadId && this.agents.has(p.threadId)) {
      this.emit("childChat", p.threadId, msg.method, p);
      if (msg.method === "turn/started") {
        this.activeAgentTurns.set(p.threadId, p.turn.id);
        this.agent(p.threadId, { turnId: p.turn.id, status: "running" });
        if (this.stopRequested)
          void this.interruptAgent(this.agents.get(p.threadId)!).catch(
            (error) => {
              this.emit("stopError", error);
              this.finish({ kind: "error", error });
            },
          );
      }
      if (msg.method === "item/completed" && p.item?.type === "agentMessage")
        this.agent(p.threadId, { message: p.item.text });
      if (msg.method === "turn/completed") {
        const current = this.agents.get(p.threadId)!;
        if (!current.turnId || current.turnId === p.turn.id) {
          this.activeAgentTurns.delete(p.threadId);
          this.agent(p.threadId, {
            status: p.turn.status === "completed" ? "completed" : p.turn.status,
            turnId: p.turn.id,
          });
        }
      }
      if (msg.method === "thread/closed") {
        this.activeAgentTurns.delete(p.threadId);
        this.agent(p.threadId, { status: "shutdown" });
      }
      const childError =
        msg.method === "turn/completed"
          ? p.turn.error
          : msg.method === "error"
            ? p.error
            : undefined;
      if (
        errorKind(childError) === "quota" ||
        (msg.method === "item/completed" &&
          p.item?.type === "agentMessage" &&
          isQuotaNotice(p.item.text))
      ) {
        this.quotaSeen = true;
        this.lastError = childError || p.item.text;
        if (!this.terminal) void this.stop().catch(() => {});
      }
      if (this.parentOutcome && !this.agentsRunning())
        this.finish(this.parentOutcome);
      return;
    }
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    // Goal state is scoped to the thread, not the current turn. A final
    // accounting update may reference an earlier turn and must still be saved.
    if (msg.method === "thread/goal/updated" && p.goal) {
      this.setGoal(p.goal);
      return;
    }
    if (msg.method === "thread/goal/cleared") {
      this.setGoal(null);
      return;
    }
    if (
      msg.method !== "turn/started" &&
      p.turnId &&
      this.turnId &&
      p.turnId !== this.turnId
    )
      return;
    if (this.parentOutcome && !this.agentsRunning())
      this.finish(this.parentOutcome);
    this.emit("chat", msg.method, p);
    if (msg.method === "thread/tokenUsage/updated" && p.tokenUsage)
      this.emit("usage", {
        ...p.tokenUsage.total,
        modelContextWindow: p.tokenUsage.modelContextWindow,
      });
    if (msg.method === "turn/started") {
      await this.beginTurn(p.turn.id);
    }
    if (msg.method === "item/agentMessage/delta")
      this.emit("output", p.delta ?? "");
    if (msg.method === "item/completed" && p.item?.type === "agentMessage") {
      if (p.item.phase == null || p.item.phase === "final_answer")
        this.finalText += p.item.text ?? "";
      if (isQuotaNotice(p.item.text)) this.quotaSeen = true;
    }
    if (msg.method === "item/completed" && p.item?.type === "exitedReviewMode")
      this.finalText +=
        typeof p.item.review === "string"
          ? p.item.review
          : JSON.stringify(p.item.review ?? "");
    if (msg.method === "item/commandExecution/outputDelta")
      this.emit("output", p.delta ?? "");
    if (msg.method === "error") {
      if (errorKind(p.error) === "quota") {
        this.quotaSeen = true;
        this.lastError = p.error;
      } else if (!p.willRetry) this.lastError = p.error;
      this.emit("log", p.error?.message ?? "Codex error");
    }
    if (msg.method === "turn/completed") {
      if (this.turnId && p.turn?.id !== this.turnId) return;
      if (this.completedRootTurns.has(p.turn.id)) return;
      this.completedRootTurns.add(p.turn.id);
      const epoch = this.turnEpoch;
      this.completing = true;
      this.parentEnded = true;
      this.emit("stage", "收到终止事件，正在复查额度与结果");
      // Drain already queued quota notifications, then ask the server again. The final
      // turn status alone is NOT a completion signal when quota has been exhausted.
      await new Promise((resolve) => setTimeout(resolve, 750));
      if (epoch !== this.turnEpoch || this.terminal) return;
      let quotaKnown = false;
      try {
        const quotas = await this.quota();
        quotaKnown = hasQuotaEvidence(quotas[this.ctx.job.bucket]);
        if (isExhausted(quotas[this.ctx.job.bucket])) this.quotaSeen = true;
      } catch {
        quotaKnown = false;
      }
      if (epoch !== this.turnEpoch || this.terminal) {
        if (this.quotaSeen && !this.terminal) void this.stop().catch(() => {});
        return;
      }
      await this.readGoal();
      if (epoch !== this.turnEpoch || this.terminal) return;
      const error = p.turn.error ?? this.lastError;
      if (this.quotaSeen || errorKind(error) === "quota")
        this.completeAfterChildren({ kind: "quota", error });
      else if (this.stopRequested)
        this.completeAfterChildren({ kind: "interrupted" });
      else if (error || !["completed", "interrupted"].includes(p.turn.status))
        this.finish({
          kind: "error",
          error: error ?? new Error(`Unexpected turn status: ${p.turn.status}`),
        });
      else if (
        this.goal &&
        ["paused", "blocked", "usageLimited", "budgetLimited"].includes(
          this.goal.status,
        )
      ) {
        this.goalStopOutcome = { kind: "goalStopped" };
        this.completeAfterChildren(this.goalStopOutcome);
      } else if (p.turn.status === "interrupted")
        this.completeAfterChildren({ kind: "interrupted" });
      else if (quotaKnown && this.goal?.status === "active") {
        this.waitingForGoal = true;
        this.emit("stage", "目标仍在执行，等待下一轮");
      } else if (
        !quotaKnown ||
        (!this.finalText.trim() && this.goal?.status !== "complete")
      )
        this.finish({
          kind: "error",
          error: new Error("终止原因不明确，需核查额度后继续"),
        });
      else {
        const outcome = completionOutcome(this.ctx.job, this.finalText);
        this.completeAfterChildren(outcome);
      }
    }
  }
  private async request(msg: RpcMessage) {
    try {
      if (msg.method === "account/chatgptAuthTokens/refresh") {
        const tokens = await this.ctx.refresh();
        this.rpc!.respond(msg.id!, tokens);
        return;
      }
      const id = String(msg.id);
      this.requests.set(id, msg.id!);
      const approval = approvalFrom(
        this.ctx.job.id,
        id,
        msg.method!,
        msg.params,
      );
      if (approval.kind === "unsupported") {
        this.rpc!.reject(msg.id!, `Unsupported server request: ${msg.method}`);
        this.requests.delete(id);
        this.emit("log", `未支持的交互请求：${msg.method}`);
      } else this.emit("approval", approval);
    } catch (error) {
      try {
        this.rpc?.reject(
          msg.id!,
          "Credential refresh failed; reauthentication may be required",
        );
      } catch {}
      this.emit("log", String(error));
    }
  }
  respond(id: string, value: unknown) {
    const original = this.requests.get(id);
    if (original === undefined) throw new Error("审批请求已过期");
    this.rpc!.respond(original, value);
    this.requests.delete(id);
  }
  async steer(text: string, attachments: ChatAttachment[]) {
    if (
      !this.rpc ||
      !this.threadId ||
      !this.turnId ||
      this.terminal ||
      this.completing
    )
      throw new Error("本轮已结束，请发送下一条消息");
    await this.rpc.call("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.turnId,
      input: [
        { type: "text", text, text_elements: [] },
        ...attachments.map(({ type, path, name }) =>
          type === "localImage" ? { type, path } : { type, path, name },
        ),
      ],
    });
  }
  async operation(method: string, params: Record<string, unknown>) {
    if (!this.rpc || !this.threadId || this.terminal)
      throw new Error("会话连接已结束");
    const revision = this.goalRevision;
    const result = await this.rpc.call(method, {
      ...params,
      threadId: this.threadId,
    });
    if (revision === this.goalRevision && method.startsWith("thread/goal/")) {
      if (Object.hasOwn(result, "goal")) this.setGoal(result.goal);
      else if (method === "thread/goal/clear" && result.cleared)
        this.setGoal(null);
    }
    return result;
  }
  async agentControl(
    threadId: string,
    action: "send" | "interrupt",
    text?: string,
  ) {
    const agent = this.agents.get(threadId);
    if (!agent || !this.rpc || this.terminal || this.stopRequested)
      throw new Error("子代理会话当前不可控制，请在主会话中继续任务");
    if (action === "interrupt") {
      if (!agent.turnId || !activeAgentStatuses.has(agent.status))
        throw new Error("子代理当前没有正在运行的轮次");
      const turnId = agent.turnId;
      this.agent(threadId, { turnId, status: "interrupting" });
      await this.interruptAgent(agent);
      return this.waitForAgentEnd(threadId, turnId);
    }
    if (!text?.trim()) throw new Error("请输入给子代理的消息");
    const input = [{ type: "text", text, text_elements: [] }];
    if (agent.status === "interrupting")
      throw Error("子代理正在停止，请等待停止确认后继续");
    if (agent.turnId && activeAgentStatuses.has(agent.status))
      return this.rpc.call("turn/steer", {
        threadId,
        expectedTurnId: agent.turnId,
        input,
      });
    const resumed = await this.rpc.call("thread/resume", {
      threadId,
      ...this.threadConfig(agent.model || "", agent.effort || "", true),
      excludeTurns: true,
    });
    if (resumed.thread?.id !== threadId)
      throw Error("子代理恢复后的会话 ID 不匹配，停止发送消息");
    if (this.stopRequested || this.terminal)
      throw Error("会话正在停止，请稍后继续");
    const result = await this.rpc.call("turn/start", {
      threadId,
      input,
      parentTurnId: this.turnId,
      rootTurnId: this.turnId,
      ...(agent.effort || this.ctx.job.effort
        ? { effort: agent.effort || this.ctx.job.effort }
        : {}),
    });
    if (
      result.turn?.id &&
      this.agents.get(threadId)?.turnId !== result.turn.id
    ) {
      this.activeAgentTurns.set(threadId, result.turn.id);
      this.agent(threadId, { turnId: result.turn.id, status: "running" });
    }
    if (this.stopRequested) {
      await this.interruptAgent(this.agents.get(threadId)!);
      throw Error("会话正在停止，请稍后继续");
    }
    return result;
  }
  private interruptAgent(agent: AgentState) {
    if (!agent.turnId || !this.rpc) return Promise.resolve();
    const key = `${agent.threadId}:${agent.turnId}`;
    let task = this.interruptingAgents.get(key);
    if (!task) {
      task = this.rpc
        .call("turn/interrupt", {
          threadId: agent.threadId,
          turnId: agent.turnId,
        })
        .catch((error) => {
          this.interruptingAgents.delete(key);
          throw error;
        });
      this.interruptingAgents.set(key, task);
    }
    return task;
  }
  private waitForAgentEnd(threadId: string, turnId: string) {
    const ended = () => {
      const current = this.agents.get(threadId);
      return (
        !current ||
        current.turnId !== turnId ||
        !activeAgentStatuses.has(current.status)
      );
    };
    if (ended()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (ended()) {
          clearTimeout(timer);
          this.off("agent", check);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.off("agent", check);
        reject(Error("子代理停止尚未确认，请停止主任务后检查恢复状态"));
      }, 20000);
      this.on("agent", check);
      check();
    });
  }
  async quota(): Promise<Record<string, Quota>> {
    if (!this.rpc) throw new Error("Worker not connected");
    const quotas = parseQuotas(await this.rpc.call("account/rateLimits/read"));
    this.quotas = quotas;
    this.emit("heartbeat");
    this.emit("quota", quotas);
    if (isExhausted(quotas[this.ctx.job.bucket])) {
      this.quotaSeen = true;
      if (
        this.turnId &&
        !this.terminal &&
        (!this.completing || this.waitingForGoal)
      )
        void this.stop().catch(() => {});
    }
    if (this.waitingForGoal && !this.terminal && !this.quotaSeen)
      await this.readGoal();
    return quotas;
  }
  async stop() {
    if (this.terminal || !this.rpc || !this.turnId || !this.threadId) return;
    if (this.stopping) return this.stopping;
    this.stopRequested = true;
    if (this.waitingForGoal) {
      this.waitingForGoal = false;
      this.parentOutcome = { kind: this.quotaSeen ? "quota" : "interrupted" };
    }
    if (
      this.quotaSeen &&
      this.goal &&
      ["active", "usageLimited"].includes(this.goal.status)
    )
      this.ctx.job.goalResumeAfterQuota = true;
    if (this.parentOutcome)
      this.parentOutcome =
        this.goalStopOutcome && !this.quotaSeen
          ? this.goalStopOutcome
          : {
              kind: this.quotaSeen ? "quota" : "interrupted",
              error: this.lastError,
            };
    this.stopping = (async () => {
      for (const agent of this.agents.values())
        if (agent.turnId && activeAgentStatuses.has(agent.status))
          await this.interruptAgent(agent);
      if (!this.parentEnded)
        await this.rpc!.call("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.turnId,
        });
      if (this.parentOutcome && !this.agentsRunning())
        this.finish(this.parentOutcome);
      // The successful RPC response only acknowledges the request. Wait for the
      // terminal notification before credentials, workers, or processes can change.
      await Promise.race([
        this.done,
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("未收到 turn/completed；拒绝自动切号")),
            20_000,
          );
          this.done.finally(() => clearTimeout(t));
        }),
      ]);
    })().catch((error) => {
      this.emit("stopError", error);
      this.finish({ kind: "error", error });
      throw error;
    });
    return this.stopping;
  }
  async close() {
    if (this.rpc) await this.rpc.close();
    this.activeAgentTurns.clear();
    for (const agent of this.agents.values())
      if (activeAgentStatuses.has(agent.status))
        this.agent(agent.threadId, { status: "interrupted" });
    this.rpc = undefined;
  }
}
