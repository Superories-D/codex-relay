import { ServerAssets } from "./assets";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { attachmentsSchema } from "../main/validation";
import type { Job, NewJob } from "../shared/types";
import type { TemplateState } from "../core/templates";
import type { conversationExport } from "../core/conversation-export";
import type { ServerRuntime } from "./runtime";
import { resolveWorkspace } from "./workspaces";

export const contextSchema = z
  .object({
    project: z.string().optional(),
    attachments: attachmentsSchema.optional(),
    task: z.string().uuid().optional(),
    defaults: z
      .object({
        model: z.string().max(200),
        effort: z.string().max(20),
        planMode: z.boolean(),
        multiAgent: z.boolean(),
        prompt: z.string().max(100000).optional(),
      })
      .optional(),
  })
  .strict();
export type TelegramContext = z.infer<typeof contextSchema>;
export const buttonSchema = z
  .object({ text: z.string().max(80), callback_data: z.string().max(64) })
  .strict();
export const replySchema = z.object({
  text: z.string().max(4000),
  keyboard: z.array(z.array(buttonSchema).max(8)).max(30).optional(),
  taskId: z.string().uuid().optional(),
  document: z
    .object({
      name: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^\/\\\x00-\x1f]+$/),
      text: z
        .string()
        .max(8 * 1024 * 1024)
        .optional(),
      data: z
        .string()
        .max(12 * 1024 * 1024)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/)
        .optional(),
    })
    .strict()
    .refine(
      (d) => (d.text !== undefined) !== (d.data !== undefined),
      "Choose text or binary document",
    )
    .optional(),
});
export type TelegramReply = z.infer<typeof replySchema>;
export const button = (text: string, command: string) => {
  if (Buffer.byteLength(command) > 64)
    throw Error("Telegram button exceeds 64 bytes");
  return { text: text.slice(0, 60), callback_data: command };
};
export const homeKeyboard = () => [
  [button("项目 Projects", "/projects"), button("任务 Tasks", "/status")],
  [button("审批 / 提问", "/approvals"), button("服务 Health", "/health")],
  [button("工作流", "/workflows"), button("帮助 Help", "/help")],
];
const defaults: NonNullable<TelegramContext["defaults"]> = {
  model: "",
  effort: "",
  planMode: false,
  multiAgent: false,
};

