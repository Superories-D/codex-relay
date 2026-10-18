import { useSyncExternalStore } from "react";
import { resolveLanguage, translate, type Language } from "../shared/locale";
export { resolveLanguage, type Language } from "../shared/locale";

export const languages: { value: Language; label: string }[] = [
  { value: "auto", label: "跟随系统 / System" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
];
let current: Exclude<Language, "auto"> = "zh-CN";
const listeners = new Set<() => void>();
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
  return translate(source, current, values);
}
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return t(
    raw
      .replace(
        /^Error invoking remote method 'relay:command':\s*(?:Error:\s*)?/,
        "",
      )
      .replace(/^Error:\s*/, ""),
  );
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
