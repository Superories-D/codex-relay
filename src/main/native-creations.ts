import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {z} from "zod";
import {atomicWrite} from "../core/store";
import {redact} from "../core/redact";
import type {Scheduler} from "../core/scheduler";
import {newJobSchema} from "./validation";
import {nativeCreationSchema,type NativeCreation,type NativeCreationResult} from "../shared/native-creation";

const cancellationSchema=z.object({id:z.string().uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export class NativeCreations {
  private active=new Map<string,Promise<unknown>>();
  constructor(private scheduler:Scheduler,readonly identity:string){}
  private serial<T>(id:string,effect:()=>Promise<T>){
    const task=(this.active.get(id)||Promise.resolve()).catch(()=>{}).then(effect);this.active.set(id,task);
    void task.finally(()=>{if(this.active.get(id)===task)this.active.delete(id);}).catch(()=>{});return task;
  }
  private fingerprint(request:NativeCreation){return createHash("sha256").update(JSON.stringify(newJobSchema.parse(request.input))).digest("hex");}
  private file(id:string){return path.join(this.scheduler.store.root,"native-creation-cancellations",id+".json");}
  private async inspect(request:NativeCreation):Promise<NativeCreationResult|undefined>{
    if(request.installationId!==this.identity)return {state:"rejected",code:"installation",error:"应用数据身份已变化，原创建请求未投递。"};
    const fingerprint=this.fingerprint(request),job=this.scheduler.store.data.jobs.find(job=>job.clientRequest?.id===request.requestId);
    if(job)return job.clientRequest!.fingerprint===fingerprint?{state:"accepted",jobId:job.id}:{state:"rejected",code:"request",error:"请求编号已被其他任务使用。"};
    try{
      const cancelled=cancellationSchema.parse(JSON.parse(await fs.readFile(this.file(request.requestId),"utf8")));
      if(cancelled.id!==request.requestId||cancelled.fingerprint!==fingerprint)return {state:"rejected",code:"request",error:"请求编号已被其他任务使用。"};
      return {state:"rejected",code:"cancelled",error:"待确认创建已取消，草稿已保留。"};
    }catch(error:any){if(error.code!=="ENOENT")throw error;}
  }
  submit(value:unknown){
    const request=nativeCreationSchema.parse(value);
    return this.serial(request.requestId,async():Promise<NativeCreationResult>=>{
      let input;
      try{input=newJobSchema.parse(request.input);}catch{return {state:"rejected",code:"input",error:"任务参数无法验证，草稿已保留。"};}
      try{
        const observed=await this.inspect(request);if(observed)return observed;
        const job=await this.scheduler.add(input,undefined,undefined,request.requestId);
        return {state:"accepted",jobId:job.id};
      }catch(error){
        const observed=await this.inspect(request);if(observed)return observed;
        return {state:"pending",error:redact(error instanceof Error?error.message:String(error))};
      }
    });
  }
  cancel(value:unknown){
    const request=nativeCreationSchema.parse(value);
    return this.serial(request.requestId,async():Promise<NativeCreationResult>=>{
      const observed=await this.inspect(request);if(observed)return observed;
      await atomicWrite(this.file(request.requestId),JSON.stringify({id:request.requestId,fingerprint:this.fingerprint(request)}));
      return {state:"rejected",code:"cancelled",error:"待确认创建已取消，草稿已保留。"};
    });
  }
}
