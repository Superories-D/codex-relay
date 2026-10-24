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
export type DeliveryFinding = {
  check: DeliveryCheck;
  status: "passed" | "failed" | "unverified";
  code:
    | "verified"
    | "missing"
    | "tooSmall"
    | "textMissing"
    | "hashMismatch"
    | "jsonMismatch"
    | "invalidText"
    | "jsonTooLarge"
    | "notFile"
    | "outsideWorkspace"
    | "changedDuringRead"
    | "ioError"
    | "cancelled";
  bytes?: number;
  sha256?: string;
  modifiedAt?: number;
};
export type DeliveryReport = {
  id: string;
  revision: number;
  startedAt: number;
  finishedAt: number;
  turnId?: string;
  source: "automatic" | "manual" | "recovery";
  status: "passed" | "failed" | "unverified";
  findings: DeliveryFinding[];
};
export type DeliveryState = {
  revision: number;
  checks: DeliveryCheck[];
  reports: DeliveryReport[];
  pendingCompletion?: boolean;
  blockedCompletion?: boolean;
};
export function deliveryAccepted(delivery?: DeliveryState) {
  if (!delivery?.checks.length) return true;
  const latest = delivery.reports.at(-1);
  return (
    !delivery.pendingCompletion &&
    !delivery.blockedCompletion &&
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
