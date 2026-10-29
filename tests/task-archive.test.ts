import {afterEach,beforeEach,expect,it} from 'vitest';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Scheduler} from '../src/core/scheduler';
import {Store} from '../src/core/store';
import {bulkArchiveSchema} from '../src/shared/task-archive';
import type {Job} from '../src/shared/types';
let root:string,store:Store,scheduler:Scheduler;
const job=(extra:Partial<Job>={}):Job=>({id:randomUUID(),title:'Archive fixture',prompt:'Synthetic',cwd:root,mode:'cli',state:'completed',model:'',effort:'',bucket:'codex',rotations:0,createdAt:Date.now(),updatedAt:Date.now(),approvalPolicy:'on-request',sandbox:'workspaceWrite',...extra});
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'task-archive-'));store=new Store(root);const worker=()=>{throw Error('Archive operations cannot start a worker');};scheduler=new Scheduler(store,{busy:new Set(),cancelLogin:async()=>{}} as any,{cli:worker,desktop:worker});scheduler.runtimeReady=()=>false;});
afterEach(async()=>{await scheduler.shutdown();await fs.rm(root,{recursive:true,force:true});});
it('persists eligible archive subset and returns revision receipts that survive reload',async()=>{
 const completed=job(),paused=job({state:'paused'}),running=job({state:'running'}),recovery=job({state:'needs_attention',recoveryRequired:true});
 store.data.jobs=[completed,paused,running,recovery];await store.save();
 const result=await scheduler.archiveMany({archived:true,entries:store.data.jobs.map(item=>({id:item.id,expectedArchiveRevision:0}))});
 expect(result.results.map(item=>[item.ok,item.code])).toEqual([[true,undefined],[true,undefined],[false,'active'],[false,'active']]);
 const disk=new Store(root);await disk.load();expect(disk.data.jobs.map(item=>[!!item.archived,item.archiveRevision||0])).toEqual([[true,1],[true,1],[false,0],[false,0]]);
 const undo=await scheduler.archiveMany({archived:false,entries:result.results.filter(item=>item.ok).map(item=>({id:item.id,expectedArchiveRevision:item.revision!}))});
 expect(undo.results.every(item=>item.ok&&item.revision===2)).toBe(true);expect(store.data.jobs[1].state).toBe('paused');
});
it('rejects stale undo after legacy metadata restore and rearchive rather than overwriting newer intent',async()=>{
 const completed=job();store.data.jobs=[completed];await store.save();
 const archived=await scheduler.archiveMany({archived:true,entries:[{id:completed.id,expectedArchiveRevision:0}]});
 const receipt=archived.results[0].revision!;
 await scheduler.metadata(completed.id,{archived:false});await scheduler.metadata(completed.id,{archived:true});
 const undo=await scheduler.archiveMany({archived:false,entries:[{id:completed.id,expectedArchiveRevision:receipt}]});
 expect(undo.results[0]).toMatchObject({ok:false,code:'stale'});expect(completed.archived).toBe(true);expect(completed.archiveRevision).toBe(3);
 const disk=new Store(root);await disk.load();expect(disk.data.jobs[0].archived).toBe(true);
});
it('rolls back every accepted archive value and revision on a real save failure, then permits retry',async()=>{
 const a=job(),b=job({archived:false,archiveRevision:4});store.data.jobs=[a,b];await store.save();
 const before=await fs.readFile(path.join(root,'state.json'),'utf8');await fs.mkdir(path.join(root,'state.previous.json'));
 const input={archived:true,entries:[{id:a.id,expectedArchiveRevision:0},{id:b.id,expectedArchiveRevision:4}]};
 const response=await scheduler.archiveMany(input);expect(response.results.every(item=>!item.ok&&item.code==='save_failed'&&item.revision===undefined)).toBe(true);
 expect(a.archived).toBeUndefined();expect(a.archiveRevision).toBeUndefined();expect(b.archived).toBe(false);expect(b.archiveRevision).toBe(4);
 expect(await fs.readFile(path.join(root,'state.json'),'utf8')).toBe(before);
 await fs.rmdir(path.join(root,'state.previous.json'));expect((await scheduler.archiveMany(input)).results.every(item=>item.ok)).toBe(true);
});
it('serializes archive receipts behind legacy metadata and rejects malformed requests before mutation',async()=>{
 const a=job();store.data.jobs=[a];await store.save();
 const legacy=scheduler.metadata(a.id,{archived:true});
 const stale=scheduler.archiveMany({archived:false,entries:[{id:a.id,expectedArchiveRevision:0}]});
 await legacy;expect((await stale).results[0].code).toBe('stale');
 expect(bulkArchiveSchema.safeParse({archived:true,entries:[]}).success).toBe(false);
 expect(bulkArchiveSchema.safeParse({archived:true,entries:[{id:a.id,expectedArchiveRevision:-1}]}).success).toBe(false);
 expect(bulkArchiveSchema.safeParse({archived:true,entries:[{id:a.id,expectedArchiveRevision:1}],force:true}).success).toBe(false);
});
