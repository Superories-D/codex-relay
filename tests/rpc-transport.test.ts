import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecoveryError } from "../src/core/auto-recovery";
import { Rpc } from "../src/core/rpc";
import { spawnCodex, terminateTree } from "../src/core/process";
import { ProcessSafetyError } from "../src/core/process-safety-error";
vi.mock("../src/core/process", () => ({
  spawnCodex: vi.fn(),
  terminateTree: vi.fn(async () => {}),
}));
let root: string, child: any, rpc: Rpc;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-rpc-"));
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: 123456789,
    exitCode: null,
  });
  child.stdin.on("data", (line: Buffer) => {
    const m = JSON.parse(line.toString());
    if (m.id)
      child.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\n");
  });
  vi.mocked(spawnCodex).mockResolvedValue(child);
  rpc = await Rpc.open("synthetic", root);
});
afterEach(async () => {
  await rpc.close();
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
it("delivers a protocol error notification without throwing an EventEmitter error", () => {
  const received = vi.fn();
  rpc.on("notification", received);
  expect(() =>
    child.stdout.write(
      JSON.stringify({
        method: "error",
        params: { error: { codexErrorInfo: "usageLimitExceeded" } },
      }) + "\n",
    ),
  ).not.toThrow();
  expect(received).toHaveBeenCalledWith(
    expect.objectContaining({ method: "error" }),
  );
});
it("closes the process exactly once under concurrent callers", async () => {
  await Promise.all([rpc.close(), rpc.close()]);
  expect(terminateTree).toHaveBeenCalledTimes(1);
});

it("a broken input pipe notifies the worker instead of leaving done pending", () => {
  const disconnected = vi.fn();
  rpc.on("disconnected", disconnected);
  child.stdin.emit("error", new Error("EPIPE"));
  expect(disconnected).toHaveBeenCalledOnce();
});

it("an initialization failure with failed process cleanup retains the recovery marker", async () => {
  await rpc.close();
  child.stdin.removeAllListeners("data");
  child.stdin.on("data", (line: Buffer) => {
    const m = JSON.parse(line.toString());
    if (m.id)
      child.stdout.write(
        JSON.stringify({
          id: m.id,
          error: { code: -1, message: "synthetic initialization failure" },
        }) + "\n",
      );
  });
  vi.mocked(terminateTree).mockRejectedValueOnce(
    new Error("synthetic process still alive"),
  );
  await expect(Rpc.open("synthetic", root)).rejects.toBeInstanceOf(
    ProcessSafetyError,
  );
  const owner = JSON.parse(
    await fs.readFile(path.join(root, "relay-owner.json"), "utf8"),
  );
  expect(owner.pid).toBe(child.pid);
});

it("ignores malformed protocol shapes and keeps subsequent responses usable", async () => {
  child.stdout.write("null\n42\n[]\nnot-json\n");
  await expect(rpc.call("account/read")).resolves.toEqual({});
});
it("closes the protocol on an oversized unterminated frame", () => {
  const disconnected = vi.fn();
  rpc.on("disconnected", disconnected);
  child.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 120));
  expect(disconnected).toHaveBeenCalledOnce();
});

it("rejects pending calls on output EOF even while the process is still alive", async () => {
  child.stdin.removeAllListeners("data");
  const pending = rpc.call("thread/read");
  const rejected = expect(pending).rejects.toBeInstanceOf(RecoveryError);
  child.stdout.emit("end");
  await rejected;
  await expect(rpc.call("thread/read")).rejects.toBeInstanceOf(RecoveryError);
  expect(child.exitCode).toBeNull();
});
it.each(["stdout", "stderr"])("recovers %s stream errors without crashing the host", async (stream) => {
  child.stdin.removeAllListeners("data");
  const rejected = expect(rpc.call("thread/read")).rejects.toBeInstanceOf(RecoveryError);
  child[stream].emit("error", Error("broken pipe"));
  await rejected;
});
it("classifies early process exit before initialization acknowledgement as recoverable", async () => {
  await rpc.close();
  child.stdin.removeAllListeners("data");
  child.stdin.on("data", () => child.emit("close", 1));
  await expect(Rpc.open("synthetic", root)).rejects.toBeInstanceOf(RecoveryError);
  await expect(fs.access(path.join(root, "relay-owner.json"))).rejects.toThrow();
});
it("retains a missing executable error instead of converting it to automatic recovery", async () => {
  await rpc.close();
  const missing = Object.assign(Error("spawn ENOENT"), { code: "ENOENT" });
  vi.mocked(spawnCodex).mockRejectedValueOnce(missing);
  await expect(Rpc.open("missing", root)).rejects.toBe(missing);
});
it("bounds a silent RPC request with a recoverable timeout", async () => {
  child.stdin.removeAllListeners("data");
  await expect(rpc.call("thread/read", {}, 5)).rejects.toBeInstanceOf(RecoveryError);
});
