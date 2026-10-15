import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExistingInspection,
  Job,
  ProcessIdentity,
  Quota,
} from "../shared/types";
import { Store, atomicWrite } from "./store";
import { Scheduler } from "./scheduler";
import {
  scanSessions,
  readSession,
  copyStoppedSession,
  fileStamp,
  type SessionRead,
} from "./existing-reader";
import { findTranscript } from "./transcript";
import { Rpc } from "./rpc";
import { parseAuth } from "./accounts";
import { hasQuotaEvidence, isExhausted, parseQuotas } from "./quota";
import { redact } from "./redact";
import { ProcessSafetyError } from "./process-safety-error";

export interface ExistingDriver {
  inspect(file: string): Promise<{
    processes: ProcessIdentity[];
    canHandoff: boolean;
    issue?: string;
  }>;
  stop(
    file: string,
    processes: ProcessIdentity[],
    receipt: string,
  ): Promise<void>;
  alive?(file: string, processes: ProcessIdentity[]): Promise<boolean>;
}
export class WindowsExistingDriver implements ExistingDriver {
  constructor(
    private root: string,
    private scripts: string,
  ) {}
  private async invoke(action: "inspect" | "stop" | "status", input: object) {
    if (process.platform !== "win32")
      throw new Error("已有进程接入需要 Windows；其他平台仅支持开发测试");
    const request = path.join(this.root, `existing-${randomUUID()}.json`);
    await atomicWrite(request, JSON.stringify(input));
    try {
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
          path.join(this.scripts, "existing-session.ps1"),
          "-RequestPath",
          request,
          "-Action",
          action,
        ],
        {
          windowsHide: true,
          timeout: action === "stop" ? 45_000 : 20_000,
          maxBuffer: 1024 * 1024,
        },
      );
      return JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
    } finally {
      await fs.rm(request, { force: true });
    }
  }
  async inspect(file: string) {
    const result = await this.invoke("inspect", { file });
    if (
      !Array.isArray(result.processes) ||
      typeof result.canHandoff !== "boolean" ||
      result.processes.some(
        (p: any) =>
          !Number.isInteger(p.pid) ||
          p.pid <= 0 ||
          typeof p.startedAt !== "string" ||
          typeof p.executable !== "string",
      )
    )
      throw new Error("进程检查未返回可靠的身份信息");
    return result;
  }
  async stop(file: string, processes: ProcessIdentity[], receipt: string) {
    const result = await this.invoke("stop", { file, processes, receipt });
    if (result.stopped !== true) throw new Error("原进程未确认停止");
  }
  async alive(file: string, processes: ProcessIdentity[]) {
    const result = await this.invoke("status", { file, processes });
    if (typeof result.alive !== "boolean")
      throw new Error("无法确认原进程连接状态");
    return result.alive;
  }
}

