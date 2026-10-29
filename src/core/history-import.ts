import { Worker } from "node:worker_threads";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, atomicWrite } from "./store";
import { Desktop } from "./desktop";
import { redact } from "./redact";
import {
  emptyImportProgress,
  importRunning,
  type ImportProgress,
} from "../shared/history-import";

export class BackgroundHistoryImport {
  progress = emptyImportProgress();
  private worker?: Worker;
  private processing: Promise<void> = Promise.resolve();
  private duplicateSkipped = 0;
  private terminal?: "completed" | "cancelled" | "failed";
  private closing = false;
  private reportWrites: Promise<void> = Promise.resolve();
  constructor(
    private store: Store,
    private desktop: Desktop,
    private workerFile: string,
    private changed: () => void,
  ) {}
  async load() {
    try {
      const value = JSON.parse(await fs.readFile(this.reportFile, "utf8"));
      this.progress = { ...emptyImportProgress(), ...value };
      if (importRunning(this.progress.phase)) {
        this.progress.phase = "interrupted";
        this.progress.finishedAt = Date.now();
      }
    } catch (error: any) {
      if (error.code !== "ENOENT")
        this.progress.warnings.push("上次导入报告未能读取");
    }
  }
  private get reportFile() {
    return path.join(this.store.root, "history-import.json");
  }
  private save() {
    const content = JSON.stringify(this.progress);
    this.reportWrites = this.reportWrites
      .catch(() => {})
      .then(() => atomicWrite(this.reportFile, content));
    return this.reportWrites;
  }
  start(homes?: string[]) {
    if (this.closing) throw Error("正在退出");
    if (this.worker || importRunning(this.progress.phase)) return this.progress;
    this.progress = {
      ...emptyImportProgress(),
      id: randomUUID(),
      phase: "scanning",
      startedAt: Date.now(),
    };
    this.duplicateSkipped = 0;
    this.terminal = undefined;
    const worker = new Worker(this.workerFile, {
      workerData: {
        root: this.store.root,
        homes,
        cli: this.store.data.settings.cliPath,
        knownSources: this.store.data.jobs
          .map((job) => job.historySource?.threadId)
          .filter(Boolean),
        knownEntries: this.store.data.jobs
          .filter((j) => j.historySource)
          .map((j) => ({
            threadId: j.historySource!.threadId,
            id: j.id,
            storage: j.historySource!.storage,
            job: j.historySource!.storage === "sqlite" ? j : undefined,
            home:
              j.historySource!.storage === "sqlite"
                ? this.store.jobHome(j.id)
                : undefined,
            upgradable:
              j.state === "completed" &&
              !j.turnId &&
              !j.pendingMessage &&
              !j.queuedMessages?.length,
          })),
      },
    });
    this.worker = worker;
    worker.on("message", (message) => {
      this.processing = this.processing
        .then(() => this.handle(message, worker))
        .catch((error) => {
          this.terminal = "failed";
          this.progress.failed++;
          this.progress.failures.push({
            title: "导入",
            message: redact(
              error instanceof Error ? error.message : String(error),
            ),
          });
          void worker.terminate();
        });
    });
    worker.on("error", (error) => {
      if (this.worker !== worker) return;
      this.terminal = "failed";
      this.progress.failed++;
      this.progress.failures.push({
        title: "导入",
        message: redact(error.message),
      });
    });
    worker.on("exit", () => {
      this.processing = this.processing.then(async () => {
        if (this.worker !== worker) return;
        // A worker's final message can arrive long before its native handles close.
        // Publish terminal progress only once its ownership is actually released.
        this.worker = undefined;
        this.progress.phase = this.terminal || (this.closing ? "cancelled" : "failed");
        this.progress.finishedAt = Date.now();
        this.progress.current = "";
        await this.save();
        this.changed();
      });
    });
    void this.save();
    return this.progress;
  }
  private async handle(message: any, worker: Worker) {
    if (this.worker !== worker) return;
    if (message.type === "progress") {
      const phase = this.progress.phase;
      Object.assign(this.progress, message.value);
      if (phase === "cancelling") this.progress.phase = phase;
      if (typeof message.value.skipped === "number")
        this.progress.skipped = message.value.skipped + this.duplicateSkipped;
    } else if (message.type === "warning")
      this.progress.warnings = [
        ...this.progress.warnings,
        redact(message.message),
      ].slice(-100);
    else if (message.type === "failure") {
      this.progress.failed++;
      this.progress.failures = [
        ...this.progress.failures,
        { title: message.title, message: redact(message.message) },
      ].slice(-100);
    } else if (message.type === "batch") {
      for (const project of message.projects) {
        if (
          !this.desktop.data.projects.some(
            (existing) =>
              existing.cwd.toLowerCase() === project.cwd.toLowerCase(),
          )
        ) {
          this.desktop.data.projects.push({
            id: randomUUID(),
            cwd: project.cwd,
            name: project.name,
            pinned: false,
          });
          this.progress.projects++;
          if (project.missing) this.progress.missingProjects++;
        }
      }
      const known = new Set(
        this.store.data.jobs
          .map((job) => job.historySource?.threadId)
          .filter(Boolean),
      );
      for (const job of message.jobs) {
        if (job.replaceId) {
          const index = this.store.data.jobs.findIndex(
            (j) =>
              j.id === job.replaceId &&
              j.historySource?.threadId === job.historySource?.threadId &&
              j.state === "completed" &&
              !j.turnId &&
              !j.pendingMessage &&
              !j.queuedMessages?.length,
          );
          delete job.replaceId;
          if (index >= 0) {
            const old = this.store.data.jobs[index];
            const incoming = await fs.realpath(
              path.join(this.store.root, "chats", `${job.id}.jsonl`),
            );
            await fs.rename(
              incoming,
              path.join(path.dirname(incoming), `${old.id}.jsonl`),
            );
            this.store.data.jobs[index] = {
              ...job,
              id: old.id,
              pinned: old.pinned,
              archived: old.archived,
            };
            this.progress.updated++;
            continue;
          }
          this.progress.warnings.push(
            "已有会话在导入期间发生变化，保留原记录；请完成当前操作后重新导入。",
          );
        }
        if (known.has(job.historySource?.threadId)) {
          this.duplicateSkipped++;
          this.progress.skipped++;
          continue;
        }
        this.store.data.jobs.push(job);
        known.add(job.historySource?.threadId);
        this.progress.imported++;
        if (job.historySource?.issue) this.progress.readOnly++;
      }
      await Promise.all([this.store.save(), this.desktop.save(), this.save()]);
      this.changed();
      worker.postMessage({ type: "ack" });
    } else if (message.type === "done" || message.type === "fatal") {
      this.terminal = message.type === "fatal" ? "failed" : message.phase;
      if (message.type === "fatal") {
        this.progress.failed++;
        this.progress.failures.push({
          title: "导入",
          message: redact(message.message),
        });
      }
      await this.save();
    }
  }
  cancel() {
    if (this.worker && importRunning(this.progress.phase)) {
      this.progress.phase = "cancelling";
      this.worker.postMessage({ type: "cancel" });
    }
    return this.progress;
  }
  // A terminal progress message can precede worker exit and its final disk write.
  // Callers preparing another import must wait for actual idle ownership.
  async drain() {
    const worker = this.worker;
    if (worker && worker.threadId !== -1)
      await new Promise<void>(resolve => worker.once("exit", () => resolve()));
    await this.processing;
    await this.reportWrites;
  }
  async shutdown() {
    this.closing = true;
    this.cancel();
    const worker = this.worker;
    if (worker && worker.threadId !== -1) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => worker.once("exit", () => resolve())),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (this.worker === worker) await worker.terminate();
    }
    await this.processing;
    await this.save();
  }
}
