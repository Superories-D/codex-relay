import {deliveryAccepted} from "../shared/delivery";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ServerRuntime } from "./runtime";
import { newJobSchema, idSchema } from "../main/validation";
import { WorkflowReports } from "../core/workflow-report";
import { atomicWrite } from "../core/store";
import { resolveWorkspace } from "./workspaces";
const schema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    sourceId: idSchema,
    fromStep: z.number().int().min(1).max(12),
    signature: z.string(),
    title: z.string().max(120),
    steps: z.array(newJobSchema).min(1).max(12),
    at: z.number(),
  })
  .strict();
export class ServerWorkflows {
  constructor(
    private runtime: ServerRuntime,
    private roots: string[],
    private now = Date.now,
  ) {}
  private jobs(id: string) {
    const jobs = this.runtime.store.data.jobs
      .filter((j) => j.workflow?.id === id)
      .sort((a, b) => a.workflow!.step - b.workflow!.step);
    if (
      !jobs.length ||
      jobs.length !== jobs[0].workflow!.total ||
      jobs.some((j, i) => j.workflow!.step !== i + 1)
    )
      throw Error("Workflow is missing stages");
    return jobs;
  }
  private signature(id: string) {
    return createHash("sha256")
      .update(JSON.stringify(this.jobs(id)))
      .digest("hex");
  }
  private check(id: string, step: number) {
    const jobs = this.jobs(id);
    if (step > jobs.length) throw Error("Stage is outside this workflow");
    if (
      jobs.some((j, i) =>
        i < step - 1
          ? j.state !== "completed" || j.recoveryRequired || !deliveryAccepted(j.delivery)
          : j.recoveryRequired ||
            !["paused", "cancelled", "completed", "needs_attention"].includes(
              j.state,
            ),
      )
    )
      throw Error(
        "Complete earlier stages and pause remaining stages before branching",
      );
    return jobs;
  }
  async preview(id: string, fromStep: number) {
    idSchema.parse(id);
    z.number().int().min(1).max(12).parse(fromStep);
    const jobs = structuredClone(this.check(id, fromStep)),
      signature = this.signature(id),
      report = await new WorkflowReports(
        this.runtime.scheduler.chats,
        () => jobs,
      ).preview(id);
    const handoff = report.report.stages
      .filter((s) => s.step < fromStep)
      .map(
        (s) =>
          `Stage ${s.step}: ${s.title}\n${s.latestResponse?.text.slice(0, 4000) || "No recorded response"}`,
      )
      .join("\n\n")
      .slice(0, 24000);
    const steps = jobs.slice(fromStep - 1).map((job) => {
      const input: any = Object.fromEntries(
        Object.keys(newJobSchema.shape)
          .filter((key) => (job as any)[key] !== undefined)
          .map((key) => [key, (job as any)[key]]),
      );
      delete input.attachments;
      if(job.delivery?.checks.length)input.deliveryChecks=structuredClone(job.delivery.checks);
      input.prompt = handoff
        ? `${job.prompt}\n\n[Recorded handoff from workflow ${id}; unverified historical results]\n${handoff}`
        : job.prompt;
      return newJobSchema.parse(input);
    });
    for (const step of steps) await resolveWorkspace(this.roots, step.cwd);
    if (this.signature(id) !== signature)
      throw Error("Workflow changed while preparing preview; refresh");
    const preview = schema.parse({
      version: 1,
      id: randomUUID(),
      sourceId: id,
      fromStep,
      signature,
      title: (jobs[0].workflow!.title + ` · retry ${fromStep}`).slice(0, 120),
      steps,
      at: this.now(),
    });
    const dir = path.join(this.runtime.store.root, "workflow-previews");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWrite(
      path.join(dir, preview.id + ".json"),
      JSON.stringify(preview),
    );
    return preview;
  }
  async read(id: string) {
    return schema.parse(
      JSON.parse(
        await fs.readFile(
          path.join(
            this.runtime.store.root,
            "workflow-previews",
            idSchema.parse(id) + ".json",
          ),
          "utf8",
        ),
      ),
    );
  }
  async fork(requestId: string, previewId: string) {
    const preview = await this.read(previewId);
    if (this.now() - preview.at > 10 * 60 * 1000 || preview.at > this.now())
      throw Error("Workflow preview expired; prepare a new preview");
    this.check(preview.sourceId, preview.fromStep);
    if (this.signature(preview.sourceId) !== preview.signature)
      throw Error("Workflow changed; prepare a new preview");
    for (const step of preview.steps)
      await resolveWorkspace(this.roots, step.cwd);
    return this.runtime.scheduler.addWorkflow(
      requestId,
      preview.title,
      preview.steps,
      { id: preview.sourceId, step: preview.fromStep },
    );
  }
}
