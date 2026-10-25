import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import {adoptionNativeRequest,adoptionNativeInspection,type AdoptionFileProof,type AdoptionNativeRequest,type AdoptionTransaction,type AdoptionTransactionView} from "../shared/handoff-adoption";
import {checkpointFingerprint,checkpointSourcePath} from "./checkpoint-file";
import {adoptionNativeFileProof,prepareAdoptionNativeRequest,runAdoptionNative} from "./handoff-adoption-native";
import {inspectAdoptionTransaction,adoptionTransitionRequest,readAdoptionTransaction,type AdoptionTransactionOptions} from "./handoff-adoption-transaction";
const hash=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex"),uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const choice=z.object({id:uuid,action:z.enum(["finish","restore","keep"])}).strict();
export const adoptionObservationSha=(view:AdoptionTransactionView)=>hash(JSON.stringify(view));
type NativePlan={request:AdoptionNativeRequest;file:string;sha256:string};
const operation=z.object({id:uuid,path:z.string(),action:choice.shape.action,requestId:uuid.optional(),requestSha256:digest.optional()}).strict();
const recoveryPlan=z.object({version:z.literal(1),id:uuid,transactionId:uuid,transactionSha256:digest,observationSha256:digest,createdAt:z.number().finite(),operations:z.array(operation).min(1)}).strict();
type RecoveryPlan=z.infer<typeof recoveryPlan>;
async function save(file:string,value:unknown){const json=JSON.stringify(value),handle=await fs.open(file,"wx",0o600);try{await handle.writeFile(json);await handle.sync();}finally{await handle.close();}return hash(json);}
const bytes=(actual:AdoptionFileProof|null|undefined,expected:AdoptionFileProof|null|undefined)=>!actual&&!expected||!!actual&&!!expected&&actual.sha256===expected.sha256&&actual.bytes===expected.bytes;
/** Recovery choices bind the entire freshly observed state. Every source-changing
 * operation gets its own immutable native request; old receipts stay unchanged. */
