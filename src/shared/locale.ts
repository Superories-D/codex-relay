import OpenCC from "opencc-js/cn2t";
import { english } from "../renderer/locales/en";
export type Language = "auto" | "zh-CN" | "zh-TW" | "en";
export type ResolvedLanguage = Exclude<Language, "auto">;
const convert = OpenCC.Converter({ from: "cn", to: "twp" });
const traditional = new Map<string, string>();
export function resolveLanguage(
  language: Language,
  system = typeof navigator !== "undefined" ? navigator.language : "zh-CN",
): ResolvedLanguage {
  return language !== "auto"
    ? language
    : /^zh(?:-|_)(?:TW|HK|MO|Hant)/i.test(system)
      ? "zh-TW"
      : /^zh/i.test(system)
        ? "zh-CN"
        : "en";
}
export function translate(
  source: string,
  language: ResolvedLanguage,
  values?: Record<string, unknown>,
): string {
  let text = source;
  if (language === "en") text = english[source] ?? source;
  else if (language === "zh-TW") {
    text =
      traditional.get(source) ?? convert(source).replaceAll("賬戶", "帳戶");
    if (traditional.size > 5000) traditional.clear();
    traditional.set(source, text);
  }
  return values
    ? text.replace(/\{(\w+)\}/g, (match, key: string) =>
        values[key] === undefined ? match : String(values[key]),
      )
    : text;
}
