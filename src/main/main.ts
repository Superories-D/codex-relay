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
} from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../core/store";
import { checkEnvironment } from "../core/diagnostics";
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
import {
  newJobSchema,
  settingsSchema,
  idSchema,
  controlSchema,
  loginSchema,
  accountSchema,
  sessionScanSchema,
  sessionAttachSchema,
} from "./validation";
import { z } from "zod";
app.setName("Codex Relay");
const dataRoot = path.join(app.getPath("appData"), "Codex Relay");
app.setPath("userData", dataRoot);
if (!app.requestSingleInstanceLock()) app.quit();
else
  void boot().catch((error) => {
    dialog.showErrorBox("Codex Relay 无法启动", redact(error));
    app.exit(1);
  });
let window: BrowserWindow | undefined;
let quitting = false;
let tray: Tray | undefined;
async function boot() {
  await app.whenReady();
  const scripts = app.isPackaged
    ? path.join(process.resourcesPath, "windows")
    : path.join(app.getAppPath(), "scripts", "windows");
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  if (process.platform === "win32")
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(scripts, "protect-directory.ps1"),
        "-Directory",
        dataRoot,
      ],
      { windowsHide: true, timeout: 15000 },
    );
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === "linux" &&
      safeStorage.getSelectedStorageBackend() === "basic_text")
  )
    throw new Error("系统安全凭据存储不可用；不会降级为明文账户库。");
  const store = new Store(dataRoot);
  await store.load();
  let scheduler: Scheduler;
  const accounts = new Accounts(
    store,
    {
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
    () => scheduler?.changed(),
  );
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
  for (const j of store.data.jobs)
    if (j.recoveryRequired && j.accountId && j.mode === "desktop")
      accounts.busy.add(j.accountId);
  let sleepBlocker: number | undefined;
  scheduler.on("snapshot", (snapshot) => {
    if (window && !window.isDestroyed())
      window.webContents.send("relay:snapshot", snapshot);
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
  const command = async (name: string, args?: unknown): Promise<unknown> => {
    if (quitting) throw new Error("正在保存并退出");
    switch (name) {
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
          { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
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
            title: "导入 Codex 账户备份",
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
      case "accounts.reorder": {
        const ids = z.array(idSchema).parse(args);
        if (
          ids.length !== store.data.accounts.length ||
          new Set(ids).size !== store.data.accounts.length ||
          ids.some((id) => !store.data.accounts.some((a) => a.id === id))
        )
          throw new Error("账户顺序无效");
        store.data.accounts = ids.map((id) =>
          store.data.accounts.find((a) => a.id === id)!,
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
          .object({ id: z.string().max(100), value: z.unknown() })
          .strict()
          .parse(args);
        const approval = scheduler.approvals.find((a) => a.id === r.id);
        if (!approval) throw new Error("请求已经结束");
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
                .object({ decision: z.enum(["accept", "decline", "cancel"]) })
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
  const rendererPath = path.join(__dirname, "..", "renderer", "index.html");
  const available = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    width: Math.min(1280, available.width),
    height: Math.min(860, available.height),
    minWidth: Math.min(900, available.width),
    minHeight: Math.min(620, available.height),
    title: "Codex Relay",
    backgroundColor: "#101316",
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
  await window.loadFile(rendererPath);
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Codex Relay", click: () => window?.show() },
      { label: "暂停受管任务 / 监控并退出", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", () => window?.show());
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      quitting = true;
      void existing
        .shutdown()
        .then(() => Promise.all([importer.drain(), scheduler.shutdown()]))
        .then(() => {
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
