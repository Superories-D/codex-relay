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
      return {
        thread: { id: params.threadId || "thread-1" },
        model: "model-1",
      };
    if (method === "turn/start") {
      this.notify("turn/started", {
        threadId: params.threadId,
        turn: { id: "turn-2" },
      });
      return { turn: { id: "turn-2" } };
    }
    if (method === "turn/interrupt" && this.interruptEmits)
      this.notify("turn/completed", {
        threadId: params.threadId,
        turn: { id: params.turnId, status: "interrupted" },
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
it("keeps root Goal accounting updates from prior turns and isolates child Goal state", async () => {
  const w = worker();
  const onGoal = vi.fn();
  w.on("goal", onGoal);
  await w.start(auth);
  const goal = {
    threadId: job.threadId,
    objective: "Keep evidence",
    status: "active",
    tokensUsed: 42,
  };
  rpc.notify("thread/goal/updated", {
    threadId: job.threadId,
    turnId: "older-turn",
    goal,
  });
  expect(onGoal).toHaveBeenLastCalledWith(goal);
  rpc.notify("thread/goal/updated", {
    threadId: "other-thread",
    goal: { ...goal, threadId: "other-thread" },
  });
  expect(onGoal).toHaveBeenCalledTimes(1);
  rpc.notify("thread/goal/cleared", {
    threadId: job.threadId,
    turnId: "older-turn",
  });
  expect(onGoal).toHaveBeenLastCalledWith(null);
  await w.close();
});
it("restores owned nested children after reconnect and resumes them using the current sandbox before sending", async () => {
  job.threadId = "thread-1";
  job.planMode = true;
  job.sandbox = "dangerFullAccess";
  job.agents = [
    {
      threadId: "grandchild",
      parentThreadId: "child",
      name: "Nested",
      status: "interrupted",
      updatedAt: 0,
    },
    {
      threadId: "unrelated",
      parentThreadId: "other-parent",
      name: "Other",
      status: "completed",
      updatedAt: 0,
    },
    {
      threadId: "child",
      parentThreadId: "thread-1",
      name: "Scout",
      model: "child-model",
      effort: "low",
      status: "shutdown",
      updatedAt: 0,
    },
  ];
  const w = worker(),
    updates = vi.fn();
  w.on("agent", updates);
  await w.start(auth);
  await w.agentControl("child", "send", "continue child");
  expect(rpc.call).toHaveBeenCalledWith(
    "thread/resume",
    expect.objectContaining({
      threadId: "child",
      model: "child-model",
      sandbox: "read-only",
      excludeTurns: true,
    }),
  );
  expect(rpc.call).toHaveBeenCalledWith(
    "turn/start",
    expect.objectContaining({
      threadId: "child",
      parentTurnId: "turn-2",
      rootTurnId: "turn-2",
      effort: "low",
    }),
  );
  await w.agentControl("grandchild", "send", "continue nested");
  await expect(
    w.agentControl("unrelated", "send", "not owned"),
  ).rejects.toThrow("不可控制");
  expect(updates).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: "grandchild", status: "running" }),
  );
  await w.close();
});
function beginChild(id = "child", turnId = "child-turn") {
  rpc.notify("thread/started", {
    thread: {
      id,
      source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1" } } },
    },
  });
  rpc.notify("turn/started", { threadId: id, turn: { id: turnId } });
}
function endParent() {
  rpc.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-2",
    item: {
      type: "agentMessage",
      phase: "final_answer",
      text: "Parent result",
    },
  });
  rpc.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-2", status: "completed" },
  });
}
it("keeps a manual child interruption pending until the terminal event and refuses a premature restart", async () => {
  const w = worker();
  await w.start(auth);
  beginChild();
  rpc.interruptEmits = false;
  const done = vi.fn(),
    stopping = w.agentControl("child", "interrupt").then(done);
  await vi.advanceTimersByTimeAsync(100);
  expect(done).not.toHaveBeenCalled();
  await expect(w.agentControl("child", "send", "too early")).rejects.toThrow(
    "等待停止确认",
  );
  rpc.notify("turn/completed", {
    threadId: "child",
    turn: { id: "child-turn", status: "interrupted" },
  });
  await stopping;
  expect(done).toHaveBeenCalledTimes(1);
  await w.close();
});
it("preserves root quota evidence while waiting for active children to stop", async () => {
  const w = worker();
  await w.start(auth);
  beginChild();
  rpc.used = 100;
  endParent();
  await vi.advanceTimersByTimeAsync(1000);
  expect((await w.done).kind).toBe("quota");
  expect(rpc.call).toHaveBeenCalledWith("turn/interrupt", {
    threadId: "child",
    turnId: "child-turn",
  });
  await w.close();
});
it("never sends a turn when child resume returns a different identity", async () => {
  job.threadId = "thread-1";
  job.agents = [
    {
      threadId: "child",
      parentThreadId: "thread-1",
      name: "Child",
      status: "shutdown",
      updatedAt: 0,
    },
  ];
  const w = worker();
  await w.start(auth);
  const original = rpc.call.getMockImplementation()!;
  rpc.call.mockImplementation((method, params) =>
    method === "thread/resume" && params.threadId === "child"
      ? Promise.resolve({ thread: { id: "unrelated" }, model: "model-1" })
      : original(method, params),
  );
  await expect(w.agentControl("child", "send", "safe")).rejects.toThrow(
    "ID 不匹配",
  );
  expect(
    rpc.call.mock.calls.filter(
      ([method, params]) =>
        method === "turn/start" && params.threadId === "child",
    ),
  ).toEqual([]);
  await w.close();
});
it("does not start a restored child if the parent begins stopping while resume is in flight", async () => {
  job.threadId = "thread-1";
  job.agents = [
    {
      threadId: "child",
      parentThreadId: "thread-1",
      name: "Child",
      status: "completed",
      updatedAt: 0,
    },
  ];
  const w = worker();
  await w.start(auth);
  const original = rpc.call.getMockImplementation()!;
  let release!: (value: any) => void;
  rpc.call.mockImplementation((method, params) =>
    method === "thread/resume" && params.threadId === "child"
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(method, params),
  );
  const sending = w.agentControl("child", "send", "do not start after stop");
  const rejected = expect(sending).rejects.toThrow("正在停止");
  const stopping = w.stop();
  release({ thread: { id: "child" } });
  await rejected;
  await vi.advanceTimersByTimeAsync(1000);
  await stopping;
  expect(
    rpc.call.mock.calls.filter(
      ([method, params]) =>
        method === "turn/start" && params.threadId === "child",
    ),
  ).toEqual([]);
  await w.close();
});
it("pauses children during the parent's final quota check and waits for the child's terminal event", async () => {
  const w = worker(),
    done = vi.fn();
  w.done.then(done);
  await w.start(auth);
  beginChild();
  rpc.interruptEmits = false;
  endParent();
  const stop = w.stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(rpc.call).toHaveBeenCalledWith("turn/interrupt", {
    threadId: "child",
    turnId: "child-turn",
  });
  expect(done).not.toHaveBeenCalled();
  rpc.notify("turn/completed", {
    threadId: "child",
    turn: { id: "child-turn", status: "interrupted" },
  });
  await stop;
  expect((await w.done).kind).toBe("interrupted");
  await w.close();
});
it("never mistakes an interrupt acknowledgement for a child terminal event after the parent has ended", async () => {
  const w = worker(),
    done = vi.fn();
  w.done.then(done);
  await w.start(auth);
  beginChild();
  endParent();
  await vi.advanceTimersByTimeAsync(1000);
  rpc.interruptEmits = false;
  const stop = w.stop();
  await vi.advanceTimersByTimeAsync(500);
  expect(done).not.toHaveBeenCalled();
  await expect(w.agentControl("child", "send", "late message")).rejects.toThrow(
    "不可控制",
  );
  rpc.notify("turn/completed", {
    threadId: "child",
    turn: { id: "child-turn", status: "interrupted" },
  });
  await stop;
  expect((await w.done).kind).toBe("interrupted");
  await w.close();
});
it("interrupts a late-starting child and preserves child-only quota evidence over a normal parent result", async () => {
  const w = worker();
  await w.start(auth);
  beginChild();
  endParent();
  await vi.advanceTimersByTimeAsync(1000);
  rpc.notify("error", {
    threadId: "child",
    error: { codexErrorInfo: "usageLimitExceeded", message: "exhausted" },
  });
  expect((await w.done).kind).toBe("quota");
  await w.close();
  rpc = new FakeRpc();
  vi.mocked(Rpc.open).mockResolvedValue(rpc as any);
  const second = worker();
  await second.start(auth);
  rpc.interruptEmits = false;
  const stop = second.stop();
  beginChild("late", "late-turn");
  await vi.advanceTimersByTimeAsync(50);
  expect(rpc.call).toHaveBeenCalledWith("turn/interrupt", {
    threadId: "late",
    turnId: "late-turn",
  });
  rpc.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-2", status: "interrupted" },
  });
  rpc.notify("turn/completed", {
    threadId: "late",
    turn: { id: "late-turn", status: "interrupted" },
  });
  await vi.advanceTimersByTimeAsync(800);
  await stop;
  await second.close();
});
it("ignores stale child-turn completion and parent snapshots while a newer child turn is active", async () => {
  const w = worker(),
    updates = vi.fn(),
    done = vi.fn();
  w.on("agent", updates);
  w.done.then(done);
  await w.start(auth);
  beginChild("child", "old");
  rpc.notify("turn/started", { threadId: "child", turn: { id: "new" } });
  rpc.notify("turn/completed", {
    threadId: "child",
    turn: { id: "old", status: "completed" },
  });
  rpc.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-2",
    item: {
      type: "collabAgentToolCall",
      senderThreadId: "thread-1",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "completed" } },
    },
  });
  expect(updates).toHaveBeenLastCalledWith(
    expect.objectContaining({
      threadId: "child",
      turnId: "new",
      status: "running",
    }),
  );
  endParent();
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).not.toHaveBeenCalled();
  rpc.notify("turn/completed", {
    threadId: "child",
    turn: { id: "new", status: "completed" },
  });
  expect((await w.done).kind).toBe("completed");
  await w.close();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("CLI completion and interruption protocol", () => {
  it("enforces read-only tools in plan mode even for a full-access chat", async () => {
    job.sandbox = "dangerFullAccess";
    job.planMode = true;
    const w = worker();
    await w.start(auth);
    expect(rpc.call).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({ sandbox: "read-only" }),
    );
    expect(rpc.call).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("不要修改文件"),
          }),
        ]),
      }),
    );
  });
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

