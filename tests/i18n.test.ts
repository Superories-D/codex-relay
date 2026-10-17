import { afterEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { capabilities } from "../src/shared/capabilities";
import { english } from "../src/renderer/locales/en";
import {
  formatDate,
  resolveLanguage,
  setLanguage,
  t,
} from "../src/renderer/i18n";

afterEach(() => setLanguage("zh-CN"));
it("follows system languages and keeps explicit selections", () => {
  for (const system of ["zh-TW", "zh-HK", "zh-Hant-HK", "zh_MO"])
    expect(resolveLanguage("auto", system)).toBe("zh-TW");
  expect(resolveLanguage("auto", "zh-CN")).toBe("zh-CN");
  expect(resolveLanguage("auto", "fr-FR")).toBe("en");
  expect(resolveLanguage("en", "zh-CN")).toBe("en");
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
  for (const operation of capabilities)
    expect(english[operation.label], operation.label).toBeTruthy();
});
