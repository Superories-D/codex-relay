import { expect, it } from "vitest";
import { threadTokenUsage } from "../src/shared/token-usage";

const counts = (n: number) => ({ totalTokens: n, inputTokens: n - 10, outputTokens: 10, cachedInputTokens: 0 });

it("preserves cumulative accounting independently of context snapshots and compaction", () => {
  const total = { ...counts(46_867_019), cacheWriteInputTokens: 40, reasoningOutputTokens: 5 };
  const before = threadTokenUsage({ total, last: counts(180_000), modelContextWindow: 200_000 })!;
  const after = threadTokenUsage({ total: { ...total, totalTokens: 46_867_119 }, last: counts(16_000), modelContextWindow: 200_000 })!;
  expect(before.totalTokens).toBe(46_867_019);
  expect(before.last?.totalTokens).toBe(180_000);
  expect(after.last?.totalTokens).toBe(16_000);
  expect(after.totalTokens).toBeGreaterThan(before.totalTokens);
  expect(after.cacheWriteInputTokens).toBe(40);
  expect(after.reasoningOutputTokens).toBe(5);
  expect(before.last?.totalTokens).toBe(180_000);
});

it("does not infer current context from cumulative totals or a missing window", () => {
  expect(threadTokenUsage({ total: counts(500_000) })).toEqual({ ...counts(500_000), last: undefined, modelContextWindow: null });
  expect(threadTokenUsage({ total: counts(500_000), last: counts(1000), modelContextWindow: null })?.last?.totalTokens).toBe(1000);
  const zero = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  expect(threadTokenUsage({ total: zero, last: zero, modelContextWindow: 200_000 })?.last).toEqual(zero);
});

it("rejects invalid accounting without coercing malformed context to zero or a percentage", () => {
  for (const invalid of [-1, NaN, Infinity, "1000", null, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(threadTokenUsage({ total: { ...counts(100), totalTokens: invalid } })).toBeUndefined();
    const usage = threadTokenUsage({ total: counts(100), last: { ...counts(100), inputTokens: invalid }, modelContextWindow: invalid });
    expect(usage?.last).toBeUndefined();
    expect(usage?.modelContextWindow).toBeNull();
  }
  for (const input of [null, [], "", {}, { total: null }]) expect(threadTokenUsage(input)).toBeUndefined();
});
