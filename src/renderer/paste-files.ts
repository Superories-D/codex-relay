import type { ChatAttachment } from "../shared/types";

export async function importPastedFiles(
  files: File[],
): Promise<ChatAttachment[]> {
  if (files.length > 20) throw Error("每条消息最多添加 20 个附件");
  if (
    files.some((file) => file.size > 64 * 1024 * 1024) ||
    files.reduce((size, file) => size + file.size, 0) > 128 * 1024 * 1024
  )
    throw Error("单个附件最大 64 MiB，每次添加总计最大 128 MiB");
  const paths = files.map((file) => window.relay.filePath?.(file) || "");
  if (paths.every(Boolean))
    return window.relay.command("chat.attachments.files", { paths }) as Promise<
      ChatAttachment[]
    >;
  const uploaded: { name: string; data: string }[] = [];
  for (const file of files) {
    // FileReader avoids constructing giant JS arrays or blocking on base64 loops.
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () =>
        resolve(String(reader.result).split(",", 2)[1] || "");
      reader.readAsDataURL(file);
    });
    uploaded.push({
      name:
        file.name ||
        (file.type.startsWith("image/") ? "clipboard.png" : "attachment"),
      data,
    });
  }
  return window.relay.command("chat.attachments.upload", {
    files: uploaded,
  }) as Promise<ChatAttachment[]>;
}
