import {z} from "zod";
import {checkpointDigest,checkpointOid,checkpointPath,checkpointStoredFile,checkpointContext,type CheckpointManifest,type CheckpointIndexEntry,type CheckpointFile} from "./checkpoints";
import {deliveryChecksSchema,deliveryReportSchema} from "./delivery";
import {handoffAttachment,handoffReplica} from "./handoff-assembly";
import {adoptionPreviewSummary} from "./handoff-adoption-preview";

export const handoffObjectFormat=z.enum(["sha1","sha256"]);
export type HandoffObjectFormat=z.infer<typeof handoffObjectFormat>;
export const handoffRole=z.enum(["base","source","task"]);
export type HandoffRole=z.infer<typeof handoffRole>;
/** A window bounds transport memory, never the size of a retained file. */
export const handoffContentSelection=z.object({role:z.enum(["base","source","task","result"]),path:checkpointPath,layer:z.enum(["working","index","undo","edited"]),stage:z.number().int().min(0).max(3).default(0),offset:z.number().int().nonnegative().safe().default(0),length:z.number().int().min(1).max(65536).default(32768)}).strict().superRefine((value,ctx)=>{
  if(!Number.isSafeInteger(value.offset+value.length+3)||value.layer==="edited"&&value.role!=="result"||value.layer==="undo"&&value.role==="result"||["working","edited"].includes(value.layer)&&value.stage!==0)ctx.addIssue({code:"custom",message:"内容窗口与审阅层不一致"});
});
export type HandoffContentSelection=z.infer<typeof handoffContentSelection>;
export interface HandoffContentDocument {
  selection:HandoffContentSelection;workspaceId?:string;kind:"file"|"absent"|"link"|"gitlink"|"tree"|"sparse";
  mode?:string;oid?:string;linkTarget?:string;
  bytes?:number;sha256?:string;identity?:string;
  window?:{offset:number;length:number;rawBase64:string;eof:boolean;encoding:"utf8"|"binary";text?:string;textOffset?:number;textBytes?:number;firstLine?:number};
}
export const handoffMode=z.enum(["100644","100755","120000","160000","040000"]);
export const handoffConflictEntry=z.object({
  path:checkpointPath,mode:handoffMode,oid:checkpointOid,stage:z.number().int().min(1).max(3),
}).strict();
export const handoffMergeMessage=z.object({paths:z.array(checkpointPath),type:z.string().min(1),text:z.string()}).strict();
export const handoffMergeResult=z.object({
  version:z.literal(1),id:z.string().uuid(),status:z.enum(["clean","conflicted"]),format:handoffObjectFormat,
  baseline:z.object({kind:z.enum(["checkpointWorking","history"]),oid:checkpointOid}).strict(),
  source:checkpointOid,task:checkpointOid,tree:checkpointOid,
  conflicts:z.array(handoffConflictEntry),messages:z.array(handoffMergeMessage),
  output:z.object({path:checkpointPath,bytes:z.number().int().nonnegative().safe(),sha256:checkpointDigest}).strict(),
}).strict().superRefine((value,ctx)=>{
  const length=value.format==="sha1"?40:64;
  for(const oid of [value.baseline.oid,value.source,value.task,value.tree,...value.conflicts.map(entry=>entry.oid)])
    if(oid.length!==length)ctx.addIssue({code:"custom",message:"交接 Git 对象格式不一致"});
  if(value.status==="clean"&&(value.conflicts.length||value.messages.some(message=>message.type.startsWith("CONFLICT"))))
    ctx.addIssue({code:"custom",message:"存在冲突的交接结果不能标记为可用"});
});
export type HandoffConflictEntry=z.infer<typeof handoffConflictEntry>;
export type HandoffMergeMessage=z.infer<typeof handoffMergeMessage>;
export type HandoffMergeResult=z.infer<typeof handoffMergeResult>;
export interface HandoffProgress {
  phase:"hashing"|"snapshotting"|"merging"|"verifying"|"sealing"|"materializing";
  role?:HandoffRole;path?:string;bytes:number;files:number;totalFiles:number;
}
export const handoffTreeMember=z.object({
  path:checkpointPath,mode:handoffMode,oid:checkpointOid,kind:z.enum(["file","link","gitlink","index"]),
  bytes:z.number().int().nonnegative().safe(),sha256:checkpointDigest.optional(),
  link:z.object({target:z.string(),directory:z.boolean(),internal:z.string().optional(),external:z.boolean()}).strict().optional(),
}).strict();
export const handoffDependency=z.object({path:checkpointPath,kind:z.enum(["uninitializedSubmodule","externalLink","externalFilter","excludedLinkTarget","nestedRepository","shallowHistory","ignoredSetup"]),detail:z.string()}).strict();
export const handoffTreeSnapshot=z.object({
  version:z.literal(1),id:z.string().uuid(),role:handoffRole,checkpointId:z.string().uuid(),
  manifestSha256:checkpointDigest,selectionSha256:checkpointDigest,repositoryId:z.string().uuid(),relative:z.string(),
  format:handoffObjectFormat,head:checkpointOid.optional(),tree:checkpointOid,createdAt:z.number().finite(),
  members:z.array(handoffTreeMember),excludedIgnored:z.array(checkpointPath),
  dependencies:z.array(handoffDependency),
  nestedRepositories:z.array(z.object({repositoryId:z.string().uuid(),relative:checkpointPath,tracked:z.boolean()}).strict()),
}).strict();
export type HandoffTreeMember=z.infer<typeof handoffTreeMember>;
export type HandoffTreeSnapshot=z.infer<typeof handoffTreeSnapshot>;

