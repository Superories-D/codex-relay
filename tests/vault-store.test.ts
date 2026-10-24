import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { VaultStore } from "../src/main/vault-store";
import { atomicWrite } from "../src/core/store";
import type { VaultEntry } from "../src/shared/vault";
let root: string;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-vault-store-"));});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
const entry=(storage:string):VaultEntry=>({id:randomUUID(),title:"Delivery",root:storage,createdAt:Date.now(),status:"copying",totalBytes:8,artifactCount:1});
it.skipIf(process.platform!=="win32")("retries transient Windows catalog sharing errors without claiming a failed durable write succeeded",async()=>{
  let locked=false,attempts=0;const store=new VaultStore({root,write:async(file,value)=>{if(locked&&attempts++<2)throw Object.assign(Error("sharing violation"),{code:"EPERM"});await atomicWrite(file,value);}});
  const storage=await store.currentStorage(),item=entry(storage);locked=true;await store.mutate(v=>v.entries.push(item));
  expect(attempts).toBe(3);expect((await store.list()).issue).toBeUndefined();expect((await new VaultStore({root}).list()).entries[0].id).toBe(item.id);
});
it("initializes one durable owner across concurrent readers and claims private storage",async()=>{
  const store=new VaultStore({root});const views=await Promise.all([store.list(),store.list(),store.list()]);
  expect(new Set(views.map(v=>v.owner)).size).toBe(1);
  const storage=await store.currentStorage(),marker=JSON.parse(await fs.readFile(path.join(storage,".codex-relay-vault.json"),"utf8"));
  expect(marker.owner).toBe(views[0].owner);expect((await store.list()).roots).toEqual([storage]);
});
it("changes the default location without moving or forgetting existing versions",async()=>{
  const store=new VaultStore({root}),old=await store.currentStorage(),item=entry(old);await store.mutate(v=>v.entries.push(item));
  const destination=path.join(root,"another-drive");await fs.mkdir(destination);const updated=await store.setStorage(destination);
  expect(updated.storage).not.toBe(old);expect(updated.roots).toContain(old);expect(updated.entries[0].root).toBe(old);
  expect((await new VaultStore({root}).list()).entries[0].root).toBe(old);
});
it("does not claim or overwrite a preexisting directory containing other data",async()=>{
  const destination=path.join(root,"existing","Codex Relay Deliveries");await fs.mkdir(destination,{recursive:true});await fs.writeFile(path.join(destination,"user.txt"),"keep");
  let protectedCalls=0;const store=new VaultStore({root,protect:async()=>{protectedCalls++;}});
  await expect(store.setStorage(path.dirname(destination))).rejects.toThrow("选择其他位置");
  expect(protectedCalls).toBe(0);expect(await fs.readFile(path.join(destination,"user.txt"),"utf8")).toBe("keep");
});
it("publishes only its marked staging directory and never replaces an existing version",async()=>{
  const store=new VaultStore({root}),storage=await store.currentStorage(),item=entry(storage);await store.mutate(v=>v.entries.push(item));
  const stage=await store.makeStage(item);await fs.writeFile(path.join(stage,"artifact"),"original");const final=await store.publish(item);
  expect(await fs.readFile(path.join(final,"artifact"),"utf8")).toBe("original");
  const another=await store.makeStage(item);await fs.writeFile(path.join(another,"artifact"),"different");
  await expect(store.publish(item)).rejects.toThrow("已存在");await store.removeFiles(item,true);
  expect(await fs.readFile(path.join(final,"artifact"),"utf8")).toBe("original");
});
it("refuses recursive deletion through a replaced staging junction",async()=>{
  const store=new VaultStore({root}),storage=await store.currentStorage(),item=entry(storage),stage=await store.makeStage(item);
  await store.removeFiles(item,true);const outside=path.join(root,"outside");await fs.mkdir(outside);await fs.writeFile(path.join(outside,"keep.txt"),"keep");
  await fs.symlink(outside,stage,process.platform==="win32"?"junction":"dir");
  await expect(store.removeFiles(item,true)).rejects.toThrow("目录已更改");expect(await fs.readFile(path.join(outside,"keep.txt"),"utf8")).toBe("keep");
});
it("marks unfinished writes interrupted after restart instead of claiming a ready snapshot",async()=>{
  const store=new VaultStore({root}),storage=await store.currentStorage(),item=entry(storage);await store.mutate(v=>v.entries.push(item));
  const restored=await new VaultStore({root}).list();expect(restored.entries[0]).toMatchObject({id:item.id,status:"interrupted"});
});
it("retains committed metadata when a subsequent catalog write fails",async()=>{
  let fail=false;const store=new VaultStore({root,write:async(file,value)=>{if(fail)throw Error("disk full");await atomicWrite(file,value);}});
  const storage=await store.currentStorage(),item=entry(storage);await store.mutate(v=>v.entries.push(item));const before=await store.list();fail=true;
  await expect(store.patch(item.id,{status:"cancelled"})).rejects.toThrow("无法保存");
  expect((await store.list()).entries).toEqual(before.entries);expect((await store.list()).issue).toBeTruthy();
  expect((await new VaultStore({root}).list()).entries[0].status).toBe("interrupted");
});
it("preserves corrupt catalogs and rejects filesystem operations with a non-UUID identity",async()=>{
  const file=path.join(root,"delivery-vault.json");await fs.writeFile(file,"corrupt");await expect(new VaultStore({root}).list()).rejects.toThrow("原文件未被覆盖");expect(await fs.readFile(file,"utf8")).toBe("corrupt");
  await fs.unlink(file);const store=new VaultStore({root}),storage=await store.currentStorage();
  await expect(store.makeStage({...entry(storage),id:"../../outside"})).rejects.toThrow();await expect(fs.stat(path.join(storage,"outside"))).rejects.toThrow();
});
