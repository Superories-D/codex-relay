import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HistoryEntry, Job } from "../shared/types";
import { Store } from "./store";
import { Chats, protocolItem, jsonLines } from "./chat";
import { TextWriter } from "./text-writer";
import { persistImages } from "./chat-media";
import { Rpc } from "./rpc";
import { redact } from "./redact";
import type { ChatItem } from "../shared/types";

export interface NativeThread {
  home: string;
  state: string;
  history: string;
  row: Record<string, any>;
  entry: HistoryEntry;
}
const uuid = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id);
// Native metadata contains absolute paths from the original home. Never let
// resuming an imported thread append to the source client's rollout files.
export async function rebaseNativeHome(home: string, sourceHome?: string) {
  const names = (await fs.readdir(home)).filter((f) =>
    /^state_\d+\.sqlite$/.test(f),
  );
  const { DatabaseSync } = await import("node:sqlite");
  const realHome = await fs.realpath(home);
  const marker = path.join(realHome, "native-source.json");
  if (!sourceHome)
    try {
      sourceHome = JSON.parse(await fs.readFile(marker, "utf8")).home;
    } catch {}
  sourceHome ||= path.join(os.homedir(), ".codex");
  if (path.resolve(sourceHome).toLowerCase() === realHome.toLowerCase())
    throw Error("来源目录不能是导入副本");
  const originals = new Map(
    (await nativeCatalog(sourceHome).catch(() => undefined))?.threads.map(
      (t) => [t.entry.threadId, t.row.rollout_path],
    ) || [],
  );
  const missing = new Set<string>();
  const copied = new Map<string, string>();
  await fs.writeFile(marker, JSON.stringify({ home: sourceHome }), {
    mode: 0o600,
  });
  for (const name of names) {
    const db = new DatabaseSync(path.join(realHome, name));
    try {
      if (
        !db
          .prepare("PRAGMA table_info(threads)")
          .all()
          .some((r) => r.name === "rollout_path")
      )
        continue;
      await fs.mkdir(path.join(realHome, "sessions", "imported"), {
        recursive: true,
        mode: 0o700,
      });
      await fs.mkdir(path.join(realHome, "archived_sessions", "imported"), {
        recursive: true,
        mode: 0o700,
      });
      const rows = db.prepare("SELECT * FROM threads").all();
      const update = db.prepare("UPDATE threads SET rollout_path=? WHERE id=?");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          if (!uuid(row.id)) continue;
          const relative =
            typeof row.rollout_path === "string"
              ? path.relative(realHome, row.rollout_path)
              : "..";
          const inside =
            relative &&
            !relative.startsWith("..") &&
            !path.isAbsolute(relative);
          const canonical = (value: unknown) =>
            typeof value === "string" &&
            /^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-[a-f0-9-]{36}\.jsonl$/i.test(
              path.basename(value),
            );
          const original = originals.get(row.id);
          const stamp = new Date(
            Number(row.created_at_ms) ||
              Number(row.created_at) * 1000 ||
              Date.now(),
          )
            .toISOString()
            .slice(0, 19)
            .replace(/:/g, "-");
          const target =
            inside && canonical(row.rollout_path)
              ? String(row.rollout_path)
              : path.join(
                  realHome,
                  row.archived ? "archived_sessions" : "sessions",
                  ...stamp.slice(0, 10).split("-"),
                  canonical(original)
                    ? path.basename(original)
                    : `rollout-${stamp}-${row.id}.jsonl`,
                );
          await fs.mkdir(path.dirname(target), {
            recursive: true,
            mode: 0o700,
          });
          try {
            await fs.access(target);
          } catch {
            const source =
              inside &&
              typeof row.rollout_path === "string" &&
              (await fs.access(row.rollout_path).then(
                () => true,
                () => false,
              ))
                ? row.rollout_path
                : original ||
                  (target !== row.rollout_path ? row.rollout_path : undefined);
            try {
              if (typeof source !== "string") throw Error("缺少源日志");
              await fs.copyFile(source, target);
            } catch {
              missing.add(row.id);
            }
          }
          update.run(target, row.id);
          if (!missing.has(row.id)) copied.set(row.id, target);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      db.close();
    }
  }
  const parents = new Map<string, any>();
  for (const [id, file] of copied)
    try {
      for await (const row of jsonLines(file)) {
        if (row.type !== "session_meta" || row.payload?.id !== id) {
          missing.add(id);
          break;
        }
        parents.set(id, row.payload?.history_base);
        break;
      }
      if (!parents.has(id)) missing.add(id);
    } catch {
      missing.add(id);
    }
  const complete = async (
    id: string,
    seen = new Set<string>(),
  ): Promise<boolean> => {
    if (missing.has(id) || seen.has(id) || seen.size >= 32) return false;
    const base = parents.get(id);
    if (!base || (base.end_ordinal_exclusive === 0 && !base.end_byte_offset))
      return true;
    if (!uuid(base.thread_id) || !copied.has(base.thread_id)) return false;
    if (
      base.end_byte_offset &&
      (await fs.stat(copied.get(base.thread_id)!)).size < base.end_byte_offset
    )
      return false;
    return complete(base.thread_id, new Set([...seen, id]));
  };
  for (const id of copied.keys()) if (!(await complete(id))) missing.add(id);
  return missing;
}
export function nativeSource(raw: unknown) {
  let source: any = raw;
  try {
    if (typeof raw === "string" && raw.trim().startsWith("{"))
      source = JSON.parse(raw);
  } catch {}
  if (source?.subagent?.other === "guardian") return { source: "review" };
  if (source?.subagent)
    return {
      source: "subagent",
      parentThreadId: source.subagent.thread_spawn?.parent_thread_id,
    };
  return { source: typeof source === "string" ? source : "desktop" };
}
export async function nativeCatalog(home: string) {
  const files = await fs.readdir(home);
  const latest = (pattern: RegExp) =>
    files
      .filter((f) => pattern.test(f))
      .sort(
        (a, b) =>
          Number(b.match(/_(\d+)\./)![1]) - Number(a.match(/_(\d+)\./)![1]),
      )[0];
  const stateName = latest(/^state_\d+\.sqlite$/);
  if (!stateName) return;
  const historyName = latest(/^thread_history_\d+\.sqlite$/),
    state = path.join(home, stateName),
    history = historyName ? path.join(home, historyName) : "";
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(state, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=1000");
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    const projects: { cwd: string; name: string; id: string }[] =
      tables.has("projects") && tables.has("project_roots")
        ? (db
            .prepare(
              "SELECT r.path AS cwd,p.name,p.id FROM projects p JOIN project_roots r ON p.id=r.project_id ORDER BY r.position",
            )
            .all() as any)
        : [];
    const roots = new Map(projects.map((p) => [p.id, p.cwd]));
    const privateTools = new Set(
      tables.has("thread_dynamic_tools")
        ? db
            .prepare("SELECT DISTINCT thread_id FROM thread_dynamic_tools")
            .all()
            .map((r) => r.thread_id)
        : [],
    );
    const threads: NativeThread[] = [];
    for (const row of db.prepare("SELECT * FROM threads").all() as Record<
      string,
      any
    >[]) {
      if (!uuid(row.id)) continue;
      const source = nativeSource(row.source);
      const missingRollout =
        typeof row.rollout_path === "string" &&
        (await fs.access(row.rollout_path).then(
          () => false,
          () => true,
        ));
      const issue =
        !history && row.history_mode === "paginated"
          ? "源客户端的分页消息数据库缺失，只能查看会话信息。"
          : missingRollout
            ? "源会话日志已缺失；已恢复完整缓存供阅读，CLI 续接需要原始日志。"
            : privateTools.has(row.id)
              ? "此会话使用 Desktop 专属工具，可阅读历史；CLI 无法提供原应用工具。"
              : source.source === "subagent"
                ? "子代理记录仅供阅读，请继续主会话。"
                : source.source === "review"
                  ? "这是后台审批记录，仅供查阅。"
                  : undefined;
      threads.push({
        home,
        state,
        history,
        row,
        entry: {
          id: createHash("sha256")
            .update(state + ":" + row.id)
            .digest("hex"),
          threadId: row.id,
          title: row.name || row.title || "Codex 会话",
          cwd: row.cwd || "",
          projectCwd: roots.get(row.project_id),
          source: source.source,
          parentThreadId: uuid(source.parentThreadId)
            ? source.parentThreadId
            : undefined,
          updatedAt: Number(
            row.updated_at_ms || row.updated_at * 1000 || Date.now(),
          ),
          archived: !!row.archived,
          issue,
          storage: "sqlite",
        },
      });
    }
    return { threads, projects };
  } finally {
    db.close();
  }
}

