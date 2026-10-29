import {z} from "zod";

export const nativeFollowupSchema=z.object({
  installationId:z.string().uuid(),requestId:z.string().uuid(),
  controlRevision:z.number().int().nonnegative(),
  input:z.object({
    id:z.string().uuid(),text:z.string().trim().min(1).max(100000),
    attachments:z.array(z.object({type:z.enum(["localImage","mention"]),path:z.string().min(1).max(32700),name:z.string().max(300)}).strict()).max(20),
    action:z.literal("queue"),model:z.string().max(200).optional(),effort:z.string().max(20).optional(),
    review:z.boolean().optional(),planMode:z.boolean().optional(),multiAgent:z.boolean().optional(),serviceTier:z.string().max(50).optional(),
  }).strict(),
}).strict();
export type NativeFollowup=z.infer<typeof nativeFollowupSchema>;
export const nativeFollowupResultSchema=z.discriminatedUnion("state",[
  z.object({state:z.literal("accepted")}).strict(),
  z.object({state:z.literal("pending"),error:z.string()}).strict(),
  z.object({state:z.literal("rejected"),code:z.enum(["installation","task","control","request","cancelled","input"]),error:z.string()}).strict(),
]);
export type NativeFollowupResult=z.infer<typeof nativeFollowupResultSchema>;
