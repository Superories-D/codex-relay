import type { Job } from "./types";
export function dependencyBlockers(job: Job, jobs: Job[]) {
  return (job.dependsOn || []).filter(
    (id) => jobs.find((j) => j.id === id)?.state !== "completed",
  );
}
export function validateDependencies(jobs: Job[], id: string, ids: string[]) {
  if (ids.length > 20 || new Set(ids).size !== ids.length)
    throw Error("最多选择 20 个不同的前置任务");
  if (ids.some((key) => !jobs.some((j) => j.id === key)))
    throw Error("前置任务不存在");
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw Error("任务依赖不能形成循环");
    if (done.has(key)) return;
    visiting.add(key);
    for (const next of key === id
      ? ids
      : jobs.find((j) => j.id === key)?.dependsOn || [])
      visit(next);
    visiting.delete(key);
    done.add(key);
  }
  visit(id);
}
