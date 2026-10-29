import type { Approval, Job } from "./types";
import { projectKey } from "./dispatch";
import { orderTasks } from "./task-order";

export type TaskLane = "ready" | "working" | "attention" | "finished";
export type TaskFilter = "all" | "active" | "attention" | "recovering" | "paused" | "completed";
export type TaskSort = "priority" | "recent" | "oldest";
export type TaskLayout = "list" | "board";
const working = new Set(["preparing", "running", "rotating", "pausing", "watching"]);

/** Approvals awaiting a response belong in attention even while the worker is running. */
export function taskNeedsAttention(job: Job, approvals: readonly Approval[]) {
  return (job.state === "needs_attention" && !job.autoRecovery) ||
    approvals.some(approval => approval.jobId === job.id && !approval.responsePending);
}
export function taskLane(job: Job, approvals: readonly Approval[]): TaskLane {
  if (taskNeedsAttention(job, approvals)) return "attention";
  if (["completed", "cancelled"].includes(job.state)) return "finished";
  if (working.has(job.state) || job.autoRecovery) return "working";
  return "ready";
}
export function matchesTaskFilter(job: Job, filter: TaskFilter, approvals: readonly Approval[]) {
  switch (filter) {
    case "active": return !["completed", "cancelled", "paused"].includes(job.state);
    case "attention": return taskNeedsAttention(job, approvals);
    case "recovering": return !!job.autoRecovery;
    case "paused": return job.state === "paused";
    case "completed": return job.state === "completed";
    default: return true;
  }
}
export function taskScope(jobs: readonly Job[], options: { project: string; query: string; platform: string; archived?: boolean }) {
  const query = options.query.trim().toLocaleLowerCase();
  return jobs.filter(job => !!job.archived === !!options.archived &&
    (!options.project || projectKey(job.projectCwd || job.cwd, options.platform) === projectKey(options.project, options.platform)) &&
    `${job.title} ${job.projectCwd || job.cwd} ${job.cwd} ${job.workflow?.title || ""}`.toLocaleLowerCase().includes(query));
}
export function sortTaskView(jobs: readonly Job[], sort: TaskSort) {
  if (sort === "priority") return orderTasks([...jobs]);
  return [...jobs].sort((a, b) => (sort === "recent" ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
}
export function canControlTask(job: Job, action: "pause" | "resume") {
  if (job.archived) return false;
  if (job.existing && job.existing.phase !== "managed") return false;
  if (action === "resume") return !job.autoRecovery && ["paused", "needs_attention"].includes(job.state);
  return !!job.autoRecovery || !["completed", "cancelled", "paused", "pausing"].includes(job.state);
}
export function readTaskView(storage: Pick<Storage, "getItem">): { layout: TaskLayout; sort: TaskSort } {
  try {
    const saved = JSON.parse(storage.getItem("relay.taskView") || "{}");
    return { layout: saved?.layout === "board" ? "board" : "list", sort: ["priority", "recent", "oldest"].includes(saved?.sort) ? saved.sort : "priority" };
  } catch { return { layout: "list", sort: "priority" }; }
}
