import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { JsonLines } from "../src/core/json-lines";
import { Store } from "../src/core/store";
import { Scheduler } from "../src/core/scheduler";
import { operationKey } from "../src/renderer/operations";

describe("bounded protocol and UI updates", () => {
  it("preserves split UTF-8 while emitting multiple complete frames", () => {
    const parser = new JsonLines(100),
      received: string[] = [];
    const bytes = Buffer.from('{"text":"中文"}\n\n{}\n');
    const cut = bytes.indexOf(Buffer.from("中")) + 1;
    parser.push(bytes.subarray(0, cut), (s) => received.push(s));
    expect(received).toEqual([]);
    parser.push(bytes.subarray(cut), (s) => received.push(s));
    expect(received).toEqual(['{"text":"中文"}', "{}"]);
  });
  it("rejects an unterminated oversized frame before it can grow without bound", () => {
    const parser = new JsonLines(8);
    parser.push(Buffer.from("12345678"), () => {});
    expect(() => parser.push(Buffer.from("9"), () => {})).toThrow("协议帧过大");
  });
  it("coalesces a log burst into one snapshot and bounds retained output", async () => {
    vi.useFakeTimers();
    try {
      const store = new Store("/unused");
      const scheduler = new Scheduler(store, {} as any, {} as any);
      const snapshots = vi.fn();
      scheduler.on("snapshot", snapshots);
      for (let i = 0; i < 1000; i++)
        scheduler.log("x".repeat(13000), "output", "job");
      expect(snapshots).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(snapshots).toHaveBeenCalledOnce();
      expect(store.data.logs.length).toBeLessThanOrEqual(500);
      expect(
        store.data.logs.reduce((sum, l) => sum + l.message.length, 0),
      ).toBeLessThanOrEqual(500000);
      expect(store.data.logs.every((l) => l.message.length < 12100)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("groups controls for the same job while allowing independent operations", () => {
    expect(operationKey("job.control", { id: "a", action: "pause" })).toBe(
      operationKey("job.control", { id: "a", action: "resume" }),
    );
    expect(operationKey("job.control", { id: "a" })).not.toBe(
      operationKey("job.control", { id: "b" }),
    );
    expect(operationKey("account.refresh", "a")).not.toBe(
      operationKey("job.add"),
    );
  });
});

it("coalesces queued disk writes without resolving checkpoints early and recovers after a failed write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-writes-"));
  const store = new Store(root);
  const rename = fs.rename.bind(fs);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const spy = vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
    enter();
    await gate;
    return rename(...args);
  });
  try {
    const first = store.save();
    await entered;
    const completed = vi.fn();
    store.data.cursor = 1;
    const second = store.save().then(completed);
    store.data.cursor = 2;
    const third = store.save().then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second, third]);
    expect(spy.mock.calls.filter(([, target]) => path.basename(String(target)) === "state.json")).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(path.join(root,"state.previous.json"),"utf8")).cursor).toBe(0);
    expect(
      JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"))
        .cursor,
    ).toBe(2);
    spy.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(store.save()).rejects.toThrow("disk unavailable");
    store.data.cursor = 3;
    await store.save();
    expect(
      JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"))
        .cursor,
    ).toBe(3);
  } finally {
    release();
    spy.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
