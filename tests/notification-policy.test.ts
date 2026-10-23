import { it, expect } from "vitest";
import {
  quietNow,
  wantsNotice,
  notificationPolicySchema,
} from "../src/server/notification-policy";
it("handles midnight quiet windows and explicit error/watch modes", () => {
  const policy = notificationPolicySchema.parse({
    mode: "errors",
    watched: [],
    quiet: { start: 22, end: 7 },
    intervalSeconds: 30,
  });
  expect(quietNow(policy, Date.UTC(2026, 1, 1, 23))).toBe(true);
  expect(quietNow(policy, Date.UTC(2026, 1, 1, 6))).toBe(true);
  expect(quietNow(policy, Date.UTC(2026, 1, 1, 7))).toBe(false);
  expect(wantsNotice(policy, "task", "completed")).toBe(false);
  expect(wantsNotice(policy, "task", "approval:1")).toBe(true);
  expect(
    wantsNotice(
      { ...policy, mode: "watched", watched: ["task"] },
      "other",
      "needs_attention",
    ),
  ).toBe(false);
  expect(wantsNotice({ ...policy, mode: "off" }, "task", "recovering")).toBe(
    false,
  );
  expect(quietNow({ ...policy, quiet: { start: 0, end: 0 } }, Date.now())).toBe(
    true,
  );
});
