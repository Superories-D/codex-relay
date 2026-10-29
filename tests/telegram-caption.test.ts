import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {expect,it,vi} from "vitest";
import {ServerRuntime} from "../src/server/runtime";
import {TelegramBridge,type TelegramApi} from "../src/server/telegram";
import {atomicWrite} from "../src/core/store";

const config={token:"123456789:"+"a".repeat(35),userId:"123456789",notify:false};
async function fixture(write=atomicWrite){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),"relay-caption-")),workspace=path.join(base,"project");await fs.mkdir(workspace);
 const runtime=await ServerRuntime.open(path.join(base,"data"),undefined,[workspace]);await runtime.scheduler.dispatch(true);
 let updates:any[]=[],next=11,failReply=false;
 const sent:any[]=[],download=vi.fn(async()=>Buffer.from("attachment evidence"));
 const api:TelegramApi=async(method,body)=>{
   if(method==="getWebhookInfo")return {url:""};
   if(method==="getUpdates")return body.offset===-1?[{update_id:10}]:updates;
   if(method==="getFile")return {file_path:"documents/file.txt",file_size:19};
   if(failReply){failReply=false;throw Error("Reply ACK lost");}
   sent.push(body);return {message_id:sent.length};
 };
 let bridge=await TelegramBridge.open(runtime,config,[workspace],api,write,Date.now,download);await bridge.initialize();
 const message=(patch:any)=>{const id=next++;updates=[{update_id:id,message:{chat:{id:123456789,type:"private"},from:{id:123456789,is_bot:false},...patch}}];return bridge.pollOnce();};
 return {base,workspace,runtime,sent,download,get bridge(){return bridge;},send:(text:string,patch:any={})=>message({text,...patch}),
  upload:(caption:string,patch:any={})=>message({caption,document:{file_id:"file-"+next,file_name:"evidence.txt",file_size:19},...patch}),
  failReply(){failReply=true;},state:async()=>JSON.parse(await fs.readFile(path.join(runtime.store.root,"telegram-state.json"),"utf8")),
  async restart(roots=[workspace]){bridge=await TelegramBridge.open(runtime,config,roots,api,write,Date.now,download);},
  async close(){await bridge.stop();await runtime.close();await fs.rm(base,{recursive:true,force:true});}};
}

it.skipIf(process.platform!=="linux")("admits a document and explicit caption together without another message",async()=>{
 const f=await fixture();try{
   await f.upload("/run 1 Inspect this document");
   expect(f.runtime.store.data.jobs).toHaveLength(1);const job=f.runtime.store.data.jobs[0];
   expect(job.prompt).toBe("Inspect this document");expect(job.attachments).toHaveLength(1);
   expect(await fs.readFile(job.attachments![0].path,"utf8")).toBe("attachment evidence");
   expect((await f.state()).inbox).toEqual([]);expect(f.sent.at(-1).text).toContain("Queued");
 }finally{await f.close();}
});

it.skipIf(process.platform!=="linux")("combines the frozen inbox with a photo caption and clears only submitted attachments",async()=>{
 const f=await fixture();try{
   await f.send("/project 1");await f.upload("Reference only");
   await f.upload("/NEW@relaybot Compare both files",{document:undefined,photo:[{file_id:"small",file_size:5},{file_id:"large",file_size:19}]});
   const job=f.runtime.store.data.jobs[0];expect(job.attachments).toHaveLength(2);expect(job.attachments?.map(file=>file.type)).toEqual(["mention","localImage"]);
   expect(job.prompt).toBe("Compare both files");expect((await f.state()).inbox).toEqual([]);expect(f.download).toHaveBeenCalledTimes(2);
 }finally{await f.close();}
});

