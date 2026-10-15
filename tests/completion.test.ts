import { expect, it } from "vitest";
import { taskPrompt, completionOutcome } from "../src/core/completion";
import { newJobSchema } from "../src/main/validation";
import type { Job } from "../src/shared/types";
const job = { prompt: "original goal", completionMarker: "[TASK_DONE]" } as Job;
it("requires the final line to match, not a substring or quoted example", () => {
  expect(completionOutcome(job, "Done\n[TASK_DONE]")).toEqual({
    kind: "completed",
  });
  for (const text of [
    "Example: [TASK_DONE]",
    "[TASK_DONE]\nStill need approval",
    "```\n[TASK_DONE]\n```",
    "Partial result",
  ])
    expect(completionOutcome(job, text).kind).toBe("incomplete");
  expect(
    completionOutcome({ ...job, completionMarker: undefined }, "Final answer")
      .kind,
  ).toBe("completed");
});
it("keeps the original goal for an uncertain Desktop send and carries the completion contract into retries", () => {
  const result = taskPrompt(
    {
      job: { ...job, turnId: "old", completionRetries: 1 },
      resumePrompt: "continue",
    } as any,
    true,
  );
  expect(result).toContain("original goal");
  expect(result).toContain("未确认");
  expect(result).toContain("上一轮");
  expect(result).toContain("[TASK_DONE]");
});
it("rejects multiline markers and unbounded retry budgets at the IPC boundary", () => {
  const input = {
    title: "test",
    prompt: "test",
    cwd: process.cwd(),
    mode: "cli",
    model: "",
    effort: "",
    bucket: "codex",
    approvalPolicy: "on-request",
    sandbox: "workspaceWrite",
  };
  expect(
    newJobSchema.safeParse({ ...input, completionMarker: "a\nb" }).success,
  ).toBe(false);
  expect(
    newJobSchema.safeParse({ ...input, maxCompletionRetries: 11 }).success,
  ).toBe(false);
  expect(
    newJobSchema.safeParse({ ...input, maxCompletionRetries: 0 }).success,
  ).toBe(true);
});
