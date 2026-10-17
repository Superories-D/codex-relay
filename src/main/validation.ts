import path from "node:path";
import { z } from "zod";
const text = z.string().max(10000);
// Current CLI catalogs define reasoning effort as a string, including model-specific levels.
const effort = z
  .string()
  .max(20)
  .regex(/^(?:[a-z][a-z0-9_-]*)?$/);
const absolute = z
  .string()
  .min(1)
  .max(32700)
  .refine((p) => path.isAbsolute(p), "必须使用绝对路径");
export const attachmentsSchema = z
  .array(
    z
      .object({
        type: z.enum(["localImage", "mention"]),
        path: absolute,
        name: z.string().max(300),
      })
      .strict(),
  )
  .max(20);
export const chatSendSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string().trim().min(1).max(100000),
    attachments: attachmentsSchema.default([]),
    action: z.enum(["send", "queue", "steer"]).default("send"),
    model: z.string().max(200).optional(),
    effort: effort.optional(),
    review: z.boolean().optional(),
    planMode: z.boolean().optional(),
    multiAgent: z.boolean().optional(),
    serviceTier: z.string().max(50).optional(),
  })
  .strict();
export const newJobSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(100000),
    cwd: absolute,
    mode: z.enum(["cli", "desktop"]),
    model: z.string().max(200),
    effort,
    bucket: z.string().min(1).max(100),
    approvalPolicy: z.enum(["on-request", "never"]),
    sandbox: z.enum(["workspaceWrite", "readOnly", "dangerFullAccess"]),
    completionMarker: z
      .string()
      .trim()
      .max(80)
      .refine((v) => !/[\r\n\x00-\x1f]/.test(v), "完成标记必须为单行文本")
      .optional(),
    maxCompletionRetries: z.number().int().min(0).max(10).optional(),
    interactive: z.boolean().optional(),
    attachments: attachmentsSchema.optional(),
    review: z.boolean().optional(),
    planMode: z.boolean().optional(),
    multiAgent: z.boolean().optional(),
    serviceTier: z.string().max(50).optional(),
  })
  .strict();
export const settingsSchema = z
  .object({
    accountSelection: z.enum(["smart", "roundRobin"]).optional(),
    resetWarmupEnabled: z.boolean().optional(),
    cliPath: z.string().min(1).max(32700),
    desktopPath: z.string().max(32700),
    pollSeconds: z.number().int().min(10).max(300),
    retrySeconds: z.number().int().min(30).max(3600),
    resumePrompt: z.string().min(1).max(10000),
    desktop: z
      .object({
        editorSelector: text.min(1),
        sendSelector: text.min(1),
        stopSelector: text.min(1),
        threadSelector: text.min(1),
        projectSelector: text,
      })
      .strict(),
  })
  .strict();
export const idSchema = z.string().uuid();
export const sessionScanSchema = z
  .object({ home: absolute.optional(), threadId: idSchema.optional() })
  .strict();
export const sessionAttachSchema = z
  .object({
    id: idSchema,
    strategy: z.enum(["quota", "now"]),
    mode: z.enum(["cli", "desktop"]),
    allowStop: z.boolean(),
  })
  .strict();
export const controlSchema = z
  .object({ id: idSchema, action: z.enum(["pause", "resume", "cancel"]) })
  .strict();
export const loginSchema = z
  .object({ label: z.string().max(100), device: z.boolean() })
  .strict();
export const accountSchema = z
  .object({
    expiresAt: z.number().int().min(0).max(8640000000000).nullable().optional(),
    limitMode: z.enum(["auto", "fiveHour", "weeklyOnly"]).optional(),
    id: idSchema,
    enabled: z.boolean().optional(),
    label: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
