import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import {
  Chats,
  jsonLines,
  protocolItem,
  rolloutRecords,
} from "../src/core/chat";
import { History } from "../src/core/history";
let root: string, store: Store, chats: Chats, history: History, source: string;
it("renders native Goal context as lifecycle history without rewriting quoted user or assistant text", async () => {
  const text =
    '<codex_internal_context source="user_goal"> User set the goal: "Ship with evidence." </codex_internal_context>';
  expect(
    protocolItem({ type: "userMessage", content: [{ text }] }, "goal"),
  ).toMatchObject({ role: "system", kind: "goal", text: "会话目标已更新" });
  expect(
    protocolItem(
      {
        type: "userMessage",
        content: [{ text: `Please explain this: ${text}` }],
      },
      "quoted",
    ).role,
  ).toBe("user");
  const file = path.join(root, "goal.jsonl");
  await fs.writeFile(
    file,
    ["user", "assistant"]
      .map((role) =>
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role, content: [{ text }] },
        }),
      )
      .join("\n") + "\n",
  );
  const rows = [];
  for await (const row of rolloutRecords(file)) rows.push(row);
  expect(rows[0]).toMatchObject({ role: "system", kind: "goal" });
  expect(rows[1]).toMatchObject({ role: "assistant", text });
  await chats.user("literal", text);
  expect((await chats.read("literal")).items[0]).toMatchObject({
    role: "user",
    text,
  });
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-chat-"));
  source = path.join(root, "source");
  store = new Store(path.join(root, "app"));
  chats = new Chats(store.root);
  history = new History(store, chats);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture(index = 0, extra = {}) {
  const id = randomUUID(),
    dir = path.join(
      source,
      index % 2 ? "archived_sessions" : "sessions",
      "2026",
      "10",
    );
  await fs.mkdir(dir, { recursive: true });
  const rows = [
    {
      type: "session_meta",
      payload: {
        id,
        cwd: root,
        source: index % 2 ? "vscode" : "cli",
        ...extra,
      },
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: `任务 ${index}` },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `问题 ${index}` }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "中文回答 ✓" }],
      },
    },
  ];
  const file = path.join(dir, `rollout-${id}.jsonl`);
  await fs.writeFile(
    file,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return { id, file };
}
it("scans beyond the old 60-session limit including archived records; imports once without touching sources", async () => {
  const fixtures = await Promise.all(
    Array.from({ length: 65 }, (_, i) => fixture(i)),
  );
  const before = await fs.readFile(fixtures[0].file);
  const scan = await history.scan([source]);
  expect(scan.entries).toHaveLength(65);
  expect(scan.entries.some((e) => e.archived)).toBe(true);
  const result = await history.import();
  expect(result.imported).toHaveLength(65);
  expect(result.errors).toEqual([]);
  expect((await history.import()).skipped).toHaveLength(65);
  expect(await fs.readFile(fixtures[0].file)).toEqual(before);
  for (const job of store.data.jobs) {
    expect(job.threadId).not.toBe(job.historySource!.threadId);
    expect(job.state).toBe("completed");
    expect((await chats.read(job.id)).items.map((i) => i.role)).toEqual([
      "user",
      "assistant",
    ]);
    const rows = [];
    for await (const r of jsonLines(job.importedRollout!)) rows.push(r);
    expect(rows[0].payload.id).toBe(job.threadId);
  }
  const loaded = new Store(store.root);
  await loaded.load();
  expect(loaded.data.jobs).toHaveLength(65);
}, 20000);
it("imports active partial tails and Desktop-only records as readable, explicitly incompatible copies", async () => {
  const { file } = await fixture(1, {
    dynamic_tools: [{ name: "private_app_tool" }],
  });
  await fs.appendFile(file, '{"type":"event_msg","payload":');
  const before = await fs.readFile(file);
  const scan = await history.scan([source]);
  expect(scan.entries).toHaveLength(1);
  expect(scan.entries[0].issue).toContain("Desktop");
  const r = await history.import();
  expect(r.errors).toEqual([]);
  expect((await chats.read(r.imported[0])).items).toHaveLength(2);
  expect(await fs.readFile(file)).toEqual(before);
});
it("restores the last model and reasoning effort from imported turn contexts", async () => {
  const { file } = await fixture();
  await fs.appendFile(
    file,
    [
      {
        type: "turn_context",
        payload: { model: "gpt-6.1-sol", effort: "low" },
      },
      {
        type: "turn_context",
        payload: { model: "gpt-6-astra", effort: "high" },
      },
    ]
      .map((row) => JSON.stringify(row) + "\n")
      .join(""),
  );
  await history.scan([source]);
  const result = await history.import();
  expect(result.errors).toEqual([]);
  expect(store.data.jobs[0]).toMatchObject({
    model: "gpt-6-astra",
    effort: "high",
  });
});
it("streams an assistant response and persists its complete form exactly once across reopening", async () => {
  const id = randomUUID(),
    params = { turnId: "t", itemId: "m" };
  await chats.user(id, "你好");
  await chats.event(id, "item/started", {
    turnId: "t",
    item: { id: "m", type: "agentMessage", text: "" },
  });
  await chats.event(id, "item/agentMessage/delta", {
    ...params,
    delta: "你好，",
  });
  expect((await chats.read(id)).items.at(-1)?.text).toBe("你好，");
  const done = chats.event(id, "item/completed", {
    turnId: "t",
    item: { id: "m", type: "agentMessage", text: "你好，世界！" },
  });
  await chats.flush(id);
  await done;
  const reopened = new Chats(store.root);
  const p = await reopened.read(id);
  expect(p.items).toHaveLength(2);
  expect(p.items[1].text).toBe("你好，世界！");
  expect(p.items[1].status).toBe("completed");
});
it("paginates old messages without log truncation and repairs only an incomplete journal tail", async () => {
  const id = randomUUID();
  for (let i = 0; i < 170; i++) await chats.user(id, String(i));
  const latest = await chats.read(id);
  expect(latest.items).toHaveLength(80);
  expect(latest.before).toBe(90);
  const older = await chats.read(id, latest.before);
  expect(older.items[0].text).toBe("10");
  await fs.appendFile(chats.file(id), '{"broken":');
  const reopened = new Chats(store.root);
  await reopened.user(id, "after crash");
  expect((await reopened.read(id)).total).toBe(171);
  expect((await reopened.read(id)).items.at(-1)?.text).toBe("after crash");
});
it("merges live updates, completed replacements and external journal edits without moving old items", async () => {
  const id = randomUUID();
  await chats.user(id, "first");
  await chats.event(id, "turn/plan/updated", {
    turnId: "t",
    explanation: "Plan",
    plan: [{ step: "A", status: "pending" }],
  });
  await chats.read(id);
  await chats.user(id, "second");
  await chats.event(id, "turn/plan/updated", {
    turnId: "t",
    explanation: "Plan",
    plan: [{ step: "A", status: "completed" }],
  });
  await chats.event(id, "item/started", {
    turnId: "t",
    item: { id: "live", type: "agentMessage", text: "Streaming" },
  });
  let page = await chats.read(id);
  expect(page.total).toBe(4);
  expect(page.items.map((i) => i.text)).toEqual([
    "first",
    "Plan",
    "second",
    "Streaming",
  ]);
  expect(page.items[1].detail).toContain("completed");
  await chats.event(id, "item/completed", {
    turnId: "t",
    item: { id: "live", type: "agentMessage", text: "Finished" },
  });
  page = await chats.read(id);
  expect(page.total).toBe(4);
  expect(page.items.at(-1)?.text).toBe("Finished");
  await fs.appendFile(
    chats.file(id),
    JSON.stringify({
      id: "external",
      role: "user",
      kind: "message",
      text: "external edit",
      at: 1,
    }) + "\n",
  );
  await chats.user(id, "after external edit");
  page = await chats.read(id);
  expect(page.total).toBe(6);
  expect(page.items.slice(-2).map((i) => i.text)).toEqual([
    "external edit",
    "after external edit",
  ]);
  expect((await new Chats(store.root).read(id)).items).toEqual(page.items);
});
