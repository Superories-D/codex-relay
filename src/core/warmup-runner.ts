import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Account, Quota } from "../shared/types";
import type { Accounts } from "./accounts";
import type { Store } from "./store";
import { Rpc } from "./rpc";
import { parseQuotas, isExhausted } from "./quota";
import { ProcessSafetyError } from "./process-safety-error";

export interface WarmupRun {
  readonly admitted?: boolean;
  done: Promise<Record<string, Quota>>;
  stop(): Promise<void>;
}
export class WarmupRunner implements WarmupRun {
  admitted = false;
  private rpc?: Rpc;
  private threadId?: string;
  private turnId?: string;
  private stopped = false;
  done: Promise<Record<string, Quota>>;
  constructor(
    store: Store,
    accounts: Accounts,
    account: Account,
    checkpoint: (home: string) => Promise<void> = async () => {},
    resetAt?: number,
  ) {
    this.done = this.run(store, accounts, account, checkpoint, resetAt);
  }
  async stop() {
    this.stopped = true;
    if (this.rpc && this.threadId && this.turnId)
      void this.rpc
        .call(
          "turn/interrupt",
          { threadId: this.threadId, turnId: this.turnId },
          1000,
        )
        .catch(() => {});
    let error: unknown;
    try {
      await this.rpc?.close();
    } catch (e) {
      error = e;
    }
    await this.done.catch(() => {});
    if (error) throw error;
  }
  private async run(
    store: Store,
    accounts: Accounts,
    account: Account,
    checkpoint: (home: string) => Promise<void>,
    resetAt?: number,
  ) {
    let owns = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const assertIdle = () => {
      if (
        this.stopped ||
        !account.enabled ||
        accounts.busy.has(account.id) ||
        (account.expiresAt != null && account.expiresAt <= Date.now()) ||
        store.data.jobs.some(
          (j) =>
            j.accountId === account.id &&
            (j.recoveryRequired ||
              ["preparing", "running", "pausing"].includes(j.state)),
        )
      )
        throw new Error("账户已有任务或后台开窗已取消");
    };
    try {
      assertIdle();
      const prepared = await accounts.inspect(account.id, true);
      assertIdle();
      if (isExhausted(prepared.quotas.codex))
        throw new Error("账户额度受限，未发送 hi");
      const nextReset = prepared.quotas.codex?.primary?.resetsAt;
      if (resetAt && nextReset && nextReset > Date.now() && nextReset > resetAt)
        return prepared.quotas;
      accounts.busy.add(account.id);
      owns = true;
      const home = path.join(
        store.root,
        "runtime",
        "warmups",
        account.id,
        randomUUID(),
      );
      const cwd = path.join(home, "workspace");
      await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
      await checkpoint(home);
      if (this.stopped) throw new Error("后台开窗已取消");
      this.rpc = await Rpc.open(store.data.settings.cliPath, home, 8000);
      let resolve!: () => void, reject!: (e: Error) => void;
      const terminal = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Attach immediately, including during login/start, so early errors do not
      // become unhandled rejections or get mistaken for successful warmups.
      void terminal.catch(() => {});
      this.rpc.on("request", (m) =>
        this.rpc?.reject(m.id!, "后台开窗不执行工具或审批"),
      );
      this.rpc.on("disconnected", () =>
        reject(new Error("后台开窗连接中断，发送结果可能不确定")),
      );
      this.rpc.on("notification", (m) => {
        if (m.params?.threadId !== this.threadId) return;
        if (m.method === "turn/started") this.turnId = m.params.turn.id;
        if (
          m.method === "turn/completed" &&
          (!this.turnId || m.params.turn.id === this.turnId)
        )
          m.params.turn.status === "completed" && !m.params.turn.error
            ? resolve()
            : reject(
                new Error(m.params.turn.error?.message || "后台开窗已中断"),
              );
      });
      await this.rpc.call("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: prepared.auth.tokens.access_token,
        chatgptAccountId: account.identity,
        chatgptPlanType: account.plan,
      });
      if (this.stopped) throw new Error("后台开窗已取消");
      const models = prepared.models.filter((m) => !m.hidden);
      const model =
        models.find((m) => /luna|mini/i.test(m.model)) ||
        models.find((m) => m.isDefault) ||
        models[0];
      const result = await this.rpc.call("thread/start", {
        cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        ...(model ? { model: model.model } : {}),
        config: {
          "features.goals": false,
          "features.multi_agent": false,
          "features.shell_tool": false,
          "features.image_generation": false,
          "features.browser_use": false,
          "features.computer_use": false,
          web_search: "disabled",
        },
      });
      this.threadId = result.thread.id;
      if (this.stopped) throw new Error("后台开窗已取消");
      const effort = ["none", "minimal", "low"].find((level) =>
        model?.supportedReasoningEfforts?.some(
          (e: any) => e.reasoningEffort === level,
        ),
      );
      timer = setTimeout(
        () => reject(new Error("后台开窗等待超时，未自动重试")),
        60000,
      );
      this.admitted = true;
      const turn = await this.rpc.call("turn/start", {
        threadId: this.threadId,
        input: [
          {
            type: "text",
            text: "hi\n只回复 hi。不要调用任何工具，不读取或修改文件，不开始其他任务。",
            text_elements: [],
          },
        ],
        ...(effort ? { effort } : {}),
        serviceTier: "default",
      });
      this.turnId ||= turn.turn.id;
      if (this.stopped)
        await this.rpc
          .call("turn/interrupt", {
            threadId: this.threadId,
            turnId: this.turnId,
          })
          .catch(() => {});
      await terminal;
      return parseQuotas(await this.rpc.call("account/rateLimits/read"));
    } finally {
      if (timer) clearTimeout(timer);
      // A failed close retains the reservation. The monitor may release it
      // only after checking the owned runtime and account profile are idle.
      try {
        await this.rpc?.close();
      } catch (error) {
        throw new ProcessSafetyError("无法确认后台开窗进程已停止", error);
      }
      if (owns) accounts.busy.delete(account.id);
    }
  }
}
