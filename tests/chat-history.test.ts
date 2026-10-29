import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
it("retries a failed partial journal append in order after storage returns without poisoning another task",async()=>{
 const id=randomUUID();await chats.user(id,"Original",undefined,"original");
 const append=fs.appendFile.bind(fs);let broken=false;
 vi.spyOn(fs,"appendFile").mockImplementation(async(file,data,options)=>{
  if(String(file)===chats.file(id)&&!broken){broken=true;await append(file,String(data).slice(0,17),options);throw Error("ENOSPC partial append");}
  await append(file,data,options);
 });
 const item:any={id:"retained",role:"assistant",kind:"message",text:"Retained answer",at:1,status:"completed"};
 await expect(chats.append(id,item)).rejects.toThrow("ENOSPC");item.text="Mutated after failure";
 await chats.user("independent","Unaffected");await chats.user(id,"Later",undefined,"later");
 const rows=(await new Chats(store.root).read(id)).items;
 expect(rows.map(row=>row.id)).toEqual(["original","retained","later"]);expect(rows[1].text).toBe("Retained answer");
 expect((await chats.read("independent")).items[0].text).toBe("Unaffected");
});
it("retains a complete protocol answer through a write failure and flush without downgrading its status",async()=>{
 const id=randomUUID(),append=fs.appendFile.bind(fs);let broken=false;
 vi.spyOn(fs,"appendFile").mockImplementation(async(file,data,options)=>{
  if(String(file)===chats.file(id)&&!broken){broken=true;await append(file,String(data).slice(0,11),options);throw Error("temporary write failure");}
  await append(file,data,options);
 });
 await chats.event(id,"item/started",{turnId:"turn",item:{id:"answer",type:"agentMessage",text:""}});
 await chats.event(id,"item/agentMessage/delta",{turnId:"turn",itemId:"answer",delta:"Full "});
 await expect(chats.event(id,"item/completed",{turnId:"turn",item:{id:"answer",type:"agentMessage",text:"Full final answer"}})).rejects.toThrow("temporary");
 await chats.event(id,"turn/plan/updated",{turnId:"turn",explanation:"Later record",plan:[]});await chats.flush(id);
 const rows=(await new Chats(store.root).read(id)).items;expect(rows.map(row=>row.text)).toEqual(["Full final answer","Later record"]);
 expect(rows[0]).toMatchObject({status:"completed",turnId:"turn"});
});
it("deduplicates a fully written record after a lost write acknowledgement",async()=>{
 const id=randomUUID(),append=fs.appendFile.bind(fs);let failed=false;
 vi.spyOn(fs,"appendFile").mockImplementation(async(file,data,options)=>{await append(file,data,options);if(String(file)===chats.file(id)&&!failed){failed=true;throw Error("write acknowledgement lost");}});
 await expect(chats.user(id,"Once",undefined,"stable-id")).rejects.toThrow("acknowledgement");
 await chats.flush(id);const rows=await new Chats(store.root).read(id);expect(rows.total).toBe(1);expect(rows.items[0]).toMatchObject({id:"stable-id",text:"Once"});
});
it("does not reject an earlier committed append when a later queued append fails",async()=>{
 const id=randomUUID(),append=fs.appendFile.bind(fs);let release!:()=>void,entered!:()=>void,failed=false;
 const gate=new Promise<void>(r=>{release=r;}),writing=new Promise<void>(r=>{entered=r;});
 vi.spyOn(fs,"appendFile").mockImplementation(async(file,data,options)=>{
  if(String(file)===chats.file(id)&&String(data).includes('"id":"first"')){entered();await gate;}
  if(String(file)===chats.file(id)&&String(data).includes('"id":"second"')&&!failed){failed=true;throw Error("second unavailable");}
  await append(file,data,options);
 });
 const first=chats.user(id,"First",undefined,"first");await writing;const second=chats.user(id,"Second",undefined,"second");
 const results=Promise.allSettled([first,second]);release();expect((await results).map(r=>r.status)).toEqual(["fulfilled","rejected"]);
 expect((await chats.read(id)).items.map(row=>row.text)).toEqual(["First","Second"]);
});
it("keeps unreadable writes visibly blocked until storage recovers and then repairs them on read",async()=>{
 const id=randomUUID(),append=fs.appendFile.bind(fs);let offline=true;
 vi.spyOn(fs,"appendFile").mockImplementation(async(file,data,options)=>{if(String(file)===chats.file(id)&&offline)throw Error("storage offline");await append(file,data,options);});
 await expect(chats.user(id,"Pending row",undefined,"pending")).rejects.toThrow("offline");
 await expect(chats.read(id)).rejects.toThrow("offline");await expect(chats.flush(id)).rejects.toThrow("offline");
 offline=false;expect((await chats.read(id)).items.map(row=>row.id)).toEqual(["pending"]);await chats.flush(id);
 expect((await new Chats(store.root).read(id)).total).toBe(1);
});
it("retries failed native hydration before later appends and freezes its supplied history",async()=>{
 const id=randomUUID();await chats.user(id,"Local input",undefined,"local");
 const rename=fs.rename.bind(fs);let failed=false;vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{if(String(to)===chats.file(id)&&!failed){failed=true;throw Error("replace interrupted");}await rename(from,to);});
 const native:any[]=[{id:"native",role:"assistant",kind:"message",text:"Native result",at:1}];
 await expect(chats.hydrate(id,native)).rejects.toThrow("replace interrupted");native[0].text="Changed after failed replace";
 await chats.user(id,"Next input",undefined,"next");
 expect((await new Chats(store.root).read(id)).items.map(row=>row.text)).toEqual(["Native result","Local input","Next input"]);
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


it("searches full history beyond the latest page with role filters and stable pagination", async () => {
  for (let i = 0; i < 95; i++) await chats.append("search", { id: String(i), role: i % 2 ? "tool" : "assistant", kind: "message", text: `needle ${i}`, detail: i === 0 ? "hidden diagnostic" : undefined, at: i });
  const first = await chats.search("search", "NEEDLE");
  expect(first.total).toBe(95);
  expect(first.items).toHaveLength(30);
  expect(first.items[0].id).toBe("94");
  const next = await chats.search("search", "needle", first.next);
  expect(next.items[0].id).toBe("64");
  expect((await chats.search("search", "needle", 0, "tool")).total).toBe(47);
  expect((await chats.search("search", "hidden diagnostic")).items[0].id).toBe("0");
});
it("searches updated records once and handles Unicode width without regular expressions", async () => {
  await chats.append("search", { id: "one", role: "user", kind: "message", text: "obsolete", at: 1 });
  await chats.append("search", { id: "one", role: "user", kind: "message", text: "ＡＢＣ 中文 [literal]", at: 1 });
  expect((await chats.search("search", "obsolete")).total).toBe(0);
  expect((await chats.search("search", "abc 中文")).total).toBe(1);
  expect((await chats.search("search", "[literal]")).total).toBe(1);
  expect((await chats.search("search", "  ")).total).toBe(0);
});
it("does not return stale cached search results after the journal is removed", async () => {
  await chats.user("search", "temporary needle");
  expect((await chats.search("search", "needle")).total).toBe(1);
  await fs.rm(chats.file("search"));
  expect((await chats.search("search", "needle")).total).toBe(0);
});
