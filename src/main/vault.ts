import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Job } from "../shared/types";
import { vaultManifestSchema, type VaultEntry, type VaultManifest, type VaultProgress } from "../shared/vault";
import { VaultStore } from "./vault-store";
import { prepareVault, assertVaultSource, type PreparedVault } from "./vault-preview";
import { copyVerifiedArtifact, verifyVaultFile, VaultFileError, VaultIntegrityError } from "./vault-file";
import { bundleMetadata, sha256 } from "./vault-bundle";
import { redact } from "../core/redact";
import { atomicWrite } from "../core/store";
import { exportVaultArchive, cleanupVaultExport } from "./vault-archive";

type Operation = {id: string; entryId: string; kind: "capture" | "verify" | "export"; controller: AbortController; publishing: boolean; published: boolean; done: Promise<void>};
const copyIssue = (error: unknown) => error instanceof VaultFileError ? {
  sourceChanged: "源产物已变化，未创建交付版本。", sourceUnavailable: "源产物无法读取，未创建交付版本。",
  outsideWorkspace: "源产物超出任务目录，未创建交付版本。", destinationError: "存储文件无法写入或复核，未创建交付版本。", cancelled: "已取消保存交付版本。",
}[error.code] : redact(error instanceof Error ? error.message : error, 4000);