export class ExistingSessions {
  private candidates = new Map<
    string,
    { source: SessionRead; inspection?: ExistingInspection; expires: number }
  >();
  private timer?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();
  private polling = false;
  private closing = false;
  private stableTerminal = new Map<string, string>();
  private lastHealthCheck = new Map<string, number>();
  constructor(
    private store: Store,
    private scheduler: Scheduler,
    private driver: ExistingDriver,
    private quotaProbe = (job: Job) => this.probe(job),
  ) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(action);
    this.chain = next;
    return next;
  }
  async scan(
    home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    threadId?: string,
  ) {
    if (!path.isAbsolute(home)) throw new Error("Codex 目录必须是绝对路径");
    const real = await fs.realpath(home);
    const relative = path.relative(this.store.root, real);
    if (!relative.startsWith("..") && !path.isAbsolute(relative))
      throw new Error("请选择原 Codex 目录，不要扫描 Relay 自己的受管目录");
    const result = threadId
      ? {
          sessions: [
            await readSession(real, await findTranscript(real, threadId, true)),
          ],
          warnings: [],
        }
      : await scanSessions(real);
    this.candidates.clear();
    for (const source of result.sessions)
      this.candidates.set(source.candidate.id, {
        source,
        expires: Date.now() + 10 * 60_000,
      });
    return {
      home: real,
      candidates: result.sessions.map((s) => s.candidate),
      warnings: result.warnings,
    };
  }
  private candidate(id: string) {
    const found = this.candidates.get(id);
    if (!found || found.expires < Date.now())
      throw new Error("会话列表已过期，请重新扫描");
    return found;
  }
  async inspect(id: string): Promise<ExistingInspection> {
    const found = this.candidate(id);
    const source = await readSession(found.source.home, found.source.file, id);
    const result = await this.driver.inspect(source.file);
    const inspection = {
      candidate: source.candidate,
      ...result,
      canHandoff: result.canHandoff && !source.candidate.issue,
      issue: source.candidate.issue || result.issue,
    };
    found.source = source;
    found.inspection = inspection;
    return inspection;
  }
  attach(input: {
    id: string;
    strategy: "quota" | "now";
    mode: "cli" | "desktop";
    allowStop: boolean;
  }) {
    return this.serial(async () => {
      if (this.closing) throw new Error("正在退出");
      if (
        this.store.data.jobs.some(
          (j) =>
            [
              "running",
              "preparing",
              "pausing",
              "rotating",
              "queued",
              "waiting",
              "watching",
            ].includes(j.state) ||
            (j.existing?.phase !== "managed" &&
              j.existing &&
              !["completed", "cancelled"].includes(j.state)),
        )
      )
        throw new Error("请先暂停或取消其他 Relay 任务，再接入已有会话");
      if (!this.store.data.accounts.some((a) => a.enabled))
        throw new Error("请先添加并启用至少一个接力账户");
      const found = this.candidate(input.id),
        shown = found.inspection;
      if (!shown) throw new Error("请先检查原进程及交接范围");
      const current = await this.inspect(input.id);
      // Verification must not silently approve a newly discovered process scope.
      // Only an explicit session.inspect from the UI/CLI replaces the reviewed scope.
      found.inspection = shown;
      if (!current.canHandoff)
        throw new Error(current.issue || "暂时无法确认原进程");
      if (
        JSON.stringify(
          current.processes
            .map((p) => [p.pid, p.startedAt, p.executable])
            .sort(),
        ) !==
        JSON.stringify(
          shown.processes.map((p) => [p.pid, p.startedAt, p.executable]).sort(),
        )
      )
        throw new Error("进程列表已改变，请重新查看交接范围后重试");
      if (current.processes.length && !input.allowStop)
        throw new Error("接力需要你在界面确认结束所列 Codex 实例及其子进程");
      const source = found.source;
      if (
        this.store.data.jobs.some(
          (j) =>
            j.threadId === source.candidate.threadId &&
            !["cancelled", "completed"].includes(j.state),
        )
      )
        throw new Error("该会话已经在 Relay 中，不能重复接入");
      const job = await this.scheduler.add(
        {
          title: source.candidate.title,
          prompt:
            source.lastPrompt.slice(0, 100000) ||
            "继续原会话中尚未完成的用户任务，先检查已有结果。",
          cwd: source.candidate.cwd,
          mode: input.mode,
          model: source.candidate.model,
          effort: "",
          bucket: "codex",
          approvalPolicy: "on-request",
          sandbox: "workspaceWrite",
        },
        {
          threadId: source.candidate.threadId,
          turnId: source.turnId,
          link: {
            sourceHome: source.home,
            sourceFile: source.file,
            phase: "watching",
            strategy: input.strategy,
            processes: current.processes,
            allowStop: input.allowStop,
            attachedAt: Date.now(),
            lastObservedTurn: source.turnId,
            completionEligible: source.candidate.status === "running",
          },
        },
      );
      this.candidates.delete(input.id);
      this.scheduler.log(
        "已接入原 Codex 会话；原窗口继续工作，交接前不会启动第二个写入进程",
        "info",
        job.id,
      );
      // Do not make the UI wait for process shutdown and history transfer.
      return job;
    });
  }
  start() {
    this.closing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.polling || this.closing) return;
      this.polling = true;
      void this.tick()
        .catch((e) => this.scheduler.log(e, "error"))
        .finally(() => {
          this.polling = false;
        });
    }, 2000);
    this.timer.unref?.();
  }
  async tick() {
    return this.serial(async () => {
      if (this.closing) return;
      for (const job of this.store.data.jobs) {
        if (!job.existing || ["completed", "cancelled"].includes(job.state))
          continue;
        try {
          if (job.existing.phase === "managed") {
            if (
              ["queued", "waiting", "preparing", "running"].includes(job.state)
            ) {
              try {
                await this.assertManagedSafe(job);
              } catch (error) {
                await this.scheduler.control(job.id, "pause");
                job.recoveryRequired = true;
                throw error;
              }
            }
            continue;
          }
          if (job.state !== "watching") continue;
          const source = await readSession(
            job.existing.sourceHome,
            job.existing.sourceFile,
          );
          if (source.candidate.threadId !== job.threadId)
            throw new Error("原会话身份已改变");
          if (source.candidate.cwd !== job.cwd)
            throw new Error("原会话的工作目录已经改变，请取消接入后重新选择");
          if (
            source.turnId !== job.existing.lastObservedTurn &&
            source.turnId
          ) {
            job.existing.lastObservedTurn = source.turnId;
            job.existing.completionEligible = true;
          }
          job.lastHeartbeatAt = Date.now();
          job.stage = source.quota
            ? "原会话额度中断，准备交接"
            : "正在监控原窗口 / 终端；审批仍在原窗口处理";
          if (source.quota || job.existing.strategy === "now") {
            await this.handoff(job, true);
            continue;
          }
          if (
            !source.terminal &&
            this.driver.alive &&
            Date.now() - (this.lastHealthCheck.get(job.id) ?? 0) >= 15000
          ) {
            this.lastHealthCheck.set(job.id, Date.now());
            if (
              !(await this.driver.alive(
                job.existing.sourceFile,
                job.existing.processes,
              ))
            )
              throw new Error(
                "原 Codex 进程已退出且未确认正常完成。可点击立即交接，从保存的会话继续。",
              );
          }
          if (source.terminal) {
            if (source.candidate.status === "interrupted")
              throw new Error(
                "原会话被中断；点击立即交接可继续，不把中断视为完成",
              );
            if (!job.existing.completionEligible) {
              job.state = "paused";
              job.stage = "原会话已结束；可立即交接继续，或取消接入保留原窗口";
            } else {
              if (this.stableTerminal.get(job.id) !== source.stamp) {
                this.stableTerminal.set(job.id, source.stamp);
                job.stage = "原会话已停止，等待终止记录稳定后复查";
                await this.store.save();
                this.scheduler.changed();
                continue;
              }
              job.stage = "原会话本轮结束，复查额度与最终答复";
              const quotas = await this.quotaProbe(job);
              // Re-read after the probe; a terminal/quota event may arrive during it.
              const latest = await readSession(
                job.existing.sourceHome,
                job.existing.sourceFile,
              );
              if (latest.turnId !== source.turnId || !latest.terminal) continue;
              if (latest.quota || isExhausted(quotas[job.bucket])) {
                await this.handoff(job, true);
                continue;
              }
              if (latest.stamp !== source.stamp) continue;
              if (
                !hasQuotaEvidence(quotas[job.bucket]) ||
                !latest.finalText.trim()
              )
                throw new Error("原会话终止原因尚不能确认，缺少额度或最终答复");
              job.state = "completed";
              job.stage = "原会话正常结束，未发生交接";
              this.scheduler.log(job.stage, "info", job.id);
            }
          }
          await this.store.save();
          this.scheduler.changed();
        } catch (error) {
          job.state = "needs_attention";
          job.lastError = redact(
            error instanceof Error ? error.message : error,
          );
          this.scheduler.log(job.lastError, "warning", job.id);
          await this.store.save();
          this.scheduler.changed();
        }
      }
    });
  }
  async assertManagedSafe(job: Job) {
    if (job.existing?.phase !== "managed") return;
    try {
      const stat = await fs.stat(job.existing.sourceFile);
      if (fileStamp(stat) !== job.existing.sourceStamp)
        throw new Error("source changed");
    } catch (error) {
      throw new ProcessSafetyError(
        "原会话在交接后被修改或无法读取。请停止原窗口的新任务，再核查两边结果；不会自动合并或覆盖会话。",
        error,
      );
    }
  }
  private async handoff(job: Job, run: boolean) {
    const link = job.existing!;
    link.phase = "handoff";
    job.stage = "确认原 Codex 进程停止，保存现有会话";
    job.state = "pausing";
    await this.store.save();
    this.scheduler.changed();
    const home = this.store.jobHome(job.id);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await Rpc.assertHomeIdle(path.join(home, "external-quota"));
    await this.scheduler.accounts.drain();
    const current = await this.driver.inspect(link.sourceFile);
    for (const owner of current.processes) {
      if (
        !link.processes.some(
          (p) =>
            p.pid === owner.pid &&
            p.startedAt === owner.startedAt &&
            p.executable.toLowerCase() === owner.executable.toLowerCase(),
        )
      )
        throw new Error(
          "原会话已由另一个进程打开，停止自动交接，请取消接入后重新扫描",
        );
    }
    if (!link.processes.length && !current.canHandoff)
      throw new Error(current.issue || "无法确认原进程已停止");
    if (link.processes.length && !link.allowStop)
      throw new Error("未确认原进程结束权限");
    link.stopAttempted = true;
    link.stopConfirmed = false;
    await this.store.save();
    await this.driver.stop(
      link.sourceFile,
      link.processes,
      path.join(home, "external-stop.json"),
    );
    link.stopConfirmed = true;
    await this.store.save();
    const source = await readSession(link.sourceHome, link.sourceFile);
    if (source.candidate.issue) throw new Error(source.candidate.issue);
    if (source.candidate.threadId !== job.threadId)
      throw new Error("原会话身份已改变");
    if (source.candidate.cwd !== job.cwd)
      throw new Error("原会话的工作目录已改变，请取消接入后重新选择");
    // The original process was the refresh-token authority until it exited.
    // Read its final cache without changing it; update only an already-imported identity.
    try {
      const authFile = path.join(link.sourceHome, "auth.json");
      if ((await fs.stat(authFile)).size <= 2 * 1024 * 1024) {
        const text = await fs.readFile(authFile, "utf8"),
          auth = parseAuth(text);
        if (this.store.data.accounts.some((a) => a.identity === auth.identity))
          await this.scheduler.accounts.import(text);
      }
    } catch (error: any) {
      if (error.code !== "ENOENT")
        this.scheduler.log(
          "无法同步原实例最后的登录缓存；接力账户仍将重新核实，过期账户需要重新登录",
          "warning",
          job.id,
        );
    }
    const originalName = path.basename(link.sourceFile);
    const named =
      /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})-[0-9a-f-]+\.jsonl$/i.exec(
        originalName,
      );
    const fallback = new Date(source.candidate.updatedAt)
      .toISOString()
      .slice(0, 19)
      .replaceAll(":", "-");
    const timestamp = named ? `${named[1]}T${named[2]}` : fallback;
    const parts = timestamp.slice(0, 10).split("-");
    // Standard date directory AND filename are needed for later ID-based discovery.
    const basename = `rollout-${timestamp}-${job.threadId}.jsonl`;
    const destination = path.join(home, "sessions", ...parts, basename);
    const copied = await copyStoppedSession(source, destination);
    if (copied.cwd && copied.cwd !== job.cwd)
      throw new Error("复制的会话工作目录不一致，停止交接");
    await atomicWrite(
      path.join(home, "external-import.json"),
      JSON.stringify({
        source: link.sourceFile,
        threadId: job.threadId,
        sha256: copied.sha256,
        importedAt: Date.now(),
      }),
    );
    link.sourceStamp = copied.stamp;
    link.phase = "managed";
    job.importedRollout = destination;
    if (copied.turnId) job.turnId = copied.turnId;
    if (copied.model) job.model = copied.model;
    if (copied.lastPrompt) job.prompt = copied.lastPrompt.slice(0, 100000);
    job.desktopSubmissionPending = true; // Resume prompt explicitly rechecks partially executed operations.
    job.recoveryRequired = false;
    job.lastError = undefined;
    job.state = run ? "queued" : "paused";
    job.stage = run
      ? "原进程已退出，等待接力账户恢复原会话"
      : "原会话已交接并暂停";
    await this.store.save();
    this.scheduler.changed();
    this.scheduler.log(job.stage, "info", job.id);
  }
  control(id: string, action: "pause" | "resume" | "cancel" | "handoff") {
    return this.serial(async () => {
      const job = this.store.data.jobs.find((j) => j.id === id);
      if (!job?.existing || job.existing.phase === "managed")
        throw new Error("该会话已交接，请使用任务控制");
      if (["completed", "cancelled"].includes(job.state))
        throw new Error("接入已经结束");
      if (action === "cancel") {
        if (
          job.existing.phase === "handoff" &&
          job.existing.stopAttempted &&
          !job.existing.stopConfirmed
        )
          throw new Error("交接已开始，请先完成停止确认，不能跳过恢复检查");
        job.state = "cancelled";
        job.stage = "已取消接入，原窗口保持原状态";
      } else if (
        action === "handoff" ||
        action === "pause" ||
        job.existing.phase === "handoff"
      ) {
        try {
          await this.handoff(job, action !== "pause");
        } catch (error) {
          job.state = "needs_attention";
          job.lastError = redact(error);
          await this.store.save();
          this.scheduler.changed();
          throw error;
        }
        return;
      } else {
        job.state = "watching";
        job.lastError = undefined;
      }
      await this.store.save();
      this.scheduler.changed();
    });
  }
  async shutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.chain.catch(() => {});
    // Monitoring is not ownership of a running turn. Exit pauses the monitor only;
    // the UI/tray explicitly says existing original windows remain running.
    for (const job of this.store.data.jobs) {
      if (
        job.existing?.phase === "handoff" &&
        job.existing.stopAttempted &&
        !job.existing.stopConfirmed
      )
        throw new ProcessSafetyError(
          "已有会话交接未完成，请先核查停止状态",
          undefined,
        );
      if (job.state === "watching") {
        job.state = "paused";
        job.stage = "监控已暂停；原窗口仍由原 Codex 运行";
      }
    }
    await this.store.save();
  }
  private async probe(job: Job) {
    const file = path.join(job.existing!.sourceHome, "auth.json");
    if ((await fs.stat(file)).size > 2 * 1024 * 1024)
      throw new Error("源认证文件过大");
    const auth = parseAuth(await fs.readFile(file, "utf8"));
    const rpc = await Rpc.open(
      this.store.data.settings.cliPath,
      path.join(this.store.jobHome(job.id), "external-quota"),
      10_000,
    );
    try {
      await rpc.call(
        "account/login/start",
        {
          type: "chatgptAuthTokens",
          accessToken: auth.auth.tokens.access_token,
          chatgptAccountId: auth.identity,
          chatgptPlanType: auth.plan,
        },
        10_000,
      );
      return parseQuotas(await rpc.call("account/rateLimits/read", {}, 10_000));
    } finally {
      await rpc.close();
    }
  }
}
