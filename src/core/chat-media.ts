import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { ChatItem } from "../shared/types";
import { atomicWrite } from "./store";
export async function persistImages(
  root: string,
  item: ChatItem,
  options?: { copyFilesFrom: string; copies?: Map<string, string> },
): Promise<ChatItem> {
  if (
    !item.images?.length ||
    (!options && !item.images.some((image) => image.data))
  )
    return item;
  const images = [];
  for (const image of item.images) {
    if (!image.data) {
      if (options && image.path) {
        try {
          const source = await fs.realpath(
            path.resolve(options.copyFilesFrom, image.path),
          );
          const stat = await fs.stat(source);
          if (stat.isFile() && stat.size <= 64 * 1024 * 1024) {
            const key = `${source}:${stat.size}:${stat.mtimeMs}`;
            let copied = options.copies?.get(key);
            if (!copied) {
              const bytes = await fs.readFile(source);
              copied = path.join(
                root,
                "media",
                `${createHash("sha256").update(bytes).digest("hex")}${path.extname(source).toLowerCase() || ".png"}`,
              );
              try {
                await fs.access(copied);
              } catch {
                await atomicWrite(copied, bytes);
              }
              options.copies?.set(key, copied);
            }
            images.push({ ...image, path: copied });
            continue;
          }
        } catch {
          /* Retain the original reference so a missing asset remains visible. */
        }
      }
      images.push(image);
      continue;
    }
    const match = image.data.match(
      /^data:(image\/(?:png|jpeg|webp|gif|avif|bmp));base64,([A-Za-z0-9+/\r\n]*={0,2})$/,
    );
    if (!match || match[2].length > 89478488) {
      images.push({ ...image, data: undefined });
      continue;
    }
    const bytes = Buffer.from(match[2], "base64");
    const ext = match[1].split("/")[1].replace("jpeg", "jpg");
    const file = path.join(
      root,
      "media",
      `${createHash("sha256").update(bytes).digest("hex")}.${ext}`,
    );
    try {
      await fs.access(file);
    } catch {
      await atomicWrite(file, bytes);
    }
    const { data, ...reference } = image;
    images.push({ ...reference, path: file, mime: match[1] });
  }
  return { ...item, images };
}
