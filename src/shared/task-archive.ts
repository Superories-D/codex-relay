import { z } from "zod";
import type { Job } from "./types";
export const bulkArchiveSchema=z.object({
  entries:z.array(z.object({id:z.string().uuid(),expectedArchiveRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict()).min(1).max(100),
  archived:z.boolean(),
}).strict();
export type BulkArchiveInput=z.infer<typeof bulkArchiveSchema>;
export type ArchiveCode="missing"|"stale"|"unchanged"|"active"|"unmanaged"|"closing"|"save_failed";
export interface ArchiveResult { id:string; ok:boolean; revision?:number; code?:ArchiveCode; error?:string }
export interface BulkArchiveResult { archived:boolean; results:ArchiveResult[] }
export const archiveErrors:Record<ArchiveCode,string>={missing:"任务已不存在，请刷新列表",stale:"归档状态已变化，请重新选择任务",unchanged:"任务已处于请求的归档状态",active:"请先暂停任务并完成恢复检查，再归档",unmanaged:"请先完成任务接入，再归档",closing:"客户端正在关闭，归档状态未修改",save_failed:"归档保存失败，本批次修改已撤回"};
export function archiveEligibility(job:Job|undefined,archived:boolean):ArchiveCode|undefined {
  if(!job)return "missing";
  if(!!job.archived===archived)return "unchanged";
  if(job.existing&&job.existing.phase!=="managed")return "unmanaged";
  if(archived&&(job.recoveryRequired||job.autoRecovery||!["paused","completed","cancelled","needs_attention"].includes(job.state)))return "active";
}
