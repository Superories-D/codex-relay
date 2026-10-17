import { parentPort, workerData } from "node:worker_threads";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "./store";
import { Chats } from "./chat";
import { History } from "./history";
import type { Job } from "../shared/types";

if (!parentPort) throw Error("History import requires a worker");
let cancelled = false,
  ack: (() => void) | undefined;
parentPort.on("message", (message) => {
  if (message.type === "cancel") cancelled = true;
  else if (message.type === "ack") {
    ack?.();
    ack = undefined;
  }
});
const post = (message: unknown) => parentPort!.postMessage(message);
const batch = async (jobs: Job[], projects: unknown[] = []) => {
  const accepted = new Promise<void>((resolve) => {
    ack = resolve;
  });
  post({ type: "batch", jobs, projects });
  await accepted;
};
async function discoverRoots(override?: string[]) {
  const candidates =
    override ??
    ([
      process.env.CODEX_HOME,
      path.join(os.homedir(), ".codex"),
      process.env.APPDATA && path.join(process.env.APPDATA, "Codex"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Codex"),
    ].filter(Boolean) as string[]);
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate);
      if (
        !roots.some((root) =>
          process.platform === "win32"
            ? root.toLowerCase() === real.toLowerCase()
            : root === real,
        )
      )
        roots.push(real);
    } catch {}
  }
  return roots;
}
async function run() {
  const roots = await discoverRoots(workerData.homes);
  post({ type: "progress", value: { phase: "scanning", roots } });
  const history = new History(
    new Store(workerData.root),
    new Chats(workerData.root),
    128 * 1024 * 1024,
  );
  history.cancelled = () => cancelled;
  let lastSnapshotProgress = 0;
  history.snapshotProgress = (snapshotPercent) => {
    if (Date.now() - lastSnapshotProgress > 250 || snapshotPercent === 100) {
      lastSnapshotProgress = Date.now();
      post({ type: "progress", value: { stage: "snapshot", snapshotPercent } });
    }
  };
  try {
    const scan = await history.scan(
      roots,
      (scanned) => {
        if (scanned % 20 === 0) post({ type: "progress", value: { scanned } });
      },
      () => cancelled,
    );
    post({
      type: "progress",
      value: {
        phase: "scanning",
        scanned: scan.entries.length,
        total: scan.entries.length,
        warnings: scan.warnings.slice(-100),
      },
    });
    const projects = new Map<
      string,
      { cwd: string; name: string; missing: boolean }
    >();
    const projectAliases = new Map<string, string>();
    const project = async (cwd: unknown, name?: unknown) => {
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return;
      if (projectAliases.has(cwd)) return;
      let real = cwd,
        missing = false;
      try {
        real = await fs.realpath(cwd);
        missing = !(await fs.stat(real)).isDirectory();
      } catch {
        missing = true;
      }
      const key = process.platform === "win32" ? real.toLowerCase() : real;
      projectAliases.set(cwd, real);
      if (!projects.has(key))
        projects.set(key, {
          cwd: real,
          name:
            typeof name === "string" && name.trim()
              ? name.slice(0, 100)
              : path.basename(real),
          missing,
        });
    };
    for (const p of history.nativeProjects) await project(p.cwd, p.name);
    for (const home of roots) {
      try {
        const state = JSON.parse(
          await fs.readFile(
            path.join(home, ".codex-global-state.json"),
            "utf8",
          ),
        );
        const labels = state["electron-workspace-root-labels"] || {};
        for (const item of Object.values(
          state["local-projects"] || {},
        ) as any[])
          for (const cwd of Array.isArray(item.rootPaths) ? item.rootPaths : [])
            await project(cwd, item.name);
        for (const key of [
          "electron-saved-workspace-roots",
          "active-workspace-roots",
          "electron-pinned-workspace-roots",
        ])
          for (const cwd of Array.isArray(state[key]) ? state[key] : [])
            await project(cwd, labels[cwd]);
      } catch (error: any) {
        if (error.code !== "ENOENT")
          post({
            type: "warning",
            message: `项目列表未完整读取：${error.message}`,
          });
      }
    }
    for (const entry of scan.entries) {
      if (cancelled) break;
      await project(entry.projectCwd || entry.cwd);
    }
    post({ type: "progress", value: { projectsTotal: projects.size } });
    if (!cancelled) await batch([], [...projects.values()]);
    post({ type: "progress", value: { phase: "importing" } });
    const known = new Set<string>(workerData.knownSources),
      pending: Job[] = [];
    const knownEntries = new Map<string, any>(
      (workerData.knownEntries || []).map((j: any) => [j.threadId, j]),
    );
    let processed = 0,
      skipped = 0;
    for (const entry of scan.entries) {
      if (cancelled) break;
      post({
        type: "progress",
        value: { current: entry.title, processed, skipped },
      });
      const previous = knownEntries.get(entry.threadId);
      const upgrade =
        entry.storage === "sqlite" &&
        previous?.storage !== "sqlite" &&
        previous?.upgradable;
      if (known.has(entry.threadId) && !upgrade) skipped++;
      else
        try {
          const job = await history.copyEntry(entry.id);
          if (upgrade) (job as any).replaceId = previous.id;
          post({
            type: "progress",
            value: { stage: "messages", snapshotPercent: undefined },
          });
          job.cwd = projectAliases.get(entry.cwd) || job.cwd;
          if (entry.projectCwd)
            job.projectCwd =
              projectAliases.get(entry.projectCwd) || entry.projectCwd;
          pending.push(job);
          known.add(entry.threadId);
        } catch (error) {
          post({
            type: "failure",
            title: entry.title,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      processed++;
      if (pending.length >= 5) {
        await batch(pending.splice(0));
      }
      post({ type: "progress", value: { processed, skipped } });
    }
    if (pending.length) await batch(pending);
    post({ type: "done", phase: cancelled ? "cancelled" : "completed" });
  } finally {
    history.close();
  }
}
void run()
  .catch((error) =>
    post(
      cancelled
        ? { type: "done", phase: "cancelled" }
        : {
            type: "fatal",
            message: error instanceof Error ? error.message : String(error),
          },
    ),
  )
  .finally(() => parentPort!.close());