export class Vaults {
  private store: VaultStore;
  private previews = new Map<string, PreparedVault & {storage: string}>();
  private actions: Promise<unknown> = Promise.resolve();
  private active?: Operation;
  private progress?: VaultProgress;
  private closing = false;
  constructor(private options: {
    root: string; scripts: string; target: (id: string) => Job;
    invalidate: (id: string, revision: number, reportId: string, reason: "changed" | "unverified") => Promise<unknown>;
    protect?: (root: string) => Promise<void>; write?: typeof atomicWrite;
    copy?: typeof copyVerifiedArtifact; now?: () => number; text?: (source: string) => string;
    report?: (error:unknown) => void;
  }) {this.store = new VaultStore(options);}
  private now() {return this.options.now?.() ?? Date.now();}
  private queue<T>(action: () => Promise<T>) {const result = this.actions.then(action); this.actions = result.catch(() => {}); return result;}
  private available() {if (this.closing) throw Error("交付保险库正在关闭"); if (this.active) throw Error("已有交付保险库操作正在进行"); if (this.store.issue) throw Error(this.store.issue);}
  private guard(prepared: PreparedVault) {for (const source of prepared.sources) assertVaultSource(this.options.target(source.id), source);}
  async list() {return {...await this.store.list(), active: this.active ? {id: this.active.id, entryId: this.active.entryId, kind: this.active.kind, publishing: this.active.publishing} : undefined, progress: structuredClone(this.progress)};}
  setStorage(parent: string) {return this.queue(async () => {this.available(); await this.store.setStorage(parent); this.previews.clear(); return this.list();});}
  async preview(input: unknown) {
    const ids = z.array(z.string().uuid()).min(1).max(100).refine(values => new Set(values).size === values.length).parse(input);
    if (this.closing) throw Error("交付保险库正在关闭");
    const prepared = await prepareVault(ids.map(id => this.options.target(id)), this.now()); this.guard(prepared);
    const storage = await this.store.currentStorage();
    prepared.view.storage = storage;
    try {const space = await fs.statfs(storage); prepared.view.freeBytes = space.bavail * space.bsize;} catch {}
    for (const [id, old] of this.previews) if (old.view.expiresAt < this.now()) this.previews.delete(id);
    while (this.previews.size >= 10) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(prepared.view.id, {...prepared, storage});
    return structuredClone(prepared.view);
  }
  capture(input: unknown) {
    const value = z.object({previewId: z.string().uuid(), title: z.string().trim().min(1).max(200)}).strict().parse(input);
    return this.queue(async () => {
      this.available(); const saved = this.previews.get(value.previewId);
      if (!saved || saved.view.expiresAt < this.now()) throw Error("交付预览已过期，请重新预览。");
      const prepared = structuredClone(saved); this.guard(prepared);
      if ((await this.store.list()).storage !== prepared.storage) throw Error("存储位置已更改，请重新预览。");
      const manifest = vaultManifestSchema.parse({...prepared.manifest, title: value.title, sealedAt: this.now()});
      const entry: VaultEntry = {id: manifest.id, title: manifest.title, root: prepared.storage, status: "copying", createdAt: this.now(), totalBytes: manifest.totalBytes, artifactCount: manifest.artifacts.length};
      await this.store.mutate(next => {if (next.entries.some(e => e.id === entry.id)) throw Error("此预览已经保存，请重新预览。"); next.entries.push(entry);});
      this.previews.delete(value.previewId);
      this.launch(entry.id, "capture", operation => this.copy(operation, entry, manifest, prepared));
      return structuredClone(entry);
    });
  }
  private launch(entryId: string, kind: Operation["kind"], action: (operation: Operation) => Promise<void>) {
    const operation: Operation = {id: randomUUID(), entryId, kind, controller: new AbortController(), publishing: false, published: false, done: Promise.resolve()};
    this.active = operation;
    operation.done = action(operation).catch(error => {this.options.report?.(error);}).finally(() => {
      if (this.active === operation) {this.active = undefined; this.progress = undefined;}
    });
  }
  private async copy(operation: Operation, entry: VaultEntry, manifest: VaultManifest, prepared: PreparedVault) {
    const signal = operation.controller.signal;
    let checkpoint = false;
    try {
      const stage = await this.store.makeStage(entry); let copied = 0, files = 0;
      this.progress = {id: operation.id, phase: "copying", bytes: 0, totalBytes: entry.totalBytes, files: 0, totalFiles: entry.artifactCount};
      for (const artifact of manifest.artifacts) {
        signal.throwIfAborted(); this.guard(prepared);
        const source = prepared.sources.find(s => s.id === artifact.jobId)!;
        try {
          await (this.options.copy ?? copyVerifiedArtifact)({cwd: source.cwd, relative: artifact.relative, stagingRoot: stage, output: artifact.path,
            bytes: artifact.bytes, sha256: artifact.sha256, signal, progress: value => {
              this.progress = {id: operation.id, phase: value.phase, path: artifact.relative, bytes: value.phase === "copying" ? copied + value.bytes : value.bytes,
                totalBytes: value.phase === "copying" ? entry.totalBytes : artifact.bytes, files, totalFiles: entry.artifactCount};
            }});
        } catch (error) {
          if (error instanceof VaultFileError && ["sourceChanged", "sourceUnavailable", "outsideWorkspace"].includes(error.code))
            await this.options.invalidate(source.id, source.revision, source.reportId, error.code === "sourceUnavailable" ? "unverified" : "changed").catch(() => {});
          throw error;
        }
        copied += artifact.bytes; files++;
      }
      signal.throwIfAborted(); this.guard(prepared); manifest.sealedAt = this.now();
      const verifier = await fs.readFile(path.join(this.options.scripts, "vault-verify.ps1"));
      const generated = bundleMetadata(manifest, verifier, this.options.text);
      const metadata: NonNullable<VaultEntry["metadata"]> = [];
      for (const [name, bytes] of generated.files) {
        signal.throwIfAborted(); const file = await fs.open(path.join(stage, name), "wx", 0o600);
        try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
        metadata.push({path: name as NonNullable<VaultEntry["metadata"]>[number]["path"], bytes: bytes.length, sha256: sha256(bytes)});
      }
      for (const file of metadata) {signal.throwIfAborted(); await verifyVaultFile(stage, file, signal);}
      signal.throwIfAborted(); this.guard(prepared);
      this.progress = {id: operation.id, phase: "sealing", bytes: entry.totalBytes, totalBytes: entry.totalBytes, files, totalFiles: entry.artifactCount};
      operation.publishing = true;
      // This checkpoint precedes directory publication. A crash afterward can
      // recover exact stored bytes without relying on the original workspace.
      await this.store.patch(entry.id, {manifestSha256: generated.manifestSha256, metadata, sealedAt: manifest.sealedAt});
      checkpoint = true;
      await this.store.publish(entry); operation.published = true;
      await this.store.patch(entry.id, {status: "ready", issue: undefined,
        verification: {at: this.now(), status: "passed", changed: []}});
    } catch (error) {
      if (!operation.published && !checkpoint) await this.store.removeFiles(entry, true).catch(() => {});
      if (!operation.published) await this.store.patch(entry.id, {status: checkpoint ? "interrupted" : signal.aborted ? "cancelled" : "failed",
        issue: checkpoint ? "文件已保存，但版本发布未完成。请复核并恢复。" : copyIssue(error)}).catch(() => {});
      throw error;
    }
  }
  private async manifest(entry: VaultEntry, allowStage = false) {
    if (!entry.manifestSha256 || !entry.metadata || entry.metadata.find(m => m.path === "manifest.json")?.sha256 !== entry.manifestSha256)
      throw new VaultIntegrityError("unverified");
    let directory: string, staging = false;
    try {directory = await this.store.directory(entry);} catch (error) {
      if (!allowStage || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      directory = await this.store.directory(entry, true); staging = true;
    }
    const spec = entry.metadata.find(m => m.path === "manifest.json")!;
    if (spec.bytes > 128 * 1024 * 1024) throw new VaultIntegrityError("unverified");
    await verifyVaultFile(directory, spec);
    const data = await fs.readFile(path.join(directory, "manifest.json"));
    if (data.length !== spec.bytes || sha256(data) !== entry.manifestSha256) throw new VaultIntegrityError("changed");
    const manifest = vaultManifestSchema.parse(JSON.parse(data.toString("utf8")));
    if (manifest.id !== entry.id || manifest.title !== entry.title || manifest.totalBytes !== entry.totalBytes || manifest.artifacts.length !== entry.artifactCount)
      throw new VaultIntegrityError("changed");
    return {manifest, directory, staging};
  }
  async detail(id: string) {
    const entry = await this.store.entry(id); const data = await this.manifest(entry, entry.status === "interrupted");
    return {entry, manifest: data.manifest};
  }
  verify(id: string) {
    return this.queue(async () => {
      this.available(); const entry = await this.store.entry(id);
      if (entry.status === "deleting") throw Error("此版本删除尚未完成，请继续删除");
      if (!entry.manifestSha256) throw Error("此版本尚未完成保存，请重新保存。");
      this.launch(id, "verify", operation => this.check(operation, entry)); return this.list();
    });
  }
  private async check(operation: Operation, entry: VaultEntry) {
    const signal = operation.controller.signal, changed: string[] = []; let status: "passed" | "failed" | "unverified" = "passed";
    try {
      const data = await this.manifest(entry, entry.status === "interrupted");
      const all = [...entry.metadata!, ...data.manifest.artifacts]; let checked = 0, count = 0;
      const total = all.reduce((n, f) => n + f.bytes, 0);
      for (const artifact of all) {
        signal.throwIfAborted();
        try {await verifyVaultFile(data.directory, artifact, signal, bytes => {
          this.progress = {id: operation.id, phase: "verifying", path: artifact.path, bytes: checked + bytes, totalBytes: total, files: count, totalFiles: all.length};
        });} catch (error) {
          if (signal.aborted) throw error;
          changed.push(artifact.path); status = error instanceof VaultIntegrityError && error.code === "changed" ? "failed" : status === "failed" ? "failed" : "unverified";
        }
        checked += artifact.bytes; count++;
      }
      signal.throwIfAborted();
      if (status === "passed" && data.staging) {operation.publishing = true; await this.store.publish(entry); operation.published = true;}
      await this.store.patch(entry.id, {verification: {at: this.now(), status, changed},
        ...(status === "passed" ? {status: "ready" as const, issue: undefined} : {})});
    } catch (error) {
      await this.store.patch(entry.id, {verification: {at: this.now(), status: signal.aborted ? "unverified" : error instanceof VaultIntegrityError && error.code === "changed" ? "failed" : "unverified", changed: ["manifest.json"]},
        issue: signal.aborted ? "已取消交付版本复核。" : "交付版本无法完成复核，请检查保存位置与文件。"}).catch(() => {});
      throw error;
    }
  }
  async cancel(id: string) {
    const operation = this.active;
    if (!operation || operation.id !== id) throw Error("此保险库操作已经结束");
    if (operation.publishing) throw Error("正在完成交付版本写入，请稍候。");
    operation.controller.abort(); await operation.done; return this.list();
  }
  export(id: string, destination: string) {
    return this.queue(async () => {
      this.available(); const entry = await this.store.entry(id);
      if (entry.status !== "ready") throw Error("请先复核并恢复此交付版本");
      if(entry.exportAttempt)throw Error("请先核对上次中断的导出");
      if (!path.isAbsolute(destination)) throw Error("导出需要绝对路径");
      const absolute = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination)), catalog = await this.store.list();
      if (catalog.roots.some(root => {
        const relative = path.relative(root, absolute);
        return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
      })) throw Error("请将导出文件保存在保险库目录之外");
      const data = await this.manifest(entry);
      let attempt:NonNullable<VaultEntry["exportAttempt"]>={at:this.now(),destination:absolute,state:"packing"};
      await this.store.patch(id, {exportIssue: undefined,exportAttempt:attempt});
      this.launch(id, "export", async operation => {
        try {
          const result = await exportVaultArchive({directory: data.directory, destination: absolute, requestRoot: this.options.root,
            script: path.join(this.options.scripts, "vault-archive.ps1"), files: [...entry.metadata!, ...data.manifest.artifacts],
            signal: operation.controller.signal, progress: value => {this.progress = {id: operation.id, ...value};},
            prepared:async temporary=>{attempt={...attempt,temporary};await this.store.patch(id,{exportAttempt:attempt});},
            validated:async result=>{attempt={...attempt,state:"publishing",bytes:result.bytes,sha256:result.sha256,files:result.files};await this.store.patch(id,{exportAttempt:attempt});},
            publishing: () => {operation.publishing = true;}});
          operation.published = true;
          await this.store.patch(id, {lastExport: {...result, at: this.now()}, exportIssue: undefined,exportAttempt:undefined});
        } catch (error) {
          await this.store.patch(id, {exportAttempt:operation.published?{...attempt,state:"interrupted"}:undefined,
            exportIssue: operation.published ? "交付包已写入，但导出记录保存失败。" : operation.controller.signal.aborted ? "已取消导出交付包" : "完整交付包导出未完成；原有文件已保留。"}).catch(() => {});
          throw error;
        }
      });
      return this.list();
    });
  }
  recoverExport(id:string) {
    return this.queue(async()=>{
      this.available();const entry=await this.store.entry(id),attempt=entry.exportAttempt;
      if(!attempt||attempt.state!=="interrupted")throw Error("没有需要核对的中断导出");
      this.launch(id,"verify",async operation=>{
        try {
        let passed=false;
        if(attempt.sha256&&attempt.bytes!==undefined&&attempt.files) {
          try{await verifyVaultFile(path.dirname(attempt.destination),{path:path.basename(attempt.destination),bytes:attempt.bytes,sha256:attempt.sha256},operation.controller.signal,
            bytes=>{this.progress={id:operation.id,phase:"checkingArchive",bytes,totalBytes:attempt.bytes!,files:0,totalFiles:1};});passed=true;}
          catch{operation.controller.signal.throwIfAborted();}
        }
        operation.controller.signal.throwIfAborted();operation.publishing=true;
        if(attempt.temporary)await cleanupVaultExport(attempt.temporary,attempt.destination,this.options.root);
        await this.store.patch(id,{exportAttempt:undefined,...(passed?{lastExport:{at:this.now(),path:attempt.destination,bytes:attempt.bytes!,sha256:attempt.sha256!,files:attempt.files!}}:{}),
          exportIssue:passed?undefined:"未确认上次导出，临时文件已清理。请重新导出完整交付包。"});
        } catch(error) {
          await this.store.patch(id,{exportIssue:operation.controller.signal.aborted?"已取消核对上次导出":redact(error instanceof Error?error.message:error,4000)}).catch(()=>{});
          throw error;
        }
      });return this.list();
    });
  }
  async openDirectory(id: string) {return this.store.directory(await this.store.entry(id));}
  remove(id: string) {
    return this.queue(async () => {
      this.available(); const entry = await this.store.entry(id);
      if(entry.exportAttempt)throw Error("请先核对上次中断的导出");
      await this.store.patch(id, {status: "deleting", issue: "此版本删除尚未完成，请继续删除"});
      await this.store.removeFiles(entry); await this.store.removeFiles(entry, true);
      await this.store.mutate(next => {next.entries = next.entries.filter(e => e.id !== id);}); return this.list();
    });
  }
  async drain() {await this.actions; await this.active?.done; await this.store.drain();}
  async shutdown() {this.closing = true; if (!this.active?.publishing) this.active?.controller.abort(); await this.drain();}
  resume() {this.closing = false;}
}
