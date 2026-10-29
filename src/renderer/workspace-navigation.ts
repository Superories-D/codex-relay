export interface WorkspaceRoute { screen: string; manage: string; jobId?: string; cwd: string }
export interface WorkspaceNavigation { entries: WorkspaceRoute[]; index: number }
function sameRoute(a: WorkspaceRoute | undefined, b: WorkspaceRoute) {
  return !!a && a.screen === b.screen && a.manage === b.manage && a.jobId === b.jobId && (a.jobId || a.cwd === b.cwd);
}
export function recordWorkspaceRoute(history: WorkspaceNavigation, route: WorkspaceRoute): WorkspaceNavigation {
  if (sameRoute(history.entries[history.index], route)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), route].slice(-50);
  return { entries, index: entries.length - 1 };
}
export function workspaceHistoryTarget(history: WorkspaceNavigation, direction: -1 | 1, availableJobs: ReadonlySet<string>) {
  for (let i=history.index+direction;i>=0&&i<history.entries.length;i+=direction) {
    if (!history.entries[i].jobId || availableJobs.has(history.entries[i].jobId!)) return i;
  }
  return -1;
}
