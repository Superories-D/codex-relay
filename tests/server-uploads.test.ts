import { it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ServerUploads,
  UPLOAD_LIMIT,
  telegramDownload,
} from "../src/server/uploads";
it("stores immutable upload receipts, rejects conflicting retries, forged references and corrupt bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-upload-"));
  try {
    const uploads = new ServerUploads(root),
      id = randomUUID(),
      data = Buffer.from("payload");
    const first = await uploads.put(id, "../../CON.txt", data);
    expect(first.attachment.path).toContain(
      path.join(root, "remote-uploads", id),
    );
    expect(await uploads.put(id, "../../CON.txt", data)).toEqual(first);
    await expect(uploads.put(id, "other.txt", data)).rejects.toThrow(
      "different content",
    );
    await expect(
      uploads.validate({
        ...first.attachment,
        path: path.join(root, "state.json"),
      }),
    ).rejects.toThrow();
    await expect(
      uploads.put(randomUUID(), "big.txt", Buffer.alloc(UPLOAD_LIMIT + 1)),
    ).rejects.toThrow("8 MiB");
    await fs.writeFile(first.attachment.path, "changed");
    await expect(uploads.read(id)).rejects.toThrow("checksum");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it("streams Telegram downloads with size bounds and rejects path injection before network I/O", async () => {
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("image"));
  try {
    const download = telegramDownload("private-token"),
      signal = new AbortController().signal;
    expect((await download("photos/file_123.jpg", signal)).toString()).toBe(
      "image",
    );
    await expect(download("../auth.json", signal)).rejects.toThrow("Invalid");
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockResolvedValueOnce(new Response(Buffer.alloc(UPLOAD_LIMIT + 1)));
    await expect(download("documents/file_1.txt", signal)).rejects.toThrow(
      "8 MiB",
    );
    mock.mockRejectedValueOnce(Error("private-token"));
    await expect(download("photos/file_123.jpg", signal)).rejects.toThrow(
      "unavailable",
    );
  } finally {
    mock.mockRestore();
  }
});
