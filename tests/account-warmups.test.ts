import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Account, Quota } from "../src/shared/types";
import { Store } from "../src/core/store";
import { AccountWarmups } from "../src/core/account-warmups";
import { eligible } from "../src/core/quota";
import { ProcessSafetyError } from "../src/core/process-safety-error";
let root: string,
  store: Store,
  account: Account,
  manager: AccountWarmups | undefined;
function quota(
  used: number,
  reset: number,
  observed = Date.now(),
): Record<string, Quota> {
  return {
    codex: {
      limitId: "codex",
      observedAt: observed,
      reached: false,
      primary: { usedPercent: used, windowDurationMins: 300, resetsAt: reset },
      secondary: {
        usedPercent: 10,
        windowDurationMins: 10080,
        resetsAt: Date.now() + 86400000,
      },
    },
  };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-warmup-"));
  store = new Store(root);
  account = {
    id: "test",
    identity: "test",
    label: "test",
    email: "test",
    plan: "plus",
    status: "ready",
    enabled: true,
    failureCount: 0,
    blockedUntil: null,
    quotas: quota(0, Date.now() - 10000),
  };
  store.data.accounts = [account];
});
afterEach(async () => {
  await manager?.shutdown();
  manager = undefined;
  vi.restoreAllMocks();
  expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(root).startsWith("relay-warmup-")).toBe(true);
  await fs.rm(root, { recursive: true, force: true });
});
it("recognizes a fresh server counter reset before the old scheduled deadline", async () => {
  const now = Date.now(),
    reset = now + 60000,
    before = quota(90, reset, now - 30000),
    fresh = quota(0, now + 18000000);
  account.quotas = fresh;
  const runner = vi.fn();
  manager = new AccountWarmups(
    store,
    () => {},
    runner,
    () => false,
  );
  manager.observe(account, before, fresh);
  expect(account.warmups?.codex).toMatchObject({
    resetAt: reset,
    status: "queued",
  });
  expect(runner).not.toHaveBeenCalled();
});
it("does not mistake a zero-percent future placeholder for a started timer", async () => {
  const reset = Date.now() - 10000,
    fresh = quota(0, Date.now() + 18000000);
  account.quotas = fresh;
  manager = new AccountWarmups(
    store,
    () => {},
    vi.fn(),
    () => false,
  );
  manager.observe(account, quota(90, reset, reset - 1), fresh);
  expect(account.warmups?.codex.status).toBe("queued");
});
it("retains a proven boundary across restart and moving zero-percent observations", async () => {
  const start = Date.now(),
    reset = start + 60000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  manager = new AccountWarmups(
    store,
    () => {},
    vi.fn(),
    () => false,
  );
  const positive = quota(90, reset, start);
  account.quotas = positive;
  manager.observe(account, positive, positive);
  await manager.shutdown();
  const restored = new Store(root);
  await restored.load();
  store = restored;
  account = restored.data.accounts[0];
  clock.mockReturnValue(start + 120000);
  manager = new AccountWarmups(
    store,
    () => {},
    vi.fn(),
    () => false,
  );
  const fresh = quota(0, start + 120000 + 18000000);
  account.quotas = fresh;
  manager.observe(
    account,
    quota(0, start + 30000 + 18000000, start + 30000),
    fresh,
  );
  expect(account.warmups?.codex).toMatchObject({
    resetAt: reset,
    status: "queued",
  });
});
it("learns a stable zero-percent countdown without spending a turn", async () => {
  const now = Date.now(),
    next = now + 17000000,
    fresh = quota(0, next),
    runner = vi.fn();
  account.quotas = fresh;
  manager = new AccountWarmups(store, () => {}, runner);
  manager.observe(account, quota(0, next, now - 30000), fresh);
  expect(account.resetWindows?.codex).toMatchObject({
    resetAt: next,
    evidence: "stable",
  });
  expect(account.warmups).toBeUndefined();
  expect(runner).not.toHaveBeenCalled();
});
it("detects a proven zero-percent clock being replaced before its deadline", async () => {
  const now = Date.now(),
    oldNext = now + 12000000,
    before = quota(0, oldNext, now - 30000),
    middle = quota(0, oldNext, now - 1000),
    runner = vi.fn();
  manager = new AccountWarmups(
    store,
    () => {},
    runner,
    () => false,
  );
  account.quotas = middle;
  manager.observe(account, before, middle);
  const fresh = quota(0, now + 18000000);
  account.quotas = fresh;
  manager.observe(account, middle, fresh);
  expect(account.warmups?.codex).toMatchObject({
    resetAt: oldNext,
    status: "queued",
  });
  expect(runner).not.toHaveBeenCalled();
});
it("keeps a completed hi unconfirmed until the zero-percent timer stays stable", async () => {
  const now = Date.now(),
    reset = now - 30000,
    next = now + 17980000;
  const fresh = quota(0, reset),
    after = quota(0, next, now - 15000);
  account.quotas = fresh;
  const runner = vi.fn(() => ({
    admitted: true,
    done: Promise.resolve(after),
    stop: async () => {},
  }));
  manager = new AccountWarmups(store, () => {}, runner);
  manager.observe(account, quota(90, reset, reset - 1), fresh);
  await vi.waitFor(() => expect(account.warmups?.codex.status).toBe("sent"));
  const current = quota(0, next);
  account.quotas = current;
  manager.observe(account, after, current);
  expect(account.warmups?.codex.status).toBe("confirmed");
  manager.pump();
  expect(runner).toHaveBeenCalledTimes(1);
});
it("requeues an unsent foreground hand-off when the task ends without starting a clock", async () => {
  const now = Date.now(),
    reset = now - 10000,
    fresh = quota(0, now + 18000000),
    runner = vi.fn();
  account.quotas = fresh;
  manager = new AccountWarmups(
    store,
    () => {},
    runner,
    () => false,
  );
  manager.observe(account, quota(90, reset, reset - 1000), fresh, true);
  expect(account.warmups?.codex).toMatchObject({
    status: "covered",
  });
  expect(account.warmups?.codex.nextResetAt).toBeUndefined();
  const changed = quota(0, now + 18001000);
  account.quotas = changed;
  manager.observe(account, fresh, changed, false);
  expect(account.warmups?.codex.status).toBe("queued");
  expect(runner).not.toHaveBeenCalled();
});
it("does not treat a known weekly primary as five hours even when manually labelled", async () => {
  account.limitMode = "fiveHour";
  const reset = Date.now() - 10000,
    before = quota(90, reset, reset - 1),
    fresh = quota(0, reset);
  before.codex.primary!.windowDurationMins = 10080;
  fresh.codex.primary!.windowDurationMins = 10080;
  account.quotas = fresh;
  const runner = vi.fn();
  manager = new AccountWarmups(
    store,
    () => {},
    runner,
    () => false,
  );
  manager.observe(account, before, fresh);
  expect(account.warmups).toBeUndefined();
  expect(account.resetWindows).toBeUndefined();
});
it("refuses a five-hour timestamp that actually points a week into the future", async () => {
  const now = Date.now(),
    fresh = quota(0, now + 604800000),
    runner = vi.fn();
  account.quotas = fresh;
  manager = new AccountWarmups(
    store,
    () => {},
    runner,
    () => false,
  );
  manager.observe(account, quota(90, now - 1000, now - 2000), fresh);
  expect(account.warmups).toBeUndefined();
  expect(runner).not.toHaveBeenCalled();
});
it("requires a fresh server observation and sends only once for a reset, including after restart", async () => {
  const reset = Date.now() - 10000,
    before = quota(80, reset, reset - 1000),
    fresh = quota(0, reset);
  account.quotas = fresh;
  const runner = vi.fn(() => ({
    done: Promise.resolve(quota(1, Date.now() + 18000000)),
    stop: async () => {},
  }));
  manager = new AccountWarmups(store, () => {}, runner);
  manager.observe(account, before, fresh);
  manager.observe(account, before, fresh);
  await vi.waitFor(() =>
    expect(account.warmups?.codex.status).toBe("confirmed"),
  );
  expect(runner).toHaveBeenCalledTimes(1);
  await manager.shutdown();
  const reloaded = new Store(root);
  await reloaded.load();
  manager = new AccountWarmups(reloaded, () => {}, runner);
  await manager.recover();
  manager.observe(reloaded.data.accounts[0], before, fresh);
  manager.pump();
  expect(runner).toHaveBeenCalledTimes(1);
});
it("does not infer reset from the clock, missing windows, stale quota, or exhausted weekly allowance", async () => {
  const reset = Date.now() - 10000,
    before = quota(100, reset, reset - 1000);
  const runner = vi.fn();
  manager = new AccountWarmups(store, () => {}, runner);
  const stale = quota(0, reset, reset - 1);
  manager.observe(account, before, stale);
  const missing = quota(0, reset);
  missing.codex.primary = null;
  manager.observe(account, before, missing);
  const blocked = quota(0, reset);
  blocked.codex.secondary!.usedPercent = 100;
  account.quotas = blocked;
  manager.observe(account, before, blocked);
  expect(runner).not.toHaveBeenCalled();
  expect(account.warmups).toBeUndefined();
});
it("treats a real foreground turn as covering this reset without sending hi", async () => {
  const reset = Date.now() - 10000,
    fresh = quota(1, Date.now() + 18000000);
  account.quotas = fresh;
  const runner = vi.fn();
  manager = new AccountWarmups(store, () => {}, runner);
  manager.observe(account, quota(90, reset, reset - 1), fresh, true);
  expect(account.warmups?.codex.status).toBe("covered");
  expect(runner).not.toHaveBeenCalled();
});
it("confirms a delayed server timer without sending another hi", async () => {
  const reset = Date.now() - 10000,
    fresh = quota(0, reset);
  account.quotas = fresh;
  const runner = vi.fn(() => ({
    done: Promise.resolve(fresh),
    stop: async () => {},
  }));
  manager = new AccountWarmups(store, () => {}, runner);
  manager.observe(account, quota(80, reset, reset - 1), fresh);
  await vi.waitFor(() => expect(account.warmups?.codex.status).toBe("sent"));
  const updated = quota(1, Date.now() + 18000000);
  account.quotas = updated;
  manager.observe(account, updated, updated);
  expect(account.warmups?.codex.status).toBe("confirmed");
  manager.pump();
  expect(runner).toHaveBeenCalledTimes(1);
});
it("queues while foreground owns the account and covers it when that task starts the timer", async () => {
  const reset = Date.now() - 10000,
    fresh = quota(0, reset);
  account.quotas = fresh;
  const runner = vi.fn();
  manager = new AccountWarmups(
    store,
    () => {},
    runner,
    () => false,
  );
  manager.observe(account, quota(80, reset, reset - 1), fresh);
  expect(account.warmups?.codex.status).toBe("queued");
  const updated = quota(1, Date.now() + 18000000);
  account.quotas = updated;
  manager.observe(account, updated, updated, true);
  expect(account.warmups?.codex.status).toBe("covered");
  expect(runner).not.toHaveBeenCalled();
});
it("yields an admitted warmup to foreground work without retrying it, and frees only a proven stopped account", async () => {
  const reset = Date.now() - 10000,
    fresh = quota(0, reset);
  account.quotas = fresh;
  let reject!: (e: Error) => void;
  const done = new Promise<Record<string, Quota>>((_, no) => {
    reject = no;
  });
  const stop = vi.fn(async () => {
    reject(new Error("preempted"));
  });
  const runner = vi.fn(() => ({ done, stop, admitted: true }));
  manager = new AccountWarmups(store, () => {}, runner);
  manager.observe(account, quota(90, reset, reset - 1), fresh);
  await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
  expect(eligible(account, "codex", Date.now())).toBe(false);
  await manager.yieldToTask();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(account.warmups?.codex.status).toBe("yielded");
  expect(eligible(account, "codex", Date.now())).toBe(true);
  manager.observe(account, quota(90, reset, reset - 1), fresh);
  manager.pump();
  expect(runner).toHaveBeenCalledTimes(1);
});
it("retains an unsafe account after failed process verification, then recovers idle ownership without replaying inference", async () => {
  const reset = Date.now() - 10000,
    fresh = quota(0, reset);
  account.quotas = fresh;
  const runner = vi.fn(() => ({
    done: Promise.reject(
      new ProcessSafetyError("not stopped", new Error("timeout")),
    ),
    stop: async () => {},
  }));
  manager = new AccountWarmups(store, () => {}, runner);
  manager.observe(account, quota(90, reset, reset - 1), fresh);
  await vi.waitFor(() =>
    expect(account.warmups?.codex.status).toBe("uncertain"),
  );
  expect(eligible(account, "codex", Date.now())).toBe(false);
  await manager.recover();
  expect(account.warmups?.codex.processSafe).toBe(true);
  expect(eligible(account, "codex", Date.now())).toBe(true);
  manager.pump();
  expect(runner).toHaveBeenCalledTimes(1);
});
