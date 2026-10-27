import {deliveryChecksSchema} from "../shared/delivery";
import { z } from "zod";
import path from "node:path";
import { idSchema } from "../main/validation";
export const scheduleInputSchema = z
  .object({
    id: idSchema.optional(),
    revision:z.number().int().nonnegative().optional(),
    deliveryChecks:deliveryChecksSchema.optional(),
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(100000),
    cwd: z.string().max(32700).refine(path.isAbsolute),
    enabled: z.boolean(),
    cadence: z.enum(["interval", "daily", "weekly"]),
    minutes: z.number().int().min(5).max(525600),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekday: z.number().int().min(0).max(6),
    worktree: z.boolean(),
  })
  .strict();
export const scheduleRunInputSchema=scheduleInputSchema.pick({title:true,prompt:true,cwd:true,worktree:true,deliveryChecks:true});
