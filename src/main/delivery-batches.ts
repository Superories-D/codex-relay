import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWrite } from "../core/store";
import { verifyDelivery } from "../core/delivery";
import { redact, redactValue } from "../core/redact";
import type { Job } from "../shared/types";
import type { DeliveryState } from "../shared/delivery";
import { compareDeliveryEvidence, deliveryBatchStateSchema,
  type DeliveryBatch, type DeliveryBatchState } from "../shared/delivery-center";

// One Windows batch at a time; no model requests are issued by this coordinator.
// Explicit verify mode delegates state/queue admission to the existing scheduler.
export class DeliveryBatches {
  private state?: DeliveryBatchState;
  private chain: Promise<unknown> = Promise.resolve();
  private active?: {id: string; controller: AbortController; done: Promise<void>};
  private closing = false;
  private fault?: string;
  constructor(private options: {
    root: string;
    target: (id: string) => Job;
    verify: (id: string, signal: AbortSignal, expected: {revision: number; reportId?: string}) => Promise<DeliveryState>;
    invalidate: (id: string, revision: number, reportId: string, reason: "changed" | "unverified") => Promise<unknown>;
    inspect?: typeof verifyDelivery;
    write?: typeof atomicWrite;
  }) {}
  private get file() {return path.join(this.options.root, "delivery-batches.json");}
  private queue<T>(action: () => Promise<T>) {
    const task = this.chain.then(action); this.chain = task.catch(() => {}); return task;
  }
  private async commit(next: DeliveryBatchState) {
    try {await (this.options.write ?? atomicWrite)(this.file, JSON.stringify(next));}
    catch {this.fault = "批量验收记录无法保存，已停止本批次。请检查磁盘后重启。"; throw Error(this.fault);}
    this.state = next;
  }
  async load() {
    if (this.state) return this.state;
    try {
      this.state = deliveryBatchStateSchema.parse(JSON.parse(await fs.readFile(this.file, "utf8")));
      const next = structuredClone(this.state);
      let interrupted = false;
      for (const batch of next.batches) if (batch.status === "running") {
        interrupted = true; batch.status = "interrupted"; batch.finishedAt = Date.now();
        for (const item of batch.items) if (item.status === "checking") {
          item.status = "unverified"; item.issue = "上次验收被中断，请重新选择任务验收。";
        }
      }
      if (interrupted) {next.revision++; await this.commit(next);}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("批量验收记录无法读取；原文件未被覆盖。");
      this.state = {version: 1, revision: 0, batches: []};
    }
    return this.state;
  }
  async list() {
    await this.chain; return { ...structuredClone(await this.load()), issue: this.fault };
  }
  start(input: unknown) {
    const value = z.object({mode: z.enum(["inspect", "verify"]), targets: z.array(z.object({
      id: z.string().uuid(), revision: z.number().int().nonnegative(),
    }).strict()).min(1).max(100).refine(a => new Set(a.map(t => t.id)).size === a.length)}).strict().parse(input);
    return this.queue(async () => {
      if (this.closing || this.fault) throw Error(this.fault ?? "批量验收正在关闭");
      if (this.active) throw Error("已有批量验收正在运行");
      const next = structuredClone(await this.load());
      const batch: DeliveryBatch = {id: randomUUID(), mode: value.mode, status: "running", createdAt: Date.now(), items: value.targets.map(t => {
        try {
          const job = this.options.target(t.id);
          if (!job.delivery?.checks.length) throw Error("请先设置交付验收条件");
          if (job.delivery.revision !== t.revision) throw Error("验收条件已更改，请刷新后重试。");
          return {id: t.id, revision: t.revision, title: job.title.slice(0, 1000), status: "queued" as const,
            cwd: job.cwd, dependsOn: job.dependsOn || [], workflow: job.workflow ? {id: job.workflow.id,
              title: job.workflow.title.slice(0, 1000), step: job.workflow.step, total: job.workflow.total} : undefined,
            baselineId: job.delivery.reports.at(-1)?.id};
        } catch (error) {return {id: t.id, revision: t.revision, title: "", status: "skipped" as const, issue: redact(error instanceof Error ? error.message : error, 4000)};}
      })};
      next.batches = [...next.batches.slice(-19), batch]; next.revision++;
      await this.commit(next);
      const active = {id: batch.id, controller: new AbortController(), done: Promise.resolve()};
      this.active = active;
      active.done = this.run(active).catch(() => {}).finally(() => {if (this.active === active) this.active = undefined;});
      return structuredClone(batch);
    });
  }
  private update(id: string, fn: (batch: DeliveryBatch) => void) {
    return this.queue(async () => {
      if (this.fault) throw Error(this.fault);
      const next = structuredClone(await this.load()), batch = next.batches.find(b => b.id === id);
      if (!batch) throw Error("批量验收记录不存在");
      fn(batch); next.revision++; await this.commit(next);
    });
  }
  private async run(active: {id: string; controller: AbortController}) {
    const batch = this.state!.batches.find(b => b.id === active.id)!;
    for (const initial of batch.items) {
      if (active.controller.signal.aborted || this.closing) break;
      if (initial.status !== "queued") continue;
      await this.update(batch.id, b => {b.items.find(i => i.id === initial.id)!.status = "checking";});
      let result: Partial<DeliveryBatch["items"][number]>;
      try {
        const target = this.options.target(initial.id), delivery = target.delivery;
        if (!delivery?.checks.length || delivery.revision !== initial.revision || delivery.reports.at(-1)?.id !== initial.baselineId)
          throw Error("交付证据已更新，请重新检查");
        const baseline = delivery.reports.at(-1);
        const report = batch.mode === "verify"
          ? (await this.options.verify(initial.id, active.controller.signal, {revision: initial.revision, reportId: initial.baselineId})).reports.at(-1)!
          : await (this.options.inspect ?? verifyDelivery)(target.cwd, delivery.checks, {revision: initial.revision,
            source: "manual", turnId: target.turnId, signal: active.controller.signal});
        const comparison = compareDeliveryEvidence(baseline, report);
        if (batch.mode === "inspect" && !active.controller.signal.aborted) {
          // Re-read ownership/revision after asynchronous I/O, even for an unchanged file.
          const current = this.options.target(initial.id);
          if (current.delivery?.revision !== initial.revision || current.delivery.reports.at(-1)?.id !== initial.baselineId)
            throw Error("交付证据已更新，请重新检查");
          if (baseline && ["changed", "unverified"].includes(comparison.status))
            await this.options.invalidate(initial.id, initial.revision, baseline.id, comparison.status as "changed" | "unverified");
        }
        result = {report, comparison, status: active.controller.signal.aborted ? "cancelled"
          : batch.mode === "inspect" ? comparison.status === "current" ? "passed" : comparison.status === "changed" ? "failed" : "unverified"
          : report.status};
      } catch (error) {
        result = {status: active.controller.signal.aborted ? "cancelled" : "skipped",
          issue: redact(error instanceof Error ? error.message : error, 4000)};
      }
      await this.update(batch.id, b => Object.assign(b.items.find(i => i.id === initial.id)!, result));
    }
    await this.update(batch.id, b => {
      b.status = this.closing ? "interrupted" : active.controller.signal.aborted ? "cancelled" : "completed";
      b.finishedAt = Date.now();
      if (active.controller.signal.aborted || this.closing) for (const item of b.items)
        if (["queued", "checking"].includes(item.status)) item.status = "cancelled";
    });
  }
  async cancel(id: string) {
    const active = this.active;
    if (!active || active.id !== id) throw Error("该批次当前未运行");
    active.controller.abort(); await active.done; return this.list();
  }
  async export(id: string) {
    await this.chain; const batch = (await this.load()).batches.find(b => b.id === id);
    if (!batch) throw Error("批量验收记录不存在");
    return redactValue({schemaVersion: 1, generatedAt: new Date().toISOString(), batch: structuredClone(batch)});
  }
  async drain() {await this.active?.done; await this.chain;}
  async shutdown() {this.closing = true; this.active?.controller.abort(); await this.drain();}
  resume() {this.closing = false;}
}
