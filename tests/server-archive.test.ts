import {expect,it} from 'vitest';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ServerRuntime} from '../src/server/runtime';
import {openHttp} from '../src/server/http';
import {Store} from '../src/core/store';
it('authenticates bulk archive, persists receipts and rejects stale restore through real HTTP',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-http-archive-')),workspace=path.join(root,'workspace');await fs.mkdir(workspace);
 const runtime=await ServerRuntime.open(path.join(root,'data'));await runtime.scheduler.dispatch(true);const web=await openHttp(runtime,0,[workspace]);
 try{
  const base=`http://127.0.0.1:${(web.server.address() as any).port}`,token=await fs.readFile(path.join(runtime.store.root,'http-token'),'utf8');
  const request=(name:string,args:unknown,auth=true)=>fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({name,args})});
  const result=await runtime.scheduler.add({title:'Archive task',prompt:'Synthetic',cwd:workspace,mode:'cli',model:'',effort:'',bucket:'codex',approvalPolicy:'on-request',sandbox:'workspaceWrite'});
  await runtime.scheduler.control(result.id,'pause');
  const input={archived:true,entries:[{id:result.id,expectedArchiveRevision:0}]};
  expect((await request('jobs.archive',input,false)).status).toBe(401);
  expect((await request('jobs.archive',{archived:true,entries:[]})).status).toBeGreaterThanOrEqual(400);
  const archived=await request('jobs.archive',input);expect(archived.status).toBe(200);expect((await archived.json()).result.results[0]).toMatchObject({ok:true,revision:1});
  const stale=await request('jobs.archive',{archived:false,entries:[{id:result.id,expectedArchiveRevision:0}]});expect((await stale.json()).result.results[0]).toMatchObject({ok:false,code:'stale'});
  const disk=new Store(runtime.store.root);await disk.load();expect(disk.data.jobs[0].archived).toBe(true);
 }finally{await web.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});}
});
