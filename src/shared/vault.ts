import { z } from "zod";
import { deliveryReportSchema } from "./delivery";

export const vaultPathSchema = z.string().min(1).max(8192).refine(value =>
  !/^[\\/]|^[a-z]:|[\x00-\x1f:]/i.test(value) &&
  !value.split(/[\\/]/).some(part => !part || part === "." || part === ".."), "Invalid vault-relative path");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const byteCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fileIdentity = z.string().regex(/^\d{1,40}$/);
const ownedExportFile = z.object({path:z.string().min(1).max(32000),dev:fileIdentity,ino:fileIdentity}).strict();
export const vaultExportAttemptSchema = z.object({at:z.number().finite(),destination:z.string().min(1).max(32000),
  state:z.enum(["packing","publishing","interrupted"]),
  temporary:z.object({partial:ownedExportFile,request:ownedExportFile}).strict().optional(),
  bytes:byteCount.optional(),sha256:digest.optional(),files:z.number().int().min(1).max(3005).optional(),
}).strict();
const workflow = z.object({id: z.string().uuid(), title: z.string().max(1000), step: z.number().int().min(1), total: z.number().int().min(1)}).strict();
export const vaultTaskSchema = z.object({
  id: z.string().uuid(), title: z.string().max(1000), project: z.string().max(1000),
  stateAtCapture: z.enum(["completed", "paused", "cancelled", "needs_attention"]),
  workflow: workflow.optional(), dependsOn: z.array(z.string().uuid()).max(20),
  revision: z.number().int().nonnegative(), report: deliveryReportSchema,
}).strict();
export const vaultArtifactSchema = z.object({
  id: z.string().uuid(), jobId: z.string().uuid(), relative: vaultPathSchema,
  path: vaultPathSchema.refine(value => value.startsWith("artifacts/")), bytes: byteCount, sha256: digest, sourceModifiedAt: z.number().finite(),
  checks: z.array(z.number().int().min(0).max(29)).min(1).max(30),
}).strict();
export const vaultManifestSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), title: z.string().trim().min(1).max(200),
  sealedAt: z.number().finite(), tasks: z.array(vaultTaskSchema).min(1).max(100),
  artifacts: z.array(vaultArtifactSchema).min(1).max(3000), totalBytes: byteCount,
}).strict().superRefine((manifest, context) => {
  const tasks = new Map(manifest.tasks.map(task => [task.id, task]));
  const paths = new Set<string>(), ids = new Set<string>(), mapped = new Set<string>();
  if (tasks.size !== manifest.tasks.length) context.addIssue({code: "custom", message: "Duplicate task identity"});
  let bytes = 0;
  for (const artifact of manifest.artifacts) {
    const key = artifact.path.replaceAll("\\", "/").toLowerCase();
    if (paths.has(key) || ids.has(artifact.id)) context.addIssue({code: "custom", message: "Duplicate artifact identity or path"});
    paths.add(key); ids.add(artifact.id); bytes += artifact.bytes;
    const task = tasks.get(artifact.jobId);
    if (!task) {context.addIssue({code: "custom", message: "Artifact task missing"}); continue;}
    for (const index of artifact.checks) {
      const finding = task.report.findings[index], identity = `${task.id}:${index}`;
      if (!finding || mapped.has(identity) || finding.status !== "passed" || finding.code !== "verified" || finding.sha256 !== artifact.sha256 || finding.bytes !== artifact.bytes)
        context.addIssue({code: "custom", message: "Artifact does not match accepted evidence"});
      mapped.add(identity);
    }
    if (!artifact.checks.some(index => task.report.findings[index]?.check.path.replaceAll("\\", "/") === artifact.relative.replaceAll("\\", "/")))
      context.addIssue({code: "custom", message: "Artifact source path is not declared by its evidence"});
  }
  for (const task of manifest.tasks) {
    if (task.report.status !== "passed" || task.report.revision !== task.revision || !task.report.findings.length ||
      task.report.findings.some((_, index) => !mapped.has(`${task.id}:${index}`)))
      context.addIssue({code: "custom", message: "Task lacks complete accepted artifact evidence"});
  }
  if (!Number.isSafeInteger(bytes) || bytes !== manifest.totalBytes)
    context.addIssue({code: "custom", message: "Artifact byte total mismatch"});
});
export type VaultManifest = z.infer<typeof vaultManifestSchema>;
export type VaultTask = z.infer<typeof vaultTaskSchema>;
export type VaultArtifact = z.infer<typeof vaultArtifactSchema>;

export const vaultEntrySchema = z.object({
  id: z.string().uuid(), title: z.string().max(200), root: z.string().min(1).max(32000),
  createdAt: z.number().finite(), sealedAt: z.number().finite().optional(),
  status: z.enum(["copying", "ready", "failed", "cancelled", "interrupted", "deleting"]),
  totalBytes: byteCount, artifactCount: z.number().int().min(1).max(3000),
  manifestSha256: digest.optional(), issue: z.string().max(4000).optional(),
  metadata: z.array(z.object({path: z.enum(["manifest.json", "index.html", "Verify.ps1", "Verify.cmd", "SHA256SUMS.txt"]),
    bytes: byteCount, sha256: digest}).strict()).length(5).refine(values => new Set(values.map(v => v.path)).size === 5).optional(),
  verification: z.object({at: z.number().finite(), status: z.enum(["passed", "failed", "unverified"]),
    changed: z.array(vaultPathSchema)}).strict().optional(),
  lastExport: z.object({at: z.number().finite(), path: z.string().min(1).max(32000), bytes: byteCount, sha256: digest,
    files: z.number().int().min(1).max(3005)}).strict().optional(),
  exportIssue: z.string().max(4000).optional(),
  exportAttempt:vaultExportAttemptSchema.optional(),
}).strict().refine(value => value.status !== "ready" || !!value.manifestSha256 && value.sealedAt !== undefined && !!value.metadata,
  "Ready vault versions require complete manifest and metadata fingerprints")
  .refine(value => !value.manifestSha256 || !value.metadata || value.metadata.find(m => m.path === "manifest.json")?.sha256 === value.manifestSha256,
    "Catalog manifest fingerprint mismatch");
export type VaultEntry = z.infer<typeof vaultEntrySchema>;
export interface VaultProgress {
  id: string;
  phase: "copying" | "verifying" | "sealing" | "packing" | "checkingArchive";
  path?: string;
  bytes: number;
  totalBytes: number;
  files: number;
  totalFiles: number;
}
export interface VaultPreview {
  id: string;
  expiresAt: number;
  title: string;
  tasks: VaultTask[];
  artifacts: VaultArtifact[];
  totalBytes: number;
  storage?: string;
  freeBytes?: number;
}
export interface VaultView {
  revision: number;
  storage: string;
  roots: string[];
  entries: VaultEntry[];
  issue?: string;
  active?: {id: string; entryId: string; kind: "capture" | "verify" | "export"; publishing: boolean};
  progress?: VaultProgress;
}
export interface VaultReferences {
  matches:{id:string;title:string;manifestSha256:string;reportId:string;revision:number;stateAtCapture:string;verification?:VaultEntry["verification"]}[];
  unreadable:{id:string;title:string}[];
}
