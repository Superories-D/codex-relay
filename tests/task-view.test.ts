import { describe, expect, it } from "vitest";
import type { Approval, Job } from "../src/shared/types";
import { canControlTask, matchesTaskFilter, readTaskView, sortTaskView, taskLane, taskNeedsAttention, taskScope } from "../src/shared/task-view";
const job = (patch: Partial<Job> = {}): Job => ({ id: "a", title: "Build interface", cwd: "C:\\Projects\\Relay", state: "queued", createdAt: 1, updatedAt: 1, ...patch } as Job);
const approval = (patch: Partial<Approval> = {}): Approval => ({ id: "approval", jobId: "a", kind: "command", method: "approve", params: {}, ...patch });

describe("task planning views", () => {
  it("brings live approvals into attention without confusing submitted responses or automatic recovery", () => {
    const running = job({ state: "running" });
    expect(taskLane(running, [approval()])).toBe("attention");
    expect(matchesTaskFilter(running, "attention", [approval()])).toBe(true);
    expect(taskNeedsAttention(running, [approval({ responsePending: true })])).toBe(false);
    expect(taskLane(job({ state: "needs_attention", autoRecovery: { reason: "process", attempt: 2, nextAttemptAt: 1 } }), [])).toBe("working");
    expect(taskLane(job({ state: "needs_attention" }), [])).toBe("attention");
  });
  it("places terminal and paused tasks in separate lanes, retaining cancellation as distinct state", () => {
    expect(taskLane(job({ state: "paused" }), [])).toBe("ready");
    expect(taskLane(job({ state: "completed" }), [])).toBe("finished");
    expect(taskLane(job({ state: "cancelled" }), [])).toBe("finished");
    expect(matchesTaskFilter(job({ state: "cancelled" }), "completed", [])).toBe(false);
  });
  it("matches normalized Windows project roots, workflow names and trims queries while excluding archives", () => {
    const current = job({ projectCwd: "C:\\Projects\\Relay\\", cwd: "C:\\worktrees\\feature", workflow: { title: "Release workflow" } as Job["workflow"] });
    expect(taskScope([current, job({ id: "archived", archived: true })], { project: "c:/projects/relay", query: " release ", platform: "win32" })).toEqual([current]);
    expect(taskScope([current], { project: "c:/projects/relay", query: "", platform: "linux" })).toEqual([]);
  });
  it("sorts scheduling priorities without mutating snapshots and supports recent and oldest work", () => {
    const jobs = [job({ id: "older", createdAt: 1, updatedAt: 8 }), job({ id: "urgent", priority: "high", createdAt: 2, updatedAt: 2 }), job({ id: "new", createdAt: 3, updatedAt: 9 })];
    expect(sortTaskView(jobs, "priority").map(j => j.id)).toEqual(["urgent", "older", "new"]);
    expect(sortTaskView(jobs, "recent").map(j => j.id)).toEqual(["new", "older", "urgent"]);
    expect(sortTaskView(jobs, "oldest").map(j => j.id)).toEqual(["older", "urgent", "new"]);
    expect(jobs[0].id).toBe("older");
  });
  it("only exposes valid controls and never bulk-controls unmanaged imported tasks", () => {
    expect(canControlTask(job({ state: "paused" }), "resume")).toBe(true);
    expect(canControlTask(job({ state: "running" }), "resume")).toBe(false);
    expect(canControlTask(job({ state: "pausing" }), "pause")).toBe(false);
    expect(canControlTask(job({ state: "completed" }), "pause")).toBe(false);
    expect(canControlTask(job({ state: "needs_attention", autoRecovery: { reason: "process", attempt: 1, nextAttemptAt: 1 } }), "resume")).toBe(false);
    expect(canControlTask(job({ existing: { phase: "watching" } as Job["existing"] }), "pause")).toBe(false);
  });
  it("restores safe view preferences and tolerates corrupt or unavailable storage", () => {
    expect(readTaskView({ getItem: () => '{"layout":"board","sort":"recent"}' })).toEqual({ layout: "board", sort: "recent" });
    for (const value of ["bad", "null", '{"layout":"strange","sort":"delete"}']) expect(readTaskView({ getItem: () => value })).toEqual({ layout: "list", sort: "priority" });
    expect(readTaskView({ getItem: () => { throw Error("storage denied"); } })).toEqual({ layout: "list", sort: "priority" });
  });
});
