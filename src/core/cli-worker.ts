import { EventEmitter } from "node:events";
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
import type { Quota } from "../shared/types";
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
    };
    this.emit("stage", "创建或恢复本地会话");
    const result = await prepareThread(this.rpc, this.ctx.job.threadId, config);
    this.threadId = result.thread.id;
    if (!this.ctx.job.model && typeof result.model === "string")
      this.ctx.job.model = result.model;
    await this.ctx.checkpoint(this.threadId!);
    if (!this.ctx.shouldStart()) {
      this.finish({ kind: "interrupted" });
      return;
    }
    this.emit("stage", "发送任务，等待执行确认");
    const turn = await this.rpc
      .call("turn/start", {
        threadId: this.threadId,
        input: [
          {
            type: "text",
            text_elements: [],
            text: this.ctx.job.turnId
              ? this.ctx.resumePrompt
              : this.ctx.job.prompt,
          },
        ],
        ...(this.ctx.job.effort ? { effort: this.ctx.job.effort } : {}),
      })
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
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    if (p.turnId && this.turnId && p.turnId !== this.turnId) return;
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
      else this.finish({ kind: "completed" });
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
    this.rpc = undefined;
  }
}
