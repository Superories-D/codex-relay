import { promises as fs } from "node:fs";
import path from "node:path";
import { jsonLines } from "./chat";
import { findTranscript } from "./transcript";
import { TextWriter } from "./text-writer";

type Part = {
  file: string;
  bytes: number;
  stat: Awaited<ReturnType<typeof fs.stat>>;
  meta: any;
  header: any;
};
export class HistoryDependencyError extends Error {}
// Flatten only explicitly bounded, available rollout ancestry. The source is
// read-only and no CLI is started in the user's original profile.
export async function captureRollout(
  file: string,
  home: string,
  destination: string,
  resolve?: (id: string) => string | undefined,
  flatten = true,
  maxRecordBytes = 16 * 1024 * 1024,
) {
  const realHome = await fs.realpath(home),
    parts: Part[] = [],
    seen = new Set<string>();
  let privateTools = false;
  const collect = async (
    file: string,
    bytes?: number,
    expectedId?: string,
  ): Promise<void> => {
    const real = await fs.realpath(file),
      relative = path.relative(realHome, real);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw Error("父会话路径超出来源目录");
    if (seen.has(real) || seen.size >= 32)
      throw new HistoryDependencyError("父会话依赖循环或超过 32 层");
    seen.add(real);
    const stat = await fs.stat(real),
      limit = bytes ?? stat.size;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > stat.size)
      throw Error("父会话记录不完整，无法恢复完整上下文");
    let meta: any, header: any;
    for await (const row of jsonLines(real, limit, maxRecordBytes)) {
      if (row.type !== "session_meta") throw Error("缺少 session_meta");
      header = row;
      meta = row.payload;
      break;
    }
    if (!meta) throw Error("会话没有完整记录");
    if (expectedId && meta.id !== expectedId) throw Error("父会话身份已经改变");
    privateTools ||= !!meta.dynamic_tools?.length;
    const base = meta.history_base;
    if (
      flatten &&
      base &&
      !(
        base.end_ordinal_exclusive === 0 &&
        (base.end_byte_offset === 0 || base.end_byte_offset == null)
      )
    ) {
      try {
        if (
          !/^[a-f0-9-]{36}$/i.test(base.thread_id || "") ||
          !Number.isSafeInteger(base.end_byte_offset) ||
          base.end_byte_offset <= 0
        )
          throw Error("父会话缺少可验证的历史边界");
        const parent =
          resolve?.(base.thread_id) ??
          (await findTranscript(realHome, base.thread_id, true));
        const handle = await fs.open(parent, "r");
        try {
          const last = Buffer.alloc(1);
          const result = await handle.read(
            last,
            0,
            1,
            base.end_byte_offset - 1,
          );
          if (result.bytesRead !== 1 || last[0] !== 10)
            throw Error("父会话历史边界不是完整记录");
        } finally {
          await handle.close();
        }
        await collect(parent, base.end_byte_offset, base.thread_id);
      } catch (error) {
        throw new HistoryDependencyError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    parts.push({ file: real, bytes: limit, stat, meta, header });
  };
  await collect(file);
  const out = await fs.open(destination, "wx", 0o600);
  const writer = new TextWriter(out);
  try {
    const meta = structuredClone(parts.at(-1)!.meta);
    const flattened = flatten && !!meta.history_base;
    if (flattened) {
      delete meta.history_base;
      delete meta.forked_from_id;
      delete meta.forked_from_ordinal_exclusive;
    }
    await writer.write(
      JSON.stringify({ ...parts.at(-1)!.header, payload: meta }) + "\n",
    );
    for (const part of parts) {
      let first = true;
      for await (const row of jsonLines(
        part.file,
        part.bytes,
        maxRecordBytes,
      )) {
        if (first) {
          first = false;
          continue;
        }
        await writer.write(JSON.stringify(row) + "\n");
      }
      const after = await fs.stat(part.file);
      if (
        after.ino !== part.stat.ino ||
        after.size < part.stat.size ||
        (after.size === part.stat.size && after.mtimeMs !== part.stat.mtimeMs)
      )
        throw Error("源会话已改变，请重新导入");
    }
    await writer.flush();
    await out.sync();
    return { flattened, privateTools, meta };
  } finally {
    await out.close();
  }
}
