import { z } from "zod";
import { goalObjectiveSchema, idSchema } from "../main/validation";
import type { Scheduler } from "./scheduler";
const budget = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
export const goalUpdateSchema = z.discriminatedUnion("action", [
  z.object({ id: idSchema, action: z.literal("pause") }).strict(),
  z.object({ id: idSchema, action: z.literal("clear") }).strict(),
  z.object({ id: idSchema, action: z.literal("start") }).strict(),
  z
    .object({
      id: idSchema,
      action: z.literal("edit"),
      objective: goalObjectiveSchema,
    })
    .strict(),
  z
    .object({
      id: idSchema,
      action: z.literal("create"),
      objective: goalObjectiveSchema,
      tokenBudget: budget,
      start: z.boolean(),
    })
    .strict(),
  z
    .object({ id: idSchema, action: z.literal("budget"), tokenBudget: budget })
    .strict(),
]);
export function updateGoal(scheduler: Scheduler, args: unknown) {
  const a = goalUpdateSchema.parse(args);
  if (a.action === "create")
    return scheduler.goal(
      a.id,
      "thread/goal/set",
      {
        objective: a.objective,
        tokenBudget: a.tokenBudget,
        status: a.start ? "active" : "paused",
      },
      a.start ? "createAndStart" : "create",
    );
  if (a.action === "start")
    return scheduler.goal(
      a.id,
      "thread/goal/set",
      { status: "active" },
      "start",
    );
  if (a.action === "edit")
    return scheduler.goal(
      a.id,
      "thread/goal/set",
      { objective: a.objective },
      "edit",
    );
  return scheduler.goal(
    a.id,
    a.action === "clear" ? "thread/goal/clear" : "thread/goal/set",
    a.action === "pause"
      ? { status: "paused" }
      : a.action === "budget"
        ? { tokenBudget: a.tokenBudget }
        : {},
  );
}
