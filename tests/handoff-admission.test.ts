import os from "node:os";
import {beforeAll} from "vitest";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
const fixtureParent=path.join(os.tmpdir(),"codex-relay-handoff-qa");
beforeAll(async()=>{await fs.mkdir(fixtureParent,{recursive:true});});
import {createHash,randomUUID} from "node:crypto";
import {Handoffs} from "../src/main/handoffs";
import {CheckpointGit} from "../src/main/checkpoint-git";
import {prepareCheckpoint,captureCheckpointFiles} from "../src/main/checkpoint-capture";
import {Scheduler} from "../src/core/scheduler";
import {Store} from "../src/core/store";
import {atomicWrite} from "../src/core/store";
import type {Job} from "../src/shared/types";
import type {HandoffTaskAdmission} from "../src/shared/handoff";

let root:string,source:string,task:string,profile:string,job:Job,service:Handoffs,store:Store,scheduler:Scheduler,workerCalls:number;
let base:{root:string;manifest:Awaited<ReturnType<typeof captureCheckpointFiles>>;manifestSha256:string};
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
function options(){return{root:profile,native:false,target:(id:string)=>scheduler.deliveryTarget(id),checkpoint:async()=>base,admit:(value:HandoffTaskAdmission)=>scheduler.addHandoffTask(value),findContinuation:(entryId:string,workspaceId:string)=>store.data.jobs.find(item=>item.handoff?.id===entryId&&item.handoff.workspaceId===workspaceId),lookup:(id:string)=>{const found=store.data.jobs.find(item=>item.id===id);if(!found)throw Error("missing task");return found;}};}
beforeEach(async()=>{
  await fs.mkdir(fixtureParent,{recursive:true});root=await fs.mkdtemp(path.join(fixtureParent,"handoff-admission-test-"));await fs.writeFile(path.join(root,".fixture-owner"),root);source=path.join(root,"source");task=path.join(root,"task");profile=path.join(root,"profile");await fs.mkdir(source);const git=new CheckpointGit(path.join(root,"commands"),{native:false});
  await git.run(source,["init","-b","main"]);await git.run(source,["config","user.name","QA"]);await git.run(source,["config","user.email","qa@localhost"]);await git.run(source,["config","core.autocrlf","false"]);await fs.writeFile(path.join(source,"raw.txt"),"base\n");await git.run(source,["add","-A"]);await git.run(source,["commit","-m","Base"]);
  const storage=path.join(root,"checkpoint");await fs.mkdir(storage);const prepared=await prepareCheckpoint(source,"Start",{root:storage,native:false}),manifest=await captureCheckpointFiles(prepared,{root:storage,native:false}),json=JSON.stringify(manifest);await fs.writeFile(path.join(storage,"manifest.json"),json);base={root:storage,manifest,manifestSha256:hash(json)};
  await git.run(source,["worktree","add","-b","task",task]);await fs.writeFile(path.join(task,"raw.txt"),"integrated\n");
  const check={kind:"contains" as const,path:"raw.txt",label:"Integrated content",text:"integrated"},now=Date.now();job={id:randomUUID(),title:"Stopped source",prompt:"Preserve source intent",cwd:task,mode:"cli",model:"",effort:"medium",bucket:"codex",approvalPolicy:"on-request",sandbox:"workspaceWrite",state:"cancelled",stopIntent:"cancel",rotations:0,createdAt:now,updatedAt:now,checkpoint:{id:manifest.id,restoreId:randomUUID(),manifestSha256:base.manifestSha256,sourceCwd:source,branch:"task",mode:"linked"},delivery:{revision:1,checks:[check],reports:[{id:randomUUID(),revision:1,source:"manual",startedAt:now-100000,finishedAt:now-99999,status:"passed",findings:[{check,status:"passed",code:"verified",sha256:"0".repeat(64),bytes:1}]}]}};
  store=new Store(profile);store.data.jobs=[job];await store.save();workerCalls=0;const factory=()=>{workerCalls++;throw Error("No inference is authorized by handoff review or admission");};scheduler=new Scheduler(store,{busy:new Set(),cancelLogin:async()=>{}} as any,{cli:factory,desktop:factory});scheduler.runtimeReady=()=>false;service=new Handoffs(options());
});
afterEach(async()=>{vi.restoreAllMocks();await service.shutdown();await scheduler.shutdown();const actual=await fs.realpath(root),parent=await fs.realpath(fixtureParent);if(path.dirname(actual)!==parent||!path.basename(actual).startsWith("handoff-admission-test-")||await fs.readFile(path.join(actual,".fixture-owner"),"utf8")!==root)throw Error("Unsafe admission fixture cleanup");await fs.rm(actual,{recursive:true,force:true});});
async function idle(){const end=Date.now()+90000;for(;;){const view=await service.list();if(!view.active)return view;if(Date.now()>end)throw Error("admission did not finish");await new Promise(resolve=>setTimeout(resolve,20));}}
async function build(){const id=randomUUID();await service.create({requestId:id,jobId:job.id,title:"Integration"});const entry=(await idle()).entries[0];expect(entry.status,entry.issue).toBe("reviewable");return id;}
async function review(id:string){await service.review(id);const entry=(await idle()).entries[0];expect(entry.review,entry.issue).toBeDefined();return entry.review!;}
const request=(id:string,reviewId:string)=>({id,requestId:randomUUID(),reviewId,title:"Inspect integrated result",prompt:"Check the integrated result before continuing"});

