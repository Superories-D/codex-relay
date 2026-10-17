import {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  powerMonitor,
  Tray,
  Menu,
  nativeImage,
  powerSaveBlocker,
  Notification,
  nativeTheme,
  clipboard,
} from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../core/store";
import { checkEnvironment } from "../core/diagnostics";
import { windowsPowerShellEnv, protectDataDirectory } from "../core/powershell";
import { AccountImport } from "../core/account-import";
import {
  ExistingSessions,
  WindowsExistingDriver,
} from "../core/existing-sessions";
import os from "node:os";
import { Accounts } from "../core/accounts";
import { Scheduler } from "../core/scheduler";
import { CliWorker } from "../core/cli-worker";
import { DesktopWorker } from "../core/desktop-worker";
import { recoverJob } from "../core/recovery";
import { redact } from "../core/redact";
import { startCommandServer } from "./ipc-server";
import { loadRenderer } from "./load-renderer";
import {
  newJobSchema,
  goalObjectiveSchema,
  settingsSchema,
  idSchema,
  controlSchema,
  loginSchema,
  accountSchema,
  sessionScanSchema,
  sessionAttachSchema,
} from "./validation";
import { z } from "zod";
import { History } from "../core/history";
import { rolloutRecords } from "../core/chat";
import { findTranscript } from "../core/transcript";
import { chatSendSchema } from "./validation";
import { Desktop, nextSchedule } from "../core/desktop";
import { Terminals } from "../core/terminals";
import { randomUUID } from "node:crypto";
import { normalizeLocalPath } from "../shared/file-reference";
import { Rpc } from "../core/rpc";
import { capabilities } from "../shared/capabilities";
import { resolveLanguage, translate } from "../shared/locale";
import { BackgroundHistoryImport } from "../core/history-import";
import { Attachments, clipboardFilePaths } from "../core/attachments";
import { exportNativeThread } from "../core/native-history";
import { importRunning } from "../shared/history-import";
app.setName("Codex Relay");
const startupTrace = (stage: string) => {
  if (process.env.CODEX_RELAY_STARTUP_TRACE === "1")
    console.info(`[startup] ${stage}`);
};
startupTrace("resolve data directory");
const customDataRoot = process.env.CODEX_RELAY_DATA_DIR;
if (customDataRoot && !path.isAbsolute(customDataRoot))
  throw new Error("CODEX_RELAY_DATA_DIR 必须为绝对路径");
const dataRoot =
  customDataRoot || path.join(app.getPath("appData"), "Codex Relay");
app.setPath("userData", dataRoot);
startupTrace("single instance lock");
if (!app.requestSingleInstanceLock()) app.quit();
else
  void boot().catch((error) => {
    console.error("Codex Relay startup failed:", redact(error));
    dialog.showErrorBox("Codex Relay 无法启动", redact(error));
    app.exit(1);
  });
