import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/core/store";
import { Rpc } from "../src/core/rpc";
import { recoverJob } from "../src/core/recovery";
import { Scheduler } from "../src/core/scheduler";
import { vi } from "vitest";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-recovery-"));
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));
describe("crash recovery refuses duplicate writers", () => {
  it("keeps a persisted Goal budget stop held after checking a service shutdown owner",async()=>{
    const store=new Store(root);store.data.settings.resetWarmupEnabled=false;store.data.jobs=[{id:"budget",mode:"cli",state:"paused",resumeAfterShutdown:true,threadId:"thread",goal:{status:"budgetLimited"}} as any];await store.save();
    const disk=new Store(root);await disk.load();const job=disk.data.jobs[0];job.autoRecovery!.nextAttemptAt=0;const factory=vi.fn(),recover=vi.fn(async()=>{}),scheduler=new Scheduler(disk,{busy:new Set(),cancelLogin:async()=>{}} as any,{cli:factory,desktop:factory},recover);
    try{await(scheduler as any).tick();await Promise.all([...(scheduler as any).recoveryTasks.values()]);expect(recover).toHaveBeenCalledOnce();expect(job.state).toBe("needs_attention");expect(job.lastError).toContain("预算");expect(job.resumeAfterShutdown).toBeUndefined();expect(job.autoRecovery).toBeUndefined();expect(factory).not.toHaveBeenCalled();}finally{await scheduler.shutdown();}
  });
  it.each(["running","pausing","paused"])("automatically recovers a system shutdown checkpoint from %s without inventing a user pause",async(state)=>{
    const store=new Store(root);store.data.settings.resetWarmupEnabled=false;store.data.jobs=[{id:"system",mode:"cli",state,resumeAfterShutdown:true,controlRevision:7,threadId:"thread",goal:{status:"active"}} as any];await store.save();
    const disk=new Store(root);await disk.load();const job=disk.data.jobs[0];expect(job.stopIntent).toBeUndefined();expect(job.recoveryRequired).toBe(true);job.autoRecovery!.nextAttemptAt=0;
    const factory=vi.fn(),recover=vi.fn(async()=>{}),scheduler=new Scheduler(disk,{busy:new Set(),cancelLogin:async()=>{}} as any,{cli:factory,desktop:factory},recover);
    try{await(scheduler as any).tick();await Promise.all([...(scheduler as any).recoveryTasks.values()]);expect(job.state).toBe("queued");expect(job.goalStartRequested).toBe(true);expect(job.resumeAfterShutdown).toBeUndefined();expect(job.controlRevision).toBe(7);expect(factory).not.toHaveBeenCalled();}finally{await scheduler.shutdown();}
  });
  it("marks interrupted persisted jobs for global recovery gating", async () => {
    const s = new Store(root);
    s.data.jobs = [{ id: "a", state: "running" } as any];
    await s.save();
    const restored = new Store(root);
    await restored.load();
    expect(restored.data.jobs[0]).toMatchObject({
      state: "needs_attention",
      recoveryRequired: true,
      autoRecovery: { reason: "process", attempt: 1 },
    });
  });
  it.each(["pause", "cancel"] as const)(
    "retains a persisted %s through crash recovery",
    async (stopIntent) => {
      const s = new Store(root);
      s.data.jobs = [
        { id: "a", mode: "cli", state: "running", stopIntent } as any,
      ];
      await s.save();
      const restored = new Store(root);
      await restored.load();
      const job = restored.data.jobs[0];
      job.autoRecovery!.nextAttemptAt = 0;
      const factory = vi.fn();
      const accounts = { busy: new Set(), cancelLogin: async () => {} } as any;
      const scheduler = new Scheduler(
        restored,
        accounts,
        { cli: factory, desktop: factory },
        (j) => recoverJob(j, restored, accounts, root),
      );
      try {
        await (scheduler as any).tick();
        await Promise.all([...(scheduler as any).recoveryTasks.values()]);
        expect(job.state).toBe(stopIntent === "pause" ? "paused" : "cancelled");
        expect(job.recoveryRequired).toBe(false);
        expect(factory).not.toHaveBeenCalled();
      } finally {
        await scheduler.shutdown();
      }
    },
  );
  it.each(["unknown","completed","shutdown"])("keeps checking a live owner after restart and releases only once idle (%s)", async (kind) => {
    const s = new Store(root);
    s.data.jobs = [
      { id: "a", mode: "cli", state: "running", threadId: "original",
        ...(kind==="completed"?{completionPending:true,completion:{revision:1,startedAt:1,finishedAt:2}}:kind==="shutdown"?{resumeAfterShutdown:true}:{}) } as any,
    ];
    const home = s.jobHome("a");
    await fs.mkdir(home, { recursive: true });
    const lock = path.join(home, "relay-owner.json");
    await fs.writeFile(
      lock,
      JSON.stringify({ pid: process.pid, nonce: "test-owned" }),
    );
    await s.save();
    const restored = new Store(root);
    await restored.load();
    const job = restored.data.jobs[0];
    const factory = vi.fn();
    const accounts = { busy: new Set(), cancelLogin: async () => {} } as any;
    const scheduler = new Scheduler(
      restored,
      accounts,
      { cli: factory, desktop: factory },
      (j) => recoverJob(j, restored, accounts, root),
    );
    try {
      job.autoRecovery!.nextAttemptAt = 0;
      await (scheduler as any).tick();
      await Promise.all([...(scheduler as any).recoveryTasks.values()]);
      expect(job.recoveryRequired).toBe(true);
      expect(await fs.readFile(lock, "utf8")).toContain("test-owned");
      expect(job.autoRecovery!.attempt).toBe(2);
      // Fixture owner relinquishes its own lock. Recovery never removes a live lock.
      await fs.rm(lock);
      job.autoRecovery!.nextAttemptAt = 0;
      await (scheduler as any).tick();
      await Promise.all([...(scheduler as any).recoveryTasks.values()]);
      expect(job).toMatchObject({
        state: kind==="completed" ? "completed" : "queued",
        recoveryRequired: false,
        threadId: "original",
      });
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await scheduler.shutdown();
    }
  });
  it("refuses a still-live owner instead of deleting its lock", async () => {
    const file = path.join(root, "relay-owner.json");
    await fs.writeFile(
      file,
      JSON.stringify({ pid: process.pid, nonce: "test" }),
    );
    await expect(Rpc.assertHomeIdle(root)).rejects.toThrow("重复实例");
    expect(await fs.readFile(file, "utf8")).toContain("test");
  });
  it("refuses a malformed owner record", async () => {
    await fs.writeFile(path.join(root, "relay-owner.json"), "{bad");
    await expect(Rpc.assertHomeIdle(root)).rejects.toThrow("损坏");
  });
  it("preserves credentials when the desktop receipt is missing", async () => {
    const s = new Store(root);
    const home = s.jobHome("job");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "desktop-launch.json"),
      JSON.stringify({ nonce: "own" }),
    );
    await fs.writeFile(path.join(home, "auth.json"), "preserve");
    await expect(
      recoverJob({ id: "job", mode: "desktop" } as any, s, {} as any, root),
    ).rejects.toThrow("回执");
    expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe(
      "preserve",
    );
  });
});