it.skipIf(process.platform!=="linux")("routes an explicit caption follow-up to the replied task without changing the selection",async()=>{
 const f=await fixture();try{
   await f.send("/run 1 First task");const first=f.runtime.store.data.jobs[0],card=f.sent.length;
   await f.send("/run 1 Second task");const second=f.runtime.store.data.jobs[1];
   await f.upload("/follow Inspect this new evidence",{reply_to_message:{message_id:card}});
   expect(first.queuedMessages).toHaveLength(1);expect(first.queuedMessages![0]).toMatchObject({text:"Inspect this new evidence",attachments:[{name:"upload-evidence.txt"}]});
   expect(second.queuedMessages||[]).toEqual([]);expect((await f.state()).context.task).toBe(second.id);
   await f.upload("/follow Do not guess",{reply_to_message:{message_id:987654}});
   expect(f.sent.at(-1).text).toContain("未关联任务");expect(first.queuedMessages).toHaveLength(1);expect(f.download).toHaveBeenCalledTimes(1);
 }finally{await f.close();}
});

it.skipIf(process.platform!=="linux").each(["Explain this /new text","/cancel","/newspaper headline","/run 1 Group instruction"])("stages ordinary, unsupported or grouped captions without executing them: %s",async(caption)=>{
 const f=await fixture();try{
   await f.upload(caption,caption.includes("Group")?{media_group_id:"album-1"}:{});
   expect(f.runtime.store.data.jobs).toHaveLength(0);expect((await f.state()).inbox).toHaveLength(1);expect(f.sent.at(-1).text).toContain("附件已暂存");
   if(caption.includes("Group"))expect(f.sent.at(-1).text).toContain("等所有附件到齐");
 }finally{await f.close();}
});

