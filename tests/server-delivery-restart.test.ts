import {it, expect, vi} from "vitest";
import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import {ServerRuntime} from "../src/server/runtime";

it.skipIf(process.platform !== "linux").each([false,true])("interrupts in-flight file checks before draining commands; restart respects manual pause=%s", async paused => {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),"relay-delivery-restart-"));
  const workspace=path.join(base,"project"),root=path.join(base,"data"),artifact=path.join(workspace,"report.bin");
  await fs.mkdir(workspace);await fs.writeFile(artifact,"");await fs.truncate(artifact,4*1024*1024);
  let runtime=await ServerRuntime.open(root,undefined,[workspace]);
  let release!:()=>void,entered!:()=>void,reads=0;
  const held=new Promise<void>(resolve=>release=resolve),reading=new Promise<void>(resolve=>entered=resolve);
  const open=fs.open.bind(fs);
  const spy=vi.spyOn(fs,"open").mockImplementation(async(...args)=>{
    const handle=await open(...args);
    if(String(args[0])===artifact){
      const read=handle.read.bind(handle);
      handle.read=(async(...values:any[])=>{
        reads++;const result=await (read as any)(...values);
        if(reads===1){entered();await held;}
        return result;
      }) as typeof handle.read;
    }
    return handle;
  });
  try {
    await runtime.scheduler.dispatch(true);
    const job=await runtime.scheduler.add({title:"Restart during file verification",prompt:"No model call",cwd:workspace,mode:"cli",model:"",effort:"",bucket:"codex",approvalPolicy:"on-request",sandbox:"workspaceWrite",deliveryChecks:[{kind:"file",path:"report.bin",label:"Binary output",minBytes:1}]});
    job.state=paused?"paused":"completed";job.stopIntent=paused?"pause":undefined;await runtime.store.save();
    const args={requestId:randomUUID(),id:job.id,revision:1};
    const verification=runtime.command("delivery.run",args);
    await reading;
    const closing=runtime.close();release();
    const [receipt]:any[]=await Promise.all([verification,closing]);
    expect(reads).toBe(1);
    expect(receipt).toMatchObject({state:"succeeded",result:{reports:[{status:"unverified",findings:[{code:"cancelled"}]}]}});
    expect(job.delivery!.pendingCompletion).toBe(!paused);
    spy.mockRestore();
    runtime=await ServerRuntime.open(root,undefined,[workspace]);
    const restored=runtime.store.data.jobs.find(j=>j.id===job.id)!;
    const errors:unknown[]=[];runtime.start(error=>errors.push(error));
    if(!paused){
      const until=Date.now()+5000;
      while(restored.delivery!.pendingCompletion && Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
      expect(restored.delivery).toMatchObject({pendingCompletion:false,reports:[{status:"unverified"},{source:"recovery",status:"passed"}]});
      expect(restored.state).toBe("completed");
    }else{
      expect(restored).toMatchObject({state:"paused",stopIntent:"pause",delivery:{pendingCompletion:false}});
      expect(restored.delivery!.reports).toHaveLength(1);
    }
    expect(await runtime.command("delivery.run",args)).toEqual(receipt);
    expect(restored.delivery!.reports).toHaveLength(paused?1:2);
    expect(errors).toEqual([]);
  } finally {
    release();spy.mockRestore();await runtime.close();await fs.rm(base,{recursive:true,force:true});
  }
});
