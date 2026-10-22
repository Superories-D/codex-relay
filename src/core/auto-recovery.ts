import type { Job } from "../shared/types";

export class RecoveryError extends Error {}

// Retry only known interruptions. Configuration errors and rejected approvals
// are not evidence that replaying a turn is safe.
export function scheduleRecovery(
  job: Job,
  reason: NonNullable<Job["autoRecovery"]>["reason"],
  now = Date.now(),
) {
  const attempt = Math.min((job.recoveryAttempts || 0) + 1, 1_000_000);
  const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5));
  job.recoveryAttempts = attempt;
  job.autoRecovery = { reason, attempt, nextAttemptAt: now + delay };
  job.stage = reason === "process" ? "正在核验中断会话" : "等待自动恢复";
  if (!job.recoveryRequired) {
    job.state = "waiting";
    job.waitingFor = "recovery";
    job.nextWakeAt = now + delay;
  }
  job.updatedAt = now;
}

export function clearRecovery(job: Job) {
  job.autoRecovery = undefined;
  if (job.waitingFor === "recovery") job.waitingFor = undefined;
  job.nextWakeAt = undefined;
}
