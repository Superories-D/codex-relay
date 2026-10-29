import {z} from "zod";
import {checkpointDigest,checkpointOid,checkpointPath} from "./checkpoints";
import {handoffObjectFormat,handoffRole} from "./handoff";
const uuid=z.string().uuid(),relative=z.string().refine(value=>!value||checkpointPath.safeParse(value).success);
export const handoffGraphMember=z.object({repositoryId:uuid.optional(),relative:checkpointPath,parentRelative:relative,tracked:z.boolean(),format:handoffObjectFormat.optional(),head:checkpointOid.optional(),source:z.string().optional(),gitlinks:z.array(z.object({stage:z.number().int().min(0).max(3),oid:checkpointOid}).strict())}).strict();
const roles=z.object({base:handoffGraphMember.optional(),source:handoffGraphMember.optional(),task:handoffGraphMember.optional()}).strict();
const identities=z.object({base:uuid,source:uuid,task:uuid}).strict();
export const handoffGraphNode=z.object({id:uuid,path:checkpointPath,kind:z.enum(["submodule","nested","mixed"]),roles,snapshots:identities,mergeId:uuid,initialWorkspaceId:uuid,currentWorkspaceId:uuid.optional(),workspaceIds:z.array(uuid),format:handoffObjectFormat.optional(),status:z.enum(["needsChoice","reviewable","needsResolution","needsDependencies"]),issues:z.array(z.enum(["missingBase","missingSource","missingTask","pathCaseConflict","formatMismatch","missingHistory","topologyChange","trackingChange"])),resolutionAttempts:z.array(z.object({workspaceId:uuid,sourceWorkspaceId:uuid,resolutionId:uuid,requestSha256:checkpointDigest}).strict())}).strict();
export type HandoffGraphNode=z.infer<typeof handoffGraphNode>;
export const handoffGraphRecord=z.object({version:z.literal(1),id:uuid,owner:uuid,entryId:uuid,createdAt:z.number().finite(),archives:z.object({base:z.object({id:uuid,manifestSha256:checkpointDigest}).strict(),source:z.object({id:uuid,manifestSha256:checkpointDigest}).strict(),task:z.object({id:uuid,manifestSha256:checkpointDigest}).strict()}).strict(),nodes:z.array(handoffGraphNode)}).strict();
export type HandoffGraphRecord=z.infer<typeof handoffGraphRecord>;
export const handoffGraphPointer=z.object({id:uuid,sha256:checkpointDigest,total:z.number().int().nonnegative().safe()}).strict();
export type HandoffGraphPointer=z.infer<typeof handoffGraphPointer>;
export interface HandoffGraphDetail {pointer:HandoffGraphPointer;node:HandoffGraphNode;assembled?:boolean;review?:Omit<import("./handoff").HandoffDetail,"entry"|"baseline"|"acceptance"|"graph">}
export const handoffGraphRoles=handoffRole.options;