it("freshly verifies integrated bytes and admits exactly one paused continuation with reset delivery reports and preserved source cancel intent",async()=>{
  const before=structuredClone(job),id=await build(),reviewed=await review(id),detail=await service.detail({id});expect(reviewed.status).toBe("passed");expect(detail.acceptance?.report?.id).not.toBe(job.delivery!.reports[0].id);expect(detail.acceptance?.report?.findings[0].sha256).toBe(hash("integrated\n"));
  const value=request(id,reviewed.id);await service.admit(value);const entry=(await idle()).entries[0];expect(entry.continuations,entry.issue).toHaveLength(1);expect(store.data.jobs).toHaveLength(2);const created=await service.task(id);expect(created).toMatchObject({state:"paused",stopIntent:"pause",prompt:value.prompt,pendingMessage:value.prompt,cwd:detail.workspace!.target,handoff:{id,workspaceId:entry.currentWorkspaceId,reviewId:reviewed.id,criteriaRevision:1},delivery:{checks:before.delivery!.checks,reports:[]}});expect(job).toEqual(before);expect(workerCalls).toBe(0);
  await service.admit(value);await idle();expect(store.data.jobs).toHaveLength(2);created.state="running";expect((await service.task(id)).state).toBe("running");await expect(service.review(id)).rejects.toThrow("续接任务中进行验收");created.state="paused";
  const disk=new Store(profile);await disk.load();expect(disk.data.jobs.find(item=>item.id===created.id)?.handoff).toEqual(created.handoff);expect((await scheduler.chats.read(created.id)).items.filter(item=>item.role==="user")).toHaveLength(1);
  const continuation=entry.continuations[0],proofFile=path.join(profile,"task-handoffs",id,"admissions",continuation.admissionId,`${continuation.proofId}.proof.json`);expect(hash(await fs.readFile(proofFile))).toBe(continuation.proofSha256);
  await service.shutdown();service=new Handoffs(options());const clock=vi.spyOn(Date,"now").mockReturnValue(reviewed.expiresAt+1);try{await service.admit(value);expect((await service.list()).entries[0].continuations[0].jobId).toBe(created.id);}finally{clock.mockRestore();}expect(workerCalls).toBe(0);
},90000);
it("rejects a changed candidate and keeps user bytes, then admits only after fresh review of the restored candidate",async()=>{
  const id=await build(),reviewed=await review(id),target=await service.openDirectory(id);await fs.writeFile(path.join(target,"raw.txt"),"my later edit");await service.admit(request(id,reviewed.id));const failed=(await idle()).entries[0];expect(failed.issue).toContain("审阅后发生变化");expect(store.data.jobs).toHaveLength(1);expect(await fs.readFile(path.join(target,"raw.txt"),"utf8")).toBe("my later edit");
  await fs.writeFile(path.join(target,"raw.txt"),"integrated\n");const next=await review(id);await service.admit(request(id,next.id));expect((await idle()).entries[0].continuations).toHaveLength(1);expect(store.data.jobs).toHaveLength(2);expect(workerCalls).toBe(0);
},90000);
it("binds review to explicit criterion revisions and never adopts a failed or stale report",async()=>{
  const id=await build();await service.configureCriteria({id,revision:1,checks:[{kind:"sha256",path:"raw.txt",label:"Wrong expected content",sha256:"f".repeat(64)}]});const failed=await review(id);expect(failed.status).toBe("failed");await service.admit(request(id,failed.id));expect((await idle()).entries[0].issue).toContain("尚未通过当前验收条件");expect(store.data.jobs).toHaveLength(1);
  await service.configureCriteria({id,revision:2,checks:job.delivery!.checks});await expect(service.configureCriteria({id,revision:1,checks:[]})).rejects.toThrow("条件已变化");const fresh=await review(id);expect(fresh.status).toBe("passed");await expect(service.admit(request(id,failed.id))).rejects.toThrow("请先对当前");
  const realNow=Date.now.bind(Date),clock=vi.spyOn(Date,"now").mockImplementation(()=>realNow()+11*60*1000);try{await service.admit(request(id,fresh.id));expect((await idle()).entries[0].issue).toContain("验收已过期");expect(store.data.jobs).toHaveLength(1);}finally{clock.mockRestore();}
  await service.admit(request(id,fresh.id));expect((await idle()).entries[0].continuations[0].criteriaRevision).toBe(3);expect(job.delivery!.revision).toBe(1);expect(workerCalls).toBe(0);
},90000);
it("rechecks inside scheduler admission after a queued callback changes the candidate",async()=>{
  const id=await build(),reviewed=await review(id);await service.shutdown();service=new Handoffs({...options(),admit:async value=>{await fs.writeFile(path.join(value.cwd,"raw.txt"),"changed after preflight");return scheduler.addHandoffTask(value);}});await service.admit(request(id,reviewed.id));expect((await idle()).entries[0].issue).toContain("任务入场前发生变化");expect(store.data.jobs).toHaveLength(1);expect(workerCalls).toBe(0);
},90000);
it("rolls back a failed scheduler save and retries without duplicate jobs or chat journals",async()=>{
  const id=await build(),reviewed=await review(id),value=request(id,reviewed.id),save=vi.spyOn(store,"save").mockRejectedValueOnce(Error("disk full"));await service.admit(value);expect((await idle()).entries[0].issue).toContain("disk full");save.mockRestore();expect(store.data.jobs).toHaveLength(1);await service.admit(value);const entry=(await idle()).entries[0];expect(entry.continuations).toHaveLength(1);expect(store.data.jobs).toHaveLength(2);expect((await scheduler.chats.read(entry.continuations[0].jobId)).items.filter(item=>item.role==="user")).toHaveLength(1);expect(workerCalls).toBe(0);
},90000);
it("reconciles a durable scheduler admission after final handoff catalog persistence fails",async()=>{
  const id=await build(),reviewed=await review(id);await service.shutdown();let fail=true;service=new Handoffs({...options(),write:async(file,value)=>{const next=JSON.parse(value.toString());if(fail&&next.entries?.[0]?.continuations?.length){fail=false;throw Error("catalog full");}await atomicWrite(file,value);}});const value=request(id,reviewed.id);await service.admit(value);const interrupted=await idle();expect(interrupted.issue).toContain("记录无法保存");expect(store.data.jobs).toHaveLength(2);
  await service.shutdown();service=new Handoffs(options());expect((await service.list()).entries[0].status).toBe("interrupted");await service.admit(value);expect((await service.list()).entries[0].continuations).toHaveLength(1);expect(store.data.jobs).toHaveLength(2);expect((await service.task(id)).state).toBe("paused");expect(workerCalls).toBe(0);
},90000);
it("labels unconfigured acceptance explicitly and creates only a paused inspection task",async()=>{
  job.delivery={revision:1,checks:[],reports:[]};const id=await build(),reviewed=await review(id);expect(reviewed.status).toBe("unconfigured");expect((await service.detail({id})).acceptance?.report).toBeUndefined();await service.admit(request(id,reviewed.id));await idle();const created=await service.task(id);expect(created.state).toBe("paused");expect(created.delivery).toBeUndefined();expect(job.stopIntent).toBe("cancel");expect(workerCalls).toBe(0);
},90000);
