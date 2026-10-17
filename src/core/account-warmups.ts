import type { Account, Quota, ResetWarmup } from "../shared/types";
import type { Store } from "./store";
import { eligible } from "./quota";
import { redact } from "./redact";
import type { WarmupRun } from "./warmup-runner";
import { Rpc } from "./rpc";
import path from "node:path";
import { ProcessSafetyError } from "./process-safety-error";
import {
  fiveHour,
  freshWindow,
  rememberWindow,
  timerEvidence,
} from "../shared/reset-window";
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
    if (this.closed) return;
    const current = fresh.codex,
      prior = previous.codex,
      now = Date.now();
    if (
      !current ||
      !freshWindow(account, current, now) ||
      (prior && current.observedAt < prior.observedAt)
    )
      return;
    if ((account.resetWindows?.codex?.observedAt || 0) > current.observedAt)
      return;
    let dirty = false;
    // Preserve the last proven boundary even if the server temporarily replaces
    // it with a moving, zero-percent `now + five hours` placeholder.
    if (
      prior &&
      fiveHour(account, prior) &&
      prior.primary!.usedPercent > 0 &&
      prior.primary!.resetsAt &&
      prior.observedAt <= current.observedAt &&
      (!account.resetWindows?.codex ||
        prior.observedAt > account.resetWindows.codex.observedAt)
    )
      dirty = rememberWindow(account, prior, "usage") || dirty;
    const known = account.resetWindows?.codex;
    const evidence = timerEvidence(account, current, prior, now);
    if (evidence) dirty = rememberWindow(account, current, evidence) || dirty;
    const old = prior?.primary;
    // A fresh counter drop plus a changed window is real server evidence even
    // when it arrives before the previously scheduled deadline.
    const counterReset = !!(
      prior &&
      fiveHour(account, prior) &&
      old?.resetsAt &&
      old.resetsAt <= prior.observedAt + 18120000 &&
      old.usedPercent > 0 &&
      current.primary!.usedPercent === 0 &&
      current.primary!.resetsAt !== old.resetsAt &&
      current.observedAt > prior.observedAt
    );
    const movedClock = !!(
      known &&
      current.primary!.usedPercent === 0 &&
      current.primary!.resetsAt &&
      current.primary!.resetsAt > known.resetAt + 60000 &&
      current.observedAt > known.observedAt
    );
    const boundary = counterReset
      ? old!.resetsAt!
      : movedClock
        ? known!.resetAt
        : known && known.resetAt <= now && current.observedAt >= known.resetAt
          ? known.resetAt
          : undefined;
    const persist = () => {
      if (dirty)
        void this.store
          .save()
          .then(() => {
            this.changed();
            this.pump();
          })
          .catch(() => {});
    };
    const pending = account.warmups?.codex;
    // A foreground task may be cancelled before it starts the clock. Only this
    // provisional hand-off (no sent hi, no confirmed date) may return to queue.
    if (
      pending?.status === "covered" &&
      !pending.nextResetAt &&
      !covered &&
      !evidence &&
      current.primary!.usedPercent === 0 &&
      eligible(account, "codex", now)
    ) {
      pending.status = "queued";
      pending.finishedAt = undefined;
      dirty = true;
    }
    if (
      pending &&
      pending.status !== "running" &&
      pending.processSafe !== false &&
      ["queued", "sent", "yielded", "failed", "uncertain", "covered"].includes(
        pending.status,
      ) &&
      evidence &&
      current.observedAt >= pending.queuedAt
    ) {
      const next = pending.status === "sent" ? "confirmed" : "covered";
      if (
        pending.status !== next ||
        pending.nextResetAt !== current.primary!.resetsAt
      ) {
        pending.status = next;
        pending.finishedAt = now;
        pending.nextResetAt = current.primary!.resetsAt!;
        pending.error = undefined;
        dirty = true;
      }
    }
    if (
      this.store.data.settings.resetWarmupEnabled === false ||
      process.env.CODEX_RELAY_DISABLE_RESET_WARMUP === "1" ||
      !boundary ||
      pending?.resetAt === boundary ||
      (current.primary!.usedPercent !== 0 &&
        !(current.primary!.resetsAt && current.primary!.resetsAt > boundary)) ||
      (!covered && !evidence && !eligible(account, "codex", now))
    ) {
      persist();
      return;
    }
    const record: ResetWarmup = {
      resetAt: boundary,
      queuedAt: now,
      status: evidence || covered ? "covered" : "queued",
      ...(evidence || covered ? { finishedAt: now } : {}),
      ...(evidence ? { nextResetAt: current.primary!.resetsAt! } : {}),
    };
    (account.warmups ||= {}).codex = record;
    dirty = true;
    persist();
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
        const before = account.quotas.codex;
        const quotas = await execution.done;
        const current = quotas.codex;
        const proof = current && timerEvidence(account, current, before);
        account.quotas = { ...account.quotas, ...quotas };
        record.nextResetAt = proof ? current!.primary!.resetsAt! : undefined;
        record.status =
          execution.admitted === false
            ? "covered"
            : proof
              ? "confirmed"
              : "sent";
        if (proof) rememberWindow(account, current!, proof);
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
