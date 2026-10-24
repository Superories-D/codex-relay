import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { WindowsTelegram, type TelegramTransport } from "../src/main/telegram-notifications";
import { atomicWrite } from "../src/core/store";
import type { Snapshot } from "../src/shared/types";

const token = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF";
const key = randomBytes(32);
const cipher = {
  encrypt(value: string) { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(value), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
  decrypt(value: Buffer) { const c = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString(); },
};
const roots: string[] = [], managers: WindowsTelegram[] = [];
const snap = (state = "running", options: any = {}): Pick<Snapshot, "jobs" | "approvals"> => ({jobs: [
  {id: "task-1", title: "Secret project C:\\private", state, ...options} as any,
], approvals: []});
const setup = (revision = 0, options: any = {}) => ({revision, token, chatId: "123456", enabled: true,
  includeTitles: false, events: ["completed", "attention", "approval", "waiting"], ...options});
async function fixture(options: any = {}) {
  const root = options.root ?? await fs.mkdtemp(path.join(os.tmpdir(), "relay-windows-tg-"));
  if (!roots.includes(root)) roots.push(root);
  const calls: {method: string; body: any; token: string}[] = [];
  const transport: TelegramTransport = async (secret, method, body, signal) => {
    calls.push({method, body, token: secret});
    const override = await options.reply?.(method, body, signal);
    if (override !== undefined) return override;
    if (method === "getMe") return {ok: true, result: {id: 123456789, is_bot: true, username: "relay_test_bot"}};
    if (method === "getChat") return {ok: true, result: {type: "private", id: Number((body as any).chat_id)}};
    if (method === "getWebhookInfo") return {ok: true, result: {url: ""}};
    if (method === "getUpdates") return {ok: true, result: []};
    return {ok: true, result: {message_id: calls.length}};
  };
  const m = new WindowsTelegram({root, cipher, transport, now: options.now,
    manualPump: true, write: options.write}); managers.push(m);
  await m.load(options.snapshot ?? snap()); return {m, root, calls};
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.shutdown()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive: true, force: true})));
});

it("keeps configuration encrypted and exposes no token; disabled configuration needs an explicit test to send", async () => {
  const {m, root, calls} = await fixture();
  m.observe(snap("completed")); await m.drain(); expect(calls).toEqual([]);
  await m.save(setup(0, {enabled: false})); expect(calls.map(c => c.method)).toEqual(["getMe", "getChat"]);
  const file = await fs.readFile(path.join(root, "windows-telegram.enc"));
  expect(file.includes(Buffer.from(token))).toBe(false);
  expect(JSON.stringify(m.view())).not.toContain(token);
  await m.test(1); expect(m.view().receipts[0].status).toBe("pending");
  await m.pump(); expect(calls.at(-1)?.method).toBe("sendMessage");
  expect(m.view().receipts[0]).toMatchObject({status: "sent", attempts: 1});
  expect(calls.at(-1)?.body).toMatchObject({chat_id: "123456", protect_content: true});
});

it("discovers only private chats without acknowledging updates and leaves existing webhooks alone", async () => {
  let webhook = false;
  const {m, calls} = await fixture({reply: (method: string) => {
    if (method === "getWebhookInfo") return {ok: true, result: {url: webhook ? "https://existing.test/hook" : ""}};
    if (method === "getUpdates") return {ok: true, result: [{message: {chat: {id: 123, type: "private", first_name: "Owner"}}},
      {message: {chat: {id: -123, type: "group"}}}, {message: {chat: {id: 123, type: "private", first_name: "Owner"}}}]};
  }});
  expect(await m.discover(token)).toEqual([{id: "123", name: "Owner"}]);
  expect(calls.at(-1)?.body).toEqual({timeout: 0, limit: 100});
  webhook = true; await expect(m.discover(token)).rejects.toThrow("Webhook");
  expect(calls.filter(c => c.method === "getUpdates")).toHaveLength(1);
  expect(calls.some(c => /delete|send/.test(c.method))).toBe(false);
});

it("deduplicates events, includes acceptance outcome, filters events and defaults to private content", async () => {
  const {m} = await fixture(); await m.save(setup());
  const blocked = snap("needs_attention", {delivery: {revision: 1, checks: [{kind: "file", path: "result.zip"}], reports: [{revision: 1, status: "failed"}]}});
  m.observe(blocked); m.observe(blocked); await m.drain();
  expect(m.view().receipts).toHaveLength(1);
  expect(m.view().receipts[0].text).toContain("交付验收未通过");
  expect(m.view().receipts[0].text).not.toMatch(/Secret|private|result.zip/);
  m.observe(snap("running")); m.observe(snap("completed")); m.observe(snap("running")); m.observe(snap("completed"));
  await m.drain(); expect(m.view().receipts.map(r => r.event)).toEqual(["completed", "completed", "attention"]);
  await m.save(setup(1, {events: ["approval"]})); m.observe(snap("waiting")); await m.drain();
  expect(m.view().receipts).toHaveLength(3);
});

