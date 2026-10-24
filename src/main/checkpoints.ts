import {promises as fs} from "node:fs";
import path from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {z} from "zod";
import {atomicWrite} from "../core/store";
import {redact} from "../core/redact";
import type {Job} from "../shared/types";
import {checkpointManifest,checkpointPath,type CheckpointManifest,type CheckpointEntry,type CheckpointRestore,type CheckpointProgress,type CheckpointView} from "../shared/checkpoints";
import {CheckpointStore} from "./checkpoint-store";
import {prepareCheckpoint,captureCheckpointFiles,type PreparedCheckpoint} from "./checkpoint-capture";
import {verifyCheckpointContents,restoreCheckpoint,verifyRestoredCheckpoint} from "./checkpoint-restore";
import {reviewLinkedCheckpoint,type LinkedCheckpointReview} from "./checkpoint-linked";
import {checkpointFingerprint,sameCheckpointPath} from "./checkpoint-file";

type Operation={id:string;entryId:string;kind:"preview"|"capture"|"verify"|"restore"|"review";controller:AbortController;publishing:boolean;done:Promise<void>};
const identifier=z.string().uuid();
export class Checkpoints {
  private store:CheckpointStore;private chain:Promise<unknown>=Promise.resolve();private active?:Operation;private progress?:CheckpointProgress;private closing=false;
  private previews=new Map<string,{prepared:PreparedCheckpoint;stage:string;cwd:string;context?:string}>();
  private reviews=new Map<string,{entryId:string;manifestSha256:string;review:LinkedCheckpointReview;expiresAt:number}>();
  private reviewOutcome?:CheckpointView["linkedReview"];
  constructor(private options:{root:string;native?:boolean;protect?:(root:string)=>Promise<void>;write?:typeof atomicWrite;report?:(error:unknown)=>void;withRepository?:<T>(cwd:string,action:(root:string)=>Promise<T>)=>Promise<T>;target?:(id:string)=>Job;lookup?:(id:string)=>Job;admit?:(value:{restore:CheckpointRestore;manifest:CheckpointManifest;title:string;prompt:string})=>Promise<Job>}){this.store=new CheckpointStore(options);}
  private queue<T>(action:()=>Promise<T>){const value=this.chain.then(action);this.chain=value.catch(()=>{});return value;}
  private available(){if(this.closing)throw Error("检查点正在关闭");if(this.active)throw Error("已有检查点操作正在进行");if(this.store.issue)throw Error(this.store.issue);}
  private repository<T>(cwd:string,action:(root:string)=>Promise<T>){return this.options.withRepository?this.options.withRepository(cwd,action):action(cwd);}
  async list(){const view=await this.store.list();return {...view,active:this.active?{id:this.active.id,entryId:this.active.entryId,kind:this.active.kind,publishing:this.active.publishing}:undefined,progress:structuredClone(this.progress),linkedReview:structuredClone(this.reviewOutcome)};}
  private async entry(id:string){identifier.parse(id);const entry=(await this.store.list()).entries.find(e=>e.id===id);if(!entry)throw Error("检查点不存在");return entry;}
  private context(jobId?:string){if(!jobId)return undefined;const job=this.options.target?.(jobId);if(!job)throw Error("来源任务不存在");const report=job.delivery?.reports.at(-1);return {jobId:job.id,title:job.title,state:job.state,workflow:job.workflow?{id:job.workflow.id,title:job.workflow.title,step:job.workflow.step,total:job.workflow.total}:undefined,delivery:job.delivery?{revision:job.delivery.revision,reportId:report?.id,status:report?.status||"pending",checks:structuredClone(job.delivery.checks)}:undefined};}
  private launch(entryId:string,kind:Operation["kind"],action:(operation:Operation)=>Promise<void>,restoreId?:string){
    const op:Operation={id:randomUUID(),entryId,kind,controller:new AbortController(),publishing:false,done:Promise.resolve()};this.active=op;
    op.done=action(op).catch(async error=>{const issue=redact(error instanceof Error?error.message:String(error),4000),status=op.controller.signal.aborted?"cancelled":"failed";this.options.report?.(error);
      if(restoreId)await this.store.mutate(next=>{const restore=next.restores.find(r=>r.id===restoreId);if(restore){restore.status=status;restore.issue=issue;}});
      else if(kind==="review")await this.store.patch(entryId,{issue});else if(kind!=="verify")await this.store.patch(entryId,{status,issue});else await this.store.patch(entryId,{status:"interrupted",issue,verification:{at:Date.now(),passed:false}});
    }).catch(error=>this.options.report?.(error)).finally(()=>{if(this.active===op){this.active=undefined;this.progress=undefined;}});
  }
  private optionsFor(op:Operation,entry:CheckpointEntry){return{signal:op.controller.signal,native:this.options.native,progress:(phase:string,file:string,bytes:number)=>{const phases={inspecting:"inspecting",copying:"copying",packing:"packing",verifying:"verifying",restoring:"restoring"} as const;
    this.progress={id:op.id,phase:phases[phase as keyof typeof phases]||"verifying",path:file,bytes,totalBytes:0,files:0,totalFiles:entry.fileCount};}};}
  preview(input:unknown){const value=z.object({cwd:z.string().refine(path.isAbsolute),title:z.string().trim().min(1).max(200),ignored:z.array(checkpointPath).default([]),jobId:identifier.optional()}).strict().parse(input);
    return this.queue(async()=>{this.available();const root=await this.store.currentStorage(),context=this.context(value.jobId);
      if(value.jobId&&!sameCheckpointPath(value.cwd,this.options.target!(value.jobId).cwd))throw Error("任务工作目录已变化");
      const entry:CheckpointEntry={id:randomUUID(),root,title:value.title,createdAt:Date.now(),status:"preview",source:value.cwd,fileCount:0,totalBytes:0};await this.store.mutate(next=>next.entries.push(entry));
      this.launch(entry.id,"preview",async op=>{const stage=await this.store.create(root,"staging",entry.id),options={...this.optionsFor(op,entry),root:stage,ignored:value.ignored,context};
        const prepared=await this.repository(value.cwd,()=>prepareCheckpoint(value.cwd,value.title,options));prepared.manifest.id=entry.id;
        op.controller.signal.throwIfAborted();await atomicWrite(path.join(stage,"preview.json"),JSON.stringify(prepared.manifest));
        await this.store.patch(entry.id,{source:prepared.manifest.source,fileCount:prepared.manifest.fileCount,totalBytes:prepared.manifest.totalBytes});
        this.previews.set(entry.id,{prepared,stage,cwd:value.cwd,context:value.jobId?JSON.stringify(this.context(value.jobId)):undefined});
      });return this.list();
    });
  }
  capture(id:string){identifier.parse(id);return this.queue(async()=>{this.available();const entry=await this.entry(id),preview=this.previews.get(id);if(!preview||entry.status!=="preview")throw Error("请重新创建工作区预览");
    if(preview.context!==undefined&&JSON.stringify(this.context(preview.prepared.manifest.context?.jobId))!==preview.context)throw Error("来源任务已变化，请重新预览");
    await this.store.patch(id,{status:"capturing",issue:undefined});this.previews.delete(id);
    this.launch(id,"capture",async op=>{const options={...this.optionsFor(op,entry),root:preview.stage};
      const manifest=await this.repository(preview.cwd,()=>captureCheckpointFiles(preview.prepared,options));
      await verifyCheckpointContents(manifest,preview.stage,path.join(preview.stage,"seal-audit"),options);op.controller.signal.throwIfAborted();
      await this.store.pruneCaptureScratch(entry);
      const json=JSON.stringify(manifest),manifestSha256=createHash("sha256").update(json).digest("hex");await atomicWrite(path.join(preview.stage,"manifest.json"),json);
      if((await checkpointFingerprint(path.join(preview.stage,"manifest.json"),{signal:op.controller.signal})).sha256!==manifestSha256)throw Error("检查点清单写入无法验证");
      op.controller.signal.throwIfAborted();op.publishing=true;await this.store.patch(id,{manifestSha256,sealedAt:manifest.sealedAt});await this.store.publish(entry);
      await this.store.patch(id,{status:"ready",verification:{at:Date.now(),passed:true},issue:undefined});
    });return this.list();
  });}
  private async readManifest(entry:CheckpointEntry,staging=false){if(!entry.manifestSha256)throw Error("检查点尚未完整封存");const root=await this.store.directory(entry.root,staging?"staging":"versions",entry.id),file=path.join(root,"manifest.json"),before=await checkpointFingerprint(file);
    if(before.sha256!==entry.manifestSha256)throw Error("检查点清单完整性未通过");const data=await fs.readFile(file),after=createHash("sha256").update(data).digest("hex");if(after!==entry.manifestSha256)throw Error("检查点清单在读取时发生变化");const manifest=checkpointManifest.parse(JSON.parse(data.toString("utf8")));if(manifest.id!==entry.id)throw Error("检查点清单身份不一致");return{root,manifest};}
  async detail(input:unknown){const value=z.object({id:identifier,offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(500).default(100)}).strict().parse(input),entry=await this.entry(value.id);
    let manifest:CheckpointManifest;if(entry.status==="preview"){const preview=this.previews.get(entry.id);if(!preview)throw Error("预览尚未完成或需要重新创建");manifest=preview.prepared.manifest;}else manifest=(await this.readManifest(entry)).manifest;
    const files=manifest.repos.flatMap(repo=>repo.files.map(file=>({...file,repository:repo.relative})));return {entry,context:manifest.context,projectRelative:manifest.projectRelative,repos:manifest.repos.map(({id,source,relative,head,branch,dependencies,stages,flags})=>({id,source,relative,head,branch,dependencies,conflicts:stages.filter(s=>s.stage>0).length,flagged:flags.filter(f=>f.bits!=="0").length})),offset:value.offset,total:files.length,files:files.slice(value.offset,value.offset+value.limit)};
  }
  verify(id:string){identifier.parse(id);return this.queue(async()=>{this.available();const entry=await this.entry(id);if(!entry.manifestSha256)throw Error("此记录没有完整封存，请重新预览");
    this.launch(id,"verify",async op=>{let staging=false,data:Awaited<ReturnType<Checkpoints["readManifest"]>>;try{data=await this.readManifest(entry);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;staging=true;data=await this.readManifest(entry,true);}
      const scratch=await fs.mkdtemp(path.join(await this.store.currentStorage(),"verify-"));await verifyCheckpointContents(data.manifest,data.root,scratch,this.optionsFor(op,entry));op.controller.signal.throwIfAborted();op.publishing=true;if(staging)await this.store.publish(entry);await this.store.patch(id,{status:"ready",issue:undefined,verification:{at:Date.now(),passed:true}});
    });return this.list();
  });}
  linkedReview(id:string){identifier.parse(id);return this.queue(async()=>{this.available();const entry=await this.entry(id);if(entry.status!=="ready")throw Error("请先复核完整检查点");const {manifest}=await this.readManifest(entry);this.reviewOutcome=undefined;await this.store.patch(id,{issue:undefined});
    this.launch(id,"review",async op=>{const scratch=await fs.mkdtemp(path.join(await this.store.currentStorage(),"review-")),review=await this.repository(manifest.source,()=>reviewLinkedCheckpoint(manifest,scratch,this.optionsFor(op,entry)));op.controller.signal.throwIfAborted();
      const token=randomUUID(),expiresAt=Date.now()+10*60*1000;for(const [key,value]of this.reviews)if(value.expiresAt<Date.now())this.reviews.delete(key);this.reviews.set(token,{entryId:id,manifestSha256:entry.manifestSha256!,review,expiresAt});this.reviewOutcome={entryId:id,token,expiresAt,source:manifest.source,head:review.repos[0].head,branch:review.repos[0].branch};await this.store.patch(id,{issue:undefined});
    });return this.list();
  });}
  restore(input:unknown){const value=z.object({id:identifier,requestId:identifier,mode:z.enum(["independent","linked"]),review:identifier.optional(),branch:z.string().trim().min(1).max(240).optional()}).strict().parse(input);
    return this.queue(async()=>{const existing=(await this.store.list()).restores.find(r=>r.id===value.requestId);if(existing){if(existing.checkpointId!==value.id||existing.mode!==value.mode||existing.branch!==(value.branch||`checkpoint/${value.requestId}`))throw Error("恢复请求已用于其他目标");return this.list();}
      this.available();const entry=await this.entry(value.id);if(entry.status!=="ready")throw Error("请先复核完整检查点");const {manifest,root}=await this.readManifest(entry),review=value.review?this.reviews.get(value.review):undefined;
      if(value.mode==="linked"&&(!review||review.entryId!==entry.id||review.manifestSha256!==entry.manifestSha256||review.expiresAt<Date.now()))throw Error("请先检查原仓库，再确认关联恢复");
      const id=value.requestId;let outer:string;
      try{outer=await this.store.create(entry.root,"restores",id);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;outer=await this.store.directory(entry.root,"restores",id);const plan=JSON.parse(await fs.readFile(path.join(outer,"restore-plan.json"),"utf8"));if(plan.id!==id||plan.checkpointId!==entry.id||plan.manifestSha256!==entry.manifestSha256||plan.mode!==value.mode||plan.branch!==(value.branch||`checkpoint/${id}`)||!sameCheckpointPath(plan.attempt,path.join(outer,"run")))throw Error("恢复请求已用于其他目标");plan.status="interrupted";plan.issue="恢复被中断，请核对原目标；已有分支与文件会保留。";await this.store.mutate(next=>next.restores.push(plan));return this.list();}
      const attempt=path.join(outer,"run"),restore:CheckpointRestore={id,checkpointId:entry.id,manifestSha256:entry.manifestSha256!,status:"restoring",createdAt:Date.now(),attempt,target:path.join(attempt,"workspace",...manifest.projectRelative.split("/").filter(Boolean)),mode:value.mode,branch:value.branch||`checkpoint/${id}`};
      await atomicWrite(path.join(outer,"restore-plan.json"),JSON.stringify(restore));await fs.mkdir(attempt);await this.store.mutate(next=>next.restores.push(restore));
      this.launch(entry.id,"restore",async op=>{const action=()=>restoreCheckpoint(manifest,root,attempt,{...this.optionsFor(op,entry),branch:restore.branch,linked:value.mode==="linked"?review!.review:undefined});
        const result=value.mode==="linked"?await this.repository(manifest.source,action):await action();op.publishing=true;await this.store.mutate(next=>{const current=next.restores.find(r=>r.id===id)!;current.status="ready";current.target=result.target;});
      },id);return this.list();
    });
  }
  private async restored(id:string){identifier.parse(id);const view=await this.store.list(),restore=view.restores.find(r=>r.id===id);if(!restore)throw Error("恢复记录不存在");const entry=await this.entry(restore.checkpointId);if(restore.manifestSha256!==entry.manifestSha256)throw Error("恢复记录与检查点不一致");const outer=await this.store.directory(entry.root,"restores",id);if(!sameCheckpointPath(restore.attempt,path.join(outer,"run"))||!sameCheckpointPath(restore.attempt,await fs.realpath(restore.attempt)))throw Error("恢复目标目录已变化");return{restore,entry,outer};}
  recover(id:string){identifier.parse(id);return this.queue(async()=>{this.available();const {restore,entry}=await this.restored(id),{manifest}=await this.readManifest(entry);
    this.launch(entry.id,"restore",async op=>{const receipt=JSON.parse(await fs.readFile(path.join(restore.attempt,"restore-receipt.json"),"utf8"));if(receipt.checkpointId!==entry.id||receipt.branch!==restore.branch||!sameCheckpointPath(receipt.target,restore.target))throw Error("恢复未完整完成，原目标已保留，请查看后选择新目标");await verifyRestoredCheckpoint(manifest,restore.attempt,this.optionsFor(op,entry));op.controller.signal.throwIfAborted();op.publishing=true;await this.store.mutate(next=>{const item=next.restores.find(r=>r.id===id)!;item.status="ready";item.issue=undefined;});},id);return this.list();
  });}
  async task(id:string){identifier.parse(id);const restore=(await this.store.list()).restores.find(r=>r.id===id);if(!restore?.jobId)throw Error("恢复工作区尚未关联任务");const lookup=this.options.lookup||this.options.target;if(!lookup)throw Error("任务创建尚不可用");return lookup(restore.jobId);}
  admit(input:unknown){const value=z.object({id:identifier,title:z.string().trim().min(1).max(200),prompt:z.string().trim().min(1).max(200000)}).strict().parse(input);return this.queue(async()=>{this.available();const {restore,entry}=await this.restored(value.id);if(restore.status!=="ready")throw Error("请先核对恢复目标");if(restore.jobId)return this.task(restore.id);
    const {manifest}=await this.readManifest(entry);await verifyRestoredCheckpoint(manifest,restore.attempt,{native:this.options.native});if(!this.options.admit)throw Error("任务创建尚不可用");const job=await this.options.admit({restore,manifest,title:value.title,prompt:value.prompt});await this.store.mutate(next=>{next.restores.find(r=>r.id===restore.id)!.jobId=job.id;});return job;});}
  setStorage(parent:string){return this.queue(async()=>{this.available();await this.store.setStorage(parent);return this.list();});}
  cancel(id:string){identifier.parse(id);return this.queue(async()=>{if(!this.active||this.active.id!==id)throw Error("此检查点操作已经结束");if(this.active.publishing)throw Error("正在完成检查点写入，请稍候");this.active.controller.abort();return this.list();});}
  async openDirectory(id:string,restore=false){return restore?(await this.restored(id)).restore.target:(await this.readManifest(await this.entry(id))).root;}
  async shutdown(){this.closing=true;await this.chain;if(this.active&&!this.active.publishing)this.active.controller.abort();await this.active?.done;await this.store.drain();}
  resume(){this.closing=false;}
}
