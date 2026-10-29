import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {Store} from "../src/core/store";
import {Scheduler} from "../src/core/scheduler";
import {NativeFollowups} from "../src/main/native-followups";
import type {Job} from "../src/shared/types";
let root:string,store:Store,scheduler:Scheduler,service:NativeFollowups,job:Job;
beforeEach(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-native-followups-"));store=new Store(root);
 scheduler=new Scheduler(store,{busy:new Set(),cancelLogin:async()=>{}} as any,{cli:()=>{throw Error("No inference");},desktop:()=>{throw Error("No desktop");}});scheduler.runtimeReady=()=>false;
 job=await scheduler.add({title:"Native",prompt:"Work",cwd:root,mode:"cli",model:"",effort:"",bucket:"codex",sandbox:"workspaceWrite",approvalPolicy:"on-request",interactive:true});job.state="paused";job.stopIntent="pause";await store.save();service=await NativeFollowups.open(scheduler);
});
afterEach(async()=>{await scheduler.shutdown();await fs.rm(root,{recursive:true,force:true});});
const request=()=>({installationId:service.identity,requestId:randomUUID(),controlRevision:job.controlRevision||0,input:{id:job.id,text:"Followup",attachments:[],action:"queue" as const}});
it("retains installation identity and confirms an accepted input after a later pause without resuming it",async()=>{
 const input=request();expect(await service.submit(input)).toEqual({state:"accepted"});expect(job.messageReceipts).toHaveLength(1);await scheduler.control(job.id,"pause");
 service=await NativeFollowups.open(scheduler);expect(service.identity).toBe(input.installationId);expect(await service.submit(input)).toEqual({state:"accepted"});expect(job.state).toBe("paused");expect(job.messageReceipts).toHaveLength(1);
});
it("restores the same acceptance after the entire scheduler and store restart",async()=>{
 const input=request();expect(await service.submit(input)).toEqual({state:"accepted"});await scheduler.control(job.id,"pause");await scheduler.shutdown();
 const disk=new Store(root);await disk.load();const factory=vi.fn(()=>{throw Error("No inference");});scheduler=new Scheduler(disk,{busy:new Set(),cancelLogin:async()=>{}} as any,{cli:factory,desktop:factory});scheduler.runtimeReady=()=>false;
 service=await NativeFollowups.open(scheduler);expect(await service.submit(input)).toEqual({state:"accepted"});expect(disk.data.jobs[0].state).toBe("paused");expect(disk.data.jobs[0].messageReceipts).toHaveLength(1);expect(factory).not.toHaveBeenCalled();
});
it("refuses a different installation, later control revision, conflicting request and invalid path",async()=>{
 const native=vi.spyOn(scheduler,"send"),input=request();expect(await service.submit({...input,installationId:randomUUID()})).toMatchObject({state:"rejected",code:"installation"});expect(native).not.toHaveBeenCalled();
 job.controlRevision=1;expect(await service.submit(input)).toMatchObject({state:"rejected",code:"control"});expect(native).not.toHaveBeenCalled();
 const fresh=request();expect(await service.submit(fresh)).toEqual({state:"accepted"});expect(await service.submit({...fresh,input:{...fresh.input,text:"Changed"}})).toMatchObject({state:"rejected",code:"request"});
 expect(await service.submit({...request(),input:{...input.input,attachments:[{type:"mention",path:"relative",name:"bad"}]}})).toMatchObject({state:"rejected",code:"input"});
});
it("retries only the original intent through a temporary recovery gate",async()=>{
 const input=request();job.recoveryRequired=true;expect(await service.submit(input)).toMatchObject({state:"pending"});expect(job.messageReceipts).toBeUndefined();
 job.recoveryRequired=false;expect(await service.submit(input)).toEqual({state:"accepted"});expect(job.messageReceipts?.map(r=>r.id)).toEqual([input.requestId]);
});
it("persists cancellation of an unaccepted intent and refuses all later replays after reopening",async()=>{
 const input=request();job.recoveryRequired=true;expect(await service.submit(input)).toMatchObject({state:"pending"});expect(await service.cancel(input)).toMatchObject({state:"rejected",code:"cancelled"});
 service=await NativeFollowups.open(scheduler);job.recoveryRequired=false;expect(await service.submit(input)).toMatchObject({state:"rejected",code:"cancelled"});expect(job.messageReceipts).toBeUndefined();
});
it("recovers cancellation after its write acknowledgement is lost and stores only its fingerprint",async()=>{
 const input=request();job.recoveryRequired=true;const rename=fs.rename.bind(fs);
 const fault=vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{await rename(from,to);if(String(to).includes("native-chat-cancellations"))throw Error("Cancellation acknowledgement lost");});
 try{await expect(service.cancel(input)).rejects.toThrow("acknowledgement");}finally{fault.mockRestore();}
 service=await NativeFollowups.open(scheduler);expect(await service.submit(input)).toMatchObject({state:"rejected",code:"cancelled"});
 expect(await fs.readFile(path.join(root,"native-chat-cancellations",input.requestId+".json"),"utf8")).not.toContain(input.input.text);
});
it("refuses a corrupt installation identity without replacing it",async()=>{
 const file=path.join(root,"native-chat-installation.json");await fs.writeFile(file,"corrupt");await expect(NativeFollowups.open(scheduler)).rejects.toThrow();expect(await fs.readFile(file,"utf8")).toBe("corrupt");
});
it("joins an in-flight admission before resolving cancellation as the original acceptance",async()=>{
 const input=request(),native=scheduler.send.bind(scheduler);let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
 vi.spyOn(scheduler,"send").mockImplementation(async(...args)=>{entered();await gate;return native(...args);});
 const submit=service.submit(input);await started;const cancel=service.cancel(input);release();expect(await submit).toEqual({state:"accepted"});expect(await cancel).toEqual({state:"accepted"});expect(job.messageReceipts).toHaveLength(1);
});
