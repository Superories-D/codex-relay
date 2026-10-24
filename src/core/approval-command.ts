import { z } from "zod";
import { idSchema } from "../main/validation";
import type { Scheduler } from "./scheduler";
export function respondApproval(scheduler: Scheduler, args: unknown) {
  const r = z
    .object({
      id: z.string().max(100),
      jobId: idSchema.optional(),
      historyId: z.string().max(100).optional(),
      reviewId:z.string().uuid().optional(),
      value: z.unknown(),
    })
    .strict()
    .parse(args);
  const matches = scheduler.approvals.filter(
    (a) => a.id === r.id && (!r.jobId || a.jobId === r.jobId),
  );
  if (matches.length > 1) throw new Error("请选择要回复的会话");
  const approval = matches[0];
  if (!approval) throw new Error("请求已经结束");
  if(r.reviewId!==undefined)scheduler.reviewApproval(approval.jobId,approval.id,r.reviewId);
  if (approval.kind === "input" && r.historyId !== approval.historyId)
    throw new Error("问题已更新，请重新查看后回答");
  if (approval.kind === "permissions") {
    const choice = z
      .object({ decision: z.enum(["accept", "decline"]) })
      .strict()
      .parse(r.value);
    const requested = (approval.params as any).permissions ?? {};
    const permissions =
      choice.decision === "accept"
        ? Object.fromEntries(
            Object.entries(requested).filter(([, v]) => v != null),
          )
        : {};
    return scheduler.respond(
      r.id,
      { permissions, scope: "turn" },
      approval.jobId,
    );
  }
  if (approval.kind === "elicitation") {
    const value = z
      .object({
        action: z.enum(["accept", "decline", "cancel"]),
        content: z.unknown().nullable(),
        _meta: z.null(),
      })
      .strict()
      .parse(r.value);
    if (JSON.stringify(value).length > 100000) throw new Error("输入内容过大");
    return scheduler.respond(r.id, value, approval.jobId);
  }
  const value =
    approval.kind === "input"
      ? z
          .object({
            answers: z.record(
              z.string(),
              z.object({
                answers: z.array(z.string().max(10000)).max(20),
              }),
            ),
          })
          .strict()
          .parse(r.value)
      : z
          .object({
            decision: z.enum([
              "accept",
              "acceptForSession",
              "decline",
              "cancel",
            ]),
          })
          .strict()
          .parse(r.value);
  return scheduler.respond(r.id, value, approval.jobId);
}
