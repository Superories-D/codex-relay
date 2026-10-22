import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Chats } from "../src/core/chat";
import { WorkflowReports } from "../src/core/workflow-report";
it("reports missing stages honestly, scans older pages, redacts credentials and exports the exact preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-report-"));
  try {
    const chats = new Chats(root);
    let now = 100000;
    const jobs: any[] = [
      {
        id: "a",
        title: "Stage one",
        state: "completed",
        cwd: "/project",
        workflow: { id: "w", title: "Release", step: 1, total: 2 },
        prompt: "PRIVATE PROMPT",
      },
    ];
    await chats.append("a", {
      id: "answer",
      role: "assistant",
      kind: "agentMessage",
      text: "Done ```\nBearer secret-token-123456789",
      at: 1,
    });
    for (let i = 0; i < 90; i++)
      await chats.append("a", {
        id: `tool-${i}`,
        role: "tool",
        kind: "commandExecution",
        text: "PRIVATE TOOL LOG",
        at: i + 2,
      });
    const reports = new WorkflowReports(
      chats,
      () => jobs,
      () => now,
    );
    const preview = await reports.preview("w");
    expect(preview.report.complete).toBe(false);
    expect(preview.report.missingStages).toEqual([2]);
    expect(preview.report.stages[0].latestResponse?.text).toContain(
      "[REDACTED]",
    );
    expect(preview.markdown).not.toContain("secret-token");
    expect(preview.markdown).not.toContain("PRIVATE");
    expect(preview.markdown).toContain("````text");
    jobs[0].title = "Changed later";
    expect(reports.document(preview.previewId, "markdown")).toBe(
      preview.markdown,
    );
    expect(
      JSON.parse(reports.document(preview.previewId, "json")).stages[0].title,
    ).toBe("Stage one");
    now += 600001;
    expect(() => reports.document(preview.previewId, "json")).toThrow("过期");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it("marks complete only for all completed stages and explicitly flags long responses", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-report-"));
  try {
    const chats = new Chats(root);
    const jobs: any[] = [1, 2].map((step) => ({
      id: String(step),
      title: "Step",
      cwd: root,
      state: "completed",
      workflow: { id: "w", title: "Flow", step, total: 2 },
    }));
    await chats.append("2", {
      id: "answer",
      role: "assistant",
      kind: "agentMessage",
      text: "a".repeat(50001),
      at: 1,
    });
    const reports = new WorkflowReports(chats, () => jobs);
    const result = await reports.preview("w");
    expect(result.report.complete).toBe(true);
    expect(result.report.stages[1].latestResponse?.truncated).toBe(true);
    jobs[1].state = "cancelled";
    expect((await reports.preview("w")).report.complete).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
