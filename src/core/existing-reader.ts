import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { ExistingCandidate, Quota } from "../shared/types";
import { errorKind, isExhausted, parseQuotas } from "./quota";

export const MAX_SESSION_BYTES = 128 * 1024 * 1024;
export interface SessionRead {
  candidate: ExistingCandidate;
  file: string;
  home: string;
  stamp: string;
  turnId?: string;
  terminal: boolean;
  finalText: string;
  quota: boolean;
  quotas: Record<string, Quota>;
  lastPrompt: string;
}
export function fileStamp(stat: {
  size: number;
  mtimeMs: number;
  ino: number;
}) {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}
function records(buffer: Buffer) {
  const end = buffer.lastIndexOf(10);
  if (end < 0) return [];
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(buffer.subarray(0, end))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error("会话含有损坏的完整记录，暂不接入");
  }
}
interface FoldState {
  turnId?: string;
  terminal: boolean;
  quota: boolean;
  finalText: string;
  lastPrompt: string;
  model: string;
  cwd: string;
  interrupted: boolean;
  hadError: boolean;
  quotas: Record<string, Quota>;
}
export function foldSession(events: any[], initial?: FoldState): FoldState {
  let {
    turnId,
    terminal,
    quota,
    finalText,
    lastPrompt,
    model,
    cwd,
    interrupted,
    hadError,
    quotas,
  } = initial ?? {
    terminal: false,
    quota: false,
    finalText: "",
    lastPrompt: "",
    model: "",
    cwd: "",
    interrupted: false,
    hadError: false,
    quotas: {},
  };
  for (const event of events) {
    const p = event.payload;
    if (!p || typeof p !== "object") continue;
    if (event.type === "turn_context") {
      if (typeof p.model === "string") model = p.model;
      if (typeof p.cwd === "string") cwd = p.cwd;
    }
    if (event.type !== "event_msg") continue;
    if (p.type === "task_started" || p.type === "turn_started") {
      turnId = typeof p.turn_id === "string" ? p.turn_id : undefined;
      terminal = quota = interrupted = hadError = false;
      finalText = "";
      quotas = {};
    }
    if (p.turn_id && turnId && p.turn_id !== turnId) continue;
    if (p.type === "user_message" && typeof p.message === "string")
      lastPrompt = p.message.slice(0, 100000);
    if (p.type === "error") {
      hadError = true;
      if (errorKind(p) === "quota") quota = true;
    }
    if (p.type === "token_count" && p.rate_limits) {
      const q = p.rate_limits;
      const adapt = (w: any) =>
        w
          ? {
              usedPercent: w.used_percent,
              windowDurationMins: w.window_minutes,
              resetsAt: w.resets_at,
            }
          : null;
      quotas = {
        ...quotas,
        ...parseQuotas(
          {
            rateLimits: {
              limitId: q.limit_id ?? "codex",
              primary: adapt(q.primary),
              secondary: adapt(q.secondary),
              rateLimitReachedType: q.rate_limit_reached_type,
              spendControlReached: q.spend_control_reached,
            },
          },
          Date.now(),
          quotas,
          true,
        ),
      };
      // Only the main Codex bucket drives an imported job; unrelated limits do not.
      if (isExhausted(quotas.codex)) quota = true;
    }
    if (
      p.type === "agent_message" &&
      (p.phase == null || p.phase === "final_answer")
    )
      finalText =
        typeof p.message === "string" ? p.message.slice(0, 200000) : "";
    if (["task_complete", "turn_complete", "turn_aborted"].includes(p.type)) {
      if (!p.turn_id || (turnId && p.turn_id !== turnId)) continue;
      turnId = p.turn_id;
      terminal = true;
      interrupted = p.type === "turn_aborted";
      if (p.error) {
        hadError = true;
        if (errorKind(p.error) === "quota") quota = true;
      }
      if (typeof p.last_agent_message === "string")
        finalText = p.last_agent_message.slice(0, 200000);
    }
  }
  return {
    turnId,
    terminal,
    quota,
    quotas,
    finalText,
    lastPrompt,
    model,
    cwd,
    interrupted,
    hadError,
  };
}
// Cache only folded state and the last complete line offset, never raw history.
// A large turn can span many MiB: tail-only reads would forget its earlier quota error.
const reads = new Map<
  string,
  {
    stamp: string;
    size: number;
    ino: number;
    birth: number;
    offset: number;
    meta: any;
    state: FoldState;
  }
