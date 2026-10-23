import { z } from "zod";
export const notificationPolicySchema = z
  .object({
    mode: z.enum(["all", "errors", "watched", "off"]),
    watched: z.array(z.string().uuid()).max(100),
    quiet: z
      .object({
        start: z.number().int().min(0).max(23),
        end: z.number().int().min(0).max(23),
      })
      .nullable(),
    intervalSeconds: z.number().int().min(0).max(3600),
  })
  .strict();
export type NotificationPolicy = z.infer<typeof notificationPolicySchema>;
export function quietNow(policy: NotificationPolicy, now: number) {
  if (!policy.quiet) return false;
  const hour = new Date(now).getUTCHours(),
    { start, end } = policy.quiet;
  return start === end
    ? true
    : start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
}
export function wantsNotice(
  policy: NotificationPolicy,
  id: string,
  tag: string,
) {
  if (
    policy.mode === "off" ||
    (policy.mode === "watched" && !policy.watched.includes(id))
  )
    return false;
  return (
    ["needs_attention", "recovering"].includes(tag) ||
    tag.startsWith("approval:") ||
    (policy.mode !== "errors" && ["completed", "cancelled"].includes(tag))
  );
}