it("describes stale evidence as needing revalidation even when the historical report passed", async () => {
  const {m}=await fixture();await m.save(setup());
  m.observe(snap("needs_attention",{delivery:{revision:1,checks:[{kind:"file",path:"artifact",label:"Artifact"}],
    reports:[{id:"baseline",revision:1,status:"passed"}],staleEvidence:{reportId:"baseline",at:Date.now(),reason:"changed"}}}));
  await m.drain();expect(m.view().receipts[0].text).toContain("交付证据已失效");expect(m.view().receipts[0].text).not.toContain("交付验收通过");
});
it("preserves fast completion transitions while a network send holds the serialized outbox", async () => {
  let release!: () => void, started!: () => void;
  const sending = new Promise<void>(r => started = r), blocked = new Promise<void>(r => release = r);
  const {m} = await fixture({reply: async (method: string) => {if (method === "sendMessage") {started(); await blocked;}}});
  await m.save(setup()); await m.test(1); const pump = m.pump(); await sending;
  m.observe(snap("completed")); m.observe(snap("running")); m.observe(snap("completed"));
  release(); await pump; await m.drain(); expect(m.view().receipts.filter(r => r.event === "completed")).toHaveLength(2);
});

it("persists a Telegram rate-limit deadline and retries only after retry_after, including after restart", async () => {
  let time = 100000;
  const first = await fixture({now: () => time, reply: (method: string) => method === "sendMessage" ? {ok: false, error_code: 429, parameters: {retry_after: 30}} : undefined});
  await first.m.save(setup()); await first.m.test(1); await first.m.pump();
  expect(first.m.view().receipts[0]).toMatchObject({status: "pending", dueAt: 130000, attempts: 1});
  await first.m.shutdown();
  const second = await fixture({root: first.root, now: () => time}); await second.m.pump();
  expect(second.calls).toHaveLength(0); time += 30000; await second.m.pump();
  expect(second.m.view().receipts[0]).toMatchObject({status: "sent", attempts: 2});
});

it("applies a rate-limit deadline to the whole bot outbox, not only the rejected message", async () => {
  let time = 100000;
  const {m, calls} = await fixture({now: () => time, reply: (method: string) => method === "sendMessage" ? {ok: false, error_code: 429, parameters: {retry_after: 172800}} : undefined});
  await m.save(setup()); await m.test(1); await m.test(1); await m.pump(); await m.pump();
  expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(1);
  time += 86400000; await m.pump(); expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(1);
  time += 86400000; await m.pump(); expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(2);
});

it("never blindly retries an unknown external effect and persists explicit retry/cancellation", async () => {
  const first = await fixture({reply: (method: string) => {if (method === "sendMessage") throw Error(`timeout at /bot${token}/sendMessage`);}});
  await first.m.save(setup()); await first.m.test(1); await first.m.pump();
  expect(first.m.view().receipts[0].status).toBe("uncertain");
  expect(JSON.stringify(first.m.view())).not.toContain(token); await first.m.pump();
  expect(first.calls.filter(c => c.method === "sendMessage")).toHaveLength(1);
  await first.m.shutdown(); const second = await fixture({root: first.root}); await second.m.pump(); expect(second.calls).toHaveLength(0);
  await second.m.action(second.m.view().receipts[0].id, "retry"); await second.m.pump();
  expect(second.m.view().receipts[0].status).toBe("sent");
});

it("recovers a crash after the durable sending marker as uncertain, with no duplicate send", async () => {
  const first = await fixture(); await first.m.save(setup()); await first.m.test(1); await first.m.shutdown();
  const file = path.join(first.root, "windows-telegram.enc");
  const state = JSON.parse(cipher.decrypt(await fs.readFile(file))); state.receipts[0].status = "sending";
  await atomicWrite(file, cipher.encrypt(JSON.stringify(state)));
  const second = await fixture({root: first.root}); expect(second.m.view().receipts[0].status).toBe("uncertain");
  await second.m.pump(); expect(second.calls).toHaveLength(0);
});

it("never redirects queued or failed notices to a replacement recipient or bot", async () => {
  const {m, calls} = await fixture(); await m.save(setup()); await m.test(1);
  const id = m.view().receipts[0].id;
  await m.save(setup(1, {chatId: "987654"}));
  expect(m.view().receipts[0].status).toBe("cancelled"); await m.pump();
  expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
  await expect(m.action(id, "retry")).rejects.toThrow();
  await m.test(2); await m.pump(); expect(calls.at(-1)?.body.chat_id).toBe("987654");
});

it("stops before sending when the durable sending marker fails to save", async () => {
  let fail = false;
  const {m, calls} = await fixture({write: async (file: string, value: Buffer) => {if (fail) throw Error("disk full"); await atomicWrite(file, value);}});
  await m.save(setup()); await m.test(1); fail = true;
  await expect(m.pump()).rejects.toThrow("保存");
  expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
  expect(m.view().receipts[0].status).toBe("pending"); expect(m.view().issue).toBeTruthy();
});

