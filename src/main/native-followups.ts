import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import {atomicWrite} from "../core/store";
import {redact} from "../core/redact";
import type {Scheduler} from "../core/scheduler";
import {chatSendSchema} from "./validation";
import {nativeFollowupSchema,type NativeFollowup,type NativeFollowupResult} from "../shared/native-followup";

const identitySchema=z.object({version:z.literal(1),id:z.string().uuid()}).strict();
const cancellationSchema=z.object({id:z.string().uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export class NativeFollowups {
  private active=new Map<string,Promise<unknown>>();
  private constructor(private scheduler:Scheduler,readonly identity:string){}
  static async open(scheduler:Scheduler){
    const file=path.join(scheduler.store.root,"native-chat-installation.json");let identity:string;
    try{identity=identitySchema.parse(JSON.parse(await fs.readFile(file,"utf8"))).id;}
    catch(error:any){if(error.code!=="ENOENT")throw error;identity=randomUUID();await atomicWrite(file,JSON.stringify({version:1,id:identity}));}
    return new NativeFollowups(scheduler,identity);
  }
  private serial<T>(id:string,effect:()=>Promise<T>){
    const task=(this.active.get(id)||Promise.resolve()).catch(()=>{}).then(effect);this.active.set(id,task);
    void task.finally(()=>{if(this.active.get(id)===task)this.active.delete(id);}).catch(()=>{});return task;
  }
  private fingerprint(request:NativeFollowup){return createHash("sha256").update(JSON.stringify(request.input)).digest("hex");}
  private file(id:string){return path.join(this.scheduler.store.root,"native-chat-cancellations",id+".json");}
  private async inspect(request:NativeFollowup):Promise<NativeFollowupResult|undefined>{
    if(request.installationId!==this.identity)return {state:"rejected",code:"installation",error:"应用数据身份已变化，原消息未投递。"};
    const job=this.scheduler.store.data.jobs.find(job=>job.id===request.input.id);
    if(!job||job.mode!=="cli")return {state:"rejected",code:"task",error:"原任务已不存在，消息未投递。"};
    const receipt=job.messageReceipts?.find(receipt=>receipt.id===request.requestId);
    if(receipt)return receipt.fingerprint===this.fingerprint(request)?{state:"accepted"}:{state:"rejected",code:"request",error:"请求编号已被其他消息使用。"};
    try{
      const cancelled=cancellationSchema.parse(JSON.parse(await fs.readFile(this.file(request.requestId),"utf8")));
      if(cancelled.id!==request.requestId||cancelled.fingerprint!==this.fingerprint(request))return {state:"rejected",code:"request",error:"请求编号已被其他消息使用。"};
      return {state:"rejected",code:"cancelled",error:"待确认消息已取消，草稿已保留。"};
    }catch(error:any){if(error.code!=="ENOENT")throw error;}
    if((job.controlRevision||0)!==request.controlRevision)return {state:"rejected",code:"control",error:"任务控制状态已变化，原消息未投递，草稿已保留。"};
  }
  submit(value:unknown){
    const request=nativeFollowupSchema.parse(value);
    return this.serial(request.requestId,async():Promise<NativeFollowupResult>=>{
      let input;
      try{input=chatSendSchema.parse(request.input);}catch{return {state:"rejected",code:"input",error:"消息参数无法验证，草稿已保留。"};}
      try{
        const observed=await this.inspect(request);if(observed)return observed;
        await this.scheduler.send(input,request.requestId,request.controlRevision);
        return {state:"accepted"};
      }catch(error){
        const observed=await this.inspect(request).catch(()=>undefined);if(observed)return observed;
        return {state:"pending",error:String(redact(error instanceof Error?error.message:String(error))).slice(0,1000)};
      }
    });
  }
  cancel(value:unknown){
    const request=nativeFollowupSchema.parse(value);
    return this.serial(request.requestId,async():Promise<NativeFollowupResult>=>{
      const observed=await this.inspect(request);if(observed)return observed;
      // Serial with submit: a still-running admission wins as accepted. Only
      // an unaccepted intent receives a durable cancellation tombstone.
      await atomicWrite(this.file(request.requestId),JSON.stringify({id:request.requestId,fingerprint:this.fingerprint(request)}));
      return {state:"rejected",code:"cancelled",error:"待确认消息已取消，草稿已保留。"};
    });
  }
}
