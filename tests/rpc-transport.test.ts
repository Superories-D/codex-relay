import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
