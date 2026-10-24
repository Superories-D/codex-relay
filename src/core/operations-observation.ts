import { createHash } from "node:crypto";
import type { Job,Approval,AppState } from "../shared/types";
import type { OperationFact,OperationObservation } from "../shared/operations";
import { projectKey } from "../shared/dispatch";
import { deliveryAccepted } from "../shared/delivery";
const projectHashes=new Map<string,string>();
export const operationProjectKey=(cwd:string,platform:string)=>{const key=platform+":"+projectKey(cwd,platform);let value=projectHashes.get(key);if(!value){value=createHash("sha256").update(key).digest("hex");if(projectHashes.size>=10000)projectHashes.clear();projectHashes.set(key,value);}return value;};
const label=(cwd:string)=>cwd.split(/[\\/]/).filter(Boolean).at(-1)||cwd;
export function operationObservation(data:Pick<AppState,"jobs"|"dispatch">,approvals:Approval[],runtime:{active:Set<string>;controls:Set<string>;home:(id:string)=>string},platform:string,at=Date.now()):OperationObservation {
  const requests=new Map<string,OperationFact["requests"]>();
  for(const a of approvals){const values=requests.get(a.jobId)||[];values.push({id:a.id,reviewId:a.reviewId,historyId:a.historyId,kind:a.kind,pending:!!a.responsePending});requests.set(a.jobId,values);}
  return {at,dispatch:{paused:!!data.dispatch?.paused,projects:(data.dispatch?.projects||[]).map(cwd=>({key:operationProjectKey(cwd,platform),label:label(cwd)}))},
    facts:data.jobs.map((job:Job)=>{
      const report=job.delivery?.reports.at(-1),delivery=job.delivery;
      const recovery=job.recoveryHistory?.at(-1);
      const status:OperationFact["acceptance"]["status"]=!delivery?.checks.length?"none":delivery.pendingCompletion?"pending":delivery.staleEvidence?.reportId===report?.id&&report?"stale":deliveryAccepted(delivery)?"passed":report?.revision===delivery.revision?report.status:"pending";
      return {id:job.id,title:job.title,familyId:job.runtimeHomeId||job.id,project:label(job.projectCwd||job.cwd),projectKey:operationProjectKey(job.projectCwd||job.cwd,platform),
        state:job.state,archived:!!job.archived,intent:job.stopIntent,waitingFor:job.waitingFor,active:runtime.active.has(job.id),controlling:runtime.controls.has(runtime.home(job.id)),
        accountId:job.accountId,rotations:job.rotations||0,queued:job.queuedMessages?.length||0,
        workflow:job.workflow?{id:job.workflow.id,title:job.workflow.title,step:job.workflow.step,total:job.workflow.total}:undefined,
        recovery:{required:!!job.recoveryRequired,attempt:job.autoRecovery?.attempt??job.recoveryAttempts??0,reason:job.autoRecovery?.reason,nextAt:job.autoRecovery?.nextAttemptAt,
          last:recovery?{at:recovery.at,kind:recovery.kind,attempt:recovery.attempt}:undefined},
        acceptance:{revision:delivery?.revision||0,reportId:report?.id,status},requests:requests.get(job.id)||[]};
    })};
}
