import { beforeEach, afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { exportVaultArchive, cleanupVaultExport } from "../src/main/vault-archive";
import { randomUUID } from "node:crypto";
import { sha256 } from "../src/main/vault-bundle";
let root:string;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-vault-archive-"));await fs.mkdir(path.join(root,"bundle"));await fs.writeFile(path.join(root,"bundle","产物.txt"),"accepted");});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
const options=()=>({directory:path.join(root,"bundle"),destination:path.join(root,"交付.zip"),requestRoot:root,script:path.resolve("scripts/windows/vault-archive.ps1"),
  files:[{path:"产物.txt",bytes:8,sha256:sha256("accepted")}],signal:new AbortController().signal,progress:()=>{},publishing:()=>{}});
it("cleans interrupted temporary files only after checking exact parent, generated name and original file identity",async()=>{
  const partial=path.join(root,`.relay-vault-${randomUUID()}.partial`),request=path.join(root,`vault-export-${randomUUID()}.json`);
  await fs.writeFile(partial,"partial bytes");await fs.writeFile(request,"request");const p=await fs.stat(partial,{bigint:true}),r=await fs.stat(request,{bigint:true});
  const temporary={partial:{path:partial,dev:String(p.dev),ino:String(p.ino)},request:{path:request,dev:String(r.dev),ino:String(r.ino)}};
  await fs.rename(partial,path.join(root,"original-owned-partial"));await fs.writeFile(partial,"unrelated replacement");
  await expect(cleanupVaultExport(temporary,path.join(root,"complete.zip"),root)).rejects.toThrow("归属");expect(await fs.readFile(partial,"utf8")).toBe("unrelated replacement");
  await fs.unlink(partial);await fs.rename(path.join(root,"original-owned-partial"),partial);await cleanupVaultExport(temporary,path.join(root,"complete.zip"),root);
  await expect(fs.stat(partial)).rejects.toThrow();await expect(fs.stat(request)).rejects.toThrow();
});
it.skipIf(process.platform!=="win32")("creates complete Unicode ZIP, verifies decompressed entries and hash, and excludes unlisted files",async()=>{
  await fs.writeFile(path.join(root,"bundle","private.txt"),"not included");const phases=new Set<string>();let published=0;
  const result=await exportVaultArchive({...options(),progress:p=>{phases.add(p.phase);},publishing:()=>{published++;}});
  expect(published).toBe(1);expect(phases).toEqual(new Set(["packing","checkingArchive"]));expect(result.files).toBe(1);
  const zip=await fs.readFile(result.path);expect(zip.length).toBe(result.bytes);expect(sha256(zip)).toBe(result.sha256);
  expect(zip.includes(Buffer.from("产物.txt"))).toBe(true);expect(zip.includes(Buffer.from("private.txt"))).toBe(false);
  expect((await fs.readdir(root)).sort()).toEqual(["bundle","交付.zip"]);
},15000);
it.skipIf(process.platform!=="win32")("does not overwrite an existing archive or leak partial files when source verification fails",async()=>{
  const o=options();await fs.writeFile(o.destination,"keep prior export");await fs.writeFile(path.join(o.directory,"产物.txt"),"tampered");
  await expect(exportVaultArchive(o)).rejects.toThrow();expect(await fs.readFile(o.destination,"utf8")).toBe("keep prior export");
  expect((await fs.readdir(root)).filter(p=>p.endsWith(".partial")||p.endsWith(".json"))).toEqual([]);
},15000);
it.skipIf(process.platform!=="win32")("joins cancellation, preserves existing output, and refuses an archive destination inside its source",async()=>{
  const o=options(),controller=new AbortController();await fs.writeFile(o.destination,"keep");
  await expect(exportVaultArchive({...o,signal:controller.signal,progress:()=>controller.abort()})).rejects.toThrow("取消");
  expect(await fs.readFile(o.destination,"utf8")).toBe("keep");expect((await fs.readdir(root)).filter(p=>p.endsWith(".partial")||p.endsWith(".json"))).toEqual([]);
  await expect(exportVaultArchive({...options(),destination:path.join(o.directory,"output.zip")})).rejects.toThrow("目录之外");
},15000);
it.skipIf(process.platform!=="win32")("refuses publication if the destination changed while packing",async()=>{
  const o=options();let changed=false;
  await expect(exportVaultArchive({...o,progress:()=>{if(!changed){changed=true;void fs.writeFile(o.destination,"new unrelated data");}}})).rejects.toThrow("发生变化");
  expect(await fs.readFile(o.destination,"utf8")).toBe("new unrelated data");
},15000);
