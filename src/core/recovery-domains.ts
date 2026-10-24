import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {z} from "zod";
import type {Job} from "../shared/types";
import {Store} from "./store";
import {inspectWindowsDomain,type WindowsDomainOwner} from "./windows-domain";

const proofSchema=z.object({version:z.literal(1),nonce:z.string().uuid(),accountId:z.string().min(1),home:z.string(),workspace:z.string(),project:z.string(),sandbox:z.enum(["workspaceWrite","readOnly"])}).strict();
export type ScopeReason="contained"|"missingProof"|"changedResources"|"unknownOwner"|"externalSession"|"unconfined"|"storage";
export type ScopeEvidence={status:"scoped"|"global";reason:ScopeReason;accounts:string[];paths:string[];processes?:number};
const global=(reason:ScopeReason):ScopeEvidence=>({status:"global",reason,accounts:[],paths:[]});
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const recoveryBinding=(job:Job)=>hash({id:job.id,account:job.accountId,home:job.runtimeHomeId,cwd:job.cwd,project:job.projectCwd,mode:job.mode,sandbox:job.planMode?"readOnly":job.sandbox,native:job.preserveNativePermissions,proof:job.runtimeDomain,existing:job.existing?.phase});
const equal=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const overlaps=(a:string,b:string)=>{const relative=path.relative(a,b);return relative===""||!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative);};
const intersects=(a:string[],b:string[])=>a.some(x=>b.some(y=>overlaps(x,y)||overlaps(y,x)));
export async function captureWindowsDomain(store:Store,job:Job,owner?:WindowsDomainOwner){
  job.runtimeDomain=undefined;
  if(owner&&process.platform==="win32"&&job.mode==="cli"&&job.accountId&&!job.existing&&!job.historySource&&!job.importedRollout&&!job.preserveNativePermissions&&job.sandbox!=="dangerFullAccess"){
    const [home,workspace,project]=await Promise.all([fs.realpath(store.jobHome(job.id)),fs.realpath(job.cwd),fs.realpath(job.projectCwd||job.cwd)]);
    if(!equal(home,owner.home))throw Error("进程归属与任务运行目录不匹配");
    await inspectWindowsDomain(home,owner.nonce);
    job.runtimeDomain={version:1,nonce:owner.nonce,accountId:job.accountId,home,workspace,project,sandbox:job.planMode?"readOnly":job.sandbox};
  }
  try{await store.save();}catch(error){job.runtimeDomain=undefined;throw error;}
}
export async function inspectRecoveryDomain(store:Store,job:Job):Promise<ScopeEvidence>{
  if(job.existing&&job.existing.phase!=="managed"||job.mode!=="cli")return global("externalSession");
  if(job.existing||job.historySource||job.importedRollout||job.preserveNativePermissions||job.sandbox==="dangerFullAccess")return global("unconfined");
  const parsed=proofSchema.safeParse(job.runtimeDomain);if(!parsed.success||process.platform!=="win32")return global("missingProof");
  const proof=parsed.data;
  try{
    const [home,workspace,project]=await Promise.all([fs.realpath(store.jobHome(job.id)),fs.realpath(job.cwd),fs.realpath(job.projectCwd||job.cwd)]);
    if(!equal(home,proof.home)||!equal(workspace,proof.workspace)||!equal(project,proof.project)||job.accountId!==proof.accountId||!store.data.accounts.some(a=>a.id===proof.accountId)||proof.sandbox!==(job.planMode?"readOnly":job.sandbox))return global("changedResources");
    let processes=0;
    for(const target of [home,path.join(home,"quota-probe"),store.profileHome(proof.accountId)]){
      let raw:string;
      try{raw=await fs.readFile(path.join(target,"relay-owner.json"),"utf8");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
        if(target===home){const receipt=JSON.parse(await fs.readFile(path.join(home,`relay-domain-${proof.nonce}.json`),"utf8"));if(receipt.version!==1||receipt.nonce!==proof.nonce||receipt.phase!=="stopped"||!equal(receipt.home,home))return global("unknownOwner");}
        continue;
      }
      const owner=JSON.parse(raw);if(owner.kind!=="windows-job"||target===home&&owner.nonce!==proof.nonce)return global("unknownOwner");
      const view=await inspectWindowsDomain(target,owner.nonce);processes+=view.active;
      if(await fs.readFile(path.join(target,"relay-owner.json"),"utf8")!==raw)return global("changedResources");
    }
    return {status:"scoped",reason:"contained",accounts:[proof.accountId],paths:[workspace,project],processes};
  }catch{return global("unknownOwner");}
}
type Cached={binding:string;evidence:ScopeEvidence;at:number};
export class RecoveryDomains {
  private scopes=new Map<string,Cached>();
  private targets=new Map<string,{raw:string;paths:string[]}>();
  private working?:Promise<void>;
  private owners:string[]=[];
  constructor(private store:Store,private inspect=(job:Job)=>inspectRecoveryDomain(store,job)){}
  refresh(recovering:string[]){if(this.working)return this.working;this.working=this.refreshOnce(recovering).finally(()=>{this.working=undefined;});return this.working;}
  private async refreshOnce(recovering:string[]){
    this.owners=[...new Set([...recovering,...this.store.data.jobs.filter(j=>j.recoveryRequired).map(j=>j.id)])];
    const next=new Map<string,Cached>(),targets=new Map<string,{raw:string;paths:string[]}>();let changed=false;
    const rollback=new Map<Job,Job["recoveryDomainObservation"]>();
    for(const id of this.owners){const job=this.store.data.jobs.find(j=>j.id===id);if(!job){next.set(id,{binding:"",evidence:global("unknownOwner"),at:Date.now()});continue;}
      const binding=recoveryBinding(job);let evidence:ScopeEvidence;try{evidence=await this.inspect(job);}catch{evidence=global("unknownOwner");}
      if(binding!==recoveryBinding(job))evidence=global("changedResources");
      next.set(id,{binding,evidence,at:Date.now()});
      const signature=hash({binding,evidence});if(job.recoveryDomainObservation?.signature!==signature){rollback.set(job,job.recoveryDomainObservation);job.recoveryDomainObservation={signature,status:evidence.status,reason:evidence.reason,at:Date.now(),processes:evidence.processes};changed=true;}
    }
    if(next.size)for(const job of this.store.data.jobs){const raw=JSON.stringify([job.cwd,job.projectCwd]);try{targets.set(job.id,{raw,paths:await Promise.all([fs.realpath(job.cwd),fs.realpath(job.projectCwd||job.cwd)])});}catch{}}
    if(changed)try{await this.store.save();}catch{for(const [job,previous]of rollback)job.recoveryDomainObservation=previous;for(const cached of next.values())cached.evidence=global("storage");}
    this.scopes=next;this.targets=targets;
  }
  private evidence(id:string){const job=this.store.data.jobs.find(j=>j.id===id),cached=this.scopes.get(id);return job&&cached?.binding===recoveryBinding(job)?cached.evidence:global("changedResources");}
  ids(recovering:string[]=[]){return [...new Set([...recovering,...this.store.data.jobs.filter(j=>j.recoveryRequired).map(j=>j.id)])];}
  global(recovering:string[]){return this.ids(recovering).filter(id=>this.evidence(id).status==="global");}
  blockedAccounts(recovering:string[]){return new Set(this.ids(recovering).flatMap(id=>this.evidence(id).accounts));}
  blockers(job:Job,recovering:string[]){return this.ids(recovering).filter(id=>{
    if(id===job.id)return true;const evidence=this.evidence(id);if(evidence.status==="global"||job.mode!=="cli")return true;
    const owner=this.store.data.jobs.find(j=>j.id===id);if((owner?.runtimeHomeId||id)===(job.runtimeHomeId||job.id))return true;
    const target=this.targets.get(job.id);if(!target||target.raw!==JSON.stringify([job.cwd,job.projectCwd]))return true;
    return intersects(evidence.paths,target.paths);
  });}
  view(recovering:string[]){return this.ids(recovering).map(id=>{
    const job=this.store.data.jobs.find(j=>j.id===id),evidence=this.evidence(id),at=this.scopes.get(id)?.at;
    return {id,title:job?.title||id,status:evidence.status,reason:evidence.reason,checkedAt:at,processes:evidence.processes,
      accounts:evidence.accounts.map(id=>({id,label:this.store.data.accounts.find(a=>a.id===id)?.label||id})),
      projects:evidence.paths.map(p=>path.basename(p)).filter((v,i,a)=>a.indexOf(v)===i),
      affected:this.store.data.jobs.filter(j=>["queued","waiting"].includes(j.state)&&this.blockers(j,recovering).includes(id)).map(j=>j.id),
      intent:job?.stopIntent,nextAt:job?.autoRecovery?.nextAttemptAt,attempt:job?.autoRecovery?.attempt,nonce:job?.runtimeDomain?.nonce};
  });}
  identity(recovering:string[]){return hash(this.view(recovering).map(({checkedAt,...entry})=>entry));}
}
