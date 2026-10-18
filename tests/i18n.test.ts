import { afterEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { capabilities } from "../src/shared/capabilities";
import { english } from "../src/renderer/locales/en";
import { japanese } from "../src/renderer/locales/ja";
import {
  formatDate,
  resolveLanguage,
  setLanguage,
  t,
  errorText,
} from "../src/renderer/i18n";

afterEach(() => setLanguage("zh-CN"));
it("shows a readable localized IPC error without rewriting file paths or model output", () => {
  setLanguage("en");
  expect(
    errorText(
      new Error(
        "Error invoking remote method 'relay:command': Error: 会话尚未设置目标",
      ),
    ),
  ).toBe("This chat does not have a goal yet");
  expect(errorText("Error: C:/My Project/Error:notes.txt")).toBe(
    "C:/My Project/Error:notes.txt",
  );
  setLanguage("zh-TW");
  expect(errorText(Error("目标已完成，请设置新的目标"))).toBe(
    "目標已完成，請設定新的目標",
  );
});
it("follows system languages and keeps explicit selections", () => {
  for (const system of ["zh-TW", "zh-HK", "zh-Hant-HK", "zh_MO"])
    expect(resolveLanguage("auto", system)).toBe("zh-TW");
  expect(resolveLanguage("auto", "zh-CN")).toBe("zh-CN");
  expect(resolveLanguage("auto", "fr-FR")).toBe("en");
  expect(resolveLanguage("en", "zh-CN")).toBe("en");
  for (const system of ["ja", "ja-JP", "ja_JP"])
    expect(resolveLanguage("auto", system)).toBe("ja");
  expect(resolveLanguage("ja", "en-US")).toBe("ja");
});
it("translates interface text while preserving interpolated user content", () => {
  setLanguage("en");
  expect(t("新聊天")).toBe("New chat");
  expect(t("{p0} 个匹配的聊天", { p0: "用户原文" })).toBe(
    "用户原文 matching chats",
  );
  expect(t("用户原文和代码")).toBe("用户原文和代码");
  setLanguage("zh-TW");
  expect(t("账户与接力")).toBe("帳戶與接力");
  expect(t("{p0} 个匹配的聊天", { p0: "账户代码" })).toContain("账户代码");
  expect(formatDate(Date.UTC(2026, 9, 18))).toContain("2026");
});
it("covers every static UI key and every public operation label", () => {
  const require = createRequire(import.meta.url);
  const { audit } = require("../scripts/qa/i18n-audit.cjs");
  expect(audit()).toMatchObject({ missing: [], unlocalized: [] });
  expect(audit("ja")).toMatchObject({ missing: [], unlocalized: [] });
  for (const operation of capabilities)
    expect(english[operation.label], operation.label).toBeTruthy();
});
it("localizes Japanese UI and native menus without changing user content or placeholders", () => {
  expect(Object.keys(japanese).sort()).toEqual(Object.keys(english).sort());
  for (const [source, translation] of Object.entries(japanese)) {
    expect(translation.trim(), source).not.toBe("");
    expect((translation.match(/\{\w+\}/g) || []).sort(), source).toEqual(
      (source.match(/\{\w+\}/g) || []).sort(),
    );
  }
  setLanguage("ja");
  expect(t("新聊天")).toBe("新しいチャット");
  expect(t("关闭窗口")).toBe("ウィンドウを閉じる");
  expect(t("并发任务上限")).toBe("同時実行タスクの上限");
  expect(t("{p0} 个匹配的聊天", { p0: "用户原文" })).toBe(
    "一致するチャット 用户原文 件",
  );
  expect(t("C:/账户/日本語.ts")).toBe("C:/账户/日本語.ts");
  expect(errorText(Error("会话尚未设置目标"))).toBe(
    "この会話には目標が設定されていません",
  );
  expect(formatDate(Date.UTC(2026, 9, 18))).toContain("2026");
});
