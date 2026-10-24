import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "../src/core/store";
import { verifyDelivery } from "../src/core/delivery";
import { deliveryAccepted } from "../src/shared/delivery";
import { compareDeliveryEvidence } from "../src/shared/delivery-center";
import { DeliveryPlans } from "../src/main/delivery-plans";
import { DeliveryBatches } from "../src/main/delivery-batches";
import type { Job } from "../src/shared/types";
const roots: string[] = [], managers: DeliveryBatches[] = [];
async function folder() {const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-delivery-center-")); roots.push(root); return root;}
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.shutdown()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive: true, force: true})));
});
const checks = [{kind: "file" as const, label: "Artifact", path: "artifact.txt", minBytes: 1}];
async function target(root: string) {
  await fs.writeFile(path.join(root, "artifact.txt"), "original");
  const report = await verifyDelivery(root, checks, {revision: 1, source: "manual"});
  return {id: randomUUID(), title: "Delivery", cwd: root, state: "completed",
    delivery: {checks, revision: 1, reports: [report]}} as Job;
}
function fixture(root: string, jobs: Job[], options: any = {}) {
  const invalidations: any[] = [], verified: string[] = [];
  const manager = new DeliveryBatches({root,
    target: id => {const job = jobs.find(j => j.id === id); if (!job) throw Error("missing"); return structuredClone(job);},
    invalidate: async (id, revision, reportId, reason) => {
      invalidations.push({id, revision, reportId, reason});
      const job = jobs.find(j => j.id === id)!;
      job.delivery!.staleEvidence = {reportId, at: Date.now(), reason};
    },
    verify: async (id, signal, expected) => {
      verified.push(id); const job = jobs.find(j => j.id === id)!;
      expect(job.delivery!.revision).toBe(expected.revision); expect(job.delivery!.reports.at(-1)?.id).toBe(expected.reportId);
      const report = await verifyDelivery(job.cwd, job.delivery!.checks, {revision: expected.revision, source: "manual", signal});
      job.delivery!.reports.push(report); delete job.delivery!.staleEvidence; return structuredClone(job.delivery!);
    }, ...options,
  }); managers.push(manager); return {manager, invalidations, verified};
}
it("stores reusable acceptance plans with revision ownership, defensive copies and write rollback", async () => {
  const root = await folder(); let fail = false;
  const plans = new DeliveryPlans(root, async (file, value) => {if (fail) throw Error("disk full"); await atomicWrite(file, value);});
  const saved = await plans.save({revision: 0, plan: {name: "Artifacts", description: "Full checks", checks}});
  saved.items[0].checks[0].path = "changed.txt";
  expect((await plans.list()).items[0].checks[0].path).toBe("artifact.txt");
  const id = saved.items[0].id;
  await expect(plans.save({revision: 0, id, plan: {name: "Old", description: "", checks}})).rejects.toThrow("刷新");
  fail = true; await expect(plans.remove({revision: 1, id})).rejects.toThrow("disk full");
  expect((await plans.list()).revision).toBe(1);
  expect((await new DeliveryPlans(root).list()).items[0].id).toBe(id);
});
it("does not overwrite a corrupt plan library and rejects escaping paths", async () => {
  const root = await folder(), file = path.join(root, "delivery-plans.json"); await fs.writeFile(file, "corrupt");
  await expect(new DeliveryPlans(root).list()).rejects.toThrow("原文件未被覆盖"); expect(await fs.readFile(file, "utf8")).toBe("corrupt");
  expect(() => new DeliveryPlans(root).save({revision: 0, plan: {name: "Unsafe", description: "", checks: [{...checks[0], path: "../outside"}]}})).toThrow();
});
it("compares full file fingerprints rather than equating a passing size rule with unchanged evidence", async () => {
  const root = await folder(), job = await target(root), baseline = job.delivery!.reports[0];
  const unchanged = await verifyDelivery(root, checks, {revision: 1, source: "manual"});
  expect(compareDeliveryEvidence(baseline, unchanged).status).toBe("current");
  await fs.writeFile(path.join(root, "artifact.txt"), "modified");
  const modified = await verifyDelivery(root, checks, {revision: 1, source: "manual"}); expect(modified.status).toBe("passed");
  expect(compareDeliveryEvidence(baseline, modified)).toEqual({status: "changed", changedPaths: ["artifact.txt"]});
  job.delivery!.staleEvidence = {reportId: baseline.id, at: Date.now(), reason: "changed"}; expect(deliveryAccepted(job.delivery)).toBe(false);
  expect(compareDeliveryEvidence(undefined, modified).status).toBe("noBaseline");
});
it("persists a detected change, invalidates only the matching baseline and does not accept a new artifact implicitly", async () => {
  const root = await folder(), job = await target(root); await fs.writeFile(path.join(root, "artifact.txt"), "modified");
  const {manager, invalidations, verified} = fixture(root, [job]);
  const batch = await manager.start({mode: "inspect", targets: [{id: job.id, revision: 1}]}); await manager.drain();
  const item = (await manager.list()).batches[0].items[0];
  expect(item).toMatchObject({status: "failed", comparison: {status: "changed"}, report: {status: "passed"}});
  expect(invalidations).toHaveLength(1); expect(verified).toHaveLength(0); expect(deliveryAccepted(job.delivery)).toBe(false);
  const exported = await manager.export(batch.id); expect(exported.batch.items[0].report?.findings[0].sha256).toHaveLength(64);
  await manager.shutdown(); const restored = fixture(root, [job]).manager; expect((await restored.list()).batches[0].items[0].status).toBe("failed");
});
it("explicit verification delegates acceptance with revision guards and creates new evidence", async () => {
  const root = await folder(), job = await target(root); await fs.writeFile(path.join(root, "artifact.txt"), "modified");
  const {manager, verified} = fixture(root, [job]);
  await manager.start({mode: "verify", targets: [{id: job.id, revision: 1}]}); await manager.drain();
  expect((await manager.list()).batches[0].items[0]).toMatchObject({status: "passed", comparison: {status: "changed"}});
  expect(verified).toEqual([job.id]); expect(job.delivery?.reports).toHaveLength(2);
});
it("rejects concurrent batches and preserves cancellation without touching another verification", async () => {
  const root = await folder(), job = await target(root); let release!: () => void, entered!: () => void;
  const began = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  const {manager, invalidations} = fixture(root, [job], {inspect: async (...args: Parameters<typeof verifyDelivery>) => {entered(); await gate; return verifyDelivery(...args);}});
  const batch = await manager.start({mode: "inspect", targets: [{id: job.id, revision: 1}]}); await began;
  await expect(manager.start({mode: "inspect", targets: [{id: job.id, revision: 1}]})).rejects.toThrow("正在运行");
  const cancel = manager.cancel(batch.id); release(); await cancel;
  expect((await manager.list()).batches[0]).toMatchObject({status: "cancelled", items: [{status: "cancelled"}]}); expect(invalidations).toEqual([]);
});
it("refuses to persist a fresh claim after the baseline changes during file inspection", async () => {
  const root = await folder(), job = await target(root);
  const {manager, invalidations} = fixture(root, [job], {inspect: async (...args: Parameters<typeof verifyDelivery>) => {
    const report = await verifyDelivery(...args); job.delivery!.reports[0].id = randomUUID(); return report;
  }});
  await manager.start({mode: "inspect", targets: [{id: job.id, revision: 1}]}); await manager.drain();
  expect((await manager.list()).batches[0].items[0].status).toBe("skipped"); expect(invalidations).toEqual([]);
});