it("does not claim a durable success or repeat the send after acknowledgement persistence fails", async () => {
  let fail = false;
  const first = await fixture({reply: (method: string) => {if (method === "sendMessage") fail = true;},
    write: async (file: string, value: Buffer) => {if (fail) throw Error("disk full"); await atomicWrite(file, value);}});
  await first.m.save(setup()); await first.m.test(1); await expect(first.m.pump()).rejects.toThrow("保存");
  expect(first.m.view().receipts[0].status).toBe("sending"); await expect(first.m.pump()).rejects.toThrow();
  await first.m.shutdown(); const second = await fixture({root: first.root});
  expect(second.m.view().receipts[0].status).toBe("uncertain"); await second.m.pump(); expect(second.calls).toHaveLength(0);
});

it("rejects stale configuration, malformed secrets and non-private chats without changing the saved connection", async () => {
  let group = false;
  const {m} = await fixture({reply: (method: string) => method === "getChat" && group ? {ok: true, result: {type: "group", id: 123456}} : undefined});
  await m.save(setup()); await expect(m.save(setup())).rejects.toThrow("已更新");
  await expect(m.save(setup(1, {token: "bad"}))).rejects.toThrow("格式");
  group = true; await expect(m.save(setup(1, {chatId: "987654"}))).rejects.toThrow("私人聊天");
  expect(m.view().revision).toBe(1); expect(JSON.stringify(m.view())).not.toContain(token);
});

it("quarantines corrupt encrypted state without network calls and supports explicit removal", async () => {
  const first = await fixture(); await first.m.shutdown(); await fs.writeFile(path.join(first.root, "windows-telegram.enc"), "corrupt");
  const second = await fixture({root: first.root}); expect(second.m.view().issue).toBeTruthy();
  await expect(second.m.pump()).rejects.toThrow(); expect(second.calls).toHaveLength(0);
  await second.m.forget(0); expect(second.m.view()).toMatchObject({issue: undefined, configured: false, revision: 1, receipts: []});
});

it("can disable an already verified connection while offline without performing another API request", async () => {
  let offline = false;
  const {m, calls} = await fixture({reply: () => {if (offline) throw Error("offline");}});
  await m.save(setup()); offline = true;
  await m.save(setup(1, {enabled: false}));
  expect(m.view().enabled).toBe(false); expect(calls).toHaveLength(2);
  m.observe(snap("completed")); await m.drain(); await m.pump();
  expect(m.view().receipts).toHaveLength(0); expect(calls).toHaveLength(2);
});

it("keeps permanent API rejection visible and bounds automatic server-error retries", async () => {
  let time = 100000, code = 403;
  const {m, calls} = await fixture({now: () => time, reply: (method: string) => method === "sendMessage" ? {ok: false, error_code: code, description: token} : undefined});
  await m.save(setup()); await m.test(1); await m.pump();
  expect(m.view().receipts[0]).toMatchObject({status: "failed", attempts: 1, issue: "Telegram API 403"});
  expect(JSON.stringify(m.view())).not.toContain(token);
  code = 500; await m.action(m.view().receipts[0].id, "retry");
  for (let i = 0; i < 5; i++) {await m.pump(); time += 100000;}
  expect(m.view().receipts[0]).toMatchObject({status: "failed", attempts: 5});
  await m.pump(); expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(6);
});

it("joins an aborted send during shutdown and resumes without automatically replaying the unknown effect", async () => {
  let started!: () => void;
  const sending = new Promise<void>(r => started = r);
  const {m, calls} = await fixture({reply: async (method: string, _body: object, signal: AbortSignal) => {
    if (method === "sendMessage") {started(); await new Promise((_r, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), {once: true}));}
  }});
  await m.save(setup()); await m.test(1); const pump = m.pump(); await sending; await m.shutdown(); await pump;
  expect(m.view().receipts[0].status).toBe("uncertain"); m.resume(); await m.pump();
  expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(1);
});

it("notifies approval and quota transitions once, suppresses automatic recovery noise and supports title opt-in", async () => {
  const {m} = await fixture(); await m.save(setup(0, {includeTitles: true}));
  m.observe({...snap(), approvals: [{jobId: "task-1", id: "a", method: "ask", params: {secret: "QUESTION"}} as any]}); await m.drain();
  expect(m.view().receipts[0].event).toBe("approval"); expect(m.view().receipts[0].text).not.toContain("QUESTION");
  m.observe(snap("needs_attention", {autoRecovery: {}})); m.observe(snap("waiting")); await m.drain();
  expect(m.view().receipts[0].event).toBe("waiting"); expect(m.view().receipts).toHaveLength(2);
  expect(m.view().receipts[0].text).toContain("Secret project");
});
