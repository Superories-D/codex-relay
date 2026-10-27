import type { ChatItem, Job } from "./types";

export function notificationState(job: Job) {
  return job.autoRecovery ? "recovering" : job.state;
}

// Do not include updatedAt: renaming, archiving and other metadata writes are
// not new results. A successful worker may reuse a legacy/missing turn ID.
export function notificationEvent(job: Job) {
  const state = notificationState(job);
  return JSON.stringify([
    state,
    state === "completed" || state === "needs_attention"
      ? job.completion?.revision ?? 0 : null,
    state === "completed" ? job.completion?.threadId ?? job.threadId ?? null : null,
    state === "completed" ? job.completion?.turnId ?? job.turnId ?? null : null,
    state === "needs_attention" ? [job.waitingFor, job.lastError] : null,
  ]);
}

export function completionAssistant(job: Pick<Job,"completion">, items: readonly ChatItem[]) {
  const completion = job.completion;
  for (let index=items.length-1;index>=0;index--) {
    const item=items[index];
    if (item.role === "assistant" && item.text.trim() &&
    (!completion || (
      item.at >= completion.startedAt && item.at <= completion.finishedAt &&
      (!item.turnId || !completion.turnId || item.turnId === completion.turnId)
    ))) return item;
  }
}
