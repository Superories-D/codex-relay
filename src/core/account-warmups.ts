import type { Account, Quota, ResetWarmup } from "../shared/types";
import type { Store } from "./store";
import { eligible } from "./quota";
import { redact } from "./redact";
import type { WarmupRun } from "./warmup-runner";
import { Rpc } from "./rpc";
import path from "node:path";
import { ProcessSafetyError } from "./process-safety-error";
export class AccountWarmups {
  private active?: {
    account: Account;
    record: ResetWarmup;
    execution: WarmupRun;
    yielded?: boolean;
  };
  private working?: Promise<void>;
  private closed = false;
  private claim?: ResetWarmup;
  constructor(
    private store: Store,
    private changed: () => void,
    private create: (account: Account, record: ResetWarmup) => WarmupRun,
    private canStart: (account: Account) => boolean = () => true,
    private release: (account: Account) => void = () => {},
  ) {}
  async recover() {
    let changed = false;
    for (const account of this.store.data.accounts)
      for (const record of Object.values(account.warmups || {}))
        if (
          (record.status === "running" || record.processSafe === false) &&
          this.claim !== record
        ) {
          record.status = "uncertain";
          record.processSafe = false;
          record.finishedAt = Date.now();
          record.error = "上次后台开窗未确认，不会自动重复发送";
          changed = true;
          try {
            if (record.home) {
              const root = path.resolve(this.store.root, "runtime", "warmups");
              const target = path.resolve(record.home);
              if (!target.startsWith(root + path.sep))
                throw Error("后台运行目录不属于当前配置");
              await Rpc.assertHomeIdle(target);
            }
            await Rpc.assertHomeIdle(this.store.profileHome(account.id));
            record.processSafe = true;
            this.release(account);
          } catch (error) {
            record.error = redact(String(error));
          }
        }
    if (changed) await this.store.save();
  }
  start() {
    this.closed = false;
  }
  observe(
    account: Account,
    previous: Record<string, Quota>,
    fresh: Record<string, Quota>,
    covered = false,
  ) {
    if (
      this.closed ||
      this.store.data.settings.resetWarmupEnabled === false ||
      process.env.CODEX_RELAY_DISABLE_RESET_WARMUP === "1"
    )
      return;
    const old = previous.codex?.primary,
      current = fresh.codex;
    const now = Date.now();
    const pending = account.warmups?.codex;
    // A completed reply can precede the rate-limit update. Reconcile a later
    // observation even when the previous probe already contains the new window.
    if (
      pending &&
      pending.status !== "running" &&
      pending.processSafe !== false &&
      ["queued", "sent", "yielded", "failed", "uncertain"].includes(
        pending.status,
      ) &&
      current?.primary?.resetsAt &&
      current.primary.resetsAt > now &&
      current.primary.resetsAt > pending.resetAt &&
      current.observedAt >= pending.resetAt &&
      current.observedAt <= now &&
      now - current.observedAt <= 120000
    ) {
      pending.status = pending.status === "sent" ? "confirmed" : "covered";
      pending.finishedAt = now;
      pending.nextResetAt = current.primary.resetsAt;
      void this.store
        .save()
        .then(() => this.changed())
        .catch(() => {});
      return;
    }
    // Require a fresh server observation of a known rolling window, not just a
    // local alarm. Missing windows remain unknown rather than meaning zero.
    if (
      !old?.resetsAt ||
      old.resetsAt > now ||
      !current?.primary ||
      (old.windowDurationMins !== 300 && account.limitMode !== "fiveHour") ||
      current.observedAt < old.resetsAt ||
      current.observedAt > now ||
      now - current.observedAt > 120000 ||
      (current.primary.usedPercent !== 0 &&
        !(
          current.primary.resetsAt && current.primary.resetsAt > old.resetsAt
        )) ||
      (!covered && !eligible(account, "codex", now))
    )
      return;
    if (account.warmups?.codex?.resetAt === old.resetsAt) {
      const record = account.warmups.codex;
      if (
        covered &&
        record.status !== "running" &&
        current.primary.resetsAt &&
        current.primary.resetsAt > now
      ) {
        record.status = "covered";
        record.finishedAt = now;
        record.nextResetAt = current.primary.resetsAt;
        void this.store
          .save()
          .then(() => this.changed())
          .catch(() => {});
      }
      return;
    }
    const timerStarted =
      covered ||
      !!(
        current.primary.resetsAt &&
        current.primary.resetsAt > now &&
        current.primary.resetsAt > old.resetsAt
      );
    const record: ResetWarmup = {
      resetAt: old.resetsAt,
      queuedAt: now,
      status: timerStarted ? "covered" : "queued",
      ...(timerStarted
        ? {
            finishedAt: now,
            nextResetAt: current.primary.resetsAt || undefined,
          }
        : {}),
    };
    (account.warmups ||= {}).codex = record;
    void this.store
      .save()
      .then(() => {
        this.changed();
        this.pump();
      })
      .catch(() => {});
  }
  pump() {
    if (this.store.data.settings.resetWarmupEnabled === false && this.active)
      void this.yieldToTask().catch(() => {});
    if (
      this.closed ||
      this.working ||
      this.store.data.settings.resetWarmupEnabled === false ||
      process.env.CODEX_RELAY_DISABLE_RESET_WARMUP === "1"
    )
      return;
    const now = Date.now(),
      account = this.store.data.accounts.find(
        (a) =>
          a.warmups?.codex?.status === "queued" &&
          eligible(a, "codex", now) &&
          this.canStart(a),
      );
    if (!account) return;
    const record = account.warmups!.codex;
    this.claim = record;
    record.status = "running";
    this.working = (async () => {
      // Persist before admitting inference. Crash recovery never replays it.
      await this.store.save();
      this.changed();
      if (this.closed || !this.canStart(account)) {
        record.status = "queued";
        return;
      }
      const execution = this.create(account, record);
      this.active = { account, record, execution };
      try {
        const quotas = await execution.done;
        account.quotas = { ...account.quotas, ...quotas };
        const next = quotas.codex?.primary?.resetsAt;
        record.nextResetAt = next || undefined;
        record.status =
          next && next > Date.now() && next > record.resetAt
            ? "confirmed"
            : "sent";
        record.processSafe = true;
      } catch (e) {
        record.status =
          e instanceof ProcessSafetyError
            ? "uncertain"
            : this.active?.yielded
              ? execution.admitted === false
                ? "queued"
                : "yielded"
              : "failed";
        record.processSafe = !(e instanceof ProcessSafetyError);
        record.error = redact(e instanceof Error ? e.message : String(e));
      } finally {
        record.finishedAt = Date.now();
        this.active = undefined;
      }
    })()
      .catch((e) => {
        record.status = "uncertain";
        record.error = redact(String(e));
      })
      .finally(async () => {
        await this.store.save().catch(() => {});
        this.working = undefined;
        this.claim = undefined;
        this.changed();
      });
  }
  async yieldToTask() {
    if (this.active) this.active.yielded = true;
    await this.active?.execution.stop();
    await this.working;
  }
  async shutdown() {
    this.closed = true;
    await this.yieldToTask();
    // Observe-only reconciliations also write state when no execution is active.
    // Join the store queue so shutdown cannot return with such a write in flight.
    await this.store.save();
  }
}
