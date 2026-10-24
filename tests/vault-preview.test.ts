import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareVault, assertVaultSource } from "../src/main/vault-preview";
import { verifyDelivery } from "../src/core/delivery";
import { vaultManifestSchema } from "../src/shared/vault";
import type { Job } from "../src/shared/types";
let root:string;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"relay-vault-preview-"));await fs.writeFile(path.join(root,"artifact.txt"),"accepted");});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
async function job(){
  const checks=[{kind:"file" as const,path:"artifact.txt",label:"Artifact",minBytes:1},{kind:"contains" as const,path:"artifact.txt",label:"Content",text:"accepted"}];
  const report=await verifyDelivery(root,checks,{revision:1,source:"manual"});
  return{id:randomUUID(),title:'Preview <task> : / title',prompt:'DO NOT EXPORT THIS PROMPT',cwd:root,state:"completed",accountId:"PRIVATE_ACCOUNT",delivery:{revision:1,checks,reports:[report]}} as Job;
}
it("freezes accepted evidence, groups file conditions and excludes account/prompt/absolute source metadata",async()=>{
  const source=await job(),prepared=await prepareVault([source],1000);
  expect(prepared.view.artifacts).toHaveLength(1);expect(prepared.view.artifacts[0].checks).toEqual([0,1]);expect(prepared.view.totalBytes).toBe(8);
  expect(prepared.view.expiresAt).toBe(301000);expect(prepared.view.artifacts[0].path).not.toMatch(/[<>:]/);
  const text=JSON.stringify(prepared.view);expect(text).not.toContain(root);expect(text).not.toContain("PRIVATE_ACCOUNT");expect(text).not.toContain("DO NOT EXPORT");
  source.title="Changed later";expect(prepared.view.tasks[0].title).not.toBe(source.title);
});
it("preserves an explicitly paused task while capturing its separately passed artifact acceptance",async()=>{
  const source=await job();source.state="paused";source.stopIntent="pause";
  const prepared=await prepareVault([source]);expect(prepared.manifest.tasks[0].stateAtCapture).toBe("paused");expect(source.state).toBe("paused");expect(source.stopIntent).toBe("pause");
});
it("rejects running, stale or mismatched contract evidence",async()=>{
  const source=await job();source.state="running";await expect(prepareVault([source])).rejects.toThrow("停止运行");source.state="completed";
  source.delivery!.staleEvidence={reportId:source.delivery!.reports[0].id,at:Date.now(),reason:"changed"};await expect(prepareVault([source])).rejects.toThrow("停止运行");
  delete source.delivery!.staleEvidence;source.delivery!.checks[0].label="Different contract";await expect(prepareVault([source])).rejects.toThrow("不一致");
});
it("guards the preview against both newer reports and in-place evidence/contract mutations",async()=>{
  const source=await job(),prepared=await prepareVault([source]);expect(()=>assertVaultSource(source,prepared.sources[0])).not.toThrow();
  source.delivery!.reports[0].findings[0].sha256="b".repeat(64);expect(()=>assertVaultSource(source,prepared.sources[0])).toThrow("已更新");
});
it("groups an in-workspace junction alias without duplicating the artifact bytes",async()=>{
  const source=await job();await fs.mkdir(path.join(root,"actual"));await fs.writeFile(path.join(root,"actual/file"),"same");
  await fs.symlink(path.join(root,"actual"),path.join(root,"alias"),process.platform==="win32"?"junction":"dir");
  const checks=[{kind:"file" as const,path:"actual/file",label:"Actual",minBytes:1},{kind:"file" as const,path:"alias/file",label:"Alias",minBytes:1}];
  source.delivery={revision:1,checks,reports:[await verifyDelivery(root,checks,{revision:1,source:"manual"})]};
  const prepared=await prepareVault([source]);expect(prepared.manifest.artifacts).toHaveLength(1);expect(prepared.manifest.totalBytes).toBe(4);
});
it("rejects an unbound source path, missing criterion coverage or duplicate case-insensitive bundle names",async()=>{
  const manifest=(await prepareVault([await job()])).manifest;
  const unbound=structuredClone(manifest);unbound.artifacts[0].relative="other.txt";expect(vaultManifestSchema.safeParse(unbound).success).toBe(false);
  const missing=structuredClone(manifest);missing.artifacts[0].checks=[0];expect(vaultManifestSchema.safeParse(missing).success).toBe(false);
  const duplicate=structuredClone(manifest);duplicate.artifacts.push({...duplicate.artifacts[0],id:randomUUID(),path:duplicate.artifacts[0].path.toUpperCase()});expect(vaultManifestSchema.safeParse(duplicate).success).toBe(false);
});