it("unknown final quota does not turn commentary into task completion", async () => {
  const w = worker();
  await w.start(auth);
  rpc.notify("item/completed", {
    threadId: "thread-1",
    item: { type: "agentMessage", phase: "commentary", text: "Working on it" },
  });
  rpc.call.mockImplementation(async () => ({}));
  rpc.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-2", status: "completed" },
  });
  await vi.advanceTimersByTimeAsync(800);
  expect((await w.done).kind).toBe("error");
});
it("a new thread is materialized before a task can pause during preparation", async () => {
  const w = worker();
  await w.start(auth);
  expect(rpc.calls.indexOf("thread/archive")).toBeLessThan(
    rpc.calls.indexOf("turn/start"),
  );
  expect(rpc.calls).toContain("thread/unarchive");
  expect(rpc.calls).toContain("thread/resume");
});

it("returns incomplete after a normal turn without the requested marker", async () => {
  job.completionMarker = "[DONE]";
  const w = worker();
  await w.start(auth);
  rpc.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-2",
    item: {
      type: "agentMessage",
      phase: "final_answer",
      text: "Partial result",
    },
  });
  rpc.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-2", status: "completed" },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await w.done).kind).toBe("incomplete");
});
it("quota exhaustion takes priority even when the final answer contains a completion marker", async () => {
  job.completionMarker = "[DONE]";
  const w = worker();
  await w.start(auth);
  rpc.used = 100;
  rpc.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-2",
    item: {
      type: "agentMessage",
      phase: "final_answer",
      text: "All done\n[DONE]",
    },
  });
  rpc.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-2", status: "completed" },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await w.done).kind).toBe("quota");
});
it("keeps child events separate and waits for active subagents before completing the parent", async () => {
  const w = worker(),
    parentChat = vi.fn(),
    childChat = vi.fn(),
    changed = vi.fn(),
    done = vi.fn();
  w.on("chat", parentChat);
  w.on("childChat", childChat);
  w.on("agent", changed);
  w.done.then(done);
  await w.start(auth);
  rpc.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-2",
    item: {
      id: "spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "thread-1",
      receiverThreadIds: ["child-1"],
      prompt: "inspect the source",
      model: "model-1",
      agentsStates: { "child-1": { status: "running", message: null } },
    },
  });
  rpc.notify("turn/started", {
    threadId: "child-1",
    turn: { id: "child-turn" },
  });
  rpc.notify("item/agentMessage/delta", {
    threadId: "child-1",
    turnId: "child-turn",
    itemId: "answer",
    delta: "Child progress",
  });
  expect(job.turnId).toBe("turn-2");
  expect(childChat).toHaveBeenCalledWith(
    "child-1",
    "item/agentMessage/delta",
    expect.objectContaining({ delta: "Child progress" }),
  );
  expect(
    parentChat.mock.calls.some(
      ([method, params]) =>
        method === "item/agentMessage/delta" && params.threadId === "child-1",
    ),
  ).toBe(false);
  rpc.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-2",
    item: {
      type: "agentMessage",
      phase: "final_answer",
      text: "Parent result",
    },
  });
  rpc.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-2", status: "completed" },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).not.toHaveBeenCalled();
  rpc.notify("turn/completed", {
    threadId: "child-1",
    turn: { id: "child-turn", status: "completed" },
  });
  expect((await w.done).kind).toBe("completed");
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ threadId: "child-1", status: "completed" }),
  );
  await w.close();
});
it("interrupts known child turns as well as the parent and never controls an unrelated thread", async () => {
  const w = worker();
  await w.start(auth);
  rpc.notify("thread/started", {
    thread: {
      id: "child-2",
      agentNickname: "Scout",
      source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1" } } },
    },
  });
  rpc.notify("turn/started", {
    threadId: "child-2",
    turn: { id: "child-turn-2" },
  });
  await expect(w.agentControl("unrelated", "interrupt")).rejects.toThrow(
    "不可控制",
  );
  const stop = w.stop();
  await vi.advanceTimersByTimeAsync(1000);
  await stop;
  expect(rpc.call).toHaveBeenCalledWith("turn/interrupt", {
    threadId: "child-2",
    turnId: "child-turn-2",
  });
  expect(rpc.call).toHaveBeenCalledWith("turn/interrupt", {
    threadId: "thread-1",
    turnId: "turn-2",
  });
  expect((await w.done).kind).toBe("interrupted");
  await w.close();
});
