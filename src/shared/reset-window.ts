import type { Account, Quota } from "./types";

export function fiveHour(account: Account, quota?: Quota) {
  const window = quota?.primary;
  return (
    !!window &&
    (window.windowDurationMins === 300 ||
      (window.windowDurationMins == null && account.limitMode === "fiveHour"))
  );
}
export function freshWindow(
  account: Account,
  quota: Quota | undefined,
  now = Date.now(),
) {
  return (
    !!quota &&
    fiveHour(account, quota) &&
    Number.isFinite(quota.observedAt) &&
    quota.observedAt <= now &&
    now - quota.observedAt <= 120000 &&
    (!quota.primary!.resetsAt ||
      quota.primary!.resetsAt <= quota.observedAt + 18120000)
  );
}
// A zero-percent idle window may report `now + five hours` on every probe.
// One future date cannot prove that a countdown has actually started.
export function timerEvidence(
  account: Account,
  current: Quota,
  previous?: Quota,
  now = Date.now(),
): "usage" | "stable" | "activity" | undefined {
  const resetAt = current.primary?.resetsAt;
  if (!freshWindow(account, current, now) || !resetAt || resetAt <= now) return;
  if (current.primary!.usedPercent > 0) return "usage";
  const known = account.resetWindows?.codex;
  if (known?.resetAt === resetAt && known.observedAt <= current.observedAt)
    return known.evidence;
  if (
    previous &&
    fiveHour(account, previous) &&
    previous.primary?.resetsAt === resetAt &&
    previous.observedAt <= current.observedAt - 10000 &&
    resetAt > previous.observedAt &&
    resetAt - current.observedAt <= 18000000 - 10000
  )
    return "stable";
}
export function rememberWindow(
  account: Account,
  quota: Quota,
  evidence: "usage" | "stable" | "activity",
) {
  const resetAt = quota.primary?.resetsAt;
  if (
    !resetAt ||
    !Number.isFinite(resetAt) ||
    !Number.isFinite(quota.observedAt) ||
    resetAt > quota.observedAt + 18120000
  )
    return false;
  const known = account.resetWindows?.codex;
  if (known && known.observedAt > quota.observedAt) return false;
  if (
    known?.resetAt === resetAt &&
    known.observedAt === quota.observedAt &&
    known.evidence === evidence
  )
    return false;
  (account.resetWindows ||= {}).codex = {
    resetAt,
    observedAt: quota.observedAt,
    evidence,
  };
  return true;
}