export async function prepareAdoptionRecovery(transaction:AdoptionTransaction,transactionSha256:string,input:{id:string;observationSha256:string;choices:z.input<typeof choice>[]},options:AdoptionTransactionOptions){
  uuid.parse(input.id);digest.parse(input.observationSha256);input.choices.forEach(value=>choice.parse(value));await readAdoptionTransaction(transaction.home,{id:transaction.id,owner:transaction.owner,sha256:transactionSha256});
  const view=await inspectAdoptionTransaction(transaction,transactionSha256,options);if(adoptionObservationSha(view)!==input.observationSha256)throw Error("采用恢复状态已变化，请重新核对全部路径");
  if(input.choices.length!==view.files.length||new Set(input.choices.map(value=>value.id)).size!==view.files.length||input.choices.some(value=>!view.files.some(file=>file.id===value.id)))throw Error("采用恢复需要明确选择每个路径");
  const folder=path.join(transaction.home,"recoveries",input.id);await fs.mkdir(folder,{mode:0o700});const plan:RecoveryPlan={version:1,id:input.id,transactionId:transaction.id,transactionSha256,observationSha256:input.observationSha256,createdAt:Date.now(),operations:[]};
  for(const decision of input.choices){
    options.signal?.throwIfAborted();const observed=view.files.find(value=>value.id===decision.id)!,original=await adoptionTransitionRequest(transaction,transaction.files.find(value=>value.id===decision.id)!);
    const row:RecoveryPlan["operations"][number]={id:decision.id,path:observed.path,action:decision.action};
    if(decision.action==="keep"){plan.operations.push(row);continue;}
    if(!view.metadataUnchanged||["userChanged","retainedEdits","stagingChanged","inconsistent"].includes(observed.state))throw Error("恢复路径或原项目元数据已有新改动，请先保留并重新审阅");
    if(decision.action==="finish"&&["applied","appliedUnsealed"].includes(observed.state)||decision.action==="restore"&&["notStarted","prepared","partialBackup"].includes(observed.state)){plan.operations.push(row);continue;}
    let stage:string|undefined,after:AdoptionFileProof|undefined,metadataSource:AdoptionNativeRequest["metadataSource"];
    if(decision.action==="finish"){
      stage=original.request.stage;after=original.request.after;if(original.request.beforeMetadata&&observed.observed.backup&&observed.observed.backupMetadata)metadataSource={path:`actual/${original.request.id}`,proof:observed.observed.backup,metadata:observed.observed.backupMetadata};
    }else if(original.request.before){
      const saved=await checkpointSourcePath(transaction.home,`before/${original.request.id}`),fingerprint=await checkpointFingerprint(saved,{signal:options.signal});if(fingerprint.sha256!==original.request.before.sha256||fingerprint.bytes!==original.request.before.bytes)throw Error("恢复采用前内容的完整独立备份未通过核验");
      stage=`staged/${randomUUID()}`;await checkpointFingerprint(saved,{signal:options.signal,output:path.join(transaction.home,stage)});after=await adoptionNativeFileProof(path.join(transaction.home,stage),options.signal);
      if(observed.observed.backup&&observed.observed.backupMetadata)metadataSource={path:`actual/${original.request.id}`,proof:observed.observed.backup,metadata:observed.observed.backupMetadata};
    }
    const before=observed.observed.target||undefined;if(before&&decision.action==="finish")metadataSource=undefined;
    const native=await prepareAdoptionNativeRequest({id:randomUUID(),transactionId:transaction.id,owner:transaction.owner,home:transaction.home,root:transaction.root,path:observed.path,action:before?after?"replace":"delete":"create",before,after,stage,metadataSource,restoreMetadata:decision.action==="restore"&&!!metadataSource},options);row.requestId=native.request.id;row.requestSha256=native.sha256;plan.operations.push(row);
  }
  // Staging new recovery bytes must not change the original observed source state.
  const after=await inspectAdoptionTransaction(transaction,transactionSha256,options);if(adoptionObservationSha(after)!==input.observationSha256)throw Error("采用恢复状态在准备期间发生变化，所有版本已保留");
  recoveryPlan.parse(plan);const sha256=await save(path.join(folder,"plan.json"),plan);await save(path.join(folder,"receipt.json"),{version:1,id:input.id,sha256});return{plan,sha256};
}
async function nativePlan(transaction:AdoptionTransaction,id:string,sha256:string):Promise<NativePlan>{
  const file=await checkpointSourcePath(transaction.home,`requests/${id}.json`),proof=await checkpointFingerprint(file),json=await fs.readFile(file),request=adoptionNativeRequest.parse(JSON.parse(json.toString("utf8")));if(proof.sha256!==sha256||hash(json)!==sha256||request.id!==id||request.transactionId!==transaction.id||request.owner!==transaction.owner||path.resolve(request.root).toLowerCase()!==path.resolve(transaction.root).toLowerCase())throw Error("采用恢复操作与当前事务不一致");return{request,file,sha256};
}
export async function applyAdoptionRecovery(transaction:AdoptionTransaction,expected:{plan:RecoveryPlan;sha256:string},options:AdoptionTransactionOptions){
  const folder=await checkpointSourcePath(transaction.home,`recoveries/${expected.plan.id}`),file=await checkpointSourcePath(folder,"plan.json"),proof=await checkpointFingerprint(file),json=await fs.readFile(file),plan=recoveryPlan.parse(JSON.parse(json.toString("utf8"))),receipt=JSON.parse(await fs.readFile(await checkpointSourcePath(folder,"receipt.json"),"utf8"));if(proof.sha256!==expected.sha256||hash(json)!==expected.sha256||JSON.stringify(plan)!==JSON.stringify(expected.plan)||receipt.id!==plan.id||receipt.sha256!==expected.sha256||plan.transactionId!==transaction.id)throw Error("采用恢复计划完整性未通过");
  const initial=await inspectAdoptionTransaction(transaction,plan.transactionSha256,options);if(adoptionObservationSha(initial)!==plan.observationSha256)throw Error("采用恢复状态已变化，请重新核对全部路径");
  await options.assertSource();await save(path.join(folder,"started.json"),{version:1,id:plan.id,sha256:expected.sha256,at:Date.now()});const results=[]as {id:string;path:string;action:"finish"|"restore"|"keep";observed:unknown}[];
  for(const item of plan.operations){
    options.signal?.throwIfAborted();if(item.requestId){await options.assertSource();const operation=await nativePlan(transaction,item.requestId,item.requestSha256!);if(operation.request.path!==item.path)throw Error("采用恢复操作与当前事务不一致");const current=await inspectAdoptionTransaction(transaction,plan.transactionSha256,options);if(!current.metadataUnchanged)throw Error("原项目暂存区或引用已变化，采用已停止并保留恢复记录");await runAdoptionNative("apply",operation,options);}
    const original=await adoptionTransitionRequest(transaction,transaction.files.find(file=>file.id===item.id)!),current=adoptionNativeInspection.parse(await runAdoptionNative("inspect",original,options)),wanted=item.action==="finish"?original.request.after:original.request.before;if(item.action!=="keep"&&!bytes(current.target,wanted))throw Error("采用恢复结果尚未通过完整字节核验");results.push({id:item.id,path:item.path,action:item.action,observed:current});
  }
  const result={version:1,id:plan.id,transactionId:transaction.id,sha256:expected.sha256,at:Date.now(),outcome:results.every(value=>value.action==="finish")?"finished":results.every(value=>value.action==="restore")?"restored":"mixed",results};await save(path.join(folder,"complete.json"),result);return result;
}
