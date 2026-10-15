import path from "node:path";
import { z } from "zod";
const text = z.string().max(10000);
const absolute = z
  .string()
  .min(1)
  .max(32700)
  .refine((p) => path.isAbsolute(p), "必须使用绝对路径");
export const newJobSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(100000),
    cwd: absolute,
    mode: z.enum(["cli", "desktop"]),
    model: z.string().max(200),
    effort: z.enum([
      "",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]),
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
  })
  .strict();
export const settingsSchema = z
  .object({
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
    id: idSchema,
    enabled: z.boolean().optional(),
    label: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
