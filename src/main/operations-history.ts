import { Worker } from "node:worker_threads";
import { promises as fs } from "node:fs";
import path from "node:path";
import { observationSchema,operationQuerySchema,type OperationObservation,type OperationPage,type RecordingStatus } from "../shared/operations";

type Waiter={resolve:(value:any)=>void;reject:(error:Error)=>void};
export class OperationsHistory {
  private worker?:Worker;
  private nextId=0;
  private pending=new Map<number,Waiter>();
  private chain:Promise<unknown>=Promise.resolve();
  private lifecycle:Promise<unknown>=Promise.resolve();
  private facts=new Map<string,string>();
  private dispatch="";
  private queuedBytes=0;
  private status:RecordingStatus={phase:"closed",pending:0};
  constructor(private options:{root:string;worker:string;maxPendingBytes?:number;report?:(issue:string)=>void}){}
  view(){return structuredClone(this.status);}
  pause(error:unknown){this.fail(error);return this.view();}
  private fail(error:unknown,at=Date.now()) {
    const first=this.status.phase!=="failed";
    this.status={...this.status,phase:"failed",issue:"运行历史记录已暂停，请检查存储后重新启用。",gapSince:this.status.gapSince??at};
    if(first)this.options.report?.(this.status.issue!);
  }
  private request(method:string,args?:unknown):Promise<any>{
    const worker=this.worker;if(!worker)return Promise.reject(Error("运行历史记录尚未就绪"));
    return new Promise((resolve,reject)=>{
      const id=++this.nextId;this.pending.set(id,{resolve,reject});
      try{worker.postMessage({id,method,args});}catch(error){this.pending.delete(id);reject(error);}
    });
  }
  start(initial:OperationObservation){
    const task=this.lifecycle.then(()=>this.startOnce(initial));this.lifecycle=task.catch(()=>{});return task;
  }
  private async startOnce(raw:OperationObservation){
    this.status={...this.status,phase:"closed"};
    await this.closeWorker();
    this.status={...this.status,phase:"starting",issue:undefined,pending:0};
    try{
      const initial=observationSchema.parse(raw);await fs.mkdir(this.options.root,{recursive:true,mode:0o700});
      const root=await fs.realpath(this.options.root);
      const worker=new Worker(this.options.worker,{execArgv:[],stderr:true});this.worker=worker;
      worker.stderr.on("data",()=>{}); // Node experimental warnings contain no useful recording state.
      worker.on("message",message=>{const waiter=this.pending.get(message.id);if(!waiter)return;this.pending.delete(message.id);if(message.error)waiter.reject(Error(message.error));else waiter.resolve(message.value);});
      const lost=(error:Error)=>{if(this.worker!==worker)return;this.worker=undefined;for(const p of this.pending.values())p.reject(error);this.pending.clear();this.fail(error);void worker.terminate().catch(()=>{});};
      worker.on("error",lost);worker.once("exit",code=>lost(Error(`Operations worker exited ${code}`)));
      this.facts=new Map(initial.facts.map(f=>[f.id,JSON.stringify(f)]));this.dispatch=JSON.stringify(initial.dispatch);this.queuedBytes=0;
      const opening=this.request("open",path.join(root,"operations.sqlite")).then(()=>this.request("append",{at:initial.at,baseline:true,facts:initial.facts,removed:[],dispatch:initial.dispatch}));
      this.chain=opening.then(checkpoint=>{Object.assign(this.status,checkpoint);if(this.status.phase==="starting")this.status={...this.status,phase:"recording",gapSince:undefined};}).catch(error=>{this.fail(error,initial.at);});
      await this.chain;return this.view();
    }catch(error){this.fail(error);return this.view();}
  }
  observe(raw:OperationObservation){
    if(this.status.phase!=="starting"&&this.status.phase!=="recording"){this.status.gapSince??=raw.at;return;}
    if(!this.worker){this.status.gapSince??=raw.at;return;}
    try{
      // The scheduler projection is already an explicit allowlist. Validate
      // changed records in the worker instead of reparsing every unchanged task
      // on each notification; malformed input still pauses recording visibly.
      const observation=raw,next=new Map(observation.facts.map(f=>[f.id,JSON.stringify(f)]));
      const facts=observation.facts.filter(f=>this.facts.get(f.id)!==next.get(f.id)),removed=[...this.facts.keys()].filter(id=>!next.has(id));
      const dispatch=JSON.stringify(observation.dispatch)!==this.dispatch?observation.dispatch:undefined;
      if(!facts.length&&!removed.length&&!dispatch)return;
      const delta={at:observation.at,baseline:false,facts,removed,dispatch},bytes=Buffer.byteLength(JSON.stringify(delta));
      if(this.queuedBytes+bytes>(this.options.maxPendingBytes??16*1024*1024)){this.fail(Error("Recording backpressure"),observation.at);return;}
      this.facts=next;this.dispatch=JSON.stringify(observation.dispatch);this.queuedBytes+=bytes;this.status.pending++;
      this.chain=this.chain.then(async()=>{
        if(this.status.phase==="failed"||this.status.phase==="closed")return;
        const checkpoint=await this.request("append",delta);Object.assign(this.status,checkpoint);
      }).catch(error=>{this.fail(error,observation.at);}).finally(()=>{this.queuedBytes-=bytes;this.status.pending--;});
    }catch(error){this.fail(error,raw.at);}
  }
  async page(input:unknown):Promise<OperationPage>{
    const query=operationQuerySchema.parse(input);await this.chain;
    if(!this.worker||this.status.phase==="starting"||this.status.phase==="closed")throw Error("运行历史记录尚未就绪");
    return this.request("query",query);
  }
  async drain(){await this.chain;}
  private async closeWorker(){
    await this.chain;const worker=this.worker;if(!worker)return;
    try{await this.request("close");}catch{}
    this.worker=undefined;
    for(const waiter of this.pending.values())waiter.reject(Error("Operations history closed"));this.pending.clear();
    await worker.terminate();
  }
  shutdown(){const task=this.lifecycle.then(async()=>{await this.closeWorker();this.status={...this.status,phase:"closed"};});this.lifecycle=task.catch(()=>{});return task;}
}
