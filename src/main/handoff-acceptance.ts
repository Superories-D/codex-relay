import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {atomicWrite} from "../core/store";
import {verifyDelivery} from "../core/delivery";
import {handoffReviewRecord,handoffReviewSummary,type HandoffEntry,type HandoffReviewRecord,type HandoffReviewSummary,type HandoffWorkspace} from "../shared/handoff";
import {checkpointFingerprint,checkpointOutputPath,checkpointSourcePath,insideCheckpoint,sameCheckpointPath} from "./checkpoint-file";
import type {HandoffRepository} from "./handoff-repository";

const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
export async function handoffProject(entry:HandoffEntry,workspace:HandoffWorkspace){
  const candidate=path.join(workspace.target,...entry.projectRelative.split("/").filter(Boolean)),project=await fs.realpath(candidate);
  if(!sameCheckpointPath(project,workspace.target)&&!insideCheckpoint(workspace.target,project)||!(await fs.stat(project)).isDirectory())throw Error("集成项目目录超出候选工作区或已变化");return project;
}
async function verifiedCandidate(entry:HandoffEntry,repository:HandoffRepository){
  if(!entry.currentWorkspaceId||entry.status!=="reviewable")throw Error("请先解决候选冲突和依赖，再进行采用验收");
  const workspace=await repository.readWorkspace(entry.currentWorkspaceId);if(workspace.state!=="reviewable"||!(await repository.verifyWorkspace(workspace.id)).unchanged)throw Error("集成候选在审阅后发生变化，请重新生成或核对候选");return workspace;
}
/** A fresh acceptance report is always evaluated against the integrated bytes. */
export async function createHandoffReview(input:{entry:HandoffEntry;repository:HandoffRepository;directory:string;signal:AbortSignal;assertTask:()=>void}){
  input.assertTask();input.signal.throwIfAborted();const workspace=await verifiedCandidate(input.entry,input.repository),cwd=await handoffProject(input.entry,workspace),checks=input.entry.criteria.checks;
  const report=checks.length?await verifyDelivery(cwd,checks,{revision:input.entry.criteria.revision,source:"manual",signal:input.signal}):undefined;
  input.signal.throwIfAborted();await verifiedCandidate(input.entry,input.repository);input.assertTask();
  const now=Date.now(),record=handoffReviewRecord.parse({version:1,id:randomUUID(),entryId:input.entry.id,workspaceId:workspace.id,commit:workspace.commit,workspaceSha256:hash(JSON.stringify(workspace)),criteriaRevision:input.entry.criteria.revision,criteriaSha256:hash(JSON.stringify(checks)),createdAt:now,expiresAt:now+10*60*1000,status:report?.status||"unconfigured",report});
  const json=JSON.stringify(record),file=await checkpointOutputPath(input.directory,`reviews/${record.id}.json`);await atomicWrite(file,json);input.signal.throwIfAborted();
  const summary=handoffReviewSummary.parse({id:record.id,workspaceId:record.workspaceId,criteriaRevision:record.criteriaRevision,at:record.createdAt,expiresAt:record.expiresAt,status:record.status,sha256:hash(json)});return{record,summary};
}
export async function readHandoffReview(directory:string,entry:HandoffEntry,summary:HandoffReviewSummary){
  const file=await checkpointSourcePath(directory,`reviews/${summary.id}.json`),before=await checkpointFingerprint(file),json=await fs.readFile(file);
  if(before.sha256!==summary.sha256||hash(json)!==summary.sha256)throw Error("采用验收记录完整性未通过");const record=handoffReviewRecord.parse(JSON.parse(json.toString("utf8")));
  if(record.id!==summary.id||record.entryId!==entry.id||record.workspaceId!==summary.workspaceId||record.criteriaRevision!==summary.criteriaRevision||record.status!==summary.status||record.expiresAt!==summary.expiresAt||record.createdAt!==summary.at||hash(JSON.stringify(record.report?.findings.map(finding=>finding.check)||[]))!==record.criteriaSha256)throw Error("采用验收记录与交接候选不一致");return record;
}
/** Re-read candidate bytes at admission; a cached green report is insufficient. */
export async function preflightHandoffAdmission(input:{entry:HandoffEntry;record:HandoffReviewRecord;repository:HandoffRepository;signal:AbortSignal;assertTask:()=>void;now?:number}){
  const {entry,record}=input;input.assertTask();input.signal.throwIfAborted();
  if(record.expiresAt<=(input.now??Date.now())||entry.currentWorkspaceId!==record.workspaceId||entry.criteria.revision!==record.criteriaRevision||hash(JSON.stringify(entry.criteria.checks))!==record.criteriaSha256)throw Error("采用验收已过期或条件已变化，请重新验收");
  if(!["passed","unconfigured"].includes(record.status))throw Error("集成候选尚未通过当前验收条件");
  const workspace=await verifiedCandidate(entry,input.repository);if(workspace.commit!==record.commit||hash(JSON.stringify(workspace))!==record.workspaceSha256)throw Error("采用验收与候选文件清单不一致");
  const cwd=await handoffProject(entry,workspace),report=entry.criteria.checks.length?await verifyDelivery(cwd,entry.criteria.checks,{revision:entry.criteria.revision,source:"manual",signal:input.signal}):undefined;
  if(report&&report.status!=="passed")throw Error("候选在采用前未通过重新验收");
  await verifiedCandidate(entry,input.repository);input.assertTask();input.signal.throwIfAborted();return{workspace,cwd,report};
}
