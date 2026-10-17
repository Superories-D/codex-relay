import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/core/store";
import { Rpc } from "../src/core/rpc";
import { WarmupRunner } from "../src/core/warmup-runner";
import { ProcessSafetyError } from "../src/core/process-safety-error";
import type { Account } from "../src/shared/types";
vi.mock("../src/core/rpc", () => ({ Rpc: { open: vi.fn() } }));
let root: string, store: Store, rpc: any, accounts: any, account: Account;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-warmup-runner-"));
  store = new Store(root);
  account = {
    id: "test",
    identity: "test",
    label: "test",
    email: "test",
    plan: "plus",
    enabled: true,
    status: "ready",
    failureCount: 0,
    blockedUntil: null,
    quotas: {},
  };
  accounts = {
    busy: new Set(),
    inspect: vi.fn(async () => ({
      auth: { tokens: { access_token: "synthetic" } },
      quotas: {
        codex: {
          limitId: "codex",
          observedAt: Date.now(),
          reached: false,
          primary: { usedPercent: 0 },
          secondary: null,
        },
      },
      models: [
        { model: "large", isDefault: true },
        {
          model: "test-mini",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        },
      ],
    })),
  };
  rpc = new EventEmitter();
  rpc.reject = vi.fn();
  rpc.close = vi.fn(async () => rpc.emit("disconnected"));
  rpc.call = vi.fn(async (method: string) => {
    if (method === "thread/start") return { thread: { id: "thread" } };
    if (method === "turn/start") {
      rpc.emit("notification", {
        method: "turn/started",
        params: { threadId: "thread", turn: { id: "turn" } },
      });
      return { turn: { id: "turn" } };
    }
    if (method === "account/rateLimits/read")
      return {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 1,
            windowDurationMins: 300,
            resetsAt: Math.floor(Date.now() / 1000) + 18000,
          },
        },
      };
    return {};
  });
  vi.mocked(Rpc.open).mockResolvedValue(rpc);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(root).startsWith("relay-warmup-runner-")).toBe(true);
  await fs.rm(root, { recursive: true, force: true });
});
function complete(status = "completed", threadId = "thread") {
  rpc.emit("notification", {
    method: "turn/completed",
    params: { threadId, turn: { id: "turn", status } },
  });
}
async function started() {
  await vi.waitFor(() =>
    expect(
      rpc.call.mock.calls.some(([m]: [string]) => m === "turn/start"),
    ).toBe(true),
  );
}
it("persists the owned runtime before one minimal, ephemeral, read-only turn, then requires its terminal notification", async () => {
  const checkpoint = vi.fn(async (home: string) => {
    expect(
      home.startsWith(path.join(root, "runtime", "warmups") + path.sep),
    ).toBe(true);
    expect(Rpc.open).not.toHaveBeenCalled();
  });
  const runner = new WarmupRunner(store, accounts, account, checkpoint),
    settled = vi.fn();
  runner.done.then(settled);
  await started();
  expect(checkpoint).toHaveBeenCalledTimes(1);
  expect(accounts.busy.has(account.id)).toBe(true);
  expect(
    rpc.call.mock.calls.find(([m]: [string]) => m === "thread/start")[1],
  ).toMatchObject({
    model: "test-mini",
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    config: {
      "features.goals": false,
      "features.multi_agent": false,
      "features.shell_tool": false,
    },
  });
  expect(
    rpc.call.mock.calls.find(([m]: [string]) => m === "turn/start")[1],
  ).toMatchObject({
    effort: "low",
    serviceTier: "default",
    input: [{ type: "text", text: expect.stringContaining("hi") }],
  });
  complete("completed", "foreign");
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  rpc.emit("request", { id: 10 });
  expect(rpc.reject).toHaveBeenCalledWith(10, expect.any(String));
  complete();
  expect((await runner.done).codex.primary?.resetsAt).toBeGreaterThan(
    Date.now(),
  );
  expect(accounts.busy.has(account.id)).toBe(false);
  expect(
    rpc.call.mock.calls.filter(([m]: [string]) => m === "turn/start"),
  ).toHaveLength(1);
});
it("cancels before admission while credential inspection is pending", async () => {
  let release!: () => void;
  const original = accounts.inspect;
  accounts.inspect = vi.fn(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return original();
  });
  const runner = new WarmupRunner(store, accounts, account);
  const rejected = expect(runner.done).rejects.toThrow("取消");
  const stopping = runner.stop();
  release();
  await stopping;
  await rejected;
  expect(runner.admitted).toBe(false);
  expect(Rpc.open).not.toHaveBeenCalled();
});
it("does not spend a turn if another activity already started the timer before execution", async () => {
  const next = Date.now() + 18000000;
  const original = accounts.inspect;
  accounts.inspect = vi.fn(async () => {
    const result = await original();
    result.quotas.codex.primary.resetsAt = next;
    result.quotas.codex.primary.usedPercent = 1;
    result.quotas.codex.primary.windowDurationMins = 300;
    return result;
  });
  const runner = new WarmupRunner(
    store,
    accounts,
    account,
    async () => {},
    Date.now() - 10000,
  );
  expect((await runner.done).codex.primary?.resetsAt).toBe(next);
  expect(runner.admitted).toBe(false);
  expect(Rpc.open).not.toHaveBeenCalled();
});
it("never treats an interrupted turn as success and retains ownership after an unproven close", async () => {
  const runner = new WarmupRunner(store, accounts, account);
  const rejected = expect(runner.done).rejects.toBeInstanceOf(
    ProcessSafetyError,
  );
  await started();
  rpc.close.mockRejectedValue(
    new ProcessSafetyError("still alive", Error("timeout")),
  );
  complete("interrupted");
  await rejected;
  expect(accounts.busy.has(account.id)).toBe(true);
});
it("sends one hi when the fresh zero-percent future date is still moving", async () => {
  const original = accounts.inspect;
  accounts.inspect = vi.fn(async () => {
    const result = await original();
    result.quotas.codex.primary = {
      usedPercent: 0,
      windowDurationMins: 300,
      resetsAt: Date.now() + 18000000,
    };
    return result;
  });
  account.quotas = {
    codex: {
      limitId: "codex",
      observedAt: Date.now() - 30000,
      reached: false,
      primary: {
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: Date.now() + 18000000 - 30000,
      },
      secondary: null,
    },
  };
  const runner = new WarmupRunner(
    store,
    accounts,
    account,
    async () => {},
    Date.now() - 10000,
  );
  await started();
  complete();
  await runner.done;
  expect(runner.admitted).toBe(true);
  expect(
    rpc.call.mock.calls.filter(([m]: [string]) => m === "turn/start"),
  ).toHaveLength(1);
});
it("does not send hi when two fresh zero-percent observations prove a stable countdown", async () => {
  const now = Date.now(),
    next = now + 17000000,
    original = accounts.inspect;
  account.quotas = {
    codex: {
      limitId: "codex",
      observedAt: now - 30000,
      reached: false,
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: next },
      secondary: null,
    },
  };
  accounts.inspect = vi.fn(async () => {
    const result = await original();
    result.quotas.codex.primary = {
      usedPercent: 0,
      windowDurationMins: 300,
      resetsAt: next,
    };
    return result;
  });
  const runner = new WarmupRunner(
    store,
    accounts,
    account,
    async () => {},
    next + 10000,
  );
  await runner.done;
  expect(runner.admitted).toBe(false);
  expect(Rpc.open).not.toHaveBeenCalled();
});
it("bounds the wait and does not retry an admitted turn with an unknown result", async () => {
  vi.useFakeTimers();
  const runner = new WarmupRunner(store, accounts, account);
  const rejected = expect(runner.done).rejects.toThrow("超时");
  await started();
  await vi.advanceTimersByTimeAsync(60000);
  await rejected;
  expect(runner.admitted).toBe(true);
  expect(
    rpc.call.mock.calls.filter(([m]: [string]) => m === "turn/start"),
  ).toHaveLength(1);
});