it.skipIf(process.platform!=="linux")("does not accept commands in media from a forwarded message or another sender",async()=>{
 const f=await fixture();try{
   await f.upload("/run 1 Unauthorized",{from:{id:99}});await f.upload("/run 1 Forwarded",{forward_origin:{type:"user"}});
   expect(f.runtime.store.data.jobs).toHaveLength(0);expect(f.download).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it.skipIf(process.platform!=="linux")("keeps a downloaded attachment available when its explicit command is invalid",async()=>{
 const f=await fixture();try{
   await f.upload("/new");expect(f.runtime.store.data.jobs).toHaveLength(0);expect((await f.state()).inbox).toHaveLength(1);expect(f.sent.at(-1).text).toContain("附件保留在 /inbox");
   await f.send("/run 1 Corrected instruction");expect(f.runtime.store.data.jobs[0].attachments).toHaveLength(1);expect(f.download).toHaveBeenCalledTimes(1);
   await f.upload("/run");await f.restart();await f.bridge.pollOnce();expect(f.runtime.store.data.jobs).toHaveLength(1);
 }finally{await f.close();}
});

it.skipIf(process.platform!=="linux")("confirms the original caption admission after its Telegram reply was lost",async()=>{
 const f=await fixture();try{
   f.failReply();await expect(f.upload("/run 1 Accepted once")).rejects.toThrow("ACK lost");const job=f.runtime.store.data.jobs[0];
   await f.runtime.scheduler.control(job.id,"pause");await f.restart();await f.bridge.pollOnce();
   expect(f.runtime.store.data.jobs).toHaveLength(1);expect(job.state).toBe("paused");expect(f.download).toHaveBeenCalledTimes(1);expect((await f.state()).incoming).toBeUndefined();
 }finally{await f.close();}
});

it.skipIf(process.platform!=="linux")("retains the original caption through a download interruption and rejects a later task control revision",async()=>{
 const f=await fixture();try{
   await f.send("/run 1 Existing task");const job=f.runtime.store.data.jobs[0];f.download.mockRejectedValueOnce(Error("Network unavailable"));
   await expect(f.upload(`/send ${job.id.slice(0,8)} Original follow-up`)).rejects.toThrow("download interrupted");
   expect((await f.state()).incoming).toMatchObject({text:`/send ${job.id} Original follow-up`,confirmation:{controlRevision:job.controlRevision||0}});
   await f.runtime.scheduler.control(job.id,"pause");await f.restart();await f.bridge.pollOnce();
   expect(job.state).toBe("paused");expect(job.queuedMessages||[]).toEqual([]);expect((await f.state()).inbox).toHaveLength(1);expect(f.sent.at(-1).text).toContain("Error:");
 }finally{await f.close();}
});

it.skipIf(process.platform!=="linux")("reconciles an already accepted caption follow-up before checking a later pause",async()=>{
 let enabled=false,failed=false;const f=await fixture(async(file,value)=>{
   const state=JSON.parse(String(value));if(enabled&&!failed&&state.pending?.text?.startsWith("Follow-up accepted")){failed=true;throw Error("Follow-up reply checkpoint lost");}await atomicWrite(file,value);
 });
 try{
   await f.send("/run 1 Existing task");const job=f.runtime.store.data.jobs[0];enabled=true;
   await expect(f.upload("/follow Keep the original input")).rejects.toThrow("checkpoint lost");
   await f.runtime.scheduler.control(job.id,"pause");await f.restart();await f.bridge.pollOnce();
   expect(job.state).toBe("paused");expect(job.messageReceipts).toHaveLength(1);expect(job.queuedMessages).toHaveLength(1);expect(f.download).toHaveBeenCalledTimes(1);expect(f.sent.at(-1).text).toContain("Follow-up accepted");
 }finally{await f.close();}
});

it.skipIf(process.platform!=="linux").each(["after staging","before freeze","after freeze","after admission","after inbox cleanup"])("recovers a caption at %s without changing its project, instruction or attachment",async(phase)=>{
 let failed=false;const f=await fixture(async(file,value)=>{
   const state=JSON.parse(String(value)),frozen=state.incoming&&!state.incoming.media&&state.incoming.context.attachments?.length;
   const hit=phase==="after staging"?state.incoming?.media&&state.inbox?.length:(phase==="before freeze"||phase==="after freeze")?frozen&&!state.context?.task:
     phase==="after admission"?frozen&&!!state.context?.task:state.pending?.text?.startsWith("Queued");
   if(!failed&&hit){failed=true;if(phase==="after freeze")await atomicWrite(file,value);throw Error("Caption checkpoint lost");}
   await atomicWrite(file,value);
 });
 try{
   await expect(f.upload("/run 1 Original caption instruction")).rejects.toThrow("checkpoint lost");
   const second=path.join(f.base,"second-project");await fs.mkdir(second);const state=await f.state();state.context={project:second};await atomicWrite(path.join(f.runtime.store.root,"telegram-state.json"),JSON.stringify(state));
   await f.restart([second,f.workspace]);await f.bridge.pollOnce();
   expect(f.runtime.store.data.jobs).toHaveLength(1);const job=f.runtime.store.data.jobs[0];expect(job.cwd).toBe(f.workspace);expect(job.prompt).toBe("Original caption instruction");expect(job.attachments).toHaveLength(1);
   expect(f.download).toHaveBeenCalledTimes(1);expect((await f.state()).inbox).toEqual([]);
 }finally{await f.close();}
});

it.skipIf(process.platform!=="linux").each([false,true])("retries temporary attachment storage failure without losing the caption (receipt committed=%s)",async(committed)=>{
 const f=await fixture();try{
   const put=f.runtime.uploads.put.bind(f.runtime.uploads);vi.spyOn(f.runtime.uploads,"put").mockImplementationOnce(async(...args)=>{
     if(committed)await put(...args);throw Object.assign(Error("Storage temporarily full"),{code:"ENOSPC"});
   });
   await expect(f.upload("/run 1 Preserve this caption")).rejects.toThrow("storage unavailable");expect((await f.state()).incoming.text).toBe("/new Preserve this caption");expect(f.runtime.store.data.jobs).toHaveLength(0);
   await f.restart();await f.bridge.pollOnce();expect(f.runtime.store.data.jobs).toHaveLength(1);expect(f.runtime.store.data.jobs[0].attachments).toHaveLength(1);expect(f.download).toHaveBeenCalledTimes(committed?1:2);
 }finally{await f.close();}
});
