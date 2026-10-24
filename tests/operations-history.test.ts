import { beforeAll,afterAll,beforeEach,afterEach,expect,it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { OperationsHistory } from "../src/main/operations-history";
import { operationObservation } from "../src/core/operations-observation";
import type { Job,AppState,Approval } from "../src/shared/types";
let base:string,root:string,worker:string,history:OperationsHistory;
async function removeOwned(dir:string,parent:string,prefix:string){const actual=await fs.realpath(dir);if(path.dirname(actual)!==await fs.realpath(parent)||!path.basename(actual).startsWith(prefix))throw Error("Unsafe operations QA cleanup");await fs.rm(actual,{recursive:true,force:true});}
beforeAll(async()=>{base=await fs.mkdtemp(path.join(os.tmpdir(),"relay-operations-build-"));worker=path.join(base,"worker.cjs");await build({entryPoints:[path.resolve("src/core/operations-worker.ts")],outfile:worker,bundle:true,platform:"node",format:"cjs"});});
afterAll(async()=>{await removeOwned(base,os.tmpdir(),"relay-operations-build-");});
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-operations-test-"));history=new OperationsHistory({root,worker});});
afterEach(async()=>{await history.shutdown();await removeOwned(root,os.tmpdir(),"relay-operations-test-");});
const job=(id="task",state:Job["state"]="queued")=>({id,title:`Title ${id}`,cwd:"D:\\PRIVATE_PROJECT_ROOT\\Project",state,prompt:"PRIVATE PROMPT",rotations:0,queuedMessages:[]} as unknown as Job);
const observe=(jobs:Job[],approvals:Approval[]=[],at=Date.now())=>operationObservation({jobs} as AppState,approvals,{active:new Set(),controls:new Set(),home:id=>id},"win32",at);
it("records rapid real observations, deduplicates unchanged facts and keeps secrets/absolute source paths out of history",async()=>{
  const task=job();expect((await history.start(observe([task]))).phase).toBe("recording");
  task.state="preparing";history.observe(observe([task]));task.state="running";history.observe(observe([task]));history.observe(observe([task]));
  const page=await history.page({taskId:task.id});expect(page.events.map(e=>[e.kind,e.current?.state])).toEqual([["changed","running"],["changed","preparing"],["baseline","queued"]]);
  const secret={id:"request",jobId:task.id,kind:"input",method:"input",params:{secret:"PRIVATE SECRET"}} as Approval;
  history.observe(observe([task],[secret]));const records=await history.page({});const text=JSON.stringify(records);
  expect(text).not.toContain("PRIVATE PROMPT");expect(text).not.toContain("PRIVATE SECRET");expect(text).not.toContain("PRIVATE_PROJECT_ROOT");expect(text).toContain('"id":"request"');
});
it("marks changed facts after downtime as a startup baseline rather than inventing a completion event",async()=>{
  const task=job();await history.start(observe([task],[],1000));task.state="running";history.observe(observe([task],[],1100));await history.shutdown();
  task.state="completed";history=new OperationsHistory({root,worker});await history.start(observe([task],[],5000));
  const events=(await history.page({taskId:task.id})).events;expect(events[0]).toMatchObject({kind:"baseline",at:5000,current:{state:"completed"},previous:{state:"running"}});
  const session=(await history.page({})).events.find(e=>e.kind==="session");expect(session).toMatchObject({at:5000,gap:true,previousAt:1100});
});
it("preserves cursor snapshots during concurrent appends, supports family/project scopes and exact >2^53 sequence IDs",async()=>{
  const task=job();await history.start(observe([task]));
  const db=new DatabaseSync(path.join(root,"operations.sqlite"));const row=db.prepare("SELECT * FROM events WHERE task=? ORDER BY seq DESC LIMIT 1").get(task.id)!;
  db.prepare("INSERT INTO events(seq,at,session,kind,task,family,project,body) VALUES(?,?,?,?,?,?,?,?)").run(9007199254740993n,row.at,row.session,row.kind,row.task,row.family,row.project,row.body);db.close();
  const first=await history.page({taskId:task.id,limit:1});expect(first.events[0].seq).toBe("9007199254740993");expect(first.cursor).toBeDefined();
  task.state="running";history.observe(observe([task]));const older=await history.page({taskId:task.id,limit:1,cursor:first.cursor});expect(older.events.every(e=>BigInt(e.seq)<9007199254740993n)).toBe(true);
  const fresh=await history.page({familyId:task.id,projectKey:observe([task]).facts[0].projectKey});expect(fresh.events[0].seq).toBe("9007199254740994");
  await expect(history.page({taskId:"different",cursor:first.cursor})).rejects.toThrow("filter changed");
});
it("records cleared optional fields and preserves removed-task evidence",async()=>{
  const task=job();task.stopIntent="pause";await history.start(observe([task]));delete task.stopIntent;history.observe(observe([task]));history.observe(observe([]));
  const events=(await history.page({taskId:task.id})).events;expect(events[0]).toMatchObject({kind:"removed",previous:{id:task.id}});expect(events[1].changes).toContain("intent");expect(events[1].current?.intent).toBeUndefined();
});
it("rolls back a failed transaction, reports a recording gap and restarts from a fresh baseline without blind replay",async()=>{
  const task=job();await history.start(observe([task]));
  const db=new DatabaseSync(path.join(root,"operations.sqlite"));db.exec("CREATE TRIGGER reject_changes BEFORE INSERT ON events WHEN NEW.kind='changed' BEGIN SELECT RAISE(ABORT,'simulated full disk'); END;");
  task.state="running";history.observe(observe([task]));await history.drain();expect(history.view()).toMatchObject({phase:"failed",gapSince:expect.any(Number)});
  expect((await history.page({taskId:task.id})).events).toHaveLength(1);expect(JSON.parse(String(db.prepare("SELECT body FROM current WHERE id=?").get(task.id)!.body)).state).toBe("queued");
  db.exec("DROP TRIGGER reject_changes");db.close();await history.start(observe([task]));expect(history.view().phase).toBe("recording");
  const events=(await history.page({taskId:task.id})).events;expect(events[0].kind).toBe("baseline");expect(events[0].current?.state).toBe("running");expect(events.every(e=>e.kind!=="changed")).toBe(true);
});
it("fails visibly on bounded-memory pressure and preserves the last durable page",async()=>{
  history=new OperationsHistory({root,worker,maxPendingBytes:100});const task=job();await history.start(observe([task]));task.state="running";history.observe(observe([task]));await history.drain();
  expect(history.view().phase).toBe("failed");expect((await history.page({taskId:task.id})).events[0].current?.state).toBe("queued");
});
it("recovers from an actual terminated worker without waiting for a reply from the dead thread",async()=>{
  const task=job();await history.start(observe([task]));
  const owned=(history as unknown as {worker:import("node:worker_threads").Worker}).worker;
  await owned.terminate();expect(history.view().phase).toBe("failed");
  await expect(history.page({taskId:task.id})).rejects.toThrow("尚未就绪");
  task.state="paused";task.stopIntent="pause";
  expect((await history.start(observe([task]))).phase).toBe("recording");
  const events=(await history.page({taskId:task.id})).events;
  expect(events[0]).toMatchObject({kind:"baseline",current:{state:"paused",intent:"pause"}});
  expect(events.some(e=>e.current?.state==="queued")).toBe(true);
});
it("preserves corrupt or unrelated database files without replacing them",async()=>{
  const file=path.join(root,"operations.sqlite");await fs.writeFile(file,"not a sqlite database");expect((await history.start(observe([]))).phase).toBe("failed");expect(await fs.readFile(file,"utf8")).toBe("not a sqlite database");
});
it("retains and paginates thousands of events without silently trimming older records",async()=>{
  const task=job();await history.start(observe([task]));for(let i=0;i<1200;i++){task.rotations=i+1;history.observe(observe([task]));}
  await history.drain();expect(history.view().phase).toBe("recording");let page=await history.page({taskId:task.id,limit:100}),count=page.events.length;
  while(page.cursor){page=await history.page({taskId:task.id,limit:100,cursor:page.cursor});count+=page.events.length;}
  expect(count).toBe(1201);expect(page.events.at(-1)?.kind).toBe("baseline");
},30000);