let window: BrowserWindow | undefined;
let quitting = false;
let tray: Tray | undefined;
async function boot() {
  startupTrace("wait for Electron");
  await app.whenReady();
  startupTrace("protect data directory");
  const scripts = app.isPackaged
    ? path.join(process.resourcesPath, "windows")
    : path.join(app.getAppPath(), "scripts", "windows");
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  startupTrace("data directory created");
  const realDataRoot = await fs.realpath(dataRoot);
  startupTrace("data directory resolved");
  if (process.platform === "win32")
    await protectDataDirectory(
      path.join(scripts, "protect-directory.ps1"),
      realDataRoot,
    );
  startupTrace("initialize system credential encryption");
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === "linux" &&
      safeStorage.getSelectedStorageBackend() === "basic_text")
  )
    throw new Error("系统安全凭据存储不可用；不会降级为明文账户库。");
  const store = new Store(dataRoot);
  startupTrace("load application state");
  await store.load();
  const desktop = new Desktop(dataRoot);
  await desktop.load();
  const nativeText = (source: string) =>
    translate(
      source,
      resolveLanguage(
        desktop.data.preferences.language || "auto",
        app.getLocale(),
      ),
    );
  const applyDesktopPreferences = () => {
    if (nativeTheme.themeSource !== desktop.data.preferences.theme)
      nativeTheme.themeSource = desktop.data.preferences.theme;
    if (window && !window.isDestroyed())
      window.setTitleBarOverlay({
        color: nativeTheme.shouldUseDarkColors ? "#1f2020" : "#f2f3f2",
        symbolColor: nativeTheme.shouldUseDarkColors ? "#b5b5b5" : "#555555",
        height: 38,
      });
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: nativeText("打开 Codex Relay"), click: () => window?.show() },
        {
          label: nativeText("暂停受管任务 / 监控并退出"),
          click: () => app.quit(),
        },
      ]),
    );
  };
  nativeTheme.themeSource = desktop.data.preferences.theme;
  nativeTheme.on("updated", applyDesktopPreferences);
  const terminals = new Terminals(dataRoot, () => store.data.settings.cliPath);
  const notifiedStates = new Map(store.data.jobs.map((j) => [j.id, j.state]));
  let scheduler: Scheduler;
  const accounts = new Accounts(
    store,
    {
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
    () => scheduler?.changed(),
  );
  await accounts.migrateIdentities();
  const importer = new AccountImport(accounts, store);
  scheduler = new Scheduler(
    store,
    accounts,
    {
      cli: (ctx) => new CliWorker(ctx),
      desktop: (ctx) => new DesktopWorker(ctx, store, accounts, scripts),
    },
    (job) => recoverJob(job, store, accounts, scripts),
    (job) => existing.assertManagedSafe(job),
  );
  const existing = new ExistingSessions(
    store,
    scheduler,
    new WindowsExistingDriver(path.join(dataRoot, "session-requests"), scripts),
  );
  const history = new History(store, scheduler.chats);
  const attachments = new Attachments(store.root);
  const backgroundHistory = new BackgroundHistoryImport(
    store,
    desktop,
    path.join(__dirname, "history-import-worker.cjs"),
    () => scheduler.changed(),
  );
  await backgroundHistory.load();
  const dirtyChats = new Set<string>();
  const watchedChats = new Set<string>();
  let chatPushTimer: ReturnType<typeof setTimeout> | undefined;
  scheduler.on("chatChanged", (id: string) => {
    if (!watchedChats.has(id)) return;
    dirtyChats.add(id);
    if (chatPushTimer) return;
    chatPushTimer = setTimeout(() => {
      chatPushTimer = undefined;
      const ids = [...dirtyChats];
      dirtyChats.clear();
      if (!window || window.isDestroyed() || !window.isVisible()) return;
      for (const id of ids)
        void scheduler.chats
          .read(id)
          .then((page) => {
            if (window && !window.isDestroyed())
              window.webContents.send("relay:chat", { id, page });
          })
          .catch((error) => scheduler.log(error, "error"));
    }, 50);
  });
  for (const j of store.data.jobs)
    if (j.recoveryRequired && j.accountId && j.mode === "desktop")
      accounts.busy.add(j.accountId);
  let sleepBlocker: number | undefined;
  scheduler.on("snapshot", (snapshot) => {
    if (window && !window.isDestroyed())
      window.webContents.send("relay:snapshot", snapshot);
    for (const job of store.data.jobs) {
      const previous = notifiedStates.get(job.id);
      if (
        desktop.data.preferences.notifications &&
        previous &&
        previous !== job.state &&
        ["completed", "needs_attention"].includes(job.state) &&
        !window?.isFocused() &&
        Notification.isSupported()
      ) {
        const notice = new Notification({
          title:
            job.state === "completed"
              ? nativeText("Codex 已完成本轮任务")
              : nativeText("Codex 需要你的处理"),
          body: job.title,
        });
        notice.on("click", () => {
          window?.show();
          window?.focus();
        });
        notice.show();
      }
      notifiedStates.set(job.id, job.state);
    }
    const running = store.data.jobs.some((j) =>
      ["preparing", "running", "pausing", "rotating", "watching"].includes(
        j.state,
      ),
    );
    if (running && sleepBlocker === undefined)
      sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
    if (!running && sleepBlocker !== undefined) {
      powerSaveBlocker.stop(sleepBlocker);
      sleepBlocker = undefined;
    }
  });
  let catalogQueue: Promise<unknown> = Promise.resolve();
  const command = async (name: string, args?: unknown): Promise<unknown> => {
    if (quitting) throw new Error("正在保存并退出");
    switch (name) {
      case "clipboard.writeText":
        await clipboard.writeText(
          z
            .string()
            .max(8 * 1024 * 1024)
            .parse(args),
        );
        return;
      case "chat.watch": {
        const a = z
          .object({
            id: idSchema.optional(),
            threadId: idSchema.optional(),
            remove: z.boolean().optional(),
          })
          .strict()
          .parse(args);
        const job = store.data.jobs.find((j) => j.id === a.id);
        if (a.threadId) {
          if (!job?.agents?.some((agent) => agent.threadId === a.threadId))
            throw new Error("子代理不属于当前会话");
          if (a.remove) watchedChats.delete(a.threadId);
          else watchedChats.add(a.threadId);
        } else {
          for (const id of watchedChats)
            if (
              !job ||
              (id !== job.id &&
                !job.agents?.some((agent) => agent.threadId === id))
            )
              watchedChats.delete(id);
          if (job) watchedChats.add(job.id);
        }
        return;
      }
      case "catalog.operation": {
        const a = z
          .object({
            method: z.string().max(100),
            params: z.record(z.string(), z.unknown()).default({}),
          })
          .strict()
          .parse(args);
        if (
          !capabilities.some((c) => c.method === a.method) ||
          /^(thread\/|command\/|gitDiff)/.test(a.method)
        )
          throw new Error("此操作需要打开会话");
        const task = catalogQueue
          .catch(() => {})
          .then(async () => {
            if (quitting) throw new Error("正在退出");
            const account = store.data.accounts.find(
              (a) =>
                a.enabled && a.status === "ready" && !accounts.busy.has(a.id),
            );
            if (!account) throw new Error("请先添加一个已登录且可用的账户");
            const prepared = await accounts.inspect(account.id);
            const rpc = await Rpc.open(
              store.data.settings.cliPath,
              path.join(dataRoot, "cli-profile"),
            );
            try {
              rpc.on("request", (m) =>
                rpc.reject(m.id, "请在聊天中完成交互请求"),
              );
              await rpc.call("account/login/start", {
                type: "chatgptAuthTokens",
                accessToken: prepared.auth.tokens.access_token,
                chatgptAccountId: account.identity,
                chatgptPlanType: account.plan,
              });
              return JSON.parse(
                redact(JSON.stringify(await rpc.call(a.method, a.params))),
              );
            } finally {
              await rpc.close();
            }
          });
        catalogQueue = task;
        return task;
      }
      case "window.menu": {
        const a = z
          .object({ menu: z.enum(["file", "edit", "view"]).optional() })
          .strict()
          .parse(args || {});
        const menus: Electron.MenuItemConstructorOptions[] = [
          {
            label: nativeText("文件"),
            submenu: [
              { role: "close", label: nativeText("关闭窗口") },
              { role: "quit", label: nativeText("退出") },
            ],
          },
          {
            label: nativeText("编辑"),
            submenu: [
              { role: "undo", label: nativeText("撤销") },
              { role: "redo", label: nativeText("重做") },
              { type: "separator" },
              { role: "cut", label: nativeText("剪切") },
              { role: "copy", label: nativeText("复制") },
              { role: "paste", label: nativeText("粘贴") },
              { role: "selectAll", label: nativeText("全选") },
            ],
          },
          {
            label: nativeText("视图"),
            submenu: [
              { role: "resetZoom", label: nativeText("实际大小") },
              { role: "zoomIn", label: nativeText("放大") },
              { role: "zoomOut", label: nativeText("缩小") },
              { role: "togglefullscreen", label: nativeText("切换全屏") },
            ],
          },
        ];
        const selected = a.menu
          ? menus[{ file: 0, edit: 1, view: 2 }[a.menu]].submenu
          : menus;
        const menu = Menu.buildFromTemplate(
          selected as Electron.MenuItemConstructorOptions[],
        );
        menu.popup({ window });
        return;
      }
      case "desktop.read":
        return desktop.data;
      case "desktop.preferences": {
        Object.assign(
          desktop.data.preferences,
          z
            .object({
              theme: z.enum(["dark", "light", "system"]).optional(),
              language: z.enum(["auto", "zh-CN", "zh-TW", "en"]).optional(),
              notifications: z.boolean().optional(),
              textSize: z.number().int().min(12).max(20).optional(),
              codeSize: z.number().int().min(10).max(20).optional(),
              accent: z
                .string()
                .regex(/^#[a-f0-9]{6}$/i)
                .optional(),
              background: z
                .string()
                .regex(/^#[a-f0-9]{6}$/i)
                .optional(),
              foreground: z
                .string()
                .regex(/^#[a-f0-9]{6}$/i)
                .optional(),
              uiFont: z.string().max(200).optional(),
              codeFont: z.string().max(200).optional(),
              enterSends: z.boolean().optional(),
              followUp: z.enum(["queue", "steer"]).optional(),
              reduceMotion: z.boolean().optional(),
            })
            .strict()
            .parse(args),
        );
        await desktop.save();
        applyDesktopPreferences();
        return desktop.data;
      }
      case "project.add":
        return desktop.project(z.string().refine(path.isAbsolute).parse(args));
      case "client.instructions.read":
        return fs
          .readFile(path.join(dataRoot, "cli-profile", "AGENTS.md"), "utf8")
          .catch((e) => {
            if (e.code === "ENOENT") return "";
            throw e;
          });
      case "client.instructions.write": {
        const text = z.string().max(100000).parse(args);
        await fs.mkdir(path.join(dataRoot, "cli-profile"), { recursive: true });
        await fs.writeFile(
          path.join(dataRoot, "cli-profile", "AGENTS.md"),
          text,
          { mode: 0o600 },
        );
        return;
      }
      case "project.update": {
        const a = z
          .object({
            id: idSchema,
            name: z.string().trim().min(1).max(100).optional(),
            pinned: z.boolean().optional(),
            remove: z.boolean().optional(),
          })
          .strict()
          .parse(args);
        const project = desktop.data.projects.find((p) => p.id === a.id);
        if (!project) throw new Error("项目不存在");
        if (a.remove)
          desktop.data.projects = desktop.data.projects.filter(
            (p) => p !== project,
          );
        else
          Object.assign(project, {
            ...(a.name ? { name: a.name } : {}),
            ...(a.pinned !== undefined ? { pinned: a.pinned } : {}),
          });
        await desktop.save();
        return desktop.data;
      }
      case "workspace.files":
      case "workspace.read":
      case "workspace.open":
      case "workspace.diff":
      case "workspace.write": {
        const a = z
          .object({
            cwd: z.string().refine(path.isAbsolute),
            path: z.string().max(32700).default("."),
            staged: z.boolean().optional(),
            text: z
              .string()
              .max(2 * 1024 * 1024)
              .optional(),
            mtime: z.number().optional(),
          })
          .strict()
          .parse(args);
        if (name === "workspace.files") return desktop.files(a.cwd, a.path);
        if (name === "workspace.read") return desktop.read(a.cwd, a.path);
        if (name === "workspace.diff")
          return desktop.diff(a.cwd, a.path, a.staged);
        if (name === "workspace.write") {
          if (a.text === undefined || a.mtime === undefined)
            throw new Error("缺少文件内容或版本");
          return desktop.write(a.cwd, a.path, a.text, a.mtime);
        }
        return shell.openPath(await desktop.resolve(a.cwd, a.path));
      }
      case "workspace.changes":
      case "workspace.branches":
      case "workspace.worktree":
      case "workspace.git": {
        const a = z
          .object({
            cwd: z.string().refine(path.isAbsolute),
            ref: z.string().max(200).optional(),
            action: z
              .enum(["stage", "unstage", "restore", "commit", "push"])
              .optional(),
            path: z.string().max(32700).optional(),
            message: z.string().max(10000).optional(),
          })
          .strict()
          .parse(args);
        if (name === "workspace.changes") return desktop.changes(a.cwd);
        if (name === "workspace.branches") return desktop.branches(a.cwd);
        if (name === "workspace.worktree")
          return desktop.worktree(a.cwd, a.ref);
        if (!a.action) throw new Error("缺少 Git 操作");
        return desktop.gitAction(a.cwd, a.action, a.path, a.message);
      }
      case "terminal.list":
        return terminals.list();
      case "terminal.open": {
        const a = z
          .object({
            cwd: z.string().refine(path.isAbsolute),
            cols: z.number().int().min(10).max(500).default(100),
            rows: z.number().int().min(2).max(200).default(24),
          })
          .strict()
          .parse(args);
        return terminals.open(a.cwd, a.cols, a.rows);
      }
      case "terminal.read":
      case "terminal.write":
      case "terminal.resize":
      case "terminal.close": {
        const a = z
          .object({
            id: idSchema,
            cursor: z.number().int().min(0).optional(),
            text: z.string().max(100000).optional(),
            cols: z.number().int().min(10).max(500).optional(),
            rows: z.number().int().min(2).max(200).optional(),
          })
          .strict()
          .parse(args);
        if (name === "terminal.read") return terminals.read(a.id, a.cursor);
        if (name === "terminal.close") return terminals.close(a.id);
        if (name === "terminal.write")
          return terminals.write(a.id, a.text ?? "");
        return terminals.resize(a.id, a.cols ?? 100, a.rows ?? 24);
      }
      case "schedule.save": {
        const a = z
          .object({
            id: idSchema.optional(),
            title: z.string().trim().min(1).max(120),
            prompt: z.string().trim().min(1).max(100000),
            cwd: z.string().refine(path.isAbsolute),
            enabled: z.boolean(),
            cadence: z.enum(["interval", "daily", "weekly"]),
            minutes: z.number().int().min(5).max(525600),
            hour: z.number().int().min(0).max(23),
            minute: z.number().int().min(0).max(59),
            weekday: z.number().int().min(0).max(6),
            worktree: z.boolean(),
          })
          .strict()
          .parse(args);
        const previous = desktop.data.schedules.find((t) => t.id === a.id);
        const task = {
          ...previous,
          ...a,
          id: a.id || randomUUID(),
          nextRun: nextSchedule(a),
        };
        if (previous) Object.assign(previous, task);
        else desktop.data.schedules.push(task);
        await desktop.save();
        return desktop.data;
      }
      case "schedule.remove": {
        const id = idSchema.parse(args);
        desktop.data.schedules = desktop.data.schedules.filter(
          (t) => t.id !== id,
        );
        await desktop.save();
        return desktop.data;
      }
      case "schedule.run": {
        const id = idSchema.parse(args),
          task = desktop.data.schedules.find((t) => t.id === id);
        if (!task) throw new Error("定时任务不存在");
        return runScheduled(task);
      }
      case "chat.questions.read": {
        const a = z
          .object({ id: idSchema, before: z.number().int().min(0).optional() })
          .strict()
          .parse(args);
        if (!store.data.jobs.some((job) => job.id === a.id))
          throw Error("会话不存在");
        const result = await scheduler.chats.questions(a.id, a.before);
        const live = new Set(
          scheduler.approvals
            .filter((p) => p.jobId === a.id && p.kind === "input")
            .map((p) => p.historyId),
        );
        return {
          ...result,
          items: result.items.map((item) =>
            item.status === "pending" && !live.has(item.id)
              ? { ...item, status: "expired" }
              : item,
          ),
        };
      }
      case "chat.goal.create": {
        const a = newJobSchema
          .extend({
            mode: z.literal("cli"),
            prompt: goalObjectiveSchema,
            tokenBudget: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER)
              .nullable(),
            start: z.boolean(),
          })
          .parse(args);
        const { tokenBudget, start, ...input } = a;
        return scheduler.createGoal(input, tokenBudget, start);
      }
      case "chat.goal.read": {
        const a = z.object({ id: idSchema }).strict().parse(args);
        return scheduler.goal(a.id, "thread/goal/get");
      }
      case "chat.goal.update": {
        const a = z
          .discriminatedUnion("action", [
            z.object({ id: idSchema, action: z.literal("pause") }).strict(),
            z.object({ id: idSchema, action: z.literal("clear") }).strict(),
            z.object({ id: idSchema, action: z.literal("start") }).strict(),
            z
              .object({
                id: idSchema,
                action: z.literal("edit"),
                objective: goalObjectiveSchema,
              })
              .strict(),
            z
              .object({
                id: idSchema,
                action: z.literal("create"),
                objective: goalObjectiveSchema,
                tokenBudget: z
                  .number()
                  .int()
                  .positive()
                  .max(Number.MAX_SAFE_INTEGER)
                  .nullable(),
                start: z.boolean(),
              })
              .strict(),
            z
              .object({
                id: idSchema,
                action: z.literal("budget"),
                tokenBudget: z
                  .number()
                  .int()
                  .positive()
                  .max(Number.MAX_SAFE_INTEGER)
                  .nullable(),
              })
              .strict(),
          ])
          .parse(args);
        if (a.action === "create")
          return scheduler.goal(
            a.id,
            "thread/goal/set",
            {
              objective: a.objective,
              tokenBudget: a.tokenBudget,
              status: a.start ? "active" : "paused",
            },
            a.start ? "createAndStart" : "create",
          );
        if (a.action === "start")
          return scheduler.goal(
            a.id,
            "thread/goal/set",
            { status: "active" },
            "start",
          );
        if (a.action === "edit")
          return scheduler.goal(
            a.id,
            "thread/goal/set",
            { objective: a.objective },
            "edit",
          );
        return scheduler.goal(
          a.id,
          a.action === "clear" ? "thread/goal/clear" : "thread/goal/set",
          a.action === "pause"
            ? { status: "paused" }
            : a.action === "budget"
              ? { tokenBudget: a.tokenBudget }
              : {},
        );
      }
      case "chat.agent.read": {
        const a = z
          .object({
            id: idSchema,
            threadId: idSchema,
            before: z.number().int().min(0).optional(),
          })
          .strict()
          .parse(args);
        const job = store.data.jobs.find((j) => j.id === a.id);
        if (!job?.agents?.some((agent) => agent.threadId === a.threadId))
          throw new Error("该子代理不属于当前会话");
        const page = await scheduler.chats.read(a.threadId, a.before);
        if (!page.total) {
          const file = await findTranscript(
            store.jobHome(job.id),
            a.threadId,
            true,
          ).catch(() => undefined);
          if (file) {
            for await (const item of rolloutRecords(file))
              await scheduler.chats.append(a.threadId, item);
            return scheduler.chats.read(a.threadId, a.before);
          }
        }
        return page;
      }
      case "chat.agent.control": {
        const a = z
          .object({
            id: idSchema,
            threadId: idSchema,
            action: z.enum(["send", "interrupt"]),
            text: z.string().max(100000).optional(),
          })
          .strict()
          .parse(args);
        return scheduler.agentControl(a.id, a.threadId, a.action, a.text);
      }
      case "chat.agent.open": {
        const a = z
          .object({ id: idSchema, threadId: idSchema })
          .strict()
          .parse(args);
        return scheduler.openAgent(a.id, a.threadId);
      }
      case "chat.export": {
        const id = idSchema.parse(args),
          job = store.data.jobs.find((j) => j.id === id);
        if (!job) throw new Error("会话不存在");
        const result = await dialog.showSaveDialog(window!, {
          defaultPath: `${job.title.replace(/[<>:"/\\|?*]/g, "-")}.md`,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (result.canceled || !result.filePath) return;
        const items = [];
        let before: number | undefined;
        do {
          const page = await scheduler.chats.read(id, before);
          items.unshift(...page.items);
          before = page.before;
        } while (before !== undefined);
        await fs.writeFile(
          result.filePath,
          `# ${job.title}\n\n` +
            items
              .map(
                (i) =>
                  `## ${i.role === "user" ? "你" : i.role === "assistant" ? "Codex" : i.kind}\n\n${i.text}\n\n${i.detail ? "```\n" + i.detail + "\n```\n" : ""}`,
              )
              .join("\n"),
        );
        return result.filePath;
      }
      case "chat.source.open": {
        const a = z.object({ id: idSchema }).strict().parse(args);
        const job = store.data.jobs.find((job) => job.id === a.id);
        if (!job?.threadId) throw Error("会话尚无原始记录");
        const file =
          job.historySource?.storage === "sqlite"
            ? await exportNativeThread(store.jobHome(job.id), job.threadId)
            : await findTranscript(store.jobHome(job.id), job.threadId, true);
        const error = await shell.openPath(file);
        if (error) throw Error(error);
        return;
      }
      case "history.importAll.status":
        return backgroundHistory.progress;
      case "history.importAll.start": {
        const a = z
          .object({
            homes: z
              .array(z.string().refine(path.isAbsolute))
              .max(20)
              .optional(),
          })
          .strict()
          .parse(args || {});
        return backgroundHistory.start(a.homes);
      }
      case "history.importAll.cancel":
        return backgroundHistory.cancel();
      case "history.scan": {
        if (importRunning(backgroundHistory.progress.phase))
          throw Error(nativeText("正在后台导入，请稍后再进行手动导入"));
        const a = z
          .object({
            homes: z
              .array(z.string().refine(path.isAbsolute))
              .max(20)
              .optional(),
          })
          .strict()
          .parse(args ?? {});
        return history.scan(a.homes);
      }
      case "history.import": {
        if (importRunning(backgroundHistory.progress.phase))
          throw Error(nativeText("正在后台导入，请稍后再进行手动导入"));
        const a = z
          .object({
            ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
          })
          .strict()
          .parse(args ?? {});
        const result = await history.import(a.ids);
        scheduler.changed();
        return result;
      }
      case "chat.read": {
        const a = z
          .object({ id: idSchema, before: z.number().int().min(0).optional() })
          .strict()
          .parse(args);
        const job = store.data.jobs.find((j) => j.id === a.id);
        if (!job) throw new Error("会话不存在");
        try {
          await fs.access(scheduler.chats.file(job.id));
        } catch {
          if (job.threadId) {
            const file = await findTranscript(
              store.jobHome(job.id),
              job.threadId,
              true,
            );
            for await (const item of rolloutRecords(file))
              await scheduler.chats.append(job.id, item);
          } else if (job.prompt) await scheduler.chats.user(job.id, job.prompt);
        }
        return scheduler.chats.read(a.id, a.before);
      }
      case "chat.send":
        return scheduler.send(chatSendSchema.parse(args));
      case "chat.model": {
        const a = z
          .object({
            id: idSchema,
            model: z.string().max(160),
            effort: z.string().max(32),
          })
          .strict()
          .parse(args);
        return scheduler.model(a.id, a.model, a.effort);
      }
      case "chat.assets.list": {
        const a = z.object({ id: idSchema }).strict().parse(args);
        if (!store.data.jobs.some((job) => job.id === a.id))
          throw Error("会话不存在");
        return scheduler.chats.assets(a.id);
      }
      case "chat.asset.read":
      case "chat.asset.open": {
        const a = z
          .object({
            id: idSchema.optional(),
            threadId: idSchema.optional(),
            path: z.string().max(32700),
            thumbnail: z.boolean().optional(),
            cwd: z.string().optional(),
          })
          .strict()
          .parse(args);
        const job = a.id
          ? store.data.jobs.find((job) => job.id === a.id)
          : undefined;
        if (a.id && !job) throw Error("会话不存在");
        if (
          a.threadId &&
          !job?.agents?.some((agent) => agent.threadId === a.threadId)
        )
          throw Error("该子代理不属于当前会话");
        const target = path.resolve(
          job?.cwd || a.cwd || dataRoot,
          normalizeLocalPath(a.path),
        );
        let file: string | undefined;
        for (const root of [
          path.join(dataRoot, "attachments"),
          path.join(dataRoot, "media"),
        ]) {
          try {
            file = await desktop.resolve(root, target);
            break;
          } catch {}
        }
        if (!file && job) {
          const references = [
            ...(job.attachments || []).map((attachment) => attachment.path),
            ...(await scheduler.chats.references(a.threadId || job.id)),
          ];
          if (
            references.some(
              (reference) =>
                path
                  .resolve(job.cwd, normalizeLocalPath(reference))
                  .toLowerCase() === target.toLowerCase(),
            )
          )
            file = await fs.realpath(target);
        }
        if (!file && (job?.cwd || a.cwd))
          file = await desktop.resolve(job?.cwd || a.cwd!, target);
        if (!file) throw Error("附件未授权或已不存在");
        if (name === "chat.asset.open") return shell.openPath(file);
        const value = await desktop.read(
          path.dirname(file),
          path.basename(file),
        );
        if (a.thumbnail && value.kind === "image") {
          const image = nativeImage.createFromDataURL(value.content);
          if (!image.isEmpty()) {
            const size = image.getSize();
            value.content = image
              .resize({
                ...(size.width >= size.height
                  ? { width: Math.min(size.width, 192) }
                  : { height: Math.min(size.height, 192) }),
                quality: "good",
              })
              .toDataURL();
          }
        }
        let projectFile = false;
        if (job?.cwd || a.cwd) {
          try {
            await desktop.resolve(job?.cwd || a.cwd!, file);
            projectFile = true;
          } catch {}
        }
        return { ...value, readOnly: !projectFile };
      }
      case "chat.update": {
        const a = z
          .object({
            id: idSchema,
            title: z.string().trim().min(1).max(120).optional(),
            archived: z.boolean().optional(),
            pinned: z.boolean().optional(),
            cwd: z.string().refine(path.isAbsolute).optional(),
            sandbox: z
              .enum(["workspaceWrite", "readOnly", "dangerFullAccess"])
              .optional(),
            approvalPolicy: z.enum(["on-request", "never"]).optional(),
          })
          .strict()
          .parse(args);
        const job = store.data.jobs.find((j) => j.id === a.id);
        if (!job) throw new Error("会话不存在");
        if (
          !["completed", "cancelled", "paused", "needs_attention"].includes(
            job.state,
          )
        )
          throw new Error("请先暂停当前会话");
        if (a.cwd && !(await fs.stat(a.cwd)).isDirectory())
          throw new Error("项目目录无效");
        Object.assign(job, a);
        if (a.sandbox !== undefined || a.approvalPolicy !== undefined)
          job.preserveNativePermissions = false;
        await store.save();
        scheduler.changed();
        return;
      }
      case "chat.fork": {
        return scheduler.fork(idSchema.parse(args));
      }
      case "chat.turns": {
        const a = z
          .object({ id: idSchema, cursor: z.string().max(10000).optional() })
          .strict()
          .parse(args);
        return scheduler.turns(a.id, a.cursor);
      }
      case "chat.branchAt": {
        const a = z
          .object({
            id: idSchema,
            beforeTurnId: idSchema.optional(),
            lastTurnId: idSchema.optional(),
          })
          .strict()
          .refine((a) => !!a.beforeTurnId !== !!a.lastTurnId)
          .parse(args);
        return scheduler.fork(a.id, a);
      }
      case "agent.operation": {
        const a = z
          .object({
            id: idSchema,
            method: z.string().max(100),
            params: z.record(z.string(), z.unknown()),
          })
          .strict()
          .parse(args);
        if (JSON.stringify(a.params).length > 200000)
          throw new Error("参数过大");
        return scheduler.operation(a.id, a.method, a.params);
      }
      case "chat.attachments": {
        const r = await dialog.showOpenDialog(window!, {
          title: nativeText("添加图片或项目文件"),
          properties: ["openFile", "multiSelections"],
        });
        return r.canceled ? [] : attachments.files(r.filePaths);
      }
      case "chat.attachments.files": {
        const a = z
          .object({ paths: z.array(z.string().max(32768)).max(20) })
          .strict()
          .parse(args);
        return attachments.files(a.paths);
      }
      case "chat.attachments.upload": {
        const a = z
          .object({
            files: z
              .array(
                z
                  .object({
                    name: z.string().max(255),
                    data: z.string().max(89478488),
                  })
                  .strict(),
              )
              .max(20),
          })
          .strict()
          .parse(args);
        return attachments.upload(a.files);
      }
      case "chat.attachments.clipboard": {
        const items = await clipboard.read();
        for (const item of items) {
          if (item.types.includes("text/uri-list")) {
            const paths = clipboardFilePaths(
              await (await item.getType("text/uri-list")).text(),
            );
            if (paths.length) return attachments.files(paths);
          }
        }
        for (const item of items) {
          if (!item.types.includes("image/png")) continue;
          const image = await item.getType("image/png");
          if (image.size > 64 * 1024 * 1024)
            throw Error("附件内容无效或超过 64 MiB");
          return attachments.upload([
            {
              name: `clipboard-${Date.now()}.png`,
              data: Buffer.from(await image.arrayBuffer()).toString("base64"),
            },
          ]);
        }
        return [];
      }
      case "link.open": {
        const url = new URL(z.string().max(10000).parse(args));
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("只允许打开 HTTP(S) 链接");
        await shell.openExternal(url.toString());
        return;
      }
      case "session.scan": {
        const input = sessionScanSchema.parse(args ?? {});
        return existing.scan(input.home, input.threadId);
      }
      case "session.inspect":
        return existing.inspect(idSchema.parse(args));
      case "session.attach":
        return existing.attach(sessionAttachSchema.parse(args));
      case "session.handoff":
        return existing.control(idSchema.parse(args), "handoff");
      case "environment.check":
        return checkEnvironment(store.data.settings.cliPath);
      case "health":
        return { at: Date.now() };
      case "job.desktop.show":
        return scheduler.showDesktop(idSchema.parse(args));
      case "job.desktop.inspect":
        return scheduler.inspectDesktop(idSchema.parse(args));
      case "job.directory": {
        const job = store.data.jobs.find((j) => j.id === idSchema.parse(args));
        if (!job) throw new Error("任务不存在");
        const error = await shell.openPath(job.cwd);
        if (error) throw new Error(error);
        return;
      }
      case "desktop.detect": {
        if (process.platform !== "win32")
          throw new Error("客户端安装检测需要 Windows");
        const result = await promisify(execFile)(
          path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(scripts, "desktop-detect.ps1"),
          ],
          {
            windowsHide: true,
            timeout: 15000,
            maxBuffer: 1024 * 1024,
            env: windowsPowerShellEnv(),
          },
        );
        return JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
      }
      case "snapshot":
        return scheduler.snapshot();
      case "job.add":
        return scheduler.add(newJobSchema.parse(args));
      case "job.control": {
        const a = controlSchema.parse(args);
        const job = store.data.jobs.find((j) => j.id === a.id);
        if (job?.existing && job.existing.phase !== "managed")
          return existing.control(a.id, a.action);
        return scheduler.control(a.id, a.action);
      }
      case "account.login": {
        const a = loginSchema.parse(args);
        const login = await accounts.beginLogin(a.label, a.device);
        await openAuth(login.url);
        return login;
      }
      case "account.cancelLogin":
        return accounts.cancelLogin();
      case "account.openLogin":
        if (accounts.loginDisplay) return openAuth(accounts.loginDisplay.url);
        return;
      case "account.import":
      case "account.importLocal": {
        let file = path.join(os.homedir(), ".codex", "auth.json");
        if (name === "account.import") {
          const result = await dialog.showOpenDialog(window!, {
            title: nativeText("导入 Codex 账户备份"),
            properties: ["openFile"],
            filters: [
              { name: "auth.json / 账户备份", extensions: ["json", "jsonl"] },
            ],
          });
          if (result.canceled) return;
          file = result.filePaths[0];
        }
        if ((await fs.stat(file)).size > 2 * 1024 * 1024)
          throw new Error("凭据文件超过 2 MiB");
        return importer.preview(await fs.readFile(file, "utf8"));
      }
      case "account.importCommit": {
        const input = z
          .object({
            id: idSchema,
            indices: z.array(z.number().int().min(0).max(199)).min(1).max(200),
          })
          .strict()
          .parse(args);
        return importer.commit(input.id, input.indices);
      }
      case "account.importCancel":
        return importer.cancel(idSchema.parse(args));
      case "account.refresh": {
        const id = idSchema.parse(args);
        if (
          store.data.jobs.some(
            (j) =>
              j.accountId === id &&
              ["preparing", "running", "pausing"].includes(j.state),
          )
        )
          throw new Error("运行中账户由任务自动监控");
        return (await accounts.inspect(id)).quotas;
      }
      case "account.models":
        return (await accounts.inspect(idSchema.parse(args), true)).models;
      case "account.update": {
        const a = accountSchema.parse(args);
        const target = store.data.accounts.find((x) => x.id === a.id);
        if (!target) throw new Error("账户不存在");
        if (a.enabled !== undefined) target.enabled = a.enabled;
        if (a.label) target.label = a.label;
        if (a.expiresAt !== undefined) target.expiresAt = a.expiresAt;
        if (a.limitMode !== undefined) target.limitMode = a.limitMode;
        await store.save();
        scheduler.changed();
        return;
      }
      case "account.remove": {
        const id = idSchema.parse(args);
        if (
          store.data.jobs.some(
            (j) =>
              j.accountId === id &&
              (j.recoveryRequired ||
                ["preparing", "running", "pausing", "needs_attention"].includes(
                  j.state,
                )),
          )
        )
          throw new Error("请先暂停使用该账户的任务");
        return accounts.remove(id);
      }
      case "accounts.policy": {
        const a = z
          .object({
            accountSelection: z.enum(["smart", "roundRobin"]).optional(),
            resetWarmupEnabled: z.boolean().optional(),
          })
          .strict()
          .refine((v) => Object.values(v).some((value) => value !== undefined))
          .parse(args);
        Object.assign(store.data.settings, a);
        await store.save();
        scheduler.changed();
        scheduler.warmups.pump();
        return;
      }
      case "accounts.reorder": {
        const ids = z.array(idSchema).parse(args);
        if (
          ids.length !== store.data.accounts.length ||
          new Set(ids).size !== store.data.accounts.length ||
          ids.some((id) => !store.data.accounts.some((a) => a.id === id))
        )
          throw new Error("账户顺序无效");
        store.data.accounts = ids.map(
          (id) => store.data.accounts.find((a) => a.id === id)!,
        );
        store.data.cursor = 0;
        await store.save();
        scheduler.changed();
        return;
      }
      case "settings.save":
        if (
          store.data.jobs.some((j) =>
            ["preparing", "running", "pausing"].includes(j.state),
          )
        )
          throw new Error("暂停任务后再修改运行设置");
        store.data.settings = settingsSchema.parse(args);
        await store.save();
        scheduler.changed();
        return;
      case "choose.directory": {
        const r = await dialog.showOpenDialog(window!, {
          properties: ["openDirectory"],
        });
        return r.canceled ? null : r.filePaths[0];
      }
      case "choose.executable": {
        const r = await dialog.showOpenDialog(window!, {
          properties: ["openFile"],
          filters: [{ name: "Executable", extensions: ["exe", "cmd"] }],
        });
        return r.canceled ? null : r.filePaths[0];
      }
      case "approval.respond": {
        const r = z
          .object({
            id: z.string().max(100),
            historyId: z.string().max(100).optional(),
            value: z.unknown(),
          })
          .strict()
          .parse(args);
        const approval = scheduler.approvals.find((a) => a.id === r.id);
        if (!approval) throw new Error("请求已经结束");
        if (approval.kind === "input" && r.historyId !== approval.historyId)
          throw new Error("问题已更新，请重新查看后回答");
        if (approval.kind === "permissions") {
          const choice = z
            .object({ decision: z.enum(["accept", "decline"]) })
            .strict()
            .parse(r.value);
          const requested = (approval.params as any).permissions ?? {};
          const permissions =
            choice.decision === "accept"
              ? Object.fromEntries(
                  Object.entries(requested).filter(([, v]) => v != null),
                )
              : {};
          return scheduler.respond(r.id, { permissions, scope: "turn" });
        }
        if (approval.kind === "elicitation") {
          const value = z
            .object({
              action: z.enum(["accept", "decline", "cancel"]),
              content: z.unknown().nullable(),
              _meta: z.null(),
            })
            .strict()
            .parse(r.value);
          if (JSON.stringify(value).length > 100000)
            throw new Error("输入内容过大");
          return scheduler.respond(r.id, value);
        }
        const value =
          approval.kind === "input"
            ? z
                .object({
                  answers: z.record(
                    z.string(),
                    z.object({
                      answers: z.array(z.string().max(10000)).max(20),
                    }),
                  ),
                })
                .strict()
                .parse(r.value)
            : z
                .object({
                  decision: z.enum([
                    "accept",
                    "acceptForSession",
                    "decline",
                    "cancel",
                  ]),
                })
                .strict()
                .parse(r.value);
        return scheduler.respond(r.id, value);
      }
      case "data.open":
        await shell.openPath(dataRoot);
        return;
      case "logs.export": {
        const r = await dialog.showSaveDialog(window!, {
          defaultPath: "codex-relay-diagnostics.json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (r.canceled || !r.filePath) return;
        await fs.writeFile(
          r.filePath,
          JSON.stringify(
            {
              version: app.getVersion(),
              platform: process.platform,
              jobs: store.data.jobs.map(({ prompt, ...j }) => j),
              logs: store.data.logs,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        return;
      }
      default:
        throw new Error("未知命令");
    }
  };
  const server = await startCommandServer(dataRoot, scheduler, command);
  async function runScheduled(task: (typeof desktop.data.schedules)[number]) {
    const working =
      task.lastJobId && store.data.jobs.find((j) => j.id === task.lastJobId);
    if (
      working &&
      !["completed", "cancelled", "paused", "needs_attention"].includes(
        working.state,
      )
    )
      throw new Error("此定时任务的上一次运行尚未结束");
    const cwd = task.worktree
      ? (await desktop.worktree(task.cwd)).cwd
      : task.cwd;
    const job = await scheduler.add({
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
    });
    task.lastRun = Date.now();
    task.lastJobId = job.id;
    task.lastError = undefined;
    task.nextRun = nextSchedule(task);
    await desktop.save();
    return job;
  }
  let checkingSchedules = false;
  const scheduleTimer = setInterval(() => {
    if (checkingSchedules || quitting) return;
    checkingSchedules = true;
    void (async () => {
      for (const task of desktop.data.schedules)
        if (task.enabled && task.nextRun <= Date.now()) {
          try {
            await runScheduled(task);
          } catch (e) {
            task.lastError = redact(e);
            task.nextRun = nextSchedule(task);
            await desktop.save();
          }
        }
    })().finally(() => {
      checkingSchedules = false;
    });
  }, 15000);
  startupTrace("create window");
  const rendererPath = path.join(__dirname, "..", "renderer", "index.html");
  const available = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    width: Math.min(1280, available.width),
    height: Math.min(860, available.height),
    minWidth: Math.min(900, available.width),
    minHeight: Math.min(620, available.height),
    title: "Codex Relay",
    autoHideMenuBar: true,
    backgroundColor: "#181818",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#1f2020", symbolColor: "#b5b5b5", height: 38 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  applyDesktopPreferences();
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  ipcMain.handle("relay:command", async (event, name, args) => {
    if (
      event.sender !== window?.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Untrusted renderer");
    try {
      return await command(name, args);
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : error));
    }
  });
  await loadRenderer(window, rendererPath);
  startupTrace("renderer ready");
  window.show();
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("activate", () => window?.show());
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 4;
      const mark =
        (x >= 8 && x <= 11 && y >= 7 && y <= 25) ||
        (x >= 11 && x <= 22 && ((y >= 7 && y <= 10) || (y >= 15 && y <= 18))) ||
        (x >= 20 && x <= 23 && y >= 9 && y <= 16) ||
        (y >= 18 && y <= 25 && x >= y - 3 && x <= y);
      pixels[i] = mark ? 23 : 178;
      pixels[i + 1] = mark ? 29 : 236;
      pixels[i + 2] = mark ? 25 : 169;
      pixels[i + 3] = 255;
    }
  const icon = nativeImage.createFromBitmap(pixels, { width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip("Codex Relay");
  applyDesktopPreferences();
  tray.on("double-click", () => window?.show());
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      quitting = true;
      void existing
        .shutdown()
        .then(() =>
          Promise.all([
            importer.drain(),
            backgroundHistory.shutdown(),
            scheduler.shutdown(),
            terminals.shutdown(),
            catalogQueue.catch(() => {}),
          ]),
        )
        .then(() => {
          clearInterval(scheduleTimer);
          server.close();
          app.quit();
        })
        .catch((error) => {
          quitting = false;
          existing.start();
          dialog.showErrorBox("任务尚未安全停止", redact(error));
          window?.show();
        });
    }
  });
  powerMonitor.on("resume", () => {
    scheduler.log("系统已唤醒，重新核实额度与连接");
    for (const j of store.data.jobs)
      if (j.state === "waiting") j.nextWakeAt = Date.now();
    scheduler.changed();
  });
  scheduler.start();
  existing.start();
}
async function openAuth(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["auth.openai.com", "chatgpt.com"].includes(url.hostname)
  )
    throw new Error("登录链接不是官方 HTTPS 地址");
  await shell.openExternal(url.toString());
}