export const handoffArchive=z.object({
  version:z.literal(1),id:z.string().uuid(),role:handoffRole,checkpointId:z.string().uuid(),
  manifestSha256:checkpointDigest,requestSha256:checkpointDigest,createdAt:z.number().finite(),
  payloadIdentity:z.string(),files:z.array(checkpointStoredFile),
  totalBytes:z.number().int().nonnegative().safe(),
}).strict();
export type HandoffArchive=z.infer<typeof handoffArchive>;

export const handoffResolutionChoice=z.object({path:checkpointPath,choice:z.enum(["source","task","base","delete","working"]),expectedSha256:checkpointDigest.optional(),expectedBytes:z.number().int().nonnegative().safe().optional()}).strict().superRefine((value,ctx)=>{
  if(value.choice==="working"&&(!value.expectedSha256||value.expectedBytes===undefined))ctx.addIssue({code:"custom",message:"手动解决冲突需要绑定完整工作文件指纹"});
  if(value.choice!=="working"&&(value.expectedSha256||value.expectedBytes!==undefined))ctx.addIssue({code:"custom",message:"已有对象的冲突选择不能带入工作文件指纹"});
});
export const handoffResolutionInput=z.object({id:z.string().uuid(),workspaceId:z.string().uuid(),strategy:z.enum(["paths","source","task"]),choices:z.array(handoffResolutionChoice)}).strict();
export type HandoffResolutionInput=z.infer<typeof handoffResolutionInput>;
export const handoffResolution=z.object({
  version:z.literal(1),id:z.string().uuid(),workspaceId:z.string().uuid(),mergeId:z.string().uuid(),
  requestSha256:checkpointDigest,strategy:z.enum(["paths","source","task"]),
  choices:z.array(handoffResolutionChoice),tree:checkpointOid,parentCommit:checkpointOid,
  createdAt:z.number().finite(),format:handoffObjectFormat,
}).strict();
export type HandoffResolution=z.infer<typeof handoffResolution>;

export const handoffWorkspaceFile=z.object({
  path:checkpointPath,mode:z.enum(["100644","100755","120000","160000"]),oid:checkpointOid,
  bytes:z.number().int().nonnegative().safe(),sha256:checkpointDigest.optional(),
  disposition:z.enum(["file","sparse","link","deferredLink","gitlink"]),
  linkTarget:z.string().optional(),directory:z.boolean().optional(),untracked:z.boolean().optional(),
}).strict();
export const handoffWorkspace=z.object({
  version:z.literal(1),id:z.string().uuid(),mergeId:z.string().uuid(),
  sourceSnapshotId:z.string().uuid(),taskSnapshotId:z.string().uuid(),
  baselineSnapshotId:z.string().uuid().optional(),requestSha256:checkpointDigest,
  resolutionId:z.string().uuid().optional(),
  compositionId:z.string().uuid().optional(),replica:handoffReplica.optional(),attachments:z.array(handoffAttachment).optional(),
  createdAt:z.number().finite(),format:handoffObjectFormat,
  state:z.enum(["reviewable","needsResolution","needsDependencies"]),
  tree:checkpointOid,commit:checkpointOid,parents:z.array(checkpointOid).length(2),
  target:z.string(),identity:z.string(),gitFileSha256:checkpointDigest,
  adminDirectory:z.string(),adminIdentity:z.string(),indexSha256:checkpointDigest,
  files:z.array(handoffWorkspaceFile),conflicts:z.array(handoffConflictEntry),
  messages:z.array(handoffMergeMessage),dependencies:z.array(handoffDependency),
}).strict();
export type HandoffWorkspace=z.infer<typeof handoffWorkspace>;
export type HandoffWorkspaceFile=z.infer<typeof handoffWorkspaceFile>;
export interface HandoffWorkspaceVerification {
  id:string;at:number;unchanged:boolean;
  changes:{path:string;reason:"content"|"missing"|"unexpected"|"index"|"head"|"layout"}[];
}

