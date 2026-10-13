import {
  app,
  BrowserWindow,
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
  scheduler = new Scheduler(
    store,
    accounts,
    {
      cli: (ctx) => new CliWorker(ctx),
      desktop: (ctx) => new DesktopWorker(ctx, store, accounts, scripts),
    },
    (job) => recoverJob(job, store, accounts, scripts),
  );
  for (const j of store.data.jobs)
    if (j.recoveryRequired && j.accountId && j.mode === "desktop")
      accounts.busy.add(j.accountId);
  let sleepBlocker: number | undefined;
  let publishTimer: NodeJS.Timeout | undefined;
  scheduler.on("snapshot", () => {
    if (!publishTimer)
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        window?.webContents.send("relay:snapshot", scheduler.snapshot());
      }, 100);
    const running = store.data.jobs.some((j) =>
      ["preparing", "running", "pausing", "rotating"].includes(j.state),
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
      case "snapshot":
        return scheduler.snapshot();
      case "job.add":
        return scheduler.add(newJobSchema.parse(args));
      case "job.control": {
        const a = controlSchema.parse(args);
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
      case "account.import": {
        const result = await dialog.showOpenDialog(window!, {
          title: "导入官方 Codex auth.json",
          properties: ["openFile"],
          filters: [{ name: "Codex auth.json", extensions: ["json"] }],
        });
        if (result.canceled) return;
        const file = result.filePaths[0];
        if ((await fs.stat(file)).size > 1024 * 1024)
          throw new Error("凭据文件过大");
        const account = await accounts.import(await fs.readFile(file, "utf8"));
        await accounts.inspect(account.id).catch(() => {});
        return account.id;
      }
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
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
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
      { label: "暂停任务并退出", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", () => window?.show());
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      quitting = true;
      void scheduler
        .shutdown()
        .then(() => {
          server.close();
          app.quit();
        })
        .catch((error) => {
          quitting = false;
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
