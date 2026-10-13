import { describe, it, expect } from "vitest";
import {
  eligible,
  errorKind,
  isExhausted,
  isQuotaNotice,
  nextWake,
  parseQuotas,
  pickAccount,
  resetDeadline,
} from "../src/core/quota";
import type { Account, Quota } from "../src/shared/types";
const now = 1_800_000_000_000;
const q = (primary = 20, secondary = 40): Quota => ({
  limitId: "codex",
  primary: {
    usedPercent: primary,
    windowDurationMins: 300,
    resetsAt: now + 5000,
  },
  secondary: {
    usedPercent: secondary,
    windowDurationMins: 10080,
    resetsAt: now + 50000,
  },
  observedAt: now,
  reached: false,
});
const account = (id: string, quota = q()): Account => ({
  id,
  identity: id,
  label: id,
  email: id,
  plan: "plus",
  enabled: true,
  status: "ready",
  quotas: { codex: quota },
  blockedUntil: null,
  failureCount: 0,
});
describe("quota selection", () => {
  it("retains the legacy quota when the per-limit map is empty", () => {
    const quota = parseQuotas(
      {
        rateLimits: { primary: { usedPercent: 100 } },
        rateLimitsByLimitId: {},
      },
      now,
    ).codex;
    expect(isExhausted(quota)).toBe(true);
  });
  it("does not trust observations from before a backwards system-clock jump", () => {
    expect(eligible(account("future", q()), "codex", now - 1000)).toBe(false);
  });
  it("interprets usedPercent, not remainingPercent, and seconds not milliseconds", () => {
    const parsed = parseQuotas(
      {
        rateLimits: {
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: now / 1000 + 5,
          },
          secondary: null,
        },
      },
      now,
    ).codex;
    expect(isExhausted(parsed)).toBe(true);
    expect(parsed.primary?.resetsAt).toBe(now + 5000);
  });
  it("does not treat a missing 5h window as zero remaining", () => {
    const quota = q();
    quota.primary = null;
    expect(eligible(account("a", quota), "codex", now)).toBe(true);
  });
  it("does not invent unlimited quota from two absent windows", () => {
    const quota = q();
    quota.primary = null;
    quota.secondary = null;
    expect(eligible(account("a", quota), "codex", now)).toBe(false);
    quota.unlimited = true;
    expect(eligible(account("a", quota), "codex", now)).toBe(true);
  });
  it("waits for the later of BOTH exhausted windows", () => {
    expect(resetDeadline(q(100, 100), now, 60000)).toBe(now + 52000);
  });
  it("wakes at the earliest account that can recover", () => {
    const a = account("a", q(100, 100));
    const b = account("b", q(100, 20));
    expect(nextWake([a, b], "codex", now, 60000)).toBe(now + 7000);
  });
  it("uses backoff for absent or already-passed reset timestamps", () => {
    const quota = q(100);
    quota.primary!.resetsAt = now - 1;
    expect(resetDeadline(quota, now, 60000)).toBe(now + 60000);
    quota.primary!.resetsAt = null;
    expect(resetDeadline(quota, now, 60000)).toBe(now + 60000);
  });
  it("never assumes a time-passed window has been refilled", () => {
    expect(eligible(account("a", q(100)), "codex", now + 10000)).toBe(false);
  });
  it("cycles in order and skips disabled, reauth, stale and depleted accounts", () => {
    const all = [account("a"), account("b"), account("c")];
    all[1].enabled = false;
    expect(pickAccount(all, 1, "codex", now)?.account.id).toBe("c");
    all[2].status = "reauth";
    expect(pickAccount(all, 1, "codex", now)?.account.id).toBe("a");
    expect(pickAccount(all, 0, "codex", now + 120001)).toBeNull();
  });
  it("honors the selected model quota bucket", () => {
    const a = account("a");
    a.quotas.spark = { ...q(100), limitId: "spark" };
    expect(eligible(a, "codex", now)).toBe(true);
    expect(eligible(a, "spark", now)).toBe(false);
    expect(eligible(a, "unknown-model", now)).toBe(false);
  });
  it("merges sparse notifications without losing an exhausted week", () => {
    const prior = q(10, 100);
    const changed = parseQuotas(
      { rateLimits: { primary: { usedPercent: 30 }, secondary: null } },
      now + 100,
      { codex: prior },
      true,
    ).codex;
    expect(changed.secondary?.usedPercent).toBe(100);
    expect(isExhausted(changed)).toBe(true);
  });
  it("lets a full server read clear old exhausted windows", () => {
    const changed = parseQuotas(
      { rateLimits: { primary: { usedPercent: 0 }, secondary: null } },
      now,
      { codex: q(100, 100) },
      false,
    ).codex;
    expect(changed.secondary).toBeNull();
    expect(isExhausted(changed)).toBe(false);
  });
  it("honors explicit server reached flags and rejects malformed percentages", () => {
    expect(
      isExhausted(
        parseQuotas({ rateLimits: { spendControlReached: true } }, now).codex,
      ),
    ).toBe(true);
    expect(
      parseQuotas({ rateLimits: { primary: { usedPercent: "0" } } }, now).codex
        .primary,
    ).toBeNull();
  });
});
describe("error classification", () => {
  it("handles camelCase, rollout snake_case, and RpcError details", () => {
    expect(errorKind({ codexErrorInfo: "usageLimitExceeded" })).toBe("quota");
    expect(errorKind({ codex_error_info: "usage_limit_exceeded" })).toBe(
      "quota",
    );
    expect(
      errorKind({
        detail: {
          data: { codexErrorInfo: "usageLimitExceeded" },
          message: "blocked",
        },
      }),
    ).toBe("quota");
  });
  it("does not rotate a whole account just because of a HTTP 429", () => {
    expect(errorKind(new Error("HTTP 429 Too Many Requests"))).toBe(
      "transient",
    );
    expect(errorKind({ codexErrorInfo: "rateLimitExceeded" })).toBe(
      "transient",
    );
  });
  it("distinguishes authentication and generic failures", () => {
    expect(errorKind(new Error("refresh_token_reused"))).toBe("auth");
    expect(errorKind(new Error("invalid workspace"))).toBe("other");
  });
  it("does not classify normal development discussion as quota exhaustion", () => {
    expect(isQuotaNotice("Implemented Usage limit exceeded handling.")).toBe(
      false,
    );
    expect(isQuotaNotice("You've hit your usage limit. Try again later.")).toBe(
      true,
    );
  });
});
