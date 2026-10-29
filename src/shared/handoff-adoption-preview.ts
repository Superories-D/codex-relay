import {z} from "zod";
import {checkpointPath,checkpointDigest} from "./checkpoints";
const uuid=z.string().uuid(),count=z.number().int().nonnegative().safe();
export const adoptionPreviewSummary=z.object({
  id:uuid,workspaceId:uuid,reviewId:uuid,requestSha256:checkpointDigest,sha256:checkpointDigest,
  createdAt:z.number().finite(),expiresAt:z.number().finite(),
  files:count,changes:count,blocked:count,sourceSha256:checkpointDigest,
}).strict();
export type AdoptionPreviewSummary=z.infer<typeof adoptionPreviewSummary>;
export const adoptionPreviewIssue=z.enum(["link","sparse","directory","newDirectory","newFilePermissions","topology","structural"]);
const bytes=z.object({bytes:count,sha256:checkpointDigest}).strict();
export const adoptionPreviewFile=z.object({
  repository:z.string().refine(value=>!value||checkpointPath.safeParse(value).success),path:checkpointPath,
  action:z.enum(["unchanged","create","replace","delete","blocked"]),issue:adoptionPreviewIssue.optional(),
  before:bytes.optional(),after:bytes.optional(),afterFile:z.string().optional(),ignored:z.boolean().optional(),
}).strict();
export type AdoptionPreviewFile=z.infer<typeof adoptionPreviewFile>;
export interface AdoptionPreviewDetail {
  summary:AdoptionPreviewSummary;source:string;offset:number;total:number;files:AdoptionPreviewFile[];
}
