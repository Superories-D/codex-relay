import {z} from "zod";
import {newJobInputSchema} from "./new-job";

export const nativeCreationSchema=z.object({
  installationId:z.string().uuid(),requestId:z.string().uuid(),
  input:newJobInputSchema.extend({mode:z.literal("cli"),interactive:z.literal(true)}),
}).strict();
export type NativeCreation=z.infer<typeof nativeCreationSchema>;
export const nativeCreationResultSchema=z.discriminatedUnion("state",[
  z.object({state:z.literal("accepted"),jobId:z.string().uuid()}).strict(),
  z.object({state:z.literal("pending"),error:z.string()}).strict(),
  z.object({state:z.literal("rejected"),code:z.enum(["installation","request","cancelled","input"]),error:z.string()}).strict(),
]);
export type NativeCreationResult=z.infer<typeof nativeCreationResultSchema>;
