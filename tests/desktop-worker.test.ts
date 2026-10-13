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
  w.cdp = { call: vi.fn(async () => ({})), click: vi.fn(async () => true) };
  w.turnStarted = true;
  w.quota = vi.fn(async () => ({}));
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
