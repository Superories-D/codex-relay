import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatItem, ChatPage } from "../shared/types";
import { redact } from "./redact";

// Conversations are stored separately from the bounded diagnostic log and snapshots.
export class Chats {
  private writes = new Map<string, Promise<void>>();
  private live = new Map<string, Map<string, ChatItem>>();
  private events = new Map<string, Promise<void>>();
  private cache = new Map<
    string,
    { stamp: string; rows: ChatItem[]; positions: Map<string, number> }
  >();
  private prepared = new Set<string>();
  constructor(private root: string) {}
  file(id: string) {
    return path.join(this.root, "chats", `${id}.jsonl`);
  }
  append(id: string, item: ChatItem) {
    const next = (this.writes.get(id) ?? Promise.resolve()).then(async () => {
      await fs.mkdir(path.dirname(this.file(id)), {
        recursive: true,
        mode: 0o700,
      });
      if (!this.prepared.has(id)) {
        try {
          const handle = await fs.open(this.file(id), "r+");
          try {
            let end = (await handle.stat()).size;
            while (end > 0) {
              const start = Math.max(0, end - 65536),
                b = Buffer.alloc(end - start);
              await handle.read(b, 0, b.length, start);
              const newline = b.lastIndexOf(10);
              if (newline >= 0) {
                await handle.truncate(start + newline + 1);
                break;
              }
              end = start;
              if (!end) await handle.truncate(0);
            }
          } finally {
            await handle.close();
          }
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
        this.prepared.add(id);
      }
      const cached = this.cache.get(id);
      const before = cached
        ? await fs.stat(this.file(id)).catch(() => undefined)
        : undefined;
      await fs.appendFile(this.file(id), JSON.stringify(item) + "\n", {
        mode: 0o600,
      });
      // Our append can update the loaded journal without reparsing its history.
      // An external edit or repaired crash tail invalidates that shortcut.
      if (
        cached &&
        before &&
        cached.stamp === `${before.size}:${before.mtimeMs}`
      ) {
        const position = cached.positions.get(item.id);
        if (position === undefined) {
          cached.positions.set(item.id, cached.rows.length);
          cached.rows.push(item);
        } else cached.rows[position] = item;
        const after = await fs.stat(this.file(id));
        cached.stamp = `${after.size}:${after.mtimeMs}`;
      } else this.cache.delete(id);
    });
    this.writes.set(id, next);
    return next;
  }
  user(id: string, text: string, detail?: string) {
    return this.append(id, {
      id: randomUUID(),
      role: "user",
      kind: "message",
      text,
      detail,
      at: Date.now(),
    });
  }
  event(id: string, method: string, p: any) {
    const next = (this.events.get(id) ?? Promise.resolve()).then(() =>
      this.reduce(id, method, p),
    );
    this.events.set(id, next);
    return next;
  }
  private async reduce(id: string, method: string, p: any) {
    const live = this.live.get(id) ?? new Map<string, ChatItem>();
    this.live.set(id, live);
    const key = `${p.turnId ?? ""}:${p.item?.id ?? p.itemId ?? p.item?.type ?? method}`;
    if (method === "item/started" || method === "item/completed") {
      const item = p.item;
      if (!item || item.type === "userMessage") return;
      const converted = protocolItem(item, key);
      converted.turnId = p.turnId;
      converted.status =
        method === "item/completed" ? (item.status ?? "completed") : "running";
      if (method === "item/completed") {
        await this.append(id, converted);
        live.delete(key);
      } else live.set(key, converted);
    } else if (
      method === "item/agentMessage/delta" ||
      method === "item/commandExecution/outputDelta" ||
      method === "item/reasoning/summaryTextDelta"
    ) {
      const item =
        live.get(key) ??
        ({
          id: key,
          role: method.includes("agentMessage") ? "assistant" : "tool",
          kind: method.split("/")[1],
          text: "",
          at: Date.now(),
          status: "running",
        } as ChatItem);
      item.text += String(p.delta ?? "");
      live.set(key, item);
    } else if (method === "turn/diff/updated") {
      await this.append(id, {
        id: `${p.turnId}:diff`,
        role: "tool",
        kind: "diff",
        text: "文件变更",
        detail: p.diff,
        at: Date.now(),
      });
    } else if (method === "turn/plan/updated") {
      await this.append(id, {
        id: `${p.turnId}:plan`,
        role: "tool",
        kind: "plan",
        text: p.explanation || "执行计划",
        detail: JSON.stringify(p.plan, null, 2),
        at: Date.now(),
      });
    }
  }
  async flush(id: string) {
    await this.events.get(id);
    for (const item of this.live.get(id)?.values() ?? [])
      await this.append(id, { ...item, status: "interrupted" });
    this.live.delete(id);
    await this.writes.get(id);
  }
  async read(id: string, before?: number): Promise<ChatPage> {
    await this.events.get(id);
    await this.writes.get(id);
    let base: ChatItem[] = [];
    let positions = new Map<string, number>();
    try {
      const stat = await fs.stat(this.file(id)),
        stamp = `${stat.size}:${stat.mtimeMs}`;
      const cached = this.cache.get(id);
      if (cached?.stamp === stamp) {
        base = cached.rows;
        positions = cached.positions;
      } else {
        const rows = new Map<string, ChatItem>();
        for await (const row of jsonLines(this.file(id))) rows.set(row.id, row);
        base = [...rows.values()];
        positions = new Map(base.map((item, index) => [item.id, index]));
        this.cache.delete(id);
        this.cache.set(id, { stamp, rows: base, positions });
        while (this.cache.size > 3)
          this.cache.delete(this.cache.keys().next().value!);
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const live = this.live.get(id);
    const extra = [...(live?.values() ?? [])].filter(
      (item) => !positions.has(item.id),
    );
    const total = base.length + extra.length;
    const end = Math.min(before ?? total, total),
      start = Math.max(0, end - 80);
    return {
      items: Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        return index < base.length
          ? (live?.get(base[index].id) ?? base[index])
          : extra[index - base.length];
      }),
      total,
      ...(start ? { before: start } : {}),
    };
  }
}
export function protocolItem(p: any, id: string): ChatItem {
  if (p.type === "userMessage")
    return {
      id,
      role: "user",
      kind: "message",
      at: Date.now(),
      text: (p.content ?? [])
        .map(
          (part: any) =>
            part.text ??
            (part.type === "localImage" ? "[图片附件]" : (part.name ?? "")),
        )
        .join("\n"),
      detail:
        (p.content ?? [])
          .map((part: any) => part.path)
          .filter(Boolean)
          .join("\n") || undefined,
    };
  const text =
    p.text ??
    (p.type === "commandExecution"
      ? p.command
      : p.type === "fileChange"
        ? "编辑文件"
        : p.type === "collabAgentToolCall"
          ? (
              {
                spawnAgent: "派出子代理",
                sendInput: "向子代理发送消息",
                wait: "等待子代理",
                closeAgent: "关闭子代理",
                resumeAgent: "恢复子代理",
              } as Record<string, string>
            )[p.tool] || p.tool
          : p.type === "subAgentActivity"
            ? `子代理 · ${p.agentPath}`
            : p.type === "mcpToolCall"
              ? `${p.server} / ${p.tool}`
              : p.type === "reasoning"
                ? (p.summary ?? []).join("\n")
                : p.type);
  const detail =
    p.type === "agentMessage"
      ? undefined
      : (p.aggregatedOutput ?? JSON.stringify(p, null, 2));
  return {
    id,
    role: p.type === "agentMessage" ? "assistant" : "tool",
    kind: p.type,
    text: String(text ?? ""),
    detail: detail ? redact(detail) : undefined,
    at: Date.now(),
    ...([
      "fileChange",
      "collabAgentToolCall",
      "subAgentActivity",
      "webSearch",
      "imageGeneration",
      "imageView",
      "plan",
    ].includes(p.type)
      ? { data: p }
      : {}),
  };
}
export async function* jsonLines(
  file: string,
  bytes?: number,
  maxRecordBytes = 16 * 1024 * 1024,
) {
  if (bytes === 0) return;
  const stream = createReadStream(file, {
    ...(bytes === undefined ? {} : { end: bytes - 1 }),
  });
  let chunks: Buffer[] = [],
    pendingBytes = 0,
    first = true;
  try {
    for await (const chunk of stream) {
      let start = 0,
        end: number;
      while ((end = chunk.indexOf(10, start)) >= 0) {
        const part = chunk.subarray(start, end);
        pendingBytes += part.length;
        if (pendingBytes > maxRecordBytes)
          throw new Error(`单条历史记录超过 ${maxRecordBytes / 1048576} MiB`);
        let line = chunks.length
          ? Buffer.concat([...chunks, part], pendingBytes).toString("utf8")
          : part.toString("utf8");
        chunks = [];
        pendingBytes = 0;
        start = end + 1;
        if (first) {
          line = line.replace(/^\uFEFF/, "");
          first = false;
        }
        if (line.trim()) yield JSON.parse(line);
      }
      if (start < chunk.length) {
        const remaining = chunk.subarray(start);
        chunks.push(remaining);
        pendingBytes += remaining.length;
      }
      if (pendingBytes > maxRecordBytes)
        throw new Error(`单条历史记录超过 ${maxRecordBytes / 1048576} MiB`);
    }
    // A crash or concurrent writer may leave a partial final record. Only
    // newline-terminated records belong to a committed snapshot.
  } finally {
    stream.destroy();
  }
}
export async function* rolloutRecords(
  file: string,
  maxRecordBytes = 16 * 1024 * 1024,
) {
  let total = 0;
  for await (const r of jsonLines(file, undefined, maxRecordBytes)) {
    const p = r.payload;
    if (r.type !== "response_item" || !p) continue;
    let item: ChatItem | undefined;
    if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
      const text = (p.content ?? [])
        .map(
          (x: any) => x.text ?? (x.type?.includes("image") ? "[图片附件]" : ""),
        )
        .join("\n");
      item = {
        id: `history:${total}`,
        role: p.role,
        kind: "message",
        text,
        at: Date.parse(r.timestamp) || 0,
      };
    } else if (
      [
        "function_call",
        "custom_tool_call",
        "function_call_output",
        "custom_tool_call_output",
        "web_search_call",
      ].includes(p.type)
    ) {
      const rawValue =
        typeof p.output === "string"
          ? p.output
          : (p.arguments ?? p.input ?? JSON.stringify(p));
      const rawDetail =
        typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
      item = {
        id: `history:${total}`,
        role: "tool",
        kind: p.type,
        text: p.name ?? (p.type.endsWith("output") ? "工具结果" : "搜索"),
        detail: redact(rawDetail.slice(0, 262144)),
        ...(rawDetail.length > 262144 ? { sourceTruncated: true } : {}),
        at: Date.parse(r.timestamp) || 0,
      };
    }
    if (item) {
      const previewLimit = 262144;
      if (item.text.length > previewLimit) {
        item.text = item.text.slice(0, previewLimit);
        item.sourceTruncated = true;
      }
      if (item.detail && item.detail.length > previewLimit) {
        item.detail = item.detail.slice(0, previewLimit);
        item.sourceTruncated = true;
      }
      total++;
      yield item;
    }
  }
}
export async function rolloutItems(
  file: string,
  before?: number,
): Promise<ChatPage> {
  const rows: ChatItem[] = [];
  let total = 0;
  for await (const item of rolloutRecords(file)) {
    total++;
    if (before === undefined || total <= before) {
      rows.push(item);
      if (rows.length > 80) rows.shift();
    }
  }
  const end = Math.min(before ?? total, total),
    start = Math.max(0, end - rows.length);
  return { items: rows, total, ...(start ? { before: start } : {}) };
}