it("keeps a previously invalidated task held even when an inspection finds the original bytes restored", async () => {
  const root=await folder(),job=await target(root),baseline=job.delivery!.reports[0];
  job.delivery!.staleEvidence={reportId:baseline.id,at:Date.now(),reason:"changed"};
  const {manager}=fixture(root,[job]);await manager.start({mode:"inspect",targets:[{id:job.id,revision:1}]});await manager.drain();
  expect((await manager.list()).batches[0].items[0].comparison?.status).toBe("current");expect(deliveryAccepted(job.delivery)).toBe(false);
});

it("stops before file work when a checking marker cannot be saved and recovers the interrupted journal", async () => {
  const root=await folder(),job=await target(root);let writes=0,reads=0;
  const {manager}=fixture(root,[job],{write:async(file:string,value:string|Buffer)=>{if(++writes===2)throw Error("disk full");await atomicWrite(file,value);},
    inspect:async(...args:Parameters<typeof verifyDelivery>)=>{reads++;return verifyDelivery(...args);}});
  await manager.start({mode:"inspect",targets:[{id:job.id,revision:1}]});await manager.drain();
  expect(reads).toBe(0);expect((await manager.list()).issue).toBeTruthy();
  await expect(manager.start({mode:"inspect",targets:[{id:job.id,revision:1}]})).rejects.toThrow("无法保存");
  const restored=fixture(root,[job]).manager;expect((await restored.list()).batches[0].status).toBe("interrupted");
});

it("preserves a corrupt batch journal instead of silently replacing it", async () => {
  const root=await folder(),file=path.join(root,"delivery-batches.json");await fs.writeFile(file,"corrupt");
  const {manager}=fixture(root,[]);await expect(manager.list()).rejects.toThrow("原文件未被覆盖");
  expect(await fs.readFile(file,"utf8")).toBe("corrupt");
});
