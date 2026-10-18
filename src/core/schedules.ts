import { randomUUID } from "node:crypto";
import { Desktop, nextSchedule, type ScheduledTask } from "./desktop";
import type { Scheduler } from "./scheduler";
import type { Job } from "../shared/types";
import { redact } from "./redact";

export type ScheduleInput = Pick<
  ScheduledTask,
  | "title"
  | "prompt"
  | "cwd"
  | "enabled"
  | "cadence"
  | "minutes"
  | "hour"
  | "minute"
  | "weekday"
  | "worktree"
> & { id?: string };

// The desktop reservation is persisted before any worktree or job is created.
// Jobs keep that reservation's identity, allowing recovery across the two stores
// without resubmitting a task after a crash between their respective writes.
export class Schedules {
  private operations = new Map<string, Promise<unknown>>();
  private running = new Map<string, Promise<Job | undefined>>();
  private polling?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private closing = false;
  constructor(
    private desktop: Desktop,
    private scheduler: Scheduler,
    private changed: () => void = () => {},
    private now = Date.now,
  ) {}

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const task = (this.operations.get(id) || Promise.resolve())
      .catch(() => {})
      .then(fn);
    this.operations.set(id, task);
    void task
      .finally(() => {
        if (this.operations.get(id) === task) this.operations.delete(id);
      })
      .catch(() => {});
    return task;
  }
  private task(id: string) {
    const task = this.desktop.data.schedules.find((task) => task.id === id);
    if (!task) throw new Error("定时任务不存在");
    return task;
  }
  save(input: ScheduleInput) {
    const id = input.id || randomUUID();
    return this.serial(id, async () => {
      if (this.closing) throw new Error("客户端正在退出，请稍后再操作定时任务");
      const previous = input.id ? this.task(id) : undefined;
      const task: ScheduledTask = {
        ...previous,
        ...input,
        id,
        nextRun: nextSchedule(input, this.now()),
      };
      if (previous) Object.assign(previous, task);
      else this.desktop.data.schedules.push(task);
      await this.desktop.save();
      this.changed();
      return this.desktop.data;
    });
  }
  remove(id: string) {
    return this.serial(id, async () => {
      if (this.closing) throw new Error("客户端正在退出，请稍后再操作定时任务");
      this.desktop.data.schedules = this.desktop.data.schedules.filter(
        (task) => task.id !== id,
      );
      await this.desktop.save();
      this.changed();
      return this.desktop.data;
    });
  }
  run(id: string, automatic = false): Promise<Job | undefined> {
    const pending = this.running.get(id);
    if (pending)
      return automatic ? pending : pending.then((job) => job ?? this.run(id));
    const task = this.serial(id, () => this.runOnce(id, automatic));
    this.running.set(id, task);
    void task
      .finally(() => {
        if (this.running.get(id) === task) this.running.delete(id);
      })
      .catch(() => {});
    return task;
  }
  private async finish(task: ScheduledTask, job: Job) {
    task.lastRun = job.schedule!.requestedAt;
    task.lastJobId = job.id;
    task.lastError = undefined;
    // Keep the reservation until the bookkeeping write succeeds in memory too.
    const pending = task.pendingRun;
    delete task.pendingRun;
    try {
      await this.desktop.save();
    } catch (error) {
      task.pendingRun = pending;
      throw error;
    }
    this.changed();
    return job;
  }
  private async runOnce(id: string, automatic: boolean) {
    if (this.closing) throw new Error("客户端正在退出，请稍后再操作定时任务");
    const task = this.task(id);
    const now = this.now();
    if (task.pendingRun) {
      const admitted = this.scheduler.store.data.jobs.find(
        (job) =>
          job.schedule?.taskId === task.id &&
          job.schedule.runId === task.pendingRun!.id,
      );
      if (admitted) {
        await this.scheduler.store.save();
        return this.finish(task, admitted);
      }
    }
    if (
      automatic &&
      (!task.enabled ||
        (task.nextRun > now && (!task.pendingRun || task.lastError)))
    )
      return;
    try {
      const previous = this.scheduler.store.data.jobs.find(
        (job) => job.id === task.lastJobId,
      );
      if (
        previous &&
        (previous.recoveryRequired ||
          !["completed", "cancelled"].includes(previous.state))
      )
        throw new Error("此定时任务的上一次运行尚未结束");
      if (!task.pendingRun)
        task.pendingRun = { id: randomUUID(), requestedAt: now };
      // Collapse missed intervals to one occurrence. A manual run only consumes
      // a due occurrence, and does not postpone a future scheduled execution.
      if (task.nextRun <= now) task.nextRun = nextSchedule(task, now);
      task.lastError = undefined;
      await this.desktop.save();
      const reservation = task.pendingRun;
      const cwd = task.worktree
        ? (await this.desktop.worktree(task.cwd, "HEAD", reservation.id)).cwd
        : task.cwd;
      if (this.closing) throw new Error("客户端正在退出，请稍后再操作定时任务");
      const job = await this.scheduler.add(
        {
          title: task.title,
          prompt: task.prompt,
          cwd,
          mode: "cli",
          model: "",
          effort: "",
          bucket: "codex",
          approvalPolicy: "on-request",
          sandbox: "workspaceWrite",
          interactive: true,
          multiAgent: true,
        },
        undefined,
        {
          taskId: id,
          runId: reservation.id,
          requestedAt: reservation.requestedAt,
        },
      );
      return await this.finish(task, job);
    } catch (error) {
      task.lastError = redact(error instanceof Error ? error.message : error);
      if (automatic && task.nextRun <= now)
        task.nextRun = nextSchedule(task, now);
      await this.desktop.save();
      this.changed();
      throw error;
    }
  }
  tick(): Promise<void> {
    if (this.polling) return this.polling;
    if (this.closing) return Promise.resolve();
    this.polling = Promise.all(
      this.desktop.data.schedules
        .filter(
          (task) =>
            task.pendingRun || (task.enabled && task.nextRun <= this.now()),
        )
        .map((task) =>
          this.run(task.id, true).catch((error) =>
            this.scheduler.log(error, "warning"),
          ),
        ),
    )
      .then(() => {})
      .finally(() => {
        this.polling = undefined;
      });
    return this.polling;
  }
  start() {
    this.closing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), 15000);
    this.timer.unref?.();
    void this.tick();
  }
  async shutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.polling;
    await Promise.allSettled([...this.operations.values()]);
  }
}