// One native snapshot per source home, shared by imported threads. This retains
// paginated model context without copying auth.json or touching the live source.
export class NativeSnapshots {
  private snapshots = new Map<
    string,
    { id: string; home: string; history?: DatabaseSync; missing: Set<string> }
  >();
  private copies = new Map<string, string>();
  private prepared = new Set<string>();
  private catalogs = new Map<
    string,
    Awaited<ReturnType<typeof nativeCatalog>>
  >();
  private previousImages = new Map<string, ChatItem["images"]>();
  constructor(
    private store: Store,
    private chats: Chats,
    private progress?: (percent: number) => void,
    private cancelled?: () => boolean,
    private cli?: string,
    private warning?: (message: string) => void,
  ) {}
  private async prepare(
    home: string,
    snapshot: { history?: DatabaseSync; missing: Set<string> },
  ) {
    if (this.prepared.has(home)) return;
    this.prepared.add(home);
    if (
      !this.cli ||
      !snapshot.history
        ?.prepare(
          "SELECT name FROM sqlite_master WHERE name='thread_history_projection_state'",
        )
        .get()
    )
      return;
    const catalog = await nativeCatalog(home);
    this.catalogs.set(home, catalog);
    let rpc: Rpc | undefined;
    try {
      await Rpc.assertHomeIdle(home);
      rpc = await Rpc.open(this.cli, home);
      for (const thread of catalog?.threads || []) {
        if (this.cancelled?.()) break;
        if (snapshot.missing.has(thread.entry.threadId)) continue;
        // Ask the native backend to rebuild its cached projection, without
        // returning enormous tool outputs or starting/resuming a model turn.
        try {
          await rpc.call(
            "thread/resume",
            {
              threadId: thread.entry.threadId,
              cwd: home,
              approvalPolicy: "never",
              sandbox: "read-only",
              excludeTurns: true,
              config: { "features.goals": false },
            },
            10000,
          );
          await rpc.call(
            "thread/items/list",
            {
              threadId: thread.entry.threadId,
              limit: 1,
              sortDirection: "asc",
            },
            10000,
          );
        } catch (error) {
          this.warning?.(`原生历史未能重建，保留已保存缓存：${redact(error)}`);
          await rpc.close();
          rpc = await Rpc.open(this.cli, home);
        }
      }
    } catch (error) {
      this.warning?.(
        `原生分页历史重建不可用，保留已保存缓存：${redact(error)}`,
      );
      // Cached messages remain readable if the optional native rebuild is
      // unavailable. Execution still validates the original rollout lineage.
    } finally {
      if (rpc) await rpc.close();
    }
  }
  async refresh(job: Job, home: string): Promise<Job | undefined> {
    let catalog = this.catalogs.get(home);
    if (!catalog) {
      catalog = await nativeCatalog(home);
      this.catalogs.set(home, catalog);
    }
    const native = catalog?.threads.find(
      (t) => t.entry.threadId === job.threadId,
    );
    if (!native) return;
    let snapshot = this.snapshots.get(native.state);
    if (!snapshot) {
      const { DatabaseSync } = await import("node:sqlite");
      snapshot = {
        id: job.runtimeHomeId || job.id,
        home,
        missing: await rebaseNativeHome(home),
        history: new DatabaseSync(native.history, { readOnly: true }),
      };
      this.snapshots.set(native.state, snapshot);
    }
    await this.prepare(home, snapshot);
    const count = Number(
      snapshot.history
        ?.prepare("SELECT COUNT(*) n FROM thread_items WHERE thread_id=?")
        .get(job.threadId!)?.n || 0,
    );
    if (
      job.historySource?.journalVersion === 2 &&
      job.historySource.itemCount === count
    )
      return;
    for await (const old of jsonLines(this.chats.file(job.id)))
      if (old.images?.length) {
        const key =
          old.turnId && !old.id.startsWith(old.turnId + ":")
            ? old.turnId + ":" + old.id
            : old.id;
        this.previousImages.set(key, old.images);
      }
    const fresh = await this.copy(native);
    return {
      ...job,
      id: fresh.id,
      historySource: {
        ...job.historySource!,
        itemCount: count,
        journalVersion: 2,
      },
    };
  }
  async copy(native: NativeThread): Promise<Job> {
    let snapshot = this.snapshots.get(native.state);
    if (!snapshot) {
      const { DatabaseSync, backup } = await import("node:sqlite");
      const id = randomUUID();
      await fs.mkdir(this.store.jobHome(id), { recursive: true, mode: 0o700 });
      const home = await fs.realpath(this.store.jobHome(id));
      for (const file of [native.state, native.history].filter(Boolean)) {
        const source = new DatabaseSync(file, { readOnly: true });
        try {
          await backup(source, path.join(home, path.basename(file)), {
            rate: 128,
            progress: ({ totalPages, remainingPages }) => {
              if (this.cancelled?.()) throw Error("导入已停止");
              this.progress?.(
                totalPages
                  ? Math.round(
                      (100 * (totalPages - remainingPages)) / totalPages,
                    )
                  : 100,
              );
            },
          });
        } finally {
          source.close();
        }
      }
      const missing = await rebaseNativeHome(home, native.home);
      snapshot = {
        id,
        home,
        missing,
        history: native.history
          ? new DatabaseSync(path.join(home, path.basename(native.history)), {
              readOnly: true,
            })
          : undefined,
      };
      this.snapshots.set(native.state, snapshot);
    }
    await this.prepare(snapshot.home, snapshot);
    if (this.cancelled?.()) throw Error("导入已停止");
    const id = randomUUID(),
      entry = native.entry;
    await fs.mkdir(path.dirname(this.chats.file(id)), {
      recursive: true,
      mode: 0o700,
    });
    const file = await fs.open(this.chats.file(id), "wx", 0o600),
      writer = new TextWriter(file);
    let count = 0;
    try {
      if (snapshot.history) {
        const turns = new Map(
          snapshot.history
            .prepare(
              "SELECT turn_id,started_at FROM thread_turns WHERE thread_id=?",
            )
            .all(entry.threadId)
            .map((r) => [r.turn_id, r.started_at]),
        );
        for (const row of snapshot.history
          .prepare(
            "SELECT item_id,turn_id,created_at_ms,item_json FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal",
          )
          .iterate(entry.threadId)) {
          if (this.cancelled?.()) throw Error("导入已停止");
          const raw = JSON.parse(String(row.item_json));
          const item = protocolItem(raw, `${row.turn_id}:${row.item_id}`);
          const savedImages = this.previousImages.get(item.id);
          if (
            savedImages?.length &&
            savedImages.length >= (item.images?.length || 0) &&
            !item.images?.some((image) => image.data || image.url) &&
            (
              await Promise.all(
                savedImages.map((image) =>
                  image.path
                    ? fs.access(image.path).then(
                        () => true,
                        () => false,
                      )
                    : Promise.resolve(!!image.url || !!image.data),
                ),
              )
            ).every(Boolean)
          )
            item.images = savedImages;
          for (const key of ["text", "detail"] as const)
            if (item[key] && item[key]!.length > 262144) {
              item[key] = item[key]!.slice(0, 262144);
              item.sourceTruncated = true;
            }
          if (item.data && JSON.stringify(item.data).length > 262144) {
            item.data = {
              type: raw.type,
              changes: raw.changes?.map((c: any) => ({
                path: c.path,
                kind: c.kind,
              })),
            };
            item.sourceTruncated = true;
          }
          item.turnId = String(row.turn_id);
          const started = turns.get(row.turn_id);
          item.at =
            Number(row.created_at_ms) ||
            (typeof started === "number"
              ? started * 1000
              : typeof started === "string"
                ? Date.parse(started)
                : entry.updatedAt);
          await writer.write(
            JSON.stringify(
              await persistImages(this.store.root, item, {
                copyFilesFrom: entry.cwd,
                copies: this.copies,
              }),
            ) + "\n",
          );
          if (++count % 100 === 0)
            await new Promise<void>((r) => setImmediate(r));
        }
      }
      if (!count)
        await writer.write(
          JSON.stringify({
            id: randomUUID(),
            role: "system",
            kind: "message",
            text: "源客户端尚未保存可读取的消息记录。",
            at: entry.updatedAt,
          }) + "\n",
        );
      await writer.flush();
      await file.sync();
    } finally {
      await file.close();
    }
    return {
      id,
      title: entry.title,
      prompt: "",
      cwd: entry.cwd,
      projectCwd: entry.projectCwd,
      mode: "cli",
      model: native.row.model || "",
      effort: native.row.reasoning_effort || "",
      bucket: "codex",
      state: "completed",
      interactive: true,
      archived: entry.archived,
      threadId: entry.threadId,
      runtimeHomeId: snapshot.id,
      historySource: {
        threadId: entry.threadId,
        source: entry.source,
        storage: "sqlite",
        itemCount: count,
        journalVersion: 2,
        parentThreadId: entry.parentThreadId,
        issue: !count
          ? "源客户端尚未保存可读取的消息记录。"
          : entry.issue ||
            (snapshot.missing.has(entry.threadId)
              ? "源会话日志已缺失；已恢复完整缓存供阅读，CLI 续接需要原始日志。"
              : undefined),
      },
      rotations: 0,
      createdAt: Number(
        native.row.created_at_ms ||
          native.row.created_at * 1000 ||
          entry.updatedAt,
      ),
      updatedAt: entry.updatedAt,
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
    };
  }
  close() {
    for (const s of this.snapshots.values()) s.history?.close();
    this.snapshots.clear();
  }
}

