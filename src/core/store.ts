import {deliveryChecksSchema} from "../shared/delivery";
import { promises as fs } from "node:fs";
import path from "node:path";
import { scheduleRecovery } from "./auto-recovery";
import { randomUUID } from "node:crypto";
import type { AppState,Job } from "../shared/types";
export const defaults: AppState = {
  version: 1,
  accounts: [],
  jobs: [],
  logs: [],
  cursor: 0,
  settings: {
    maxConcurrentTasks: 3,
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
  // Resolve the parent first, but Windows can still redirect a newly created
  // file while leaving this existing directory's realpath unchanged.
  const target = path.join(
    await fs.realpath(path.dirname(file)),
    path.basename(file),
  );
  const tmp = `${target}.${randomUUID()}.tmp`;
  let actualTmp = tmp;
  let created:import("node:fs").BigIntStats|undefined;
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      created=await handle.stat({bigint:true});
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Only the created file reveals the physical destination in a mixed
    // global/MSIX AppData view. Rename within that directory, never copy over
    // or truncate the existing destination as an EXDEV workaround.
    actualTmp = await fs.realpath(tmp);
    const sealed=await fs.lstat(actualTmp,{bigint:true}),destination=path.join(path.dirname(actualTmp),path.basename(target));
    if(!sealed.isFile()||sealed.dev!==created.dev||sealed.ino!==created.ino)throw Error("原子写入临时文件已变化");
    const waits=process.platform==="win32"?[50,100,200,400]:[];
    for(let attempt=0;;attempt++){
      try{await fs.rename(actualTmp,destination);break;}
      catch(error){
        if(!["EPERM","EACCES","EBUSY"].includes((error as NodeJS.ErrnoException).code||"")||attempt>=waits.length)throw error;
        await new Promise(resolve=>setTimeout(resolve,waits[attempt]));
        const current=await fs.lstat(actualTmp,{bigint:true});
        if(!current.isFile()||current.dev!==sealed.dev||current.ino!==sealed.ino||current.size!==sealed.size||current.mtimeNs!==sealed.mtimeNs)throw Error("原子写入临时文件已变化");
      }
    }
  } catch (error) {
    if(created){
      actualTmp=await fs.realpath(actualTmp).catch(()=>actualTmp);
      const remaining=await fs.lstat(actualTmp,{bigint:true}).catch(()=>undefined);
      if(remaining?.isFile()&&remaining.dev===created.dev&&remaining.ino===created.ino)await fs.rm(actualTmp,{force:true}).catch(()=>{});
    }
    throw error;
  }
}
export class Store {
  data = structuredClone(defaults);
  private writing = false;
  private lastSaved?: string;
  private pending?: {
    content: string;
    waiters: { resolve: () => void; reject: (error: unknown) => void }[];
  };
  constructor(readonly root: string) {}
  async load() {
    try {
      const content = await fs.readFile(path.join(this.root, "state.json"), "utf8");
      const raw = JSON.parse(content) as AppState;
      if (
        raw.version !== 1 ||
        !Array.isArray(raw.accounts) ||
        !Array.isArray(raw.jobs) ||
        !Array.isArray(raw.logs)
      )
        throw new Error("Unsupported state format");
      this.lastSaved = content;
      this.data = {
        ...raw,
        settings: {
          ...defaults.settings,
          ...raw.settings,
          desktop: { ...defaults.settings.desktop, ...raw.settings?.desktop },
        },
      };
      for (const j of this.data.jobs) {
        if(!j.projectCwd&&j.schedule?.sourceCwd)j.projectCwd=j.schedule.sourceCwd;
        // Old batch-created workflows kept input checks on an unused field.
        // Restore the declared gate without inheriting or fabricating evidence.
        const legacy=(j as Job&{deliveryChecks?:unknown}).deliveryChecks;
        if(legacy!==undefined){
          if(!j.delivery){
            const parsed=deliveryChecksSchema.safeParse(legacy);
            if(!parsed.success)throw Error("旧版工作流验收条件无法读取，请检查状态文件");
            if(parsed.data.length)j.delivery={revision:1,checks:parsed.data,reports:[],...(j.state==="completed"&&!j.recoveryRequired&&(!j.existing||j.existing.phase==="managed")?{pendingCompletion:true,blockedCompletion:true}:{})};
          }
          delete (j as Job&{deliveryChecks?:unknown}).deliveryChecks;
        }

        for (const message of j.queuedMessages || []) message.id ||= randomUUID();
        if (j.delivery?.pendingCompletion) {
          // This marker is saved only after the worker has positively closed.
          // Resume read-only verification rather than sending another model turn.
          j.state = j.stopIntent === "cancel" ? "cancelled" : j.stopIntent === "pause" ? "paused" : "needs_attention";
          j.recoveryRequired = false;
          j.autoRecovery = undefined;
          j.delivery.blockedCompletion = true;
          j.lastError = "交付验收中断，正在重新检查产物";
        } else if (j.existing && j.existing.phase !== "managed") {
          if (!["completed", "cancelled"].includes(j.state)) {
            j.state = "needs_attention";
            j.lastError =
              "已有会话接入需要恢复检查；原窗口可能仍在运行。选择继续监控或完成交接。";
          }
        } else if (
          ["running", "preparing", "pausing", "rotating"].includes(j.state) ||
          j.recoveryRequired
        ) {
          // Old versions did not persist stop intent. Treat an old 'pausing'
          // state conservatively; a crash must never undo a user's Stop click.
          if (j.state === "pausing") j.stopIntent ||= "pause";
          j.recoveryRequired = true;
          j.state = "needs_attention";
          j.lastError = "上次进程意外退出，正在自动核验并恢复原会话。";
          if (!j.autoRecovery) scheduleRecovery(j, "process");
        }
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
          if (this.lastSaved !== undefined) await atomicWrite(path.join(this.root, "state.previous.json"), this.lastSaved);
          await atomicWrite(path.join(this.root, "state.json"), batch.content);
          this.lastSaved = batch.content;
          batch.waiters.forEach((w) => w.resolve());
        } catch (error) {
          batch.waiters.forEach((w) => w.reject(error));
        }
      }
    } finally {
      this.writing = false;
    }
  }
  jobHome(id: string,index?:ReadonlyMap<string,Job>) {
    const homeId = (index?index.get(id):this.data.jobs.find((job) => job.id === id))?.runtimeHomeId;
    if (homeId && !/^[a-f0-9-]{36}$/i.test(homeId))
      throw new Error("会话运行目录标识无效");
    return path.join(this.root, "runtime", "jobs", homeId || id);
  }
  profileHome(id: string) {
    return path.join(this.root, "runtime", "accounts", id);
  }
}
