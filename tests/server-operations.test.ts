import {describe,it,expect} from "vitest";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {ServerRuntime} from "../src/server/runtime";
import {openHttp} from "../src/server/http";
describe.skipIf(process.platform!=="linux")("remote operations integration",()=>{
 it("persists settings/templates and exposes search/export/organization through authenticated HTTP",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-operations-")),workspace=path.join(root,"workspace");await fs.mkdir(workspace);
  const runtime=await ServerRuntime.open(path.join(root,"data"));await runtime.scheduler.dispatch(true);const web=await openHttp(runtime,0,[workspace]);
  try{
   const base=`http://127.0.0.1:${(web.server.address() as any).port}`,token=await fs.readFile(path.join(runtime.store.root,"http-token"),"utf8");
   const call=async(name:string,args?:unknown)=>{const r=await fetch(base+"/api/command",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({name,args})});const data=await r.json();if(!r.ok)throw Error(data.error);return data.result;};
   const job=await call("job.submit",{requestId:randomUUID(),input:{title:"Integration",prompt:"Find the evidence",cwd:workspace,mode:"cli",model:"",effort:"",bucket:"codex",approvalPolicy:"on-request",sandbox:"workspaceWrite",interactive:true}});
   await call("settings.save",{...runtime.store.data.settings,retrySeconds:180});
   const templates=await call("templates.save",{revision:0,template:{name:"Review",prompt:"Check evidence",model:"",effort:"",planMode:true,multiAgent:false}});expect(templates.items).toHaveLength(1);
   await expect(call("templates.save",{revision:0,template:templates.items[0]})).rejects.toThrow();
   await call("chat.priority",{id:job.id,priority:"high"});
   expect((await call("chat.search",{id:job.id,query:"evidence"})).total).toBe(1);
   expect((await call("chat.export",job.id)).markdown).toContain("Find the evidence");
   expect((await call("jobs.control",{ids:[job.id],action:"pause"})).results[0].ok).toBe(true);
   await call("job.metadata",{id:job.id,title:"Reviewed",pinned:true,archived:true});
   const saved=JSON.parse(await fs.readFile(path.join(runtime.store.root,"state.json"),"utf8"));
   expect(saved.settings.retrySeconds).toBe(180);expect(saved.jobs[0]).toMatchObject({title:"Reviewed",archived:true,priority:"high"});
   expect((await call("health")).tasks.total).toBe(1);
  }finally{await web.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});}
 });
});
