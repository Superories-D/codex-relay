import type { Account } from "./types";
import { fiveHour, timerEvidence } from "./reset-window";
export type ValueFactor = {
  key: "capacity" | "expiry" | "reset" | "plan" | "weeklyOnly" | "reliability";
  points: number;
};
// Scheduling priority, not a price estimate. Use current server quota windows;
// missing windows are unknown, and token expiry is never subscription expiry.
export function accountValue(account: Account, bucket: string, now: number) {
  const quota = account.quotas[bucket];
  const windows = [quota?.primary, quota?.secondary].filter((w) => w != null);
  const remaining = windows.length
    ? Math.min(...windows.map((w) => Math.max(0, 1 - w!.usedPercent / 100)))
    : quota?.unlimited
      ? 1
      : 0;
  const factors: ValueFactor[] = [{ key: "capacity", points: remaining * 35 }];
  if (account.expiresAt && account.expiresAt > now) {
    const days = (account.expiresAt - now) / 86400000;
    factors.push({ key: "expiry", points: 40 / (1 + days / 3) });
  }
  const resetValue = Math.max(
    0,
    ...windows.map((w) => {
      if (!w!.resetsAt || w!.resetsAt <= now) return 0;
      if (
        bucket === "codex" &&
        w === quota?.primary &&
        w.usedPercent === 0 &&
        fiveHour(account, quota) &&
        !timerEvidence(account, quota!, undefined, now)
      )
        return 0;
      const duration = (w!.windowDurationMins || 300) * 60000;
      // Unused quota that will be replaced sooner is worth using first. A
      // passed deadline is not proof that the server replenished any quota.
      const urgency = Math.exp(
        -(w!.resetsAt - now) / Math.max(1, duration / 4),
      );
      return (1 - w!.usedPercent / 100) * urgency * 18;
    }),
  );
  if (resetValue) factors.push({ key: "reset", points: resetValue });
  const plan = account.plan.toLowerCase();
  const planPoints = /pro/.test(plan)
    ? 4
    : /team|business|enterprise|edu/.test(plan)
      ? 3
      : /plus/.test(plan)
        ? 2
        : 0;
  if (planPoints) factors.push({ key: "plan", points: planPoints });
  if (account.limitMode === "weeklyOnly" && !quota?.primary)
    factors.push({ key: "weeklyOnly", points: 6 });
  if (account.failureCount)
    factors.push({
      key: "reliability",
      points: -Math.min(25, account.failureCount * 5),
    });
  const score =
    Math.round(
      (50 + factors.reduce((sum, factor) => sum + factor.points, 0)) * 10,
    ) / 10;
  return { score, factors, remaining };
}
