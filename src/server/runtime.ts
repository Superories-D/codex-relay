import {sourceVersion} from "../shared/build-info";
import {randomUUID} from "node:crypto";
import {ServerWorkflows} from "./workflows";
import { Desktop } from "../core/desktop";
import { Schedules } from "../core/schedules";
import { scheduleInputSchema, scheduleAbandonSchema } from "../core/schedule-command";
import { prepareWorkspaces, resolveWorkspace } from "./workspaces";
import {goalUpdateSchema,updateGoal} from "../core/goal-command";
import { RemoteActions } from "./actions";
import { ServerUploads } from "./uploads";
import { conversationExport } from "../core/conversation-export";
import { checkEnvironment } from "../core/diagnostics";
import { Templates } from "../core/templates";
import { serviceHealth } from "../core/service-health";
import { WorkflowReports } from "../core/workflow-report";
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
  settingsSchema,
  newJobSchema,
  controlSchema,
  chatSendSchema,
  idSchema,
  deliverySaveSchema,
} from "../main/validation";
import { ServerCipher } from "./vault";
import { acquireOwner } from "./owner";
import { CliSetup } from "../core/cli-setup";
export class ServerRuntime {
  private cliSetup?: CliSetup;
  enableCliSetup() {
    if (this.cliSetup) return this.cliSetup;
    const setup = new CliSetup({
      root: this.store.root,
      configured: () => this.store.data.settings.cliPath,
      select: async (cli, previous) => {
        if (this.closing || this.store.data.settings.cliPath !== previous) throw Error("CLI path changed during installation");
        this.store.data.settings.cliPath = cli;
        try { await this.store.save(); } catch (error) { this.store.data.settings.cliPath = previous; throw error; }
        this.scheduler.changed();
      },
    });
    this.cliSetup = setup;
    this.scheduler.runtimeReady = () => setup.state.phase === "ready";
    return setup;
  }
  get uploads() { return this.uploadStore ||= new ServerUploads(this.store.root); }
  private uploadStore?: ServerUploads;
  private remoteActions?: RemoteActions;
  private reports?: WorkflowReports;
  private templates?: Templates;
  private closing = false;
  private closePromise?: Promise<void>;
  private inFlight = new Set<Promise<unknown>>();
  private constructor(
    readonly store: Store,
    readonly accounts: Accounts,
    readonly scheduler: Scheduler,
    private owner: Awaited<ReturnType<typeof acquireOwner>>,
    readonly desktop: Desktop,
    private workspaceRoots: string[],
    readonly installationId: string,
  ) {
    this.schedules=new Schedules(desktop,scheduler,()=>scheduler.changed(),Date.now,()=>Intl.DateTimeFormat().resolvedOptions().timeZone,async task=>{await resolveWorkspace(this.workspaceRoots,task.cwd);});
  }
  readonly schedules: Schedules;
  static async open(directory: string, cliPath?: string, workspaces: string[] = []) {
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
      const installation=z.object({version:z.literal(1),kind:z.literal("codex-relay-server"),id:idSchema.optional()}).parse(JSON.parse(await fs.readFile(marker,"utf8")));
      if(!installation.id){installation.id=randomUUID();await atomicWrite(marker,JSON.stringify(installation));}
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
      const desktop=new Desktop(root);await desktop.load();
      const runtime = new ServerRuntime(store, accounts, scheduler, owner,desktop,await prepareWorkspaces(root,workspaces),installation.id);
      return runtime;
    } catch (error) {
      await owner.release();
      throw error;
    }
  }
  start(onFailure: (error: unknown) => void) {
    if (this.cliSetup) void this.cliSetup.ensure().then(state => {
      if (state.phase === "error") onFailure(Error(state.error || "Codex CLI installation failed"));
    });
    this.owner.onLost(() => {
      void this.close().catch(onFailure);
      onFailure(Error("Server ownership lock was lost"));
    });
    this.scheduler.start();
    this.schedules.start();
  }
  get draining() { return this.closing; }
  beginDrain() { this.closing = true; this.scheduler.interruptDeliveryChecks(); }
  command(name: string, args?: unknown): Promise<unknown> {
    if (name === "health") return Promise.resolve(serviceHealth(this.scheduler.snapshot(),this.closing));
    if (this.closing) return Promise.reject(Object.assign(Error("Server is shutting down; retry after restart"),{status:503}));
    const task = this.execute(name, args);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task)).catch(() => {});
    return task;
  }
  private async execute(name: string, args?: unknown): Promise<unknown> {
    switch (name) {
      case "cli.status":
        return structuredClone(this.cliSetup?.state || { phase: "checking" });
      case "cli.ensure":
        return this.enableCliSetup().ensure();
      case "workflow.previewRetry": {
        const a=z.object({id:idSchema,fromStep:z.number().int().min(1).max(12)}).strict().parse(args);
        return new ServerWorkflows(this,this.workspaceRoots).preview(a.id,a.fromStep);
      }
      case "workflow.retry": {
        const a=z.object({requestId:idSchema,previewId:idSchema}).strict().parse(args);
        const workflows=new ServerWorkflows(this,this.workspaceRoots),preview=await workflows.read(a.previewId);
        return (this.remoteActions ||= new RemoteActions(this.store.root)).run(a.requestId,name,preview.sourceId,{previewId:a.previewId},()=>workflows.fork(a.requestId,a.previewId));
      }
      case "workflow.control": {
        const a=z.object({requestId:idSchema,id:idSchema,action:z.enum(["pause","resume"])}).strict().parse(args);
        return (this.remoteActions ||= new RemoteActions(this.store.root)).run(a.requestId,name,a.id,{action:a.action},async()=>{
          const jobs=this.store.data.jobs.filter(j=>j.workflow?.id===a.id && !["completed","cancelled"].includes(j.state));
          if(!jobs.length)throw Error("No unfinished workflow stages");
          return this.scheduler.controlMany(jobs.map(j=>j.id),a.action);
        });
      }

      case "schedule.list":
        return {tasks:this.desktop.data.schedules,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,serverTime:Date.now()};
      case "schedule.create":
      case "schedule.save": {
        const a=z.object({requestId:idSchema,id:idSchema,input:scheduleInputSchema.omit({id:true})}).strict().parse(args);
        a.input.cwd=await resolveWorkspace(this.workspaceRoots,a.input.cwd);
        return (this.remoteActions ||= new RemoteActions(this.store.root)).run(a.requestId,name,a.id,a.input,async()=>{
          if(this.desktop.data.schedules.length>=200 && name==="schedule.create")throw Error("Schedule limit reached (200)");
          await this.schedules.save({...a.input,...(name==="schedule.save"?{id:a.id}:{})},name==="schedule.create"?a.id:undefined);
          return this.desktop.data.schedules.find(t=>t.id===a.id);
        });
      }
      case "schedule.remove":
      case "schedule.run": {
        const a=z.object({requestId:idSchema,id:idSchema}).strict().parse(args);
        return (this.remoteActions ||= new RemoteActions(this.store.root)).run(a.requestId,name,a.id,{},async()=>name==="schedule.run"?this.schedules.run(a.id):this.schedules.remove(a.id).then(()=>({removed:true})));
      }
      case "schedule.abandon": {
        const a=scheduleAbandonSchema.extend({requestId:idSchema}).parse(args);
        return (this.remoteActions ||= new RemoteActions(this.store.root)).run(a.requestId,name,a.id,{runId:a.runId},()=>this.schedules.abandonPending(a.id,a.runId));
      }

      case "goal.read": {
        const a=z.object({id:idSchema}).strict().parse(args);
        return this.scheduler.goal(a.id,"thread/goal/get");
      }
      case "goal.update": {
        const a=z.object({requestId:idSchema,input:goalUpdateSchema}).strict().parse(args);
        return (this.remoteActions ||= new RemoteActions(this.store.root)).run(a.requestId,name,a.input.id,a.input,()=>updateGoal(this.scheduler,a.input));
      }

      case "action.read":
        return (this.remoteActions ||= new RemoteActions(this.store.root)).read(idSchema.parse(args));
      case "actions.list":
        return (this.remoteActions ||= new RemoteActions(this.store.root)).list(args);
      case "delivery.read":
        return this.scheduler.readDelivery(idSchema.parse(args));
      case "delivery.repair":
        return this.scheduler.deliveryPrompt(idSchema.parse(args));
      case "delivery.save": {
        const a=deliverySaveSchema.extend({requestId:idSchema}).parse(args);
        return (this.remoteActions ||= new RemoteActions(this.store.root)).run(a.requestId,name,a.id,{revision:a.revision,checks:a.checks},()=>this.scheduler.saveDelivery(a.id,a.revision,a.checks));
      }
      case "delivery.run": {
        const a=z.object({requestId:idSchema,id:idSchema,revision:z.number().int().nonnegative(),reportId:idSchema.optional()}).strict().parse(args);
        const expected={revision:a.revision,reportId:a.reportId};
        return (this.remoteActions ||= new RemoteActions(this.store.root)).run(a.requestId,name,a.id,expected,()=>this.scheduler.checkDelivery(a.id,"manual",undefined,expected));
      }
      case "models.list":
        return this.store.data.accounts.filter(a=>a.enabled).map(a=>({account:a.label,ids:a.modelAccess?.ids||[],observedAt:a.modelAccess?.observedAt||0,complete:a.modelAccess?.complete||false}));
      case "task.steer": {
        const a=z.object({requestId:idSchema,id:idSchema,text:z.string().trim().min(1).max(100000)}).strict().parse(args);
        return (this.remoteActions ||= new RemoteActions(this.store.root)).run(a.requestId,name,a.id,{text:a.text},()=>this.scheduler.send({id:a.id,text:a.text,attachments:[],action:"steer"}));
      }
      case "task.model": {
        const a=z.object({requestId:idSchema,id:idSchema,model:z.string().trim().min(1).max(200),effort:z.string().max(20).regex(/^(?:[a-z][a-z0-9_-]*)?$/).default("")}).strict().parse(args);
        return (this.remoteActions ||= new RemoteActions(this.store.root)).run(a.requestId,name,a.id,{model:a.model,effort:a.effort},()=>this.scheduler.model(a.id,a.model,a.effort));
      }

      case "templates.list":
      case "templates.save":
      case "templates.remove": {
        this.templates ||= new Templates(this.store.root);
        if (name === "templates.list") return this.templates.list();
        return name === "templates.save" ? this.templates.save(args) : this.templates.remove(args);
      }
      case "settings.save": {
        const input = settingsSchema.parse(args);
        const changed = input.cliPath !== undefined && input.cliPath !== this.store.data.settings.cliPath;
        const result = await this.scheduler.configure(input);
        if (changed && this.cliSetup) void this.cliSetup.ensure();
        return result;
      }
      case "environment.check":
        return checkEnvironment(this.store.data.settings.cliPath);
      case "health":
        return serviceHealth(this.scheduler.snapshot(), this.closing);
      case "snapshot":
        return this.scheduler.snapshot();
      case "job.add": {
        const input = newJobSchema.parse(args);
        if (input.mode !== "cli") throw Error("Only CLI tasks are supported");
        return this.scheduler.add(input);
      }
      case "job.submit": {
        const a = z
          .object({ requestId: idSchema, input: newJobSchema })
          .strict()
          .parse(args);
        if (a.input.mode !== "cli") throw Error("Only CLI tasks are supported");
        return this.scheduler.add(a.input, undefined, undefined, a.requestId);
      }
      case "workflow.add": {
        const a = z
          .object({
            requestId: idSchema,
            title: z.string().trim().min(1).max(120),
            steps: z.array(newJobSchema).min(2).max(12),
          })
          .strict()
          .parse(args);
        return this.scheduler.addWorkflow(a.requestId, a.title, a.steps);
      }
      case "workflow.report": {
        this.reports ||= new WorkflowReports(
          this.scheduler.chats,
          () => this.store.data.jobs,
        );
        return this.reports.preview(idSchema.parse(args));
      }
      case "scheduler.dispatch": {
        const a = z
          .object({
            paused: z.boolean(),
            cwd: z.string().min(1).max(32768).optional(),
          })
          .strict()
          .parse(args);
        return this.scheduler.dispatch(a.paused, a.cwd);
      }
      case "scheduler.projectLimit": {
        const a = z
          .object({
            cwd: z.string().min(1).max(32768),
            limit: z.number().int().min(1).max(8).nullable(),
          })
          .strict()
          .parse(args);
        return this.scheduler.projectLimit(a.cwd, a.limit);
      }
      case "job.dependencies": {
        const a = z
          .object({ id: idSchema, ids: z.array(idSchema).max(20) })
          .strict()
          .parse(args);
        return this.scheduler.dependencies(a.id, a.ids);
      }
      case "chat.export": {
        const id=idSchema.parse(args),job=this.store.data.jobs.find(j=>j.id===id);
        if(!job)throw Error("Task does not exist");
        return conversationExport(this.scheduler.chats,job);
      }
      case "chat.search": {
        const a = z.object({ id:idSchema, query:z.string().trim().min(1).max(200), offset:z.number().int().min(0).max(10000000).default(0), role:z.enum(["user","assistant","tool","system"]).optional() }).strict().parse(args);
        if (!this.store.data.jobs.some(j => j.id === a.id)) throw Error("Task does not exist");
        return this.scheduler.chats.search(a.id,a.query,a.offset,a.role);
      }
      case "chat.searchItem": {
        const a=z.object({id:idSchema,itemId:z.string().min(1).max(1000)}).strict().parse(args);
        if (!this.store.data.jobs.some(j=>j.id===a.id)) throw Error("Task does not exist");
        const item=await this.scheduler.chats.item(a.id,a.itemId);
        if (!item) throw Error("Message does not exist");
        return {text:item.text.slice(0,500000),detail:item.detail?.slice(0,500000),truncated:item.text.length>500000||(item.detail?.length||0)>500000};
      }
      case "chat.read": {
        const a = z
          .object({
            id: idSchema,
            before: z.number().int().nonnegative().optional(),
          })
          .strict()
          .parse(args);
        if (!this.store.data.jobs.some((j) => j.id === a.id))
          throw Error("Task does not exist");
        return this.scheduler.chats.read(a.id, a.before);
      }
      case "jobs.control": {
        const a=z.object({ids:z.array(idSchema).min(1).max(100),action:z.enum(["pause","resume"])}).strict().parse(args);
        return this.scheduler.controlMany(a.ids,a.action);
      }
      case "job.control": {
        const a = controlSchema.parse(args);
        return this.scheduler.control(a.id, a.action);
      }
      case "job.metadata": {
        const {id,...patch}=z.object({id:idSchema,title:z.string().trim().min(1).max(120).optional(),pinned:z.boolean().optional(),archived:z.boolean().optional()}).strict().parse(args);
        return this.scheduler.metadata(id,patch);
      }
      case "chat.priority": {
        const a = z.object({id:idSchema,priority:z.enum(["high","normal","low"])}).strict().parse(args);
        return this.scheduler.priority(a.id,a.priority);
      }
      case "chat.queue":
        return this.scheduler.editQueue(z.object({id:idSchema,messageId:idSchema,revision:z.number().int().nonnegative(),action:z.enum(["edit","remove","up","down"]),text:z.string().trim().min(1).max(100000).optional()}).strict().parse(args));
      case "chat.submit": {
        const a=z.object({requestId:idSchema,input:chatSendSchema}).strict().parse(args);
        return this.scheduler.send(a.input,a.requestId);
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
          version: sourceVersion,
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
    this.beginDrain();
    await this.cliSetup?.shutdown();
    await Promise.allSettled([...this.inFlight]);
    await this.schedules.shutdown();
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
