import { z } from "zod";
import type { Job } from "./types";
export type TaskPriority = NonNullable<Job["priority"]>;
export const bulkPrioritySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  priority: z.enum(["high", "normal", "low"]),
}).strict();
export type BulkPriorityInput = z.infer<typeof bulkPrioritySchema>;
export type PriorityRejection = "missing" | "archived" | "finished" | "unmanaged" | "closing" | "save_failed";
export interface PriorityResult { id: string; ok: boolean; code?: PriorityRejection; error?: string }
export interface BulkPriorityResult { priority: TaskPriority; results: PriorityResult[] }
export function priorityRejection(job: Job | undefined): PriorityRejection | undefined {
  if (!job) return "missing";
  if (job.archived) return "archived";
  if (["completed", "cancelled"].includes(job.state)) return "finished";
  if (job.existing && job.existing.phase !== "managed") return "unmanaged";
}
export const priorityErrors: Record<PriorityRejection, string> = {
  missing: "任务已不存在，请刷新列表",
  archived: "已归档任务不能批量调整优先级",
  finished: "已结束任务不能批量调整优先级",
  unmanaged: "请先完成任务接入，再调整优先级",
  closing: "客户端正在关闭，优先级未修改",
  save_failed: "优先级保存失败，本批次修改已撤回",
};
