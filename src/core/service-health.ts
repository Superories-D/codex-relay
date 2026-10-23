import type { Snapshot } from "../shared/types";
/** Deliberately excludes task text, paths, account identities and credentials. */
export function serviceHealth(snapshot: Snapshot, closing = false) {
  const states: Record<string, number> = {};
  let recovering = 0, queuedMessages = 0;
  for (const job of snapshot.jobs) {
    states[job.state] = (states[job.state] || 0) + 1;
    if (job.autoRecovery) recovering++;
    queuedMessages += job.queuedMessages?.length || 0;
  }
  return {
    at: Date.now(), status: closing ? "stopping" : "ready",
    platform: process.platform, uptimeSeconds: Math.floor(process.uptime()),
    tasks: { total: snapshot.jobs.length, states, recovering, queuedMessages },
    approvals: snapshot.approvals.length,
    accounts: { total: snapshot.accounts.length, enabled: snapshot.accounts.filter(a => a.enabled).length },
    dispatchPaused: snapshot.dispatch?.paused || false,
    memoryBytes: process.memoryUsage().rss,
  };
}
