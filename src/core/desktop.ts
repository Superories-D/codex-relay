import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWrite } from "./store";
import { normalizeLocalPath } from "../shared/file-reference";
import { readHead, readBranches, switchBranch } from "./git-branches";
import { gitHunkPatch } from "../shared/git-hunks";
import {
  parseGitStatus,
  gitConflict,
  gitStaged,
  gitUnstaged,
  type GitChanges,
} from "../shared/git";

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
  nextRunZone?: string;
  lastRun?: number;
  lastJobId?: string;
  lastError?: string;
  pendingRun?: { id: string; requestedAt: number };
  worktree: boolean;
}
export interface DesktopData {
  projects: Project[];
  schedules: ScheduledTask[];
  preferences: {
    theme: "dark" | "light" | "system";
    notifications: boolean;
    startMinimized?: boolean;
    closeToTray?: boolean;
    preventSleep?: boolean;
    privateNotifications?: boolean;
    language?: import("../shared/locale").Language;
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
    const next = this.writes
      .catch(() => {})
      // Read after prior transactions commit, so an already-queued preference
      // save cannot put an obsolete schedule list back on disk.
      .then(() => atomicWrite(path.join(this.root, "desktop.json"), JSON.stringify(this.data)));
    this.writes = next;
    return next;
  }
  changeSchedules(change: (tasks: ScheduledTask[]) => ScheduledTask[]) {
    const next = this.writes.catch(() => {}).then(async () => {
      const tasks = change(this.data.schedules);
      await atomicWrite(path.join(this.root, "desktop.json"), JSON.stringify({
        ...this.data, schedules: tasks,
      }));
      // Publish only durable edits. Retain task identities used by admission
      // bookkeeping; unrelated tasks may still be preparing while disk writes.
      this.data.schedules = tasks.map((task) => {
        const previous = this.data.schedules.find((item) => item.id === task.id);
        return previous && previous !== task ? Object.assign(previous, task) : task;
      });
    });
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
    let content: string;
    try {
      // A forgiving decode turns legacy encodings into replacement characters;
      // saving that preview would silently destroy bytes. Retain UTF-8 BOMs.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      return { path: relative, kind: "encoded", content: "", mtime: stat.mtimeMs, size: stat.size };
    }
    return {
      path: relative,
      kind: "text",
      content,
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  }
  async write(cwd: string, relative: string, text: string, mtime: number) {
    const file = await this.resolve(cwd, relative);
    const preview = await this.read(cwd, relative);
    if (preview.mtime !== mtime)
      throw new Error("文件已被其他程序修改，请重新读取后保存");
    if (preview.kind !== "text")
      throw new Error("内置编辑器仅支持 UTF-8 文本，请在外部编辑器中修改此文件");
    await atomicWrite(file, text);
    return this.read(cwd, relative);
  }
  async git(cwd: string, args: string[], input?: string) {
    const execution = execute("git", ["-C", cwd, ...args], {
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (input !== undefined) {
      // Git may reject a patch before consuming stdin; report its process error.
      execution.child.stdin?.on("error", () => {});
      execution.child.stdin?.end(input, "utf8");
    }
    const { stdout } = await execution;
    return stdout;
  }
  async changes(cwd: string): Promise<GitChanges> {
    try {
      return await this.inRepository(cwd, (root) => this.readChanges(root));
    } catch (e: any) {
      return {
        root: cwd,
        branch: "",
        revision: "",
        files: [],
        error: String(e.stderr || e.message).slice(0, 500),
      };
    }
  }
  private async readChanges(root: string): Promise<GitChanges> {
    const { current, head } = await readHead(this.git.bind(this), root);
    const branch = current.replace(/^refs\/heads\//, "") || "detached HEAD";
    const raw = await this.git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const index = await this.git(root, [
      "diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames",
      "--no-ext-diff", "--no-textconv", "--",
    ]);
    const revision = createHash("sha256")
      .update(JSON.stringify([head, index, raw]))
      .digest("hex");
    const files = parseGitStatus(raw);
    return { root, branch, revision, files, error: "" };
  }
  async diff(cwd: string, relative: string, staged = false) {
    return this.inRepository(cwd, async (root) =>
      this.readDiff(await this.readChanges(root), relative, staged),
    );
  }
  private async readDiff(state: GitChanges, relative: string, staged: boolean) {
    const entry = state.files.find((f) => f.path === relative);
    if (!entry) throw new Error("文件不在当前变更列表中");
    if (entry.index === "?" && entry.worktree === "?") {
      if (staged) return "";
      const file = await this.read(state.root, relative);
      return file.kind === "text"
        ? file.content
            .split("\n")
            .map((l) => `+${l}`)
            .join("\n")
        : "Binary file";
    }
    return this.git(state.root, [
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--no-relative",
      "--unified=3",
      "--inter-hunk-context=0",
      ...(staged ? ["--cached"] : []),
      "--",
      relative,
      ...(staged && entry.index === "R" && entry.original
        ? [entry.original]
        : []),
    ]);
  }
  async gitHunk(
    cwd: string,
    relative: string,
    staged: boolean,
    hunk: number,
    expectedRevision: string,
    expectedDiff: string,
  ) {
    return this.inRepository(cwd, async (root) => {
      const state = await this.readChanges(root);
      if (state.revision !== expectedRevision)
        throw new Error("Git 状态已变化，请刷新更改列表后重试");
      const entry = state.files.find((file) => file.path === relative);
      if (!entry || gitConflict(entry))
        throw new Error("此差异仅支持整文件操作");
      const diff = await this.readDiff(state, relative, staged);
      if (diff !== expectedDiff)
        throw new Error("文件差异已变化，请刷新后重新检查");
      // Build only from the freshly generated Git patch, never renderer input.
      const patch = gitHunkPatch(diff, hunk);
      if (!patch) throw new Error("此差异仅支持整文件操作");
      await this.git(root, [
        "apply", "--cached", "--whitespace=nowarn",
        ...(staged ? ["--reverse"] : []), "-",
      ], patch);
      return this.readChanges(root);
    });
  }
  async gitAction(
    cwd: string,
    action: string,
    relative?: string,
    message?: string,
    expectedRevision?: string,
    expectedDiff?: string,
  ) {
    return this.inRepository(cwd, (root) =>
      this.applyGitAction(root, action, relative, message, expectedRevision, expectedDiff),
    );
  }
  private async applyGitAction(
    cwd: string,
    action: string,
    relative?: string,
    message?: string,
    expectedRevision?: string,
    expectedDiff?: string,
  ) {
    const state = await this.readChanges(cwd);
    if (expectedRevision !== undefined && state.revision !== expectedRevision)
      throw new Error("Git 状态已变化，请刷新更改列表后重试");
    if (["stage", "unstage", "restore"].includes(action)) {
      const entry = state.files.find((f) => f.path === relative);
      if (!relative || !entry) throw new Error("请选择当前变更文件");
      if (
        expectedDiff !== undefined &&
        (await this.readDiff(state, relative, action === "unstage")) !== expectedDiff
      )
        throw new Error("文件差异已变化，请刷新后重新检查");
      if (action === "stage")
        await this.git(state.root, [
          "--literal-pathspecs",
          "add",
          "--",
          relative,
          ...(entry.worktree === "R" && entry.original ? [entry.original] : []),
        ]);
      if (action === "unstage") {
        if (!gitStaged(entry)) throw new Error("此文件没有已暂存的更改");
        const paths = [
          relative,
          ...(entry.index === "R" && entry.original ? [entry.original] : []),
        ];
        let hasHead = true;
        try {
          await this.git(state.root, [
            "rev-parse",
            "--verify",
            "--quiet",
            "HEAD",
          ]);
        } catch (error: any) {
          if (error.code !== 1) throw error;
          hasHead = false;
        }
        await this.git(state.root, [
          "--literal-pathspecs",
          ...(hasHead
            ? ["restore", "--staged", "--", ...paths]
            : ["rm", "--cached", "--force", "--", ...paths]),
        ]);
      }
      if (action === "restore") {
        if (entry.index === "?")
          throw new Error("未跟踪文件不自动删除，请在文件管理器中处理");
        if (gitConflict(entry))
          throw new Error("文件存在合并冲突，请先解决冲突");
        if (!gitUnstaged(entry)) throw new Error("此文件没有未暂存的更改");
        await this.git(state.root, [
          "--literal-pathspecs",
          "restore",
          "--worktree",
          "--",
          relative,
        ]);
      }
    } else if (action === "commit") {
      if (!message?.trim()) throw new Error("请输入提交信息");
      await this.git(state.root, ["commit", "-m", message]);
    } else if (action === "push") await this.git(state.root, ["push"]);
    else throw new Error("未知 Git 操作");
    return this.readChanges(cwd);
  }
  async worktree(cwd: string, ref = "HEAD", reservationId?: string) {
    return this.inRepository(cwd, (root) =>
      this.createWorktree(root, ref, reservationId),
    );
  }
  private async createWorktree(cwd: string, ref: string, reservationId?: string) {
    if (!ref || ref.startsWith("-") || !/^[\w./@{}~^+-]+$/.test(ref))
      throw new Error("起始分支格式无效");
    if (reservationId && !/^[a-f0-9-]{36}$/i.test(reservationId))
      throw new Error("Worktree reservation ID is invalid");
    const target = path.join(
      this.root,
      "worktrees",
      reservationId || randomUUID(),
    );
    if (reservationId) {
      const normalize = (value: string) =>
        process.platform === "win32"
          ? path.resolve(value).toLowerCase()
          : path.resolve(value);
      const registered = (
        await this.git(cwd, ["worktree", "list", "--porcelain", "-z"])
      )
        .split("\0")
        .some(
          (field) =>
            field.startsWith("worktree ") &&
            normalize(field.slice(9)) === normalize(target),
        );
      if (registered) return this.project(target);
      try {
        await fs.lstat(target);
        throw new Error("预留的 Worktree 目录已存在但未注册，请检查后再运行");
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    }
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
  private gitOperations = new Map<string, Promise<unknown>>();
  // Canonical worktree roots share a queue, including nested folders/junctions.
  // Linked worktrees have separate indices and may operate independently.
  private async inRepository<T>(
    cwd: string,
    operation: (root: string) => Promise<T>,
  ): Promise<T> {
    const root = await fs.realpath(
      (await this.git(cwd, ["rev-parse", "--show-toplevel"])).trim(),
    );
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    const task = (this.gitOperations.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => operation(root));
    this.gitOperations.set(key, task);
    const release = () => {
      if (this.gitOperations.get(key) === task) this.gitOperations.delete(key);
    };
    void task.then(release, release);
    return task;
  }
  async branchList(cwd: string) {
    return this.inRepository(cwd, (root) => readBranches(this.git.bind(this), root));
  }
  async switchBranch(
    cwd: string,
    ref: string,
    expectedHead: string,
    name?: string,
  ) {
    return this.inRepository(cwd, async (root) => {
      await switchBranch(this.git.bind(this), root, ref, expectedHead, name);
      return this.readChanges(root);
    });
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
  const offset = task.cadence === "weekly"
    ? (task.weekday - date.getDay() + 7) % 7 : 0;
  // Construct each target date with the requested wall time. Mutating a date
  // already shifted through a DST gap carries that shifted hour into tomorrow.
  const at = (days: number) => new Date(
    date.getFullYear(), date.getMonth(), date.getDate() + days,
    task.hour, task.minute, 0, 0,
  ).getTime();
  const candidate = at(offset);
  return candidate > now ? candidate : at(offset + (task.cadence === "weekly" ? 7 : 1));
}
