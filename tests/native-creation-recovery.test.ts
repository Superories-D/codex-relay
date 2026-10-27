import {expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {NativeCreationRecovery} from "../src/renderer/native-creation-recovery";
import {confirmNativeDraft,saveDraftState,type DraftState} from "../src/renderer/drafts";
const identity=randomUUID(),jobId=randomUUID(),draftKey="new:D:\\Projects\\work";
const request=()=>({installationId:identity,requestId:randomUUID(),input:{title:"Original task",prompt:"Original",cwd:"D:\\Projects\\work",mode:"cli" as const,model:"model-1",effort:"low",bucket:"codex",approvalPolicy:"on-request" as const,sandbox:"workspaceWrite" as const,interactive:true as const,attachments:[],deliveryChecks:[{kind:"file" as const,path:"report.txt",label:"Report",minBytes:1}]}});
function storage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value);},values};}
it("freezes all creation inputs before IPC and recovers the original task ID after reload",async()=>{
 const s=storage(),input=request(),call=vi.fn(async()=>{expect(s.values.size).toBe(1);throw Error("Lost IPC acknowledgement");});
 const first=new NativeCreationRecovery({storage:s,identity,call,accepted:()=>{}});expect(await first.enqueue(input,"Original",draftKey)).toMatchObject({state:"pending"});input.input.prompt="Changed";input.input.deliveryChecks[0].path="other.txt";first.dispose();
 const accepted=vi.fn(),next=vi.fn(async(_name:string,_args?:unknown)=>({state:"accepted",jobId})),second=new NativeCreationRecovery({storage:s,identity,call:next,accepted});await second.drain();
 expect(next.mock.calls[0]).toEqual(["chat.creation.submit",expect.objectContaining({requestId:input.requestId,input:expect.objectContaining({prompt:"Original",model:"model-1",deliveryChecks:[{kind:"file",path:"report.txt",label:"Report",minBytes:1}]})})]);
 expect(accepted).toHaveBeenCalledWith(expect.objectContaining({draftKey}),{state:"accepted",jobId});expect(second.entries()).toEqual([]);
});
it("does not submit into a different installation or send an intent that could not be saved",async()=>{
 const s=storage(),call=vi.fn(async()=>({state:"accepted",jobId}));let recovery=new NativeCreationRecovery({storage:s,identity,call:async()=>{throw Error("Offline");},accepted:()=>{}});await recovery.enqueue(request(),"Original",draftKey);recovery.dispose();
 recovery=new NativeCreationRecovery({storage:s,identity:randomUUID(),call,accepted:()=>{}});await recovery.drain();expect(call).not.toHaveBeenCalled();expect(recovery.entries()).toHaveLength(1);
 const broken=new NativeCreationRecovery({storage:{getItem:()=>null,setItem:()=>{throw Error("Storage full");}},identity,call,accepted:()=>{}});expect(()=>broken.enqueue(request(),"Original",draftKey)).toThrow("Storage full");expect(call).not.toHaveBeenCalled();
});
it("retains a newer identical draft when accepted cleanup must repeat after storage failure",async()=>{
 const s=storage(),input=request();let current:DraftState={drafts:{[draftKey]:"Original"},files:{}};saveDraftState(s,current);let blocked=true,now=1;
 const set=s.setItem;s.setItem=(key,value)=>{if(key.includes("creations")&&value==="[]"&&blocked){blocked=false;throw Error("Cleanup failed");}set(key,value);};
 const recovery=new NativeCreationRecovery({storage:s,identity,now:()=>now,call:async()=>({state:"accepted",jobId}),accepted:record=>{current=confirmNativeDraft(s,current,record.request.requestId,record.draftKey,record.draft,record.request.input.attachments||[]);}});
 expect(await recovery.enqueue(input,"Original",draftKey)).toMatchObject({state:"pending"});expect(current.drafts[draftKey]).toBe("");
 current={drafts:{[draftKey]:"Original"},files:{}};saveDraftState(s,current);now+=3001;await recovery.drain();expect(recovery.entries()).toEqual([]);expect(current.drafts[draftKey]).toBe("Original");
});
it("deduplicates overlapping recovery, blocks another creation in the same composer and ignores disposed results",async()=>{
 const s=storage();let release!:(value:unknown)=>void;const call=vi.fn(()=>new Promise(resolve=>{release=resolve;})),accepted=vi.fn();
 const recovery=new NativeCreationRecovery({storage:s,identity,call,accepted}),first=recovery.enqueue(request(),"Original",draftKey),drain=recovery.drain();
 expect(call).toHaveBeenCalledOnce();expect(()=>recovery.enqueue(request(),"Another",draftKey)).toThrow("待确认创建");recovery.dispose();release({state:"accepted",jobId});await first;await drain;expect(accepted).not.toHaveBeenCalled();expect(recovery.entries()).toHaveLength(1);
});
it("keeps a timeout pending and retries with the same creation ID",async()=>{
 const s=storage(),input=request(),calls:any[]=[];let now=1;
 const recovery=new NativeCreationRecovery({storage:s,identity,timeoutMs:5,now:()=>now,call:async(_name,args)=>{calls.push(args);if(calls.length===1)return new Promise(()=>{});return {state:"accepted",jobId};},accepted:()=>{}});
 expect(await recovery.enqueue(input,"Original",draftKey)).toMatchObject({state:"pending"});now+=3001;await recovery.drain();expect(calls.map(call=>call.requestId)).toEqual([input.requestId,input.requestId]);expect(recovery.entries()).toEqual([]);
});
it("removes only a confirmed cancelled intent and keeps its draft",async()=>{
 const s=storage(),accepted=vi.fn(),rejected=vi.fn(),call=vi.fn(async(name)=>name==="chat.creation.cancel"?{state:"rejected",code:"cancelled",error:"Cancelled"}:{state:"pending",error:"Unavailable"});
 const recovery=new NativeCreationRecovery({storage:s,identity,call,accepted,rejected});await recovery.enqueue(request(),"Keep",draftKey);
 const record=recovery.entries()[0];expect(await recovery.cancel(record)).toMatchObject({state:"rejected",code:"cancelled"});expect(recovery.entries()).toEqual([]);expect(accepted).not.toHaveBeenCalled();expect(rejected).toHaveBeenCalledOnce();
});
it.each(["desktop","bad draft key"])("retains a corrupt/non-replayable creation record (%s)",reason=>{
 const s=storage(),input=request();s.setItem("relay.native.creations.v1",JSON.stringify([{request:{...input,input:{...input.input,mode:reason==="desktop"?"desktop":"cli"}},draft:"Keep",draftKey:reason==="bad draft key"?jobId:draftKey}]));const original=s.getItem("relay.native.creations.v1"),call=vi.fn();
 expect(()=>new NativeCreationRecovery({storage:s,identity,call,accepted:()=>{}})).toThrow();expect(s.getItem("relay.native.creations.v1")).toBe(original);expect(call).not.toHaveBeenCalled();
});
