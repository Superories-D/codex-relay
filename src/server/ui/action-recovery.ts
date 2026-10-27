import {CommandError} from "./client";

export const actionPrefix="relay.remote.action.";
const names=new Set(["task.steer","task.model","task.control","task.queue","goal.update","workflow.control","workflow.retry","schedule.create","schedule.save","schedule.run","schedule.remove","schedule.abandon","delivery.save","delivery.run"]);
export const supportsActionRecovery=(name:string)=>names.has(name);
export type PendingAction={name:string;args:Record<string,any>&{requestId:string}};
export type ActionOutcome={settled:boolean;receipt?:any;error?:unknown};
type StorageView=Pick<Storage,"length"|"key"|"getItem"|"removeItem">;
type Call=(name:string,args?:any)=>Promise<any>;
type Update={key:string;record:PendingAction;outcome:ActionOutcome};
const encoded=(value:PendingAction)=>JSON.stringify(value);

/** One transport per stored intent, shared by task views and background recovery. */
export class ActionRecovery {
  private active=new Map<string,{payload:string;promise:Promise<ActionOutcome>}>();
  private completed=new Map<string,Update>();
  private listeners=new Set<(update:Update)=>void>();
  private draining?:Promise<void>;
  constructor(private storage:StorageView) {}
  read(key:string):PendingAction|null {
    try {
      if(!key.startsWith(actionPrefix))return null;
      const value=JSON.parse(this.storage.getItem(key)||"null");
      if(!value||!names.has(value.name)||!value.args||typeof value.args.requestId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.args.requestId))return null;
      return {name:value.name,args:value.args};
    }catch{return null;}
  }
  keys() {
    const keys:string[]=[];
    for(let i=0;i<this.storage.length;i++){const key=this.storage.key(i);if(key&&this.read(key))keys.push(key);}
    return keys.sort();
  }
  latest(key:string) {return this.completed.get(key)?.outcome;}
  subscribe(listener:(update:Update)=>void) {this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  async attempt(key:string,call:Call):Promise<ActionOutcome|undefined> {
    const record=this.read(key);if(!record)return this.latest(key);
    const payload=encoded(record),active=this.active.get(key);
    if(active){if(active.payload===payload)return active.promise;await active.promise;return this.attempt(key,call);}
    const promise=this.perform(key,record,call);this.active.set(key,{payload,promise});
    try{return await promise;}finally{if(this.active.get(key)?.promise===promise)this.active.delete(key);}
  }
  private async perform(key:string,record:PendingAction,call:Call) {
    let outcome:ActionOutcome;
    try{outcome={settled:true,receipt:await call(record.name,record.args)};}
    catch(error) {
      outcome={settled:false,error};
      if(error instanceof CommandError&&error.status>=400&&error.status<500&&![401,403,429].includes(error.status)) {
        try {const receipt=await call("action.read",record.args.requestId);outcome={settled:true,receipt:receipt||undefined,error:receipt?undefined:error};}
        catch {/* Keep the original intent until its receipt can be inspected. */}
      }
    }
    const current=this.read(key);
    if(current&&encoded(current)===encoded(record)) {
      if(outcome.settled)try{this.storage.removeItem(key);}catch(error){outcome={settled:false,error};}
      const update={key,record,outcome};
      if(outcome.settled){this.completed.delete(key);this.completed.set(key,update);while(this.completed.size>100)this.completed.delete(this.completed.keys().next().value!);}
      for(const listener of this.listeners)try{listener(update);}catch{/* One closed view cannot block other observers. */}
    }
    return outcome;
  }
  async drain(call:Call,alive:()=>boolean=()=>true) {
    if(this.draining)return this.draining;
    const task=this.drainOnce(call,alive);this.draining=task;
    try{await task;}finally{if(this.draining===task)this.draining=undefined;}
  }
  private async drainOnce(call:Call,alive:()=>boolean) {
    const keys=this.keys();let next=0;
    await Promise.all(Array.from({length:2},async()=>{while(alive()&&next<keys.length)await this.attempt(keys[next++],call);}));
  }
}
let browserRecovery:ActionRecovery|undefined;
export const actionRecovery=()=>browserRecovery ||= new ActionRecovery({
  get length(){return sessionStorage.length;},key:index=>sessionStorage.key(index),
  getItem:key=>sessionStorage.getItem(key),removeItem:key=>sessionStorage.removeItem(key),
});
