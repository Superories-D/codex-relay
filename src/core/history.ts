import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { HistoryEntry, Job } from "../shared/types";
import { Store } from "./store";
import { Chats, jsonLines, rolloutRecords } from "./chat";
import { captureRollout, HistoryDependencyError } from "./rollout-snapshot";
import { TextWriter } from "./text-writer";
import { persistImages } from "./chat-media";
import {
  nativeCatalog,
  NativeSnapshots,
  type NativeThread,
} from "./native-history";

export class History {
  private entries = new Map<
    string,
    { entry: HistoryEntry; file: string; home: string; native?: NativeThread }
  >();
  private busy = false;
  private mediaCopies = new Map<string, string>();
  private nativeSnapshots?: NativeSnapshots;
  nativeProjects: { cwd: string; name: string; id: string }[] = [];
  snapshotProgress?: (percent: number) => void;
  cancelled?: () => boolean;
  constructor(
    private store: Store,
    private chats: Chats,
    private maxRecordBytes = 16 * 1024 * 1024,
  ) {}
  async scan(
    homes?: string[],
    progress?: (scanned: number) => void,
    cancelled?: () => boolean,
  ) {
    if (this.busy) throw new Error("正在导入历史，请稍后扫描");
    this.close();
    this.entries.clear();
    this.nativeProjects = [];
    let scanned = 0;
    const warnings: string[] = [],
      roots: string[] = [];
    for (const root of homes ??
      ([process.env.CODEX_HOME, path.join(os.homedir(), ".codex")].filter(
        Boolean,
      ) as string[])) {
      try {
        const real = await fs.realpath(root);
        if (!roots.includes(real)) roots.push(real);
      } catch {
        warnings.push(`无法读取目录：${root}`);
      }
    }
    for (const home of roots) {
      const titles = new Map<string, string>();
      try {
        for await (const r of jsonLines(path.join(home, "session_index.jsonl")))
          if (r.id && typeof r.thread_name === "string")
            titles.set(r.id, r.thread_name);
      } catch {}
      const walk = async (dir: string) => {
        let files;
        try {
          files = await fs.readdir(dir, { withFileTypes: true });
        } catch (e: any) {
          if (e.code !== "ENOENT") warnings.push(`目录不可读：${dir}`);
          return;
        }
        for (const f of files) {
          if (cancelled?.()) throw Error("导入已停止");
          const file = path.join(dir, f.name);
          if (f.isDirectory()) await walk(file);
          else if (f.isFile() && f.name.endsWith(".jsonl")) {
            try {
              const real = await fs.realpath(file);
              const relative = path.relative(home, real);
              if (relative.startsWith("..") || path.isAbsolute(relative))
                throw new Error("路径超出所选目录");
              let meta: any,
                prompt = "",
                count = 0;
              for await (const row of jsonLines(
                real,
                undefined,
                this.maxRecordBytes,
              )) {
                if (!meta) {
                  if (row.type !== "session_meta")
                    throw new Error("缺少 session_meta");
                  meta = row.payload;
                }
                if (
                  row.type === "event_msg" &&
                  row.payload?.type === "user_message"
                ) {
                  prompt = row.payload.message;
                  break;
                }
                if (++count > 40) break;
              }
              if (!/^[0-9a-f-]{36}$/i.test(meta?.id ?? ""))
                throw new Error("会话 ID 无效");
              const id = createHash("sha256").update(real).digest("hex");
              const source =
                typeof meta.source === "string" ? meta.source : "subagent";
              const entry: HistoryEntry = {
                id,
                threadId: meta.id,
                title:
                  titles.get(meta.id) ??
                  (prompt || "Codex 会话").replace(/\s+/g, " ").slice(0, 100),
                cwd: typeof meta.cwd === "string" ? meta.cwd : "",
                source,
                updatedAt: (await fs.stat(file)).mtimeMs,
                archived: relative.split(path.sep)[0] === "archived_sessions",
                issue:
                  meta.history_base || meta.parent_thread_id
                    ? "此会话含外部历史依赖，已导入本地记录；继续任务前需在原客户端导出完整独立会话。"
                    : meta.dynamic_tools?.length
                      ? "此会话使用 Desktop 专属工具，可阅读历史；CLI 无法提供原应用工具。"
                      : source === "subagent"
                        ? "子代理记录仅供阅读，请继续主会话。"
                        : undefined,
                imported: this.store.data.jobs.some(
                  (j) => j.historySource?.threadId === meta.id,
                ),
              };
              this.entries.set(id, { entry, file: real, home });
              progress?.(++scanned);
            } catch (e) {
              warnings.push(`${f.name}：${String(e)}`);
            }
          }
        }
      };
      await walk(path.join(home, "sessions"));
      await walk(path.join(home, "archived_sessions"));
      try {
        const catalog = await nativeCatalog(home);
        if (catalog) {
          this.nativeProjects.push(...catalog.projects);
          for (const native of catalog.threads) {
            const existing = [...this.entries.entries()].find(
              ([, v]) => v.entry.threadId === native.entry.threadId,
            );
            if (
              existing?.[1].native &&
              existing[1].entry.updatedAt >= native.entry.updatedAt
            )
              continue;
            if (existing && native.row.history_mode !== "paginated") continue;
            if (existing) this.entries.delete(existing[0]);
            native.entry.imported = this.store.data.jobs.some(
              (j) => j.historySource?.threadId === native.entry.threadId,
            );
            this.entries.set(native.entry.id, {
              entry: native.entry,
              home,
              file: native.state,
              native,
            });
            progress?.(++scanned);
          }
        }
      } catch (error) {
        warnings.push(`分页历史数据库未完整读取：${String(error)}`);
      }
    }
    return {
      entries: [...this.entries.values()]
        .map((x) => x.entry)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      roots,
      warnings,
    };
  }
  async copyEntry(id: string) {
    const found = this.entries.get(id);
    if (!found) throw Error("扫描记录已过期");
    if (found.native) {
      this.nativeSnapshots ??= new NativeSnapshots(
        this.store,
        this.chats,
        (percent) => this.snapshotProgress?.(percent),
        () => this.cancelled?.() || false,
      );
      return this.nativeSnapshots.copy(found.native);
    }
    return this.copy(found.file, found.entry, found.home);
  }
  async import(ids?: string[]) {
    if (this.busy) throw new Error("导入正在进行中");
    this.busy = true;
    const imported: string[] = [],
      skipped: string[] = [],
      errors: string[] = [];
    try {
      for (const id of ids ?? [...this.entries.keys()]) {
        const found = this.entries.get(id);
        if (!found) {
          errors.push(`扫描记录已过期：${id}`);
          continue;
        }
        const { entry, file, home } = found;
        if (
          this.store.data.jobs.some(
            (j) => j.historySource?.threadId === entry.threadId,
          )
        ) {
          skipped.push(entry.title);
          continue;
        }
        try {
          const job = await this.copyEntry(id);
          this.store.data.jobs.push(job);
          await this.store.save();
          imported.push(job.id);
        } catch (e) {
          errors.push(`${entry.title}：${String(e)}`);
        }
      }
      return { imported, skipped, errors };
    } finally {
      this.busy = false;
      this.close();
    }
  }
  close() {
    this.nativeSnapshots?.close();
    this.nativeSnapshots = undefined;
  }
  async copy(
    file: string,
    entry: HistoryEntry,
    sourceHome = path.dirname(file),
  ): Promise<Job> {
    const id = randomUUID(),
      threadId = randomUUID(),
      home = this.store.jobHome(id);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const realHome = await fs.realpath(home);
    const snapshot = path.join(realHome, "import-source.jsonl");
    const resolve = (id: string) =>
      [...this.entries.values()].find(
        (found) => found.home === sourceHome && found.entry.threadId === id,
      )?.file;
    let issue = entry.issue;
    try {
      const captured = await captureRollout(
        file,
        sourceHome,
        snapshot,
        resolve,
        true,
        this.maxRecordBytes,
      );
      if (captured.privateTools)
        issue =
          "此会话使用 Desktop 专属工具，可阅读历史；CLI 无法提供原应用工具。";
      else if (
        captured.flattened &&
        !captured.meta.parent_thread_id &&
        entry.source !== "subagent"
      )
        issue = undefined;
    } catch (error) {
      if (!(error instanceof HistoryDependencyError)) throw error;
      await captureRollout(
        file,
        sourceHome,
        snapshot,
        resolve,
        false,
        this.maxRecordBytes,
      );
      issue = `父会话历史未完整恢复，仅可阅读已复制记录：${error.message}`;
    }
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const dir = path.join(
      realHome,
      "sessions",
      ...timestamp.slice(0, 10).split("-"),
    );
    await fs.mkdir(dir, { recursive: true });
    const rollout = path.join(dir, `rollout-${timestamp}-${threadId}.jsonl`);
    const out = await fs.open(rollout, "wx", 0o600);
    const writer = new TextWriter(out);
    let model = "",
      effort = "";
    try {
      let first = true;
      for await (const row of jsonLines(
        snapshot,
        undefined,
        this.maxRecordBytes,
      )) {
        if (first) {
          if (row.type !== "session_meta" || row.payload?.id !== entry.threadId)
            throw new Error("会话身份发生变化");
          row.payload.id = threadId;
          if (row.payload.session_id) row.payload.session_id = threadId;
          first = false;
        }
        if (row.type === "turn_context") {
          if (typeof row.payload?.model === "string") model = row.payload.model;
          const level = row.payload?.effort ?? row.payload?.reasoning_effort;
          if (typeof level === "string") effort = level;
        }
        await writer.write(JSON.stringify(row) + "\n");
      }
      await writer.flush();
      await out.sync();
    } finally {
      await out.close();
    }
    await fs.mkdir(path.dirname(this.chats.file(id)), { recursive: true });
    const transcript = await fs.open(this.chats.file(id), "wx", 0o600);
    const transcriptWriter = new TextWriter(transcript);
    try {
      for await (const item of rolloutRecords(snapshot, this.maxRecordBytes))
        await transcriptWriter.write(
          JSON.stringify(
            await persistImages(this.store.root, item, {
              copyFilesFrom: entry.cwd,
              copies: this.mediaCopies,
            }),
          ) + "\n",
        );
      await transcriptWriter.flush();
    } finally {
      await transcript.close();
    }
    return {
      id,
      title: entry.title,
      prompt: "",
      cwd: entry.cwd,
      mode: "cli",
      model,
      effort,
      bucket: "codex",
      state: "completed",
      interactive: true,
      archived: entry.archived,
      threadId,
      importedRollout: rollout,
      historySource: {
        threadId: entry.threadId,
        source: entry.source,
        issue,
      },
      rotations: 0,
      createdAt: entry.updatedAt,
      updatedAt: entry.updatedAt,
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
    };
  }
}
