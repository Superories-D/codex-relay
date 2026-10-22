import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Templates } from "../src/core/templates";
import { atomicWrite } from "../src/core/store";
let root: string;
const template = { name: "Debug", prompt: "Inspect, fix, verify", model: "", effort: "high", planMode: false, multiAgent: true };
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-templates-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it("saves, edits and removes templates durably across restarts", async () => {
  const store = new Templates(root);
  let state = await store.save({ revision: 0, template });
  expect((await new Templates(root).list()).items).toEqual(state.items);
  state = await store.save({ revision: 1, id: state.items[0].id, template: { ...template, prompt: "Changed" } });
  expect(state.items[0].prompt).toBe("Changed");
  state = await store.remove({ revision: 2, id: state.items[0].id });
  expect(state.items).toEqual([]);
});
it("rejects stale concurrent edits without losing the winning write", async () => {
  const store = new Templates(root);
  const results = await Promise.allSettled([store.save({ revision: 0, template }), store.save({ revision: 0, template: { ...template, name: "Other" } })]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect((await store.list()).items[0].name).toBe("Debug");
});
it("does not publish failed saves and allows a later retry", async () => {
  const write = vi.fn(atomicWrite).mockRejectedValueOnce(Error("disk full"));
  const store = new Templates(root, write);
  await expect(store.save({ revision: 0, template })).rejects.toThrow("disk full");
  expect((await store.list()).revision).toBe(0);
  expect((await store.save({ revision: 0, template })).revision).toBe(1);
});
it("refuses to overwrite corrupt template storage", async () => {
  const file = path.join(root, "task-templates.json");
  await fs.writeFile(file, "corrupt");
  await expect(new Templates(root).save({ revision: 0, template })).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe("corrupt");
});
