import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { redact } from "../core/redact";
import type { ServerRuntime } from "./runtime";
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    !relative ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};
const stamp = (stat: import("node:fs").Stats) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const safeName = (file: string) =>
  path
    .basename(file)
    .replace(/[\\\x00-\x1f]/g, "_")
    .slice(-180);
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 24);
export class ServerAssets {
  constructor(
    private runtime: ServerRuntime,
    private roots: string[],
  ) {}
  private async references(jobId: string) {
    const job = this.runtime.store.data.jobs.find((j) => j.id === jobId);
    if (!job) throw Error("Task not found");
    const assets = await this.runtime.scheduler.chats.assets(jobId);
    return { job, files: [...assets.outputs, ...assets.sources].slice(0, 100) };
  }
  private allowed(file: string) {
    return (
      this.roots.some((root) => inside(root, file)) ||
      inside(path.join(this.runtime.store.root, "media"), file) ||
      inside(path.join(this.runtime.store.root, "remote-uploads"), file)
    );
  }
  async list(jobId: string) {
    const { job, files } = await this.references(jobId),
      result = [];
    for (const asset of files) {
      if (/^https?:/.test(asset.path)) continue;
      try {
        const file = await fs.realpath(path.resolve(job.cwd, asset.path));
        if (!this.allowed(file)) continue;
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.nlink > 1 || stat.size > 8 * 1024 * 1024)
          continue;
        result.push({
          id: digest(jobId + file + stamp(stat)),
          name: safeName(file),
          size: stat.size,
          kind: asset.kind,
          modifiedAt: stat.mtimeMs,
        });
      } catch {}
    }
    return { files: result, limit: 100, maxBytes: 8 * 1024 * 1024 };
  }
  async read(jobId: string, id: string) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw Error("Invalid artifact ID");
    const { job, files } = await this.references(jobId);
    for (const asset of files) {
      if (/^https?:/.test(asset.path)) continue;
      let file: string, stat: import("node:fs").Stats;
      try {
        file = await fs.realpath(path.resolve(job.cwd, asset.path));
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      if (!this.allowed(file) || digest(jobId + file + stamp(stat)) !== id)
        continue;
      const handle = await fs.open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await handle.stat(),
          actual = await fs.realpath(`/proc/self/fd/${handle.fd}`);
        if (
          !this.allowed(actual) ||
          !opened.isFile() ||
          opened.nlink > 1 ||
          opened.size > 8 * 1024 * 1024 ||
          stamp(opened) !== stamp(stat)
        )
          throw Error("Artifact changed; refresh the list");
        const bytes = Buffer.alloc(opened.size);
        let position = 0;
        while (position < bytes.length) {
          const { bytesRead } = await handle.read(
            bytes,
            position,
            bytes.length - position,
            position,
          );
          if (!bytesRead) break;
          position += bytesRead;
        }
        if (
          position !== bytes.length ||
          stamp(await handle.stat()) !== stamp(opened)
        )
          throw Error("Artifact changed during download");
        const decoded = bytes.toString("utf8"),
          isText =
            !decoded.includes("\0") && Buffer.from(decoded).equals(bytes),
          ext = path.extname(file).toLowerCase();
        const mime = (
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
          } as Record<string, string>
        )[ext];
        const content = isText
          ? Buffer.from(redact(decoded, Number.MAX_SAFE_INTEGER))
          : bytes;
        return {
          name: safeName(file),
          mime: isText
            ? "text/plain;charset=utf-8"
            : mime || "application/octet-stream",
          data: content.toString("base64"),
          ...(isText ? { preview: redact(decoded, 10000) } : {}),
          size: content.length,
          redacted: isText,
        };
      } finally {
        await handle.close();
      }
    }
    throw Error(
      "Artifact missing, outside allowed roots, or changed; refresh the list",
    );
  }
}
