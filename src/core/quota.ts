import type { Account, Quota, WindowQuota } from "../shared/types";
const finite = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
function windowOf(raw: any): WindowQuota | null {
  if (!raw || !finite(raw.usedPercent)) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, raw.usedPercent)),
    windowDurationMins: finite(raw.windowDurationMins)
      ? raw.windowDurationMins
      : null,
    resetsAt: finite(raw.resetsAt) ? raw.resetsAt * 1000 : null,
  };
}
export function parseQuotas(
  raw: any,
  now = Date.now(),
  previous: Record<string, Quota> = {},
  sparse = false,
): Record<string, Quota> {
  const buckets = {
    ...(raw?.rateLimits
      ? { [raw.rateLimits.limitId ?? "codex"]: raw.rateLimits }
      : {}),
    ...(raw?.rateLimitsByLimitId ?? {}),
  };
  return Object.fromEntries(
    Object.entries(buckets)
      .filter(
        ([key, value]) => key.length > 0 && value && typeof value === "object",
      )
      .map(([key, value]) => {
        const r = value as any;
        const old = sparse ? previous[key] : undefined;
        return [
          key,
          {
            limitId: key,
            primary: windowOf(r.primary) ?? old?.primary ?? null,
            secondary: windowOf(r.secondary) ?? old?.secondary ?? null,
            observedAt: now,
            reached: Boolean(
              r.rateLimitReachedType ||
                r.spendControlReached ||
                (sparse && old?.reached),
            ),
            unlimited:
              r.credits?.unlimited === true ||
              (sparse && old?.unlimited === true),
          },
        ];
      }),
  );
}
export function isExhausted(q?: Quota): boolean {
  return (
    !!q &&
    (q.reached ||
      [q.primary, q.secondary].some((w) => w !== null && w.usedPercent >= 100))
  );
}
// BOTH exhausted windows must reset. Never infer replenishment from wall time alone.
export function resetDeadline(
  q: Quota | undefined,
  now: number,
  fallbackMs: number,
): number {
  const blocked = q
    ? ([q.primary, q.secondary].filter(
        (w) => w !== null && w.usedPercent >= 100,
      ) as WindowQuota[])
    : [];
  if (
    blocked.length === 0 ||
    blocked.some((w) => !w.resetsAt || w.resetsAt <= now)
  )
    return now + fallbackMs;
  return Math.max(...blocked.map((w) => w.resetsAt!)) + 2000;
}
export function hasQuotaEvidence(q?: Quota): boolean {
  return (
    !!q && (q.primary != null || q.secondary != null || q.unlimited === true)
  );
}
export function eligible(
  account: Account,
  bucket: string,
  now: number,
): boolean {
  if (
    !account.enabled ||
    account.status === "reauth" ||
    (account.blockedUntil ?? 0) > now
  )
    return false;
  const q = account.quotas[bucket];
  return (
    !!q &&
    hasQuotaEvidence(q) &&
    now >= q.observedAt &&
    now - q.observedAt <= 120_000 &&
    !isExhausted(q)
  );
}
export function pickAccount(
  accounts: Account[],
  cursor: number,
  bucket: string,
  now: number,
): { account: Account; cursor: number } | null {
  for (let step = 0; step < accounts.length; step++) {
    const i = (cursor + step) % accounts.length;
    if (eligible(accounts[i], bucket, now))
      return { account: accounts[i], cursor: (i + 1) % accounts.length };
  }
  return null;
}
export function nextWake(
  accounts: Account[],
  bucket: string,
  now: number,
  retryMs: number,
): number {
  const times = accounts
    .filter((a) => a.enabled && a.status !== "reauth")
    .map((a) =>
      Math.max(
        a.blockedUntil ?? 0,
        resetDeadline(a.quotas[bucket], now, retryMs),
      ),
    );
  return times.length
    ? Math.max(now + 1000, Math.min(...times))
    : now + retryMs;
}
export function errorKind(
  error: unknown,
): "quota" | "auth" | "transient" | "other" {
  const original =
    typeof error === "object" && error !== null ? (error as any) : {};
  const obj = original.detail ?? original;
  const code = JSON.stringify(
    obj.codexErrorInfo ??
      obj.codex_error_info ??
      obj.error?.codexErrorInfo ??
      obj.error?.codex_error_info ??
      obj.data ??
      "",
  ).toLowerCase();
  const message = String(
    obj.message ?? obj.error?.message ?? error,
  ).toLowerCase();
  if (
    /usagelimitexceeded|usage_limit_exceeded/.test(code) ||
    /(?:you['’]ve|you have) (?:hit|reached) (?:your |the )?(?:usage|weekly|5.?hour) limit|usage limit exceeded|quota exceeded|额度(?:已)?(?:耗尽|用完)/.test(
      message,
    )
  )
    return "quota";
  if (
    /unauthorized|authrequired|refresh_token_(expired|reused|invalidated)/.test(
      code + message,
    ) ||
    /401|please (log|sign) in/.test(message)
  )
    return "auth";
  // HTTP 429 alone can be service throttling. It must NOT blacklist an account as exhausted.
  if (
    /429|503|502|timed? ?out|econn|network|overloaded|streamdisconnected|ratelimitexceeded|rate_limit_exceeded/.test(
      message + code,
    )
  )
    return "transient";
  return "other";
}
export function isQuotaNotice(text: unknown): boolean {
  return (
    typeof text === "string" &&
    /^\s*(?:error:\s*)?(?:(?:you['’]ve|you have) (?:hit|reached) (?:your |the )?(?:usage|weekly|5.?hour) limit|usage limit exceeded|quota exceeded|额度(?:已)?(?:耗尽|用完))/i.test(
      text,
    )
  );
}
