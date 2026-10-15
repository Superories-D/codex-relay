import { promises as fs } from "node:fs";
import path from "node:path";
// Reads complete new JSONL records only. UTF-8 decoding happens AFTER a full
// line is assembled so split multibyte output cannot corrupt the transcript.
export class TranscriptTail {
  private offset = 0;
  private pending = Buffer.alloc(0);
  constructor(readonly file: string) {}
  async seekEnd() {
    this.offset = (await fs.stat(this.file)).size;
    this.pending = Buffer.alloc(0);
  }
  async read(): Promise<any[]> {
    const handle = await fs.open(this.file, "r");
    try {
      const stat = await handle.stat();
      if (stat.size < this.offset)
        throw new Error("会话文件被截断，拒绝从头重复处理");
      const length = Math.min(stat.size - this.offset, 4 * 1024 * 1024);
      if (!length) return [];
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      this.pending = Buffer.concat([
        this.pending,
        buffer.subarray(0, bytesRead),
      ]);
      if (this.pending.length > 16 * 1024 * 1024)
        throw new Error("会话记录过大，停止自动操作");
      const end = this.pending.lastIndexOf(10);
      if (end < 0) return [];
      const lines = this.pending.subarray(0, end).toString("utf8").split("\n");
      this.pending = this.pending.subarray(end + 1);
      return lines.filter((l) => l.trim()).map((line) => JSON.parse(line));
    } finally {
      await handle.close();
    }
  }
}
export async function findTranscript(
  home: string,
  threadId: string,
  includeArchived = false,
): Promise<string> {
  let visited = 0;
  async function walk(dir: string): Promise<string | undefined> {
    if (++visited > 5000) throw new Error("会话目录过大，无法安全定位");
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = await walk(full);
        if (hit) return hit;
      } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
        const handle = await fs.open(full, "r");
        const buf = Buffer.alloc(128 * 1024);
        try {
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
          const first = JSON.parse(
            buf.subarray(0, bytesRead).toString().split("\n")[0],
          );
          if (first.type === "session_meta" && first.payload?.id === threadId)
            return full;
        } finally {
          await handle.close();
        }
      }
    }
  }
  const file =
    (await walk(path.join(home, "sessions"))) ||
    (includeArchived
      ? await walk(path.join(home, "archived_sessions"))
      : undefined);
  if (!file)
    throw new Error("受管目录内未找到该会话，客户端版本可能忽略 CODEX_HOME");
  return file;
}
