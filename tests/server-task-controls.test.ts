import {describe,it,expect,vi} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import {ServerRuntime} from "../src/server/runtime";
import {openHttp} from "../src/server/http";
import {taskControlSignature} from "../src/shared/task-control";

describe.skipIf(process.platform!=="linux")("durable task management",()=>{
  it("recovers original control and queue receipts over HTTP without applying them to later state",async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-task-controls-")),workspace=path.join(root,"workspace"),data=path.join(root,"data");await fs.mkdir(workspace);
    let runtime=await ServerRuntime.open(data,undefined,[workspace]);await runtime.scheduler.dispatch(true);
    let web=await openHttp(runtime,0,[workspace]);
    const call=async(name:string,args:unknown)=>{
      const token=await fs.readFile(path.join(data,"http-token"),"utf8"),base=`http://127.0.0.1:${(web.server.address() as any).port}`;
      const response=await fetch(base+"/api/command",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({name,args})});
      const body=await response.json();if(!response.ok)throw Error(body.error);return body.result;
    };
    try {
      const created=await call("job.submit",{requestId:randomUUID(),input:{title:"Control receipt",prompt:"Initial work",cwd:workspace,mode:"cli",model:"",effort:"",bucket:"codex",approvalPolicy:"on-request",sandbox:"workspaceWrite",interactive:true}}),job=runtime.store.data.jobs.find(job=>job.id===created.id)!;
      const control={requestId:randomUUID(),id:job.id,action:"pause",expected:taskControlSignature(job)},native=vi.spyOn(runtime.scheduler,"controlObserved");
      const [first,duplicate]=await Promise.all([call("task.control",control),call("task.control",control)]);
      expect(first).toEqual(duplicate);expect(first.result.applied).toBe(true);expect(job.state).toBe("paused");expect(native).toHaveBeenCalledTimes(1);
      await runtime.command("job.control",{id:job.id,action:"resume"});
      expect(await call("task.control",control)).toEqual(first);expect(job.state).toBe("queued");expect(native).toHaveBeenCalledTimes(1);
      const stale=await call("task.control",{...control,requestId:randomUUID()});expect(stale).toMatchObject({state:"succeeded",result:{applied:false}});expect(job.state).toBe("queued");
      await runtime.command("chat.submit",{requestId:randomUUID(),input:{id:job.id,text:"first",attachments:[],action:"queue"}});
      await runtime.command("chat.submit",{requestId:randomUUID(),input:{id:job.id,text:"second",attachments:[],action:"queue"}});
      const queue={requestId:randomUUID(),input:{id:job.id,messageId:job.queuedMessages![0].id,revision:job.queueRevision,action:"remove"}},edit=vi.spyOn(runtime.scheduler,"editQueue");
      const removed=await call("task.queue",queue);expect(removed.state).toBe("succeeded");const revision=job.queueRevision;
      expect(await call("task.queue",queue)).toEqual(removed);expect(edit).toHaveBeenCalledTimes(1);expect(job.queueRevision).toBe(revision);expect(job.queuedMessages!.map(item=>item.text)).toEqual(["second"]);
      await expect(call("task.queue",{...queue,input:{...queue.input,action:"down"}})).rejects.toThrow("different operation");
      await web.close();await runtime.close();runtime=await ServerRuntime.open(data,undefined,[workspace]);web=await openHttp(runtime,0,[workspace]);
      expect(await call("task.control",control)).toEqual(first);expect(await call("task.queue",queue)).toEqual(removed);
      expect(runtime.store.data.jobs[0]).toMatchObject({state:"queued",queueRevision:revision});
    }finally{await web.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});}
  });
  it("checks observed state inside serialized controls instead of before a queued mutation",async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-observed-control-"));const runtime=await ServerRuntime.open(path.join(root,"data"));await runtime.scheduler.dispatch(true);
    try {
      const job=await runtime.scheduler.add({title:"Serialized",prompt:"Work",cwd:root,mode:"cli",model:"",effort:"",bucket:"codex",approvalPolicy:"on-request",sandbox:"workspaceWrite",interactive:true}),expected=taskControlSignature(job);
      const first=runtime.scheduler.control(job.id,"pause"),late=runtime.scheduler.controlObserved(job.id,"cancel",expected);
      await first;expect(await late).toEqual({applied:false});expect(job.state).toBe("paused");
      await runtime.scheduler.control(job.id,"resume");const revision=job.controlRevision||0;
      const stop=runtime.scheduler.control(job.id,"cancel"),message=runtime.scheduler.send({id:job.id,text:"An older confirmed repair",attachments:[],action:"queue"},randomUUID(),revision),rejected=expect(message).rejects.toThrow("确认的追问未投递");
      await stop;await rejected;expect(job.state).toBe("cancelled");expect(job.messageReceipts||[]).toHaveLength(0);
    }finally{await runtime.close();await fs.rm(root,{recursive:true,force:true});}
  });
});
