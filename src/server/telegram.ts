import {
  notificationPolicySchema,
  quietNow,
  wantsNotice,
} from "./notification-policy";
import {deliveryStatus} from "./delivery-view";
import { attachmentsSchema } from "../main/validation";
import {
  telegramDownload,
  UPLOAD_LIMIT,
  type TelegramDownload,
} from "./uploads";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { ServerCipher } from "./vault";
import { atomicWrite } from "../core/store";
import { redact } from "../core/redact";
import { prepareWorkspaces, resolveWorkspace } from "./workspaces";
import type { ServerRuntime } from "./runtime";
import type { Approval, Job } from "../shared/types";
import {
  questionList,
  validateQuestionAnswers,
} from "../shared/user-questions";
import {
  TelegramConsole,
  contextSchema,
  replySchema,
  button,
  homeKeyboard,
  type TelegramContext,
  type TelegramReply,
} from "./telegram-console";
const configSchema = z
  .object({
    token: z.string().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/),
    userId: z.string().regex(/^[1-9]\d{4,19}$/),
    notify: z.boolean().default(false),
  })
  .strict();
export type TelegramConfig = z.infer<typeof configSchema>;
export async function telegramConfig(root: string, inputFile?: string) {
  const file = path.join(root, "telegram-config.vault"),
    cipher = await ServerCipher.open(root, false);
  if (inputFile) {
    const stat = await fs.lstat(inputFile);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 10000)
      throw Error(
        "Telegram config must be an owner-only regular file (0600), at most 10 KiB",
      );
    const config = configSchema.parse(
      JSON.parse(await fs.readFile(inputFile, "utf8")),
    );
    await atomicWrite(file, cipher.encrypt(JSON.stringify(config)));
    return config;
  }
  try {
    return configSchema.parse(
      JSON.parse(cipher.decrypt(await fs.readFile(file))),
    );
  } catch (e: any) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}
