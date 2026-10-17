import { expect, it } from "vitest";
import type { Account } from "../src/shared/types";
import { accountValue } from "../src/shared/account-value";
import { eligible, pickAccount } from "../src/core/quota";
import { accountSchema } from "../src/main/validation";
const now = 1800000000000;
function account(id: string): Account {
  return {
    id,
    identity: id,
    label: id,
    email: id,
    plan: "plus",
    enabled: true,
    status: "ready",
    blockedUntil: null,
    failureCount: 0,
    quotas: {
      codex: {
        limitId: "codex",
        observedAt: now,
        reached: false,
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: now + 5 * 3600000,
        },
        secondary: {
          usedPercent: 20,
          windowDurationMins: 10080,
          resetsAt: now + 7 * 86400000,
        },
      },
    },
  };
}
it("prefers expiring capacity before it is lost, while refusing expired, offline, exhausted and stale accounts", () => {
  const normal = account("normal"),
    urgent = account("urgent");
  urgent.expiresAt = now + 3600000;
  expect(
    pickAccount([normal, urgent], 0, "codex", now, "smart")?.account.id,
  ).toBe("urgent");
  urgent.expiresAt = now;
  expect(eligible(urgent, "codex", now)).toBe(false);
  urgent.expiresAt = null;
  urgent.status = "offline";
  expect(eligible(urgent, "codex", now)).toBe(false);
  urgent.status = "ready";
  urgent.quotas.codex.primary!.usedPercent = 100;
  expect(eligible(urgent, "codex", now)).toBe(false);
  urgent.quotas.codex.primary!.usedPercent = 0;
  urgent.quotas.codex.observedAt = now - 120001;
  expect(eligible(urgent, "codex", now)).toBe(false);
});
it("values unused capacity with a nearer reset, never treating a passed deadline as replenishment", () => {
  const later = account("later"),
    sooner = account("sooner");
  sooner.quotas.codex.primary!.resetsAt = now + 5 * 60000;
  expect(accountValue(sooner, "codex", now).score).toBeGreaterThan(
    accountValue(later, "codex", now).score,
  );
  sooner.quotas.codex.primary!.resetsAt = now - 1;
  sooner.quotas.codex.primary!.usedPercent = 100;
  expect(
    pickAccount([sooner, later], 0, "codex", now, "smart")?.account.id,
  ).toBe("later");
});
it("does not rank a moving zero-percent placeholder as expiring capacity", () => {
  const a = account("idle");
  a.quotas.codex.secondary = null;
  a.quotas.codex.primary!.usedPercent = 0;
  a.quotas.codex.primary!.resetsAt = now + 30000;
  expect(
    accountValue(a, "codex", now).factors.some((f) => f.key === "reset"),
  ).toBe(false);
  a.resetWindows = {
    codex: { resetAt: now + 30000, observedAt: now, evidence: "stable" },
  };
  expect(
    accountValue(a, "codex", now).factors.some((f) => f.key === "reset"),
  ).toBe(true);
});
it("uses known plans and failure history as bounded factors, retaining rotation order for equal value", () => {
  const plus = account("plus"),
    pro = account("pro");
  pro.plan = "pro";
  expect(pickAccount([plus, pro], 0, "codex", now, "smart")?.account.id).toBe(
    "pro",
  );
  pro.failureCount = 3;
  expect(pickAccount([plus, pro], 0, "codex", now, "smart")?.account.id).toBe(
    "plus",
  );
  pro.plan = "plus";
  pro.failureCount = 0;
  expect(pickAccount([plus, pro], 1, "codex", now, "smart")?.account.id).toBe(
    "pro",
  );
  pro.expiresAt = now + 1000;
  expect(
    pickAccount([plus, pro], 0, "codex", now, "roundRobin")?.account.id,
  ).toBe("plus");
});
it("keeps unreported 5-hour windows unknown, with server restrictions overriding manual weekly-only metadata", () => {
  const a = account("a");
  a.quotas.codex.primary = null;
  expect(
    accountValue(a, "codex", now).factors.some((f) => f.key === "weeklyOnly"),
  ).toBe(false);
  a.limitMode = "weeklyOnly";
  expect(
    accountValue(a, "codex", now).factors.some((f) => f.key === "weeklyOnly"),
  ).toBe(true);
  a.quotas.codex.primary = {
    usedPercent: 100,
    windowDurationMins: 300,
    resetsAt: now + 10000,
  };
  expect(eligible(a, "codex", now)).toBe(false);
  expect(
    accountValue(a, "codex", now).factors.some((f) => f.key === "weeklyOnly"),
  ).toBe(false);
  expect(
    accountSchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      expiresAt: Number.NaN,
    }).success,
  ).toBe(false);
});
