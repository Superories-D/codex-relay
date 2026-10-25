import {z} from "zod";
import {checkpointDigest} from "./checkpoints";
import type {AdoptionTransactionView} from "./handoff-adoption";
const uuid=z.string().uuid();
export const sourceApplicationPolicy=z.object({newFiles:z.enum(["inheritProject","refuse"]),omittedSetup:z.enum(["preserve","delete"])}).strict();
export const sourceRecoverySummary=z.object({id:uuid,outcome:z.enum(["finished","restored","mixed"]),at:z.number().finite(),sha256:checkpointDigest}).strict();
export type SourceApplicationPolicy=z.infer<typeof sourceApplicationPolicy>;
export const sourceApplication=z.object({id:uuid,previewId:uuid,previewSha256:checkpointDigest,workspaceId:uuid,reviewId:uuid,requestSha256:checkpointDigest,home:z.string(),createdAt:z.number().finite(),policy:sourceApplicationPolicy,status:z.enum(["preparing","prepared","applying","complete","interrupted","failed","recovered"]),transactionSha256:checkpointDigest.optional(),acceptanceSha256:checkpointDigest.optional(),recoveries:z.array(sourceRecoverySummary).default([]),issue:z.string().optional()}).strict();
export type SourceApplication=z.infer<typeof sourceApplication>;
export interface SourceApplicationDetail {
  application:SourceApplication;view:AdoptionTransactionView;
  observationSha256:string;
  sourceAcceptance?:{status:string;at:number};
  recovery?:{id:string;outcome:string;at:number};
  permissions:{id:string;path:string;mode:"preserveOriginal"|"inheritProject";sddl?:string}[];
}
