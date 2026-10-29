import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { atomicWrite } from "../core/store";
import type { ChatAttachment } from "../shared/types";
export const UPLOAD_LIMIT = 8 * 1024 * 1024;
const receiptSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    sha: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(0).max(UPLOAD_LIMIT),
  })
  .strict();
export class ServerUploads {
  private operations = new Map<string, Promise<unknown>>();
  constructor(private root: string) {}
  private folder(id: string) {
    return path.join(this.root, "remote-uploads", z.string().uuid().parse(id));
  }
  async read(id: string) {
    const folder = this.folder(id),
      receipt = receiptSchema.parse(
        JSON.parse(
          await fs.readFile(path.join(folder, "receipt.json"), "utf8"),
        ),
      );
    if (receipt.id !== id || path.basename(receipt.name) !== receipt.name)
      throw Error("Invalid upload receipt");
    const file = path.join(folder, receipt.name);
    let bytes: Buffer;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size !== receipt.size)
        throw Error("Upload changed or missing");
      bytes = await fs.readFile(file);
    } catch (error: any) {
      // ENOENT is reserved for a missing receipt. Once accepted, a missing
      // payload must never make this request ID available for a new upload.
      if (error.code === "ENOENT")
        throw Error("Upload file missing; original receipt retained");
      throw error;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== receipt.sha)
      throw Error("Upload checksum mismatch");
    return {
      id,
      size: receipt.size,
      attachment: {
        name: receipt.name,
        path: file,
        type: /\.(png|jpe?g|webp|gif)$/i.test(receipt.name)
          ? "localImage"
          : "mention",
      } as ChatAttachment,
    };
  }
  put(id: string, name: string, bytes: Buffer) {
    const task = (this.operations.get(id) || Promise.resolve())
      .catch(() => {})
      .then(() => this.putOnce(id, name, bytes));
    this.operations.set(id, task);
    void task
      .finally(() => {
        if (this.operations.get(id) === task) this.operations.delete(id);
      })
      .catch(() => {});
    return task;
  }
  private async putOnce(id: string, name: string, bytes: Buffer) {
    if (bytes.length > UPLOAD_LIMIT) throw Error("单个附件最大 8 MiB");
    const clean =
      "upload-" +
      (path
        .basename(name.replace(/\\/g, "/"))
        .replace(/[<>:"|?*\x00-\x1f]/g, "_")
        .slice(-160) || "file");
    const folder = this.folder(id),
      sha = createHash("sha256").update(bytes).digest("hex");
    try {
      const existing = await this.read(id);
      const receipt = JSON.parse(
        await fs.readFile(path.join(folder, "receipt.json"), "utf8"),
      );
      if (receipt.sha !== sha || existing.attachment.name !== clean)
        throw Error("Upload request ID was already used for different content");
      return existing;
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(folder, clean), bytes);
    await atomicWrite(
      path.join(folder, "receipt.json"),
      JSON.stringify({ id, name: clean, sha, size: bytes.length }),
    );
    return this.read(id);
  }
  async validate(attachment: ChatAttachment) {
    const relative = path.relative(
        path.join(this.root, "remote-uploads"),
        attachment.path,
      ),
      parts = relative.split(path.sep);
    if (parts.length !== 2) throw Error("Unknown uploaded attachment");
    const result = await this.read(parts[0]);
    if (
      JSON.stringify(result.attachment) !==
      JSON.stringify({
        name: attachment.name,
        path: attachment.path,
        type: attachment.type,
      })
    )
      throw Error("Upload reference changed");
    return result.attachment;
  }
}
export type TelegramDownload = (
  filePath: string,
  signal: AbortSignal,
) => Promise<Buffer>;
export function telegramDownload(token: string): TelegramDownload {
  return async (filePath, signal) => {
    if (
      !/^[A-Za-z0-9_/-]+\.[A-Za-z0-9]+$/.test(filePath) ||
      filePath.split("/").some((p) => !p || p === "..")
    )
      throw Error("Invalid Telegram file path");
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/file/bot${token}/${filePath}`,
        {
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        },
      );
    } catch {
      throw Error("Telegram file download unavailable");
    }
    if (!response.ok || !response.body)
      throw Error("Telegram file download failed");
    if (Number(response.headers.get("content-length")) > UPLOAD_LIMIT) {
      await response.body.cancel();
      throw Error("单个附件最大 8 MiB");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > UPLOAD_LIMIT) throw Error("单个附件最大 8 MiB");
        chunks.push(value);
      }
    } catch {
      throw Error(
        size > UPLOAD_LIMIT
          ? "单个附件最大 8 MiB"
          : "Telegram file download interrupted",
      );
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  };
}
