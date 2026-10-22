import type { Snapshot } from "../shared/types";
import { redact } from "./redact";
export function taskReport(
  snapshot: Snapshot,
  id: string,
  environment: {
    version: string;
    platform: string;
    arch: string;
    node: string;
  },
) {
  const job = snapshot.jobs.find((j) => j.id === id);
  if (!job) throw Error("会话不存在");
  const approvals = snapshot.approvals.filter((a) => a.jobId === id).length;
  const enabled = snapshot.accounts.filter((a) => a.enabled);
  const blockers: string[] = [];
  if (job.recoveryRequired) blockers.push("ownership");
  if (job.autoRecovery) blockers.push("recovery");
  if (approvals) blockers.push("approval");
  if (job.stopIntent || job.state === "paused") blockers.push("paused");
  if (job.waitingFor === "model") blockers.push("model");
  if (!enabled.length) blockers.push("accounts");
  else if (enabled.every((a) => a.status === "reauth"))
    blockers.push("authentication");
  if (
    job.state === "waiting" &&
    !job.autoRecovery &&
    job.waitingFor !== "model"
  )
    blockers.push("availability");
  if (job.historySource?.issue) blockers.push("history");
  if (job.existing && job.existing.phase !== "managed")
    blockers.push("handoff");
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment,
    blockers,
    pendingApprovals: approvals,
    task: {
      id: job.id,
      state: job.state,
      mode: job.mode,
      cwd: job.cwd,
      threadId: job.threadId,
      model: job.model,
      effort: job.effort,
      priority: job.priority || "normal",
      rotations: job.rotations,
      recoveryRequired: !!job.recoveryRequired,
      stopIntent: job.stopIntent,
      autoRecovery: job.autoRecovery,
      submissionUncertain: !!job.submissionUncertain,
      queuedMessages: job.queuedMessages?.length || 0,
      lastError: redact(job.lastError).slice(0, 4000),
      lastActivityAt: job.lastActivityAt,
      lastHeartbeatAt: job.lastHeartbeatAt,
      goal: job.goal
        ? {
            status: job.goal.status,
            tokenBudget: job.goal.tokenBudget,
            tokensUsed: job.goal.tokensUsed,
          }
        : undefined,
    },
    accounts: {
      total: snapshot.accounts.length,
      enabled: enabled.length,
      reauthentication: enabled.filter((a) => a.status === "reauth").length,
    },
    recovery: (job.recoveryHistory || [])
      .slice(-50)
      .map((e) => ({
        at: e.at,
        kind: e.kind,
        attempt: e.attempt,
        detail: redact(e.detail).slice(0, 2000),
      })),
    logs: snapshot.logs
      .filter((l) => l.jobId === id && l.level !== "output")
      .slice(-100)
      .map((l) => ({
        at: l.at,
        level: l.level,
        message: redact(l.message).slice(0, 2000),
      })),
  };
  // Keep only the explicit report fields, then redact diagnostics without
  // truncating the JSON document into invalid data.
  return JSON.parse(
    redact(JSON.stringify(report), Number.MAX_SAFE_INTEGER),
  ) as typeof report;
}
