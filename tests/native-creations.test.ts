import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {Store} from "../src/core/store";
import {Scheduler} from "../src/core/scheduler";
import {NativeFollowups} from "../src/main/native-followups";
import {NativeCreations} from "../src/main/native-creations";
let root:string,store:Store,scheduler:Scheduler,service:NativeCreations;
async function open(){
 store=new Store(root);await store.load();store.data.settings.resetWarmupEnabled=false;
 scheduler=new Scheduler(store,{busy:new Set(),cancelLogin:async()=>{}} as any,{cli:()=>{throw Error("No inference");},desktop:()=>{throw Error("No desktop");}});scheduler.runtimeReady=()=>false;
 service=new NativeCreations(scheduler,(await NativeFollowups.open(scheduler)).identity);
}
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-native-creations-"));await open();});
afterEach(async()=>{vi.restoreAllMocks();await scheduler.shutdown();await fs.rm(root,{recursive:true,force:true});});
const request=()=>({installationId:service.identity,requestId:randomUUID(),input:{title:"Native new task",prompt:"Original instruction",cwd:root,mode:"cli" as const,model:"chosen-model",effort:"low",bucket:"codex",sandbox:"workspaceWrite" as const,approvalPolicy:"on-request" as const,interactive:true as const,attachments:[{type:"mention" as const,path:path.join(root,"evidence.txt"),name:"evidence.txt"}],deliveryChecks:[{kind:"file" as const,path:"result.txt",label:"Result",minBytes:1}]}});
it("creates one task for overlapping original requests and confirms it without undoing a later pause",async()=>{
 const input=request(),[first,second]=await Promise.all([service.submit(input),service.submit(input)]);
 expect(first).toMatchObject({state:"accepted"});expect(second).toEqual(first);expect(store.data.jobs).toHaveLength(1);
 const job=store.data.jobs[0];expect(first).toEqual({state:"accepted",jobId:job.id});expect(job.clientRequest?.id).toBe(input.requestId);
 expect(job.model).toBe("chosen-model");expect(job.attachments).toEqual(input.input.attachments);expect(job.delivery?.checks).toEqual(input.input.deliveryChecks);
 await scheduler.control(job.id,"pause");expect(await service.submit(input)).toEqual(first);expect(job.state).toBe("paused");expect(store.data.jobs).toHaveLength(1);
});
it("recovers the same task after the complete store and scheduler restart",async()=>{
 const input=request(),first=await service.submit(input);await scheduler.control(store.data.jobs[0].id,"pause");await scheduler.shutdown();await open();
 expect(service.identity).toBe(input.installationId);expect(await service.submit(input)).toEqual(first);expect(store.data.jobs).toHaveLength(1);expect(store.data.jobs[0].state).toBe("paused");
});
it("rejects another installation, reused IDs and relative paths without creating another task",async()=>{
 const input=request();expect(await service.submit({...input,installationId:randomUUID()})).toMatchObject({state:"rejected",code:"installation"});expect(store.data.jobs).toHaveLength(0);
 expect(await service.submit({...input,input:{...input.input,cwd:"relative"}})).toMatchObject({state:"rejected",code:"input"});
 await service.submit(input);expect(await service.submit({...input,input:{...input.input,prompt:"Changed"}})).toMatchObject({state:"rejected",code:"request"});expect(store.data.jobs).toHaveLength(1);
});
it("retains a failed creation until storage recovers and then admits only the original request",async()=>{
 const input=request(),save=vi.spyOn(store,"save").mockRejectedValueOnce(Error("Disk unavailable"));
 expect(await service.submit(input)).toMatchObject({state:"pending"});expect(store.data.jobs).toHaveLength(0);save.mockRestore();
 expect(await service.submit(input)).toMatchObject({state:"accepted"});expect(store.data.jobs).toHaveLength(1);expect(store.data.jobs[0].prompt).toBe(input.input.prompt);
});
it("reconciles a lost acknowledgement after the scheduler already accepted a task",async()=>{
 const input=request(),add=scheduler.add.bind(scheduler);vi.spyOn(scheduler,"add").mockImplementation(async(...args)=>{await add(...args);throw Error("Lost acknowledgement");});
 expect(await service.submit(input)).toEqual({state:"accepted",jobId:store.data.jobs[0].id});expect(store.data.jobs).toHaveLength(1);
});
it("finds a committed task after a lost state-file rename acknowledgement and process restart",async()=>{
 const input=request(),rename=fs.rename.bind(fs);const fault=vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{await rename(from,to);if(String(to)===path.join(root,"state.json"))throw Error("State acknowledgement lost");});
 expect(await service.submit(input)).toMatchObject({state:"pending"});fault.mockRestore();
 expect(store.data.jobs).toHaveLength(0);const disk=JSON.parse(await fs.readFile(path.join(root,"state.json"),"utf8"));expect(disk.jobs).toHaveLength(1);
 // Simulate process loss before another save; opening the on-disk receipt must
 // find the existing task rather than create a replacement with another UUID.
 await open();expect(await service.submit(input)).toEqual({state:"accepted",jobId:disk.jobs[0].id});expect(store.data.jobs).toHaveLength(1);
});
it("persists cancellation before any admission, survives restart and stores only its fingerprint",async()=>{
 const input=request();expect(await service.cancel(input)).toMatchObject({state:"rejected",code:"cancelled"});await scheduler.shutdown();await open();
 expect(await service.submit(input)).toMatchObject({state:"rejected",code:"cancelled"});expect(store.data.jobs).toHaveLength(0);
 expect(await fs.readFile(path.join(root,"native-creation-cancellations",input.requestId+".json"),"utf8")).not.toContain(input.input.prompt);
});
it("joins an in-flight creation before reporting an attempted cancellation as the original acceptance",async()=>{
 const input=request(),add=scheduler.add.bind(scheduler);let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 vi.spyOn(scheduler,"add").mockImplementation(async(...args)=>{entered();await gate;return add(...args);});
 const submitting=service.submit(input);await started;const cancelling=service.cancel(input);release();expect(await cancelling).toEqual(await submitting);expect(store.data.jobs).toHaveLength(1);
});
it("recovers a lost cancellation write acknowledgement without later admitting the task",async()=>{
 const input=request(),rename=fs.rename.bind(fs);const fault=vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{await rename(from,to);if(String(to).includes("native-creation-cancellations"))throw Error("Cancellation acknowledgement lost");});
 await expect(service.cancel(input)).rejects.toThrow("acknowledgement");fault.mockRestore();
 expect(await service.submit(input)).toMatchObject({state:"rejected",code:"cancelled"});expect(store.data.jobs).toHaveLength(0);
});
