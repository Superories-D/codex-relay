import type { JobTokenUsage, TokenCounts } from "./types";

export function tokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function tokenCounts(value: unknown): TokenCounts | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (!tokenCount(v.totalTokens) || !tokenCount(v.inputTokens) || !tokenCount(v.outputTokens))
    return;
  return {
    totalTokens: v.totalTokens,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    cachedInputTokens: tokenCount(v.cachedInputTokens) ? v.cachedInputTokens : 0,
    ...(tokenCount(v.cacheWriteInputTokens) ? { cacheWriteInputTokens: v.cacheWriteInputTokens } : {}),
    ...(tokenCount(v.reasoningOutputTokens) ? { reasoningOutputTokens: v.reasoningOutputTokens } : {}),
  };
}

// CLI totals are cumulative; last is an independent, replaceable snapshot.
// In particular, compaction can reduce last without reducing total.
export function threadTokenUsage(value: unknown): JobTokenUsage | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  const total = tokenCounts(v.total);
  if (!total) return;
  return {
    ...total,
    last: tokenCounts(v.last),
    modelContextWindow: tokenCount(v.modelContextWindow) && v.modelContextWindow > 0
      ? v.modelContextWindow : null,
  };
}
