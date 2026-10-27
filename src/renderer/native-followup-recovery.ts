import {z} from "zod";
import {nativeFollowupSchema,nativeFollowupResultSchema,type NativeFollowup,type NativeFollowupResult} from "../shared/native-followup";

const key="relay.native.followups.v1";
const pendingSchema=z.object({request:nativeFollowupSchema,draft:z.string().max(100000)}).strict();
export type PendingNativeFollowup=z.infer<typeof pendingSchema>;
type StorageView=Pick<Storage,"getItem"|"setItem">;
type Call=(name:string,args?:unknown)=>Promise<unknown>;
export class NativeFollowupRecovery {
  private active=new Map<string,Promise<NativeFollowupResult>>();
  private retry=new Map<string,{at:number;attempt:number}>();
  private cancelling=new Set<string>();
  private draining?:Promise<void>;
  private disposed=false;
  readonly errors=new Map<string,string>();
  constructor(private options:{storage:StorageView;identity:string;call:Call;accepted:(record:PendingNativeFollowup)=>void;rejected?:(record:PendingNativeFollowup,result:NativeFollowupResult)=>void;changed?:()=>void;timeoutMs?:number;now?:()=>number}){this.entries();}
  get identity(){return this.options.identity;}
  entries(){
    const raw=this.options.storage.getItem(key);if(!raw)return [] as PendingNativeFollowup[];
    const records=z.array(pendingSchema).max(100).parse(JSON.parse(raw));
    if(new Set(records.map(record=>record.request.requestId)).size!==records.length)throw Error("待确认消息记录无法读取；原记录已保留。");
    return records;
  }
  private save(records:PendingNativeFollowup[]){
    const value=JSON.stringify(records);if(value.length>4*1024*1024)throw Error("待确认消息保存失败，草稿已保留。");
    this.options.storage.setItem(key,value);
  }
  private changed(){if(!this.disposed)this.options.changed?.();}
  private now(){return this.options.now?.()??Date.now();}
  private defer(id:string,error:string){
    this.errors.set(id,error);const attempt=(this.retry.get(id)?.attempt||0)+1;
    this.retry.set(id,{attempt,at:this.now()+Math.min(60000,3000*2**Math.min(5,attempt-1))});
  }
  enqueue(request:NativeFollowup,draft:string){
    if(this.disposed)throw Error("消息恢复已关闭");
    const record=pendingSchema.parse({request,draft}),records=this.entries();
    if(request.installationId!==this.options.identity)throw Error("应用数据身份已变化，原消息未投递。");
    if(records.some(entry=>entry.request.input.id===request.input.id))throw Error("此任务仍有待确认消息，正在自动核对原请求。");
    if(records.length>=100)throw Error("待确认消息保存失败，草稿已保留。");
    this.save([...records,record]);this.changed();return this.attempt(record);
  }
  private async invoke(name:string,request:NativeFollowup){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return nativeFollowupResultSchema.parse(await Promise.race([
      this.options.call(name,request),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("消息回复超时，正在自动核对原请求。")),this.options.timeoutMs??12000);}),
    ]));}finally{if(timer)clearTimeout(timer);}
  }
  private settle(record:PendingNativeFollowup,result:NativeFollowupResult){
    if(this.disposed)return;
    const records=this.entries(),original=JSON.stringify(record),current=records.find(entry=>entry.request.requestId===record.request.requestId);
    if(!current||JSON.stringify(current)!==original)return;
    if(result.state==="pending"){
      this.defer(record.request.requestId,result.error);
    }else{
      // Draft confirmation is persisted before removing the recovery request.
      // A stored confirmation ID makes this cleanup safe to repeat after a crash.
      if(result.state==="accepted")this.options.accepted(record);
      this.save(records.filter(entry=>entry.request.requestId!==record.request.requestId));
      this.errors.delete(record.request.requestId);this.retry.delete(record.request.requestId);
      if(result.state==="rejected")this.options.rejected?.(record,result);
    }
    this.changed();
  }
  attempt(record:PendingNativeFollowup):Promise<NativeFollowupResult>{
    const id=record.request.requestId,existing=this.active.get(id);if(existing)return existing;
    if(record.request.installationId!==this.options.identity){this.errors.set(id,"应用数据身份已变化，原消息未投递。");this.changed();return Promise.resolve({state:"pending",error:"应用数据身份已变化，原消息未投递。"});}
    const task=(async()=>{
      let result:NativeFollowupResult;
      try{result=await this.invoke("chat.submit",record.request);this.settle(record,result);}
      catch(error){result={state:"pending",error:error instanceof Error?error.message:String(error)};if(!this.disposed){this.defer(id,result.error);this.changed();}}
      return result;
    })();this.active.set(id,task);
    void task.finally(()=>{if(this.active.get(id)===task)this.active.delete(id);}).catch(()=>{});return task;
  }
  drain(){
    if(this.draining)return this.draining;
    const task=(async()=>{
      const records=this.entries();let index=0;
      await Promise.all(Array.from({length:2},async()=>{
        while(index<records.length&&!this.disposed){const record=records[index++],id=record.request.requestId;
          if(this.cancelling.has(id)||(this.retry.get(id)?.at||0)>this.now())continue;
          await this.attempt(record);
        }
      }));
    })();this.draining=task;void task.finally(()=>{if(this.draining===task)this.draining=undefined;}).catch(()=>{});return task;
  }
  async cancel(record:PendingNativeFollowup){
    const id=record.request.requestId;this.cancelling.add(id);
    try{const result=await this.invoke("chat.submission.cancel",record.request);this.settle(record,result);return result;}
    catch(error){this.errors.set(id,error instanceof Error?error.message:String(error));this.changed();throw error;}
    finally{this.cancelling.delete(id);}
  }
  dispose(){this.disposed=true;}
}
