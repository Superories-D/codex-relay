import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Desktop, nextSchedule } from "../src/core/desktop";
import { Store } from "../src/core/store";
import { Scheduler } from "../src/core/scheduler";
import { Schedules, type ScheduleInput } from "../src/core/schedules";

let root: string,
  desktop: Desktop,
  store: Store,
  scheduler: Scheduler,
  schedules: Schedules;
let now: number;
const input = (): ScheduleInput => ({
  title: "Scheduled fixture",
  prompt: "Only a synthetic fixture",
  cwd: root,
  enabled: true,
  cadence: "interval",
  minutes: 5,
  hour: 9,
  minute: 30,
  weekday: 1,
  worktree: false,
});
async function create(due = false) {
  await schedules.save(input());
  const task = desktop.data.schedules.at(-1)!;
  if (due) {
    task.nextRun = now - 86400000;
    await desktop.save();
  }
  return task;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-schedules-"));
  desktop = new Desktop(root);
  store = new Store(root);
  now = Date.now();
  scheduler = new Scheduler(
    store,
    { busy: new Set(), cancelLogin: async () => {} } as any,
    {
      cli: () => {
        throw Error("No inference is permitted in this fixture");
      },
      desktop: () => {
        throw Error("No Desktop worker expected");
      },
    },
  );
  schedules = new Schedules(
    desktop,
    scheduler,
    () => {},
    () => now,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await schedules.shutdown();
  await scheduler.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

it("coalesces manual and timer admission into one persisted job and one occurrence", async () => {
  const task = await create(true);
  const [a, b] = await Promise.all([
    schedules.run(task.id),
    schedules.run(task.id),
    schedules.tick(),
  ]);
  expect(a!.id).toBe(b!.id);
  expect(store.data.jobs).toHaveLength(1);
  expect(a!.schedule).toMatchObject({ taskId: task.id, requestedAt: now });
  expect(task.pendingRun).toBeUndefined();
  expect(task.lastJobId).toBe(a!.id);
  expect(task.nextRun).toBe(now + 300000);
  await schedules.tick();
  expect(store.data.jobs).toHaveLength(1);
  const restored = new Desktop(root);
  await restored.load();
  expect(restored.data.schedules[0].lastJobId).toBe(a!.id);
});

it("does not postpone a future cadence when run manually", async () => {
  const task = await create();
  const due = task.nextRun;
  now += 60000;
  await schedules.run(task.id);
  expect(task.nextRun).toBe(due);
});

it("does not accumulate jobs behind an unfinished, paused or unsafe previous run", async () => {
  const task = await create(true);
  const job = (await schedules.run(task.id))!;
  for (const state of ["waiting", "paused", "needs_attention"] as const) {
    job.state = state;
    now = task.nextRun;
    await schedules.tick();
    expect(store.data.jobs).toHaveLength(1);
    expect(task.lastError).toContain("上一次运行");
    expect(task.nextRun).toBeGreaterThan(now);
  }
  job.state = "completed";
  job.recoveryRequired = true;
  await expect(schedules.run(task.id)).rejects.toThrow("上一次运行");
  job.recoveryRequired = false;
  await schedules.run(task.id);
  expect(store.data.jobs).toHaveLength(2);
});

it("does not resurrect a deleted schedule from a stale editor or start disabled due work", async () => {
  const task = await create(true);
  await schedules.save({ ...input(), id: task.id, enabled: false });
  task.nextRun = now - 1;
  await schedules.tick();
  expect(store.data.jobs).toHaveLength(0);
  await schedules.remove(task.id);
  await expect(schedules.save({ ...input(), id: task.id })).rejects.toThrow(
    "不存在",
  );
  await expect(schedules.run(task.id)).rejects.toThrow("不存在");
  expect(desktop.data.schedules).toHaveLength(0);
});
it("guards stale configuration revisions inside the shared disk transaction",async()=>{
  const task=await create(),revision=task.revision!;
  const other=new Schedules(desktop,scheduler,()=>{},()=>now);
  const stale={...input(),id:task.id,revision};
  const results=await Promise.allSettled([
    schedules.save({...stale,prompt:"Winning edit",deliveryChecks:[{kind:"file",path:"winner.txt",label:"Winner",minBytes:1}]}),
    other.save({...stale,prompt:"Stale edit"}),
  ]);
  expect(results.map(result=>result.status)).toEqual(["fulfilled","rejected"]);
  expect(task.prompt).toBe("Winning edit");expect(task.deliveryChecks?.[0].path).toBe("winner.txt");
  expect(task.revision).toBe(revision+1);
  const mutable={...input(),id:task.id,revision:task.revision,prompt:"Captured edit"};
  const saving=schedules.save(mutable);mutable.prompt="Changed after dispatch";await saving;
  expect(task.prompt).toBe("Captured edit");
  await other.shutdown();
});
it("freezes reserved run inputs across edits and restart, then uses the new plan for the next run",async()=>{
  const oldCheck={kind:"file" as const,path:"old.txt",label:"Original",minBytes:1};
  await schedules.save({...input(),title:"Original plan",prompt:"Original instruction",deliveryChecks:[oldCheck]});
  const task=desktop.data.schedules[0];
  vi.spyOn(scheduler,"add").mockRejectedValueOnce(Error("Interrupted before admission"));
  await expect(schedules.run(task.id)).rejects.toThrow("Interrupted");
  const reservation=structuredClone(task.pendingRun!);
  expect(reservation.input).toMatchObject({title:"Original plan",prompt:"Original instruction",cwd:root,deliveryChecks:[oldCheck]});
  const nextCwd=path.join(root,"future-project");await fs.mkdir(nextCwd);
  const newCheck={...oldCheck,path:"new.txt",label:"Future"};
  await schedules.save({...input(),id:task.id,revision:task.revision,title:"Future plan",prompt:"Future instruction",cwd:nextCwd,deliveryChecks:[newCheck]});
  expect(task.pendingRun).toEqual(reservation);
  await schedules.shutdown();await scheduler.shutdown();
  desktop=new Desktop(root);await desktop.load();store=new Store(root);await store.load();
  scheduler=new Scheduler(store,{busy:new Set(),cancelLogin:async()=>{}} as any,{cli:()=>{throw Error("No model call");},desktop:()=>{throw Error("No desktop worker");}});
  const admittedRoots:string[]=[];
  schedules=new Schedules(desktop,scheduler,()=>{},()=>now,undefined,async plan=>{admittedRoots.push(plan.cwd);});
  const first=(await schedules.run(task.id))!;
  expect(first).toMatchObject({title:"Original plan",prompt:"Original instruction",cwd:root,schedule:{runId:reservation.id,sourceCwd:root},delivery:{checks:[oldCheck],reports:[]}});
  expect(desktop.data.schedules[0]).toMatchObject({title:"Future plan",prompt:"Future instruction",cwd:nextCwd});
  first.state="cancelled";first.stopIntent="cancel";
  const second=(await schedules.run(task.id))!;
  expect(second).toMatchObject({title:"Future plan",prompt:"Future instruction",cwd:nextCwd,delivery:{checks:[newCheck],reports:[]}});
  expect(second.schedule!.runId).not.toBe(reservation.id);
  expect(admittedRoots).toEqual([root,nextCwd]);
});
it("abandons only the exact unadmitted occurrence, keeps files, and preserves the next plan",async()=>{
  const task=await create();
  vi.spyOn(scheduler,"add").mockRejectedValueOnce(Error("Admission interrupted"));
  await expect(schedules.run(task.id)).rejects.toThrow("interrupted");
  const run=task.pendingRun!,nextRun=task.nextRun,revision=task.revision;
  const prepared=path.join(root,"worktrees",run.id,"operator-note.txt");await fs.mkdir(path.dirname(prepared),{recursive:true});await fs.writeFile(prepared,"Keep this file");
  await expect(schedules.abandonPending(task.id,randomUUID())).rejects.toThrow("已变化");
  const writes=vi.spyOn(desktop,"changeSchedules").mockRejectedValueOnce(Error("Abandon checkpoint failed"));
  await expect(schedules.abandonPending(task.id,run.id)).rejects.toThrow("checkpoint failed");
  expect(task.pendingRun?.id).toBe(run.id);writes.mockRestore();
  expect(await schedules.abandonPending(task.id,run.id)).toEqual({abandoned:true,runId:run.id});
  expect(task.pendingRun).toBeUndefined();expect(task.nextRun).toBe(nextRun);expect(task.revision).toBe(revision);
  expect(await fs.readFile(prepared,"utf8")).toBe("Keep this file");
  expect(store.data.jobs).toHaveLength(0);
  const restored=new Desktop(root);await restored.load();expect(restored.data.schedules[0].pendingRun).toBeUndefined();
  const next=await schedules.run(task.id);expect(next!.schedule!.runId).not.toBe(run.id);
});
it("reconciles an already admitted occurrence instead of abandoning or stopping its task",async()=>{
  const task=await create(),save=desktop.save.bind(desktop);let writes=0;
  vi.spyOn(desktop,"save").mockImplementation(()=>++writes===2?Promise.reject(Error("Bookkeeping failed")):save());
  await expect(schedules.run(task.id)).rejects.toThrow("Bookkeeping failed");
  const job=store.data.jobs[0],state=job.state,runId=task.pendingRun!.id;
  expect(await schedules.abandonPending(task.id,runId)).toEqual({abandoned:false,runId,jobId:job.id});
  expect(task.pendingRun).toBeUndefined();expect(task.lastJobId).toBe(job.id);
  expect(job.state).toBe(state);expect(store.data.jobs).toHaveLength(1);
  expect((await schedules.abandonPending(task.id,runId)).jobId).toBe(job.id);
});

it("recovers a job admitted before the desktop bookkeeping write failed without resubmission", async () => {
  const task = await create(true);
  const save = desktop.save.bind(desktop);
  let saves = 0;
  vi.spyOn(desktop, "save").mockImplementation(() =>
    ++saves === 2
      ? Promise.reject(Error("simulated bookkeeping failure"))
      : save(),
  );
  await expect(schedules.run(task.id)).rejects.toThrow("bookkeeping");
  await (scheduler as any).tickInFlight;
  expect(store.data.jobs).toHaveLength(1);
  const job = store.data.jobs[0];
  expect(task.pendingRun?.id).toBe(job.schedule?.runId);
  const restoredDesktop = new Desktop(root);
  await restoredDesktop.load();
  const restoredStore = new Store(root);
  await restoredStore.load();
  expect(restoredStore.data.jobs[0].schedule).toEqual(job.schedule);
  // The manager reconciles the durable identity, not lastJobId or task title.
  restoredDesktop.data.schedules[0].lastJobId = undefined;
  restoredDesktop.data.schedules[0].enabled = false;
  await schedules.shutdown();
  await scheduler.shutdown();
  scheduler = new Scheduler(
    restoredStore,
    { busy: new Set(), cancelLogin: async () => {} } as any,
    {
      cli: () => {
        throw Error("No inference is permitted in this fixture");
      },
      desktop: () => {
        throw Error("No Desktop worker expected");
      },
    },
  );
  const recovered = new Schedules(
    restoredDesktop,
    scheduler,
    () => {},
    () => now,
  );
  await recovered.tick();
  expect(restoredDesktop.data.schedules[0].pendingRun).toBeUndefined();
  expect(restoredDesktop.data.schedules[0].lastJobId).toBe(job.id);
  expect(restoredStore.data.jobs).toHaveLength(1);
  await recovered.shutdown();
});

it("honors a manual run concurrent with an automatic no-op", async () => {
  const task = await create();
  const [automatic, manual] = await Promise.all([
    schedules.run(task.id, true),
    schedules.run(task.id),
  ]);
  expect(automatic).toBeUndefined();
  expect(manual?.schedule?.taskId).toBe(task.id);
  expect(store.data.jobs).toHaveLength(1);
});

it("resumes a durable reservation that crashed before admission, using the original occurrence identity", async () => {
  const task = await create();
  task.pendingRun = { id: randomUUID(), requestedAt: now - 1000 };
  const identity = task.pendingRun.id;
  await desktop.save();
  const restored = new Desktop(root);
  await restored.load();
  const recovered = new Schedules(
    restored,
    scheduler,
    () => {},
    () => now,
  );
  await recovered.tick();
  expect(store.data.jobs).toHaveLength(1);
  expect(store.data.jobs[0].schedule?.runId).toBe(identity);
  await recovered.tick();
  expect(store.data.jobs).toHaveLength(1);
  await recovered.shutdown();
});

it("never creates a job before the reservation is durable", async () => {
  const task = await create();
  vi.spyOn(desktop, "save").mockRejectedValueOnce(Error("disk unavailable"));
  await expect(schedules.run(task.id)).rejects.toThrow("disk unavailable");
  expect(store.data.jobs).toHaveLength(0);
  const id = task.pendingRun!.id;
  await schedules.run(task.id);
  expect(store.data.jobs).toHaveLength(1);
  expect(store.data.jobs[0].schedule?.runId).toBe(id);
});

it("reuses the reserved real Git worktree after interruption between creation and job admission", async () => {
  await desktop.git(root, ["init"]);
  await desktop.git(root, ["config", "user.email", "qa@example.invalid"]);
  await desktop.git(root, ["config", "user.name", "Relay QA"]);
  await fs.writeFile(path.join(root, "note.txt"), "initial");
  await desktop.git(root, ["add", "note.txt"]);
  await desktop.git(root, ["commit", "-m", "fixture"]);
  const task = await create(true);
  task.worktree = true;
  vi.spyOn(desktop, "project").mockRejectedValueOnce(
    Error("interrupted after worktree creation"),
  );
  await expect(schedules.run(task.id)).rejects.toThrow("interrupted");
  const reservation = task.pendingRun!.id;
  expect(store.data.jobs).toHaveLength(0);
  const recovered = (await schedules.run(task.id))!;
  expect(recovered.cwd).toBe(path.join(root, "worktrees", reservation));
  expect(await fs.readdir(path.join(root, "worktrees"))).toEqual([reservation]);
  expect(await fs.readFile(path.join(recovered.cwd, "note.txt"), "utf8")).toBe(
    "initial",
  );
  await desktop.git(root, ["worktree", "remove", recovered.cwd]);
}, 20000);

it("drains preparation on shutdown and does not enqueue a new job after closing begins", async () => {
  const task = await create();
  task.worktree = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worktree = vi
    .spyOn(desktop, "worktree")
    .mockImplementation(async () => {
      await gate;
      return { id: "fixture", name: "fixture", cwd: root, pinned: false };
    });
  const run = schedules.run(task.id).catch((error) => error);
  await vi.waitFor(() => expect(worktree).toHaveBeenCalledTimes(1));
  let closed = false;
  const shutdown = schedules.shutdown().then(() => {
    closed = true;
  });
  expect(closed).toBe(false);
  release();
  expect(await run).toBeInstanceOf(Error);
  await shutdown;
  expect(store.data.jobs).toHaveLength(0);
  expect(task.pendingRun).toBeDefined();
});

it("collapses a long sleep/forward clock jump into one occurrence and never repeats it on rollback", async () => {
  const task = await create();
  now = task.nextRun + 3 * 86400000;
  await Promise.all([schedules.tick(), schedules.tick(), schedules.tick()]);
  expect(store.data.jobs).toHaveLength(1);
  const job = store.data.jobs[0];
  job.state = "completed";
  const due = task.nextRun;
  now -= 7 * 86400000;
  await schedules.tick();
  expect(store.data.jobs).toHaveLength(1);
  now = due - 1;
  await schedules.tick();
  expect(store.data.jobs).toHaveLength(1);
  now = due;
  await schedules.tick();
  expect(store.data.jobs).toHaveLength(2);
  expect(store.data.jobs[0].schedule?.runId).not.toBe(store.data.jobs[1].schedule?.runId);
});

it("recalculates a saved calendar schedule when the system zone changes, including while disabled", async () => {
  await schedules.save({ ...input(), cadence: "daily", enabled: false });
  const task = desktop.data.schedules[0];
  task.nextRunZone = "Previous/SystemZone";
  task.nextRun = now - 1000;
  await schedules.tick();
  expect(store.data.jobs).toHaveLength(0);
  expect(task.nextRunZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(task.nextRun).toBe(nextSchedule(task, now));
  const loaded = new Desktop(root);
  await loaded.load();
  expect(loaded.data.schedules[0].nextRun).toBe(task.nextRun);
  expect(loaded.data.schedules[0].nextRunZone).toBe(task.nextRunZone);
  const unchanged = task.nextRun;
  now += 1000;
  await schedules.tick();
  expect(task.nextRun).toBe(unchanged);
});

it("does not skip legacy overdue calendar work when adopting time-zone metadata", async () => {
  await schedules.save({ ...input(), cadence: "daily" });
  const task = desktop.data.schedules[0];
  task.nextRun = now - 1000;
  delete task.nextRunZone;
  await schedules.tick();
  expect(store.data.jobs).toHaveLength(1);
  expect(task.nextRun).toBe(nextSchedule(task, now));
  expect(task.nextRunZone).toBeTruthy();
});

it("preserves a pending occurrence across time-zone changes and rolls back failed metadata writes", async () => {
  await schedules.save({ ...input(), cadence: "weekly" });
  const task = desktop.data.schedules[0];
  task.nextRunZone = "Previous/SystemZone";
  task.nextRun = now + 1234;
  task.pendingRun = { id: randomUUID(), requestedAt: now - 10000 };
  const reservation = { ...task.pendingRun }, oldDue = task.nextRun;
  vi.spyOn(desktop, "save").mockRejectedValueOnce(Error("zone write unavailable"));
  await expect(schedules.run(task.id, true)).rejects.toThrow("zone write");
  expect(task.nextRunZone).toBe("Previous/SystemZone");
  expect(task.nextRun).toBe(oldDue);
  expect(store.data.jobs).toHaveLength(0);
  await schedules.run(task.id, true);
  expect(store.data.jobs).toHaveLength(1);
  expect(store.data.jobs[0].schedule).toEqual({ taskId: task.id, runId: reservation.id, requestedAt: reservation.requestedAt,sourceCwd:task.cwd });
  expect(task.nextRun).toBe(nextSchedule(task, now));
  await schedules.tick();
  expect(store.data.jobs).toHaveLength(1);
});

function failDesktopWrite() {
  const rename = fs.rename.bind(fs);
  let failedTemporary:string|undefined;
  return vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    // Deny the entire first atomic write, including Windows sharing retries.
    // A later user retry uses a different owned temporary file and may succeed.
    if (path.basename(String(to)) === "desktop.json"&&(!failedTemporary||failedTemporary===String(from))) {
      failedTemporary=String(from);
      throw Object.assign(Error("schedule disk denied"), { code: "EPERM" });
    }
    return rename(from, to);
  });
}

it("does not enable a new schedule after its disk write fails", async () => {
  await desktop.save();
  failDesktopWrite();
  await expect(schedules.save(input())).rejects.toThrow("schedule disk denied");
  expect(desktop.data.schedules).toHaveLength(0);
  now += 86400000;
  await schedules.tick();
  expect(store.data.jobs).toHaveLength(0);
  const loaded = new Desktop(root);
  await loaded.load();
  expect(loaded.data.schedules).toHaveLength(0);
  await schedules.save(input());
  expect(desktop.data.schedules).toHaveLength(1);
});

it("retains the saved enabled state and task content after edit or deletion fails", async () => {
  const task = await create();
  const before = structuredClone(task);
  const spy = failDesktopWrite();
  await expect(schedules.save({ ...input(), id: task.id, enabled: false, prompt: "unsaved replacement" })).rejects.toThrow("schedule disk denied");
  expect(desktop.data.schedules[0]).toEqual(before);
  spy.mockRestore();
  failDesktopWrite();
  await expect(schedules.remove(task.id)).rejects.toThrow("schedule disk denied");
  expect(desktop.data.schedules[0]).toEqual(before);
  const loaded = new Desktop(root);
  await loaded.load();
  expect(loaded.data.schedules[0]).toEqual(before);
  await schedules.remove(task.id);
  expect(desktop.data.schedules).toHaveLength(0);
});

it("keeps failed edits invisible while concurrent schedule and preference writes preserve committed changes", async () => {
  await schedules.save({ ...input(), enabled: false });
  const original = desktop.data.schedules[0];
  const rename = fs.rename.bind(fs);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (first && path.basename(String(to)) === "desktop.json") {
      first = false;
      entered();
      await gate;
      throw Error("blocked schedule edit failed");
    }
    return rename(from, to);
  });
  const edit = schedules.save({ ...input(), id: original.id }).catch((error) => error);
  await waiting;
  expect(original.enabled).toBe(false);
  const add = schedules.save({ ...input(), title: "Independent schedule" });
  desktop.data.preferences.language = "ja";
  const preferences = desktop.save();
  release();
  expect(await edit).toBeInstanceOf(Error);
  await Promise.all([add, preferences]);
  expect(desktop.data.schedules).toHaveLength(2);
  expect(original.enabled).toBe(false);
  const loaded = new Desktop(root);
  await loaded.load();
  expect(loaded.data.schedules).toEqual(desktop.data.schedules);
  expect(loaded.data.preferences.language).toBe("ja");
  // A preference write already queued behind deletion must not resurrect it.
  const removing = schedules.remove(original.id);
  await Promise.resolve();
  await Promise.all([removing, desktop.save()]);
  await loaded.load();
  expect(loaded.data.schedules.map((task) => task.title)).toEqual(["Independent schedule"]);
  expect(desktop.data.schedules.map((task) => task.title)).toEqual(["Independent schedule"]);
});
it("applies a fresh delivery contract to every scheduled occurrence and preserves it across partial edits",async()=>{
 const check={kind:"file" as const,path:"report.txt",label:"Report",minBytes:1};
 await schedules.save({...input(),deliveryChecks:[check]});const task=desktop.data.schedules[0];
 await schedules.save({...input(),id:task.id,deliveryChecks:undefined,title:"Edited"});expect(task.deliveryChecks).toEqual([check]);
 const first=await schedules.run(task.id);expect(first?.delivery).toEqual({revision:1,checks:[check],reports:[]});
 first!.state="completed";await scheduler.checkDelivery(first!.id);expect(first!.state).toBe("needs_attention");await expect(schedules.run(task.id)).rejects.toThrow("尚未结束");
 await fs.writeFile(path.join(root,"report.txt"),"verified");await scheduler.checkDelivery(first!.id);expect(first!.state).toBe("completed");
 const second=await schedules.run(task.id);expect(second?.delivery).toEqual({revision:1,checks:[check],reports:[]});
 await schedules.save({...input(),id:task.id,deliveryChecks:[]});expect(desktop.data.schedules[0].deliveryChecks).toEqual([]);expect(second?.delivery?.checks).toEqual([check]);
 await expect(schedules.save({...input(),id:task.id,deliveryChecks:[{...check,path:"../escape"}]})).rejects.toThrow();expect(desktop.data.schedules[0].deliveryChecks).toEqual([]);
});
