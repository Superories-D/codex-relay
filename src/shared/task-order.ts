import type { Job } from "./types";
const priority = { high: 2, normal: 1, low: 0 };
export function orderTasks(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) =>
    (priority[b.priority || "normal"] ?? 1) - (priority[a.priority || "normal"] ?? 1) ||
    (a.enqueuedAt ?? a.createdAt) - (b.enqueuedAt ?? b.createdAt));
}
