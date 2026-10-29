import {z} from "zod";
import {deliveryChecksSchema} from "./delivery";
const effort=z.string().max(20).regex(/^(?:[a-z][a-z0-9_-]*)?$/);
const nativeAttachmentsSchema=z.array(z.object({type:z.enum(["localImage","mention"]),path:z.string().min(1).max(32700),name:z.string().max(300)}).strict()).max(20);

// Renderer validates the frozen shape; the main process also requires absolute paths.
export const newJobInputSchema = z
  .object({
    deliveryChecks: deliveryChecksSchema.optional(),
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(100000),
    cwd: z.string().min(1).max(32700),
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
    attachments: nativeAttachmentsSchema.optional(),
    review: z.boolean().optional(),
    planMode: z.boolean().optional(),
    multiAgent: z.boolean().optional(),
    serviceTier: z.string().max(50).optional(),
  })
  .strict();
