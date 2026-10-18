import { EventEmitter } from "node:events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Rpc } from "../src/core/rpc";
import { CliWorker } from "../src/core/cli-worker";
import type { Job } from "../src/shared/types";
vi.mock("../src/core/rpc", () => ({ Rpc: { open: vi.fn() } }));
class FakeRpc extends EventEmitter {
  used = 10;
  autoGoalTurn = true;
  interruptEmits = true;
  calls: string[] = [];
  call = vi.fn(async (method: string, params: any): Promise<any> => {
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
    if (method === "thread/start" || method === "thread/resume") {
      if (
        method === "thread/resume" &&
        params.config?.["features.goals"] &&
        this.autoGoalTurn
      )
        this.notify("turn/started", {
          threadId: params.threadId,
          turn: { id: "native-goal-turn" },
        });
      return {
        thread: { id: params.threadId || "thread-1" },
        model: "model-1",
      };
    }
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
    checkpoint: async (t, u, submitted = true) => {
      job.threadId = t;
      if (u) {
        job.turnId = u;
        if (submitted) {
          job.pendingMessage = undefined;
          job.attachments = undefined;
          job.review = undefined;
          job.goalStartRequested = false;
        }
      }
    },
    shouldStart: () => true,
    refresh: async () => auth,
  });
}
it("preserves adopted thread permissions while enforcing an explicitly selected read-only planning turn", async () => {
  job.threadId = "thread-1";
  job.preserveNativePermissions = true;
  const original = worker();
  await original.start(auth);
  const resume = rpc.call.mock.calls.find(
    ([method]) => method === "thread/resume",
  )![1];
  expect(resume).not.toHaveProperty("sandbox");
  expect(resume).not.toHaveProperty("approvalPolicy");
  await original.close();
  rpc.call.mockClear();
  job.planMode = true;
  const planned = worker();
  await planned.start(auth);
  const planningResume = rpc.call.mock.calls.find(
    ([method]) => method === "thread/resume",
  )![1];
  expect(planningResume.sandbox).toBe("read-only");
  await planned.close();
});
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
it("offers proactive question tools and resolves child-thread requests before filtering child chat events", async () => {
  const w = worker(),
    approval = vi.fn(),
    resolved = vi.fn();
  w.on("approval", approval);
  w.on("approvalResolved", resolved);
  await w.start(auth);
  expect(rpc.call).toHaveBeenCalledWith(
    "thread/start",
    expect.objectContaining({
      config: expect.objectContaining({
        "features.default_mode_request_user_input": true,
      }),
    }),
  );
  rpc.notify("thread/started", {
    thread: {
      id: "child",
      source: {
        subAgent: { thread_spawn: { parent_thread_id: job.threadId } },
      },
    },
  });
  rpc.emit("request", {
    id: 77,
    method: "item/tool/requestUserInput",
    params: { threadId: "child", questions: [] },
  });
  expect(approval).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "input", id: "77" }),
  );
  w.respond("77", { answers: {} });
  expect(rpc.respond).toHaveBeenCalledWith(77, { answers: {} });
  expect(resolved).not.toHaveBeenCalled();
  rpc.notify("serverRequest/resolved", { threadId: "child", requestId: 77 });
  expect(resolved).toHaveBeenCalledWith("77");
  await w.close();
});
it("holds a new native Goal turn open when the previous turn's final verification completes", async () => {
  const w = worker(),
    settled = vi.fn();
  w.done.then(settled);
  await w.start(auth);
  endParent();
  rpc.notify("turn/started", {
    threadId: job.threadId,
    turn: { id: "goal-next" },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).not.toHaveBeenCalled();
  expect(job.turnId).toBe("goal-next");
  // No new final answer: the previous turn's text cannot satisfy this one.
  rpc.notify("turn/completed", {
    threadId: job.threadId,
    turn: { id: "goal-next", status: "completed" },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await w.done).kind).toBe("error");
  await w.close();
});
it("keeps an active native Goal alive across a delayed continuation instead of completing its first round", async () => {
  const w = worker(),
    settled = vi.fn();
  w.done.then(settled);
  await w.start(auth);
  rpc.notify("thread/goal/updated", {
    threadId: job.threadId,
    goal: { threadId: job.threadId, status: "active" },
  });
  endParent();
  await vi.advanceTimersByTimeAsync(3000);
  expect(settled).not.toHaveBeenCalled();
  rpc.notify("turn/started", {
    threadId: job.threadId,
    turn: { id: "delayed-goal" },
  });
  rpc.notify("thread/goal/updated", {
    threadId: job.threadId,
    goal: { threadId: job.threadId, status: "complete" },
  });
  rpc.notify("turn/completed", {
    threadId: job.threadId,
    turn: { id: "delayed-goal", status: "completed" },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await w.done).kind).toBe("completed");
  await w.close();
});
it("can stop between native Goal rounds and prioritizes quota exhaustion over a later completion update", async () => {
  const w = worker();
  await w.start(auth);
  rpc.notify("thread/goal/updated", {
    threadId: job.threadId,
    goal: { threadId: job.threadId, status: "active" },
  });
  endParent();
  await vi.advanceTimersByTimeAsync(1000);
  rpc.used = 100;
  await w.quota();
  rpc.notify("thread/goal/updated", {
    threadId: job.threadId,
    goal: { threadId: job.threadId, status: "complete" },
  });
  expect((await w.done).kind).toBe("quota");
  await w.close();
});
it("settles a paused Goal while waiting for its next round without another inference turn", async () => {
  const w = worker();
  await w.start(auth);
  rpc.notify("thread/goal/updated", {
    threadId: job.threadId,
    goal: { threadId: job.threadId, status: "active" },
  });
  endParent();
  await vi.advanceTimersByTimeAsync(1000);
  rpc.notify("thread/goal/updated", {
    threadId: job.threadId,
    goal: { threadId: job.threadId, status: "paused" },
  });
  expect((await w.done).kind).toBe("goalStopped");
  expect(rpc.call.mock.calls.filter(([m]) => m === "turn/start")).toHaveLength(
    1,
  );
  await w.close();
});
it("interrupts a late native Goal turn after a user stop was already requested", async () => {
  const w = worker();
  await w.start(auth);
  rpc.interruptEmits = false;
  const stopping = w.stop();
  rpc.notify("turn/started", {
    threadId: job.threadId,
    turn: { id: "late-goal-turn" },
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(rpc.call).toHaveBeenCalledWith("turn/interrupt", {
    threadId: job.threadId,
    turnId: "late-goal-turn",
  });
  rpc.notify("turn/completed", {
    threadId: job.threadId,
    turn: { id: "late-goal-turn", status: "interrupted" },
  });
  await vi.advanceTimersByTimeAsync(1000);
  await stopping;
  expect((await w.done).kind).toBe("interrupted");
  await w.close();
});
it("preserves a native Goal budget stop while waiting for children to stop", async () => {
  const w = worker();
  await w.start(auth);
  rpc.notify("thread/goal/updated", {
    threadId: job.threadId,
    goal: { threadId: job.threadId, status: "budgetLimited" },
  });
  beginChild();
  endParent();
  await vi.advanceTimersByTimeAsync(1000);
  expect((await w.done).kind).toBe("goalStopped");
  expect(rpc.call).toHaveBeenCalledWith("turn/interrupt", {
    threadId: "child",
    turnId: "child-turn",
  });
  await w.close();
});
it("restores only status after quota rotation with automatic provenance and no objective or budget reset", async () => {
  job.threadId = "thread-1";
  job.goalResumeAfterQuota = true;
  const original = rpc.call.getMockImplementation()!;
  const goal = {
    threadId: job.threadId,
    objective: "Keep the existing evidence",
    status: "usageLimited",
    tokensUsed: 42,
    tokenBudget: 5000,
  };
  rpc.call.mockImplementation(async (method, params) =>
    method === "thread/goal/get"
      ? { goal }
      : method === "thread/goal/set"
        ? { goal: { ...goal, status: params.status } }
        : original(method, params),
  );
  const w = worker();
  await w.start(auth);
  expect(rpc.call).toHaveBeenCalledWith("thread/goal/set", {
    threadId: job.threadId,
    status: "active",
    origin: "automatic",
  });
  expect(job.goalResumeAfterQuota).toBe(false);
  expect(rpc.call.mock.calls.some(([m]) => m === "turn/start")).toBe(false);
  await w.close();
});
it("uses the saved model, effort and service tier for native Goal admission without a synthetic user turn", async () => {
  job.threadId = "thread-1";
  job.goalStartRequested = true;
  job.model = "model-1";
  job.effort = "low";
  job.serviceTier = "default";
  const original = rpc.call.getMockImplementation()!;
  rpc.call.mockImplementation(async (method, params) =>
    method === "thread/goal/get"
      ? { goal: { threadId: job.threadId, status: "active" } }
      : original(method, params),
  );
  const w = worker();
  await w.start(auth);
  expect(job.turnId).toBe("native-goal-turn");
  expect(rpc.call.mock.calls.some(([m]) => m === "turn/start")).toBe(false);
  expect(rpc.call).toHaveBeenCalledWith(
    "thread/resume",
    expect.objectContaining({
      model: "model-1",
      serviceTier: "default",
      config: expect.objectContaining({
        model_reasoning_effort: "low",
        "features.goals": true,
      }),
    }),
  );
  await w.close();
});
it("recovers a Goal blocked by a verified model rejection without resetting its budget or adding a manual turn", async () => {
  job.threadId = "thread-1";
  job.goalResumeAfterModelChange = true;
  const original = rpc.call.getMockImplementation()!;
  const goal = {
    threadId: job.threadId,
    status: "blocked",
    objective: "Keep evidence",
    tokensUsed: 42,
    tokenBudget: 5000,
  };
  rpc.call.mockImplementation(async (method, params) =>
    method === "thread/goal/get"
      ? { goal }
      : method === "thread/goal/set"
        ? { goal: { ...goal, status: params.status } }
        : original(method, params),
  );
  const w = worker();
  await w.start(auth);
  expect(rpc.call).toHaveBeenCalledWith("thread/goal/set", {
    threadId: job.threadId,
    status: "active",
    origin: "automatic",
  });
  expect(job.goalResumeAfterModelChange).toBe(false);
  expect(rpc.call.mock.calls.some(([m]) => m === "turn/start")).toBe(false);
  await w.close();
});
it.each(["paused", "budgetLimited", "complete"])(
  "does not reactivate a %s Goal because of a model recovery flag",
  async (status) => {
    job.threadId = "thread-1";
    job.goalResumeAfterModelChange = true;
    const original = rpc.call.getMockImplementation()!;
    rpc.call.mockImplementation(async (method, params) =>
      method === "thread/goal/get"
        ? { goal: { threadId: job.threadId, status } }
        : original(method, params),
    );
    const w = worker();
    await w.start(auth);
    expect(
      rpc.call.mock.calls.some(
        ([m]) => m === "thread/goal/set" || m === "turn/start",
      ),
    ).toBe(false);
    expect((await w.done).kind).toBe(
      status === "complete" ? "completed" : "goalStopped",
    );
    await w.close();
  },
);
it("classifies a root backend model rejection without classifying assistant content", async () => {
  job.model = "wanted";
  const w = worker();
  await w.start(auth);
  rpc.notify("turn/completed", {
    threadId: job.threadId,
    turn: {
      id: job.turnId,
      status: "failed",
      error: {
        message: JSON.stringify({
          status: 400,
          error: {
            type: "invalid_request_error",
            message:
              "The 'wanted' model is not supported when using Codex with a ChatGPT account.",
          },
        }),
        codexErrorInfo: "other",
      },
    },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await w.done).kind).toBe("modelUnavailable");
  await w.close();
});
it("delivers a pending user message to an automatically resumed Goal without starting a duplicate turn", async () => {
  job.threadId = "thread-1";
  job.goalResumeAfterQuota = true;
  job.pendingMessage = "FOLLOWUP_KEEP_42";
  job.attachments = [
    { type: "localImage", path: "/tmp/question.png", name: "question.png" },
  ];
  const original = rpc.call.getMockImplementation()!;
  rpc.call.mockImplementation(async (method, params) =>
    method === "thread/goal/get"
      ? { goal: { threadId: job.threadId, status: "active" } }
      : method === "thread/goal/set"
        ? { goal: { threadId: job.threadId, status: params.status } }
        : original(method, params),
  );
  const w = new CliWorker({
    job,
    home: "/tmp/never-used",
    cli: "never-launched",
    resumePrompt: "resume original work",
    checkpoint: async (threadId, turnId, submitted?: boolean) => {
      job.threadId = threadId;
      if (turnId) {
        job.turnId = turnId;
        if (submitted !== false) {
          job.pendingMessage = undefined;
          job.attachments = undefined;
        }
      }
    },
    shouldStart: () => true,
    refresh: async () => auth,
  });
  await w.start(auth);
  expect(rpc.call.mock.calls.some(([m]) => m === "turn/start")).toBe(false);
  expect(rpc.call).toHaveBeenCalledWith("turn/steer", {
    threadId: "thread-1",
    expectedTurnId: "native-goal-turn",
    input: [
      { type: "text", text: "FOLLOWUP_KEEP_42", text_elements: [] },
      { type: "localImage", path: "/tmp/question.png" },
    ],
  });
  expect(job.pendingMessage).toBeUndefined();
  await w.close();
});
it("does not automatically reactivate a paused Goal after quota recovery", async () => {
  job.threadId = "thread-1";
  job.goalResumeAfterQuota = true;
  const original = rpc.call.getMockImplementation()!;
  rpc.call.mockImplementation(async (method, params) =>
    method === "thread/goal/get"
      ? { goal: { threadId: job.threadId, status: "paused" } }
      : original(method, params),
  );
  const w = worker();
  await w.start(auth);
  expect((await w.done).kind).toBe("goalStopped");
  expect(
    rpc.call.mock.calls.some(([m]) =>
      ["thread/resume", "thread/goal/set", "turn/start"].includes(m),
    ),
  ).toBe(false);
  await w.close();
});
it("retains ordinary chat input until a delayed turn/start response is acknowledged", async () => {
  job.pendingMessage = "NORMAL_PENDING_42";
  job.attachments = [
    { type: "mention", path: "/tmp/note.txt", name: "note.txt" },
  ];
  const original = rpc.call.getMockImplementation()!;
  let accept!: () => void;
  rpc.call.mockImplementation(async (method, params) => {
    const value = await original(method, params);
    if (method === "turn/start")
      await new Promise<void>((resolve) => {
        accept = resolve;
      });
    return value;
  });
  const w = worker(),
    start = w.start(auth);
  await vi.advanceTimersByTimeAsync(0);
  expect(job.turnId).toBe("turn-2");
  expect(job.pendingMessage).toBe("NORMAL_PENDING_42");
  expect(job.attachments).toHaveLength(1);
  accept();
  await start;
  expect(job.pendingMessage).toBeUndefined();
  expect(job.attachments).toBeUndefined();
  await w.close();
});
it("preserves ordinary chat input when a started turn loses its acknowledgement", async () => {
  job.pendingMessage = "NORMAL_PENDING_42";
  job.attachments = [
    { type: "mention", path: "/tmp/note.txt", name: "note.txt" },
  ];
  const original = rpc.call.getMockImplementation()!;
  rpc.call.mockImplementation(async (method, params) => {
    const value = await original(method, params);
    if (method === "turn/start") throw Error("network timeout");
    return value;
  });
  const w = worker();
  await expect(w.start(auth)).rejects.toThrow("启动结果不确定");
  expect(job.turnId).toBe("turn-2");
  expect(job.pendingMessage).toBe("NORMAL_PENDING_42");
  expect(job.attachments).toHaveLength(1);
  expect(rpc.call.mock.calls.filter(([m]) => m === "turn/start")).toHaveLength(
    1,
  );
  await w.close();
});
function pendingGoal() {
  job.threadId = "thread-1";
  job.goalResumeAfterQuota = true;
  job.pendingMessage = "FOLLOWUP_KEEP_42";
  job.attachments = [
    { type: "localImage", path: "/tmp/question.png", name: "question.png" },
  ];
  const original = rpc.call.getMockImplementation()!;
  const goal = { threadId: job.threadId, status: "active" };
  rpc.call.mockImplementation(async (method, params) => {
    if (method === "thread/goal/get") return { goal };
    if (method === "thread/goal/set") {
      goal.status = params.status;
      return { goal };
    }
    return original(method, params);
  });
  return { goal, call: rpc.call.getMockImplementation()! };
}
it("retains the pending text and attachments until the native Goal steer acknowledgement", async () => {
  const { call } = pendingGoal();
  let accept!: () => void;
  rpc.call.mockImplementation((method, params) =>
    method === "turn/steer"
      ? new Promise((resolve) => {
          accept = () => resolve({});
        })
      : call(method, params),
  );
  const w = worker(),
    start = w.start(auth);
  await vi.advanceTimersByTimeAsync(0);
  expect(job.pendingMessage).toBe("FOLLOWUP_KEEP_42");
  expect(job.attachments).toHaveLength(1);
  accept();
  await start;
  expect(job.pendingMessage).toBeUndefined();
  expect(job.attachments).toBeUndefined();
  await w.close();
});
it("preserves unconfirmed Goal input on transport failure without falling back to another turn", async () => {
  const { call } = pendingGoal();
  rpc.call.mockImplementation((method, params) =>
    method === "turn/steer"
      ? Promise.reject(Error("network timeout"))
      : call(method, params),
  );
  const w = worker();
  await expect(w.start(auth)).rejects.toThrow("不会自动重发");
  expect(job.pendingMessage).toBe("FOLLOWUP_KEEP_42");
  expect(job.attachments).toHaveLength(1);
  expect(rpc.call.mock.calls.filter(([m]) => m === "turn/steer")).toHaveLength(
    1,
  );
  expect(rpc.call.mock.calls.some(([m]) => m === "turn/start")).toBe(false);
  await w.close();
});
it("retains Goal recovery authority and pending input when steer is explicitly rejected for quota", async () => {
  const { goal, call } = pendingGoal();
  rpc.call.mockImplementation((method, params) => {
    if (method === "turn/steer") {
      goal.status = "usageLimited";
      rpc.notify("thread/goal/updated", { threadId: job.threadId, goal });
      return Promise.reject({
        codexErrorInfo: "usageLimitExceeded",
        message: "Usage limit exceeded",
      });
    }
    return call(method, params);
  });
  const w = worker();
  await expect(w.start(auth)).rejects.toMatchObject({
    codexErrorInfo: "usageLimitExceeded",
  });
  expect(job.goalResumeAfterQuota).toBe(true);
  expect(job.pendingMessage).toBe("FOLLOWUP_KEEP_42");
  expect(job.attachments).toHaveLength(1);
  expect(rpc.call.mock.calls.some(([m]) => m === "turn/start")).toBe(false);
  await w.close();
});
it("sends the actual pending request once if the Goal finishes before the delayed resume reply", async () => {
  const { goal, call } = pendingGoal();
  rpc.call.mockImplementation(async (method, params) => {
    const value = await call(method, params);
    if (method === "thread/resume") {
      goal.status = "complete";
      rpc.notify("thread/goal/updated", { threadId: job.threadId, goal });
      rpc.notify("turn/completed", {
        threadId: job.threadId,
        turn: { id: "native-goal-turn", status: "completed" },
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return value;
  });
  const w = worker(),
    settled = vi.fn();
  w.done.then(settled);
  const start = w.start(auth);
  await vi.advanceTimersByTimeAsync(800);
  expect(settled).not.toHaveBeenCalled();
  expect(job.pendingMessage).toBe("FOLLOWUP_KEEP_42");
  await vi.advanceTimersByTimeAsync(200);
  await start;
  const starts = rpc.call.mock.calls.filter(([m]) => m === "turn/start");
  expect(starts).toHaveLength(1);
  expect(starts[0][1].input[0].text).toBe("FOLLOWUP_KEEP_42");
  expect(starts[0][1].input[1]).toEqual({
    type: "localImage",
    path: "/tmp/question.png",
  });
  expect(rpc.call.mock.calls.some(([m]) => m === "turn/steer")).toBe(false);
  endParent();
  await vi.advanceTimersByTimeAsync(1000);
  expect((await w.done).kind).toBe("completed");
  await w.close();
});
it("waits for the next actual Goal turn when the previous one ends during resume", async () => {
  const { call } = pendingGoal();
  rpc.call.mockImplementation(async (method, params) => {
    const value = await call(method, params);
    if (method === "thread/resume") {
      rpc.notify("turn/completed", {
        threadId: job.threadId,
        turn: { id: "native-goal-turn", status: "completed" },
      });
      setTimeout(
        () =>
          rpc.notify("turn/started", {
            threadId: job.threadId,
            turn: { id: "next-goal-turn" },
          }),
        500,
      );
    }
    return value;
  });
  const w = worker(),
    start = w.start(auth);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    rpc.call.mock.calls.some(([m]) => ["turn/start", "turn/steer"].includes(m)),
  ).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  await start;
  expect(rpc.call).toHaveBeenCalledWith(
    "turn/steer",
    expect.objectContaining({
      expectedTurnId: "next-goal-turn",
      input: expect.arrayContaining([
        expect.objectContaining({ text: "FOLLOWUP_KEEP_42" }),
      ]),
    }),
  );
  expect(rpc.call.mock.calls.some(([m]) => m === "turn/start")).toBe(false);
  await w.close();
});
it("bounds missing Goal admission and retains the pending message", async () => {
  pendingGoal();
  rpc.autoGoalTurn = false;
  const w = worker(),
    start = w.start(auth);
  const rejected = expect(start).rejects.toThrow("待发送消息已保留");
  await vi.advanceTimersByTimeAsync(11000);
  await rejected;
  expect(job.pendingMessage).toBe("FOLLOWUP_KEEP_42");
  expect(job.attachments).toHaveLength(1);
  expect(
    rpc.call.mock.calls.some(([m]) => ["turn/start", "turn/steer"].includes(m)),
  ).toBe(false);
  await w.close();
});
it("does not rewind a newer Goal turn when an earlier steer acknowledgement arrives", async () => {
  const { call } = pendingGoal();
  let accept!: () => void;
  rpc.call.mockImplementation((method, params) =>
    method === "turn/steer"
      ? new Promise((resolve) => {
          accept = () => resolve({});
        })
      : call(method, params),
  );
  const w = worker(),
    start = w.start(auth);
  await vi.advanceTimersByTimeAsync(0);
  rpc.notify("turn/completed", {
    threadId: job.threadId,
    turn: { id: "native-goal-turn", status: "completed" },
  });
  rpc.notify("turn/started", {
    threadId: job.threadId,
    turn: { id: "newer-goal-turn" },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(job.pendingMessage).toBe("FOLLOWUP_KEEP_42");
  accept();
  await start;
  expect(job.turnId).toBe("newer-goal-turn");
  expect(job.pendingMessage).toBeUndefined();
  await w.close();
});
it("bounds uncertain native Goal admission and never falls back to a second turn/start", async () => {
  job.threadId = "thread-1";
  job.goalStartRequested = true;
  rpc.autoGoalTurn = false;
  const original = rpc.call.getMockImplementation()!;
  rpc.call.mockImplementation(async (method, params) =>
    method === "thread/goal/get"
      ? { goal: { threadId: job.threadId, status: "active" } }
      : original(method, params),
  );
  const w = worker();
  const start = w.start(auth);
  const rejected = expect(start).rejects.toThrow("不会补发任务");
  await vi.advanceTimersByTimeAsync(11000);
  await rejected;
  expect(rpc.call.mock.calls.some(([m]) => m === "turn/start")).toBe(false);
  await w.close();
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
      excludeTurns: true,
    }),
  );
  const childResume = rpc.call.mock.calls.find(
    ([method, params]) =>
      method === "thread/resume" && params.threadId === "child",
  )![1];
  expect(childResume.sandbox).toBe("read-only"); // Explicit planning restriction still applies to descendants.
  expect(childResume).not.toHaveProperty("cwd");
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
it("preserves nested ancestry and creation settings across cross-agent messages and activity summaries", async () => {
  const w = worker(),
    updates = vi.fn();
  w.on("agent", updates);
  await w.start(auth);
  beginChild("child", "child-turn");
  rpc.notify("thread/started", {
    thread: {
      id: "nested",
      agentNickname: "Nested",
      source: { subAgent: { thread_spawn: { parent_thread_id: "child" } } },
    },
  });
  rpc.notify("item/completed", {
    threadId: "child",
    item: {
      type: "subAgentActivity",
      agentThreadId: "nested",
      agentPath: "child/nested",
      kind: "started",
      model: "nested-model",
      reasoningEffort: "high",
    },
  });
  rpc.notify("turn/started", {
    threadId: "nested",
    turn: { id: "nested-turn" },
  });
  rpc.notify("turn/completed", {
    threadId: "nested",
    turn: { id: "nested-turn", status: "completed" },
  });
  rpc.notify("item/completed", {
    threadId: "child",
    item: {
      type: "subAgentActivity",
      agentThreadId: "nested",
      agentPath: "child/nested",
      kind: "started",
    },
  });
  rpc.notify("item/completed", {
    threadId: "thread-1",
    item: {
      type: "collabAgentToolCall",
      tool: "sendMessage",
      senderThreadId: "thread-1",
      receiverThreadIds: ["nested", "unrelated"],
      prompt: "a status question",
      agentsStates: {},
    },
  });
  rpc.notify("item/completed", {
    threadId: "thread-1",
    item: {
      type: "subAgentActivity",
      agentThreadId: "nested",
      agentPath: "child/nested",
      kind: "interacted",
      model: null,
      reasoningEffort: null,
    },
  });
  const nested = updates.mock.calls
    .map(([a]) => a)
    .filter((a) => a.threadId === "nested")
    .at(-1);
  expect(nested).toMatchObject({
    parentThreadId: "child",
    model: "nested-model",
    effort: "high",
    status: "completed",
  });
  await expect(
    w.agentControl("unrelated", "send", "must not adopt a message target"),
  ).rejects.toThrow("不可控制");
  await w.close();
});
it("keeps stale child messages in history without overwriting current state or rotating the parent", async () => {
  const w = worker(),
    updates = vi.fn(),
    chats = vi.fn();
  w.on("agent", updates);
  w.on("childChat", chats);
  await w.start(auth);
  beginChild("child", "old");
  rpc.notify("turn/completed", {
    threadId: "child",
    turn: { id: "old", status: "completed" },
  });
  rpc.notify("turn/started", { threadId: "child", turn: { id: "new" } });
  rpc.notify("item/completed", {
    threadId: "child",
    turnId: "new",
    item: { type: "agentMessage", text: "current answer" },
  });
  rpc.notify("turn/started", { threadId: "child", turn: { id: "old" } });
  rpc.notify("item/completed", {
    threadId: "child",
    turnId: "old",
    item: { type: "agentMessage", text: "old answer" },
  });
  rpc.notify("turn/completed", {
    threadId: "child",
    turn: {
      id: "old",
      status: "failed",
      error: { codexErrorInfo: "usageLimitExceeded", message: "old quota" },
    },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(updates.mock.calls.at(-1)?.[0]).toMatchObject({
    turnId: "new",
    status: "running",
    message: "current answer",
  });
  expect(rpc.calls.filter((m) => m === "turn/interrupt")).toEqual([]);
  expect(chats).toHaveBeenCalledWith(
    "child",
    "item/completed",
    expect.objectContaining({ turnId: "old" }),
  );
  await w.close();
});
it("does not rewind a newer child turn when an older start response arrives", async () => {
  const w = worker(),
    updates = vi.fn();
  w.on("agent", updates);
  await w.start(auth);
  beginChild();
  rpc.notify("turn/completed", {
    threadId: "child",
    turn: { id: "child-turn", status: "completed" },
  });
  const original = rpc.call.getMockImplementation()!;
  rpc.call.mockImplementation(async (method, params) => {
    if (method === "turn/start" && params.threadId === "child") {
      rpc.notify("turn/started", {
        threadId: "child",
        turn: { id: "requested" },
      });
      rpc.notify("turn/completed", {
        threadId: "child",
        turn: { id: "requested", status: "completed" },
      });
      rpc.notify("turn/started", { threadId: "child", turn: { id: "newer" } });
      return { turn: { id: "requested" } };
    }
    return original(method, params);
  });
  await w.agentControl("child", "send", "follow up");
  expect(updates.mock.calls.at(-1)?.[0]).toMatchObject({
    turnId: "newer",
    status: "running",
  });
  await w.close();
});
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
  it("fails closed when the interrupt event is missing and process cleanup also fails", async () => {
    const w = worker();
    await w.start(auth);
    rpc.interruptEmits = false;
    rpc.close.mockRejectedValueOnce(new Error("process tree still alive"));
    const errors = vi.fn();
    w.on("stopError", errors);
    const stop = w.stop().catch((e) => e);
    await vi.advanceTimersByTimeAsync(21000);
    expect(await stop).toBeInstanceOf(Error);
    expect((await w.done).kind).toBe("error");
    expect(errors).toHaveBeenCalledOnce();
  });
  it("waits for confirmed process shutdown before settling a missing interrupt event", async () => {
    const w = worker();
    await w.start(auth);
    rpc.interruptEmits = false;
    let release!: () => void;
    rpc.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const done = vi.fn(),
      errors = vi.fn();
    w.done.then(done);
    w.on("stopError", errors);
    const stop = w.stop();
    await vi.advanceTimersByTimeAsync(21000);
    expect(rpc.close).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    rpc.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "interrupted" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).not.toHaveBeenCalled();
    release();
    await stop;
    expect((await w.done).kind).toBe("interrupted");
    expect(errors).not.toHaveBeenCalled();
    await w.close();
    expect(rpc.close).toHaveBeenCalledOnce();
  });
  it("retains quota recovery and the same thread after a missing interrupt event and confirmed close", async () => {
    const w = worker();
    await w.start(auth);
    rpc.notify("thread/goal/updated", {
      threadId: "thread-1",
      goal: {
        threadId: "thread-1",
        objective: "Finish work",
        status: "active",
        tokenBudget: null,
      },
    });
    rpc.interruptEmits = false;
    const errors = vi.fn();
    w.on("stopError", errors);
    rpc.used = 100;
    await w.quota();
    await vi.advanceTimersByTimeAsync(21000);
    expect((await w.done).kind).toBe("quota");
    expect(rpc.close).toHaveBeenCalledOnce();
    expect(job.threadId).toBe("thread-1");
    expect(job.goalResumeAfterQuota).toBe(true);
    expect(errors).not.toHaveBeenCalled();
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
