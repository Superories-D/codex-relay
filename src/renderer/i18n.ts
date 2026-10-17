import { useSyncExternalStore } from "react";
import OpenCC from "opencc-js/cn2t";
import { english } from "./locales/en";

export type Language = "auto" | "zh-CN" | "zh-TW" | "en";
export const languages: { value: Language; label: string }[] = [
  { value: "auto", label: "跟随系统 / System" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
];
let current: Exclude<Language, "auto"> = "zh-CN";
const listeners = new Set<() => void>();
const convert = OpenCC.Converter({ from: "cn", to: "twp" });
const traditional = new Map<string, string>();
export function resolveLanguage(
  language: Language,
  system = typeof navigator !== "undefined" ? navigator.language : "zh-CN",
): Exclude<Language, "auto"> {
  if (language !== "auto") return language;
  return /^zh(?:-|_)(?:TW|HK|MO|Hant)/i.test(system)
    ? "zh-TW"
    : /^zh/i.test(system)
      ? "zh-CN"
      : "en";
}
export function setLanguage(language: Language) {
  const next = resolveLanguage(language);
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (next === current) return;
  current = next;
  for (const notify of listeners) notify();
}
export function getLanguage() {
  return current;
}
export function t(source: string, values?: Record<string, unknown>): string {
  let text = source;
  if (current === "en") text = english[source] ?? source;
  else if (current === "zh-TW") {
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
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useI18n() {
  const language = useSyncExternalStore(
    subscribe,
    () => current,
    () => "zh-CN" as const,
  );
  return { language, t };
}
export function formatDate(value: number) {
  return new Intl.DateTimeFormat(current, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
