import type {ChatItem} from "../shared/types";
export type ActivityStatusFilter = "all" | "running" | "failed";
export type ActivityKindFilter = "all" | "commands" | "files" | "other";
const narrativeTools = new Set(["reasoning", "plan", "questionRequest"]);
export function isToolActivity(item: ChatItem) { return item.role === "tool" && !narrativeTools.has(item.kind); }
export function activityStatus(item: ChatItem): "running" | "failed" | "finished" {
  if (["failed", "declined", "error", "cancelled", "canceled"].includes(item.status || "") || item.data?.failure) return "failed";
  if (["running", "inProgress", "in_progress"].includes(item.status || "")) return "running";
  return "finished";
}
export function activityKind(item: ChatItem): Exclude<ActivityKindFilter, "all"> {
  return item.kind === "commandExecution" ? "commands" : ["fileChange", "diff"].includes(item.kind) ? "files" : "other";
}
export function filterActivityTimeline(items: ChatItem[], filter: ActivityStatusFilter, kind: ActivityKindFilter, query: string) {
  const needle = query.trim().normalize("NFKC").toLowerCase();
  return items.filter(item => {
    if (!isToolActivity(item)) return true;
    const paths = Array.isArray(item.data?.changes) ? item.data.changes.map((change: unknown) => typeof (change as any)?.path === "string" ? (change as any).path : "").join("\n") : "";
    return (filter === "all" || activityStatus(item) === filter) && (kind === "all" || activityKind(item) === kind) && (!needle || [item.text, item.detail, paths].filter(Boolean).join("\n").normalize("NFKC").toLowerCase().includes(needle));
  });
}
export function nextFailedActivity(items: ChatItem[], current?: string) {
  const failures = items.filter(item => isToolActivity(item) && activityStatus(item) === "failed");
  if (!failures.length) return undefined;
  return failures[(failures.findIndex(item => item.id === current) + 1) % failures.length];
}
export function activityCopyText(items: ChatItem[], truncatedLabel: string) {
  return items.map(item => [item.text, item.detail, item.sourceTruncated ? `[${truncatedLabel}]` : undefined].filter(Boolean).join("\n\n")).join("\n\n────────\n\n");
}
