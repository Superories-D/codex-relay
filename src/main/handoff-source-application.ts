import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {z} from "zod";
import type {HandoffEntry} from "../shared/handoff";
import type {SourceApplication,SourceApplicationDetail} from "../shared/handoff-source-application";
import type {AdoptionPreviewPlan} from "./handoff-adoption-preview";
import {assertAdoptionPreviewSource,assertAdoptionUntouchedSource} from "./handoff-adoption-preview";
import {verifyDelivery} from "../core/delivery";
import {prepareAdoptionTransaction,readAdoptionTransaction,inspectAdoptionTransaction,applyAdoptionTransaction,adoptionTransitionRequest} from "./handoff-adoption-transaction";
import {assertAdoptionRepositoryGuards,withAdoptionRepositoryLeases} from "./handoff-adoption-guards";
import {checkpointSourcePath,checkpointFingerprint,sameCheckpointPath} from "./checkpoint-file";
import {adoptionObservationSha,prepareAdoptionRecovery,applyAdoptionRecovery} from "./handoff-adoption-recovery";
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex"),uuid=z.string().uuid();
type Options={native?:boolean;signal:AbortSignal;executable?:string;protect:(directory:string)=>Promise<void>;assertTask:()=>void};
async function save(file:string,value:unknown){const json=JSON.stringify(value),handle=await fs.open(file,"wx",0o600);try{await handle.writeFile(json);await handle.sync();}finally{await handle.close();}return hash(json);}
export function sourceApplicationHome(source:string,id:string){uuid.parse(id);return path.join(path.dirname(source),`.codex-relay-adoption-${id}`);}
function bound(application:SourceApplication,entry:HandoffEntry,plan:AdoptionPreviewPlan){
  if(application.previewId!==plan.id||application.workspaceId!==plan.workspaceId||application.reviewId!==plan.reviewId||entry.id!==plan.entryId||!sameCheckpointPath(application.home,sourceApplicationHome(plan.source,application.id)))throw Error("原项目写回计划与已审阅候选不一致");
}
export async function prepareSourceApplication(input:{application:SourceApplication;entry:HandoffEntry;plan:AdoptionPreviewPlan;previewFolder:string;owner:string},options:Options){
  const {application,entry,plan}=input;bound(application,entry,plan);if(application.workspaceId!==entry.currentWorkspaceId||plan.expiresAt<=Date.now()||entry.review?.id!==plan.reviewId)throw Error("采用验收已过期，请重新验收当前候选。");
  const files:Parameters<typeof prepareAdoptionTransaction>[0]["files"]=[];
  for(const row of plan.files){
    if(row.action==="unchanged"||row.ignored&&!row.after&&application.policy.omittedSetup==="preserve")continue;
    if(row.action==="blocked"&&(row.issue!=="newFilePermissions"||application.policy.newFiles!=="inheritProject"))throw Error("请先处理全部特殊路径，再准备原项目写回");
    const relative=row.repository?`${row.repository}/${row.path}`:row.path;files.push({path:relative,before:row.before,after:row.after&&row.afterFile?{file:row.afterFile,...row.after}:undefined});
  }
  if(!files.length)throw Error("当前写回策略没有文件变化");options.assertTask();
  return withAdoptionRepositoryLeases(plan.guards,path.join(input.previewFolder,"commands"),options,async signal=>{
    const assertSource=async()=>{options.assertTask();await assertAdoptionRepositoryGuards(plan.guards,path.join(input.previewFolder,"commands"),{...options,signal});await assertAdoptionPreviewSource(input.previewFolder,plan,{...options,signal});};await assertSource();
    const transaction=await prepareAdoptionTransaction({id:application.id,owner:input.owner,entryId:entry.id,workspaceId:application.workspaceId,reviewId:application.reviewId,home:application.home,root:plan.source,files,metadata:plan.guards.flatMap(guard=>guard.metadata.filter(file=>!!file.identity).map(file=>file.file))},{...options,signal,assertSource});
    await save(path.join(application.home,"source-application.json"),{version:1,applicationId:application.id,entryId:entry.id,previewId:plan.id,previewSha256:application.previewSha256,transactionSha256:transaction.sha256,policy:application.policy,sourceSha256:plan.sourceSha256});return transaction;
  });
}
export async function readSourceApplication(application:SourceApplication,entry:HandoffEntry,plan:AdoptionPreviewPlan){
  bound(application,entry,plan);if(!application.transactionSha256)throw Error("原项目写回尚未准备完成");const transaction=await readAdoptionTransaction(application.home,{id:application.id,owner:plan.owner,sha256:application.transactionSha256}),file=await checkpointSourcePath(application.home,"source-application.json"),binding=JSON.parse(await fs.readFile(file,"utf8"));
  if(binding.version!==1||binding.applicationId!==application.id||binding.entryId!==entry.id||binding.previewId!==plan.id||binding.previewSha256!==application.previewSha256||binding.transactionSha256!==application.transactionSha256||binding.sourceSha256!==plan.sourceSha256||JSON.stringify(binding.policy)!==JSON.stringify(application.policy)||!sameCheckpointPath(transaction.root,plan.source))throw Error("原项目写回计划与已审阅候选不一致");return transaction;
}
export async function sourceApplicationDetail(application:SourceApplication,entry:HandoffEntry,plan:AdoptionPreviewPlan,options:Pick<Options,"signal"|"executable">):Promise<SourceApplicationDetail>{
  const transaction=await readSourceApplication(application,entry,plan),view=await inspectAdoptionTransaction(transaction,application.transactionSha256!,options),permissions:SourceApplicationDetail["permissions"]=[];
  let sourceAcceptance:SourceApplicationDetail["sourceAcceptance"],recovery:SourceApplicationDetail["recovery"];
  if(application.acceptanceSha256){const file=await checkpointSourcePath(application.home,"source-acceptance.json"),bytes=await fs.readFile(file);if(hash(bytes)!==application.acceptanceSha256)throw Error("原项目写回验收记录完整性未通过");const proof=JSON.parse(bytes.toString("utf8"));if(proof.id!==application.id||proof.previewSha256!==application.previewSha256||proof.transactionSha256!==application.transactionSha256)throw Error("原项目写回验收记录完整性未通过");sourceAcceptance={at:proof.at,status:proof.status};}
  for(const summary of application.recoveries){const file=await checkpointSourcePath(application.home,`recoveries/${summary.id}/complete.json`),bytes=await fs.readFile(file);if(hash(bytes)!==summary.sha256)throw Error("原项目恢复记录完整性未通过");const proof=JSON.parse(bytes.toString("utf8"));if(proof.id!==summary.id||proof.transactionId!==application.id||proof.outcome!==summary.outcome||proof.at!==summary.at)throw Error("原项目恢复记录完整性未通过");recovery={id:summary.id,outcome:summary.outcome,at:summary.at};}
  for(const file of transaction.files){const {request}=await adoptionTransitionRequest(transaction,file);permissions.push({id:file.id,path:file.path,mode:request.creationSecurity?"inheritProject":"preserveOriginal",sddl:request.creationSecurity?.sddl||request.beforeMetadata?.sddl});}return{application,view,observationSha256:adoptionObservationSha(view),permissions,sourceAcceptance,recovery};
}
export async function applySourceApplication(input:{application:SourceApplication;entry:HandoffEntry;plan:AdoptionPreviewPlan;previewFolder:string},options:Options){
  const {application,entry,plan}=input,transaction=await readSourceApplication(application,entry,plan);if(entry.currentWorkspaceId!==application.workspaceId||entry.review?.id!==application.reviewId||plan.expiresAt<=Date.now())throw Error("采用验收已过期，请重新验收当前候选。");
  return withAdoptionRepositoryLeases(plan.guards,path.join(input.previewFolder,"commands"),options,async signal=>{
    await assertAdoptionPreviewSource(input.previewFolder,plan,{...options,signal});const assertSource=async()=>{options.assertTask();await assertAdoptionRepositoryGuards(plan.guards,path.join(input.previewFolder,"commands"),{...options,signal});};await assertSource();const result=await applyAdoptionTransaction(transaction,application.transactionSha256!,{...options,signal,assertSource});await assertSource();
    const changed=[];for(const file of transaction.files){const {request}=await adoptionTransitionRequest(transaction,file);changed.push({path:file.path,after:request.after});}await assertAdoptionUntouchedSource(input.previewFolder,plan,changed,{...options,signal});
    const report=entry.criteria.checks.length?await verifyDelivery(path.join(plan.source,...entry.projectRelative.split("/").filter(Boolean)),entry.criteria.checks,{revision:entry.criteria.revision,source:"manual",signal}):undefined;
    await assertSource();await assertAdoptionUntouchedSource(input.previewFolder,plan,changed,{...options,signal});const view=await inspectAdoptionTransaction(transaction,application.transactionSha256!,{...options,signal});if(!view.complete)throw Error("原项目写回后文件发生变化，完整恢复记录已保留");
    const proof={version:1,id:application.id,previewSha256:application.previewSha256,transactionSha256:application.transactionSha256,criteriaRevision:entry.criteria.revision,at:Date.now(),status:report?.status||"unconfigured",report},sourceAcceptanceSha256=await save(path.join(application.home,"source-acceptance.json"),proof);if(report&&report.status!=="passed")throw Error("原项目写回后未通过验收，请核对恢复计划");return{...view,sourceAcceptance:proof,sourceAcceptanceSha256};
  });
}
export async function recoverSourceApplication(input:{application:SourceApplication;entry:HandoffEntry;plan:AdoptionPreviewPlan;previewFolder:string;requestId:string;observationSha256:string;choices:{id:string;action:"finish"|"restore"|"keep"}[]},options:Options){
  const {application,entry,plan}=input,transaction=await readSourceApplication(application,entry,plan);
  const execute=async(signal:AbortSignal)=>{
    const assertSource=async()=>{options.assertTask();if(input.choices.some(choice=>choice.action!=="keep"))await assertAdoptionRepositoryGuards(plan.guards,path.join(input.previewFolder,"commands"),{...options,signal});};
    const before=await inspectAdoptionTransaction(transaction,application.transactionSha256!,{...options,signal});if(adoptionObservationSha(before)!==input.observationSha256)throw Error("采用恢复状态已变化，请重新核对全部路径");
    const recovery=await prepareAdoptionRecovery(transaction,application.transactionSha256!,{id:input.requestId,observationSha256:input.observationSha256,choices:input.choices},{...options,signal,assertSource}),result=await applyAdoptionRecovery(transaction,recovery,{...options,signal,assertSource}),file=await checkpointSourcePath(application.home,`recoveries/${result.id}/complete.json`),proof=await checkpointFingerprint(file,{signal});if(proof.sha256!==hash(JSON.stringify(result)))throw Error("原项目恢复记录完整性未通过");return{result,sha256:proof.sha256};
  };
  return input.choices.every(choice=>choice.action==="keep")?execute(options.signal):withAdoptionRepositoryLeases(plan.guards,path.join(input.previewFolder,"commands"),options,execute);
}
