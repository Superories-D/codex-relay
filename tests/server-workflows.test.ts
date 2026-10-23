import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ServerRuntime } from "../src/server/runtime";
import { ServerWorkflows } from "../src/server/workflows";
it.skipIf(process.platform !== "linux")(
  "branches a paused workflow with bounded handoff, immutable provenance and recoverable submission",
  async () => {
    const base = await fs.mkdtemp(
        path.join(os.tmpdir(), "relay-workflow-retry-"),
      ),
      root = path.join(base, "data"),
      work = path.join(base, "work");
    await fs.mkdir(work);
    let runtime = await ServerRuntime.open(root, undefined, [work]);
    try {
      await runtime.scheduler.dispatch(true);
      const source = randomUUID(),
        input = {
          title: "Stage",
          prompt: "Original instructions",
          cwd: work,
          mode: "cli",
          model: "",
          effort: "",
          bucket: "codex",
          approvalPolicy: "on-request",
          sandbox: "workspaceWrite",
        };
      const jobs: any = await runtime.command("workflow.add", {
        requestId: source,
        title: "Pipeline",
        steps: [input, input, input],
      });
      await expect(
        runtime.command("workflow.previewRetry", { id: source, fromStep: 3 }),
      ).rejects.toThrow("Complete earlier");
      jobs[0].state = "completed";
      jobs[1].state = "completed";
      await runtime.scheduler.control(jobs[2].id, "pause");
      await runtime.scheduler.chats.append(jobs[1].id, {
        id: "result",
        at: Date.now(),
        role: "assistant",
      kind:"message",
        text: "Recorded result api_key: top-secret",
      });
      const preview: any = await runtime.command("workflow.previewRetry", {
        id: source,
        fromStep: 3,
      });
      expect(preview.steps).toHaveLength(1);
      expect(preview.steps[0].prompt).toContain("Recorded result");
      expect(preview.steps[0].prompt).not.toContain("top-secret");
      await expect(
        new ServerWorkflows(
          runtime,
          [work],
          () => Date.now() + 11 * 60000,
        ).fork(randomUUID(), preview.id),
      ).rejects.toThrow("expired");
      const request = { requestId: randomUUID(), previewId: preview.id },
        result: any = await runtime.command("workflow.retry", request);
      expect(result.state).toBe("succeeded");
      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toMatchObject({
        state: "paused",
        stopIntent: "pause",
        workflow: { source: { id: source, step: 3 } },
      });
      expect(jobs[2].state).toBe("paused");
      await runtime.close();
      runtime = await ServerRuntime.open(root, undefined, [work]);
      expect(await runtime.command("workflow.retry", request)).toEqual(result);
      expect(runtime.store.data.jobs).toHaveLength(4);
      const stale: any = await runtime.command("workflow.previewRetry", {
        id: source,
        fromStep: 3,
      });
      await runtime.scheduler.metadata(jobs[2].id, { title: "changed" });
      const failed: any = await runtime.command("workflow.retry", {
        requestId: randomUUID(),
        previewId: stale.id,
      });
      expect(failed.state).toBe("uncertain");
      expect(failed.error).toContain("changed");
      expect(runtime.store.data.jobs).toHaveLength(4);
    } finally {
      await runtime.close();
      await fs.rm(base, { recursive: true, force: true });
    }
  },
);
