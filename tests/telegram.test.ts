import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, vi } from "vitest";
import { ServerRuntime } from "../src/server/runtime";
import {
  TelegramBridge,
  telegramApi,
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
  const acknowledgements: any[] = [];
  let failSend = false;
  const api: TelegramApi = async (method, body) => {
    if (method === "getWebhookInfo") return { url: "" };
    if (method === "getUpdates")
      return body.offset === -1 ? [message(10, "/run 1 Old backlog")] : updates;
    if (method === "answerCallbackQuery") {
      acknowledgements.push(body);
      return true;
    }
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
    acknowledgements,
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

const callback = (update_id: number, data: string, patch: any = {}) => ({
  update_id,
  callback_query: {
    id: `callback-${update_id}`,
    data,
    from: { id: 123456789, is_bot: false },
    message: { message_id: 1, chat: { id: 123456789, type: "private" } },
    ...patch,
  },
});
const buttons = (reply: any): { text: string; callback_data: string }[] =>
  reply.reply_markup?.inline_keyboard.flat() || [];
async function consoleFixture(write = atomicWrite, now = Date.now) {
  const f = await setup(),
    t = transport();
  let bridge = await TelegramBridge.open(
      f.runtime,
      config,
      [f.workspace],
      t.api,
      write,
      now,
    ),
    id = 10;
  await bridge.initialize();
  return {
    ...f,
    t,
    get bridge() {
      return bridge;
    },
    async send(text: string, patch: any = {}) {
      t.setUpdates([message(++id, text, patch)]);
      await bridge.pollOnce();
      return t.sent.at(-1);
    },
    async click(data: string, patch: any = {}) {
      t.setUpdates([callback(++id, data, patch)]);
      await bridge.pollOnce();
      return t.sent.at(-1);
    },
    async restart() {
      bridge = await TelegramBridge.open(
        f.runtime,
        config,
        [f.workspace],
        t.api,
        write,
        now,
      );
    },
  };
}
describe.skipIf(process.platform !== "linux")("Telegram mobile console", () => {
  it("selects projects, persists defaults and routes ordinary text and replies to the correct task", async () => {
    const f = await consoleFixture();
    try {
      expect((await f.send("no selection")).text).toContain("先 /project");
      const projects = await f.send("/projects@RelayBot");
      await f.click(buttons(projects)[0].callback_data);
      await f.send("/model example-model");
      await f.send("/effort high");
      await f.send("/plan on");
      await f.send("/new First task");
      const first = f.runtime.store.data.jobs[0],
        firstCard = f.t.sent.length;
      expect(first).toMatchObject({
        model: "example-model",
        effort: "high",
        planMode: true,
      });
      await f.send("/new Second task");
      const second = f.runtime.store.data.jobs[1];
      await f.restart();
      await f.send("For second");
      await f.send("For first", {
        reply_to_message: { message_id: firstCard },
      });
      expect(second.queuedMessages?.map((m) => m.text)).toEqual(["For second"]);
      expect(first.queuedMessages?.map((m) => m.text)).toEqual(["For first"]);
      expect(
        (
          await f.send("Unknown reply", {
            reply_to_message: { message_id: 99999 },
          })
        ).text,
      ).toContain("未关联任务");
      expect(second.queuedMessages).toHaveLength(1);
      await f.send("/project 1");
      expect((await f.send("No accidental task")).text).toContain(
        "先 /project",
      );
      expect(f.runtime.store.data.jobs).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
  it("freezes creation inputs and follow-up destinations before side effects across checkpoint failures", async () => {
    let fail = false;
    const f = await consoleFixture(async (file, value) => {
      if (fail && JSON.parse(String(value)).pending) {
        fail = false;
        throw Error("checkpoint lost");
      }
      await atomicWrite(file, value);
    });
    try {
      await f.send("/project 1");
      fail = true;
      await expect(f.send("/new Durable task")).rejects.toThrow(
        "checkpoint lost",
      );
      await f.restart();
      await f.bridge.pollOnce();
      expect(f.runtime.store.data.jobs).toHaveLength(1);
      const first = f.runtime.store.data.jobs[0];
      fail = true;
      await expect(f.send("Frozen follow-up")).rejects.toThrow(
        "checkpoint lost",
      );
      // Simulate an independent task-selection update before replaying the admitted update.
      const stateFile = path.join(f.runtime.store.root, "telegram-state.json");
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      state.context.task = "00000000-0000-4000-8000-000000000000";
      await atomicWrite(stateFile, JSON.stringify(state));
      await f.restart();
      await f.bridge.pollOnce();
      expect(first.queuedMessages?.map((m) => m.text)).toEqual([
        "Frozen follow-up",
      ]);
      expect(first.messageReceipts).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it("rejects unauthorized callbacks, acknowledges valid callbacks and ignores stale control buttons", async () => {
    const f = await consoleFixture();
    try {
      await f.send("/run 1 Task");
      const job = f.runtime.store.data.jobs[0];
      const count = f.t.sent.length;
      await f.click(`/control pause ${job.id}`, { from: { id: 99999 } });
      await f.click(`/control pause ${job.id}`, {
        message: { chat: { id: 123456789, type: "group" } },
      });
      expect(f.t.sent).toHaveLength(count);
      expect(f.t.acknowledgements).toHaveLength(0);
      const prompt = await f.click(`/control pause ${job.id}`),
        confirm = buttons(prompt)[0].callback_data;
      expect(f.t.acknowledgements).toHaveLength(1);
      expect(job.state).toBe("queued");
      job.updatedAt += 10;
      expect((await f.click(confirm)).text).toContain("已变化");
      expect(job.state).toBe("queued");
      const next = await f.click(`/control pause ${job.id}`),
        action = buttons(next)[0].callback_data;
      await f.click(action);
      expect(job.state).toBe("paused");
      expect((await f.click(action)).text).toContain("已过期");
      const resume = await f.click(`/control resume ${job.id}`);
      await f.restart();
      expect((await f.click(buttons(resume)[0].callback_data)).text).toContain(
        "已过期",
      );
      expect(job.state).toBe("paused");
    } finally {
      await f.close();
    }
  });
  it("paginates task lists, immutable long results and redacts credentials before splitting", async () => {
    let now = 1000;
    const f = await consoleFixture(atomicWrite, () => now);
    try {
      for (let i = 0; i < 10; i++) await f.send(`/run 1 Task ${i}`);
      const list = await f.send("/status");
      expect(list.text).toContain("1/2");
      const second = await f.click(
        buttons(list).find((b) => b.text === "下一页")!.callback_data,
      );
      expect(second.text).toContain("2/2");
      const job = f.runtime.store.data.jobs[0];
      const secret = "sk-" + "Z".repeat(30),
        text = "x".repeat(2940) + "\n" + secret + "😀".repeat(2000) + "END";
      await f.runtime.scheduler.chats.append(job.id, {
        id: "reply",
        role: "assistant",
        kind: "message",
        text,
        at: 1000,
      });
      const first = await f.send(`/result ${job.id}`);
      const next = buttons(first).find(
        (b) => b.text === "下一页",
      )!.callback_data;
      expect(first.text).not.toContain(secret);
      await f.runtime.scheduler.chats.append(job.id, {
        id: "newer",
        role: "assistant",
        kind: "message",
        text: "NEW RESULT",
        at: 2000,
      });
      const page = await f.click(next);
      expect(page.text).not.toContain("NEW RESULT");
      expect(page.text).toContain("😀");
      for (const reply of f.t.sent) {
        expect(reply.text.length).toBeLessThanOrEqual(3500);
        for (const b of buttons(reply))
          expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
      }
      now += 20 * 60 * 1000 + 1;
      expect((await f.click(next)).text).toContain("过期");
    } finally {
      await f.close();
    }
  });
  it("exports durable redacted documents and replays the same snapshot after a send failure", async () => {
    const f = await consoleFixture();
    try {
      await f.send("/run 1 Export me");
      const job = f.runtime.store.data.jobs[0];
      await f.runtime.scheduler.chats.append(job.id, {
        id: "answer",
        role: "assistant",
        kind: "message",
        text: `OLD snapshot\napi_key: hidden-key\n${config.token}`,
        at: 1000,
      });
      f.t.failNextSend();
      await expect(f.send("/export")).rejects.toThrow("Simulated");
      await f.runtime.scheduler.chats.append(job.id, {
        id: "answer2",
        role: "assistant",
        kind: "message",
        text: "NEW snapshot",
        at: 2000,
      });
      await f.restart();
      await f.bridge.pollOnce();
      const doc = f.t.sent.at(-1).document;
      expect(doc.name).toBe(`conversation-${job.id}.md`);
      expect(doc.text).toContain("OLD snapshot");
      expect(doc.text).not.toContain("NEW snapshot");
      expect(doc.text).not.toContain("hidden-key");
      expect(doc.text).not.toContain(config.token);
      expect((await f.send("/report")).document.name).toBe(
        `report-${job.id}.json`,
      );
    } finally {
      await f.close();
    }
  });
  it("manages the real queue with revision checks and prevents repeat button execution", async () => {
    const f = await consoleFixture();
    try {
      await f.send("/run 1 Queue task");
      const job = f.runtime.store.data.jobs[0];
      await f.send("first");
      await f.send("second");
      await f.send("third");
      const queue = await f.send("/queue"),
        down = buttons(queue).find((b) => b.text === "↓ 1")!.callback_data;
      await f.click(down);
      expect(job.queuedMessages?.map((m) => m.text)).toEqual([
        "second",
        "first",
        "third",
      ]);
      await f.click(down);
      expect(job.queuedMessages?.map((m) => m.text)).toEqual([
        "second",
        "first",
        "third",
      ]);
      const item = job.queuedMessages![0],
        revision = job.queueRevision!;
      await f.send(`/edit ${item.id} ${revision} edited`);
      expect(job.queuedMessages![0].text).toBe("edited");
      expect((await f.send(`/remove ${item.id} ${revision}`)).text).toContain(
        "队列已变化",
      );
      await f.send(`/remove ${item.id} ${job.queueRevision}`);
      expect(job.queuedMessages?.map((m) => m.text)).toEqual([
        "first",
        "third",
      ]);
      expect((await f.send("/queueall")).text).toContain("third");
    } finally {
      await f.close();
    }
  });
  it("creates atomic dependent workflows, uses template defaults and controls project scheduling", async () => {
    const f = await consoleFixture();
    try {
      await f.send("/project 1");
      const template: any = await f.runtime.command("templates.save", {
        revision: 0,
        template: {
          name: "Careful",
          prompt: "Verify before changing",
          model: "example",
          effort: "high",
          planMode: false,
          multiAgent: false,
        },
      });
      await f.send(`/template ${template.items[0].id}`);
      expect((await f.send("/templates")).text).toContain("Careful");
      const created = await f.send(
        "/workflow Mobile delivery\nInvestigate\n---\nImplement\n---\nVerify",
      );
      expect(created.text).toContain("工作流已创建");
      const jobs = f.runtime.store.data.jobs;
      expect(jobs).toHaveLength(3);
      expect(jobs[1].dependsOn).toEqual([jobs[0].id]);
      expect(jobs[2].dependsOn).toEqual([jobs[1].id]);
      expect(jobs[0].prompt).toBe("Verify before changing\n\nInvestigate");
      await f.bridge.pollOnce();
      expect(jobs).toHaveLength(3);
      const report = await f.send(`/handoff ${jobs[0].workflow!.id}`);
      expect(report.document.text).toContain("Mobile delivery");
      expect(report.document.text).toContain("Complete: no");
      await f.send("/limit 2");
      expect(f.runtime.store.data.projectLimits?.[0].limit).toBe(2);
      await f.send("/dispatch pause project");
      expect(f.runtime.store.data.dispatch?.projects).toContain(f.workspace);
      await f.send("/priority high");
      expect(jobs[0].priority).toBe("high");
      await f.send("/rename Phone investigation");
      await f.send("/pin on");
      expect(jobs[0]).toMatchObject({
        title: "Phone investigation",
        pinned: true,
      });
      expect((await f.send("/health")).text).toContain('"total": 3');
    } finally {
      await f.close();
    }
  });
  it("answers all questions using buttons and free text, rejects stale choices and keeps answer mode safe after restart", async () => {
    const f = await consoleFixture();
    try {
      await f.send("/run 1 Questions");
      const job = f.runtime.store.data.jobs[0];
      const approval: any = {
        id: "question",
        historyId: "history-one",
        jobId: job.id,
        kind: "input",
        method: "item/tool/requestUserInput",
        params: {
          questions: [
            {
              id: "platform",
              header: "Platform",
              question: "Which OS?",
              options: [
                { label: "Linux", description: "Server" },
                { label: "Windows", description: "Desktop" },
              ],
            },
            {
              id: "notes",
              header: "Notes",
              question: "Any details?",
              isOther: true,
            },
          ],
        },
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
      const listing = await f.send("/approvals"),
        start = buttons(listing).find(
          (b) => b.text === "逐题回答",
        )!.callback_data;
      const question = await f.click(start),
        choice = buttons(question)[0].callback_data;
      expect((await f.click(choice)).text).toContain("2/2");
      expect((await f.click(choice)).text).toContain("已变化");
      await f.send("Keep it reliable");
      expect(responses).toHaveLength(1);
      expect(responses[0].value).toEqual({
        answers: {
          platform: { answers: ["Linux"] },
          notes: { answers: ["Keep it reliable"] },
        },
      });
      expect(job.queuedMessages || []).toHaveLength(0);
      const fresh = await f.send("/approvals");
      await f.click(buttons(fresh)[0].callback_data);
      await f.restart();
      expect(
        (await f.send("This must not be sent to the task")).text,
      ).toContain("expired");
      expect(job.queuedMessages || []).toHaveLength(0);
      await f.send("/dismiss");
      await f.send("Normal follow-up");
      expect(job.queuedMessages?.[0].text).toBe("Normal follow-up");
    } finally {
      await f.close();
    }
  });
  it("does not offer approval for oversized requests and paginates pending requests", async () => {
    const f = await consoleFixture();
    try {
      await f.send("/run 1 Approvals");
      const job = f.runtime.store.data.jobs[0];
      f.runtime.scheduler.approvals.push(
        ...Array.from({ length: 12 }, (_, i): any => ({
          id: String(i),
          jobId: job.id,
          kind: "command",
          method: "requestApproval",
          params: { command: i === 0 ? "x".repeat(3000) : "git status" },
        })),
      );
      const first = await f.send("/approvals");
      expect(first.text).toContain("1/12");
      expect(
        buttons(first).some((b) => b.callback_data.startsWith("/approve ")),
      ).toBe(false);
      const last = await f.send("/approvals 12");
      expect(last.text).toContain("12/12");
      expect(
        buttons(last).some((b) => b.callback_data.startsWith("/approve ")),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("responds to unsupported media instead of silently dropping it", async () => {
    const f = await consoleFixture();
    try {
      expect(
        (await f.send("", { text: undefined, voice: { file_id: "voice" } }))
          .text,
      ).toContain("语音和二进制附件");
      expect(f.runtime.store.data.jobs).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});

it("uploads documents with multipart encoding without putting the bot token in an error", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
      status: 200,
    }),
  );
  try {
    const api = telegramApi(config.token);
    const result = await api(
      "sendDocument",
      {
        chat_id: config.userId,
        document: { name: "result.md", text: "完整内容" },
        caption: "Results",
      },
      new AbortController().signal,
    );
    expect(result.message_id).toBe(42);
    const options = fetchMock.mock.calls[0][1]!;
    expect(options.body).toBeInstanceOf(FormData);
    const form = options.body as FormData;
    expect(await (form.get("document") as File).text()).toBe("完整内容");
    expect((form.get("document") as File).name).toBe("result.md");
    expect(options.headers).toBeUndefined();
    fetchMock.mockRejectedValueOnce(Error(`Failed: ${config.token}`));
    await expect(
      api("getUpdates", {}, new AbortController().signal),
    ).rejects.toThrow("connection unavailable");
  } finally {
    fetchMock.mockRestore();
  }
});

describe.skipIf(process.platform !== "linux")(
  "Telegram recovery boundaries",
  () => {
    it("admits no work before the resolved incoming route is durable", async () => {
      let fail = false;
      const f = await consoleFixture(async (file, value) => {
        if (fail && JSON.parse(String(value)).incoming)
          throw Error("admission disk full");
        await atomicWrite(file, value);
      });
      try {
        await f.send("/project 1");
        fail = true;
        await expect(f.send("/new Never admitted")).rejects.toThrow(
          "admission disk full",
        );
        expect(f.runtime.store.data.jobs).toHaveLength(0);
        fail = false;
        await f.bridge.pollOnce();
        expect(f.runtime.store.data.jobs).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
    it("deduplicates a whole workflow after a checkpoint failure and restores the original model inputs", async () => {
      let fail = false;
      const f = await consoleFixture(async (file, value) => {
        if (fail && JSON.parse(String(value)).pending) {
          fail = false;
          throw Error("lost workflow checkpoint");
        }
        await atomicWrite(file, value);
      });
      try {
        await f.send("/project 1");
        await f.send("/model model-before");
        fail = true;
        await expect(
          f.send("/workflow Durable workflow\nPlan\n---\nBuild"),
        ).rejects.toThrow("lost workflow checkpoint");
        const file = path.join(f.runtime.store.root, "telegram-state.json"),
          state = JSON.parse(await fs.readFile(file, "utf8"));
        state.context.defaults.model = "model-after";
        await atomicWrite(file, JSON.stringify(state));
        await f.restart();
        await f.bridge.pollOnce();
        expect(f.runtime.store.data.jobs).toHaveLength(2);
        expect(
          f.runtime.store.data.jobs.every((j) => j.model === "model-before"),
        ).toBe(true);
        expect(f.t.sent.at(-1).text).toContain("工作流已创建");
      } finally {
        await f.close();
      }
    });
    it("delivers every terminal notification in bounded batches and routes replies to notification cards", async () => {
      const f = await consoleFixture();
      try {
        for (let i = 0; i < 12; i++) await f.send(`/run 1 Notification ${i}`);
        f.t.setUpdates([]);
        const bridge = await TelegramBridge.open(
          f.runtime,
          { ...config, notify: true },
          [f.workspace],
          f.t.api,
        );
        await bridge.pollOnce();
        for (const job of f.runtime.store.data.jobs) {
          job.state = "completed";
          await f.runtime.scheduler.chats.append(job.id, {
            id: "result",
            role: "assistant",
            kind: "message",
            text: "RESULT api_key: hidden-notification-key",
            at: 1000,
          });
        }
        const before = f.t.sent.length;
        await bridge.pollOnce();
        expect(f.t.sent.length - before).toBe(5);
        await bridge.pollOnce();
        expect(f.t.sent.length - before).toBe(10);
        await bridge.pollOnce();
        expect(f.t.sent.length - before).toBe(12);
        await bridge.pollOnce();
        expect(f.t.sent.length - before).toBe(12);
        const notices = f.t.sent.slice(before);
        expect(
          new Set(notices.map((n) => n.text.split("\n")[1].slice(0, 8))).size,
        ).toBe(12);
        expect(
          notices.every(
            (n) =>
              n.text.includes("RESULT") &&
              !n.text.includes("hidden-notification-key"),
          ),
        ).toBe(true);
        const state = JSON.parse(
          await fs.readFile(
            path.join(f.runtime.store.root, "telegram-state.json"),
            "utf8",
          ),
        );
        expect(Object.values(state.routes)).toHaveLength(24);
        const again = await TelegramBridge.open(
          f.runtime,
          { ...config, notify: true },
          [f.workspace],
          f.t.api,
        );
        await again.pollOnce();
        expect(f.t.sent.length - before).toBe(12);
      } finally {
        await f.close();
      }
    });
  },
);

describe.skipIf(process.platform !== "linux")(
  "Telegram context checkpoints",
  () => {
    it("retries admission when saving the new task selection fails after scheduler acceptance", async () => {
      let fail = false;
      const f = await consoleFixture(async (file, value) => {
        const state = JSON.parse(String(value));
        if (fail && state.incoming && state.context?.task) {
          fail = false;
          throw Error("selection checkpoint failed");
        }
        await atomicWrite(file, value);
      });
      try {
        await f.send("/project 1");
        fail = true;
        await expect(
          f.send("/new Created before selection write"),
        ).rejects.toThrow("selection checkpoint failed");
        expect(f.runtime.store.data.jobs).toHaveLength(1);
        await f.restart();
        await f.bridge.pollOnce();
        expect(f.runtime.store.data.jobs).toHaveLength(1);
        expect(f.t.sent.at(-1).text).toContain("Queued");
        await f.send("Follow the restored selection");
        expect(f.runtime.store.data.jobs[0].queuedMessages?.[0].text).toBe(
          "Follow the restored selection",
        );
      } finally {
        await f.close();
      }
    });
    it("lets the owner select projects beyond the first keyboard page", async () => {
      const f = await setup(),
        t = transport();
      try {
        const roots = Array.from({ length: 27 }, (_, i) =>
          path.join(f.base, `project-${i}`),
        );
        await Promise.all(roots.map((root) => fs.mkdir(root)));
        const bridge = await TelegramBridge.open(
          f.runtime,
          config,
          roots,
          t.api,
        );
        await bridge.initialize();
        t.setUpdates([message(11, "/projects")]);
        await bridge.pollOnce();
        expect(t.sent.at(-1).text).toContain("1/3");
        const next = buttons(t.sent.at(-1)).find(
          (b) => b.text === "下一页",
        )!.callback_data;
        t.setUpdates([callback(12, next)]);
        await bridge.pollOnce();
        expect(t.sent.at(-1).text).toContain("2/3");
        t.setUpdates([callback(13, "/projects 3")]);
        await bridge.pollOnce();
        expect(
          buttons(t.sent.at(-1)).some((b) => b.callback_data === "/project 27"),
        ).toBe(true);
        t.setUpdates([
          callback(14, "/project 27"),
          message(15, "/new Last project task"),
        ]);
        await bridge.pollOnce();
        expect(f.runtime.store.data.jobs[0].cwd).toBe(roots[26]);
      } finally {
        await f.close();
      }
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "freezes /run workspace numbers before a restart with reordered roots",
  async () => {
    let fail = false;
    const f = await consoleFixture(async (file, value) => {
      if (fail && JSON.parse(String(value)).pending) {
        fail = false;
        throw Error("root checkpoint lost");
      }
      await atomicWrite(file, value);
    });
    try {
      fail = true;
      await expect(f.send("/run 1 Original project")).rejects.toThrow(
        "root checkpoint lost",
      );
      const second = path.join(f.base, "second-project");
      await fs.mkdir(second);
      const bridge = await TelegramBridge.open(
        f.runtime,
        config,
        [second, f.workspace],
        f.t.api,
      );
      await bridge.pollOnce();
      expect(f.runtime.store.data.jobs).toHaveLength(1);
      expect(f.runtime.store.data.jobs[0].cwd).toBe(f.workspace);
      expect(f.t.sent.at(-1).text).toContain("Queued");
    } finally {
      await f.close();
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "persists incoming documents and attaches them once to the next task across a lost reply",
  async () => {
    const f = await setup(),
      t = transport();
    let downloads = 0;
    const api: TelegramApi = async (method, body, signal) =>
      method === "getFile"
        ? { file_path: "documents/file_1.txt", file_size: 5 }
        : t.api(method, body, signal);
    const download = async () => {
      downloads++;
      return Buffer.from("hello");
    };
    try {
      let bridge = await TelegramBridge.open(
        f.runtime,
        config,
        [f.workspace],
        api,
        atomicWrite,
        Date.now,
        download,
      );
      await bridge.initialize();
      t.setUpdates([
        message(11, "", {
          text: undefined,
          document: {
            file_id: "file-one",
            file_size: 5,
            file_name: "notes.txt",
          },
        }),
      ]);
      t.failNextSend();
      await expect(bridge.pollOnce()).rejects.toThrow("Simulated");
      bridge = await TelegramBridge.open(
        f.runtime,
        config,
        [f.workspace],
        api,
        atomicWrite,
        Date.now,
        download,
      );
      await bridge.pollOnce();
      expect(downloads).toBe(1);
      t.setUpdates([message(12, "/run 1 Use the document")]);
      await bridge.pollOnce();
      const job = f.runtime.store.data.jobs[0];
      expect(job.attachments).toHaveLength(1);
      expect(await fs.readFile(job.attachments![0].path, "utf8")).toBe("hello");
      t.setUpdates([message(13, "/inbox")]);
      await bridge.pollOnce();
      expect(t.sent.at(-1).text).toContain("暂无附件");
      t.setUpdates([message(14, "follow up")]);
      await bridge.pollOnce();
      expect(job.queuedMessages![0].attachments).toEqual([]);
    } finally {
      await f.close();
    }
  },
);
