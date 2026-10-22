import type { AppState, Job } from "./types";
export const projectKey = (cwd: string, platform: string) => {
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};
export function dispatchHeld(data: Pick<AppState,"dispatch">, job: Job, platform: string) {
  return !!data.dispatch?.paused || !!data.dispatch?.projects.some(cwd => projectKey(cwd,platform) === projectKey(job.projectCwd || job.cwd,platform));
}
export function projectLimit(data: Pick<AppState,"projectLimits">, job: Pick<Job,"cwd"|"projectCwd">, platform: string) {
  const key = projectKey(job.projectCwd || job.cwd, platform);
  return data.projectLimits?.find(p => projectKey(p.cwd, platform) === key)?.limit;
}
export function projectHasCapacity(data: Pick<AppState,"projectLimits">, job: Job, running: Job[], platform: string) {
  const limit = projectLimit(data, job, platform);
  if (!limit) return true;
  const key = projectKey(job.projectCwd || job.cwd, platform);
  return running.filter(j => projectKey(j.projectCwd || j.cwd, platform) === key).length < limit;
}
