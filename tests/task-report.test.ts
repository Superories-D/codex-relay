import { expect, it } from "vitest";
import { taskReport } from "../src/core/task-report";
import { defaults } from "../src/core/store";
const environment = {
  version: "test",
  platform: "linux",
  arch: "x64",
  node: "test",
};
function snapshot(): any {
  return {
    ...structuredClone(defaults),
    approvals: [],
    jobs: [
      {
        id: "job",
        state: "waiting",
        mode: "cli",
        prompt: "PRIVATE PROMPT",
        pendingMessage: "PRIVATE FOLLOWUP",
        cwd: "/project",
        rotations: 1,
      },
    ],
    accounts: [
      {
        enabled: true,
        status: "reauth",
        accessToken: "PRIVATE CREDENTIAL",
        email: "private@example.com",
      },
    ],
  };
}
it("explains recovery, stop and approval gates without exporting conversation or account credentials", () => {
  const state = snapshot();
  Object.assign(state.jobs[0], {
    recoveryRequired: true,
    stopIntent: "pause",
    autoRecovery: { attempt: 2, reason: "process", nextAttemptAt: 1000 },
  });
  state.approvals = [{ jobId: "job", params: { text: "PRIVATE QUESTION" } }];
  state.logs = [
    {
      jobId: "job",
      level: "warning",
      at: 0,
      message: "Authorization: Bearer secret-example-123456789\nrt.1.Synthetic_0123456789-0123456789",
    },
    { jobId: "job", level: "output", at: 0, message: "PRIVATE OUTPUT" },
  ];
  const report = taskReport(state, "job", environment);
  expect(report.blockers).toEqual([
    "ownership",
    "recovery",
    "approval",
    "paused",
    "authentication",
  ]);
  expect(JSON.stringify(report)).not.toMatch(
    /PRIVATE|private@example|secret-example|Synthetic_0123456789/,
  );
  expect(report.logs).toHaveLength(1);
});
it("bounds report history and isolates one task's logs", () => {
  const state = snapshot();
  state.logs = Array.from({ length: 200 }, (_, at) => ({
    jobId: at % 2 ? "other" : "job",
    level: "info",
    at,
    message: "x".repeat(3000),
  }));
  state.jobs[0].recoveryHistory = Array.from({ length: 100 }, (_, at) => ({
    at,
    kind: "scheduled",
    attempt: at,
  }));
  const report = taskReport(state, "job", environment);
  expect(report.recovery).toHaveLength(50);
  expect(report.logs).toHaveLength(100);
  expect(
    report.logs.every((l) => l.message.length === 2000 && l.at % 2 === 0),
  ).toBe(true);
  expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
  expect(() => taskReport(state, "missing", environment)).toThrow("会话不存在");
});