export type TelegramApi = (
  method:
    | "getFile"
    | "getWebhookInfo"
    | "getUpdates"
    | "sendMessage"
    | "sendDocument"
    | "answerCallbackQuery",
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<any>;
export function telegramApi(token: string): TelegramApi {
  let nextSendAt = 0,
    notBefore = 0;
  return async (method, body, signal) => {
    const delay =
      Math.max(
        notBefore,
        ["sendMessage", "sendDocument"].includes(method) ? nextSendAt : 0,
      ) - Date.now();
    if (delay > 0)
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          reject(Error("Telegram request stopped"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", aborted);
          resolve();
        }, delay);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
    if (signal.aborted) throw Error("Telegram request stopped");
    if (["sendMessage", "sendDocument"].includes(method))
      nextSendAt = Date.now() + 1100;
    let payload: string | FormData = JSON.stringify(body);
    if (method === "sendDocument") {
      const document = body.document as {
        name: string;
        text?: string;
        data?: string;
      };
      const form = new FormData();
      for (const [key, value] of Object.entries(body)) {
        if (key !== "document" && value !== undefined)
          form.set(
            key,
            typeof value === "object" ? JSON.stringify(value) : String(value),
          );
      }
      form.set(
        "document",
        new Blob(
          [
            document.data
              ? new Uint8Array(Buffer.from(document.data, "base64"))
              : document.text || "",
          ],
          {
            type: document.data
              ? "application/octet-stream"
              : "text/plain;charset=utf-8",
          },
        ),
        document.name,
      );
      payload = form;
    }
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers:
          typeof payload === "string"
            ? { "Content-Type": "application/json" }
            : undefined,
        body: payload,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
      });
    } catch {
      throw Error(`Telegram ${method} connection unavailable`);
    }
    const data = await response.json().catch(() => ({}));
    if (
      Number.isFinite(data.parameters?.retry_after) &&
      data.parameters.retry_after > 0
    )
      notBefore =
        Date.now() + Math.min(3600, data.parameters.retry_after) * 1000;
    if (!response.ok || data.ok !== true)
      throw Error(
        `Telegram ${method} failed (HTTP ${response.status}); check bot configuration and rate limits`,
      );
    return data.result;
  };
}
const stateSchema = z
  .object({
    version: z.literal(1),
    identity: z.string(),
    offset: z.number().int().nonnegative(),
    known: z.record(z.string(), z.string()),
    notificationPolicy: notificationPolicySchema.optional(),
    notices: z
      .array(
        z.object({
          jobId: z.string().uuid(),
          tag: z.string(),
          text: z.string().max(4000),
          at: z.number(),
        }),
      )
      .max(200)
      .optional(),
    noticeDropped: z.number().int().nonnegative().optional(),
    lastNoticeAt: z.number().optional(),
    context: contextSchema.optional(),
    inbox: attachmentsSchema.optional(),
    answerCode: z.string().optional(),
    routes: z.record(z.string(), z.string().uuid()).optional(),
    incoming: z
      .object({
        updateId: z.number().int().nonnegative(),
        text: z.string().max(110000),
        context: contextSchema,
        media: z
          .object({
            fileId: z.string().min(1).max(1000),
            name: z.string().max(200),
            size: z.number().nonnegative().max(UPLOAD_LIMIT).optional(),
          })
          .optional(),
      })
      .strict()
      .optional(),
    pending: replySchema
      .extend({ updateId: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
class TelegramPersistenceError extends Error {}
const requestId = (identity: string, id: number) => {
  const chars = createHash("sha256")
    .update(`telegram:${identity}:${id}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export class TelegramBridge {
  private state?: State;
  private controller = new AbortController();
  private loop?: Promise<void>;
  private grants = new Map<
    string,
    {
      jobId: string;
      id: string;
      historyId?: string;
      signature: string;
      expires: number;
    }
  >();
  private identity: string;
  private console: TelegramConsole;
  private wizard?: {
    code: string;
    index: number;
    answers: Record<string, { answers: string[] }>;
  };
  private constructor(
    private runtime: ServerRuntime,
    private config: TelegramConfig,
    private roots: string[],
    private api: TelegramApi,
    private write: typeof atomicWrite,
    private now: () => number,
    private download: TelegramDownload,
  ) {
    this.identity = `${config.token.split(":")[0]}:${config.userId}`;
    this.console = new TelegramConsole(
      runtime,
      roots,
      (text, limit) => this.safe(text, limit),
      async (context) => {
        const { attachments, ...selection } = context;
        await this.commit({ ...this.state!, context: selection });
      },
      now,
    );
  }
  static async open(
    runtime: ServerRuntime,
    config: TelegramConfig,
    workspaces: string[],
    api = telegramApi(config.token),
    write = atomicWrite,
    now = Date.now,
    download = telegramDownload(config.token),
  ) {
    const bridge = new TelegramBridge(
      runtime,
      configSchema.parse(config),
      await prepareWorkspaces(runtime.store.root, workspaces),
      api,
      write,
      now,
      download,
    );
    try {
      const state = stateSchema.parse(
        JSON.parse(await fs.readFile(bridge.file(), "utf8")),
      );
      if (state.identity === bridge.identity) bridge.state = state;
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    return bridge;
  }
  private file() {
    return path.join(this.runtime.store.root, "telegram-state.json");
  }
  private safe(text: unknown, limit = 3500) {
    return redact(
      String(text).split(this.config.token).join("[REDACTED]"),
      limit,
    ).replace(/[\uD800-\uDBFF]$/, "");
  }
  private async commit(next: State) {
    try {
      await this.write(this.file(), JSON.stringify(next));
    } catch (error) {
      throw new TelegramPersistenceError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    this.state = next;
  }
  private jobs() {
    return this.runtime.store.data.jobs
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 500);
  }
  private tag(job: Job) {
    const approvals = this.runtime.scheduler.approvals.filter(
      (a) => a.jobId === job.id,
    );
    return approvals.length
      ? `approval:${approvals.map((a) => a.historyId || a.id).join(",")}`
      : job.autoRecovery
        ? "recovering"
        : job.state;
  }
  async initialize() {
    if (this.state) return;
    const hook = await this.api("getWebhookInfo", {}, this.controller.signal);
    if (hook?.url)
      throw Error(
        "Telegram bot already has a webhook; use a dedicated polling bot",
      );
    // First enablement discards old commands. Never execute a previous deployment's backlog.
    const updates = await this.api(
      "getUpdates",
      {
        offset: -1,
        limit: 1,
        timeout: 0,
        allowed_updates: ["message", "callback_query"],
      },
      this.controller.signal,
    );
    const latest = Array.isArray(updates)
      ? Math.max(
          -1,
          ...updates.map((u) =>
            Number.isSafeInteger(u.update_id) ? u.update_id : -1,
          ),
        )
      : -1;
    await this.commit({
      version: 1,
      identity: this.identity,
      offset: latest + 1,
      known: Object.fromEntries(this.jobs().map((j) => [j.id, this.tag(j)])),
    });
  }
  private async send(reply: string | TelegramReply) {
    const value = typeof reply === "string" ? { text: reply } : reply;
    return this.api(
      value.document ? "sendDocument" : "sendMessage",
      {
        chat_id: this.config.userId,
        ...(value.document
          ? { document: value.document, caption: this.safe(value.text, 1000) }
          : {
              text: this.safe(value.text),
              link_preview_options: { is_disabled: true },
            }),
        reply_markup: {
          inline_keyboard: (value.keyboard || homeKeyboard()).map((row) =>
            row.map((b) => ({ ...b, text: this.safe(b.text, 60) })),
          ),
        },
      },
      this.controller.signal,
    );
  }
  private findJob(prefix: string) {
    if (!prefix || prefix.length < 8)
      throw Error("Use at least 8 characters of the task ID");
    const matches = this.runtime.store.data.jobs.filter((j) =>
      j.id.startsWith(prefix),
    );
    if (matches.length !== 1) throw Error("Task ID is missing or ambiguous");
    return matches[0];
  }
  private signature(a: Approval) {
    const job = this.runtime.store.data.jobs.find((j) => j.id === a.jobId);
    return createHash("sha256")
      .update(
        JSON.stringify([
          a.jobId,
          a.id,
          a.historyId,
          a.method,
          job?.turnId,
          a.params,
        ]),
      )
      .digest("hex");
  }
  private async execute(
    updateId: number,
    text: string,
    context: TelegramContext,
  ): Promise<string | TelegramReply> {
    const match = text.match(/^\/(\w+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
    if (!match) return "Use /help for Relay commands.";
    const command = match[1].toLowerCase(),
      args = (match[2] || "").trim();
    if (
      ["notify", "watch", "unwatch", "quiet", "throttle", "digest"].includes(
        command,
      )
    ) {
      const policy = this.state!.notificationPolicy || {
        mode: this.config.notify ? ("all" as const) : ("off" as const),
        watched: [],
        quiet: null,
        intervalSeconds: 0,
      };
      const next = structuredClone(policy);
      if (command === "digest")
        return {
          text: this.safe(
            `通知模式: ${policy.mode} · 待发 ${this.state!.notices?.length || 0} · 队列溢出累计 ${this.state!.noticeDropped || 0}\n` +
              (this.state!.notices || [])
                .slice(0, 15)
                .map(
                  (n) =>
                    `${n.jobId.slice(0, 8)} · ${n.tag} · ${new Date(n.at).toISOString()}`,
                )
                .join("\n") +
              "\n/notify all|errors|watched|off\n/watch [任务ID] · /unwatch ID\n/quiet START-END（UTC 小时，或 off）\n/throttle 0..3600（秒）",
          ),
        };
      if (command === "notify" && !args)
        return this.execute(updateId, "/digest", context);
      if (command === "notify")
        next.mode = z.enum(["all", "errors", "watched", "off"]).parse(args);
      if (command === "watch" || command === "unwatch") {
        const job = this.findJob(args || context.task || "");
        next.watched = [
          ...new Set([
            ...next.watched.filter((id) => id !== job.id),
            ...(command === "watch" ? [job.id] : []),
          ]),
        ];
        if (command === "watch") next.mode = "watched";
      }
      if (command === "quiet") {
        const times = args.match(/^(\d{1,2})-(\d{1,2})$/);
        if (args !== "off" && !times)
          throw Error("Use /quiet 22-7 (UTC hours) or /quiet off");
        next.quiet = times
          ? { start: Number(times[1]), end: Number(times[2]) }
          : null;
      }
      if (command === "throttle")
        next.intervalSeconds = z
          .number()
          .int()
          .min(0)
          .max(3600)
          .parse(Number(args));
      const validated = notificationPolicySchema.parse(next);
      await this.commit({
        ...this.state!,
        notificationPolicy: validated,
        notices: (this.state!.notices || []).filter((n) =>
          wantsNotice(validated, n.jobId, n.tag),
        ),
      });
      return `通知设置已保存。模式: ${validated.mode} · 关注 ${validated.watched.length} · 间隔 ${validated.intervalSeconds}s\n静默 UTC: ${validated.quiet ? `${validated.quiet.start}-${validated.quiet.end}` : "off"}\n/digest 查看排队通知。`;
    }
    if (command === "inbox") {
      if (args === "clear") {
        await this.commit({ ...this.state!, inbox: [] });
        return "附件暂存已清空。";
      }
      return {
        text:
          (this.state!.inbox || [])
            .map((a, i) => `${i + 1}. ${a.name}`)
            .join("\n") || "暂无附件。发送图片或文档后，再发送任务指令。",
        keyboard: [[button("清空暂存附件", "/inbox clear")]],
      };
    }
    const reply = await this.console.execute(
      command,
      args,
      context,
      requestId(this.identity, updateId),
    );
    if (reply !== undefined) return reply;
    if (command === "run") {
      const parts = args.match(/^(\d+)\s+([\s\S]+)$/);
      if (!parts || !this.roots[Number(parts[1]) - 1])
        throw Error(
          "Use /run PROJECT_NUMBER instruction; list roots with /projects",
        );
      const project = await resolveWorkspace(
        this.roots,
        this.roots[Number(parts[1]) - 1],
      );
      return (await this.console.execute(
        "new",
        parts[2].trim(),
        { ...context, project },
        requestId(this.identity, updateId),
      ))!;
    }
    if (command === "send") {
      const parts = args.match(/^(\S+)\s+([\s\S]+)$/);
      if (!parts) throw Error("Use /send TASK_ID instruction");
      const job = this.findJob(parts[1]);
      await this.runtime.command("chat.submit", {
        requestId: requestId(this.identity, updateId),
        input: {
          id: job.id,
          text: parts[2],
          attachments: context.attachments || [],
          action: "queue",
        },
      });
      return {
        text: `Follow-up accepted for ${job.id}`,
        taskId: job.id,
        keyboard: this.console.taskKeyboard(job),
      };
    }
    if (["pause", "resume", "cancel"].includes(command)) {
      const job = this.findJob(args.trim() || context.task || "");
      if (
        command === "resume" &&
        !["paused", "needs_attention"].includes(job.state)
      )
        return `Task already ${job.state}: ${job.id}`;
      if (
        (command === "pause" && job.state === "paused") ||
        (command === "cancel" && job.state === "cancelled")
      )
        return `Task already ${job.state}: ${job.id}`;
      await this.runtime.command("job.control", {
        id: job.id,
        action: command,
      });
      return `${command}: ${job.id}`;
    }
    if (command === "dismiss") {
      this.wizard = undefined;
      await this.commit({ ...this.state!, answerCode: undefined });
      return "已退出答题。普通文字将发送到当前任务。";
    }
    if (command === "approvals") {
      this.grants.clear();
      this.wizard = undefined;
      await this.commit({ ...this.state!, answerCode: undefined });
      const approvals = this.runtime.scheduler.approvals,
        page = args ? Number(args) : 1;
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        page > Math.max(1, approvals.length)
      )
        throw Error("Invalid approval page");
      const a = approvals[page - 1];
      if (!a) return "No pending approvals.";
      const detail = JSON.stringify(a.params, null, 2),
        keyboard = [];
      let text = `${a.jobId.slice(0, 8)} · ${a.kind} · ${page}/${approvals.length}\n`;
      if (detail.length > 2600) {
        text += "请求太长，不能在截断信息上审批。请在网页控制台查看完整请求。";
      } else {
        const code = randomBytes(6).toString("hex");
        this.grants.set(code, {
          jobId: a.jobId,
          id: a.id,
          historyId: a.historyId,
          signature: this.signature(a),
          expires: this.now() + 5 * 60 * 1000,
        });
        text += `${this.safe(detail)}\nCode: ${code} (5 minutes)\n`;
        if (
          a.kind === "input" &&
          questionList(a.params).length &&
          questionList(a.params).every((q) => (q.options?.length || 0) <= 25)
        ) {
          text += "点击逐题回答，支持选项按钮和文字。也可 /answer CODE JSON";
          keyboard.push([button("逐题回答", `/ask ${code}`)]);
        } else if (a.kind === "input" || a.kind === "elicitation")
          text += "Use /answer CODE JSON";
        else {
          text += "Use /approve CODE or /decline CODE";
          keyboard.push([
            button("同意此次请求", `/approve ${code}`),
            button("拒绝", `/decline ${code}`),
          ]);
        }
      }
      const nav = [];
      if (page > 1) nav.push(button("上一条", `/approvals ${page - 1}`));
      if (page < approvals.length)
        nav.push(button("下一条", `/approvals ${page + 1}`));
      if (nav.length) keyboard.push(nav);
      keyboard.push([
        button("任务详情", `/task ${a.jobId}`),
        button("刷新审批", `/approvals ${page}`),
      ]);
      return { text, keyboard, taskId: a.jobId };
    }
    if (["ask", "pick", "answertext"].includes(command)) {
      const parts = args.match(/^(\S+)(?:\s+(\d+)\s+([\s\S]+))?$/),
        code = parts?.[1] || "";
      const { approval } = this.currentGrant(code);
      const questions = questionList(approval.params);
      if (
        approval.kind !== "input" ||
        !questions.length ||
        questions.some((q) => (q.options?.length || 0) > 25)
      )
        throw Error("This request requires /answer CODE JSON");
      if (command === "ask") {
        this.wizard = { code, index: 0, answers: Object.create(null) };
        await this.commit({ ...this.state!, answerCode: code });
      } else {
        const wizard = this.wizard;
        if (
          !wizard ||
          wizard.code !== code ||
          Number(parts?.[2]) !== wizard.index
        )
          throw Error("问题已变化，请重新 /approvals → 逐题回答");
        const question = questions[wizard.index];
        const answer =
          command === "pick"
            ? question.options?.[Number(parts?.[3])]?.label
            : parts?.[3]?.trim();
        if (!answer || answer.length > 10000) throw Error("Invalid answer");
        if (
          question.options?.length &&
          !question.isOther &&
          !question.options.some((o) => o.label === answer)
        )
          throw Error("请点击提供的选项");
        wizard.answers[question.id] = { answers: [answer] };
        wizard.index++;
        if (wizard.index === questions.length) {
          const value = { answers: wizard.answers };
          validateQuestionAnswers(approval.params, value);
          return this.execute(
            updateId,
            `/answer ${code} ${JSON.stringify(value)}`,
            context,
          );
        }
      }
      const wizard = this.wizard!,
        q = questions[wizard.index];
      return {
        text: `问题 ${wizard.index + 1}/${questions.length} · ${q.header}\n${q.question}\n\n${(q.options || []).map((o, i) => `${i + 1}. ${o.label} — ${o.description}`).join("\n")}\n\n直接回复文字，或点击选项。/dismiss 退出答题。`,
        taskId: approval.jobId,
        keyboard: [
          ...(q.options || []).map((o, i) => [
            button(o.label, `/pick ${code} ${wizard.index} ${i}`),
          ]),
          [button("退出答题", "/dismiss")],
        ],
      };
    }
    if (["approve", "decline", "answer"].includes(command)) {
      const parts = args.match(/^(\S+)(?:\s+([\s\S]+))?$/),
        code = parts?.[1] || "";
      const { grant, approval } = this.currentGrant(code);
      let value: unknown;
      if (command === "answer") {
        if (!["input", "elicitation"].includes(approval.kind || ""))
          throw Error("This request requires approve or decline");
        value = JSON.parse(parts?.[2] || "");
      } else {
        if (["input", "elicitation"].includes(approval.kind || ""))
          throw Error(
            "This request needs an explicit JSON answer or the web console",
          );
        value = { decision: command === "approve" ? "accept" : "decline" };
      }
      // Consume before dispatch; an uncertain response must not accept a second request.
      this.grants.delete(code);
      await this.runtime.command("approval.respond", {
        id: grant.id,
        jobId: grant.jobId,
        historyId: grant.historyId,
        value,
      });
      this.wizard = undefined;
      await this.commit({ ...this.state!, answerCode: undefined });
      return `Response sent for ${grant.jobId}`;
    }
    return "Unknown command. Use /help.";
  }
  private async stageMedia(
    incoming: NonNullable<State["incoming"]>,
  ): Promise<TelegramReply> {
    const uploads = this.runtime.uploads,
      id = requestId(this.identity, incoming.updateId),
      media = incoming.media!;
    let result;
    try {
      result = await uploads.read(id);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!result) {
      if ((this.state!.inbox?.length || 0) >= 10)
        throw Error("最多暂存 10 个附件，请先发送任务或 /inbox clear");
      const file = await this.api(
        "getFile",
        { file_id: media.fileId },
        this.controller.signal,
      ).catch((error) => {
        throw new TelegramPersistenceError(
          "Telegram file metadata unavailable; retrying",
          { cause: error },
        );
      });
      if (
        typeof file?.file_path !== "string" ||
        Number(file.file_size) > UPLOAD_LIMIT
      )
        throw Error("附件无效或超过 8 MiB");
      const data = await this.download(
        file.file_path,
        this.controller.signal,
      ).catch((error) => {
        if (/8 MiB|Invalid Telegram file path/.test(String(error))) throw error;
        throw new TelegramPersistenceError(
          "Telegram file download interrupted; retrying",
          { cause: error },
        );
      });
      result = await uploads.put(id, media.name, data);
    }
    const inbox = this.state!.inbox || [];
    if (!inbox.some((a) => a.path === result.attachment.path))
      await this.commit({
        ...this.state!,
        inbox: [...inbox, result.attachment],
      });
    return {
      text: `附件已暂存: ${result.attachment.name}（${result.size} bytes）\n发送下一条任务指令一起提交；/inbox 查看或清空。文件说明不会自动执行。`,
      keyboard: [[button("查看附件", "/inbox")]],
    };
  }
  private currentGrant(code: string) {
    const grant = this.grants.get(code);
    if (!grant || grant.expires <= this.now())
      throw Error("Approval code expired; request /approvals again");
    const approval = this.runtime.scheduler.approvals.find(
      (a) =>
        a.jobId === grant.jobId &&
        a.id === grant.id &&
        a.historyId === grant.historyId,
    );
    if (!approval || this.signature(approval) !== grant.signature)
      throw Error("Approval changed; request /approvals again");
    return { grant, approval };
  }
  private async deliverPending() {
    const pending = this.state!.pending;
    if (!pending) return;
    const sent = await this.send(pending),
      routes = { ...this.state!.routes };
    if (pending.taskId && Number.isSafeInteger(sent?.message_id))
      routes[String(sent.message_id)] = pending.taskId;
    const entries = Object.entries(routes)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .slice(0, 200);
    await this.commit({
      ...this.state!,
      routes: Object.fromEntries(entries),
      offset: pending.updateId + 1,
      pending: undefined,
      incoming: undefined,
    });
  }
  private async processIncoming() {
    const incoming = this.state!.incoming;
    if (!incoming) return;
    let reply: TelegramReply;
    try {
      const result = incoming.media
        ? await this.stageMedia(incoming)
        : await this.execute(
            incoming.updateId,
            incoming.text,
            incoming.context,
          );
      if (
        !incoming.media &&
        /^\/(new|run|send)\b/.test(incoming.text) &&
        incoming.context.attachments?.length
      ) {
        const used = new Set(incoming.context.attachments.map((a) => a.path));
        await this.commit({
          ...this.state!,
          inbox: (this.state!.inbox || []).filter((a) => !used.has(a.path)),
        });
      }
      reply = typeof result === "string" ? { text: result } : result;
    } catch (e) {
      if (e instanceof TelegramPersistenceError) throw e;
      reply = {
        text: `Error: ${this.safe(e instanceof Error ? e.message : e)}`,
      };
    }
    reply.text = this.safe(reply.text);
    if (reply.keyboard)
      reply.keyboard = reply.keyboard.map((row) =>
        row.map((b) => ({ ...b, text: this.safe(b.text, 60) })),
      );
    if (reply.document)
      reply.document.name = this.safe(reply.document.name, 200);
    if (reply.document?.text !== undefined) {
      const limit = 8 * 1024 * 1024;
      const truncated = reply.document.text.length > limit;
      reply.document.text =
        this.safe(reply.document.text, truncated ? limit - 100 : limit) +
        (truncated
          ? "\n[Document exceeded 8 Mi characters; remainder omitted.]"
          : "");
    }
    // Validate and save the complete reply (including any document) before network I/O.
    replySchema.parse(reply);
    await this.commit({
      ...this.state!,
      pending: { ...reply, updateId: incoming.updateId },
      incoming: undefined,
    });
    await this.deliverPending();
  }
  private route(text: string, message: any, context: TelegramContext) {
    const run = text.match(/^\/run(?:@[A-Za-z0-9_]+)?\s+(\d+)\s+([\s\S]+)$/i);
    if (run) {
      const project = this.roots[Number(run[1]) - 1];
      if (!project)
        throw Error(
          "Use /run PROJECT_NUMBER instruction; list roots with /projects",
        );
      // Workspace numbers are presentation only and may change with launch configuration.
      context.project = project;
      return `/new ${run[2]}`;
    }
    if (text.startsWith("/")) return text;
    if (this.state!.answerCode) {
      // Persisted answer mode fails closed after restart; it must not become a task instruction.
      return `/answertext ${this.state!.answerCode} ${this.wizard?.index || 0} ${text}`;
    }
    let task = context.task;
    if (message.reply_to_message) {
      task = this.state!.routes?.[String(message.reply_to_message.message_id)];
      if (!task)
        throw Error(
          "这条回复未关联任务，请 /task ID 后重新发送；没有投递到其他任务。",
        );
    }
    if (!task)
      throw Error(
        "先 /project 选项目、/new 创建任务，或 /task ID 选择已有任务。",
      );
    return `/send ${task} ${text}`;
  }
  async pollOnce() {
    await this.initialize();
    await this.deliverPending();
    // A durable resolved route survives lost acknowledgements, project changes and restart.
    await this.processIncoming();
    const updates = await this.api(
      "getUpdates",
      {
        offset: this.state!.offset,
        limit: 20,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      },
      this.controller.signal,
    );
    if (!Array.isArray(updates))
      throw Error("Invalid Telegram update response");
    for (const update of updates
      .slice(0, 100)
      .sort((a, b) => a.update_id - b.update_id)) {
      if (
        !Number.isSafeInteger(update.update_id) ||
        update.update_id < this.state!.offset
      )
        continue;
      const callback = update.callback_query,
        message = callback?.message || update.message,
        sender = callback?.from || message?.from;
      const text = callback ? callback.data : message?.text;
      if (
        message?.chat?.type !== "private" ||
        String(message.chat.id) !== this.config.userId ||
        String(sender?.id) !== this.config.userId ||
        sender?.is_bot ||
        message.forward_origin ||
        message.via_bot ||
        (callback &&
          (typeof callback.id !== "string" ||
            typeof text !== "string" ||
            Buffer.byteLength(text) > 64 ||
            !text.startsWith("/")))
      ) {
        await this.commit({ ...this.state!, offset: update.update_id + 1 });
        continue;
      }
      if (callback) {
        // An expired acknowledgement must not block processing of the actual operation.
        await this.api(
          "answerCallbackQuery",
          { callback_query_id: callback.id },
          this.controller.signal,
        ).catch(() => {});
      }
      const context = structuredClone({
        ...this.state!.context,
        attachments: this.state!.inbox || [],
      });
      let routed: string;
      let media: NonNullable<State["incoming"]>["media"];
      const source =
        !callback &&
        (message.document ||
          (Array.isArray(message.photo) ? message.photo.at(-1) : undefined));
      try {
        if (source) {
          if (
            typeof source.file_id !== "string" ||
            source.file_id.length > 1000 ||
            (source.file_size !== undefined &&
              (!Number.isFinite(source.file_size) ||
                source.file_size < 0 ||
                source.file_size > UPLOAD_LIMIT))
          )
            throw Error("附件信息无效或超过 8 MiB");
          media = {
            fileId: source.file_id,
            name: String(message.document?.file_name || "photo.jpg").slice(
              -200,
            ),
            size: source.file_size,
          };
        }
        if (!media && typeof text !== "string")
          throw Error(
            "目前接收文字指令；请将文件内容粘贴为文字。语音和二进制附件不会自动执行。",
          );
        if (typeof text === "string" && text.length > 100000)
          throw Error("Message is too large");
        routed = media
          ? "/upload"
          : this.route(text.trim(), callback ? {} : message, context);
      } catch (e) {
        await this.commit({
          ...this.state!,
          pending: {
            updateId: update.update_id,
            text: this.safe(`Error: ${e instanceof Error ? e.message : e}`),
          },
        });
        await this.deliverPending();
        continue;
      }
      await this.commit({
        ...this.state!,
        incoming: { updateId: update.update_id, text: routed, context, media },
      });
      await this.processIncoming();
    }
    await this.notify();
  }
  private async notify() {
    const jobs = this.jobs(),
      known = { ...this.state!.known },
      policy = this.state!.notificationPolicy || {
        mode: this.config.notify ? ("all" as const) : ("off" as const),
        watched: [],
        quiet: null,
        intervalSeconds: 0,
      };
    let notices = [...(this.state!.notices || [])],
      dropped = this.state!.noticeDropped || 0;
    for (const job of jobs) {
      const tag = this.tag(job);
      if (known[job.id] === tag) continue;
      known[job.id] = tag;
      if (!wantsNotice(policy, job.id, tag)) continue;
      let text = `Relay update\n${job.id.slice(0, 8)} · ${tag.startsWith("approval:") ? "needs your answer (/approvals)" : tag} · ${job.title.slice(0, 120)}`;
      if (job.delivery?.checks.length) text += `\n交付验收: ${deliveryStatus(job.delivery)}`;
      if (tag === "completed") {
        const page = await this.runtime.scheduler.chats.read(job.id),
          latest = [...page.items]
            .reverse()
            .find((i) => i.role === "assistant" && i.text.trim());
        if (latest)
          text += `\n\n${this.safe(latest.text, 1200)}${latest.text.length > 1200 ? "…（点击最新结果查看全文）" : ""}`;
      } else if (tag === "needs_attention" && job.lastError)
        text += `\n${this.safe(job.lastError, 1000)}`;
      else if (tag === "recovering")
        text += "\n正在自动检查并恢复；无需点击继续。手动暂停/取消仍然有效。";
      notices.push({
        jobId: job.id,
        tag,
        text: this.safe(text),
        at: this.now(),
      });
    }
    if (notices.length > 200) {
      dropped += notices.length - 200;
      notices = notices.slice(-200);
    }
    const ids = new Set(jobs.map((j) => j.id)),
      next = {
        ...this.state!,
        known: Object.fromEntries(
          Object.entries(known).filter(([id]) => ids.has(id)),
        ),
        notices,
        noticeDropped: dropped,
      };
    // Snapshot notification content before network I/O, including quiet periods.
    if (JSON.stringify(next) !== JSON.stringify(this.state))
      await this.commit(next);
    if (quietNow(policy, this.now())) return;
    let delivered = 0;
    while (this.state!.notices?.length && delivered < 5) {
      if (
        policy.intervalSeconds &&
        this.state!.lastNoticeAt !== undefined &&
        this.now() - this.state!.lastNoticeAt < policy.intervalSeconds * 1000
      )
        return;
      const notice = this.state!.notices[0],
        job = this.runtime.store.data.jobs.find((j) => j.id === notice.jobId);
      const sent = await this.send({
          text: notice.text,
          taskId: notice.jobId,
          keyboard: job ? this.console.taskKeyboard(job) : homeKeyboard(),
        }),
        routes = { ...this.state!.routes };
      if (Number.isSafeInteger(sent?.message_id))
        routes[String(sent.message_id)] = notice.jobId;
      await this.commit({
        ...this.state!,
        notices: this.state!.notices!.slice(1),
        lastNoticeAt: this.now(),
        routes: Object.fromEntries(
          Object.entries(routes)
            .sort((a, b) => Number(b[0]) - Number(a[0]))
            .slice(0, 200),
        ),
      });
      delivered++;
    }
  }
  start(onError: (error: unknown) => void) {
    if (this.loop) return;
    this.loop = (async () => {
      let failures = 0;
      while (!this.controller.signal.aborted) {
        try {
          await this.pollOnce();
          failures = 0;
        } catch (e) {
          if (this.controller.signal.aborted) break;
          onError(Error(this.safe(e instanceof Error ? e.message : e)));
          failures++;
        }
        if (this.controller.signal.aborted) break;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.controller.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(
            done,
            Math.min(60000, 1000 * 2 ** Math.min(failures, 6)),
          );
          this.controller.signal.addEventListener("abort", done, {
            once: true,
          });
        });
      }
    })();
  }
  async stop() {
    this.controller.abort();
    await this.loop;
  }
}
