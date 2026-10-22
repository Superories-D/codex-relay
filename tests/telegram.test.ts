import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, vi } from "vitest";
import { ServerRuntime } from "../src/server/runtime";
import {
  TelegramBridge,
  telegramConfig,
  type TelegramApi,
} from "../src/server/telegram";
import { atomicWrite } from "../src/core/store";
const config = {
  token: "123456789:" + "a".repeat(35),
  userId: "123456789",
  notify: false,
};
const message = (update_id: number, text: string, patch: any = {}) => ({
  update_id,
  message: {
    chat: { id: 123456789, type: "private" },
    from: { id: 123456789, is_bot: false },
    text,
    ...patch,
  },
});
async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "relay-telegram-")),
    workspace = path.join(base, "project");
  await fs.mkdir(workspace);
  const runtime = await ServerRuntime.open(path.join(base, "data"));
  await runtime.scheduler.dispatch(true);
  return {
    base,
    workspace,
    runtime,
    async close() {
      await runtime.close();
      await fs.rm(base, { recursive: true, force: true });
    },
  };
}
function transport() {
  let updates: any[] = [];
  const sent: any[] = [];
  let failSend = false;
  const api: TelegramApi = async (method, body) => {
    if (method === "getWebhookInfo") return { url: "" };
    if (method === "getUpdates")
      return body.offset === -1 ? [message(10, "/run 1 Old backlog")] : updates;
    if (failSend) {
      failSend = false;
      throw Error("Simulated lost send acknowledgement");
    }
    sent.push(body);
    return { message_id: sent.length };
  };
  return {
    api,
    sent,
    setUpdates(value: any[]) {
      updates = value;
    },
    failNextSend() {
      failSend = true;
    },
  };
}
describe.skipIf(process.platform !== "linux")("private Telegram bridge", () => {
  it("encrypts imported configuration and refuses public-readable input", async () => {
    const fixture = await setup();
    try {
      const file = path.join(fixture.base, "bot.json");
      await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
      await telegramConfig(fixture.runtime.store.root, file);
      const stored = await fs.readFile(
        path.join(fixture.runtime.store.root, "telegram-config.vault"),
      );
      expect(stored.toString()).not.toContain(config.token);
      expect((await telegramConfig(fixture.runtime.store.root))?.userId).toBe(
        config.userId,
      );
      await fs.chmod(file, 0o644);
      await expect(
        telegramConfig(fixture.runtime.store.root, file),
      ).rejects.toThrow("0600");
    } finally {
      await fixture.close();
    }
  });
  it("discards initial backlog and rejects groups, spoofed senders, bots and forwarded commands", async () => {
    const f = await setup(),
      t = transport();
    try {
      const bridge = await TelegramBridge.open(
        f.runtime,
        config,
        [f.workspace],
        t.api,
      );
      await bridge.initialize();
      expect(f.runtime.store.data.jobs).toHaveLength(0);
      t.setUpdates([
        message(11, "/run 1 Wrong sender", { from: { id: 999999 } }),
        message(12, "/run 1 Group", { chat: { id: 123456789, type: "group" } }),
        message(13, "/run 1 Wrong chat", {
          chat: { id: 999999, type: "private" },
        }),
        message(14, "/run 1 Bot", { from: { id: 123456789, is_bot: true } }),
        message(15, "/run 1 Forwarded", { forward_origin: { type: "user" } }),
        message(16, "/run 1 Authorized task"),
      ]);
      await bridge.pollOnce();
      expect(f.runtime.store.data.jobs).toHaveLength(1);
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0].chat_id).toBe(config.userId);
      const again = await TelegramBridge.open(
        f.runtime,
        config,
        [f.workspace],
        t.api,
      );
      await again.pollOnce();
      expect(f.runtime.store.data.jobs).toHaveLength(1);
      expect(t.sent).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it("replays a persisted reply outbox without redelivering its follow-up", async () => {
    const f = await setup(),
      t = transport();
    try {
      let bridge = await TelegramBridge.open(
        f.runtime,
        config,
        [f.workspace],
        t.api,
      );
      await bridge.initialize();
      t.setUpdates([message(11, "/run 1 First task")]);
      await bridge.pollOnce();
      const job = f.runtime.store.data.jobs[0];
      t.setUpdates([message(12, `/send ${job.id} Exactly once`)]);
      t.failNextSend();
      await expect(bridge.pollOnce()).rejects.toThrow("Simulated");
      expect(job.queuedMessages).toHaveLength(1);
      bridge = await TelegramBridge.open(
        f.runtime,
        config,
        [f.workspace],
        t.api,
      );
      await bridge.pollOnce();
      expect(job.queuedMessages).toHaveLength(1);
      expect(job.messageReceipts).toHaveLength(1);
      expect(t.sent.at(-1).text).toContain("Follow-up accepted");
    } finally {
      await f.close();
    }
  });
  it("deduplicates a created task when the Telegram checkpoint fails after admission", async () => {
    const f = await setup(),
      t = transport();
    let fail = true;
    try {
      const bridge = await TelegramBridge.open(
        f.runtime,
        config,
        [f.workspace],
        t.api,
        async (file, value) => {
          if (JSON.parse(String(value)).pending && fail) {
            fail = false;
            throw Error("disk full");
          }
          await atomicWrite(file, value);
        },
      );
      await bridge.initialize();
      t.setUpdates([message(11, "/run 1 One task despite retry")]);
      await expect(bridge.pollOnce()).rejects.toThrow("disk full");
      await bridge.pollOnce();
      expect(f.runtime.store.data.jobs).toHaveLength(1);
      expect(t.sent).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it("binds approval codes to current parameters and expiry before sending an explicit response", async () => {
    const f = await setup(),
      t = transport();
    let now = 1000;
    try {
      const bridge = await TelegramBridge.open(
        f.runtime,
        config,
        [f.workspace],
        t.api,
        atomicWrite,
        () => now,
      );
      await bridge.initialize();
      t.setUpdates([message(11, "/run 1 Task")]);
      await bridge.pollOnce();
      const job = f.runtime.store.data.jobs[0];
      job.turnId = "turn-one";
      const approval: any = {
        id: "1",
        jobId: job.id,
        kind: "command",
        method: "item/commandExecution/requestApproval",
        params: { command: "git status" },
      };
      f.runtime.scheduler.approvals.push(approval);
      const original = f.runtime.command.bind(f.runtime),
        responses: any[] = [];
      vi.spyOn(f.runtime, "command").mockImplementation(async (name, args) => {
        if (name === "approval.respond") {
          responses.push(args);
          return;
        }
        return original(name, args);
      });
      const code = () => t.sent.at(-1).text.match(/Code: ([a-f0-9]+)/)[1];
      t.setUpdates([message(12, "/approvals")]);
      await bridge.pollOnce();
      let nonce = code();
      approval.params.command = "changed command";
      t.setUpdates([message(13, `/approve ${nonce}`)]);
      await bridge.pollOnce();
      expect(responses).toHaveLength(0);
      expect(t.sent.at(-1).text).toContain("Approval changed");
      t.setUpdates([message(14, "/approvals")]);
      await bridge.pollOnce();
      nonce = code();
      now += 300001;
      t.setUpdates([message(15, `/approve ${nonce}`)]);
      await bridge.pollOnce();
      expect(responses).toHaveLength(0);
      t.setUpdates([message(16, "/approvals")]);
      await bridge.pollOnce();
      nonce = code();
      t.setUpdates([message(17, `/approve ${nonce}`)]);
      await bridge.pollOnce();
      await bridge.pollOnce();
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        jobId: job.id,
        id: "1",
        value: { decision: "accept" },
      });
    } finally {
      await f.close();
    }
  });
  it("notifies terminal transitions once across restart and does not take over an existing webhook", async () => {
    const f = await setup(),
      t = transport();
    try {
      let bridge = await TelegramBridge.open(
        f.runtime,
        { ...config, notify: true },
        [f.workspace],
        t.api,
      );
      await bridge.initialize();
      t.setUpdates([message(11, "/run 1 Notification task")]);
      await bridge.pollOnce();
      t.setUpdates([]);
      f.runtime.store.data.jobs[0].state = "completed";
      await bridge.pollOnce();
      const count = t.sent.length;
      expect(t.sent.at(-1).text).toContain("completed");
      bridge = await TelegramBridge.open(
        f.runtime,
        { ...config, notify: true },
        [f.workspace],
        t.api,
      );
      await bridge.pollOnce();
      expect(t.sent).toHaveLength(count);
      await fs.rm(path.join(f.runtime.store.root, "telegram-state.json"));
      const blocked = await TelegramBridge.open(
        f.runtime,
        config,
        [f.workspace],
        async (method) =>
          method === "getWebhookInfo"
            ? { url: "https://existing.example" }
            : [],
      );
      await expect(blocked.initialize()).rejects.toThrow("webhook");
    } finally {
      await f.close();
    }
  });
});
