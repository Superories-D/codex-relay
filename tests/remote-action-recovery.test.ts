import {it,expect,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {ActionRecovery,actionPrefix,type PendingAction} from "../src/server/ui/action-recovery";
import {CommandError} from "../src/server/ui/client";
class MemoryStorage {
  values=new Map<string,string>();failRemove=false;
  get length(){return this.values.size;}
  key(index:number){return [...this.values.keys()][index]||null;}
  getItem(key:string){return this.values.get(key)||null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){if(this.failRemove)throw Error("Storage unavailable");this.values.delete(key);}
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(storage=new MemoryStorage()) {
  const key=actionPrefix+randomUUID(),record:PendingAction={name:"task.control",args:{requestId:randomUUID(),id:randomUUID(),action:"pause",expected:"Original state"}};
  storage.setItem(key,JSON.stringify(record));return {storage,key,record,recovery:new ActionRecovery(storage)};
}
it("shares an in-flight request between a task view and background recovery",async()=>{
  const {storage,key,record,recovery}=fixture(),updates:any[]=[];let resolve!:(value:any)=>void;
  const call=vi.fn(()=>new Promise<any>(done=>{resolve=done;}));recovery.subscribe(update=>updates.push(update));
  const view=recovery.attempt(key,call),background=recovery.drain(call);expect(call).toHaveBeenCalledTimes(1);
  resolve({id:record.args.requestId,state:"succeeded"});await Promise.all([view,background]);
  expect(call).toHaveBeenCalledTimes(1);expect(storage.getItem(key)).toBeNull();expect(updates).toHaveLength(1);
  expect(recovery.latest(key)?.receipt.state).toBe("succeeded");
});
it("recovers frozen requests without mounting their task after a page restart",async()=>{
  const {storage,key,record,recovery}=fixture(),offline=vi.fn().mockRejectedValue(Error("Proxy disconnected"));
  expect(await recovery.attempt(key,offline)).toMatchObject({settled:false});expect(JSON.parse(storage.getItem(key)!)).toEqual(record);
  const restarted=new ActionRecovery(storage),online=vi.fn().mockResolvedValue({state:"succeeded"});await restarted.drain(online);
  expect(online).toHaveBeenCalledExactlyOnceWith(record.name,record.args);expect(storage.getItem(key)).toBeNull();
});
it.each([null,{state:"pending"},{state:"succeeded",result:{applied:true}}])("inspects the original receipt before settling a definitive HTTP error (%j)",async receipt=>{
  const {storage,key,record,recovery}=fixture(),error=new CommandError(409,"Uncertain gateway response"),call=vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(receipt);
  const outcome=await recovery.attempt(key,call);expect(outcome?.settled).toBe(true);expect(outcome?.error).toBe(receipt?undefined:error);expect(outcome?.receipt).toEqual(receipt||undefined);
  expect(call.mock.calls).toEqual([[record.name,record.args],["action.read",record.args.requestId]]);expect(storage.getItem(key)).toBeNull();
});
it.each([401,403,429])("retains an authorization or rate-limit failure for automatic recovery (%s)",async status=>{
  const {storage,key,recovery}=fixture(),call=vi.fn().mockRejectedValue(new CommandError(status,"Unavailable"));
  expect(await recovery.attempt(key,call)).toMatchObject({settled:false});expect(call).toHaveBeenCalledTimes(1);expect(storage.getItem(key)).not.toBeNull();
});
it("keeps the intent if the original receipt cannot be inspected",async()=>{
  const {storage,key,recovery}=fixture(),call=vi.fn().mockRejectedValueOnce(new CommandError(409,"Changed installation")).mockRejectedValueOnce(Error("Receipt unavailable"));
  expect(await recovery.attempt(key,call)).toMatchObject({settled:false});expect(storage.getItem(key)).not.toBeNull();
});
it("does not erase or publish over a newer request stored under the same scope",async()=>{
  const {storage,key,record,recovery}=fixture(),listener=vi.fn();let resolve!:(value:any)=>void;
  recovery.subscribe(listener);const old=recovery.attempt(key,()=>new Promise(done=>{resolve=done;}));
  const newer={...record,args:{...record.args,requestId:randomUUID(),action:"resume"}};storage.setItem(key,JSON.stringify(newer));resolve({state:"succeeded"});await old;
  expect(JSON.parse(storage.getItem(key)!)).toEqual(newer);expect(listener).not.toHaveBeenCalled();
  const call=vi.fn().mockResolvedValue({state:"succeeded"});await recovery.attempt(key,call);expect(call).toHaveBeenCalledExactlyOnceWith(newer.name,newer.args);
});
it("retains an acknowledged request when local cleanup fails",async()=>{
  const {storage,key,record,recovery}=fixture();storage.failRemove=true;
  expect(await recovery.attempt(key,async()=>({state:"succeeded"}))).toMatchObject({settled:false});expect(JSON.parse(storage.getItem(key)!)).toEqual(record);
});
it("bounds background concurrency and skips malformed or non-durable commands",async()=>{
  const storage=new MemoryStorage(),entries=Array.from({length:5},()=>fixture(storage)),recovery=new ActionRecovery(storage),finish:(()=>void)[]=[];
  storage.setItem(actionPrefix+"unsafe",JSON.stringify({name:"job.control",args:{requestId:randomUUID()}}));storage.setItem(actionPrefix+"corrupt","{");
  let active=0,peak=0,calls=0;const call=()=>{calls++;active++;peak=Math.max(peak,active);return new Promise(resolve=>finish.push(()=>{active--;resolve({state:"succeeded"});}));};
  const drain=Promise.all([recovery.drain(call),recovery.drain(call)]);expect(calls).toBe(2);
  while(calls<5){finish.shift()!();await flush();}while(finish.length)finish.shift()!();await drain;
  expect(peak).toBe(2);expect(calls).toBe(5);expect(recovery.keys()).toEqual([]);expect(entries.every(entry=>storage.getItem(entry.key)===null)).toBe(true);expect(storage.length).toBe(2);
});
