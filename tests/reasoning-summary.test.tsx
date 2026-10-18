import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { Chats, protocolItem } from "../src/core/chat";
import { RichMessage } from "../src/renderer/RichMessage";
import { setLanguage } from "../src/renderer/i18n";
const roots: string[] = [];
afterEach(async () => {
  setLanguage("zh-CN");
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it("keeps streamed public summary parts when empty completion frames arrive and after restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-summary-"));
  roots.push(root);
  const chats = new Chats(root);
  const p = { threadId: "thread", turnId: "turn", itemId: "r" };
  await chats.event("job", "item/started", {
    ...p,
    item: { type: "reasoning", id: "r", summary: [], content: [] },
  });
  await chats.event("job", "item/reasoning/summaryPartAdded", {
    ...p,
    summaryIndex: 0,
  });
  await chats.event("job", "item/reasoning/summaryTextDelta", {
    ...p,
    summaryIndex: 0,
    delta: "Public ",
  });
  await chats.event("job", "item/reasoning/summaryTextDelta", {
    ...p,
    summaryIndex: 1,
    delta: "要約です。",
  });
  await chats.event("job", "item/reasoning/summaryTextDelta", {
    ...p,
    summaryIndex: 0,
    delta: "summary.",
  });
  expect((await chats.read("job")).items[0].text).toBe(
    "Public summary.\n\n要約です。",
  );
  await chats.event("job", "item/completed", {
    ...p,
    item: { type: "reasoning", id: "r", summary: [], content: [] },
  });
  await chats.flush("job");
  const item = (await new Chats(root).read("job")).items[0];
  expect(item).toMatchObject({
    text: "Public summary.\n\n要約です。",
    kind: "reasoning",
    status: "completed",
    turnId: "turn",
  });
  expect(item.detail).toBeUndefined();
  // Native history hydration can also omit a summary that was streamed.
  await chats.hydrate("job", [{ ...item, text: "" }]);
  expect((await new Chats(root).read("job")).items[0].text).toBe(item.text);
});
it("uses explicit summary text and never falls back to raw reasoning or encrypted fields", () => {
  const item = protocolItem(
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Published summary" }],
      content: ["raw fixture"],
      encrypted_content: "opaque fixture",
    },
    "r",
  );
  expect(item.text).toBe("Published summary");
  expect(item.detail).toBeUndefined();
  const empty = protocolItem(
    { type: "reasoning", summary: [], content: ["raw fixture"] },
    "r",
  );
  expect(empty.text).toBe("");
  expect(empty.detail).toBeUndefined();
});
it("renders an honest localized empty state for legacy JSON details and readable summary markdown", () => {
  const callbacks = {
    onOpen: () => {},
    onAgents: () => {},
    onChanges: () => {},
  };
  const item = {
    id: "r",
    role: "tool" as const,
    kind: "reasoning",
    text: "",
    at: 1,
    status: "completed",
    detail: '{"type":"reasoning","summary":[],"content":[]}',
  };
  for (const language of ["zh-CN", "zh-TW", "en", "ja"] as const) {
    setLanguage(language);
    const html = renderToStaticMarkup(
      <RichMessage {...callbacks} item={item} />,
    );
    expect(html).not.toContain("code-block");
    expect(html).not.toContain("&quot;summary&quot;");
    expect(html).toMatch(/摘要|summary|要約/);
  }
  const html = renderToStaticMarkup(
    <RichMessage
      {...callbacks}
      item={{ ...item, text: "**Public summary**" }}
    />,
  );
  expect(html).toContain("<strong>Public summary</strong>");
});
