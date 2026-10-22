import { expect, it } from "vitest";
import { scheduleRecovery } from "../src/core/auto-recovery";
import { taskPrompt } from "../src/core/completion";
import type { Job } from "../src/shared/types";

it("backs off repeated interruptions and caps the delay without losing retry intent", () => {
  const job = {} as Job;
  const delays = [];
  for (let i = 0; i < 8; i++) {
    scheduleRecovery(job, "unknown", 1000);
    delays.push(job.autoRecovery!.nextAttemptAt - 1000);
  }
  expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  expect(job.autoRecovery?.attempt).toBe(8);
  expect(job).toMatchObject({ state: "waiting", waitingFor: "recovery" });
});

it("continues uncertain input with an explicit inspection instruction instead of verbatim replay", () => {
  const job = {
    prompt: "old request",
    pendingMessage: "publish my change",
    submissionUncertain: true,
  } as Job;
  const prompt = taskPrompt({ job, resumePrompt: "continue" } as any);
  expect(prompt).toContain("publish my change");
  expect(prompt).not.toBe(job.pendingMessage);
  expect(prompt).toContain("若任务已经完成");
  expect(prompt).toContain("不要重复执行");
  expect(
    taskPrompt({
      job: { ...job, submissionUncertain: false },
      resumePrompt: "continue",
    } as any),
  ).toBe(job.pendingMessage);
});
