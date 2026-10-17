import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { HistoryEntry, Job } from "../shared/types";
import { Store } from "./store";
import { Chats, jsonLines, rolloutRecords } from "./chat";

export class History {
  private entries = new Map<
    string,
    { entry: HistoryEntry; file: string; home: string }
  >();
  private busy = false;
  constructor(
    private store: Store,
    private chats: Chats,
  ) {}
  async scan(homes?: string[]) {
    if (this.busy) throw new Error("正在导入历史，请稍后扫描");
    this.entries.clear();
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
          if (r.id && r.thread_name) titles.set(r.id, r.thread_name);
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
              for await (const row of jsonLines(real)) {
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
                cwd: meta.cwd ?? "",
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
            } catch (e) {
              warnings.push(`${f.name}：${String(e)}`);
            }
          }
        }
      };
      await walk(path.join(home, "sessions"));
      await walk(path.join(home, "archived_sessions"));
    }
    return {
      entries: [...this.entries.values()]
        .map((x) => x.entry)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      roots,
      warnings,
    };
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
        const { entry, file } = found;
        if (
          this.store.data.jobs.some(
            (j) => j.historySource?.threadId === entry.threadId,
          )
        ) {
          skipped.push(entry.title);
          continue;
        }
        try {
          const job = await this.copy(file, entry);
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
    }
  }
  async copy(file: string, entry: HistoryEntry): Promise<Job> {
    const id = randomUUID(),
      threadId = randomUUID(),
      home = this.store.jobHome(id);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const realHome = await fs.realpath(home);
    const snapshot = path.join(realHome, "import-source.jsonl");
    // Snapshot only complete records at the initial size. Appending source processes
    // are untouched; source truncation/replacement is detected before committing.
    const stat = await fs.stat(file);
    await fs.copyFile(file, snapshot);
    const after = await fs.stat(file);
    if (
      after.ino !== stat.ino ||
      after.size < stat.size ||
      (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)
    )
      throw new Error("源会话已改变，请重新导入");
    const handle = await fs.open(snapshot, "r+");
    try {
      await handle.truncate(stat.size);
      let end = stat.size,
        found = false;
      while (end > 0 && !found) {
        const start = Math.max(0, end - 65536),
          b = Buffer.alloc(end - start);
        await handle.read(b, 0, b.length, start);
        const newline = b.lastIndexOf(10);
        if (newline >= 0) {
          await handle.truncate(start + newline + 1);
          found = true;
        } else end = start;
      }
      if (!found) throw new Error("会话没有完整记录");
    } finally {
      await handle.close();
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
    let model = "",
      effort = "";
    try {
      let first = true;
      for await (const row of jsonLines(snapshot)) {
        if (first) {
          if (row.type !== "session_meta" || row.payload?.id !== entry.threadId)
            throw new Error("会话身份发生变化");
          row.payload.id = threadId;
          first = false;
        }
        if (row.type === "turn_context") {
          if (typeof row.payload?.model === "string") model = row.payload.model;
          const level = row.payload?.effort ?? row.payload?.reasoning_effort;
          if (typeof level === "string") effort = level;
        }
        await out.writeFile(JSON.stringify(row) + "\n");
      }
      await out.sync();
    } finally {
      await out.close();
    }
    await fs.mkdir(path.dirname(this.chats.file(id)), { recursive: true });
    const transcript = await fs.open(this.chats.file(id), "wx", 0o600);
    try {
      for await (const item of rolloutRecords(snapshot))
        await transcript.writeFile(JSON.stringify(item) + "\n");
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
        issue: entry.issue,
      },
      rotations: 0,
      createdAt: entry.updatedAt,
      updatedAt: entry.updatedAt,
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
    };
  }
}
