import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppState } from "../shared/types";
export const defaults: AppState = {
  version: 1,
  accounts: [],
  jobs: [],
  logs: [],
  cursor: 0,
  settings: {
    accountSelection: "smart",
    resetWarmupEnabled: true,
    cliPath: "codex",
    desktopPath: "",
    pollSeconds: 30,
    retrySeconds: 60,
    resumePrompt:
      "继续之前的任务。先检查工作目录与已完成的操作，从中断处继续，避免重复提交、发布或其他已完成的外部操作。完成原始任务后说明结果。",
    desktop: {
      editorSelector: '[contenteditable="true"][role="textbox"], textarea',
      sendSelector:
        'button[aria-label="Send"], button[aria-label="Send message"], button[aria-label="发送"]',
      stopSelector:
        'button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="停止"]',
      threadSelector: '[data-thread-id="{threadId}"]',
      projectSelector: "",
    },
  },
};
export async function atomicWrite(
  file: string,
  value: string | Buffer,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // MSIX hosts may redirect AppData to another volume. Resolve the directory
  // before creating either path so rename remains a same-volume atomic replace.
  const target = path.join(
    await fs.realpath(path.dirname(file)),
    path.basename(file),
  );
  const tmp = `${target}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}
export class Store {
  data = structuredClone(defaults);
  private writing = false;
  private pending?: {
    content: string;
    waiters: { resolve: () => void; reject: (error: unknown) => void }[];
  };
  constructor(readonly root: string) {}
  async load() {
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(this.root, "state.json"), "utf8"),
      ) as AppState;
      if (
        raw.version !== 1 ||
        !Array.isArray(raw.accounts) ||
        !Array.isArray(raw.jobs) ||
        !Array.isArray(raw.logs)
      )
        throw new Error("Unsupported state format");
      this.data = {
        ...raw,
        settings: {
          ...defaults.settings,
          ...raw.settings,
          desktop: { ...defaults.settings.desktop, ...raw.settings?.desktop },
        },
      };
      for (const j of this.data.jobs)
        if (j.existing && j.existing.phase !== "managed") {
          if (!["completed", "cancelled"].includes(j.state)) {
            j.state = "needs_attention";
            j.lastError =
              "已有会话接入需要恢复检查；原窗口可能仍在运行。选择继续监控或完成交接。";
          }
        } else if (
          ["running", "preparing", "pausing", "rotating"].includes(j.state)
        ) {
          j.recoveryRequired = true;
          j.state = "needs_attention";
          j.lastError =
            "上次进程意外退出。确认原进程停止后点击继续，恢复已有会话。";
        }
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  save(): Promise<void> {
    const content = JSON.stringify(this.data, null, 2);
    return new Promise<void>((resolve, reject) => {
      if (this.pending) {
        this.pending.content = content;
        this.pending.waiters.push({ resolve, reject });
      } else this.pending = { content, waiters: [{ resolve, reject }] };
      if (!this.writing) void this.flush();
    });
  }
  private async flush() {
    this.writing = true;
    try {
      while (this.pending) {
        const batch = this.pending;
        this.pending = undefined;
        try {
          await atomicWrite(path.join(this.root, "state.json"), batch.content);
          batch.waiters.forEach((w) => w.resolve());
        } catch (error) {
          batch.waiters.forEach((w) => w.reject(error));
        }
      }
    } finally {
      this.writing = false;
    }
  }
  jobHome(id: string) {
    const homeId = this.data.jobs.find((job) => job.id === id)?.runtimeHomeId;
    if (homeId && !/^[a-f0-9-]{36}$/i.test(homeId))
      throw new Error("会话运行目录标识无效");
    return path.join(this.root, "runtime", "jobs", homeId || id);
  }
  profileHome(id: string) {
    return path.join(this.root, "runtime", "accounts", id);
  }
}