const exportsInProgress = new Map<string, Promise<string>>();
export function exportNativeThread(home: string, threadId: string) {
  const key = home + ":" + threadId;
  const existing = exportsInProgress.get(key);
  if (existing) return existing;
  const task = (async () => {
    if (!uuid(threadId)) throw Error("会话 ID 无效");
    const files = await fs.readdir(home),
      name = files
        .filter((f) => /^thread_history_\d+\.sqlite$/.test(f))
        .sort(
          (a, b) =>
            Number(b.match(/_(\d+)\./)![1]) - Number(a.match(/_(\d+)\./)![1]),
        )[0];
    if (!name) throw Error("分页历史数据库缺失");
    const { DatabaseSync } = await import("node:sqlite"),
      db = new DatabaseSync(path.join(home, name), { readOnly: true });
    await fs.mkdir(path.join(home, "source-exports"), {
      recursive: true,
      mode: 0o700,
    });
    const dir = await fs.realpath(path.join(home, "source-exports")),
      target = path.join(dir, `${threadId}.jsonl`),
      temporary = path.join(dir, `${threadId}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", 0o600),
        writer = new TextWriter(handle);
      try {
        for (const row of db
          .prepare(
            "SELECT turn_id,item_json FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal",
          )
          .iterate(threadId))
          await writer.write(
            JSON.stringify({
              threadId,
              turnId: row.turn_id,
              item: JSON.parse(String(row.item_json)),
            }) + "\n",
          );
        await writer.flush();
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
      return target;
    } finally {
      db.close();
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  })();
  exportsInProgress.set(key, task);
  void task.finally(() => exportsInProgress.delete(key)).catch(() => {});
  return task;
}
