import { expect, it, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Attachments, clipboardFilePaths } from "../src/core/attachments";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it("copies multiple Unicode files independently of their originals and keeps file/image input types", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-attachments-"));
  roots.push(root);
  const first = path.join(root, "中文 文件.txt"),
    second = path.join(root, "image.png");
  await fs.writeFile(first, "hello 世界");
  await fs.writeFile(second, Buffer.from([1, 2, 3]));
  const attachments = new Attachments(path.join(root, "profile"));
  const paths = clipboardFilePaths(
    `# comment\r\n${pathToFileURL(first).href}\r\nhttps://example.invalid/\r\n${pathToFileURL(second).href}\r\n`,
  );
  expect(paths).toEqual([first, second]);
  const result = await attachments.files([...paths, first]);
  expect(result).toHaveLength(2);
  expect(result.map((f) => f.type)).toEqual(["mention", "localImage"]);
  await fs.unlink(first);
  await fs.unlink(second);
  expect(await fs.readFile(result[0].path, "utf8")).toBe("hello 世界");
  expect(await fs.readFile(result[1].path)).toEqual(Buffer.from([1, 2, 3]));
  const uploaded = await attachments.upload([
    { name: "../../escape.txt", data: Buffer.from("safe").toString("base64") },
  ]);
  expect(path.basename(uploaded[0].path)).toBe("escape.txt");
  expect(
    uploaded[0].path.startsWith(path.join(root, "profile", "attachments")),
  ).toBe(true);
});
it("rejects folders, missing files, oversized batches and invalid uploads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-attachments-"));
  roots.push(root);
  const attachments = new Attachments(root);
  await expect(attachments.files([root])).rejects.toThrow("文件夹");
  await expect(
    attachments.files([path.join(root, "absent")]),
  ).rejects.toThrow();
  await expect(attachments.files(Array(21).fill(root))).rejects.toThrow("20");
  await expect(
    attachments.upload([{ name: "x", data: "!bad" }]),
  ).rejects.toThrow("无效");
  const big = path.join(root, "big");
  const handle = await fs.open(big, "w");
  await handle.truncate(64 * 1024 * 1024 + 1);
  await handle.close();
  await expect(attachments.files([big])).rejects.toThrow("64 MiB");
});
