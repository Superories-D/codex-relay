import {expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {NativeFollowupRecovery} from "../src/renderer/native-followup-recovery";
import {confirmNativeDraft,saveDraftState} from "../src/renderer/drafts";
const identity=randomUUID();
const request=(id=randomUUID())=>({installationId:identity,requestId:randomUUID(),controlRevision:0,input:{id,text:"Original",attachments:[],action:"queue" as const}});
function storage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value);},values};}
it("persists a frozen request before IPC and resumes the same ID after renderer reload",async()=>{
 const s=storage(),input=request(),call=vi.fn(async()=>{expect(s.values.size).toBe(1);throw Error("Lost IPC acknowledgement");});
 const first=new NativeFollowupRecovery({storage:s,identity,call,accepted:()=>{}});expect(await first.enqueue(input,"Original")).toMatchObject({state:"pending"});input.input.text="Changed";first.dispose();
 const accepted=vi.fn(),next=vi.fn(async(_name:string,_args?:unknown)=>({state:"accepted"})),second=new NativeFollowupRecovery({storage:s,identity,call:next,accepted});await second.drain();
 expect(next.mock.calls[0][1]).toMatchObject({requestId:input.requestId,input:{text:"Original"}});expect(accepted).toHaveBeenCalledOnce();expect(second.entries()).toEqual([]);
});
it("never invokes a different installation and fails closed when storage cannot save an intent",async()=>{
 const s=storage(),call=vi.fn(async()=>({state:"accepted"}));let recovery=new NativeFollowupRecovery({storage:s,identity,call:async()=>{throw Error("Offline");},accepted:()=>{}});await recovery.enqueue(request(),"Original");recovery.dispose();
 recovery=new NativeFollowupRecovery({storage:s,identity:randomUUID(),call,accepted:()=>{}});await recovery.drain();expect(call).not.toHaveBeenCalled();expect(recovery.entries()).toHaveLength(1);
 const broken=new NativeFollowupRecovery({storage:{getItem:()=>null,setItem:()=>{throw Error("Quota");}},identity,call,accepted:()=>{}});expect(()=>broken.enqueue(request(),"Original")).toThrow("Quota");expect(call).not.toHaveBeenCalled();
});
it("preserves newer drafts when acknowledgement cleanup is retried after a storage failure",async()=>{
 const s=storage(),input=request();let current={drafts:{[input.input.id]:"Original"},files:{}};saveDraftState(s,current);let blocked=true,now=1;
 const set=s.setItem;s.setItem=(key,value)=>{if(key.includes("followups")&&value==="[]"&&blocked){blocked=false;throw Error("Cleanup failed");}set(key,value);};
 const recovery=new NativeFollowupRecovery({storage:s,identity,now:()=>now,call:async()=>({state:"accepted"}),accepted:record=>{current=confirmNativeDraft(s,current,record.request.requestId,record.request.input.id,record.draft,record.request.input.attachments);}});
 expect(await recovery.enqueue(input,"Original")).toMatchObject({state:"pending"});expect(current.drafts[input.input.id]).toBe("");expect(recovery.entries()).toHaveLength(1);
 current={drafts:{[input.input.id]:"Original"},files:{}};saveDraftState(s,current);now+=3001;await recovery.drain();expect(recovery.entries()).toEqual([]);expect(current.drafts[input.input.id]).toBe("Original");
});
it("deduplicates concurrent recovery and ignores late results after disposal",async()=>{
 const s=storage();let release!:(value:unknown)=>void;const call=vi.fn(()=>new Promise(resolve=>{release=resolve;})),accepted=vi.fn();
 const recovery=new NativeFollowupRecovery({storage:s,identity,call,accepted});const first=recovery.enqueue(request(),"Original"),drain=recovery.drain();expect(call).toHaveBeenCalledOnce();recovery.dispose();release({state:"accepted"});await first;await drain;expect(accepted).not.toHaveBeenCalled();expect(recovery.entries()).toHaveLength(1);
});
it("keeps a timed-out request and recovers using the original ID",async()=>{
 const s=storage(),input=request(),calls:any[]=[];let now=1;
 const recovery=new NativeFollowupRecovery({storage:s,identity,timeoutMs:5,now:()=>now,call:async(_name,args)=>{calls.push(args);if(calls.length===1)return new Promise(()=>{});return {state:"accepted"};},accepted:()=>{}});
 expect(await recovery.enqueue(input,"Original")).toMatchObject({state:"pending"});now+=3001;await recovery.drain();expect(calls.map(call=>call.requestId)).toEqual([input.requestId,input.requestId]);expect(recovery.entries()).toEqual([]);
});
it("keeps corrupt or non-replayable stored requests intact without invoking IPC",()=>{
 const s=storage();s.setItem("relay.native.followups.v1",JSON.stringify([{request:{...request(),input:{...request().input,action:"steer"}},draft:"Keep"}]));const original=s.getItem("relay.native.followups.v1"),call=vi.fn();
 expect(()=>new NativeFollowupRecovery({storage:s,identity,call,accepted:()=>{}})).toThrow();expect(s.getItem("relay.native.followups.v1")).toBe(original);expect(call).not.toHaveBeenCalled();
});
