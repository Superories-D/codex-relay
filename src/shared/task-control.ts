import type {Job} from "./types";

/** The task state an operator actually observed before requesting a control. */
export function taskControlSignature(job:Job) {
  return JSON.stringify([job.state,job.turnId,job.updatedAt,job.queueRevision,job.stopIntent,job.controlRevision,job.completion?.revision,job.completionPending,
    job.delivery?.revision,job.delivery?.reports.at(-1)?.id,job.delivery?.pendingCompletion,job.delivery?.staleEvidence]);
}