const identities=z.object({base:z.string().uuid(),source:z.string().uuid(),task:z.string().uuid()}).strict();
export const handoffCriteria=z.object({revision:z.number().int().positive(),checks:deliveryChecksSchema}).strict();
export const handoffAcceptanceStatus=z.enum(["passed","failed","unverified","unconfigured"]);
export const handoffReviewSummary=z.object({id:z.string().uuid(),workspaceId:z.string().uuid(),criteriaRevision:z.number().int().positive(),at:z.number().finite(),expiresAt:z.number().finite(),status:handoffAcceptanceStatus,sha256:checkpointDigest}).strict();
export const handoffReviewRecord=z.object({version:z.literal(1),id:z.string().uuid(),entryId:z.string().uuid(),workspaceId:z.string().uuid(),commit:checkpointOid,workspaceSha256:checkpointDigest,criteriaRevision:z.number().int().positive(),criteriaSha256:checkpointDigest,createdAt:z.number().finite(),expiresAt:z.number().finite(),status:handoffAcceptanceStatus,report:deliveryReportSchema.optional()}).strict().superRefine((value,ctx)=>{
  if(value.expiresAt<=value.createdAt||(value.status==="unconfigured")!==!value.report||value.report&&(value.report.status!==value.status||value.report.revision!==value.criteriaRevision))ctx.addIssue({code:"custom",message:"采用验收状态与完整报告不一致"});
});
export type HandoffReviewRecord=z.infer<typeof handoffReviewRecord>;
export type HandoffReviewSummary=z.infer<typeof handoffReviewSummary>;
export const handoffContinuation=z.object({workspaceId:z.string().uuid(),reviewId:z.string().uuid(),jobId:z.string().uuid(),admissionId:z.string().uuid(),proofId:z.string().uuid(),proofSha256:checkpointDigest,criteriaRevision:z.number().int().positive(),createdAt:z.number().finite()}).strict();
export type HandoffContinuation=z.infer<typeof handoffContinuation>;
export const handoffPendingAdmission=z.object({id:z.string().uuid(),workspaceId:z.string().uuid(),reviewId:z.string().uuid(),requestSha256:checkpointDigest}).strict();
export const handoffEntry=z.object({
  id:z.string().uuid(),requestSha256:checkpointDigest,title:z.string().min(1).max(200),
  createdAt:z.number().finite(),updatedAt:z.number().finite(),
  checkpointId:z.string().uuid(),manifestSha256:checkpointDigest,
  taskJobId:z.string().uuid(),taskCwd:z.string(),sourceCwd:z.string(),taskSignature:checkpointDigest,
  projectRelative:z.string().refine(value=>!value||checkpointPath.safeParse(value).success),
  ignored:z.array(checkpointPath),
  status:z.enum(["building","reviewable","needsResolution","needsDependencies","failed","cancelled","interrupted"]),
  archives:identities,snapshots:identities,mergeId:z.string().uuid(),initialWorkspaceId:z.string().uuid(),
  retryOf:z.discriminatedUnion("mode",[
    z.object({entryId:z.string().uuid(),mode:z.literal("recapture")}).strict(),
    z.object({entryId:z.string().uuid(),mode:z.literal("retained"),archives:identities}).strict(),
  ]).optional(),
  graph:z.object({id:z.string().uuid(),sha256:checkpointDigest,total:z.number().int().nonnegative().safe()}).strict().optional(),
  pendingGraph:z.object({id:z.string().uuid(),nodeId:z.string().uuid(),graphSha256:checkpointDigest,requestSha256:checkpointDigest,resolutionId:z.string().uuid(),sourceWorkspaceId:z.string().uuid()}).strict().optional(),
  assembly:z.object({id:z.string().uuid(),graphSha256:checkpointDigest.optional(),sourceWorkspaceId:z.string().uuid(),workspaceId:z.string().uuid(),sha256:checkpointDigest,requestSha256:checkpointDigest}).strict().optional(),
  pendingAssembly:z.object({id:z.string().uuid(),graphSha256:checkpointDigest.optional(),sourceWorkspaceId:z.string().uuid(),requestSha256:checkpointDigest}).strict().optional(),
  workspaceIds:z.array(z.string().uuid()),currentWorkspaceId:z.string().uuid().optional(),
  resolutionAttempts:z.array(z.object({workspaceId:z.string().uuid(),sourceWorkspaceId:z.string().uuid(),resolutionId:z.string().uuid(),requestSha256:checkpointDigest}).strict()),
  pendingWorkspaceId:z.string().uuid().optional(),issue:z.string().optional(),context:checkpointContext,
  criteria:handoffCriteria.default({revision:1,checks:[]}),review:handoffReviewSummary.optional(),
  continuations:z.array(handoffContinuation).default([]),pendingAdmission:handoffPendingAdmission.optional(),
  adoptionPreviews:z.array(adoptionPreviewSummary).default([]),
  verification:z.object({at:z.number().finite(),unchanged:z.boolean(),changes:z.number().int().nonnegative()}).strict().optional(),
}).strict();
export type HandoffEntry=z.infer<typeof handoffEntry>;
export interface HandoffView {
  revision:number;storage:string;entries:HandoffEntry[];issue?:string;
  active?:{id:string;entryId:string;kind:"build"|"resolve"|"verify"|"recover"|"inspect"|"review"|"admit"|"content"|"graphResolve"|"assemble"|"sourcePreview";publishing:boolean};
  progress?:HandoffProgress;
  workingReview?:{entryId:string;workspaceId:string;nodeId?:string;graphSha256?:string;path:string;at:number;bytes:number;sha256:string};
  contentReview?:{entryId:string;requestId:string;workspaceId?:string;nodeId?:string;graphSha256?:string;at:number};
}
export interface HandoffFileReview {
  path:string;base?:HandoffTreeMember;source?:HandoffTreeMember;task?:HandoffTreeMember;result?:HandoffWorkspaceFile;
  index:Record<HandoffRole,CheckpointIndexEntry[]>;
  undo:Record<HandoffRole,CheckpointIndexEntry[]>;
  flags:Partial<Record<HandoffRole,string>>;
  setup:Partial<Record<HandoffRole,CheckpointFile>>;
}
export interface HandoffLayerReview {
  checkpointId:string;manifestSha256:string;source:string;context?:CheckpointManifest["context"];
  tree:string;head?:string;branch:string;indexSha256?:string;sharedIndexSha256?:string;
  conflicts:number;flagged:number;resolveUndo:number;
}
export interface HandoffDetail {
  entry:HandoffEntry;baseline:{kind:"checkpointWorking";checkpointId:string;manifestSha256:string};
  layers:Record<HandoffRole,HandoffLayerReview>;
  merge:Omit<HandoffMergeResult,"conflicts"|"messages">&{conflicts:HandoffConflictEntry[];messages:HandoffMergeMessage[];totalConflicts:number;totalConflictPaths:number;totalMessages:number};
  workspace?:Omit<HandoffWorkspace,"files"|"conflicts"|"messages">;
  total:number;offset:number;files:HandoffFileReview[];
  acceptance?:HandoffReviewRecord;
  graph?:{pointer:NonNullable<HandoffEntry["graph"]>;offset:number;nodes:import("./handoff-graph").HandoffGraphNode[]};
}
export interface HandoffTaskAdmission {
  entry:HandoffEntry;workspace:HandoffWorkspace;review:HandoffReviewRecord;
  admissionId:string;cwd:string;title:string;prompt:string;
  proof:{id:string;sha256:string;at:number};
  validate:()=>Promise<void>;
}
