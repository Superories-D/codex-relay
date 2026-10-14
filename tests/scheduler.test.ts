import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/core/scheduler";
import { Store } from "../src/core/store";
import { ProcessSafetyError } from "../src/core/process-safety-error";
import type { Worker, WorkerContext, Outcome } from "../src/core/worker";
import type { Account, NewJob } from "../src/shared/types";
class FakeWorker extends EventEmitter implements Worker {
  settle!: (o: Outcome) => void;
  done = new Promise<Outcome>((r) => {
    this.settle = r;
  });
  started = false;
  failClose = false;
  constructor(public ctx: WorkerContext) {
    super();
  }
  async start() {
    await this.ctx.checkpoint(
      "stable-thread",
      this.ctx.job.turnId ?? "first-turn",
    );
    this.started = true;
  }
  async stop() {
    this.settle({ kind: "interrupted" });
  }
  async close() {
    if (this.failClose) throw new Error("Still running");
  }
  async quota() {
    return {};
  }
  respond() {}
}
let root: string;
let store: Store;
let scheduler: Scheduler;
let workers: FakeWorker[];
const input: NewJob = {
  title: "Test",
  prompt: "Finish original task",
  cwd: "",
  mode: "cli",
  model: "",
  effort: "",
  bucket: "codex",
  approvalPolicy: "on-request",
  sandbox: "workspaceWrite",
};
function account(id: string): Account {
  return {
    id,
    identity: id,
    label: id,
    email: id,
    plan: "plus",
    enabled: true,
    status: "ready",
    quotas: {
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: Date.now() + 60_000,
        },
        secondary: null,
        observedAt: Date.now(),
        reached: false,
      },
    },
    blockedUntil: null,
    failureCount: 0,
  };
}
const until = async (fn: () => boolean) => {
  await vi.waitFor(() => expect(fn()).toBe(true), {
    timeout: 5000,
    interval: 5,
  });
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-test-"));
  store = new Store(root);
  store.data.accounts = [account("a"), account("b")];
  workers = [];
  const accounts = {
    busy: new Set(),
    inspect: vi.fn(async (id: string) => {
      const a = store.data.accounts.find((a) => a.id === id)!;
      a.quotas.codex.observedAt = Date.now();
      return {
        auth: { tokens: { access_token: "synthetic" } },
        quotas: a.quotas,
        models: [],
      };
    }),
    cancelLogin: async () => {},
  };
  const factory = (ctx: WorkerContext) => {
    const w = new FakeWorker(ctx);
    workers.push(w);
    return w;
  };
  scheduler = new Scheduler(store, accounts as any, {
    cli: factory,
    desktop: factory,
  });
});
afterEach(async () => {
  for (const w of workers) {
    w.failClose = false;
    w.settle({ kind: "interrupted" });
  }
  await scheduler.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});
describe("supervisor state transitions", () => {
  it("rotates on exhaustion, keeps the thread and finishes only after a successful run", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    const q = store.data.accounts[0].quotas.codex;
    q.primary!.usedPercent = 100;
    workers[0].settle({ kind: "quota" });
    await (scheduler as any).currentRun;
    expect(job.state).toBe("queued");
    expect(job.rotations).toBe(1);
    expect(job.threadId).toBe("stable-thread");
    await (scheduler as any).tick();
    await until(() => workers[1]?.started);
    expect(job.accountId).toBe("b");
    workers[1].settle({ kind: "completed" });
    await (scheduler as any).currentRun;
    expect(job.state).toBe("completed");
  });
  it("waits rather than marking the task complete when every account is exhausted", async () => {
    for (const a of store.data.accounts)
      a.quotas.codex.primary!.usedPercent = 100;
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => job.state === "waiting");
    expect(workers).toHaveLength(0);
    expect(job.nextWakeAt).toBeGreaterThan(Date.now());
  });
  it("resumes a waiting task only after a fresh positive quota observation", async () => {
    for (const a of store.data.accounts)
      a.quotas.codex.primary!.usedPercent = 100;
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => job.state === "waiting");
    job.nextWakeAt = Date.now() - 1;
    await (scheduler as any).tick();
    expect(workers).toHaveLength(0);
    store.data.accounts[1].quotas.codex.primary!.usedPercent = 0;
    store.data.accounts[1].quotas.codex.observedAt = Date.now();
    job.nextWakeAt = Date.now() - 1;
    await (scheduler as any).tick();
    await until(() => workers[0]?.started);
    expect(job.accountId).toBe("b");
  });
  it("manual pause has priority over quota rotation", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    await scheduler.control(job.id, "pause");
    await (scheduler as any).currentRun;
    expect(job.state).toBe("paused");
    expect(job.rotations).toBe(0);
  });
  it("never starts another worker when the old process cannot be confirmed closed", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    workers[0].failClose = true;
    workers[0].settle({ kind: "quota" });
    await (scheduler as any).currentRun;
    expect(job.state).toBe("needs_attention");
    await (scheduler as any).tick();
    expect(workers).toHaveLength(1);
    workers[0].failClose = false;
    await scheduler.control(job.id, "resume");
    await (scheduler as any).tick();
    await until(() => workers[1]?.started);
  });
  it("freezes the entire queue until interrupted jobs are explicitly recovered", async () => {
    store.data.jobs.push({
      ...input,
      id: "old",
      state: "needs_attention",
      recoveryRequired: true,
      rotations: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const job = await scheduler.add({ ...input, cwd: root });
    await (scheduler as any).tick();
    expect(workers).toHaveLength(0);
    expect(job.state).toBe("queued");
    await scheduler.control("old", "cancel");
    await (scheduler as any).tick();
    await until(() => workers[0]?.started);
    expect(store.data.jobs[0].recoveryRequired).toBe(false);
  });
  it("shutdown waits for the running worker to finish saving", async () => {
    const job = await scheduler.add({ ...input, cwd: root });
    await until(() => workers[0]?.started);
    await scheduler.shutdown();
    expect(job.state).toBe("paused");
    const persisted = JSON.parse(
      await fs.readFile(path.join(root, "state.json"), "utf8"),
    );
    expect(persisted.jobs[0].state).toBe("paused");
  });
});

