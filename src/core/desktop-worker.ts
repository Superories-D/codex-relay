import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Accounts, parseAuth } from "./accounts";
import { Store, atomicWrite } from "./store";
import { taskPrompt, completionOutcome } from "./completion";
import { prepareThread } from "./thread";
import { Rpc } from "./rpc";
import { Cdp } from "./cdp";
import { findTranscript, TranscriptTail } from "./transcript";
import {
  errorKind,
  hasQuotaEvidence,
  isExhausted,
  isQuotaNotice,
  parseQuotas,
} from "./quota";
import type { Outcome, Worker, WorkerContext } from "./worker";
import type { Quota } from "../shared/types";
import { ensureWindowsSandbox } from "./windows-sandbox";
import { windowsPowerShellEnv } from "./powershell";
const exec = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class DesktopWorker extends EventEmitter implements Worker {
  private cdp?: Cdp;
  private tail?: TranscriptTail;
  private timer?: NodeJS.Timeout;
  private receipt?: string;
  private polling = false;
  private terminal = false;
  private completing = false;
  private closing = false;
  private finalText = "";
  private closeInFlight?: Promise<void>;
  private bootstrap?: Rpc;
  private leased = false;
  private launchNonce?: string;
  private stopRequested = false;
  private probe?: Rpc;
  private quotaSeen = false;
  private turnStarted = false;
  private lastError?: unknown;
  private stopping?: Promise<void>;
  private launchAttempted = false;
  private heartbeatAt = 0;
  private probeInFlight?: Promise<Record<string, Quota>>;
  private settle!: (outcome: Outcome) => void;
  done = new Promise<Outcome>((resolve) => {
    this.settle = resolve;
  });
  constructor(
    private ctx: WorkerContext,
    private store: Store,
    private accounts: Accounts,
    private windowsScripts: string,
  ) {
    super();
  }
  private async powershell(script: string, args: string[] = []) {
    if (process.platform !== "win32")
      throw new Error("官方客户端适配仅在 Windows 可用");
    return exec(
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
        path.join(this.windowsScripts, script),
        ...args,
      ],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024, env: windowsPowerShellEnv() },
    );
  }
  private stage(text: string) {
    this.emit("stage", text);
  }
  private assertStarting() {
    if (this.stopRequested || !this.ctx.shouldStart())
      throw new Error("已请求暂停，停止准备客户端任务");
  }
  async inspect() {
    if (!this.cdp || !this.ctx.job.threadId)
      throw new Error("客户端尚未连接，请查看当前准备阶段");
    return this.cdp.inspect(
      this.store.data.settings.desktop,
      this.ctx.job.threadId,
    );
  }
  async show() {
    if (!this.receipt || !this.launchAttempted)
      throw new Error("受管客户端尚未启动");
    await this.powershell("desktop-control.ps1", [
      "-RequestPath",
      this.receipt,
      "-Action",
      "show",
    ]);
  }
  private finish(outcome: Outcome) {
    if (!this.terminal) {
      this.terminal = true;
      this.settle(outcome);
    }
  }
  async start(auth: {
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType: string;
  }) {
    if (process.platform !== "win32")
      throw new Error("官方客户端模式需要 Windows；CLI 模式可跨平台开发检查");
    this.assertStarting();
    this.stage("等待账户凭据独占权");
    const id = this.ctx.job.accountId!;
    const leasedAuth = await this.accounts.acquireDesktop(id);
    this.leased = true;
    await atomicWrite(
      path.join(this.ctx.home, "auth.json"),
      JSON.stringify(leasedAuth),
    );
    const job = this.ctx.job;
    // Only a dedicated profile is changed; the user's default ~/.codex is untouched.
    await atomicWrite(
      path.join(this.ctx.home, "config.toml"),
      `cli_auth_credentials_store = "file"\n${job.model ? `model = ${JSON.stringify(job.model)}\n` : ""}${job.effort ? `model_reasoning_effort = ${JSON.stringify(job.effort)}\n` : ""}approval_policy = ${JSON.stringify(job.approvalPolicy)}\nsandbox_mode = ${JSON.stringify({ workspaceWrite: "workspace-write", readOnly: "read-only", dangerFullAccess: "danger-full-access" }[job.sandbox])}\n[features]\nsecret_auth_storage = false\n`,
    );
    this.assertStarting();
    this.stage("创建或恢复本地会话");
    const bootstrap = await Rpc.open(this.ctx.cli, this.ctx.home);
    this.bootstrap = bootstrap;
    this.assertStarting();
    const title = `Relay ${job.id.slice(0, 8)} · ${job.title}`;
    try {
      await bootstrap.call("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: leasedAuth.tokens.access_token,
        chatgptAccountId: leasedAuth.tokens.account_id,
        chatgptPlanType: auth.chatgptPlanType,
      });
      await ensureWindowsSandbox(bootstrap, job.cwd, job.sandbox);
      const response = await prepareThread(
        bootstrap,
        job.threadId,
        {
          cwd: job.cwd,
          approvalPolicy: job.approvalPolicy,
          sandbox: {
            workspaceWrite: "workspace-write",
            readOnly: "read-only",
            dangerFullAccess: "danger-full-access",
          }[job.sandbox],
          ...(job.model ? { model: job.model } : {}),
        },
        job.importedRollout,
      );
      if (!job.model && typeof response.model === "string")
        job.model = response.model;
      this.assertStarting();
      await this.ctx.checkpoint(response.thread.id);
      await bootstrap.call("thread/name/set", {
        threadId: job.threadId,
        name: title,
      });
    } finally {
      await bootstrap.close();
      this.bootstrap = undefined;
    }
    if (!this.ctx.shouldStart()) {
      this.finish({ kind: "interrupted" });
      return;
    }
    // Persist the actual model chosen by bootstrap before launching the desktop.
    const configFile = path.join(this.ctx.home, "config.toml");
    if (job.model) {
      const config = await fs.readFile(configFile, "utf8");
      const modelLine = `model = ${JSON.stringify(job.model)}`;
      await atomicWrite(
        configFile,
        /^model = /m.test(config)
          ? config.replace(/^model = .*$/m, () => modelLine)
          : modelLine + "\n" + config,
      );
    }
    this.stage("启动独立的官方客户端");
    this.tail = new TranscriptTail(
      await findTranscript(this.ctx.home, job.threadId!),
    );
    await this.tail.seekEnd();
    const userData = path.join(this.ctx.home, "desktop");
    await fs.mkdir(userData, { recursive: true, mode: 0o700 });
    const globalStateFile = path.join(
      this.ctx.home,
      ".codex-global-state.json",
    );
    let globalState: any = {};
    try {
      globalState = JSON.parse(await fs.readFile(globalStateFile, "utf8"));
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    globalState["electron-saved-workspace-roots"] = [job.cwd];
    globalState["active-workspace-roots"] = [job.cwd];
    await atomicWrite(globalStateFile, JSON.stringify(globalState));
    await fs.rm(path.join(userData, "DevToolsActivePort"), { force: true });
    this.receipt = path.join(this.ctx.home, "desktop-receipt.json");
    await fs.rm(this.receipt, { force: true });
    const request = path.join(this.ctx.home, "desktop-launch.json");
    const nonce = randomUUID();
    this.launchNonce = nonce;
    await atomicWrite(
      request,
      JSON.stringify({
        executable: this.store.data.settings.desktopPath,
        codexHome: this.ctx.home,
        userData,
        receipt: this.receipt,
        nonce,
      }),
    );
    this.launchAttempted = true;
    await this.powershell("desktop-launch.ps1", ["-RequestPath", request]);
    const deadline = Date.now() + 45_000;
    let connected = false;
    while (Date.now() < deadline && !connected) {
      this.assertStarting();
      try {
        const receipt = JSON.parse(
          (await fs.readFile(this.receipt, "utf8")).replace(/^\uFEFF/, ""),
        );
        if (receipt.nonce !== nonce) throw new Error("客户端启动回执不匹配");
        if (receipt.error) throw new Error(receipt.error);
        const verified = await this.powershell("desktop-control.ps1", [
          "-RequestPath",
          this.receipt,
        ]);
        if (!JSON.parse(verified.stdout).running)
          throw new Error("客户端在启动后退出");
        const port = Number(
          (
            await fs.readFile(path.join(userData, "DevToolsActivePort"), "utf8")
          ).split("\n")[0],
        );
        this.stage("连接受管客户端调试端口");
        this.cdp = await Cdp.connect(port);
        connected = true;
      } catch (error) {
        this.assertStarting();
        if (Date.now() + 1000 >= deadline) throw error;
        await delay(1000);
      }
    }
    if (!this.cdp)
      throw new Error(
        "客户端未开放受管调试端口；请使用 CLI 模式或调整客户端版本",
      );
    const selectors = this.store.data.settings.desktop;
    const selector = selectors.threadSelector.replaceAll(
      "{threadId}",
      job.threadId!,
    );
    this.stage("定位任务会话；首次运行请完成客户端引导");
    let selected = false;
    for (let i = 0; i < 20 && !selected; i++) {
      this.assertStarting();
      selected = await this.cdp.selectThread(selector, title, job.threadId);
      if (!selected) await delay(500);
    }
    if (!selected)
      throw new Error(
        "客户端未显示受管会话；请检查客户端适配选择器，不会发送到其他会话",
      );
    let verifiedThread = false;
    for (let i = 0; i < 20 && !verifiedThread; i++) {
      this.assertStarting();
      verifiedThread = await this.cdp.isThreadSelected(job.threadId!, selector);
      if (!verifiedThread) await delay(500);
    }
    if (!verifiedThread) throw new Error("无法验证客户端当前会话，未发送任务");
    if (!this.ctx.shouldStart()) {
      this.finish({ kind: "interrupted" });
      return;
    }
    this.stage("核对会话与输入框");
    await this.submitPrompt();
    this.stage("已发送，等待本机会话确认");
    this.timer = setInterval(() => void this.readTranscript(), 500);
    for (let i = 0; i < 40 && !this.turnStarted && !this.terminal; i++) {
      this.assertStarting();
      await delay(500);
    }
    if (!this.turnStarted && !this.terminal)
      throw new Error(
        "未在受管目录检测到新 task_started，无法确认客户端目录隔离",
      );
  }
  private async submitPrompt() {
    const job = this.ctx.job;
    const selectors = this.store.data.settings.desktop;
    const selector = selectors.threadSelector.replaceAll(
      "{threadId}",
      job.threadId!,
    );
    const prompt = taskPrompt(this.ctx, job.desktopSubmissionPending);
    this.assertStarting();
    await this.cdp!.fill(selectors.editorSelector, prompt);
    this.assertStarting();
    // Persist before the side effect. A disconnect after click is not proof it was unsent.
    job.desktopSubmissionPending = true;
    await this.ctx.checkpoint(job.threadId!);
    this.assertStarting();
    const clicked = await this.cdp!.clickForThread(
      selectors.sendSelector,
      job.threadId!,
      selector,
      { selector: selectors.editorSelector, text: prompt },
    );
    if (!clicked) {
      job.desktopSubmissionPending = false;
      await this.ctx.checkpoint(job.threadId!);
      throw new Error(
        "会话、草稿或发送按钮发生变化，任务未发送；请检查客户端适配",
      );
    }
  }
  private async readTranscript() {
    if (this.polling || !this.tail || this.terminal || this.closing) return;
    this.polling = true;
    try {
      if (Date.now() - this.heartbeatAt > 10_000) {
        this.heartbeatAt = Date.now();
        if (!this.cdp) throw new Error("客户端连接已关闭");
        await this.cdp.call("Runtime.evaluate", {
          expression: "1",
          returnByValue: true,
        });
        this.emit("heartbeat");
      }
      for (const record of await this.tail.read()) {
        if (record.type !== "event_msg") continue;
        const p = record.payload ?? {};
        if (p.type === "task_started" || p.type === "turn_started") {
          if (this.turnStarted && p.turn_id !== this.ctx.job.turnId)
            throw new Error("受管会话出现另一轮任务，停止自动操作");
          this.turnStarted = true;
          this.ctx.job.desktopSubmissionPending = false;
          this.stage("客户端正在执行；需要审批时请在官方窗口处理");
          if (!p.turn_id) throw new Error("客户端未提供真实 turn_id");
          await this.ctx.checkpoint(this.ctx.job.threadId!, p.turn_id);
        }
        if (p.type === "agent_message") {
          this.emit("output", p.message ?? "");
          if (p.phase == null || p.phase === "final_answer")
            this.finalText = p.message ?? "";
          if (isQuotaNotice(p.message)) this.quotaSeen = true;
        }
        if (p.type === "error") {
          this.lastError = p;
          if (errorKind(p) === "quota") this.quotaSeen = true;
        }
        if (p.type === "token_count" && p.rate_limits) {
          const adapt = (w: any) =>
            w
              ? {
                  usedPercent: w.used_percent,
                  windowDurationMins: w.window_minutes,
                  resetsAt: w.resets_at,
                }
              : null;
          const quotas = parseQuotas(
            {
              rateLimits: {
                limitId: p.rate_limits.limit_id ?? "codex",
                primary: adapt(p.rate_limits.primary),
                secondary: adapt(p.rate_limits.secondary),
                rateLimitReachedType: p.rate_limits.rate_limit_reached_type,
                spendControlReached: p.rate_limits.spend_control_reached,
              },
            },
            Date.now(),
            this.store.data.accounts.find(
              (a) => a.id === this.ctx.job.accountId,
            )?.quotas,
            true,
          );
          this.emit("quota", quotas);
          if (isExhausted(quotas[this.ctx.job.bucket])) {
            this.quotaSeen = true;
            void this.stop().catch((e) => this.emit("stopError", e));
          }
        }
        if (
          p.type === "task_complete" ||
          p.type === "turn_complete" ||
          p.type === "turn_aborted"
        ) {
          if (!this.turnStarted) continue;
          if (!p.turn_id)
            throw new Error("终止记录缺少 turn_id，无法确认任务结束");
          if (p.turn_id !== this.ctx.job.turnId) continue;
          this.completing = true;
          this.stage("收到终止记录，正在复查额度与结果");
          this.lastError = p.error ?? this.lastError;
          await delay(750);
          let quotaKnown = false;
          try {
            const q = await this.quota();
            quotaKnown = hasQuotaEvidence(q[this.ctx.job.bucket]);
            if (isExhausted(q[this.ctx.job.bucket])) this.quotaSeen = true;
          } catch {}
          if (
            this.quotaSeen ||
            errorKind(this.lastError) === "quota" ||
            isQuotaNotice(p.last_agent_message)
          )
            this.finish({ kind: "quota", error: this.lastError });
          else if (p.type === "turn_aborted")
            this.finish({ kind: "interrupted" });
          else if (this.lastError)
            this.finish({ kind: "error", error: this.lastError });
          else if (
            !quotaKnown ||
            !String(p.last_agent_message ?? this.finalText).trim()
          )
            this.finish({
              kind: "error",
              error: new Error("终止原因不明确，缺少额度核实或最终答复"),
            });
          else
            this.finish(
              completionOutcome(
                this.ctx.job,
                String(p.last_agent_message ?? this.finalText),
              ),
            );
        }
      }
    } catch (error) {
      this.finish({ kind: "error", error });
    } finally {
      this.polling = false;
    }
  }
  quota(): Promise<Record<string, Quota>> {
    if (this.closing) return Promise.reject(new Error("客户端正在关闭"));
    if (!this.probeInFlight)
      this.probeInFlight = this.readQuota().finally(() => {
        this.probeInFlight = undefined;
      });
    return this.probeInFlight;
  }
  private async readQuota(): Promise<Record<string, Quota>> {
    const current = parseAuth(
      await fs.readFile(path.join(this.ctx.home, "auth.json"), "utf8"),
    ).auth;
    if (
      current.tokens.account_id !== this.ctx.job.accountId &&
      current.tokens.account_id !==
        this.store.data.accounts.find((a) => a.id === this.ctx.job.accountId)
          ?.identity
    )
      throw new Error("客户端凭据身份变化，停止自动操作");
    const probeHome = path.join(this.ctx.home, "quota-probe");
    await fs.mkdir(probeHome, { recursive: true });
    const probe = await Rpc.open(this.ctx.cli, probeHome, 10000);
    this.probe = probe;
    try {
      probe.on("request", (m) =>
        probe.reject(m.id, "Desktop owns token refresh"),
      );
      await probe.call(
        "account/login/start",
        {
          type: "chatgptAuthTokens",
          accessToken: current.tokens.access_token,
          chatgptAccountId: current.tokens.account_id,
        },
        8000,
      );
      const q = parseQuotas(
        await probe.call("account/rateLimits/read", {}, 8000),
      );
      this.emit("quota", q);
      if (isExhausted(q[this.ctx.job.bucket])) {
        this.quotaSeen = true;
        if (
          this.turnStarted &&
          !this.terminal &&
          !this.completing &&
          !this.closing
        )
          void this.stop().catch((e) => this.emit("stopError", e));
      }
      return q;
    } finally {
      await probe.close();
      this.probe = undefined;
    }
  }
  respond() {
    throw new Error("客户端模式请在官方客户端处理审批和输入");
  }
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (!this.turnStarted && this.bootstrap) {
      await this.bootstrap.close();
      return;
    }
    if (this.terminal || this.completing || !this.turnStarted) return;
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.stage("请求停止，等待本轮终止记录");
      const selectors = this.store.data.settings.desktop;
      const selector = selectors.threadSelector.replaceAll(
        "{threadId}",
        this.ctx.job.threadId!,
      );
      if (
        !this.cdp ||
        !(await this.cdp.clickForThread(
          selectors.stopSelector,
          this.ctx.job.threadId!,
          selector,
        ))
      )
        throw new Error(
          "当前会话或停止按钮无法确认，禁止点击其他会话；保留任务等待检查",
        );
      await Promise.race([
        this.done,
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("未收到客户端任务停止记录，禁止轮换")),
            20_000,
          );
          this.done.finally(() => clearTimeout(t));
        }),
      ]);
    })().catch((error) => {
      this.emit("stopError", error);
      this.finish({ kind: "error", error });
      throw error;
    });
    return this.stopping;
  }
  close(): Promise<void> {
    if (!this.closeInFlight)
      this.closeInFlight = this.closeOnce().catch((error) => {
        this.closeInFlight = undefined;
        throw error;
      });
    return this.closeInFlight;
  }
  private async closeOnce() {
    this.closing = true;
    this.stage("确认客户端退出并保存凭据");
    if (this.timer) clearInterval(this.timer);
    this.cdp?.close();
    if (this.bootstrap) {
      await this.bootstrap.close();
      this.bootstrap = undefined;
    }
    if (this.leased) await Rpc.assertHomeIdle(this.ctx.home);
    await this.probeInFlight?.catch(() => {});
    if (this.probe) {
      await this.probe.close();
      this.probe = undefined;
    }
    if (this.leased)
      await Rpc.assertHomeIdle(path.join(this.ctx.home, "quota-probe"));
    if (this.receipt && this.launchAttempted) {
      const receipt = JSON.parse(
        (await fs.readFile(this.receipt, "utf8")).replace(/^\uFEFF/, ""),
      );
      if (receipt.nonce !== this.launchNonce)
        throw new Error("客户端退出回执不匹配，保留进程等待检查");
      if (receipt.started !== false)
        await this.powershell("desktop-control.ps1", [
          "-RequestPath",
          this.receipt,
          "-Action",
          "stop",
        ]);
    }
    if (!this.leased) return;
    const id = this.ctx.job.accountId!;
    try {
      const auth = parseAuth(
        await fs.readFile(path.join(this.ctx.home, "auth.json"), "utf8"),
      ).auth;
      const account = this.store.data.accounts.find((a) => a.id === id);
      if (auth.tokens.account_id !== account?.identity)
        throw new Error("客户端凭据身份不匹配，保留文件等待检查");
      await this.accounts.put(id, auth);
      await fs.rm(path.join(this.ctx.home, "auth.json"), { force: true });
      this.accounts.busy.delete(id);
      this.leased = false;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        this.accounts.busy.delete(id);
        this.leased = false;
      } else throw error;
    }
  }
}