>();
async function readFold(file: string, stat: Stats) {
  const cached = reads.get(file);
  if (cached?.stamp === fileStamp(stat)) return cached;
  const prior =
    cached &&
    cached.ino === stat.ino &&
    cached.birth === stat.birthtimeMs &&
    stat.size > cached.size
      ? cached
      : undefined;
  let offset = prior?.offset ?? 0,
    position = offset;
  let state = prior?.state ?? foldSession([]),
    meta = prior?.meta;
  let pending = Buffer.alloc(0);
  const handle = await fs.open(file, "r");
  try {
    while (position < stat.size) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, stat.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) throw new Error("会话正在被替换，请重新扫描");
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      if (pending.length > 16 * 1024 * 1024)
        throw new Error("单条会话记录过大，停止接入");
      const end = pending.lastIndexOf(10);
      if (end < 0) continue;
      const events = records(pending.subarray(0, end + 1));
      if (!meta && events.length) {
        const first = events[0],
          p = first.payload ?? {};
        // Session metadata may contain huge instruction/tool definitions; do not cache them.
        meta = {
          type: first.type,
          payload: {
            id: p.id,
            cwd: p.cwd,
            source: typeof p.source === "string" ? p.source : "subagent",
            history_base: !!p.history_base,
            parent_thread_id: !!p.parent_thread_id,
            dynamic_tools: p.dynamic_tools?.length ? [true] : [],
          },
        };
      }
      state = foldSession(events, state);
      offset += end + 1;
      pending = Buffer.from(pending.subarray(end + 1));
    }
    const after = await handle.stat();
    if (
      after.ino !== stat.ino ||
      after.size < stat.size ||
      (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)
    )
      throw new Error("会话正在被替换，请重新扫描");
  } finally {
    await handle.close();
  }
  const result = {
    stamp: fileStamp(stat),
    size: stat.size,
    ino: stat.ino,
    birth: stat.birthtimeMs,
    offset,
    meta,
    state,
  };
  reads.delete(file);
  reads.set(file, result);
  while (reads.size > 64) reads.delete(reads.keys().next().value!);
  return result;
}
export async function readSession(
  home: string,
  file: string,
  id: string = randomUUID(),
): Promise<SessionRead> {
  const realHome = await fs.realpath(home),
    realFile = await fs.realpath(file);
  const relative = path.relative(realHome, realFile);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !["sessions", "archived_sessions"].includes(relative.split(path.sep)[0])
  )
    throw new Error("会话路径必须位于所选 Codex 目录的 sessions 内");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("不接入链接或非普通会话文件");
  if (stat.size > MAX_SESSION_BYTES)
    throw new Error("会话超过 128 MiB，请先在官方客户端整理或压缩上下文");
  const { meta, state } = await readFold(realFile, stat);
  if (
    meta?.type !== "session_meta" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      meta.payload?.id ?? "",
    )
  )
    throw new Error("缺少有效的 Codex session_meta");
  const p = meta.payload;
  const prompt = state.lastPrompt;
  const source = typeof p.source === "string" ? p.source : "subagent";
  let issue: string | undefined;
  if (
    p.history_base ||
    p.parent_thread_id ||
    (p.dynamic_tools?.length ?? 0) > 0
  )
    issue = "此会话依赖其他线程或应用专用工具，当前不能独立交接";
  if (source === "subagent") issue = "请选择主会话，不直接接管子代理";
  const cwd = state.cwd || p.cwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd))
    issue = "工作目录不是本机绝对路径（不支持 WSL/远程会话）";
  const candidate: ExistingCandidate = {
    id,
    threadId: p.id,
    title: (prompt || "已有 Codex 会话").replace(/\s+/g, " ").slice(0, 100),
    cwd: typeof cwd === "string" ? cwd : "",
    model: state.model,
    source,
    updatedAt: stat.mtimeMs,
    status: state.quota
      ? "quota"
      : state.terminal
        ? state.interrupted || state.hadError
          ? "interrupted"
          : "completed"
        : state.turnId
          ? "running"
          : "unknown",
    preview: prompt.slice(0, 1500),
    issue,
  };
  return {
    candidate,
    home: realHome,
    file: realFile,
    stamp: fileStamp(stat),
    ...state,
    lastPrompt: prompt,
  };
}
export async function scanSessions(home: string) {
  const files: { file: string; at: number }[] = [];
  const warnings: string[] = [];
  let visited = 0;
  async function walk(dir: string, depth = 0) {
    if (depth > 12 || visited >= 10000) {
      warnings.push("目录扫描达到上限，请选更具体的 Codex 目录");
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e: any) {
      if (e.code !== "ENOENT") warnings.push("部分会话目录无法读取");
      return;
    }
    for (const e of entries) {
      if (++visited > 10000) break;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) await walk(file, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          files.push({ file, at: (await fs.stat(file)).mtimeMs });
        } catch {}
      }
    }
  }
  await walk(path.join(home, "sessions"));
  await walk(path.join(home, "archived_sessions"));
  const sessions: SessionRead[] = [];
  for (const { file } of files.sort((a, b) => b.at - a.at).slice(0, 60)) {
    try {
      sessions.push(await readSession(home, file));
    } catch {
      warnings.push("有会话因记录损坏、格式不支持或过大被跳过");
    }
  }
  if (files.length > 60)
    warnings.push("显示最近 60 个会话，可使用会话 ID 精确查找更早的记录");
  return { sessions, warnings: [...new Set(warnings)] };
}
// Called only after the source process tree has been confirmed stopped.
export async function copyStoppedSession(
  source: SessionRead,
  destination: string,
) {
  const before = await fs.stat(source.file);
  if (fileStamp(before) !== source.stamp)
    throw new Error("原会话在读取后已改变，请重新检查再交接");
  if (before.size > MAX_SESSION_BYTES) throw new Error("会话超过交接容量上限");
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const input = await fs.open(source.file, "r");
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  let pending = Buffer.alloc(0),
    position = 0,
    count = 0,
    state = foldSession([]);
  const hash = createHash("sha256");
  try {
    output = await fs.open(temporary, "wx", 0o600);
    while (position < before.size) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, before.size - position));
      const { bytesRead } = await input.read(chunk, 0, chunk.length, position);
      if (!bytesRead) throw new Error("原会话在复制时被截断");
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      if (pending.length > 16 * 1024 * 1024)
        throw new Error("单条会话记录过大，停止交接");
      const end = pending.lastIndexOf(10);
      if (end < 0) continue;
      const complete = pending.subarray(0, end + 1);
      for (const record of records(complete)) {
        if (count++ === 0) {
          if (
            record.type !== "session_meta" ||
            record.payload?.id !== source.candidate.threadId
          )
            throw new Error("会话身份已改变，交接取消");
          if (
            record.payload?.history_base ||
            record.payload?.parent_thread_id ||
            record.payload?.dynamic_tools?.length
          )
            throw new Error("会话出现外部历史依赖，交接取消");
        }
        state = foldSession([record], state);
      }
      hash.update(complete);
      await output.writeFile(complete);
      pending = Buffer.from(pending.subarray(end + 1));
    }
    if (!count) throw new Error("会话没有完整记录");
    const after = await input.stat();
    if (
      fileStamp(before) !== fileStamp(after) ||
      fileStamp(after) !== fileStamp(await fs.stat(source.file))
    )
      throw new Error("原会话仍在写入，禁止开始第二个任务进程");
    await output.sync();
    await output.close();
    await input.close();
    await fs.rename(temporary, destination);
    return { stamp: fileStamp(after), sha256: hash.digest("hex"), ...state };
  } catch (error) {
    await output?.close().catch(() => {});
    await input.close().catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
