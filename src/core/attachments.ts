import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ChatAttachment } from "../shared/types";

const maxFile = 64 * 1024 * 1024;
const maxBatch = 128 * 1024 * 1024;
export function clipboardFilePaths(data: string) {
  return data.split(/\r?\n/).flatMap((line) => {
    if (!line.trim() || line.startsWith("#")) return [];
    try {
      const url = new URL(line);
      return url.protocol === "file:" ? [fileURLToPath(url)] : [];
    } catch {
      return [];
    }
  });
}

// Keep sent attachments independent of clipboard lifetime and original-file moves.
export class Attachments {
  constructor(private root: string) {}
  private async destination(name: string) {
    const folder = path.join(this.root, "attachments", randomUUID());
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const clean = path
      .basename(name.replace(/\\/g, "/"))
      .replace(/[<>:"|?*\x00-\x1f]/g, "_")
      .slice(-180);
    return path.join(
      folder,
      clean && !/^\.+$/.test(clean) ? clean : "attachment",
    );
  }
  private reference(file: string): ChatAttachment {
    return {
      type: /\.(png|jpe?g|webp|gif)$/i.test(file) ? "localImage" : "mention",
      path: file,
      name: path.basename(file),
    };
  }
  async files(paths: string[]) {
    if (paths.length > 20) throw Error("每条消息最多添加 20 个附件");
    const unique = [...new Set(paths)];
    const sources = [];
    let total = 0;
    for (const file of unique) {
      if (!path.isAbsolute(file)) throw Error("附件路径必须为绝对路径");
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw Error("请粘贴文件，文件夹请通过选择项目打开");
      total += stat.size;
      if (stat.size > maxFile || total > maxBatch)
        throw Error("单个附件最大 64 MiB，每次添加总计最大 128 MiB");
      sources.push({ file, stat });
    }
    const result: ChatAttachment[] = [];
    for (const { file, stat } of sources) {
      const target = await this.destination(path.basename(file));
      try {
        await fs.copyFile(file, target, fs.constants.COPYFILE_EXCL);
        const after = await fs.stat(file),
          copied = await fs.stat(target);
        if (
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          copied.size !== stat.size
        )
          throw Error("复制时原文件已更改，请重新粘贴");
        result.push(this.reference(target));
      } catch (error) {
        await fs.rm(target, { force: true });
        throw error;
      }
    }
    return result;
  }
  async upload(files: { name: string; data: string }[]) {
    if (files.length > 20) throw Error("每条消息最多添加 20 个附件");
    let total = 0;
    const decoded = files.map((file) => {
      if (
        file.data.length > Math.ceil(maxFile / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
      )
        throw Error("附件内容无效或超过 64 MiB");
      const data = Buffer.from(file.data, "base64");
      total += data.length;
      if (data.length > maxFile || total > maxBatch)
        throw Error("单个附件最大 64 MiB，每次添加总计最大 128 MiB");
      return { name: file.name, data };
    });
    const result: ChatAttachment[] = [];
    for (const file of decoded) {
      const target = await this.destination(file.name);
      await fs.writeFile(target, file.data, { flag: "wx", mode: 0o600 });
      result.push(this.reference(target));
    }
    return result;
  }
}
