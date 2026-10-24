import {scheduleInputSchema} from "../core/schedule-command";
import { deliverySaveSchema } from "./validation";
import {updateGoal} from "../core/goal-command";
import { conversationExport } from "../core/conversation-export";
import { NotificationState } from "../core/notification-state";
import { WindowPlacement } from "./window-placement";
import { serviceHealth } from "../core/service-health";
import { respondApproval } from "../core/approval-command";
import { WorkflowReports } from "../core/workflow-report";
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
import { taskReport } from "../core/task-report";
import { Store, atomicWrite } from "../core/store";
import { CliSetup } from "../core/cli-setup";
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
import { redact, redactValue } from "../core/redact";
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
import { Templates } from "../core/templates";
import { Desktop } from "../core/desktop";
import { Schedules } from "../core/schedules";
import { Catalog, localCatalogOperation } from "../core/catalog";
import { Terminals } from "../core/terminals";
import { randomUUID } from "node:crypto";
import { normalizeLocalPath } from "../shared/file-reference";
import { Rpc } from "../core/rpc";
import { capabilities } from "../shared/capabilities";
import { resolveLanguage, translate } from "../shared/locale";
import { BackgroundHistoryImport } from "../core/history-import";
import { Attachments, clipboardFilePaths } from "../core/attachments";
import { exportNativeThread, rebaseNativeHome } from "../core/native-history";
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
let quitReady = false;
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
  const cliSetup = new CliSetup({
    root: dataRoot,
    configured: () => store.data.settings.cliPath,
    changed: () => scheduler?.changed(),
    select: async (cli, previous) => {
      if (store.data.settings.cliPath !== previous) throw Error("CLI 路径在安装期间已更改，请重新检测");
      store.data.settings.cliPath = cli;
      try { await store.save(); } catch (error) { store.data.settings.cliPath = previous; throw error; }
    },
  });
  const desktop = new Desktop(dataRoot);
  const templates = new Templates(dataRoot);
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
  const notifications = new NotificationState(store.data.jobs);
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
  const nativeHomes = new Map<string, typeof store.data.jobs>();
  for (const job of store.data.jobs)
    if (job.historySource?.storage === "sqlite") {
      const home = store.jobHome(job.id);
      nativeHomes.set(home, [...(nativeHomes.get(home) || []), job]);
    }
  for (const [home, jobs] of nativeHomes) {
    if (
      jobs.some(
        (j) =>
          !["completed", "failed", "paused", "cancelled"].includes(j.state),
      )
    )
      continue;
    try {
      await Rpc.assertHomeIdle(home);
      const missing = await rebaseNativeHome(home);
      for (const job of jobs)
        if (missing.has(job.threadId!) && !job.historySource!.issue)
          job.historySource!.issue =
            "源会话日志已缺失；已恢复完整缓存供阅读，CLI 续接需要原始日志。";
    } catch (error) {
      for (const job of jobs)
        if (!job.historySource!.issue)
          job.historySource!.issue = `导入副本暂时不可续接：${redact(error)}`;
    }
  }
  if (nativeHomes.size) await store.save();
  const importer = new AccountImport(accounts, store);
  scheduler = new Scheduler(
    store,
    accounts,
    {
      cli: (ctx) => new CliWorker(ctx),
      desktop: (ctx) => new DesktopWorker(ctx, store, accounts, scripts),
    },
    (job) => recoverJob(job, store, accounts, scripts),
    async (job) => {
      await existing.assertManagedSafe(job);
      if (job.historySource?.storage === "sqlite") {
        const home = store.jobHome(job.id);
        await Rpc.assertHomeIdle(home);
        await rebaseNativeHome(home);
      }
    },
  );
  const workflowReports = new WorkflowReports(scheduler.chats, () => store.data.jobs);
  scheduler.runtimeReady = () => cliSetup.state.phase === "ready";
  const schedules = new Schedules(desktop, scheduler, () =>
    scheduler.changed(),
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
    const notices = notifications.update(snapshot.jobs,snapshot.approvals);
    if (desktop.data.preferences.notifications && !window?.isFocused() && Notification.isSupported()) {
      for (const event of notices) {
        const job = store.data.jobs.find(j=>j.id===event.id);
        if (!job) continue;
        const notice = new Notification({title:nativeText(event.kind === "completed" ? "Codex 已完成本轮任务" : "Codex 需要你的处理"),body:desktop.data.preferences.privateNotifications ? "Codex Relay" : job.title});
        notice.on("click",()=>{window?.show();window?.focus();window?.webContents.send("relay:open-job",job.id);});
        notice.show();
      }
    }
    const running = desktop.data.preferences.preventSleep !== false && store.data.jobs.some((j) =>
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
  const catalog = new Catalog(
    path.join(dataRoot, "cli-profile"),
    () => store.data.settings.cliPath,
    (update) => {
      if (window && !window.isDestroyed())
        window.webContents.send("relay:catalog-login", update);
    },
  );
  const command = async (name: string, args?: unknown): Promise<unknown> => {
    if (quitting) throw new Error("正在保存并退出");
    if (cliSetup.state.phase !== "ready" && [
      "account.login", "account.refresh", "account.models", "catalog.operation",
      "terminal.open", "chat.goal.create", "chat.goal.read", "chat.goal.update",
      "chat.fork", "chat.branchAt", "chat.agent.open",
    ].includes(name)) throw Error("Codex CLI 正在准备，请稍后重试");
    switch (name) {
      case "cli.status":
        return structuredClone(cliSetup.state);
      case "cli.ensure":
        return cliSetup.ensure();
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
          /^(thread\/|command\/|gitDiff|mcpServer\/tool\/call)/.test(a.method)
        )
          throw new Error("此操作需要打开会话");
        return catalog.operation(
          a.method,
          a.params,
          localCatalogOperation(a.method)
            ? undefined
            : async (rpc) => {
                if (quitting) throw new Error("正在退出");
                const account = store.data.accounts.find(
                  (a) =>
                    a.enabled &&
                    a.status === "ready" &&
                    !accounts.busy.has(a.id),
                );
                if (!account) throw new Error("请先添加一个已登录且可用的账户");
                const prepared = await accounts.inspect(account.id);
                await rpc.call("account/login/start", {
                  type: "chatgptAuthTokens",
                  accessToken: prepared.auth.tokens.access_token,
                  chatgptAccountId: account.identity,
                  chatgptPlanType: account.plan,
                });
              },
        );
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
      case "templates.list": return templates.list();
      case "templates.save": return templates.save(args);
      case "templates.remove": return templates.remove(args);
      case "desktop.read":
        return desktop.data;
      case "desktop.preferences": {
        const previous = structuredClone(desktop.data.preferences);
        Object.assign(
          desktop.data.preferences,
          z
            .object({
              theme: z.enum(["dark", "light", "system"]).optional(),
              language: z
                .enum(["auto", "zh-CN", "zh-TW", "en", "ja"])
                .optional(),
              notifications: z.boolean().optional(),
              startMinimized: z.boolean().optional(),
              closeToTray: z.boolean().optional(),
              preventSleep: z.boolean().optional(),
              privateNotifications: z.boolean().optional(),
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
        try { await desktop.save(); } catch (error) { desktop.data.preferences = previous; throw error; }
        applyDesktopPreferences();
        scheduler.changed();
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
      case "workspace.gitHunk": {
        const a = z.object({
          cwd: z.string().refine(path.isAbsolute),
          path: z.string().min(1).max(32700),
          staged: z.boolean(),
          hunk: z.number().int().min(0).max(100000),
          expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
          expectedDiff: z.string().max(4 * 1024 * 1024),
        }).strict().parse(args);
        return desktop.gitHunk(a.cwd, a.path, a.staged, a.hunk, a.expectedRevision, a.expectedDiff);
      }
      case "workspace.branchList":
      case "workspace.switchBranch": {
        const a = z
          .object({
            cwd: z.string().refine(path.isAbsolute),
            ref: z.string().max(1000).optional(),
            expectedHead: z.string().max(1200).optional(),
            name: z.string().max(200).optional(),
          })
          .strict()
          .parse(args);
        if (name === "workspace.branchList") return desktop.branchList(a.cwd);
        if (!a.ref || a.expectedHead === undefined)
          throw new Error("请选择分支");
        return desktop.switchBranch(a.cwd, a.ref, a.expectedHead, a.name);
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
            expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
            expectedDiff: z.string().max(4 * 1024 * 1024).optional(),
          })
          .strict()
          .parse(args);
        if (name === "workspace.changes") return desktop.changes(a.cwd);
        if (name === "workspace.branches") return desktop.branches(a.cwd);
        if (name === "workspace.worktree")
          return desktop.worktree(a.cwd, a.ref);
        if (!a.action) throw new Error("缺少 Git 操作");
        if (!a.expectedRevision)
          throw new Error("Git 状态已变化，请刷新更改列表后重试");
        if (["stage", "unstage", "restore"].includes(a.action) && a.expectedDiff === undefined)
          throw new Error("文件差异已变化，请刷新后重新检查");
        return desktop.gitAction(a.cwd, a.action, a.path, a.message, a.expectedRevision, a.expectedDiff);
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
      case "schedule.save":
        return schedules.save(scheduleInputSchema.parse(args));
      case "schedule.remove":
        return schedules.remove(idSchema.parse(args));
      case "schedule.run":
        return schedules.run(idSchema.parse(args));
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
      case "chat.goal.update":
        return updateGoal(scheduler,args);
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
      case "job.report":
      case "job.report.save": {
        const id = idSchema.parse(args);
        const report = taskReport(scheduler.snapshot(), id, { version: app.getVersion(), platform: process.platform, arch: process.arch, node: process.versions.node });
        if (name === "job.report") return report;
        const result = await dialog.showSaveDialog(window!, { defaultPath: `codex-relay-${id.slice(0, 8)}-report.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
        if (result.canceled || !result.filePath) return { saved: false };
        await atomicWrite(result.filePath, JSON.stringify(report, null, 2));
        return { saved: true };
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
        const exported = await conversationExport(scheduler.chats,job);
        await atomicWrite(result.filePath,exported.markdown);
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
      case "chat.search": {
        const a = z.object({ id: idSchema, query: z.string().trim().min(1).max(200), offset: z.number().int().min(0).max(10000000).default(0), role: z.enum(["user", "assistant", "tool", "system"]).optional() }).strict().parse(args);
        if (!store.data.jobs.some((j) => j.id === a.id)) throw Error("会话不存在");
        return scheduler.chats.search(a.id, a.query, a.offset, a.role);
      }
      case "chat.searchItem": {
        const a = z.object({ id: idSchema, itemId: z.string().min(1).max(1000) }).strict().parse(args);
        if (!store.data.jobs.some((j) => j.id === a.id)) throw Error("会话不存在");
        const item = await scheduler.chats.item(a.id, a.itemId);
        if (!item) throw Error("消息不存在");
        return { text: item.text.slice(0, 500000), detail: item.detail?.slice(0, 500000), truncated: item.text.length > 500000 || (item.detail?.length || 0) > 500000 };
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
      case "chat.priority": {
        const a = z.object({ id: idSchema, priority: z.enum(["high", "normal", "low"]) }).strict().parse(args);
        return scheduler.priority(a.id, a.priority);
      }
      case "chat.queue":
        return scheduler.editQueue(z.object({
          id: idSchema, messageId: z.string().uuid(), revision: z.number().int().nonnegative(),
          action: z.enum(["edit", "remove", "up", "down"]), text: z.string().trim().min(1).max(100000).optional(),
        }).strict().parse(args));
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
        if (a.cwd === undefined && a.sandbox === undefined && a.approvalPolicy === undefined) { const {id,...patch}=a; return scheduler.metadata(id,patch); }
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
        return serviceHealth(scheduler.snapshot());
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
      case "delivery.read": return scheduler.readDelivery(idSchema.parse(args));
      case "delivery.run": return scheduler.checkDelivery(idSchema.parse(args));
      case "delivery.cancel": return scheduler.cancelDelivery(idSchema.parse(args));
      case "delivery.repair": return scheduler.deliveryPrompt(idSchema.parse(args));
      case "delivery.save": {
        const value = deliverySaveSchema.parse(args);
        return scheduler.saveDelivery(value.id, value.revision, value.checks);
      }
      case "delivery.export": {
        const id = idSchema.parse(args), job = store.data.jobs.find(j => j.id === id);
        return redactValue({schemaVersion: 1, jobId: id, title: job?.title, workspace: job?.cwd, exportedAt: Date.now(), delivery: scheduler.readDelivery(id)});
      }
      case "job.add":
        return scheduler.add(newJobSchema.parse(args));
      case "workflow.report":
        return workflowReports.preview(idSchema.parse(args));
      case "workflow.report.save": {
        const a = z.object({ previewId: idSchema, format: z.enum(["markdown", "json"]) }).strict().parse(args);
        const content = workflowReports.document(a.previewId, a.format);
        const extension = a.format === "json" ? "json" : "md";
        const result = await dialog.showSaveDialog(window!, {defaultPath:`workflow-handoff.${extension}`,filters:[{name:a.format,extensions:[extension]}]});
        if (result.canceled || !result.filePath) return {saved:false};
        await atomicWrite(result.filePath, content);
        return {saved:true};
      }
      case "workflow.add": {
        const a = z.object({ requestId: idSchema, title: z.string().trim().min(1).max(120), steps: z.array(newJobSchema).min(2).max(12) }).strict().parse(args);
        return scheduler.addWorkflow(a.requestId, a.title, a.steps);
      }
      case "scheduler.projectLimit": {
        const a = z.object({ cwd: z.string().min(1).max(32768), limit: z.number().int().min(1).max(8).nullable() }).strict().parse(args);
        return scheduler.projectLimit(a.cwd, a.limit);
      }
      case "scheduler.dispatch": {
        const a = z.object({ paused: z.boolean(), cwd: z.string().min(1).max(32768).optional() }).strict().parse(args);
        return scheduler.dispatch(a.paused, a.cwd);
      }
      case "job.dependencies": {
        const a = z.object({ id: idSchema, ids: z.array(idSchema).max(20) }).strict().parse(args);
        return scheduler.dependencies(a.id, a.ids);
      }
      case "jobs.control": {
        const a = z.object({ ids: z.array(idSchema).min(1).max(100), action: z.enum(["pause", "resume"]) }).strict().parse(args);
        return scheduler.controlMany(a.ids, a.action);
      }
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
      case "tasks.policy": {
        const a = z
          .object({ maxConcurrentTasks: z.number().int().min(1).max(8) })
          .strict()
          .parse(args);
        Object.assign(store.data.settings, a);
        await store.save();
        scheduler.changed();
        return;
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
      {
        const input = settingsSchema.parse(args);
        const changed = input.cliPath !== undefined && input.cliPath !== store.data.settings.cliPath;
        const result = await scheduler.configure(input);
        if (changed) void cliSetup.ensure();
        return result;
      }
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
      case "approval.respond":
        return respondApproval(scheduler, args);
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
  const server = await startCommandServer(dataRoot, scheduler, command, ["cli.status", "cli.ensure"]);
  startupTrace("create window");
  const rendererPath = path.join(__dirname, "..", "renderer", "index.html");
  const available = screen.getPrimaryDisplay().workAreaSize;
  const placement = new WindowPlacement(dataRoot);
  const restored = await placement.read(screen.getAllDisplays().map(d => d.workArea));
  window = new BrowserWindow({
    x: restored.x, y: restored.y, width: restored.width, height: restored.height,
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
  if (restored.maximized) window.maximize();
  let placementTimer: ReturnType<typeof setTimeout> | undefined;
  const savePlacement = () => {
    if (!window || window.isDestroyed() || window.isMinimized()) return;
    void placement.save(window.getNormalBounds(),window.isMaximized()).catch(error => scheduler.log(error,"warning"));
  };
  const queuePlacement = () => {clearTimeout(placementTimer);placementTimer=setTimeout(savePlacement,300);};
  window.on("move",queuePlacement); window.on("resize",queuePlacement);
  window.on("maximize",queuePlacement); window.on("unmaximize",queuePlacement);
  window.on("close",savePlacement);
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
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("activate", () => window?.show());
  window.on("close", (event) => {
    if (!quitReady) {
      event.preventDefault();
      if (!quitting) {
        if (desktop.data.preferences.closeToTray === false) app.quit();
        else window?.hide();
      }
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
  if (!desktop.data.preferences.startMinimized) window.show();
  app.on("before-quit", (event) => {
    if (!quitReady) {
      event.preventDefault();
      if (quitting) return;
      quitting = true;
      void existing
        .shutdown()
        .then(() => schedules.shutdown())
        .then(() =>
          Promise.all([
            cliSetup.shutdown(),
            importer.drain(),
            backgroundHistory.shutdown(),
            scheduler.shutdown(),
            terminals.shutdown(),
            catalog.shutdown(),
          ]),
        )
        .then(() => {
          server.close();
          quitReady = true;
          app.quit();
        })
        .catch((error) => {
          quitting = false;
          existing.start();
          schedules.start();
          catalog.resume();
          terminals.resume();
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
    void schedules.tick().catch((error) => scheduler.log(error, "warning"));
  });
  scheduler.start();
  schedules.start();
  existing.start();
  void cliSetup.ensure();
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
