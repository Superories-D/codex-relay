import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Vaults } from "../src/main/vault";
import { VaultFileError } from "../src/main/vault-file";
import { verifyDelivery } from "../src/core/delivery";
import { atomicWrite } from "../src/core/store";
import { VaultStore } from "../src/main/vault-store";
import type { Job } from "../src/shared/types";
let root:string, source:Job, vault:Vaults, failures:unknown[];
const scripts=path.resolve("scripts/windows"), invalidate=vi.fn(async()=>{});
beforeEach(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-vault-coordinator-"));
  const cwd=path.join(root,"project");await fs.mkdir(cwd);await fs.writeFile(path.join(cwd,"产物.txt"),"accepted");
  const checks=[{kind:"file" as const,path:"产物.txt",label:"Artifact",minBytes:1}];
  source={id:randomUUID(),title:"<img src=x onerror=alert(1)>",cwd,state:"paused",stopIntent:"pause",delivery:{revision:1,checks,reports:[await verifyDelivery(cwd,checks,{revision:1,source:"manual"})]}} as Job;
  failures=[];invalidate.mockClear();vault=new Vaults({root,scripts,target:()=>structuredClone(source),invalidate,report:error=>failures.push(error)});
});
afterEach(async()=>{await vault.shutdown();await fs.rm(root,{recursive:true,force:true});});
async function capture(){const preview=await vault.preview([source.id]);const entry=await vault.capture({previewId:preview.id,title:"Delivery <script>"});await vault.drain();return (await vault.list()).entries.find(e=>e.id===entry.id)!;}
it("seals independent actual bytes and provenance without changing pause intent, even after task/workspace deletion",async()=>{
  const entry=await capture();expect(entry.status).toBe("ready");expect(entry.metadata).toHaveLength(5);expect(source.state).toBe("paused");expect(source.stopIntent).toBe("pause");
  const detail=await vault.detail(entry.id),folder=await vault.openDirectory(entry.id);expect(detail.manifest.tasks[0].stateAtCapture).toBe("paused");
  const html=await fs.readFile(path.join(folder,"index.html"),"utf8");expect(html).toContain("&lt;img");expect(html).not.toContain("<img");expect(html).toContain("已暂停");
  await fs.unlink(path.join(source.cwd,"产物.txt"));source={} as Job;
  await vault.verify(entry.id);await vault.drain();expect((await vault.list()).entries[0].verification?.status).toBe("passed");
  expect(await fs.readFile(path.join(folder,detail.manifest.artifacts[0].path),"utf8")).toBe("accepted");expect(invalidate).not.toHaveBeenCalled();
});
it("consumes a preview once and rejects changed acceptance before reserving any version",async()=>{
  const preview=await vault.preview([source.id]);source.delivery!.revision++;
  await expect(vault.capture({previewId:preview.id,title:"Changed"})).rejects.toThrow("已更新");expect((await vault.list()).entries).toHaveLength(0);
  source.delivery!.revision--;await vault.capture({previewId:preview.id,title:"Once"});await vault.drain();
  await expect(vault.capture({previewId:preview.id,title:"Twice"})).rejects.toThrow("过期");
});
it("invalidates changed source evidence but preserves acceptance on destination failure",async()=>{
  const preview=await vault.preview([source.id]);await fs.writeFile(path.join(source.cwd,"产物.txt"),"tampered");await vault.capture({previewId:preview.id,title:"Changed"});await vault.drain();
  expect((await vault.list()).entries[0].status).toBe("failed");expect(invalidate).toHaveBeenCalledWith(source.id,1,source.delivery!.reports[0].id,"changed");
  invalidate.mockClear();await vault.shutdown();vault=new Vaults({root,scripts,target:()=>source,invalidate,copy:async()=>{throw new VaultFileError("destinationError");}});
  await capture();expect((await vault.list()).entries.every(e=>e.status==="failed")).toBe(true);expect(invalidate).not.toHaveBeenCalled();
});
it("joins cancellation and removes partial owned staging without accepting partial bytes",async()=>{
  await vault.shutdown();let started!:()=>void;const waiting=new Promise<void>(r=>{started=r;});
  vault=new Vaults({root,scripts,target:()=>source,invalidate,copy:async options=>{started();return new Promise<never>((_,reject)=>options.signal!.addEventListener("abort",()=>reject(new VaultFileError("cancelled")),{once:true}));}});
  const preview=await vault.preview([source.id]);await vault.capture({previewId:preview.id,title:"Cancel"});await waiting;
  const active=(await vault.list()).active!;await vault.cancel(active.id);const entry=(await vault.list()).entries[0];
  expect(entry.status).toBe("cancelled");expect(await fs.readdir(path.join(entry.root,"staging"))).toEqual([]);expect(invalidate).not.toHaveBeenCalled();
});
it("detects artifact and metadata tampering and can verify after repair without relying on source jobs",async()=>{
  const entry=await capture(),detail=await vault.detail(entry.id),folder=await vault.openDirectory(entry.id),artifact=path.join(folder,detail.manifest.artifacts[0].path);
  await fs.writeFile(artifact,"changed!");await fs.appendFile(path.join(folder,"index.html"),"changed");await vault.verify(entry.id);await vault.drain();
  expect((await vault.list()).entries[0].verification).toMatchObject({status:"failed",changed:expect.arrayContaining(["index.html",detail.manifest.artifacts[0].path])});
  await fs.appendFile(path.join(folder,"manifest.json")," ");await expect(vault.detail(entry.id)).rejects.toThrow();
});
it("recovers a published version after the final catalog write fails, by rehashing every stored file",async()=>{
  await vault.shutdown();let fail=true;
  vault=new Vaults({root,scripts,target:()=>source,invalidate,write:async(file,value)=>{const data=JSON.parse(value.toString());if(fail&&data.entries.some((e:any)=>e.status==="ready")){fail=false;throw Error("disk full");}await atomicWrite(file,value);}});
  const entry=await capture();expect(entry.status).toBe("copying");expect((await vault.list()).issue).toBeTruthy();await vault.shutdown();
  vault=new Vaults({root,scripts,target:()=>{throw Error("task gone");},invalidate});expect((await vault.list()).entries[0].status).toBe("interrupted");
  await vault.verify(entry.id);await vault.drain();expect((await vault.list()).entries[0]).toMatchObject({status:"ready",verification:{status:"passed"}});
});
it("keeps existing snapshots accessible when the default storage changes",async()=>{
  const first=await capture();await fs.mkdir(path.join(root,"disk2"));await vault.setStorage(path.join(root,"disk2"));const second=await capture();
  expect(first.root).not.toBe(second.root);await vault.verify(first.id);await vault.drain();expect((await vault.detail(first.id)).entry.verification?.status).toBe("passed");
  await vault.remove(second.id);expect((await vault.list()).entries.map(e=>e.id)).toEqual([first.id]);
});
it.skipIf(process.platform!=="win32")("exports independent complete bytes and preserves a prior export after vault tampering",async()=>{
  const entry=await capture(),detail=await vault.detail(entry.id),destination=path.join(root,"complete.zip");await fs.unlink(path.join(source.cwd,"产物.txt"));
  await vault.export(entry.id,destination);await vault.drain();expect(failures).toEqual([]);const before=await fs.readFile(destination),receipt=(await vault.list()).entries[0].lastExport;
  expect(receipt).toMatchObject({path:destination,files:6});expect((await vault.list()).entries[0].exportIssue).toBeUndefined();
  const folder=await vault.openDirectory(entry.id);await fs.writeFile(path.join(folder,detail.manifest.artifacts[0].path),"tampered");
  await vault.export(entry.id,destination);await vault.drain();expect(await fs.readFile(destination)).toEqual(before);
  expect((await vault.list()).entries[0].lastExport).toEqual(receipt);expect((await vault.list()).entries[0].exportIssue).toBeTruthy();
  const alias=path.join(root,"vault-alias");await fs.symlink(entry.root,alias,"junction");await expect(vault.export(entry.id,path.join(alias,"other.zip"))).rejects.toThrow("保险库目录之外");
},15000);
it.skipIf(process.platform!=="win32")("reconciles a published ZIP after restart when its receipt write failed, without exporting again",async()=>{
  const entry=await capture();await vault.shutdown();let fail=true;
  vault=new Vaults({root,scripts,target:()=>source,invalidate,write:async(file,value)=>{const state=JSON.parse(value.toString());if(fail&&state.entries.some((e:any)=>e.lastExport)){fail=false;throw Error("disk failure");}await atomicWrite(file,value);}});
  const destination=path.join(root,"recovered.zip");await vault.export(entry.id,destination);await vault.drain();expect((await fs.stat(destination)).size).toBeGreaterThan(0);expect((await vault.list()).issue).toBeTruthy();await vault.shutdown();
  vault=new Vaults({root,scripts,target:()=>{throw Error("task deleted");},invalidate});expect((await vault.list()).entries[0].exportAttempt?.state).toBe("interrupted");
  await expect(vault.export(entry.id,destination)).rejects.toThrow("先核对");await vault.recoverExport(entry.id);await vault.drain();
  const restored=(await vault.list()).entries[0];expect(restored.lastExport?.path).toBe(destination);expect(restored.exportAttempt).toBeUndefined();expect(restored.exportIssue).toBeUndefined();
},15000);
it("retains a replaced temporary file after a crash, then permits cleanup and an explicit new export",async()=>{
  const entry=await capture();await vault.shutdown();
  const partial=path.join(root,`.relay-vault-${randomUUID()}.partial`),request=path.join(root,`vault-export-${randomUUID()}.json`);await fs.writeFile(partial,"incomplete");await fs.writeFile(request,"request");
  const p=await fs.stat(partial,{bigint:true}),r=await fs.stat(request,{bigint:true});
  await new VaultStore({root}).patch(entry.id,{exportAttempt:{at:Date.now(),state:"packing",destination:path.join(root,"interrupted.zip"),temporary:{partial:{path:partial,dev:String(p.dev),ino:String(p.ino)},request:{path:request,dev:String(r.dev),ino:String(r.ino)}}}});
  await fs.rename(partial,path.join(root,"original"));await fs.writeFile(partial,"unrelated");vault=new Vaults({root,scripts,target:()=>source,invalidate});
  await vault.recoverExport(entry.id);await vault.drain();expect(await fs.readFile(partial,"utf8")).toBe("unrelated");expect((await vault.list()).entries[0].exportIssue).toContain("归属无法确认");expect((await vault.list()).entries[0].exportAttempt).toBeDefined();
  await fs.unlink(partial);await vault.recoverExport(entry.id);await vault.drain();const restored=(await vault.list()).entries[0];expect(restored.exportAttempt).toBeUndefined();expect(restored.lastExport).toBeUndefined();expect(restored.exportIssue).toContain("请重新导出");await expect(fs.stat(request)).rejects.toThrow();
});
it.skipIf(process.platform!=="win32")("runs the shipped offline Windows verifier with Unicode files and a trusted manifest, and rejects tampering",async()=>{
  const entry=await capture(),folder=await vault.openDirectory(entry.id),run=promisify(execFile);
  const result=await run("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",path.join(folder,"Verify.ps1"),"-ExpectedManifestSha256",entry.manifestSha256!],{windowsHide:true});
  expect(JSON.parse(result.stdout)).toMatchObject({passed:true,comparedTrustedManifest:true,files:1,bytes:8});
  const manifest=(await vault.detail(entry.id)).manifest;await fs.writeFile(path.join(folder,manifest.artifacts[0].path),"tampered");
  await expect(run("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",path.join(folder,"Verify.ps1")],{windowsHide:true})).rejects.toMatchObject({code:2,stdout:expect.stringContaining('"passed":  false')});
},15000);