// These regressions exercise public controls while asynchronous preparation is pending.
it("completed jobs cannot be resurrected through pause then resume", async () => {
  store.data.jobs.push({
    ...input,
    id: "done",
    state: "completed",
    rotations: 0,
    createdAt: 0,
    updatedAt: 0,
  });
  await expect(scheduler.control("done", "pause")).rejects.toThrow();
  expect(store.data.jobs[0].state).toBe("completed");
});
it("shutdown waits for an idle quota probe and never starts a worker afterwards", async () => {
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const inspect = scheduler.accounts.inspect.bind(scheduler.accounts);
  vi.spyOn(scheduler.accounts, "inspect").mockImplementationOnce(async (id) => {
    entered = true;
    await gate;
    return inspect(id);
  });
  await scheduler.add({ ...input, cwd: root });
  await until(() => entered);
  const ended = vi.fn();
  const shutdown = scheduler.shutdown().then(ended);
  await new Promise((r) => setTimeout(r, 10));
  const returnedBeforeProbeEnded = ended.mock.calls.length > 0;
  release();
  await shutdown;
  await until(() => (scheduler as any).ticking === false);
  expect(returnedBeforeProbeEnded).toBe(false);
  expect(workers).toHaveLength(0);
});

it("a newly available account wakes a job before the old reset deadline", async () => {
  for (const a of store.data.accounts)
    a.quotas.codex.primary!.usedPercent = 100;
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => job.state === "waiting");
  await (scheduler as any).tick();
  job.nextWakeAt = Date.now() + 7 * 86400000;
  store.data.accounts.push(account("new"));
  await (scheduler as any).tick();
  await until(() => workers[0]?.started);
  expect(job.accountId).toBe("new");
});
it("failed close persists the global recovery gate across restart", async () => {
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => workers[0]?.started);
  workers[0].failClose = true;
  workers[0].settle({ kind: "quota" });
  await (scheduler as any).currentRun;
  const restored = new Store(root);
  await restored.load();
  expect(restored.data.jobs[0].recoveryRequired).toBe(true);
  workers[0].failClose = false;
});
it("an unconfirmed process left by preparation freezes the entire queue", async () => {
  const original = vi
    .mocked(scheduler.accounts.inspect)
    .getMockImplementation()!;
  vi.spyOn(scheduler.accounts, "inspect").mockImplementation(
    async (id, force) => {
      if (force)
        throw new ProcessSafetyError(
          "cannot stop initialization process",
          new Error("test"),
        );
      return original(id, force);
    },
  );
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => job.state === "needs_attention");
  await (scheduler as any).currentRun;
  expect(job.recoveryRequired).toBe(true);
  await (scheduler as any).tick();
  expect(workers).toHaveLength(0);
});
it("shutdown waits for completion persistence without trying to pause a terminal job", async () => {
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => workers[0]?.started);
  const originalSave = store.save.bind(store);
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(store, "save").mockImplementation(async () => {
    if (job.state === "completed") {
      entered = true;
      await gate;
    }
    return originalSave();
  });
  workers[0].settle({ kind: "completed" });
  await until(() => entered);
  const result = scheduler.shutdown().then(
    () => "ok",
    (error) => error,
  );
  release();
  expect(await result).toBe("ok");
  expect(job.state).toBe("completed");
});

it("does not probe an unavailable account before dispatching a known available one", async () => {
  store.data.accounts[0].status = "offline";
  store.data.accounts[0].quotas = {};
  const inspect = vi.mocked(scheduler.accounts.inspect);
  const job = await scheduler.add({ ...input, cwd: root });
  await until(() => workers[0]?.started);
  expect(job.accountId).toBe("b");
  expect(inspect.mock.calls.every(([id]) => id === "b")).toBe(true);
});
it("limits idle quota refresh to one account per dispatch cycle", async () => {
  const inspect = vi.mocked(scheduler.accounts.inspect);
  await (scheduler as any).tick();
  expect(inspect).toHaveBeenCalledTimes(1);
  await (scheduler as any).tick();
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(inspect.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
});
