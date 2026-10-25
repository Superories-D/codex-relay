import {z} from "zod";
import {checkpointDigest,checkpointPath} from "./checkpoints";
const uuid=z.string().uuid(),decimal=z.string().regex(/^\d+$/),absolute=z.string().refine(value=>/^(?:[A-Za-z]:[\\/]|\\\\)/.test(value));
export const adoptionFileProof=z.object({dev:decimal,ino:decimal,bytes:z.number().int().nonnegative().safe(),sha256:checkpointDigest}).strict();
export type AdoptionFileProof=z.infer<typeof adoptionFileProof>;
export const adoptionMetadata=z.object({attributes:z.number().int().nonnegative(),links:z.number().int().positive(),security:z.string(),securitySha256:checkpointDigest,created:decimal,modified:decimal,streams:z.array(z.string())}).strict();
export const adoptionDirectoryProof=z.object({path:absolute,dev:decimal,ino:decimal}).strict();
export const adoptionNativeRequest=z.object({version:z.literal(1),id:uuid,transactionId:uuid,owner:uuid,home:absolute,root:absolute,path:checkpointPath,action:z.enum(["create","replace","delete"]),stage:checkpointPath.optional(),before:adoptionFileProof.optional(),after:adoptionFileProof.optional(),beforeMetadata:adoptionMetadata.optional(),afterMetadata:adoptionMetadata.optional(),metadataSource:z.object({path:z.string().regex(/^actual\/[a-fA-F0-9-]{36}$/),proof:adoptionFileProof,metadata:adoptionMetadata}).strict().optional(),restoreMetadata:z.boolean().optional(),directories:z.array(adoptionDirectoryProof).min(1)}).strict().superRefine((value,context)=>{
  if((value.action==="create")===!!value.before||(value.action==="delete")===!!value.after||(value.action==="delete")===!!value.stage)context.addIssue({code:"custom",message:"采用文件操作的前后状态不一致"});
  if(value.metadataSource&&(value.action==="delete"||!uuid.safeParse(value.metadataSource.path.slice(7)).success)||value.restoreMetadata&&!value.metadataSource)context.addIssue({code:"custom",message:"采用元数据来源缺少独立备份身份"});
});
export type AdoptionNativeRequest=z.infer<typeof adoptionNativeRequest>;
export const adoptionNativeReceipt=z.object({version:z.literal(1),id:uuid,transactionId:uuid,requestSha256:checkpointDigest,phase:z.enum(["prepared","applied"]),before:adoptionFileProof.nullable(),after:adoptionFileProof.nullable()}).strict();
export const adoptionNativeInspection=z.object({version:z.literal(1),id:uuid,transactionId:uuid,prepared:z.boolean(),applied:z.boolean(),target:adoptionFileProof.nullable(),stage:adoptionFileProof.nullable(),backup:adoptionFileProof.nullable(),beforeCopy:adoptionFileProof.nullable(),targetMetadata:adoptionMetadata.nullable().optional(),stageMetadata:adoptionMetadata.nullable().optional(),backupMetadata:adoptionMetadata.nullable().optional()}).strict();
export type AdoptionNativeInspection=z.infer<typeof adoptionNativeInspection>;
export const adoptionFileState=z.enum(["notStarted","prepared","displaced","applied","appliedUnsealed","partialBackup","stagingChanged","retainedEdits","userChanged","inconsistent"]);
export type AdoptionFileState=z.infer<typeof adoptionFileState>;
export const adoptionTransition=z.object({id:uuid,path:checkpointPath,requestSha256:checkpointDigest}).strict();
export const adoptionTransaction=z.object({version:z.literal(1),id:uuid,owner:uuid,entryId:uuid,workspaceId:uuid,reviewId:uuid,createdAt:z.number().finite(),home:absolute,root:absolute,rootIdentity:z.string().regex(/^\d+:\d+$/),files:z.array(adoptionTransition).min(1),metadata:z.array(z.object({id:uuid,path:absolute,proof:adoptionFileProof}).strict())}).strict();
export type AdoptionTransaction=z.infer<typeof adoptionTransaction>;
export interface AdoptionTransactionView {id:string;sha256:string;files:{id:string;path:string;state:AdoptionFileState;observed:AdoptionNativeInspection}[];metadataUnchanged:boolean;complete:boolean;}
