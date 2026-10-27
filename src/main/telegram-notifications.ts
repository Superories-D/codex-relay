// Windows desktop integration. This module never polls for commands or changes webhooks.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWrite } from "../core/store";
import { redact } from "../core/redact";
import type { Snapshot } from "../shared/types";
import {notificationEvent,notificationState} from "../shared/notification-event";
import { telegramSave, telegramToken, type TelegramSave, type TelegramEvent,
  type TelegramReceipt, type TelegramView, type TelegramCandidate } from "../shared/telegram-notifications";

type Cipher = { encrypt(value: string): Buffer; decrypt(value: Buffer): string };
export type TelegramTransport = (token: string, method: string, body: object, signal: AbortSignal) => Promise<unknown>;
// A fixed HTTPS origin and no redirects keep the Bot token out of third-party URLs.
export function createTelegramTransport(request: (url: string, init: RequestInit) => Promise<Response> = fetch): TelegramTransport {
 return async (token, method, body, signal) => {
  const response = await request(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const reader = response.body?.getReader();
  if (!reader) throw Error("empty response");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      length += item.value.length;
      if (length > 1024 * 1024) throw Error("response too large");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
 };
}
export const telegramTransport = createTelegramTransport();
type Cursor = { jobs: Record<string, string>; events?: Record<string,string>; approvals: string[] };
type Envelope = {
  version: 1; revision: number; generation: string;
  blockedUntil?: number;
  token: string; chatId: string; enabled: boolean; includeTitles: boolean; events: TelegramEvent[];
  bot?: { id: number; username: string }; cursor: Cursor;
  receipts: (TelegramReceipt & { generation: string })[];
};
const empty = (): Envelope => ({ version: 1, revision: 0, generation: randomUUID(), token: "", chatId: "",
  enabled: false, includeTitles: false, events: ["completed", "attention", "approval"],
  cursor: { jobs: {}, approvals: [] }, receipts: [] });
function cursor(snapshot: Pick<Snapshot, "jobs" | "approvals">): Cursor {
  return {
    jobs: Object.fromEntries(snapshot.jobs.map(job => [job.id, notificationState(job)])),
    events: Object.fromEntries(snapshot.jobs.map(job=>[job.id,createHash("sha256").update(notificationEvent(job)).digest("hex")])),
    approvals: snapshot.approvals.map(a => createHash("sha256")
      .update(JSON.stringify([a.jobId, a.id, a.historyId, a.method, a.params])).digest("hex")),
  };
}
function validEnvelope(v: Envelope) {
  if (v.version !== 1 || !Number.isInteger(v.revision) || v.revision < 0 || typeof v.generation !== "string" ||
    !v.cursor || !v.cursor.jobs || !Array.isArray(v.cursor.approvals) || !Array.isArray(v.receipts) || v.receipts.length > 1000)
    throw Error("invalid envelope");
  if (v.token || v.chatId) telegramSave.parse({revision: v.revision, token: v.token, chatId: v.chatId,
    enabled: v.enabled, includeTitles: v.includeTitles, events: v.events});
  else if (v.enabled) throw Error("invalid configuration");
  for (const r of v.receipts) {
    if (!r || typeof r.id !== "string" || typeof r.generation !== "string" || typeof r.text !== "string" ||
      !["pending", "sending", "sent", "failed", "uncertain", "cancelled"].includes(r.status) ||
      !Number.isFinite(r.dueAt) || !Number.isFinite(r.attempts)) throw Error("invalid receipt");
  }
  return v;
}
type Reply = { ok: boolean; result?: any; error_code?: number; parameters?: { retry_after?: number } };
export class WindowsTelegram {
  private state = empty();
  private fault?: string;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private controller = new AbortController();
  private observations: Pick<Snapshot, "jobs" | "approvals">[] = [];
  private observedCursor?: string;
  private observing = false;
  private snapshot: Pick<Snapshot, "jobs" | "approvals"> = { jobs: [], approvals: [] };
  constructor(private options: {
    root: string; cipher: Cipher; transport?: TelegramTransport; now?: () => number;
    write?: typeof atomicWrite; changed?: () => void; manualPump?: boolean;
    text?: (source: string) => string;
  }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private text(source: string) { return this.options.text?.(source) ?? source; }
  private get file() { return path.join(this.options.root, "windows-telegram.enc"); }
  private queue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.chain.then(action);
    this.chain = operation.catch(() => {});
    return operation;
  }
  private async commit(value: Envelope) {
    try {
      await (this.options.write ?? atomicWrite)(this.file, this.options.cipher.encrypt(JSON.stringify(value)));
    } catch {
      this.fault = "Telegram 通知记录无法安全保存，发送已停止。请检查磁盘后重启客户端。";
      this.options.changed?.();
      throw Error(this.fault);
    }
    this.state = value;
    this.options.changed?.();
  }
  async load(snapshot: Pick<Snapshot, "jobs" | "approvals">) {
    this.snapshot = structuredClone(snapshot);
    try {
      this.state = validEnvelope(JSON.parse(this.options.cipher.decrypt(await fs.readFile(this.file))));
      const next = structuredClone(this.state);
      let interrupted = false;
      for (const receipt of next.receipts) if (receipt.status === "sending") {
        receipt.status = "uncertain"; receipt.issue = "上次发送结果未知，请先查看 Telegram，再决定是否重试。";
        receipt.updatedAt = this.now(); interrupted = true;
      }
      if (interrupted) await this.commit(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.state.cursor = cursor(snapshot);
      else this.fault = "Telegram 配置无法解密或读取；发送已停止，可移除配置后重新接入。";
    }
    this.observedCursor = JSON.stringify(this.state.cursor);
    this.schedule();
    return this.view();
  }
  view(): TelegramView {
    const {revision, enabled, includeTitles, events, chatId, bot} = this.state;
    return structuredClone({ revision, configured: !!this.state.token, enabled, includeTitles, events, chatId, bot,
      issue: this.fault, receipts: this.state.receipts.slice().reverse().map(({generation: _generation, ...r}) => r) });
  }
  private async request(token: string, method: string, body: object): Promise<Reply> {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]);
    const result = await (this.options.transport ?? telegramTransport)(token, method, body, signal) as Reply;
    if (!result || typeof result.ok !== "boolean") throw Error("invalid Telegram response");
    return result;
  }
  private assertAvailable() {
    if (this.stopped) throw Error("Telegram 通知正在关闭");
    if (this.fault) throw Error(this.fault);
  }
  private async identity(token: string, chatId: string) {
    try {
      const me = await this.request(token, "getMe", {});
      if (!me.ok || !me.result?.is_bot || !Number.isSafeInteger(me.result.id) ||
        !/^[A-Za-z0-9_]{5,32}$/.test(me.result.username)) throw Error("invalid bot");
      const chat = await this.request(token, "getChat", { chat_id: chatId });
      if (!chat.ok || chat.result?.type !== "private" || String(chat.result.id) !== chatId) throw Error("invalid chat");
      return { id: me.result.id as number, username: me.result.username as string };
    } catch { throw Error("无法验证 Bot 或私人聊天。请检查 Token、Chat ID，并先向 Bot 发送 /start。配置未更改。"); }
  }
  save(input: unknown) {
    // Never include a Zod error containing the candidate token in IPC/logs.
    const parsed = telegramSave.safeParse(input);
    if (!parsed.success) return Promise.reject(Error("Telegram 配置格式无效"));
    return this.queue(async () => {
      this.assertAvailable(); const value: TelegramSave = parsed.data;
      if (value.revision !== this.state.revision) throw Error("Telegram 配置已更新，请刷新后重试。");
      const token = value.token ?? this.state.token;
      if (!token) throw Error("请填写 Bot Token");
      const next = structuredClone(this.state);
      const changed = token !== next.token || value.chatId !== next.chatId;
      // Keep disabling usable while offline. An unchanged, previously verified
      // binding needs no network request merely to update notification choices.
      const bot = !changed && next.bot ? next.bot : await this.identity(token, value.chatId);
      if (changed) {
        next.generation = randomUUID();
        if (token !== next.token) delete next.blockedUntil;
        for (const r of next.receipts) if (["pending", "failed", "uncertain"].includes(r.status)) {
          r.status = "cancelled"; r.issue = "接收配置已变更，旧通知不会转发给新接收人。"; r.updatedAt = this.now();
        }
      }
      Object.assign(next, { token, bot, chatId: value.chatId, enabled: value.enabled,
        includeTitles: value.includeTitles, events: value.events, revision: next.revision + 1 });
      // Enabling starts with future transitions; historical completed jobs are not replayed.
      if (changed || !this.state.enabled || !value.enabled) {
        next.cursor = cursor(this.snapshot);
        this.observations = [];
        this.observedCursor = JSON.stringify(next.cursor);
      }
      await this.commit(next); this.schedule(); return this.view();
    });
  }
  discover(input: unknown): Promise<TelegramCandidate[]> {
    const parsed = telegramToken.optional().safeParse(input);
    if (!parsed.success) return Promise.reject(Error("Bot Token 格式无效"));
    return this.queue(async () => {
      this.assertAvailable(); const token = parsed.data ?? this.state.token;
      if (!token) throw Error("请填写 Bot Token");
      let webhook: Reply;
      try { webhook = await this.request(token, "getWebhookInfo", {}); }
      catch { throw Error("无法连接 Telegram，请检查网络与 Bot Token。"); }
      if (!webhook.ok) throw Error("无法连接 Telegram，请检查网络与 Bot Token。");
      if (webhook.result?.url) throw Error("Bot 已配置 Webhook，请手动填写私人 Chat ID；不会修改现有 Webhook。");
      let updates: Reply;
      try { updates = await this.request(token, "getUpdates", { timeout: 0, limit: 100 }); }
      catch { throw Error("无法读取最近聊天，请手动填写私人 Chat ID。"); }
      if (!updates.ok || !Array.isArray(updates.result)) throw Error("无法读取最近聊天，请手动填写私人 Chat ID。");
      const candidates = new Map<string, TelegramCandidate>();
      for (const u of updates.result) {
        const c = u.message?.chat;
        if (c?.type !== "private" || !Number.isSafeInteger(c.id) || c.id <= 0) continue;
        const id = String(c.id);
        candidates.set(id, {id, name: String(c.first_name || c.username || id).slice(0, 80)});
      }
      // No offset: none of the bot's updates are acknowledged/consumed.
      return [...candidates.values()];
    });
  }
  observe(snapshot: Pick<Snapshot, "jobs" | "approvals">) {
    this.snapshot = structuredClone(snapshot);
    const key = JSON.stringify(cursor(snapshot));
    if (key !== this.observedCursor && !this.stopped && !this.fault) {
      if (this.observations.length >= 1000) {
        this.fault = "Telegram 通知队列已满，请处理发送记录后重启。";
        this.options.changed?.(); return;
      }
      this.observations.push(this.snapshot); this.observedCursor = key;
    }
    if (this.observing || this.stopped || this.fault) return;
    this.observing = true;
    void this.queue(async () => {
      while (this.observations.length && !this.stopped && !this.fault) {
        const current = this.observations.shift()!;
        const next = structuredClone(this.state), after = cursor(current), before = next.cursor;
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        if (next.enabled) {
          const events = new Map<string, TelegramEvent>();
          current.approvals.forEach((a, i) => { if (!before.approvals.includes(after.approvals[i])) events.set(a.jobId, "approval"); });
          for (const job of current.jobs) {
            const state = after.jobs[job.id];
            const changed=before.jobs[job.id] !== state ||
              (!!before.events?.[job.id] && before.events[job.id] !== after.events![job.id]);
            if (before.jobs[job.id] && changed && !events.has(job.id)) {
              if (state === "completed") events.set(job.id, "completed");
              else if (state === "needs_attention") events.set(job.id, "attention");
              else if (state === "waiting") events.set(job.id, "waiting");
            }
          }
          for (const [id, event] of events) {
            if (!next.events.includes(event)) continue;
            const job = current.jobs.find(j => j.id === id); if (!job) continue;
            const heading = { completed: "任务已完成", attention: "任务需要处理", approval: "任务等待你的回复或批准", waiting: "任务正在等待可用额度" }[event];
            const lines = ["Codex Relay", this.text(heading), `${this.text("任务编号")}: ${id.slice(0, 8)}`];
            if (next.includeTitles) lines.push(redact(job.title.replaceAll(next.token, "[REDACTED]"), 160).replace(/[\r\n\u0000-\u001f]/g, " "));
            const report = job.delivery?.reports.at(-1);
            if (job.delivery?.checks.length && report?.revision === job.delivery.revision)
              lines.push(this.text(job.delivery?.staleEvidence && job.delivery.staleEvidence.reportId === report.id ? "交付证据已失效" : report.status === "passed" ? "交付验收通过" : "交付验收未通过"));
            this.append(next, event, lines.join("\n"), id);
          }
        }
        next.cursor = after;
        await this.commit(next);
      }
      this.schedule();
    }).catch(() => {
      this.fault ||= "Telegram 通知记录无法安全保存，发送已停止。请检查磁盘后重启客户端。";
      this.options.changed?.();
    }).finally(() => { this.observing = false; if (this.observations.length && !this.stopped && !this.fault) this.observe(this.snapshot); });
  }
  private append(next: Envelope, event: TelegramReceipt["event"], text: string, jobId?: string) {
    // Keep every unresolved item, while bounding resolved history and avoiding silent queue loss.
    const resolved = new Set(next.receipts.filter(r => ["sent", "cancelled"].includes(r.status)).slice(-100).map(r => r.id));
    next.receipts = next.receipts.filter(r => !["sent", "cancelled"].includes(r.status) || resolved.has(r.id));
    if (next.receipts.length >= 1000) throw Error("Telegram 通知队列已满，请处理发送记录后重启。");
    next.receipts.push({id: randomUUID(), generation: next.generation, event, jobId, text,
      status: "pending", attempts: 0, dueAt: this.now(), createdAt: this.now(), updatedAt: this.now()});
  }
  test(revision: number) {
    return this.queue(async () => {
      this.assertAvailable();
      if (revision !== this.state.revision || !this.state.token) throw Error("请先保存有效的 Telegram 配置");
      const next = structuredClone(this.state);
      this.append(next, "test", `Codex Relay\n${this.text("Telegram 测试通知")}`);
      await this.commit(next); this.schedule(); return this.view();
    });
  }
  action(id: string, action: "retry" | "cancel") {
    return this.queue(async () => {
      this.assertAvailable(); const next = structuredClone(this.state), r = next.receipts.find(r => r.id === id);
      if (!r || r.generation !== next.generation || ["sent", "sending", "cancelled"].includes(r.status)) throw Error("这条通知当前无法执行此操作");
      r.status = action === "retry" ? "pending" : "cancelled"; r.dueAt = this.now(); r.updatedAt = this.now();
      r.attempts = 0; delete r.issue;
      await this.commit(next); this.schedule(); return this.view();
    });
  }
  forget(revision: number) {
    return this.queue(async () => {
      if (revision !== this.state.revision) throw Error("Telegram 配置已更新，请刷新后重试。");
      const next = empty(); next.revision = this.state.revision + 1; next.cursor = cursor(this.snapshot);
      this.observations = []; this.observedCursor = JSON.stringify(next.cursor);
      await this.commit(next); this.fault = undefined; this.schedule(); return this.view();
    });
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || this.fault || this.options.manualPump) return;
    const pending = this.state.receipts.filter(r => r.status === "pending" && r.generation === this.state.generation && (this.state.enabled || r.event === "test"));
    if (!pending.length) return;
    const due = Math.max(this.state.blockedUntil ?? 0, Math.min(...pending.map(r => r.dueAt)));
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump().catch(() => {}); }, Math.min(60000, Math.max(1000, due - this.now())));
    this.timer.unref?.();
  }
  pump() {
    return this.queue(async () => {
      this.assertAvailable();
      if ((this.state.blockedUntil ?? 0) > this.now()) { this.schedule(); return; }
      const item = this.state.receipts.find(r => r.status === "pending" && r.generation === this.state.generation && r.dueAt <= this.now() && (this.state.enabled || r.event === "test"));
      if (!item) { this.schedule(); return; }
      let next = structuredClone(this.state), receipt = next.receipts.find(r => r.id === item.id)!;
      receipt.status = "sending"; receipt.attempts++; receipt.updatedAt = this.now();
      // Durable sending marker precedes the external effect. Restart never blindly resends it.
      await this.commit(next);
      let result: Reply | undefined;
      try { result = await this.request(next.token, "sendMessage", { chat_id: next.chatId, text: receipt.text,
        link_preview_options: { is_disabled: true }, protect_content: true }); } catch {}
      next = structuredClone(this.state); receipt = next.receipts.find(r => r.id === item.id)!;
      receipt.updatedAt = this.now();
      if (result?.ok && Number.isSafeInteger(result.result?.message_id) && result.result.message_id > 0) {
        receipt.status = "sent"; receipt.messageId = result.result.message_id;
      } else if (result?.ok === false && Number.isInteger(result.error_code)) {
        const retry = result.error_code === 429 || result.error_code! >= 500;
        receipt.status = retry && receipt.attempts < 5 ? "pending" : "failed";
        const seconds = result.parameters?.retry_after;
        const delay = result.error_code === 429 && typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
          ? seconds * 1000 : 5000 * 2 ** (receipt.attempts - 1);
        const deadline = Math.ceil(this.now() + Math.max(1000, delay));
        receipt.dueAt = Number.isSafeInteger(deadline) ? deadline : this.now();
        if (!Number.isSafeInteger(deadline)) receipt.status = "failed";
        receipt.issue = result.error_code === 429 && receipt.status === "pending" ? "Telegram 限流，已安排重试。" : `Telegram API ${result.error_code}`;
        if (result.error_code === 429) next.blockedUntil = receipt.dueAt;
      } else {
        receipt.status = "uncertain";
        receipt.issue = "发送结果未知，请先查看 Telegram，再决定是否重试。";
      }
      await this.commit(next); this.schedule();
    });
  }
  async drain() { await this.chain; }
  resume() {
    this.stopped = false; this.controller = new AbortController(); this.schedule();
  }
  async shutdown() {
    this.stopped = true; this.observations = []; if (this.timer) clearTimeout(this.timer);
    this.controller.abort(); await this.chain;
  }
}
