import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopWorker } from "../src/core/desktop-worker";
import { defaults } from "../src/core/store";
import type { Job } from "../src/shared/types";
let w: any, job: Job;
beforeEach(() => {
  vi.useFakeTimers();
  job = {
    id: "job",
    accountId: "account",
    title: "test",
    prompt: "original",
    cwd: "/tmp",
    mode: "desktop",
    model: "",
    effort: "",
    bucket: "codex",
    state: "running",
    rotations: 0,
    createdAt: 0,
    updatedAt: 0,
    threadId: "thread",
    turnId: "turn",
    sandbox: "workspaceWrite",
    approvalPolicy: "on-request",
  };
  const store = { data: structuredClone(defaults) };
  w = new DesktopWorker(
    {
      job,
      home: "/unused",
      cli: "unused",
      resumePrompt: "resume",
      shouldStart: () => true,
      checkpoint: async (t, u) => {
        job.threadId = t;
        if (u) job.turnId = u;
      },
      refresh: async () => ({
        accessToken: "test",
        chatgptAccountId: "account",
        chatgptPlanType: "plus",
      }),
    },
    store as any,
    {} as any,
    "/unused",
  );
  w.cdp = {
    close: vi.fn(),
    call: vi.fn(async () => ({})),
    fill: vi.fn(async () => {}),
    clickForThread: vi.fn(async () => true),
  };
  w.turnStarted = true;
  w.quota = vi.fn(async () => ({
    codex: {
      primary: { usedPercent: 10 },
      secondary: null,
      observedAt: Date.now(),
      reached: false,
    },
  }));
});
afterEach(() => vi.useRealTimers());
function records(...payloads: any[]) {
  w.tail = {
    read: async () =>
      payloads.map((payload) => ({ type: "event_msg", payload })),
  };
}
describe("desktop rollout completion guard", () => {
  it("task_complete containing quota error is never successful", async () => {
    records({
      type: "task_complete",
      turn_id: "turn",
      error: {
        codex_error_info: "usageLimitExceeded",
        message: "usage exhausted",
      },
    });
    const read = w.readTranscript();
    await vi.advanceTimersByTimeAsync(1000);
    await read;
    expect((await w.done).kind).toBe("quota");
  });
  it("an automatic quota abort still rotates", async () => {
    records(
      {
        type: "error",
        codex_error_info: "usageLimitExceeded",
        message: "limit",
      },
      { type: "turn_aborted", turn_id: "turn" },
    );
    const read = w.readTranscript();
    await vi.advanceTimersByTimeAsync(1000);
    await read;
    expect((await w.done).kind).toBe("quota");
  });
  it("a normal turn really completes", async () => {
    records({
      type: "task_complete",
      turn_id: "turn",
      last_agent_message: "Finished changes and verification.",
    });
    const read = w.readTranscript();
    await vi.advanceTimersByTimeAsync(1000);
    await read;
    expect((await w.done).kind).toBe("completed");
  });
  it("ignores old turn terminal records", async () => {
    records({ type: "task_complete", turn_id: "old" });
    const done = vi.fn();
    w.done.then(done);
    await w.readTranscript();
    expect(done).not.toHaveBeenCalled();
  });
  it("a disconnected desktop becomes an error, not an endless running job", async () => {
    records();
    w.cdp.call.mockRejectedValue(new Error("connection closed"));
    await w.readTranscript();
    expect((await w.done).kind).toBe("error");
  });
  it("button click without stop confirmation fails closed", async () => {
    const stop = w.stop().catch((e: any) => e);
    await vi.advanceTimersByTimeAsync(21000);
    expect(await stop).toBeInstanceOf(Error);
    expect((await w.done).kind).toBe("error");
  });
});

it("an empty successful-looking terminal without quota evidence stays unresolved", async () => {
  w.quota.mockResolvedValue({});
  records({
    type: "task_complete",
    turn_id: "turn",
    last_agent_message: "Some output",
  });
  const read = w.readTranscript();
  await vi.advanceTimersByTimeAsync(1000);
  await read;
  expect((await w.done).kind).toBe("error");
});
it("a terminal record without a started turn cannot complete a job", async () => {
  w.turnStarted = false;
  records({
    type: "task_complete",
    turn_id: "turn",
    last_agent_message: "old final",
  });
  const done = vi.fn();
  w.done.then(done);
  await w.readTranscript();
  expect(done).not.toHaveBeenCalled();
});
it("does not release credentials while the bootstrap process is unconfirmed", async () => {
  const busy = new Set(["account"]);
  w.accounts = { busy };
  w.bootstrap = {
    close: vi.fn(async () => {
      throw new Error("still running");
    }),
  };
  w.cdp.close = vi.fn();
  w.leased = true;
  await expect(w.close()).rejects.toThrow("still running");
  expect(busy.has("account")).toBe(true);
});

it("does not click stop when another thread is selected", async () => {
  w.cdp.clickForThread.mockResolvedValue(false);
  await expect(w.stop()).rejects.toThrow("当前会话");
  expect((await w.done).kind).toBe("error");
  expect(w.cdp.clickForThread).toHaveBeenCalledWith(
    expect.any(String),
    "thread",
    '[data-thread-id="thread"]',
  );
});
it("cancels a pending bootstrap without waiting for its RPC timeout", async () => {
  w.turnStarted = false;
  w.bootstrap = { close: vi.fn(async () => {}) };
  await w.stop();
  expect(w.bootstrap.close).toHaveBeenCalledOnce();
  expect(() => w.assertStarting()).toThrow("已请求暂停");
});
it("records uncertain submission before sending and includes original goal on recovery", async () => {
  job.turnId = undefined;
  w.cdp.clickForThread.mockImplementationOnce(async () => {
    expect(job.desktopSubmissionPending).toBe(true);
    throw new Error("lost acknowledgment");
  });
  await expect(w.submitPrompt()).rejects.toThrow("lost acknowledgment");
  expect(job.desktopSubmissionPending).toBe(true);
  await w.submitPrompt();
  expect(w.cdp.fill).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.stringContaining("上次请求：\noriginal"),
  );
  records({ type: "task_started", turn_id: "new-turn" });
  w.turnStarted = false;
  await w.readTranscript();
  expect(job.desktopSubmissionPending).toBe(false);
  expect(job.turnId).toBe("new-turn");
});
it("a refused atomic click clears the unsent marker", async () => {
  w.cdp.clickForThread.mockResolvedValue(false);
  await expect(w.submitPrompt()).rejects.toThrow("任务未发送");
  expect(job.desktopSubmissionPending).toBe(false);
});
it("keeps the account lease when the quota probe cannot stop", async () => {
  w.probe = {
    close: vi.fn(async () => {
      throw new Error("probe still running");
    }),
  };
  const busy = new Set(["account"]);
  w.accounts = { busy };
  w.leased = true;
  await expect(w.close()).rejects.toThrow("probe still running");
  expect(busy.has("account")).toBe(true);
});

it("Desktop uses the same optional completion gate after quota verification", async () => {
  job.completionMarker = "[DONE]";
  records({
    type: "task_complete",
    turn_id: "turn",
    last_agent_message: "Not yet verified",
  });
  const read = w.readTranscript();
  await vi.advanceTimersByTimeAsync(1000);
  await read;
  expect((await w.done).kind).toBe("incomplete");
});
