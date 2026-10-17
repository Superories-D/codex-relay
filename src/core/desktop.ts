import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWrite } from "./store";
import { normalizeLocalPath } from "../shared/file-reference";

export interface Project {
  id: string;
  name: string;
  cwd: string;
  pinned: boolean;
}
export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  enabled: boolean;
  cadence: "interval" | "daily" | "weekly";
  minutes: number;
  hour: number;
  minute: number;
  weekday: number;
  nextRun: number;
  lastRun?: number;
  lastJobId?: string;
  lastError?: string;
  worktree: boolean;
}
export interface DesktopData {
  projects: Project[];
  schedules: ScheduledTask[];
  preferences: {
    theme: "dark" | "light" | "system";
    notifications: boolean;
    language?: "auto" | "zh-CN" | "zh-TW" | "en";
    textSize?: number;
    codeSize?: number;
    accent?: string;
    background?: string;
    foreground?: string;
    uiFont?: string;
    codeFont?: string;
    enterSends?: boolean;
    followUp?: "queue" | "steer";
    reduceMotion?: boolean;
  };
}
const execute = promisify(execFile);
export class Desktop {
  data: DesktopData = {
    projects: [],
    schedules: [],
    preferences: { theme: "dark", notifications: true, language: "auto" },
  };
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly root: string) {}
  async load() {
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(this.root, "desktop.json"), "utf8"),
      );
      this.data = {
        ...this.data,
        ...raw,
        preferences: { ...this.data.preferences, ...raw.preferences },
      };
    } catch (e: any) {
      if (e.code !== "ENOENT")
        throw new Error("桌面配置无法读取，请检查 desktop.json");
    }
  }
  save() {
    const text = JSON.stringify(this.data);
    const next = this.writes
      .catch(() => {})
      .then(() => atomicWrite(path.join(this.root, "desktop.json"), text));
    this.writes = next;
    return next;
  }
  async project(cwd: string) {
    const real = await fs.realpath(cwd);
    if (!(await fs.stat(real)).isDirectory()) throw new Error("项目目录不存在");
    const found = this.data.projects.find(
      (p) => p.cwd.toLowerCase() === real.toLowerCase(),
    );
    if (found) return found;
    const project = {
      id: randomUUID(),
      name: path.basename(real),
      cwd: real,
      pinned: false,
    };
    this.data.projects.push(project);
    await this.save();
    return project;
  }
  async resolve(cwd: string, relative = ".") {
    const root = await fs.realpath(cwd);
    const target = await fs.realpath(
      path.resolve(root, normalizeLocalPath(relative)),
    );
    const rel = path.relative(root, target);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
      throw new Error("文件超出当前项目目录");
    return target;
  }
  async files(cwd: string, relative = ".") {
    const dir = await this.resolve(cwd, relative);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          ![".git", "node_modules", ".next", ".venv", "__pycache__"].includes(
            e.name,
          ),
      )
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 1000)
      .map((e) => ({
        name: e.name,
        path: path
          .relative(cwd, path.join(dir, e.name))
          .split(path.sep)
          .join("/"),
        directory: e.isDirectory(),
      }));
  }
  async read(cwd: string, relative: string) {
    const file = await this.resolve(cwd, relative),
      stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("请选择文件");
    const ext = path.extname(file).toLowerCase();
    const mime: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
    };
    if (mime[ext]) {
      if (stat.size > 20 * 1024 * 1024)
        throw new Error("预览文件超过 20 MB，请在默认应用中打开");
      return {
        path: relative,
        kind: ext === ".pdf" ? "pdf" : "image",
        mime: mime[ext],
        content: `data:${mime[ext]};base64,${(await fs.readFile(file)).toString("base64")}`,
        mtime: stat.mtimeMs,
        size: stat.size,
      };
    }
    if (stat.size > 2 * 1024 * 1024)
      throw new Error("文本预览最多 2 MB，请在编辑器中打开");
    const buffer = await fs.readFile(file);
    if (buffer.includes(0))
      return {
        path: relative,
        kind: "binary",
        content: "",
        mtime: stat.mtimeMs,
        size: stat.size,
      };
    return {
      path: relative,
      kind: "text",
      content: buffer.toString("utf8"),
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  }
  async write(cwd: string, relative: string, text: string, mtime: number) {
    const file = await this.resolve(cwd, relative),
      stat = await fs.stat(file);
    if (stat.mtimeMs !== mtime)
      throw new Error("文件已被其他程序修改，请重新读取后保存");
    await atomicWrite(file, text);
    return this.read(cwd, relative);
  }
  async git(cwd: string, args: string[]) {
    const { stdout } = await execute("git", ["-C", cwd, ...args], {
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  }
  async changes(cwd: string) {
    try {
      const root = (
        await this.git(cwd, ["rev-parse", "--show-toplevel"])
      ).trim();
      const branch =
        (await this.git(cwd, ["branch", "--show-current"])).trim() ||
        "detached HEAD";
      const raw = (
        await this.git(root, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=normal",
        ])
      ).split("\0");
      const files: {
        path: string;
        index: string;
        worktree: string;
        original?: string;
      }[] = [];
      for (let i = 0; i < raw.length; i++)
        if (raw[i]) {
          const row = raw[i],
            entry = {
              path: row.slice(3),
              index: row[0],
              worktree: row[1],
              original: undefined as string | undefined,
            };
          if (/[RC]/.test(row.slice(0, 2))) entry.original = raw[++i];
          files.push(entry);
        }
      return { root, branch, files, error: "" };
    } catch (e: any) {
      return {
        root: cwd,
        branch: "",
        files: [],
        error: String(e.stderr || e.message).slice(0, 500),
      };
    }
  }
  async diff(cwd: string, relative: string, staged = false) {
    const state = await this.changes(cwd);
    if (state.error) throw new Error("当前目录不是 Git 仓库");
    const entry = state.files.find((f) => f.path === relative);
    if (!entry) throw new Error("文件不在当前变更列表中");
    if (entry.index === "?" && entry.worktree === "?") {
      const file = await this.read(state.root, relative);
      return file.kind === "text"
        ? file.content
            .split("\n")
            .map((l) => `+${l}`)
            .join("\n")
        : "Binary file";
    }
    return this.git(state.root, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      ...(staged ? ["--cached"] : []),
      "--",
      relative,
    ]);
  }
  async gitAction(
    cwd: string,
    action: string,
    relative?: string,
    message?: string,
  ) {
    const state = await this.changes(cwd);
    if (state.error) throw new Error("当前目录不是 Git 仓库");
    if (["stage", "unstage", "restore"].includes(action)) {
      if (!relative || !state.files.some((f) => f.path === relative))
        throw new Error("请选择当前变更文件");
      if (action === "stage")
        await this.git(state.root, ["add", "--", relative]);
      if (action === "unstage")
        await this.git(state.root, ["restore", "--staged", "--", relative]);
      if (action === "restore") {
        if (state.files.find((f) => f.path === relative)?.index === "?")
          throw new Error("未跟踪文件不自动删除，请在文件管理器中处理");
        await this.git(state.root, ["restore", "--worktree", "--", relative]);
      }
    } else if (action === "commit") {
      if (!message?.trim()) throw new Error("请输入提交信息");
      await this.git(state.root, ["commit", "-m", message]);
    } else if (action === "push") await this.git(state.root, ["push"]);
    else throw new Error("未知 Git 操作");
    return this.changes(cwd);
  }
  async worktree(cwd: string, ref = "HEAD") {
    if (!ref || ref.startsWith("-") || !/^[\w./@{}~^+-]+$/.test(ref))
      throw new Error("起始分支格式无效");
    const target = path.join(this.root, "worktrees", randomUUID());
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.git(cwd, ["worktree", "add", "--detach", target, ref]);
    return this.project(target);
  }
  async branches(cwd: string) {
    return (
      await this.git(cwd, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  }
}
export function nextSchedule(
  task: Pick<
    ScheduledTask,
    "cadence" | "minutes" | "hour" | "minute" | "weekday"
  >,
  now = Date.now(),
) {
  if (task.cadence === "interval") return now + task.minutes * 60000;
  const date = new Date(now);
  date.setHours(task.hour, task.minute, 0, 0);
  if (task.cadence === "weekly") {
    const diff = (task.weekday - date.getDay() + 7) % 7;
    date.setDate(date.getDate() + diff);
  }
  if (date.getTime() <= now)
    date.setDate(date.getDate() + (task.cadence === "weekly" ? 7 : 1));
  return date.getTime();
}
