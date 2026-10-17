import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Scheduler } from "../src/core/scheduler";
import { Store } from "../src/core/store";
import { Rpc } from "../src/core/rpc";
import type { Job } from "../src/shared/types";
vi.mock("../src/core/rpc", () => ({ Rpc: { open: vi.fn() } }));
const sourceId = "11111111-1111-4111-8111-111111111111";
let root: string,
  store: Store,
  scheduler: Scheduler,
  rpcs: FakeRpc[],
  inspect: ReturnType<typeof vi.fn>;
class FakeRpc extends EventEmitter {
  invalidRevert = false;
  call = vi.fn(async (method: string, args: any): Promise<any> => {
    if (method === "thread/resume") return { thread: { id: args.threadId } };
    if (method === "thread/fork")
      return {
        thread: {
          id: `fork-${rpcs.length}`,
          historyMode: "paginated",
          path: "metadata-only.jsonl",
        },
      };
    if (method === "thread/revert") {
      if (this.invalidRevert) throw Error("Unknown turn");
      return {};
    }
    if (method === "thread/turns/list")
      return args.cursor
        ? {
            data: [
              {
                id: "turn-b",
                items: [
                  {
                    id: "answer-b",
                    type: "agentMessage",
                    text: "Second answer",
                  },
                ],
              },
            ],
            nextCursor: null,
          }
        : {
            data: [
              {
                id: "turn-a",
                items: [
                  {
                    id: "user-a",
                    type: "userMessage",
                    content: [{ type: "text", text: "First question" }],
                  },
                  {
                    id: "answer-a",
                    type: "agentMessage",
                    text: "First answer",
                  },
                ],
              },
            ],
            nextCursor: "next",
          };
    throw Error(`Unexpected protocol operation ${method}`);
  });
  close = vi.fn(async () => {});
  reject = vi.fn();
}
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-branches-"));
  store = new Store(root);
  rpcs = [];
  inspect = vi.fn();
  store.data.jobs.push({
    id: sourceId,
    title: "Original",
    cwd: root,
    prompt: "",
    mode: "cli",
    model: "model",
    effort: "low",
    bucket: "codex",
    state: "completed",
    threadId: "source-thread",
    rotations: 0,
    createdAt: 1,
    updatedAt: 1,
    approvalPolicy: "on-request",
    sandbox: "readOnly",
  });
  vi.mocked(Rpc.open).mockImplementation(async () => {
    const rpc = new FakeRpc();
    rpcs.push(rpc);
    return rpc as any;
  });
  scheduler = new Scheduler(store, { inspect, cancelLogin: async () => {} } as any, {
    cli: () => {
      throw Error("Inference must not start");
    },
    desktop: () => {
      throw Error("Desktop must not start");
    },
  });
});
afterEach(async () => {
  await scheduler.shutdown();
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
it("hydrates every fork page and keeps nested paginated forks in the owned thread-family runtime", async () => {
  const fork = await scheduler.fork(sourceId, { beforeTurnId: "turn-b" });
  expect(store.data.jobs[0].threadId).toBe("source-thread");
  expect(fork.threadId).not.toBe("source-thread");
  expect(fork.runtimeHomeId).toBe(sourceId);
  expect(
    (await scheduler.chats.read(fork.id)).items.map((item) => item.text),
  ).toEqual(["First question", "First answer", "Second answer"]);
  const nested = await scheduler.fork(fork.id, { lastTurnId: "turn-a" });
  expect(nested.runtimeHomeId).toBe(sourceId);
  expect(store.jobHome(nested.id)).toBe(store.jobHome(sourceId));
  expect(rpcs[0].call).toHaveBeenCalledWith("thread/revert", {
    threadId: fork.threadId,
    beforeTurnId: "turn-b",
  });
  expect(rpcs[1].call).toHaveBeenCalledWith(
    "thread/fork",
    expect.objectContaining({ threadId: fork.threadId, lastTurnId: "turn-a" }),
  );
  expect(inspect).not.toHaveBeenCalled();
  expect(rpcs.every((rpc) => rpc.close.mock.calls.length === 1)).toBe(true);
});
it("does not register a failed branch or revert the source thread", async () => {
  vi.mocked(Rpc.open).mockImplementationOnce(async () => {
    const rpc = new FakeRpc();
    rpc.invalidRevert = true;
    rpcs.push(rpc);
    return rpc as any;
  });
  await expect(
    scheduler.fork(sourceId, { beforeTurnId: "missing-turn" }),
  ).rejects.toThrow("Unknown turn");
  expect(store.data.jobs).toHaveLength(1);
  expect(store.data.jobs[0].threadId).toBe("source-thread");
  expect(rpcs[0].close).toHaveBeenCalled();
});
it("rejects queued, unsafe recovery and incompatible source chats before opening a CLI", async () => {
  const job = store.data.jobs[0];
  job.state = "queued";
  await expect(scheduler.turns(sourceId)).rejects.toThrow("尚不可操作");
  job.state = "needs_attention";
  job.recoveryRequired = true;
  await expect(scheduler.fork(sourceId)).rejects.toThrow("尚不可操作");
  job.recoveryRequired = false;
  job.historySource = {
    threadId: "foreign",
    source: "desktop",
    issue: "Private tools",
  };
  await expect(scheduler.fork(sourceId)).rejects.toThrow("尚不可操作");
  expect(Rpc.open).not.toHaveBeenCalled();
});
it("rejects a persisted runtime-family path escaping the workspace", () => {
  store.data.jobs[0].runtimeHomeId = "../../foreign";
  expect(() => store.jobHome(sourceId)).toThrow("标识无效");
});
