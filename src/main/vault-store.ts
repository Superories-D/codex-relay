import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWrite } from "../core/store";
import { vaultEntrySchema, type VaultEntry } from "../shared/vault";

const catalogSchema = z.object({version: z.literal(1), owner: z.string().uuid(), revision: z.number().int().nonnegative(),
  storage: z.string().min(1).max(32000), roots: z.array(z.string().min(1).max(32000)), entries: z.array(vaultEntrySchema)}).strict();
export type VaultCatalog = z.infer<typeof catalogSchema>;
const markerSchema = z.object({version: z.literal(1), owner: z.string().uuid(), id: z.string().uuid().optional()}).strict();
const within = (root: string, file: string) => {const rel = path.relative(root, file); return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);};

export class VaultStore {
  private state?: VaultCatalog;
  private loading?: Promise<VaultCatalog>;
  private chain: Promise<unknown> = Promise.resolve();
  issue?: string;
  constructor(private options: {root: string; write?: typeof atomicWrite; protect?: (root: string) => Promise<void>}) {}
  private get file() {return path.join(this.options.root, "delivery-vault.json");}
  private queue<T>(fn: () => Promise<T>) {const value = this.chain.then(fn); this.chain = value.catch(() => {}); return value;}
  private async commit(next: VaultCatalog) {
    catalogSchema.parse(next);
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw Error("保险库记录已满，请清理不再需要的版本记录");
    try {
      const waits = process.platform === "win32" ? [100, 250, 500, 1000, 2000] : [];
      for (let attempt = 0; ; attempt++) {
        try {await (this.options.write ?? atomicWrite)(this.file, json); break;}
        catch (error) {
          if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "") || attempt >= waits.length) throw error;
          await new Promise(resolve => setTimeout(resolve, waits[attempt]));
        }
      }
    }
    catch (error) {this.issue = "交付保险库记录无法保存，请检查磁盘后重启。"; throw Error(this.issue, {cause: error});}
    this.state = next;
  }
  private async read() {
    let state: VaultCatalog;
    try {
      if ((await fs.stat(this.file)).size > 32 * 1024 * 1024) throw Error("invalid catalog");
      state = catalogSchema.parse(JSON.parse(await fs.readFile(this.file, "utf8")));
      if (!path.isAbsolute(state.storage) || state.roots.some(root => !path.isAbsolute(root)) ||
        new Set(state.entries.map(e => e.id)).size !== state.entries.length || state.entries.some(e =>
          !state.roots.includes(e.root) || e.status === "ready" && (!e.manifestSha256 || e.sealedAt === undefined))) throw Error("invalid catalog");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("交付保险库记录无法读取；原文件未被覆盖。");
      state = {version: 1, owner: randomUUID(), revision: 0, storage: path.join(this.options.root, "delivery-vault"), roots: [], entries: []};
      await this.commit(state); return state;
    }
    const next = structuredClone(state); let changed = false;
    for (const entry of next.entries) if (entry.status === "copying") {
      changed = true; entry.status = "interrupted"; entry.issue = "上次保存被中断，请复核已写入版本或重新保存。";
    }
    for(const entry of next.entries) if(entry.exportAttempt&&entry.exportAttempt.state!=="interrupted") {
      changed=true;entry.exportAttempt.state="interrupted";entry.exportIssue="上次导出被中断，请核对目标文件并清理临时文件。";
    }
    this.state = state;
    if (changed) {next.revision++; await this.commit(next);}
    return this.state!;
  }
  private load() {
    if (this.state) return Promise.resolve(this.state);
    return this.loading ??= this.read();
  }
  async list() {await this.chain; return {...structuredClone(await this.load()), issue: this.issue};}
  mutate(fn: (next: VaultCatalog) => void) {
    return this.queue(async () => {
      if (this.issue) throw Error(this.issue);
      const next = structuredClone(await this.load()); fn(next); next.revision++; await this.commit(next); return structuredClone(next);
    });
  }
  async entry(id: string) {
    const item = (await this.list()).entries.find(e => e.id === id);
    if (!item) throw Error("交付版本不存在"); return item;
  }
  patch(id: string, patch: Partial<Omit<VaultEntry, "id" | "root" | "createdAt">>) {
    return this.mutate(next => {const entry = next.entries.find(e => e.id === id); if (!entry) throw Error("交付版本不存在"); Object.assign(entry, patch);});
  }
  private async claim(directory: string, owner: string) {
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const physical = await fs.realpath(directory), marker = path.join(physical, ".codex-relay-vault.json");
    if (physical === path.parse(physical).root) throw Error("请选择普通目录作为保险库存储位置");
    try {
      const value = markerSchema.parse(JSON.parse(await fs.readFile(marker, "utf8")));
      if (value.owner !== owner || value.id) throw Error("wrong owner");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (await fs.readdir(physical)).length)
        throw Error("该目录不属于当前交付保险库，请选择其他位置。");
      await this.options.protect?.(physical);
      const handle = await fs.open(marker, "wx", 0o600);
      try {await handle.writeFile(JSON.stringify({version: 1, owner})); await handle.sync();} finally {await handle.close();}
    }
    for (const part of ["staging", "versions"]) {
      await fs.mkdir(path.join(physical, part), {recursive: true, mode: 0o700});
      const target = await fs.realpath(path.join(physical, part));
      if (path.dirname(target) !== physical || !(await fs.stat(target)).isDirectory()) throw Error("保险库目录结构已更改，操作已停止。");
    }
    return physical;
  }
  currentStorage() {
    return this.queue(async () => {
      const state = await this.load(), storage = await this.claim(state.storage, state.owner);
      if (storage !== state.storage || !state.roots.includes(storage)) {
        const next = structuredClone(state); next.storage = storage; if (!next.roots.includes(storage)) next.roots.push(storage);
        next.revision++; await this.commit(next);
      }
      return storage;
    });
  }
  setStorage(parent: string) {
    if (!path.isAbsolute(parent)) return Promise.reject(Error("请选择绝对路径"));
    return this.queue(async () => {
      if (this.issue) throw Error(this.issue);
      const state = await this.load(), storage = await this.claim(path.join(parent, "Codex Relay Deliveries"), state.owner);
      const next = structuredClone(state); next.storage = storage; if (!next.roots.includes(storage)) next.roots.push(storage);
      next.revision++; await this.commit(next); return structuredClone(next);
    });
  }
  async ownedRoot(root: string) {
    const state = await this.load();
    if (!state.roots.includes(root) || !path.isAbsolute(root) || await fs.realpath(root) !== root) throw Error("保险库存储位置已更改，操作已停止。");
    const marker = markerSchema.parse(JSON.parse(await fs.readFile(path.join(root, ".codex-relay-vault.json"), "utf8")));
    if (marker.owner !== state.owner || marker.id) throw Error("保险库目录不属于当前配置");
    return state.owner;
  }
  async makeStage(entry: VaultEntry) {
    vaultEntrySchema.parse(entry);
    const owner = await this.ownedRoot(entry.root), stage = path.join(entry.root, "staging", entry.id);
    const parent = await fs.realpath(path.dirname(stage));
    if (parent !== path.join(entry.root, "staging")) throw Error("保险库目录结构已更改，操作已停止。");
    await fs.mkdir(stage, {mode: 0o700});
    if (await fs.realpath(stage) !== stage) throw Error("保险库目录结构已更改，操作已停止。");
    await atomicWrite(path.join(stage, ".relay-vault.json"), JSON.stringify({version: 1, owner, id: entry.id}));
    return stage;
  }
  async directory(entry: VaultEntry, staging = false) {
    vaultEntrySchema.parse(entry);
    const owner = await this.ownedRoot(entry.root), file = path.join(entry.root, staging ? "staging" : "versions", entry.id);
    if (!within(entry.root, file) || (await fs.lstat(file)).isSymbolicLink() || await fs.realpath(file) !== file) throw Error("交付版本目录已更改，操作已停止。");
    const marker = markerSchema.parse(JSON.parse(await fs.readFile(path.join(file, ".relay-vault.json"), "utf8")));
    if (marker.owner !== owner || marker.id !== entry.id) throw Error("交付版本不属于当前保险库");
    return file;
  }
  async publish(entry: VaultEntry) {
    const stage = await this.directory(entry, true), target = path.join(entry.root, "versions", entry.id);
    if (await fs.realpath(path.dirname(target)) !== path.join(entry.root, "versions")) throw Error("保险库目录结构已更改，操作已停止。");
    try {await fs.lstat(target); throw Error("交付版本目录已存在");} catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
    // Windows indexers/security scanners may briefly hold a directory without
    // FILE_SHARE_DELETE. Retain the verified stage and retry only sharing-like
    // errors; recheck ownership and the absent destination before every retry.
    const waits = process.platform === "win32" ? [250, 500, 1000, 2000, 2000] : [];
    for (let attempt = 0; ; attempt++) {
      try {await fs.rename(stage, target); return target;}
      catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "") || attempt >= waits.length) throw error;
        await new Promise(resolve => setTimeout(resolve, waits[attempt]));
        await this.directory(entry, true);
        if (await fs.realpath(path.dirname(target)) !== path.join(entry.root, "versions")) throw Error("保险库目录结构已更改，操作已停止。");
        try {await fs.lstat(target); throw Error("交付版本目录已存在");} catch (e) {if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;}
      }
    }
  }
  async removeFiles(entry: VaultEntry, staging = false) {
    let directory: string;
    try {directory = await this.directory(entry, staging);} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e;}
    // Explicit absolute-root, owner marker, UUID and realpath checks precede
    // every recursive deletion. Never follow a replaced staging junction.
    if (!within(entry.root, directory) || path.basename(directory) !== entry.id) throw Error("拒绝删除保险库范围外的目录");
    await fs.rm(directory, {recursive: true, force: true});
  }
  async drain() {await this.chain;}
}
