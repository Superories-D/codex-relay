import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Job } from "../shared/types";
import { deliveryAccepted, deliveryChecksSchema, deliveryReportSchema } from "../shared/delivery";
import { vaultManifestSchema, type VaultManifest, type VaultPreview, type VaultTask, type VaultArtifact } from "../shared/vault";
import { VaultFileError } from "./vault-file";

export interface VaultSource {id: string; cwd: string; state: Job["state"]; revision: number; reportId: string; signature: string}
export interface PreparedVault {view: VaultPreview; manifest: VaultManifest; sources: VaultSource[]}
const folderTitle = (value: string) => Array.from(value.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim())
  .slice(0, 60).join("").replace(/[. ]+$/, "") || "Task";
const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return !!relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
export function assertVaultSource(job: Job, source: VaultSource) {
  if (job.id !== source.id || job.cwd !== source.cwd || job.state !== source.state || !deliveryAccepted(job.delivery) ||
    job.delivery?.revision !== source.revision || job.delivery.reports.at(-1)?.id !== source.reportId || signature(job) !== source.signature)
    throw Error("交付证据或任务状态已更新，请重新预览。");
}
function signature(job: Job) {
  return createHash("sha256").update(JSON.stringify({checks: deliveryChecksSchema.parse(job.delivery?.checks),
    report: deliveryReportSchema.parse(job.delivery?.reports.at(-1))})).digest("hex");
}

export async function prepareVault(jobs: Job[], now = Date.now()): Promise<PreparedVault> {
  if (!jobs.length || jobs.length > 100 || new Set(jobs.map(j => j.id)).size !== jobs.length)
    throw Error("请选择 1 到 100 项不同的已验收任务。");
  const tasks: VaultTask[] = [], artifacts: VaultArtifact[] = [], sources: VaultSource[] = [], usedFolders = new Set<string>();
  let totalBytes = 0;
  for (const job of jobs) {
    const delivery = job.delivery, report = delivery?.reports.at(-1);
    if (!["completed", "paused", "cancelled", "needs_attention"].includes(job.state) || !delivery?.checks.length || !report || !deliveryAccepted(delivery) || report.findings.length !== delivery.checks.length)
      throw Error("所选任务必须已停止运行并通过当前交付验收。");
    if (report.findings.some((finding, index) => JSON.stringify(deliveryChecksSchema.parse([finding.check])) !== JSON.stringify(deliveryChecksSchema.parse([delivery.checks[index]]))))
      throw Error("验收记录与当前条件不一致，请重新验收。");
    let folder = `${folderTitle(job.title)}-${job.id.replaceAll("-", "").slice(0, 12)}`;
    while (usedFolders.has(folder.toLowerCase())) folder += "-";
    usedFolders.add(folder.toLowerCase());
    const task: VaultTask = {id: job.id, title: job.title.slice(0, 1000), project: (path.basename(job.projectCwd || job.cwd) || job.title).slice(0, 1000),
      stateAtCapture: job.state as VaultTask["stateAtCapture"],
      dependsOn: [...(job.dependsOn || [])], revision: delivery.revision, report: structuredClone(report),
      workflow: job.workflow ? {id: job.workflow.id, title: job.workflow.title.slice(0, 1000), step: job.workflow.step, total: job.workflow.total} : undefined};
    const root = await fs.realpath(job.cwd), files = new Map<string, VaultArtifact>();
    for (const [index, finding] of report.findings.entries()) {
      if (finding.status !== "passed" || !finding.sha256 || finding.bytes === undefined || !Number.isFinite(finding.modifiedAt))
        throw Error("验收记录缺少完整文件证据，请先重新验收。");
      const candidate = path.resolve(root, ...finding.check.path.split(/[\\/]/)), physical = await fs.realpath(candidate);
      if (!within(root, physical)) throw new VaultFileError("outsideWorkspace");
      const key = process.platform === "win32" ? physical.toLowerCase() : physical;
      const existing = files.get(key);
      if (existing) {
        if (existing.sha256 !== finding.sha256 || existing.bytes !== finding.bytes) throw Error("同一产物的验收指纹不一致，请重新验收。");
        existing.checks.push(index);
      } else {
        const relative = finding.check.path.replaceAll("\\", "/");
        const artifact: VaultArtifact = {id: randomUUID(), jobId: job.id, relative, path: `artifacts/${folder}/${relative}`,
          bytes: finding.bytes, sha256: finding.sha256, sourceModifiedAt: finding.modifiedAt!, checks: [index]};
        files.set(key, artifact); artifacts.push(artifact); totalBytes += finding.bytes;
      }
    }
    tasks.push(task); sources.push({id: job.id, cwd: job.cwd, state: job.state, revision: delivery.revision, reportId: report.id, signature: signature(job)});
  }
  const commonWorkflow = tasks.every(t => t.workflow?.id && t.workflow.id === tasks[0].workflow?.id);
  const title = (commonWorkflow ? tasks[0].workflow!.title : tasks.length === 1 ? tasks[0].title : "Delivery").slice(0, 200) || "Delivery";
  const id = randomUUID(), manifest = vaultManifestSchema.parse({schemaVersion: 1, id, title, sealedAt: now, tasks, artifacts, totalBytes});
  return {manifest, sources, view: {id, title, expiresAt: now + 300000, tasks: manifest.tasks, artifacts: manifest.artifacts, totalBytes}};
}
