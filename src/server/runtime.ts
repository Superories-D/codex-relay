import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Store, atomicWrite } from "../core/store";
import { Accounts } from "../core/accounts";
import { Scheduler } from "../core/scheduler";
import { CliWorker } from "../core/cli-worker";
import { recoverJob } from "../core/recovery";
import { respondApproval } from "../core/approval-command";
import { taskReport } from "../core/task-report";
import {
  newJobSchema,
  controlSchema,
  chatSendSchema,
  idSchema,
} from "../main/validation";
import { ServerCipher } from "./vault";
import { acquireOwner } from "./owner";
export class ServerRuntime {
  private closing = false;
  private closePromise?: Promise<void>;
  private inFlight = new Set<Promise<unknown>>();
  private constructor(
    readonly store: Store,
    readonly accounts: Accounts,
    readonly scheduler: Scheduler,
    private owner: Awaited<ReturnType<typeof acquireOwner>>,
  ) {}
  static async open(directory: string, cliPath?: string) {
    if (process.platform !== "linux")
      throw Error("The headless entry point currently supports Linux only");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(directory),
      stat = await fs.stat(root);
    if (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
      throw Error("Server data directory must be owner-only (0700)");
    const owner = await acquireOwner(root);
    try {
      const marker = path.join(root, "server-installation.json");
      try {
        await fs.access(marker);
      } catch {
        try {
          await fs.access(path.join(root, "state.json"));
          throw Error(
            "Use a separate data directory for the server; desktop vaults are not interchangeable",
          );
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
        await atomicWrite(
          marker,
          JSON.stringify({ version: 1, kind: "codex-relay-server" }),
        );
      }
      const store = new Store(root);
      await store.load();
      if (
        store.data.jobs.some(
          (j) =>
            j.mode !== "cli" || (j.existing && j.existing.phase !== "managed"),
        )
      )
        throw Error(
          "Server data contains unsupported desktop or unmanaged tasks",
        );
      const cipher = await ServerCipher.open(
        root,
        store.data.accounts.length === 0,
      );
      if (cliPath) store.data.settings.cliPath = cliPath;
      let scheduler: Scheduler;
      const accounts = new Accounts(store, cipher, () => scheduler?.changed());
      scheduler = new Scheduler(
        store,
        accounts,
        {
          cli: (ctx) => new CliWorker(ctx),
          desktop: () => {
            throw Error("Desktop workers are unavailable on the server");
          },
        },
        (job) => recoverJob(job, store, accounts, ""),
      );
      await store.save();
      const runtime = new ServerRuntime(store, accounts, scheduler, owner);
      return runtime;
    } catch (error) {
      await owner.release();
      throw error;
    }
  }
  start(onFailure: (error: unknown) => void) {
    this.owner.onLost(() => {
      void this.close().catch(onFailure);
      onFailure(Error("Server ownership lock was lost"));
    });
    this.scheduler.start();
  }
  command(name: string, args?: unknown): Promise<unknown> {
    if (this.closing) return Promise.reject(Error("Server is shutting down"));
    const task = this.execute(name, args);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task)).catch(() => {});
    return task;
  }
  private async execute(name: string, args?: unknown): Promise<unknown> {
    switch (name) {
      case "snapshot":
        return this.scheduler.snapshot();
      case "job.add": {
        const input = newJobSchema.parse(args);
        if (input.mode !== "cli") throw Error("Only CLI tasks are supported");
        return this.scheduler.add(input);
      }
      case "job.control": {
        const a = controlSchema.parse(args);
        return this.scheduler.control(a.id, a.action);
      }
      case "chat.send":
        return this.scheduler.send(chatSendSchema.parse(args));
      case "approval.list":
        return this.scheduler.snapshot().approvals;
      case "approval.respond":
        return respondApproval(this.scheduler, args);
      case "account.importText": {
        const a = z
          .object({
            text: z.string().max(2 * 1024 * 1024),
            label: z.string().max(100).optional(),
          })
          .strict()
          .parse(args);
        return this.accounts.import(a.text, a.label);
      }
      case "account.list":
        return this.scheduler.snapshot().accounts;
      case "job.report":
        return taskReport(this.scheduler.snapshot(), idSchema.parse(args), {
          version: "0.6.17-source",
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
        });
      default:
        throw Error("Command is unavailable on the headless server");
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeOnce().catch((error) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }
  private async closeOnce() {
    this.closing = true;
    await Promise.allSettled([...this.inFlight]);
    const resume = new Set(
      this.store.data.jobs
        .filter(
          (j) =>
            !j.stopIntent &&
            ["queued", "waiting", "preparing", "running", "rotating"].includes(
              j.state,
            ),
        )
        .map((j) => j.id),
    );
    try {
      await this.scheduler.shutdown();
      // Service shutdown is not a user Pause. Resume only work that shutdown
      // itself stopped after process ownership was positively released.
      for (const job of this.store.data.jobs)
        if (
          resume.has(job.id) &&
          job.state === "paused" &&
          job.stopIntent === "pause"
        ) {
          job.stopIntent = undefined;
          job.state = "queued";
          job.stage = "等待服务重启后继续";
        }
      await this.store.save();
      await this.owner.release();
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }
}
