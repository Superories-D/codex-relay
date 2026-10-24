import { randomUUID } from "node:crypto";
import { deliveryAccepted } from "../shared/delivery";
import type { Job } from "../shared/types";
import type { Chats } from "./chat";
import { redactValue } from "./redact";
const block = (text: string) => {
  const fence = "`".repeat(
    Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)),
  );
  return `${fence}text\n${text}\n${fence}`;
};
export class WorkflowReports {
  private previews = new Map<
    string,
    { expires: number; json: string; markdown: string }
  >();
  constructor(
    private chats: Chats,
    private jobs: () => Job[],
    private now = Date.now,
  ) {}
  async preview(id: string) {
    const jobs = structuredClone(
      this.jobs().filter((j) => j.workflow?.id === id),
    ).sort((a, b) => a.workflow!.step - b.workflow!.step);
    if (!jobs.length) throw Error("工作流不存在");
    const expected = Math.max(...jobs.map((j) => j.workflow!.total));
    const missingStages = Array.from(
      { length: expected },
      (_, i) => i + 1,
    ).filter((n) => !jobs.some((j) => j.workflow!.step === n));
    const stages = [];
    for (const job of jobs) {
      let before: number | undefined, latest;
      do {
        const page = await this.chats.read(job.id, before);
        latest = [...page.items]
          .reverse()
          .find((i) => i.role === "assistant" && i.text.trim());
        before = page.before;
      } while (!latest && before !== undefined);
      const assets = await this.chats.assets(job.id);
      stages.push({
        id: job.id,
        step: job.workflow!.step,
        title: job.title,
        state: job.state,
        delivery: job.delivery?.checks.length ? {revision: job.delivery.revision, accepted: deliveryAccepted(job.delivery), latest: job.delivery.reports.at(-1) || null} : null,
        cwd: job.cwd,
        dependsOn: job.dependsOn || [],
        lastError: job.lastError,
        latestResponse: latest
          ? {
              at: latest.at,
              status: latest.status,
              text: latest.text.slice(0, 50000),
              truncated: latest.text.length > 50000 || !!latest.sourceTruncated,
            }
          : null,
        outputs: assets.outputs
          .slice(0, 100)
          .map((a) => ({ name: a.name, path: a.path, kind: a.kind })),
        outputsTruncated: assets.outputs.length > 100,
        recovery: (job.recoveryHistory || [])
          .slice(-50)
          .map((e) => ({ ...e, detail: e.detail?.slice(0, 2000) })),
      });
    }
    const raw = {
      schemaVersion: 1,
      id,
      title: jobs[0].workflow!.title,
      generatedAt: new Date(this.now()).toISOString(),
      expectedStages: expected,
      missingStages,
      complete:
        !missingStages.length &&
        stages.length === expected &&
        stages.every((s) => s.state === "completed" && (!s.delivery || s.delivery.accepted)),
      stages,
    };
    const report = redactValue(raw);
    const markdown =
      [
        `# Workflow handoff: ${report.title.replace(/[\r\n]/g, " ")}`,
        `Generated: ${report.generatedAt}`,
        `Complete: ${report.complete ? "yes" : "no"} · Stages: ${stages.length}/${expected}`,
        `Missing stages: ${missingStages.join(", ") || "none"}`,
        "Latest recorded responses are not independent verification. Output paths are references; files are not embedded.",
        ...report.stages.flatMap((s) => [
          `## Stage ${s.step}: ${s.title.replace(/[\r\n]/g, " ")}`,
          `State: ${s.state}`,
          s.delivery ? `Delivery acceptance: ${s.delivery.accepted ? "passed" : "not accepted"} · Contract r${s.delivery.revision}` : "",
          s.delivery ? block(JSON.stringify(s.delivery.latest, null, 2)) : "",
          `Workspace: ${JSON.stringify(s.cwd)}`,
          `Dependencies: ${s.dependsOn.join(", ") || "none"}`,
          s.lastError ? block(s.lastError) : "",
          "### Latest recorded response",
          s.latestResponse
            ? block(s.latestResponse.text) +
              (s.latestResponse.truncated
                ? "\n[Response truncated at 50,000 characters]"
                : "")
            : "No assistant response recorded.",
          "### Output references",
          s.outputs.map((a) => `- ${JSON.stringify(a.path)}`).join("\n") ||
            "None recorded.",
          s.outputsTruncated ? "[First 100 output references shown]" : "",
          "### Recovery history",
          block(JSON.stringify(s.recovery, null, 2)),
        ]),
      ]
        .filter(Boolean)
        .join("\n\n") + "\n";
    const json = JSON.stringify(report, null, 2);
    for (const [key, value] of this.previews)
      if (value.expires <= this.now()) this.previews.delete(key);
    while (this.previews.size >= 5)
      this.previews.delete(this.previews.keys().next().value!);
    const previewId = randomUUID();
    this.previews.set(previewId, {
      expires: this.now() + 10 * 60 * 1000,
      json,
      markdown,
    });
    return { previewId, report, markdown };
  }
  document(previewId: string, format: "markdown" | "json") {
    const preview = this.previews.get(previewId);
    if (!preview || preview.expires <= this.now())
      throw Error("报告预览已过期，请重新生成");
    return format === "json" ? preview.json : preview.markdown;
  }
}
