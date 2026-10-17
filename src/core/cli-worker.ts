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
import type { Quota, ChatAttachment, AgentState } from "../shared/types";
import { ensureWindowsSandbox } from "./windows-sandbox";
export class CliWorker extends EventEmitter implements Worker {
  private rpc?: Rpc;
  private threadId?: string;
  private turnId?: string;
  private quotaSeen = false;
  private lastError: unknown;
  private terminal = false;
  private completing = false;
  private stopping?: Promise<void>;
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
    await ensureWindowsSandbox(
      this.rpc,
      this.ctx.job.cwd,
      this.ctx.job.sandbox,
    );
    const quota = await this.quota();
    if (isExhausted(quota[this.ctx.job.bucket]))
      throw new Error("Usage limit exceeded before turn start");
    const config = {
      cwd: this.ctx.job.cwd,
      approvalPolicy: this.ctx.job.approvalPolicy,
      sandbox: {
        workspaceWrite: "workspace-write",
        readOnly: "read-only",
        dangerFullAccess: "danger-full-access",
      }[this.ctx.job.sandbox],
      ...(this.ctx.job.model ? { model: this.ctx.job.model } : {}),
      config: { "features.multi_agent": this.ctx.job.multiAgent !== false },
    };
    this.emit("stage", "创建或恢复本地会话");
    const result = await prepareThread(
      this.rpc,
      this.ctx.job.threadId,
      config,
      this.ctx.job.importedRollout,
    );
    this.threadId = result.thread.id;
    if (!this.ctx.job.model && typeof result.model === "string")
      this.ctx.job.model = result.model;
    await this.ctx.checkpoint(this.threadId!);
    if (!this.ctx.shouldStart()) {
      this.finish({ kind: "interrupted" });
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
    this.turnId = turn.turn.id;
    await this.ctx.checkpoint(this.threadId!, this.turnId);
    this.emit("stage", "Codex 正在执行");
    if (this.quotaSeen && !this.terminal) await this.stop();
  }
  private finish(result: Outcome) {
    if (!this.terminal) {
      this.terminal = true;
      this.settle(result);
      this.emit("settled", result);
    }
  }
  private agent(id: string, patch: Partial<AgentState>) {
    if (id === this.threadId) return;
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
      ["running", "pendingInit", "pending", "waiting"].includes(a.status),
    );
  }
  private async notification(msg: RpcMessage) {
    const p = msg.params ?? {};
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
      if (msg.method === "turn/started")
        this.agent(p.threadId, { turnId: p.turn.id, status: "running" });
      if (msg.method === "item/completed" && p.item?.type === "agentMessage")
        this.agent(p.threadId, { message: p.item.text });
      if (msg.method === "turn/completed") {
        this.agent(p.threadId, {
          status: p.turn.status === "completed" ? "completed" : p.turn.status,
          turnId: p.turn.id,
        });
        if (this.parentOutcome && !this.agentsRunning())
          this.finish(this.parentOutcome);
      }
      return;
    }
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    if (p.turnId && this.turnId && p.turnId !== this.turnId) return;
    if (this.parentOutcome && !this.agentsRunning())
      this.finish(this.parentOutcome);
    this.emit("chat", msg.method, p);
    if (msg.method === "thread/tokenUsage/updated" && p.tokenUsage)
      this.emit("usage", {
        ...p.tokenUsage.total,
        modelContextWindow: p.tokenUsage.modelContextWindow,
      });
    if (msg.method === "turn/started") {
      this.turnId = p.turn.id;
      if (this.threadId) await this.ctx.checkpoint(this.threadId, this.turnId);
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
    if (msg.method === "serverRequest/resolved") {
      const id = String(p.requestId);
      this.requests.delete(id);
      this.emit("approvalResolved", id);
    }
    if (msg.method === "turn/completed") {
      if (this.turnId && p.turn?.id !== this.turnId) return;
      this.completing = true;
      this.parentEnded = true;
      this.emit("stage", "收到终止事件，正在复查额度与结果");
      // Drain already queued quota notifications, then ask the server again. The final
      // turn status alone is NOT a completion signal when quota has been exhausted.
      await new Promise((resolve) => setTimeout(resolve, 750));
      let quotaKnown = false;
      try {
        const quotas = await this.quota();
        quotaKnown = hasQuotaEvidence(quotas[this.ctx.job.bucket]);
        if (isExhausted(quotas[this.ctx.job.bucket])) this.quotaSeen = true;
      } catch {
        quotaKnown = false;
      }
      const error = p.turn.error ?? this.lastError;
      if (this.quotaSeen || errorKind(error) === "quota")
        this.finish({ kind: "quota", error });
      else if (p.turn.status === "interrupted")
        this.finish({ kind: "interrupted" });
      else if (error || p.turn.status !== "completed")
        this.finish({
          kind: "error",
          error: error ?? new Error(`Unexpected turn status: ${p.turn.status}`),
        });
      else if (!quotaKnown || !this.finalText.trim())
        this.finish({
          kind: "error",
          error: new Error("终止原因不明确，需核查额度后继续"),
        });
      else {
        const outcome = completionOutcome(this.ctx.job, this.finalText);
        if (outcome.kind === "completed" && this.agentsRunning()) {
          this.parentOutcome = outcome;
          this.emit("stage", "主轮次已结束，等待子代理完成");
        } else this.finish(outcome);
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
    return this.rpc.call(method, { ...params, threadId: this.threadId });
  }
  async agentControl(
    threadId: string,
    action: "send" | "interrupt",
    text?: string,
  ) {
    const agent = this.agents.get(threadId);
    if (!agent || !this.rpc || this.terminal)
      throw new Error("子代理会话当前不可控制，请在主会话中继续任务");
    if (action === "interrupt") {
      if (
        !agent.turnId ||
        !["running", "waiting", "pendingInit"].includes(agent.status)
      )
        throw new Error("子代理当前没有正在运行的轮次");
      return this.rpc.call("turn/interrupt", {
        threadId,
        turnId: agent.turnId,
      });
    }
    if (!text?.trim()) throw new Error("请输入给子代理的消息");
    const input = [{ type: "text", text, text_elements: [] }];
    if (agent.turnId && ["running", "waiting"].includes(agent.status))
      return this.rpc.call("turn/steer", {
        threadId,
        expectedTurnId: agent.turnId,
        input,
      });
    return this.rpc.call("turn/start", {
      threadId,
      input,
      parentTurnId: this.turnId,
      rootTurnId: this.turnId,
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
      if (this.turnId && !this.terminal && !this.completing)
        void this.stop().catch(() => {});
    }
    return quotas;
  }
  async stop() {
    if (this.parentEnded && this.parentOutcome && !this.terminal) {
      this.parentOutcome = undefined;
      for (const agent of this.agents.values())
        if (
          agent.turnId &&
          ["running", "pendingInit", "waiting"].includes(agent.status)
        )
          await this.rpc!.call("turn/interrupt", {
            threadId: agent.threadId,
            turnId: agent.turnId,
          });
      this.finish({ kind: this.quotaSeen ? "quota" : "interrupted" });
      return;
    }
    if (
      this.terminal ||
      this.completing ||
      !this.rpc ||
      !this.turnId ||
      !this.threadId
    )
      return;
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      for (const agent of this.agents.values())
        if (
          agent.turnId &&
          ["running", "pendingInit", "waiting"].includes(agent.status)
        )
          await this.rpc!.call("turn/interrupt", {
            threadId: agent.threadId,
            turnId: agent.turnId,
          });
      await this.rpc!.call("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.turnId,
      });
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
    for (const agent of this.agents.values())
      if (["running", "pendingInit", "waiting"].includes(agent.status))
        this.agent(agent.threadId, { status: "interrupted" });
    this.rpc = undefined;
  }
}
