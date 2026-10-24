import { z } from "zod";

const relativePath = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (value) =>
      !/^[\\/]|^[a-z]:|[\x00-\x1f:]/i.test(value) &&
      !value
        .split(/[\\/]/)
        .some((part) => !part || part === "." || part === ".."),
    "产物路径必须位于任务目录内，不能包含上级目录或绝对路径",
  );
const base = { path: relativePath, label: z.string().trim().min(1).max(200) };
export const deliveryCheckSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("file"),
      minBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(1),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("contains"),
      text: z.string().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("sha256"),
      sha256: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .transform((v) => v.toLowerCase()),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("json"),
      pointer: z
        .string()
        .max(2000)
        .refine(
          (v) => v === "" || (/^\//.test(v) && !/~(?![01])/.test(v)),
          "请输入 JSON Pointer",
        ),
      equals: z.union([
        z.string().max(4000),
        z.number().finite(),
        z.boolean(),
        z.null(),
      ]),
    })
    .strict(),
]);
export const deliveryChecksSchema = z.array(deliveryCheckSchema).max(30);
export type DeliveryCheck = z.infer<typeof deliveryCheckSchema>;
export const deliveryFindingSchema = z.object({
  check: deliveryCheckSchema,
  status: z.enum(["passed", "failed", "unverified"]),
  code: z.enum(["verified", "missing", "tooSmall", "textMissing", "hashMismatch", "jsonMismatch",
    "invalidText", "jsonTooLarge", "notFile", "outsideWorkspace", "changedDuringRead", "ioError", "cancelled"]),
  bytes: z.number().finite().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  modifiedAt: z.number().finite().optional(),
}).strict();
export type DeliveryFinding = z.infer<typeof deliveryFindingSchema>;
export const deliveryReportSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().nonnegative(),
  startedAt: z.number().finite(), finishedAt: z.number().finite(),
  turnId: z.string().optional(), source: z.enum(["automatic", "manual", "recovery"]),
  status: z.enum(["passed", "failed", "unverified"]), findings: z.array(deliveryFindingSchema).max(30),
}).strict();
export type DeliveryReport = z.infer<typeof deliveryReportSchema>;
export type DeliveryState = {
  revision: number;
  checks: DeliveryCheck[];
  reports: DeliveryReport[];
  pendingCompletion?: boolean;
  blockedCompletion?: boolean;
  staleEvidence?: {reportId: string; at: number; reason: "changed" | "unverified"};
};
export function deliveryAccepted(delivery?: DeliveryState) {
  if (!delivery?.checks.length) return true;
  const latest = delivery.reports.at(-1);
  return (
    !delivery.pendingCompletion &&
    !delivery.blockedCompletion &&
    !(delivery.staleEvidence && delivery.staleEvidence.reportId === latest?.id) &&
    latest?.revision === delivery.revision &&
    latest.status === "passed"
  );
}

export function deliveryRepairPrompt(report: DeliveryReport) {
  const failed = report.findings.filter((f) => f.status !== "passed");
  return [
    "请继续修正当前任务的交付产物，保留已有成果。以下是客户端直接检查文件得到的验收结果：",
    ...failed.map(
      (f) => `- ${f.check.label}: ${JSON.stringify(f.check)} (${f.code})`,
    ),
    "完成修正后说明变更与验证；客户端会再次检查这些条件。",
  ].join("\n");
}
