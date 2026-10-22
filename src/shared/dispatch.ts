import type { AppState, Job } from "./types";
export const projectKey = (cwd: string, platform: string) => {
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};
export function dispatchHeld(data: Pick<AppState,"dispatch">, job: Job, platform: string) {
  return !!data.dispatch?.paused || !!data.dispatch?.projects.some(cwd => projectKey(cwd,platform) === projectKey(job.projectCwd || job.cwd,platform));
}
