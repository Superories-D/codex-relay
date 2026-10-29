import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Scheduler } from "../src/core/scheduler";
import { Store } from "../src/core/store";
import { bulkPrioritySchema, priorityRejection } from "../src/shared/task-priority";
import type { Job } from "../src/shared/types";
let root: string, store: Store, scheduler: Scheduler;
const makeJob = (patch: Partial<Job> = {}): Job => ({
  id: randomUUID(), title: "Queued work", prompt: "synthetic", cwd: root,
  mode: "cli", state: "queued", model: "", effort: "", bucket: "codex", rotations: 0,
  createdAt: Date.now(), updatedAt: Date.now(), approvalPolicy: "on-request", sandbox: "workspaceWrite", ...patch,
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-priority-"));
  store = new Store(root);
  const factory = () => { throw Error("Priority edits must never start a worker"); };
  scheduler = new Scheduler(store, { busy: new Set(), cancelLogin: async () => {} } as any, { cli: factory, desktop: factory });
  scheduler.runtimeReady = () => false;
});
afterEach(async () => { vi.restoreAllMocks(); await scheduler.shutdown(); await fs.rm(root, { recursive: true, force: true }); });

it("persists one accepted batch, deduplicates IDs and reports each unsupported task without changing it", async () => {
  const queued = makeJob(), paused = makeJob({ state: "paused", priority: "low" });
  const archived = makeJob({ archived: true }), done = makeJob({ state: "completed" });
  const imported = makeJob({ existing: { phase: "watching" } as Job["existing"] });
  const missing = randomUUID();
  store.data.jobs = [queued, paused, archived, done, imported]; await store.save();
  const saved = vi.spyOn(store, "save");
  const response = await scheduler.priorityMany({ ids: [queued.id, missing, paused.id, archived.id, done.id, imported.id, queued.id], priority: "high" });
  expect(saved).toHaveBeenCalledTimes(1);
  expect(response.results.map(item => [item.id, item.ok, item.code])).toEqual([
    [queued.id, true, undefined], [missing, false, "missing"], [paused.id, true, undefined],
    [archived.id, false, "archived"], [done.id, false, "finished"], [imported.id, false, "unmanaged"],
  ]);
  const disk = new Store(root); await disk.load();
  expect(disk.data.jobs.filter(job => job.priority === "high").map(job => job.id)).toEqual([queued.id, paused.id]);
  expect(disk.data.jobs.find(job => job.id === archived.id)?.priority).toBeUndefined();
  expect(queued.state).toBe("queued"); expect(paused.state).toBe("paused");
});
it("rolls back every accepted priority on a real filesystem save failure and preserves previous durable state", async () => {
  const first = makeJob(), second = makeJob({ priority: "low" });
  store.data.jobs = [first, second]; await store.save();
  const before = await fs.readFile(path.join(root, "state.json"), "utf8");
  // A directory at the previous-generation destination makes atomic rename fail
  // on Windows and Linux; no mocked persistence method is involved.
  await fs.mkdir(path.join(root, "state.previous.json"));
  const result = await scheduler.priorityMany({ ids: [first.id, second.id], priority: "high" });
  expect(result.results.every(item => !item.ok && item.code === "save_failed")).toBe(true);
  expect(first.priority).toBeUndefined(); expect(second.priority).toBe("low");
  expect(await fs.readFile(path.join(root, "state.json"), "utf8")).toBe(before);
  await fs.rmdir(path.join(root, "state.previous.json"));
  const retried = await scheduler.priorityMany({ ids: [first.id, second.id], priority: "normal" });
  expect(retried.results.every(item => item.ok)).toBe(true);
  const reloaded = new Store(root); await reloaded.load();
  expect(reloaded.data.jobs.map(job => job.priority)).toEqual(["normal", "normal"]);
});
it("serializes individual and bulk priority commands and validates after earlier controls finish", async () => {
  const first = makeJob(), second = makeJob(); store.data.jobs = [first, second]; await store.save();
  const individual = scheduler.priority(first.id, "low");
  const bulk = scheduler.priorityMany({ ids: [first.id, second.id], priority: "high" });
  const later = scheduler.priority(second.id, "normal");
  await Promise.all([individual, bulk, later]);
  const loaded = new Store(root); await loaded.load();
  expect(loaded.data.jobs.map(job => job.priority)).toEqual(["high", "normal"]);
  const archive = scheduler.metadata(first.id, { archived: true });
  // Archiving queued work is rejected by existing semantics; pause it first.
  await expect(archive).rejects.toThrow();
  first.state = "paused"; await store.save();
  const pendingArchive = scheduler.metadata(first.id, { archived: true });
  const staleBatch = scheduler.priorityMany({ ids: [first.id], priority: "low" });
  await pendingArchive;
  expect((await staleBatch).results[0]).toMatchObject({ ok: false, code: "archived" });
  expect(first.priority).toBe("high");
});
it("rejects oversized or malformed batches before mutation, while legacy single priority keeps its behavior", async () => {
  const done = makeJob({ state: "completed", archived: true }); store.data.jobs = [done]; await store.save();
  expect(bulkPrioritySchema.safeParse({ ids: [], priority: "high" }).success).toBe(false);
  expect(bulkPrioritySchema.safeParse({ ids: [done.id], priority: "urgent" }).success).toBe(false);
  expect(bulkPrioritySchema.safeParse({ ids: [done.id], priority: "low", extra: true }).success).toBe(false);
  expect(() => scheduler.priorityMany({ ids: Array.from({ length: 101 }, () => randomUUID()), priority: "high" })).toThrow();
  expect(priorityRejection(done)).toBe("archived");
  await scheduler.priority(done.id, "high");
  const reloaded = new Store(root); await reloaded.load();
  expect(reloaded.data.jobs[0].priority).toBe("high");
});
