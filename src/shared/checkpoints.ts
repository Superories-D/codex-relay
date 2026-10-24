import {z} from "zod";
import {deliveryChecksSchema} from "./delivery";
export const checkpointDigest=z.string().regex(/^[a-f0-9]{64}$/);
export const checkpointOid=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const checkpointPath=z.string().min(1).max(32700).refine(value=>!value.includes("\\")&&!/[\x00-\x1f:]/.test(value)&&!value.startsWith("/")&&value.split("/").every(part=>!!part&&!['.','..','.git'].includes(part.toLowerCase())&&!/[. ]$/.test(part)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),"检查点路径无法在 Windows 上安全表示");
export const checkpointStoredFile=z.object({path:checkpointPath,bytes:z.number().int().nonnegative().safe(),sha256:checkpointDigest}).strict();
export type CheckpointStoredFile=z.infer<typeof checkpointStoredFile>;
export const checkpointIndexEntry=z.object({path:z.string().min(1),mode:z.enum(["100644","100755","120000","160000","040000"]),oid:checkpointOid,stage:z.number().int().min(0).max(3)}).strict();
export type CheckpointIndexEntry=z.infer<typeof checkpointIndexEntry>;
export const checkpointFile=z.object({path:checkpointPath,kind:z.enum(["file","absent","link","directory"]),tracked:z.boolean(),ignored:z.boolean(),
  stored:checkpointStoredFile.optional(),mode:z.number().int().nonnegative().optional(),link:z.object({target:z.string().min(1).max(32700),directory:z.boolean(),internal:z.string().refine(value=>value===""||checkpointPath.safeParse(value).success).optional(),external:z.boolean()}).strict().optional()}).strict()
  .refine(value=>value.kind!=="file"||!!value.stored,"检查点文件缺少完整指纹")
  .refine(value=>value.kind!=="link"||!!value.link,"检查点链接缺少目标记录");
export type CheckpointFile=z.infer<typeof checkpointFile>;
export const checkpointRepo=z.object({id:z.string().uuid(),relative:z.string().refine(value=>value===""||checkpointPath.safeParse(value).success),source:z.string(),gitDir:z.string(),commonDir:z.string(),identity:z.string(),format:z.enum(["sha1","sha256"]),head:checkpointOid.optional(),branch:z.string(),
  index:checkpointStoredFile.optional(),sharedIndex:checkpointStoredFile.optional(),sharedName:z.string().regex(/^sharedindex\.[a-f0-9]{40,64}$/).optional(),
  shallow:checkpointStoredFile.optional(),sparse:checkpointStoredFile.optional(),exclude:checkpointStoredFile.optional(),globalExclude:checkpointStoredFile.optional(),
  config:z.record(z.string(),z.string()),stages:z.array(checkpointIndexEntry),undo:z.array(checkpointIndexEntry),flags:z.array(z.object({path:z.string().min(1),bits:z.string().regex(/^[a-f0-9]+$/)}).strict()),roots:z.array(checkpointOid),
  files:z.array(checkpointFile),pack:checkpointStoredFile.optional(),dependencies:z.array(z.object({path:checkpointPath,kind:z.enum(["uninitializedSubmodule","externalLink","externalFilter","excludedLinkTarget"]),detail:z.string()}).strict())}).strict();
export type CheckpointRepo=z.infer<typeof checkpointRepo>;
export const checkpointContext=z.object({jobId:z.string().uuid(),title:z.string(),state:z.string(),workflow:z.object({id:z.string(),title:z.string(),step:z.number(),total:z.number()}).strict().optional(),
  delivery:z.object({revision:z.number(),reportId:z.string().optional(),status:z.string(),checks:deliveryChecksSchema}).strict().optional()}).strict();
export const checkpointManifest=z.object({version:z.literal(1),id:z.string().uuid(),title:z.string().trim().min(1).max(200),createdAt:z.number().finite(),sealedAt:z.number().finite().optional(),
  source:z.string(),projectRelative:z.string().refine(value=>value===""||checkpointPath.safeParse(value).success),ignored:z.array(checkpointPath),repos:z.array(checkpointRepo).min(1),
  context:checkpointContext.optional(),fileCount:z.number().int().nonnegative(),totalBytes:z.number().int().nonnegative().safe(),signature:checkpointDigest}).strict();
export type CheckpointManifest=z.infer<typeof checkpointManifest>;
export interface CheckpointProgress {id:string;phase:"inspecting"|"copying"|"packing"|"verifying"|"publishing"|"restoring";path?:string;bytes:number;totalBytes:number;files:number;totalFiles:number}
export const checkpointEntry=z.object({id:z.string().uuid(),root:z.string(),title:z.string(),createdAt:z.number().finite(),status:z.enum(["preview","capturing","ready","failed","cancelled","interrupted"]),manifestSha256:checkpointDigest.optional(),sealedAt:z.number().finite().optional(),source:z.string(),fileCount:z.number().int().nonnegative(),totalBytes:z.number().int().nonnegative().safe(),issue:z.string().optional(),verification:z.object({at:z.number().finite(),passed:z.boolean()}).strict().optional()}).strict();
export type CheckpointEntry=z.infer<typeof checkpointEntry>;
export const checkpointRestore=z.object({id:z.string().uuid(),checkpointId:z.string().uuid(),manifestSha256:checkpointDigest,status:z.enum(["restoring","ready","failed","cancelled","interrupted"]),createdAt:z.number().finite(),attempt:z.string(),target:z.string(),mode:z.enum(["independent","linked"]),branch:z.string(),issue:z.string().optional(),jobId:z.string().uuid().optional()}).strict();
export type CheckpointRestore=z.infer<typeof checkpointRestore>;
export interface CheckpointView {revision:number;storage:string;entries:CheckpointEntry[];restores:CheckpointRestore[];issue?:string;active?:{id:string;kind:"preview"|"capture"|"verify"|"restore"|"review";entryId?:string;publishing:boolean};progress?:CheckpointProgress;linkedReview?:{entryId:string;token:string;expiresAt:number;source:string;head:string;branch:string};}
