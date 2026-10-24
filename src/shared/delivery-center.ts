import { z } from "zod";
import { deliveryChecksSchema, deliveryReportSchema, type DeliveryReport } from "./delivery";

export const deliveryPlanContent = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000),
  checks: deliveryChecksSchema.refine(a => a.length > 0),
}).strict();
export const deliveryPlanSchema = deliveryPlanContent.extend({
  id: z.string().uuid(), updatedAt: z.number().finite(),
});
export const deliveryPlanStateSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  items: z.array(deliveryPlanSchema).max(100),
}).strict();
export type DeliveryPlan = z.infer<typeof deliveryPlanSchema>;
export type DeliveryPlanState = z.infer<typeof deliveryPlanStateSchema>;
export type EvidenceComparison = {
  status: "current" | "changed" | "unverified" | "noBaseline";
  changedPaths: string[];
};
// A condition can still pass after its artifact changes (for example file size).
// Compare the actual full-file fingerprints, independently of condition success.
export function compareDeliveryEvidence(baseline: DeliveryReport | undefined, current: DeliveryReport): EvidenceComparison {
  if (!baseline || baseline.revision !== current.revision || baseline.status !== "passed" ||
    baseline.findings.length !== current.findings.length || baseline.findings.some((f, i) =>
      JSON.stringify(f.check) !== JSON.stringify(current.findings[i].check) || !f.sha256))
    return {status: "noBaseline", changedPaths: []};
  const changed = current.findings.filter((f, i) =>
    f.status === "failed" || (f.sha256 && f.sha256 !== baseline.findings[i].sha256));
  if (changed.length) return {status: "changed", changedPaths: [...new Set(changed.map(f => f.check.path))]};
  if (current.status !== "passed" || current.findings.some(f => !f.sha256))
    return {status: "unverified", changedPaths: []};
  return {status: "current", changedPaths: []};
}

export interface DeliveryBatchItem {
  id: string;
  title: string;
  revision: number;
  status: "queued" | "checking" | "passed" | "failed" | "unverified" | "skipped" | "cancelled";
  comparison?: EvidenceComparison;
  baselineId?: string;
  report?: DeliveryReport;
  issue?: string;
  cwd?: string;
  dependsOn?: string[];
  workflow?: {id: string; title: string; step: number; total: number};
}
export interface DeliveryBatch {
  id: string;
  mode: "inspect" | "verify";
  status: "running" | "completed" | "cancelled" | "interrupted";
  createdAt: number;
  finishedAt?: number;
  items: DeliveryBatchItem[];
}
export const deliveryBatchSchema = z.object({
  id: z.string().uuid(), mode: z.enum(["inspect", "verify"]),
  status: z.enum(["running", "completed", "cancelled", "interrupted"]),
  createdAt: z.number().finite(), finishedAt: z.number().finite().optional(),
  items: z.array(z.object({
    id: z.string().uuid(), title: z.string().max(1000), revision: z.number().int().nonnegative(),
    status: z.enum(["queued", "checking", "passed", "failed", "unverified", "skipped", "cancelled"]),
    comparison: z.object({status: z.enum(["current", "changed", "unverified", "noBaseline"]),
      changedPaths: z.array(z.string().max(2000)).max(30)}).strict().optional(),
    baselineId: z.string().uuid().optional(), report: deliveryReportSchema.optional(), issue: z.string().max(4000).optional(),
    cwd: z.string().max(32000).optional(), dependsOn: z.array(z.string().uuid()).max(20).optional(),
    workflow: z.object({id: z.string().uuid(), title: z.string().max(1000), step: z.number().int().min(1), total: z.number().int().min(1)}).strict().optional(),
  }).strict()).max(100),
}).strict();
export const deliveryBatchStateSchema = z.object({version: z.literal(1), revision: z.number().int().nonnegative(),
  batches: z.array(deliveryBatchSchema).max(20)}).strict();
export type DeliveryBatchState = z.infer<typeof deliveryBatchStateSchema>;