/** Presentation and explicit user operations. It never invokes an arbitrary runtime command. */
export class TelegramConsole {
  private assetLinks = new Map<
    string,
    { jobId: string; assetId: string; expires: number }
  >();
  private pages = new Map<
    string,
    { chunks: string[]; expires: number; taskId?: string }
  >();
  private actions = new Map<
    string,
    {
      expires: number;
      jobId: string;
      signature: string;
      command: string;
      args: unknown;
    }
  >();
  constructor(
    private runtime: ServerRuntime,
    private roots: string[],
    private clean: (text: string, limit?: number) => string,
    private save: (context: TelegramContext) => Promise<void>,
    private now: () => number,
  ) {}
  job(prefix?: string) {
    if (!prefix || prefix.length < 8)
      throw Error("Select a task with /task TASK_ID (at least 8 characters)");
    const jobs = this.runtime.store.data.jobs.filter((j) =>
      j.id.startsWith(prefix),
    );
    if (jobs.length !== 1) throw Error("Task ID is missing or ambiguous");
    return jobs[0];
  }
  async input(context: TelegramContext, prompt: string): Promise<NewJob> {
    if (!context.project)
      throw Error("Select a project with /project NUMBER first");
    const settings = context.defaults || defaults;
    return {
      ...settings,
      title: prompt.split("\n")[0].slice(0, 120),
      prompt: [settings.prompt, prompt].filter(Boolean).join("\n\n"),
      cwd: await resolveWorkspace(this.roots, context.project),
      mode: "cli",
      bucket: "codex",
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
      interactive: true,
      ...(context.attachments?.length
        ? { attachments: context.attachments }
        : {}),
    };
  }
  taskKeyboard(job: Job) {
    return [
      [
        button("详情 / 选中", `/task ${job.id}`),
        button("最新结果", `/result ${job.id}`),
      ],
      [
        button("对话", `/history ${job.id}`),
        button("排队消息", `/queue ${job.id}`),
      ],
      [
        button("暂停", `/control pause ${job.id}`),
        button("恢复", `/control resume ${job.id}`),
        button("取消", `/control cancel ${job.id}`),
      ],
      [
        button("导出对话", `/export ${job.id}`),
        button("诊断报告", `/report ${job.id}`),
      ],
      [
        button("产物 / 附件", `/files ${job.id}`),
        button("任务列表", "/status"),
        button("审批 / 提问", "/approvals"),
      ],
    ];
  }
  card(job: Job): TelegramReply {
    return {
      taskId: job.id,
      keyboard: this.taskKeyboard(job),
      text:
        `${job.title}\n${job.id}\n状态: ${job.state}${job.autoRecovery ? " · 自动恢复中" : ""}\n项目: ${job.cwd}\n` +
        `优先级: ${job.priority || "normal"} · 排队: ${job.queuedMessages?.length || 0}\n` +
        `模型: ${job.model || "default"} · 推理: ${job.effort || "default"}\n` +
        (job.workflow
          ? `工作流: ${job.workflow.title} (${job.workflow.step}/${job.workflow.total})\n`
          : "") +
        (job.dependsOn?.length
          ? `依赖: ${job.dependsOn.map((id) => id.slice(0, 8)).join(", ")}\n`
          : "") +
        (job.stage ? `进度: ${job.stage.slice(0, 500)}\n` : "") +
        (job.lastError ? `最近错误: ${job.lastError.slice(0, 700)}\n` : "") +
        "\n直接发文字可追问当前选中任务；回复这张卡片可指定此任务。/new 指令 创建新任务。",
    };
  }
  private paginate(text: string, taskId?: string): TelegramReply {
    // Redact before splitting: secrets must not straddle a page boundary.
    const truncated = text.length > 8 * 1024 * 1024;
    text =
      this.clean(text, 8 * 1024 * 1024) +
      (truncated ? "\n[内容超过 8 Mi 字符，后续部分省略]" : "");
    const chunks: string[] = [];
    while (text.length) {
      let end = Math.min(3000, text.length);
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      chunks.push(text.slice(0, end));
      text = text.slice(end);
    }
    if (!chunks.length) chunks.push("暂无内容 No content.");
    for (const [key, page] of this.pages)
      if (page.expires <= this.now()) this.pages.delete(key);
    while (this.pages.size >= 12)
      this.pages.delete(this.pages.keys().next().value!);
    const key = randomBytes(6).toString("hex");
    this.pages.set(key, {
      chunks,
      taskId,
      expires: this.now() + 20 * 60 * 1000,
    });
    return this.page(key, 0);
  }
  private page(key: string, index: number): TelegramReply {
    const page = this.pages.get(key);
    if (!page || page.expires <= this.now())
      throw Error("内容快照已过期，请重新打开结果 / history / search");
    if (!Number.isInteger(index) || index < 0 || index >= page.chunks.length)
      throw Error("Invalid page");
    const nav = [];
    if (index) nav.push(button("上一页", `/page ${key} ${index - 1}`));
    if (index + 1 < page.chunks.length)
      nav.push(button("下一页", `/page ${key} ${index + 1}`));
    return {
      text: `${page.chunks[index]}\n\n[${index + 1}/${page.chunks.length} · 快照保留 20 分钟]`,
      taskId: page.taskId,
      keyboard: [
        ...(nav.length ? [nav] : []),
        ...(page.taskId
          ? [
              [
                button("任务", `/task ${page.taskId}`),
                button("导出", `/export ${page.taskId}`),
              ],
            ]
          : homeKeyboard()),
      ],
    };
  }
  private signature(job: Job) {
    return JSON.stringify([
      job.state,
      job.turnId,
      job.updatedAt,
      job.queueRevision,
      job.stopIntent,
    ]);
  }
  private action(label: string, job: Job, command: string, args: unknown) {
    for (const [key, action] of this.actions)
      if (action.expires <= this.now()) this.actions.delete(key);
    while (this.actions.size >= 200)
      this.actions.delete(this.actions.keys().next().value!);
    const key = randomBytes(6).toString("hex");
    this.actions.set(key, {
      expires: this.now() + 5 * 60 * 1000,
      jobId: job.id,
      signature: this.signature(job),
      command,
      args,
    });
    return button(label, `/confirm ${key}`);
  }
  async execute(
    command: string,
    args: string,
    context: TelegramContext,
    requestId: string,
  ): Promise<TelegramReply | string | undefined> {
    if (["help", "start", "home"].includes(command))
      return {
        keyboard: homeKeyboard(),
        text:
          "Codex Relay · 手机控制台\n\n" +
          "1. /projects → 点选项目\n2. /new 任务描述 → 创建并选中任务\n3. 直接发文字追问；回复任务卡片可指定该任务\n\n" +
          "/status [状态|all] [页码] · /task ID\n/result [ID] · /history [ID] · /export [ID]\n/search 关键词 · /report [ID]\n/schedules · /schedule create|run|pause|enable|remove\n/goal read|create|edit|start|pause|budget|clear\n/steer 立即补充 · /switchmodel 模型 [推理强度] · /models\n/queue [ID] · /priority high|normal|low\n/edit 消息ID 版本 新文字\n/remove 消息ID 版本 · /up 消息ID 版本 · /down 消息ID 版本\n" +
          "/pause [ID] · /resume [ID] · /cancel [ID]\n/rename 名称 · /pin on|off · /archive on|off\n/depends ID ID（或 none）\n\n" +
          "/workflow 标题 换行 阶段一 换行 --- 换行 阶段二\n/workflows · /handoff 工作流ID\n/templates · /template ID（或 off）\n/defaults · /model 名称（或 default）\n/effort low|medium|high|xhigh|default · /plan on|off\n\n" +
          "/approvals [页码] · /answer CODE JSON\n/dispatch pause|resume [project|all]\n/limit 1..8|auto · /health · /accounts\n/forget 清除当前任务 · /dismiss 退出答题\n\n所有操作仅接受配置的本人私聊。",
      };
    if(command === "schedules") {
      const list:any=await this.runtime.command("schedule.list");
      return this.paginate(`定时任务 · ${list.timeZone}\n`+list.tasks.map((task:any)=>`${task.id}\n${task.title} · ${task.enabled?"启用":"暂停"} · ${task.cadence}\n下一次: ${new Date(task.nextRun).toISOString()}\n${task.lastError||""}`).join("\n\n")+"\n/schedule create MINUTES 任务描述\n/schedule run|pause|enable|remove ID");
    }
    if(command === "schedule") {
      const [action,...parts]=args.split(/\s+/),value=parts.join(" ");
      if(action==="create"){
        const minutes=Number(parts.shift()),prompt=parts.join(" "),input=await this.input(context,prompt);
        const receipt:any=await this.runtime.command("schedule.create",{requestId,id:requestId,input:{title:input.title,prompt:input.prompt,cwd:input.cwd,enabled:true,cadence:"interval",minutes,hour:9,minute:0,weekday:1,worktree:false}});
        return `定时任务: ${receipt.state} · ${requestId}\n/schedules 查看；时间为服务器时区。`;
      }
      const tasks:any=await this.runtime.command("schedule.list"),matches=tasks.tasks.filter((task:any)=>value.length>=8&&task.id.startsWith(value));
      if(matches.length!==1)throw Error("Schedule ID is missing or ambiguous");
      const task=matches[0];let receipt:any;
      if(action==="pause"||action==="enable"){
        const {title,prompt,cwd,cadence,minutes,hour,minute,weekday,worktree}=task;
        receipt=await this.runtime.command("schedule.save",{requestId,id:task.id,input:{title,prompt,cwd,cadence,minutes,hour,minute,weekday,worktree,enabled:action==="enable"}});
      }else if(action==="run"||action==="remove")receipt=await this.runtime.command(`schedule.${action}`,{requestId,id:task.id});
      else throw Error("Use /schedule create|run|pause|enable|remove");
      return `定时任务操作: ${receipt.state}\n/schedules 查看状态。`;
    }
    if(command === "goal") {
      const job=this.job(context.task),match=args.match(/^(\S+)(?:\s+([\s\S]*))?$/),action=match?.[1]||"read",value=match?.[2]||"";
      if(action==="read")return this.paginate(JSON.stringify(await this.runtime.command("goal.read",{id:job.id}),null,2),job.id);
      let input:any={id:job.id,action};
      if(action==="create"){
        const spec=value.match(/^(\d+|none)\s+([\s\S]+)$/);
        if(!spec)throw Error("/goal create TOKEN_BUDGET|none 目标（创建后暂停，需 /goal start）");
        input={...input,tokenBudget:spec[1]==="none"?null:Number(spec[1]),objective:spec[2],start:false};
      }else if(action==="edit")input.objective=value;
      else if(action==="budget")input.tokenBudget=value==="none"?null:Number(value);
      else if(value)throw Error("Unexpected goal arguments");
      const receipt:any=await this.runtime.command("goal.update",{requestId,input});
      return {taskId:job.id,text:`目标操作: ${receipt.state}\n${receipt.state==="succeeded"?"已确认。/goal 查看最新状态。":"结果未知，请检查目标状态；不会自动重放。"}`,keyboard:this.taskKeyboard(job)};
    }
    if(command === "models") return this.paginate(JSON.stringify(await this.runtime.command("models.list"),null,2));
    if(command === "steer" || command === "switchmodel") {
      const job=this.job(context.task);
      const [model,effort="",...rest]=args.split(/\s+/);
      if(command==="switchmodel"&&rest.length)throw Error("Use /switchmodel MODEL [EFFORT]");
      const receipt:any=await this.runtime.command(command==="steer"?"task.steer":"task.model",{requestId,id:job.id,...(command==="steer"?{text:args}:{model,effort})});
      return {taskId:job.id,text:`操作: ${receipt.action} · ${receipt.state}\n${receipt.id}\n${receipt.state==="succeeded"?JSON.stringify(receipt.result??{}):"执行结果未确认，请检查任务状态；不会重复执行。"}`,keyboard:this.taskKeyboard(job)};
    }
    if (command === "page") {
      const [key, index] = args.split(/\s+/);
      return this.page(key, Number(index));
    }
    if (command === "projects") {
      const page = args ? Number(args) : 1,
        total = Math.max(1, Math.ceil(this.roots.length / 10));
      if (!Number.isInteger(page) || page < 1 || page > total)
        throw Error("Invalid project page");
      const start = (page - 1) * 10,
        roots = this.roots.slice(start, start + 10),
        nav = [];
      if (page > 1) nav.push(button("上一页", `/projects ${page - 1}`));
      if (page < total) nav.push(button("下一页", `/projects ${page + 1}`));
      return {
        text:
          `项目 ${page}/${total}\n` +
          (roots
            .map(
              (root, i) =>
                `${start + i + 1}. ${root.slice(0, 250)}${root.length > 250 ? "…" : ""}${root === context.project ? " ✓" : ""}`,
            )
            .join("\n") || "No workspaces configured."),
        keyboard: [
          ...roots.map((root, i) => [
            button(
              `${start + i + 1}. ${root.split("/").at(-1)}`,
              `/project ${start + i + 1}`,
            ),
          ]),
          ...(nav.length ? [nav] : []),
        ],
      };
    }
    if (command === "project") {
      const root = this.roots[Number(args) - 1];
      if (!root || !/^\d+$/.test(args))
        throw Error("Use /project NUMBER; /projects lists workspaces");
      const project = await resolveWorkspace(this.roots, root);
      await this.save({ ...context, project, task: undefined });
      return {
        text: `当前项目: ${project}\n/new 指令 创建任务。当前任务已清除。`,
        keyboard: homeKeyboard(),
      };
    }
    if (command === "forget") {
      await this.save({ ...context, task: undefined });
      return "当前任务已清除。用 /new 创建，或 /task ID 选择。";
    }
    if (command === "task") {
      const job = this.job(args || context.task);
      await this.save({ ...context, task: job.id });
      return this.card(job);
    }
    if (command === "status") {
      const [filter = "active", rawPage = "1"] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const page = Number(rawPage);
      const all = this.runtime.store.data.jobs
        .filter(
          (j) =>
            filter === "all" ||
            (filter === "active" ? !j.archived : j.state === filter),
        )
        .sort(
          (a, b) =>
            Number(!!b.pinned) - Number(!!a.pinned) ||
            b.updatedAt - a.updatedAt,
        );
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        page > Math.max(1, Math.ceil(all.length / 8))
      )
        throw Error("Invalid task page");
      const jobs = all.slice((page - 1) * 8, page * 8),
        nav = [];
      if (page > 1) nav.push(button("上一页", `/status ${filter} ${page - 1}`));
      if (page * 8 < all.length)
        nav.push(button("下一页", `/status ${filter} ${page + 1}`));
      return {
        text:
          `任务 ${page}/${Math.max(1, Math.ceil(all.length / 8))} · ${all.length} 项\n` +
          jobs
            .map(
              (j) =>
                `${j.id.slice(0, 8)} · ${j.autoRecovery ? "recovering" : j.state} · ${j.title.slice(0, 120)}`,
            )
            .join("\n"),
        keyboard: [
          ...jobs.map((j) => [
            button(`${j.id.slice(0, 8)} ${j.title}`, `/task ${j.id}`),
          ]),
          ...(nav.length ? [nav] : []),
          [
            button("全部", "/status all"),
            button("待处理", "/status needs_attention"),
            button("主页", "/home"),
          ],
        ],
      };
    }
    if (command === "new" || command === "workflow") {
      if (!args.trim())
        throw Error(`Use /${command} followed by an instruction`);
      if (command === "new") {
        const job = (await this.runtime.command("job.submit", {
          requestId,
          input: await this.input(context, args),
        })) as Job;
        await this.save({ ...context, task: job.id });
        return {
          ...this.card(job),
          text: `Queued ${job.id}\n${this.card(job).text}`,
        };
      }
      if (context.attachments?.length)
        throw Error(
          "工作流创建不接收暂存附件，请先 /inbox clear，或发送到某个阶段",
        );
      const newline = args.indexOf("\n"),
        title = args.slice(0, newline).trim();
      const prompts = args
        .slice(newline + 1)
        .split(/\r?\n---\r?\n/)
        .map((s) => s.trim());
      if (
        newline < 0 ||
        !title ||
        prompts.length < 2 ||
        prompts.length > 12 ||
        prompts.some((s) => !s)
      )
        throw Error(
          "Use /workflow 标题\n第一阶段指令\n---\n第二阶段指令（2 至 12 阶段）",
        );
      const steps = await Promise.all(
        prompts.map((prompt) => this.input(context, prompt)),
      );
      const jobs = (await this.runtime.command("workflow.add", {
        requestId,
        title,
        steps,
      })) as Job[];
      await this.save({ ...context, task: jobs[0].id });
      return {
        text: `工作流已创建: ${title}\n${requestId}\n${jobs.map((j, i) => `${i + 1}. ${j.id.slice(0, 8)} ${j.title}`).join("\n")}\n后续阶段等待前一阶段完成。`,
        keyboard: [
          ...jobs.map((j) => [
            button(`${j.workflow!.step}. ${j.title}`, `/task ${j.id}`),
          ]),
          [button("交接报告", `/handoff ${requestId}`)],
        ],
      };
    }
    if (command === "workflows") {
      const flows = new Map(
        this.runtime.store.data.jobs
          .filter((j) => j.workflow)
          .map((j) => [j.workflow!.id, j.workflow!]),
      );
      return this.paginate(
        [...flows.values()]
          .map(
            (w) =>
              `${w.title}\n${w.id}\n${this.runtime.store.data.jobs
                .filter((j) => j.workflow?.id === w.id)
                .sort((a, b) => a.workflow!.step - b.workflow!.step)
                .map(
                  (j) =>
                    `  ${j.workflow!.step}. ${j.state} · ${j.id.slice(0, 8)} · ${j.title}`,
                )
                .join("\n")}\n/handoff ${w.id}`,
          )
          .join("\n\n") || "暂无工作流。/workflow 创建分阶段任务。",
      );
    }
    if (command === "handoff") {
      const ids = [
        ...new Set(
          this.runtime.store.data.jobs
            .map((j) => j.workflow?.id)
            .filter((id): id is string => !!id && id.startsWith(args)),
        ),
      ];
      if (args.length < 8 || ids.length !== 1)
        throw Error("Use /handoff WORKFLOW_ID (unique, at least 8 characters)");
      const report = (await this.runtime.command(
        "workflow.report",
        ids[0],
      )) as { markdown: string };
      return {
        text: "工作流交接报告（包含已记录结果、状态、产物路径和恢复记录）",
        document: { name: `workflow-${ids[0]}.md`, text: report.markdown },
      };
    }
    if (["result", "history", "export", "report"].includes(command)) {
      const job = this.job(args || context.task);
      if (command === "report")
        return {
          text: `任务诊断 ${job.id}`,
          taskId: job.id,
          document: {
            name: `report-${job.id}.json`,
            text: JSON.stringify(
              await this.runtime.command("job.report", job.id),
              null,
              2,
            ),
          },
        };
      const output = (await this.runtime.command(
        "chat.export",
        job.id,
      )) as Awaited<ReturnType<typeof conversationExport>>;
      if (command === "export")
        return {
          text: `对话导出 ${job.id}${output.document.truncated ? "（已达到导出上限，较早内容被省略）" : ""}`,
          taskId: job.id,
          document: {
            name: `conversation-${job.id}.md`,
            text: output.markdown,
          },
        };
      const latest = [...output.document.items]
        .reverse()
        .find((i) => i.role === "assistant" && i.text.trim());
      const text =
        command === "history"
          ? output.markdown
          : latest
            ? `${job.title}\n${new Date(latest.at).toISOString()}\n\n${latest.text}`
            : "尚无助手回答。";
      return this.paginate(
        text +
          (output.document.truncated
            ? "\n[导出范围限最近 5000 条 / 4 MiB]"
            : ""),
        job.id,
      );
    }
    if (command === "files") {
      const [prefix, rawPage = "1"] = args.split(/\s+/),
        job = this.job(prefix || context.task),
        assets = new ServerAssets(this.runtime, this.roots),
        listing = await assets.list(job.id),
        number = Number(rawPage),
        total = Math.max(1, Math.ceil(listing.files.length / 20));
      if (!Number.isInteger(number) || number < 1 || number > total)
        throw Error("Invalid files page");
      const files = listing.files.slice((number - 1) * 20, number * 20);
      for (const [key, value] of this.assetLinks)
        if (value.expires <= this.now()) this.assetLinks.delete(key);
      const page = this.paginate(
        `产物 ${number}/${total}\n` +
          files.map((f) => `${f.name} (${f.size} bytes)`).join("\n") ||
          "暂无可下载产物。仅列出已记录、在允许目录内且不超过 8 MiB 的文件。",
        job.id,
      );
      page.keyboard = files.map((f) => {
        while (this.assetLinks.size >= 200)
          this.assetLinks.delete(this.assetLinks.keys().next().value!);
        const key = randomBytes(6).toString("hex");
        this.assetLinks.set(key, {
          jobId: job.id,
          assetId: f.id,
          expires: this.now() + 10 * 60 * 1000,
        });
        return [button(`下载 ${f.name}`, `/file ${key}`)];
      });
      const nav = [];
      if (number > 1)
        nav.push(button("上一页", `/files ${job.id} ${number - 1}`));
      if (number < total)
        nav.push(button("下一页", `/files ${job.id} ${number + 1}`));
      if (nav.length) page.keyboard.push(nav);
      page.keyboard.push([button("任务", `/task ${job.id}`)]);
      return page;
    }
    if (command === "file") {
      const link = this.assetLinks.get(args);
      if (!link || link.expires <= this.now())
        throw Error("文件链接已过期，请重新 /files");
      const asset = await new ServerAssets(this.runtime, this.roots).read(
        link.jobId,
        link.assetId,
      );
      return {
        text: `${asset.name} · ${asset.size} bytes${asset.redacted ? " · 已过滤已知凭据" : " · 原始二进制文件"}`,
        taskId: link.jobId,
        document: asset.redacted
          ? {
              name: asset.name,
              text: Buffer.from(asset.data, "base64").toString("utf8"),
            }
          : { name: asset.name, data: asset.data },
      };
    }
    if (command === "search") {
      const job = this.job(context.task);
      const result = (await this.runtime.command("chat.search", {
        id: job.id,
        query: args,
      })) as { items: { role: string; excerpt: string }[]; total: number };
      return this.paginate(
        `找到 ${result.total} 条（展示最新 ${result.items.length} 条；/export 获取完整导出范围）\n\n${result.items.map((i) => `[${i.role}] ${i.excerpt}`).join("\n\n")}`,
        job.id,
      );
    }
    if (command === "control") {
      const [action, id] = args.split(/\s+/),
        job = this.job(id);
      if (!["pause", "resume", "cancel"].includes(action))
        throw Error("Invalid control");
      return {
        text: `确认 ${action}: ${job.title}\n${job.id}\n当前状态: ${job.state}\n按钮 5 分钟有效，状态变化后失效。`,
        taskId: job.id,
        keyboard: [
          [
            this.action(`确认 ${action}`, job, "job.control", {
              id: job.id,
              action,
            }),
            button("返回", `/task ${job.id}`),
          ],
        ],
      };
    }
    if (command === "confirm") {
      const action = this.actions.get(args);
      if (!action || action.expires <= this.now())
        throw Error("操作按钮已过期，请重新打开任务或队列");
      const job = this.job(action.jobId);
      if (action.signature !== this.signature(job))
        throw Error("任务或队列已变化，请刷新后操作");
      // Consume before execution: an uncertain response must never replay a control.
      this.actions.delete(args);
      await this.runtime.command(action.command, action.args);
      return this.card(job);
    }
    if (command === "queue") {
      const job = this.job(args || context.task),
        queue = job.queuedMessages || [],
        revision = job.queueRevision || 0;
      const lines = queue
        .slice(0, 5)
        .map(
          (m, i) =>
            `${i + 1}. ${m.id || "legacy"}\n${m.text.slice(0, 350)}${m.text.length > 350 ? "…" : ""}`,
        );
      const keyboard = queue
        .slice(0, 5)
        .filter((m) => m.id)
        .map((m, i) => [
          this.action(`↑ ${i + 1}`, job, "chat.queue", {
            id: job.id,
            messageId: m.id,
            revision,
            action: "up",
          }),
          this.action(`↓ ${i + 1}`, job, "chat.queue", {
            id: job.id,
            messageId: m.id,
            revision,
            action: "down",
          }),
          this.action(`删除 ${i + 1}`, job, "chat.queue", {
            id: job.id,
            messageId: m.id,
            revision,
            action: "remove",
          }),
        ]);
      return {
        text: `队列 ${job.id}\n版本 ${revision} · ${queue.length} 条（按钮展示前 5 条）\n\n${lines.join("\n\n") || "空"}\n\n/queueall 查看全部文字；/edit 消息ID ${revision} 新文字（先 /task 选中此任务）`,
        taskId: job.id,
        keyboard: [
          ...keyboard,
          [
            button("完整队列", `/queueall ${job.id}`),
            button("刷新", `/queue ${job.id}`),
            button("任务", `/task ${job.id}`),
          ],
        ],
      };
    }
    if (command === "queueall") {
      const job = this.job(args || context.task);
      return this.paginate(
        `队列 ${job.id}\n版本 ${job.queueRevision || 0}\n\n` +
          (job.queuedMessages || [])
            .map((m, i) => `${i + 1}. ${m.id}\n${m.text}`)
            .join("\n\n"),
        job.id,
      );
    }
    if (["edit", "remove", "up", "down"].includes(command)) {
      const job = this.job(context.task),
        match = args.match(/^(\S+)\s+(\d+)(?:\s+([\s\S]+))?$/);
      if (!match || match[1].length < 8)
        throw Error(
          `Use /${command} MESSAGE_ID REVISION${command === "edit" ? " text" : ""}; /queue shows both`,
        );
      const items = (job.queuedMessages || []).filter((m) =>
        m.id?.startsWith(match[1]),
      );
      if (items.length !== 1) throw Error("Message ID is missing or ambiguous");
      await this.runtime.command("chat.queue", {
        id: job.id,
        messageId: items[0].id,
        revision: Number(match[2]),
        action: command,
        ...(command === "edit" ? { text: match[3] } : {}),
      });
      return `队列已更新 ${job.id}。/queue 刷新。`;
    }
    if (["priority", "rename", "pin", "archive", "depends"].includes(command)) {
      const job = this.job(context.task);
      if (command === "priority")
        await this.runtime.command("chat.priority", {
          id: job.id,
          priority: args,
        });
      else if (command === "depends")
        await this.runtime.command("job.dependencies", {
          id: job.id,
          ids:
            args === "none"
              ? []
              : args.split(/\s+/).map((id) => this.job(id).id),
        });
      else {
        if (command !== "rename" && !["on", "off"].includes(args))
          throw Error(`Use /${command} on|off`);
        await this.runtime.command("job.metadata", {
          id: job.id,
          ...(command === "rename"
            ? { title: args }
            : command === "pin"
              ? { pinned: args === "on" }
              : { archived: args === "on" }),
        });
      }
      return this.card(job);
    }
    if (
      ["defaults", "model", "effort", "plan", "template", "templates"].includes(
        command,
      )
    ) {
      let next = { ...defaults, ...context.defaults };
      if (
        command === "templates" ||
        (command === "template" && args !== "off")
      ) {
        const state = (await this.runtime.command(
          "templates.list",
        )) as TemplateState;
        if (command === "templates")
          return this.paginate(
            state.items
              .map(
                (t) =>
                  `${t.name}\n/template ${t.id}\n${t.prompt.slice(0, 200)}`,
              )
              .join("\n\n") ||
              "暂无模板，可先在网页保存模板。/template off 清除模板。",
          );
        const matches = state.items.filter(
          (t) => args.length >= 8 && t.id.startsWith(args),
        );
        if (matches.length !== 1)
          throw Error("Template ID is missing or ambiguous");
        const t = matches[0];
        next = {
          model: t.model,
          effort: t.effort,
          planMode: t.planMode,
          multiAgent: t.multiAgent,
          prompt: t.prompt,
        };
      } else if (command === "template") next = { ...defaults };
      else if (command === "model") {
        if (!args || args.length > 200) throw Error("Use /model NAME|default");
        next.model = args === "default" ? "" : args;
      } else if (command === "effort") {
        if (
          !["default", "minimal", "low", "medium", "high", "xhigh"].includes(
            args,
          )
        )
          throw Error("Invalid reasoning effort");
        next.effort = args === "default" ? "" : args;
      } else if (command === "plan") {
        if (!["on", "off"].includes(args)) throw Error("Use /plan on|off");
        next.planMode = args === "on";
      }
      if (command !== "defaults")
        await this.save({ ...context, defaults: next });
      return `新任务默认值（不改已有任务）\n模型: ${next.model || "default"}\n推理: ${next.effort || "default"}\n计划模式: ${next.planMode ? "on" : "off"}\n多代理: ${next.multiAgent ? "on" : "off"}\n模板前缀: ${next.prompt?.slice(0, 1000) || "无"}`;
    }
    if (command === "dispatch") {
      const [action, scope = "project"] = args.split(/\s+/);
      if (
        !["pause", "resume"].includes(action) ||
        !["project", "all"].includes(scope)
      )
        throw Error("Use /dispatch pause|resume [project|all]");
      const cwd =
        scope === "project"
          ? await resolveWorkspace(this.roots, context.project || "")
          : undefined;
      await this.runtime.command("scheduler.dispatch", {
        paused: action === "pause",
        ...(cwd ? { cwd } : {}),
      });
      return `调度 ${action}: ${cwd || "所有项目"}。已有运行任务继续执行。`;
    }
    if (command === "limit") {
      const cwd = await resolveWorkspace(this.roots, context.project || "");
      await this.runtime.command("scheduler.projectLimit", {
        cwd,
        limit: args === "auto" ? null : Number(args),
      });
      return `项目并发上限: ${args}\n${cwd}`;
    }
    if (command === "health" || command === "accounts") {
      const data = await this.runtime.command(
        command === "health" ? "health" : "account.list",
      );
      // Account summaries only; never expose imported auth material.
      return this.paginate(JSON.stringify(data, null, 2));
    }
    return undefined;
  }
}
