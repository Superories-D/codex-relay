import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Terminals } from "../src/core/terminals";
import { Rpc } from "../src/core/rpc";

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
class FakeRpc extends EventEmitter {
  execution = deferred<{ exitCode: number }>();
  pid = "";
  writeGate?: Promise<void>;
  call = vi.fn(async (method: string, params: any) => {
    if (method === "command/exec") {
      this.pid = params.processId;
      return this.execution.promise;
    }
    if (method === "command/exec/write") await this.writeGate;
    return {};
  });
  close = vi.fn(async () => {
    this.execution.reject(new Error("RPC closed"));
  });
  reject = vi.fn();
  output(data: string | Buffer) {
    this.emit("command/exec/outputDelta", {
      processId: this.pid,
      deltaBase64: Buffer.from(data).toString("base64"),
    });
  }
}
let root: string, terminals: Terminals, rpcs: FakeRpc[];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-terminals-"));
  rpcs = [];
  terminals = new Terminals(
    root,
    () => "fixture",
    async () => {
      const rpc = new FakeRpc();
      rpcs.push(rpc);
      return rpc as unknown as Rpc;
    },
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await terminals.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

it("reserves all pending starts before awaits and strictly caps concurrent opens at eight", async () => {
  const gate = deferred();
  const open = vi.fn(async () => {
    await gate.promise;
    const rpc = new FakeRpc();
    rpcs.push(rpc);
    return rpc as unknown as Rpc;
  });
  terminals = new Terminals(root, () => "fixture", open);
  const requests = Array.from({ length: 12 }, () => terminals.open(root));
  const settled = Promise.allSettled(requests);
  expect(terminals.list()).toHaveLength(8);
  expect(terminals.list().every((s) => s.state === "starting")).toBe(true);
  gate.resolve();
  const results = await settled;
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(4);
  expect(open).toHaveBeenCalledTimes(8);
});

it("shutdown drains an in-flight RPC start and never launches its shell", async () => {
  const gate = deferred<Rpc>(),
    entered = deferred();
  const rpc = new FakeRpc();
  terminals = new Terminals(
    root,
    () => "fixture",
    async () => {
      entered.resolve();
      return gate.promise;
    },
  );
  const opening = terminals.open(root).catch((error) => error);
  await entered.promise;
  const closing = terminals.shutdown();
  await expect(terminals.open(root)).rejects.toThrow("客户端正在退出");
  gate.resolve(rpc as unknown as Rpc);
  await closing;
  expect(await opening).toBeInstanceOf(Error);
  expect(rpc.call).not.toHaveBeenCalled();
  expect(rpc.close).toHaveBeenCalledOnce();
  expect(terminals.list()).toEqual([]);
  // No command was launched, so this fake's rejected deferred is unused.
  await rpc.execution.promise.catch(() => {});
});

it("releases ordinary failed starts but retains uncertain owners for recovery", async () => {
  await expect(terminals.open(path.join(root, "absent"))).rejects.toThrow();
  expect(terminals.list()).toEqual([]);
  terminals = new Terminals(
    root,
    () => "fixture",
    async (_cli, home) => {
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(
        path.join(home, "relay-owner.json"),
        JSON.stringify({ pid: process.pid }),
      );
      throw new Error("initialization failed");
    },
  );
  await expect(terminals.open(root)).rejects.toThrow("不会启动重复实例");
  const session = terminals.list()[0];
  expect(session.state).toBe("error");
  await expect(terminals.close(session.id)).rejects.toThrow("不会启动重复实例");
  await fs.rm(path.join(root, "terminals", session.id, "relay-owner.json"));
  await terminals.close(session.id);
  expect(terminals.list()).toEqual([]);
});

it("coalesces duplicate close and drains other terminals before reporting a failed shutdown", async () => {
  const first = await terminals.open(root),
    second = await terminals.open(root);
  const slow = deferred();
  rpcs[0].close.mockRejectedValueOnce(new Error("still alive"));
  rpcs[1].close.mockImplementationOnce(async () => {
    await slow.promise;
    rpcs[1].execution.reject(Error("closed"));
  });
  const shutdown = terminals.shutdown();
  let finished = false;
  const failure = shutdown.catch((e) => {
    finished = true;
    return e;
  });
  await vi.waitFor(() => expect(rpcs[1].close).toHaveBeenCalled());
  expect(finished).toBe(false);
  const sameClose = terminals.close(second.id);
  expect(
    rpcs[1].call.mock.calls.filter(([m]) => m === "command/exec/terminate"),
  ).toHaveLength(1);
  slow.resolve();
  await sameClose;
  expect(await failure).toBeInstanceOf(AggregateError);
  expect(terminals.list().map((s) => s.id)).toEqual([first.id]);
  await terminals.shutdown();
  expect(terminals.list()).toEqual([]);
  terminals.resume();
  expect((await terminals.open(root)).state).toBe("starting");
});

it("serializes input within each terminal and isolates independent terminals", async () => {
  const a = await terminals.open(root),
    b = await terminals.open(root);
  await expect(terminals.write(a.id, "early")).rejects.toThrow("正在启动");
  rpcs.forEach((rpc) => rpc.output("ready"));
  const gate = deferred();
  rpcs[0].writeGate = gate.promise;
  const first = terminals.write(a.id, "first"),
    second = terminals.write(a.id, "second");
  await terminals.write(b.id, "independent");
  expect(
    rpcs[0].call.mock.calls.filter(([m]) => m.endsWith("/write")),
  ).toHaveLength(1);
  expect(
    Buffer.from(
      rpcs[1].call.mock.calls.at(-1)![1].deltaBase64,
      "base64",
    ).toString(),
  ).toBe("independent");
  gate.resolve();
  await Promise.all([first, second]);
  expect(
    rpcs[0].call.mock.calls
      .filter(([m]) => m.endsWith("/write"))
      .map(([, p]) => Buffer.from(p.deltaBase64, "base64").toString()),
  ).toEqual(["first", "second"]);
});

it("preserves split UTF-8, resets stale cursors, and keeps exit output after releasing RPC", async () => {
  const s = await terminals.open(root),
    rpc = rpcs[0];
  const bytes = Buffer.from("日本語😀");
  rpc.output(bytes.subarray(0, 2));
  rpc.output(bytes.subarray(2));
  expect(terminals.read(s.id).text).toBe("日本語😀");
  rpc.output("😀" + "x".repeat(1024 * 1024 - 1));
  const read = terminals.read(s.id);
  expect(read.reset).toBe(true);
  expect(read.text).not.toContain("\udc00");
  expect(read.text.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  expect(terminals.read(s.id, read.cursor + 1).reset).toBe(true);
  rpc.execution.resolve({ exitCode: 7 });
  await vi.waitFor(() => expect(rpc.close).toHaveBeenCalledOnce());
  expect(terminals.list()[0]).toMatchObject({ state: "exited", exitCode: 7 });
  expect(terminals.read(s.id).text.length).toBeGreaterThan(0);
  await expect(terminals.write(s.id, "late")).rejects.toThrow("已退出");
});
