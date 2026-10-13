import { EventEmitter } from "node:events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Rpc } from "../src/core/rpc";
import { CliWorker } from "../src/core/cli-worker";
import type { Job } from "../src/shared/types";
vi.mock("../src/core/rpc", () => ({ Rpc: { open: vi.fn() } }));
class FakeRpc extends EventEmitter {
  used = 10;
  interruptEmits = true;
  calls: string[] = [];
  call = vi.fn(async (method: string, params: any) => {
    this.calls.push(method);
    if (method === "windowsSandbox/readiness") return { status: "ready" };
    if (method === "account/rateLimits/read")
      return {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: this.used,
            windowDurationMins: 300,
            resetsAt: Date.now() / 1000 + 300,
          },
          secondary: {
            usedPercent: 10,
            windowDurationMins: 10080,
            resetsAt: Date.now() / 1000 + 86400,
          },
        },
      };
    if (method === "thread/start" || method === "thread/resume")
      return { thread: { id: "thread-1" }, model: "model-1" };
    if (method === "turn/start") {
      this.notify("turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-2" },
      });
      return { turn: { id: "turn-2" } };
    }
    if (method === "turn/interrupt" && this.interruptEmits)
      this.notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-2", status: "interrupted" },
      });
    return {};
  });
  notify(method: string, params: any) {
    this.emit("notification", { method, params });
  }
  close = vi.fn(async () => {});
  respond = vi.fn();
  reject = vi.fn();
}
let rpc: FakeRpc;
let job: Job;
const auth = {
  accessToken: "synthetic",
  chatgptAccountId: "account",
  chatgptPlanType: "plus",
};
function worker() {
  return new CliWorker({
    job,
    home: "/tmp/never-used",
    cli: "never-launched",
    resumePrompt: "resume original work",
    checkpoint: async (t, u) => {
      job.threadId = t;
      if (u) job.turnId = u;
    },
    shouldStart: () => true,
    refresh: async () => auth,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  rpc = new FakeRpc();
  vi.mocked(Rpc.open).mockResolvedValue(rpc as any);
  job = {
    id: "job",
    title: "test",
    prompt: "original",
    cwd: "/tmp",
    mode: "cli",
    model: "",
    effort: "",
    bucket: "codex",
    state: "running",
    rotations: 0,
    createdAt: 0,
    updatedAt: 0,
    approvalPolicy: "on-request",
    sandbox: "workspaceWrite",
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("CLI completion and interruption protocol", () => {
  it("sends the official kebab-case sandbox wire value", async () => {
    const w = worker();
    await w.start(auth);
    expect(rpc.call).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({ sandbox: "workspace-write" }),
    );
  });
  it("does not count a completed status with a structured quota error as success", async () => {
    const w = worker();
    await w.start(auth);
    rpc.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-2",
        status: "completed",
        error: { codexErrorInfo: "usageLimitExceeded", message: "exhausted" },
      },
    });
    await vi.advanceTimersByTimeAsync(800);
    expect((await w.done).kind).toBe("quota");
  });
  it("preserves quota evidence even if a subsequent read has recovered", async () => {
    const w = worker();
    await w.start(auth);
    rpc.notify("account/rateLimits/updated", {
      rateLimits: { primary: { usedPercent: 100 } },
    });
    await vi.advanceTimersByTimeAsync(800);
    expect((await w.done).kind).toBe("quota");
    expect(rpc.calls.filter((m) => m === "turn/interrupt")).toHaveLength(1);
  });
  it("periodic polling alone can trigger an interruption and rotation", async () => {
    const w = worker();
    await w.start(auth);
    rpc.used = 100;
    await w.quota();
    await vi.advanceTimersByTimeAsync(800);
    expect((await w.done).kind).toBe("quota");
    expect(rpc.calls).toContain("turn/interrupt");
  });
  it("does not call completion before the interrupt terminal notification", async () => {
    const w = worker();
    await w.start(auth);
    rpc.interruptEmits = false;
    const done = vi.fn();
    w.done.then(done);
    const stop = w.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(done).not.toHaveBeenCalled();
    rpc.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "interrupted" },
    });
    await vi.advanceTimersByTimeAsync(800);
    await stop;
    expect((await w.done).kind).toBe("interrupted");
  });
  it("fails closed when interruption is acknowledged but never completes", async () => {
    const w = worker();
    await w.start(auth);
    rpc.interruptEmits = false;
    const errors = vi.fn();
    w.on("stopError", errors);
    const stop = w.stop().catch((e) => e);
    await vi.advanceTimersByTimeAsync(21000);
    expect(await stop).toBeInstanceOf(Error);
    expect((await w.done).kind).toBe("error");
    expect(errors).toHaveBeenCalledOnce();
  });
  it("uses the same thread and a continuation prompt after rotation", async () => {
    job.threadId = "thread-1";
    job.turnId = "turn-1";
    const w = worker();
    await w.start(auth);
    expect(rpc.calls).toContain("thread/resume");
    const turn = rpc.call.mock.calls.find(([m]) => m === "turn/start")!;
    expect(turn[1].input[0].text).toBe("resume original work");
  });
  it("successful final text does not become a quota error because it mentions implementation", async () => {
    const w = worker();
    await w.start(auth);
    rpc.notify("item/completed", {
      threadId: "thread-1",
      item: {
        type: "agentMessage",
        text: "Implemented Usage limit exceeded handling.",
      },
    });
    rpc.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed", error: null },
    });
    await vi.advanceTimersByTimeAsync(800);
    expect((await w.done).kind).toBe("completed");
  });
  it("ignores terminal events for another thread or another turn", async () => {
    const w = worker();
    await w.start(auth);
    const done = vi.fn();
    w.done.then(done);
    rpc.notify("turn/completed", {
      threadId: "other",
      turn: { id: "turn-2", status: "completed" },
    });
    rpc.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "other", status: "completed" },
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(done).not.toHaveBeenCalled();
    await w.close();
  });
  it("clears stale approval requests on server resolution", async () => {
    const w = worker();
    await w.start(auth);
    const clear = vi.fn();
    w.on("approvalResolved", clear);
    rpc.emit("request", {
      id: 12,
      method: "item/commandExecution/requestApproval",
      params: {},
    });
    rpc.notify("serverRequest/resolved", {
      threadId: "thread-1",
      requestId: 12,
    });
    expect(clear).toHaveBeenCalledWith("12");
    expect(() => w.respond("12", { decision: "accept" })).toThrow("过期");
  });
});
