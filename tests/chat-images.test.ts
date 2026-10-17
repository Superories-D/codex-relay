import { it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Chats, protocolItem, rolloutRecords } from "../src/core/chat";
import { protocolImages } from "../src/shared/chat-images";
import { persistImages } from "../src/core/chat-media";
const roots: string[] = [];
it("retains independent copies of imported local images even if the source app removes its image cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-media-"));
  roots.push(root);
  const source = path.join(root, "original.png"),
    bytes = Buffer.from("image snapshot");
  await fs.writeFile(source, bytes);
  const copied = await persistImages(
    path.join(root, "profile"),
    protocolItem({ type: "imageView", id: "v", path: source }, "view"),
    { copyFilesFrom: root, copies: new Map() },
  );
  expect(copied.images?.[0].path).not.toBe(source);
  await fs.unlink(source);
  expect(await fs.readFile(copied.images![0].path!)).toEqual(bytes);
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it("extracts native view/generation, MCP, dynamic and user images without loading remote URLs", () => {
  expect(
    protocolImages({
      type: "imageView",
      id: "v",
      path: "C:\\images\\sample.png",
    })[0],
  ).toMatchObject({ origin: "view", path: "C:\\images\\sample.png" });
  expect(
    protocolImages({
      type: "imageGeneration",
      id: "g",
      savedPath: "C:\\out.png",
      result: "base64",
    })[0].path,
  ).toBe("C:\\out.png");
  expect(
    protocolImages({
      type: "mcpToolCall",
      result: {
        content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
      },
    })[0].data,
  ).toBe("data:image/png;base64,YWJj");
  expect(
    protocolImages({
      type: "dynamicToolCall",
      contentItems: [
        { type: "inputImage", imageUrl: "data:image/png;base64,YWJj" },
      ],
    }),
  ).toHaveLength(1);
  expect(
    protocolImages({
      type: "userMessage",
      content: [{ type: "localImage", path: "C:\\source.png" }],
    })[0].origin,
  ).toBe("input");
  expect(
    protocolImages({
      type: "userMessage",
      content: [{ type: "image", url: "https://example.invalid/test.png" }],
    })[0].url,
  ).toBe("https://example.invalid/test.png");
});
it("persists image bytes separately from live journals, then restores images and full asset lists after restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-media-"));
  roots.push(root);
  const chats = new Chats(root);
  const base64 = Buffer.from("fake-image-bytes".repeat(1000)).toString(
    "base64",
  );
  await chats.event("test", "item/started", {
    turnId: "turn",
    item: {
      type: "imageGeneration",
      id: "g",
      status: "in_progress",
      result: "",
    },
  });
  expect((await chats.read("test")).items[0].status).toBe("running");
  await chats.event("test", "item/completed", {
    turnId: "turn",
    item: {
      type: "imageGeneration",
      id: "g",
      status: "completed",
      result: base64,
    },
  });
  const completed = (await chats.read("test")).items[0];
  expect(completed.images?.[0].data).toBeUndefined();
  expect(await fs.readFile(completed.images![0].path!, "utf8")).toBe(
    "fake-image-bytes".repeat(1000),
  );
  expect((await fs.stat(chats.file("test"))).size).toBeLessThan(3000);
  await chats.user("test", "Look at this", path.join(root, "source.png"));
  for (let i = 0; i < 100; i++)
    await chats.append(
      "test",
      protocolItem(
        {
          type: "fileChange",
          id: `f${i}`,
          changes: [{ path: `file-${i}.ts` }],
        },
        `f${i}`,
      ),
    );
  const reopened = new Chats(root);
  expect((await reopened.read("test")).items).toHaveLength(80);
  const assets = await reopened.assets("test");
  expect(assets.outputs).toHaveLength(101);
  expect(assets.sources).toHaveLength(1);
  expect((await reopened.item("test", "turn:g"))?.images?.[0].path).toBe(
    completed.images?.[0].path,
  );
});
it("preserves images in imported tool outputs, viewed-file calls and native image-generation rollout records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-media-"));
  roots.push(root);
  const file = path.join(root, "source.jsonl");
  const records = [
    {
      type: "function_call",
      name: "functions.view_image",
      arguments: JSON.stringify({ path: "C:\\view.png" }),
    },
    {
      type: "function_call_output",
      output: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    },
    {
      type: "image_generation_call",
      id: "g",
      status: "completed",
      result: "YWJj",
    },
  ];
  await fs.writeFile(
    file,
    records
      .map((payload) =>
        JSON.stringify({
          type: "response_item",
          timestamp: new Date().toISOString(),
          payload,
        }),
      )
      .join("\n") + "\n",
  );
  const items = [];
  for await (const item of rolloutRecords(file)) items.push(item);
  expect(items).toHaveLength(3);
  expect(items[0].images?.[0].origin).toBe("view");
  expect(items[1].images?.[0].data).toBe("data:image/png;base64,YWJj");
  expect(items[2].images?.[0].origin).toBe("generated");
});
