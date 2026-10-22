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
  method: "getWebhookInfo" | "getUpdates" | "sendMessage",
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<any>;
export function telegramApi(token: string): TelegramApi {
  let nextSendAt = 0,
    notBefore = 0;
  return async (method, body, signal) => {
    const delay =
      Math.max(notBefore, method === "sendMessage" ? nextSendAt : 0) -
      Date.now();
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
    if (method === "sendMessage") nextSendAt = Date.now() + 1100;
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
    pending: z
      .object({
        updateId: z.number().int().nonnegative(),
        text: z.string().max(4000),
      })
      .optional(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
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
  private constructor(
    private runtime: ServerRuntime,
    private config: TelegramConfig,
    private roots: string[],
    private api: TelegramApi,
    private write: typeof atomicWrite,
    private now: () => number,
  ) {
    this.identity = `${config.token.split(":")[0]}:${config.userId}`;
  }
  static async open(
    runtime: ServerRuntime,
    config: TelegramConfig,
    workspaces: string[],
    api = telegramApi(config.token),
    write = atomicWrite,
    now = Date.now,
  ) {
    const bridge = new TelegramBridge(
      runtime,
      configSchema.parse(config),
      await prepareWorkspaces(runtime.store.root, workspaces),
      api,
      write,
      now,
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
  private safe(text: unknown) {
    return redact(
      String(text).split(this.config.token).join("[REDACTED]"),
      3500,
    ).replace(/[\uD800-\uDBFF]$/, "");
  }
  private async commit(next: State) {
    await this.write(this.file(), JSON.stringify(next));
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
      { offset: -1, limit: 1, timeout: 0, allowed_updates: ["message"] },
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
  private async send(text: string) {
    await this.api(
      "sendMessage",
      {
        chat_id: this.config.userId,
        text: this.safe(text),
        link_preview_options: { is_disabled: true },
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
  private async execute(updateId: number, text: string): Promise<string> {
    const match = text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
    if (!match) return "Use /help for Relay commands.";
    const command = match[1].toLowerCase(),
      args = match[2] || "";
    if (command === "help" || command === "start")
      return "/projects · /status\n/run PROJECT_NUMBER instruction\n/send TASK_ID instruction\n/pause TASK_ID · /resume TASK_ID · /cancel TASK_ID\n/approvals · /approve CODE · /decline CODE\n/answer CODE JSON\nOnly this configured private chat can control Relay.";
    if (command === "projects")
      return (
        this.roots.map((root, i) => `${i + 1}. ${root}`).join("\n") ||
        "No workspaces configured."
      );
    if (command === "status")
      return (
        this.jobs()
          .slice(0, 12)
          .map((j) => `${j.id.slice(0, 8)} · ${this.tag(j)} · ${j.title}`)
          .join("\n") || "No tasks."
      );
    if (command === "run") {
      const parts = args.match(/^(\d+)\s+([\s\S]+)$/);
      if (!parts || !this.roots[Number(parts[1]) - 1])
        throw Error(
          "Use /run PROJECT_NUMBER instruction; list roots with /projects",
        );
      const prompt = parts[2].trim(),
        cwd = await resolveWorkspace(
          this.roots,
          this.roots[Number(parts[1]) - 1],
        );
      const job: any = await this.runtime.command("job.submit", {
        requestId: requestId(this.identity, updateId),
        input: {
          title: prompt.split("\n")[0].slice(0, 120),
          prompt,
          cwd,
          mode: "cli",
          model: "",
          effort: "",
          bucket: "codex",
          approvalPolicy: "on-request",
          sandbox: "workspaceWrite",
          interactive: true,
        },
      });
      return `Queued ${job.id}\n${job.title}`;
    }
    if (command === "send") {
      const parts = args.match(/^(\S+)\s+([\s\S]+)$/);
      if (!parts) throw Error("Use /send TASK_ID instruction");
      const job = this.findJob(parts[1]);
      await this.runtime.command("chat.submit", {
        requestId: requestId(this.identity, updateId),
        input: { id: job.id, text: parts[2], attachments: [], action: "queue" },
      });
      return `Follow-up accepted for ${job.id}`;
    }
    if (["pause", "resume", "cancel"].includes(command)) {
      const job = this.findJob(args.trim());
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
    if (command === "approvals") {
      this.grants.clear();
      const lines = [];
      for (const a of this.runtime.scheduler.approvals.slice(0, 10)) {
        const detail = JSON.stringify(a.params, null, 2);
        if (detail.length > 1200) {
          lines.push(
            `${a.jobId.slice(0, 8)} · ${a.kind}: request is too large for chat; review it in the web console.`,
          );
          continue;
        }
        const code = randomBytes(6).toString("hex");
        this.grants.set(code, {
          jobId: a.jobId,
          id: a.id,
          historyId: a.historyId,
          signature: this.signature(a),
          expires: this.now() + 5 * 60 * 1000,
        });
        lines.push(
          `${a.jobId.slice(0, 8)} · ${a.kind}\n${this.safe(detail)}\nCode: ${code} (5 minutes)\n${a.kind === "input" || a.kind === "elicitation" ? "Use /answer CODE JSON" : "Use /approve CODE or /decline CODE"}`,
        );
      }
      // Limit to complete request descriptions; never offer an approval for a truncated prompt.
      let reply = "";
      for (const line of lines) {
        if (reply.length + line.length > 3300) break;
        reply += line + "\n\n";
      }
      return reply || "No pending approvals.";
    }
    if (["approve", "decline", "answer"].includes(command)) {
      const parts = args.match(/^(\S+)(?:\s+([\s\S]+))?$/),
        code = parts?.[1] || "",
        grant = this.grants.get(code);
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
      await this.runtime.command("approval.respond", {
        id: grant.id,
        jobId: grant.jobId,
        historyId: grant.historyId,
        value,
      });
      this.grants.delete(code);
      return `Response sent for ${grant.jobId}`;
    }
    return "Unknown command. Use /help.";
  }
  async pollOnce() {
    await this.initialize();
    if (this.state!.pending) {
      const pending = this.state!.pending;
      await this.send(pending.text);
      await this.commit({
        ...this.state!,
        offset: pending.updateId + 1,
        pending: undefined,
      });
    }
    const updates = await this.api(
      "getUpdates",
      {
        offset: this.state!.offset,
        limit: 20,
        timeout: 25,
        allowed_updates: ["message"],
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
      const message = update.message;
      if (
        message?.chat?.type !== "private" ||
        String(message.chat.id) !== this.config.userId ||
        String(message.from?.id) !== this.config.userId ||
        message.from?.is_bot ||
        message.forward_origin ||
        message.via_bot ||
        typeof message.text !== "string"
      ) {
        await this.commit({ ...this.state!, offset: update.update_id + 1 });
        continue;
      }
      let reply;
      try {
        reply = await this.execute(update.update_id, message.text);
      } catch (e) {
        reply = `Error: ${this.safe(e instanceof Error ? e.message : e)}`;
      }
      await this.commit({
        ...this.state!,
        pending: { updateId: update.update_id, text: this.safe(reply) },
      });
      await this.send(reply);
      await this.commit({
        ...this.state!,
        offset: update.update_id + 1,
        pending: undefined,
      });
    }
    if (this.config.notify) await this.notify();
  }
  private async notify() {
    const jobs = this.jobs(),
      known = { ...this.state!.known },
      changed = [];
    for (const job of jobs) {
      const tag = this.tag(job);
      if (
        known[job.id] !== tag &&
        (tag === "completed" ||
          tag === "cancelled" ||
          tag === "needs_attention" ||
          tag.startsWith("approval:"))
      )
        changed.push(
          `${job.id.slice(0, 8)} · ${tag.startsWith("approval:") ? "needs your answer (/approvals)" : tag} · ${job.title}`,
        );
      known[job.id] = tag;
    }
    if (changed.length)
      await this.send("Relay update\n" + changed.slice(0, 10).join("\n"));
    const ids = new Set(jobs.map((j) => j.id));
    await this.commit({
      ...this.state!,
      known: Object.fromEntries(
        Object.entries(known).filter(([id]) => ids.has(id)),
      ),
    });
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
