import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { windowsPowerShellEnv } from "../core/powershell";
import { terminateTree } from "../core/process";
import { verifyVaultFile } from "./vault-file";
import { vaultPathSchema, vaultExportAttemptSchema, type VaultProgress } from "../shared/vault";

const fileSchema = z.object({path: vaultPathSchema, bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/)});
const resultSchema = z.object({result: z.literal(true), bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/), files: z.number().int().positive()}).strict();
const progressSchema = z.object({phase: z.enum(["packing", "checkingArchive"]), bytes: z.number().finite().nonnegative(), totalBytes: z.number().finite().nonnegative(), files: z.number().int().nonnegative(), totalFiles: z.number().int().positive()}).strict();
export type ArchiveFile = z.infer<typeof fileSchema>;
export type ArchiveResult = Omit<z.infer<typeof resultSchema>, "result"> & {path: string};
export type ExportTemporary = NonNullable<z.infer<typeof vaultExportAttemptSchema>["temporary"]>;
export async function cleanupVaultExport(temporary:ExportTemporary, destination:string, requestRoot:string) {
  const parent=await fs.realpath(path.dirname(destination)), profile=await fs.realpath(requestRoot);
  for(const [kind,file] of Object.entries(temporary)) {
    const expected=kind==="partial"?parent:profile;
    const pattern=kind==="partial"?/^\.relay-vault-[a-f0-9-]{36}\.partial$/:/^vault-export-[a-f0-9-]{36}\.json$/;
    if(!path.isAbsolute(file.path)||path.dirname(file.path)!==expected||!pattern.test(path.basename(file.path)))throw Error("导出临时文件归属无法确认，未执行清理");
    try {
      const stat=await fs.lstat(file.path,{bigint:true});
      if(!stat.isFile()||stat.isSymbolicLink()||String(stat.dev)!==file.dev||String(stat.ino)!==file.ino)throw Error("导出临时文件归属无法确认，未执行清理");
      await fs.unlink(file.path);
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  }
}
const stamp = (s: Awaited<ReturnType<typeof fs.lstat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function existing(file: string) {
  try {const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error("导出位置必须是普通文件"); return stamp(stat);}
  catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e;}
}
export async function exportVaultArchive(options: {
  directory: string; destination: string; requestRoot: string; script: string; files: ArchiveFile[];
  signal: AbortSignal; progress: (value: Omit<VaultProgress, "id" | "path">) => void;
  publishing: () => void;
  prepared?: (temporary:ExportTemporary) => Promise<void>;
  validated?: (result:ArchiveResult) => Promise<void>;
}): Promise<ArchiveResult> {
  if (process.platform !== "win32") throw Error("完整交付包导出目前仅支持 Windows");
  const files = z.array(fileSchema).min(1).max(3005).parse(options.files);
  if (new Set(files.map(f => f.path.toLowerCase())).size !== files.length) throw Error("交付包文件名重复");
  if (!path.isAbsolute(options.destination) || !path.isAbsolute(options.requestRoot)) throw Error("导出需要绝对路径");
  const parent = await fs.realpath(path.dirname(options.destination));
  const destination = path.join(parent, path.basename(options.destination)), before = await existing(destination);
  const relative = path.relative(await fs.realpath(options.directory), destination);
  if (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)) throw Error("请将导出文件保存在交付版本目录之外");
  const partialName = `.relay-vault-${randomUUID()}.partial`, partial = path.join(parent, partialName);
  const request = path.join(await fs.realpath(options.requestRoot), `vault-export-${randomUUID()}.json`);
  let partialOwned = false, requestOwned = false;
  try {
    options.signal.throwIfAborted();
    const file = await fs.open(partial, "wx", 0o600); partialOwned = true; await file.close();
    const initial = await fs.lstat(partial);
    const spec = await fs.open(request, "wx", 0o600); requestOwned = true;
    try {await spec.writeFile(JSON.stringify({directory: options.directory, output: partial, files})); await spec.sync();} finally {await spec.close();}
    const requestStat=await fs.lstat(request,{bigint:true}),partialStat=await fs.lstat(partial,{bigint:true});
    await options.prepared?.({partial:{path:partial,dev:String(partialStat.dev),ino:String(partialStat.ino)},request:{path:request,dev:String(requestStat.dev),ino:String(requestStat.ino)}});
    options.signal.throwIfAborted();
    const result = await new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
      const child = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", options.script, "-Request", request],
        {windowsHide: true, env: windowsPowerShellEnv(), stdio: ["pipe", "pipe", "pipe"]});
      let line = "", error = "", result: z.infer<typeof resultSchema> | undefined, invalid = false;
      let stop: Promise<void> | undefined;
      const abort = () => {stop ??= terminateTree(child).catch(e => {error = String(e);});};
      options.signal.addEventListener("abort", abort, {once: true}); if (options.signal.aborted) abort();
      child.stdin.end(); child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data: string) => {error = (error + data).slice(-4000);});
      child.stdout.on("data", (data: string) => {
        line += data; if (line.length > 65536) {invalid = true; abort(); return;}
        let newline: number;
        while ((newline = line.indexOf("\n")) >= 0) {
          const raw = line.slice(0, newline).trim(); line = line.slice(newline + 1); if (!raw) continue;
          try {
            const value = JSON.parse(raw);
            if (value.result) {if (result) throw Error("Duplicate result"); result = resultSchema.parse(value);}
            else options.progress(progressSchema.parse(value));
          } catch {invalid = true; abort();}
        }
      });
      child.once("error", reject);
      child.once("close", async code => {
        options.signal.removeEventListener("abort", abort); await stop;
        if (options.signal.aborted) reject(Error("已取消导出交付包"));
        else if (invalid || code !== 0 || !result || line.trim() || result.files !== files.length) reject(Error(error || "完整交付包校验未通过"));
        else resolve(result);
      });
    });
    options.signal.throwIfAborted();
    const stat = await fs.lstat(partial);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size !== result.bytes) throw Error("导出临时文件已变化");
    await verifyVaultFile(parent, {path: partialName, bytes: result.bytes, sha256: result.sha256}, options.signal,
      bytes => options.progress({phase: "checkingArchive", bytes, totalBytes: result.bytes, files: files.length, totalFiles: files.length}));
    if (before !== await existing(destination)) throw Error("导出位置在打包期间发生变化，请重新选择");
    await options.validated?.({path:destination,bytes:result.bytes,sha256:result.sha256,files:result.files});
    options.signal.throwIfAborted(); options.publishing();
    const waits=[100,250,500,1000,2000];
    for(let attempt=0;;attempt++) {
      try{await fs.rename(partial,destination);break;}
      catch(e){
        if(!["EPERM","EACCES","EBUSY"].includes((e as NodeJS.ErrnoException).code||"")||attempt>=waits.length)throw e;
        await new Promise(resolve=>setTimeout(resolve,waits[attempt]));
        if(before!==await existing(destination)||stamp(await fs.lstat(partial))!==stamp(stat))throw Error("导出位置在打包期间发生变化，请重新选择");
      }
    }
    partialOwned = false;
    return {path: destination, bytes: result.bytes, sha256: result.sha256, files: result.files};
  } finally {
    if (requestOwned) await fs.unlink(request).catch(() => {});
    if (partialOwned) await fs.unlink(partial).catch(() => {});
  }
}
