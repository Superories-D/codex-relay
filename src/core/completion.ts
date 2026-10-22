import type { Job } from "../shared/types";
import type { Outcome, WorkerContext } from "./worker";

export function taskPrompt(
  ctx: WorkerContext,
  uncertain = !!ctx.job.submissionUncertain,
): string {
  const { job } = ctx;
  if (job.pendingMessage && !uncertain) return job.pendingMessage;
  let prompt = uncertain
    ? `${ctx.resumePrompt}\n上次发送结果未确认。请先核查已有会话、工具结果和文件，只继续尚未完成的部分；不要重复执行已经完成的修改、提交或外部操作。若任务已经完成，直接报告现有结果。\n上次请求：\n${job.pendingMessage || job.prompt}`
    : job.turnId || job.existing
      ? ctx.resumePrompt
      : job.prompt;
  if ((job.completionRetries ?? 0) > 0)
    prompt +=
      "\n上一轮没有通过完成标记检查。请检查原始任务的验收要求与现有结果，补完缺失部分，避免重复已完成的操作。";
  if (job.completionMarker)
    prompt += `\n完成判断要求：只有原始任务全部完成且你已检查结果后，才在最终答复最后独立一行写出以下标记：\n${job.completionMarker}\n若仍需用户输入、审批或存在未解决问题，请说明原因，不要输出完成标记。`;
  return prompt;
}
// This is an additional gate, applied only AFTER normal terminal/quota checks.
export function completionOutcome(job: Job, finalText: string): Outcome {
  if (!job.completionMarker) return { kind: "completed" };
  const lines = finalText.trim().split(/\r?\n/);
  if (lines.at(-1)?.trim() === job.completionMarker)
    return { kind: "completed" };
  return {
    kind: "incomplete",
    error: new Error("最终答复缺少指定的独立完成标记，保留原会话继续检查"),
  };
}
