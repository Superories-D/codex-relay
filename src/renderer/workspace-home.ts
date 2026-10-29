import type { Approval, Job } from "../shared/types";
export const projectShortName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
export function homeJobs(jobs: Job[], approvals: Approval[]) {
  const visible = jobs.filter(j => !j.archived && !j.historySource?.issue);
  const pending = new Set(approvals.filter(a => !a.responsePending).map(a => a.jobId));
  const recent = [...visible].sort((a,b) => b.updatedAt - a.updatedAt);
  const active = recent.filter(j => !!j.autoRecovery || ["running", "preparing", "queued", "waiting", "rotating", "watching", "pausing"].includes(j.state));
  const attention = recent.filter(j => pending.has(j.id) || (j.state === "needs_attention" && !j.autoRecovery));
  return {recent, active, attention};
}
