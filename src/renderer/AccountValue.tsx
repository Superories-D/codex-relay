import React, { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { Account, Snapshot } from "../shared/types";
import { accountValue } from "../shared/account-value";
import { eligible } from "../core/quota";
import { t, useI18n, formatDate } from "./i18n";
import { Dialog } from "./Dialog";
import { ModalPresence } from "./MotionRegion";
type Call = (name: string, args?: unknown) => Promise<any>;
export function AccountSelection({
  snapshot,
  call,
}: {
  snapshot: Snapshot;
  call: Call;
}) {
  useI18n();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [selection, setSelection] = useState(
    snapshot.settings.accountSelection || "smart",
  );
  const [warmupEnabled, setWarmupEnabled] = useState(
    snapshot.settings.resetWarmupEnabled !== false,
  );
  useEffect(
    () => setSelection(snapshot.settings.accountSelection || "smart"),
    [snapshot.settings.accountSelection],
  );
  useEffect(
    () => setWarmupEnabled(snapshot.settings.resetWarmupEnabled !== false),
    [snapshot.settings.resetWarmupEnabled],
  );
  return (
    <div className="account-selection">
      <label>
        {t("账户选择方式")}
        <select
          aria-label={t("账户选择方式")}
          value={selection}
          disabled={busy}
          onChange={async (e) => {
            const next = e.target.value as "smart" | "roundRobin";
            setSelection(next);
            setBusy(true);
            setError("");
            try {
              await call("accounts.policy", {
                accountSelection: next,
              });
            } catch (e) {
              setSelection(snapshot.settings.accountSelection || "smart");
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="smart">{t("智能选择")}</option>
          <option value="roundRobin">{t("按顺序轮换")}</option>
        </select>
      </label>
      <p>
        {t(
          "综合剩余额度、重置时间、套餐到期日与账户状态，优先使用更值得现在使用的账户。仅影响下一次调度。",
        )}
      </p>
      <label className="warmup-setting">
        <input
          type="checkbox"
          checked={warmupEnabled}
          disabled={busy}
          onChange={async (e) => {
            const enabled = e.target.checked;
            setWarmupEnabled(enabled);
            setBusy(true);
            setError("");
            try {
              await call("accounts.policy", { resetWarmupEnabled: enabled });
            } catch (e) {
              setWarmupEnabled(snapshot.settings.resetWarmupEnabled !== false);
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        />
        <span>{t("额度重置后自动开始计时")}</span>
      </label>
      <p>
        {t(
          "服务器确认 5 小时额度重置后，在独立后台会话发送一次 hi。优先让路给任务；发送结果不确定时不会重试。会消耗少量额度。",
        )}
      </p>
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function AccountValueControl({
  account,
  call,
}: {
  account: Account;
  call: Call;
}) {
  useI18n();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [expiry, setExpiry] = useState(""),
    [mode, setMode] = useState<Account["limitMode"]>("auto");
  const now = Date.now(),
    value = accountValue(account, "codex", now);
  const factors = {
    capacity: t("剩余额度"),
    expiry: t("即将到期"),
    reset: t("重置临近"),
    plan: t("套餐"),
    weeklyOnly: t("无 5 小时限额"),
    reliability: t("近期失败"),
  };
  const unavailable = !eligible(account, "codex", now);
  const warmup = account.warmups?.codex;
  const clockKnown = !!(
    warmup?.nextResetAt &&
    warmup.nextResetAt > now &&
    account.resetWindows?.codex?.resetAt === warmup.nextResetAt
  );
  const warmupLabel =
    warmup &&
    {
      queued: t("等待空闲时开始计时"),
      running: t("正在后台开始计时…"),
      confirmed: clockKnown
        ? t("已确认下一次重置时间")
        : t("等待重新核实计时状态"),
      sent: t("已发送 hi，等待计时确认"),
      failed: t("后台开窗未完成，不自动重试"),
      uncertain: t("后台开窗结果待核实，不重复发送"),
      covered: clockKnown ? t("已有活动启动计时") : t("由当前任务接手开窗"),
      yielded: t("已让路给任务，不重复发送"),
    }[warmup.status];
  return (
    <>
      <div className="account-value-row">
        <div>
          <span>
            {t("调度优先分")}{" "}
            <strong>
              {unavailable ? t("暂不可选") : value.score.toFixed(1)}
            </strong>
          </span>
          <small>
            {account.expiresAt
              ? t("套餐到期：{date}", { date: formatDate(account.expiresAt) })
              : t("套餐到期时间未设置")}
          </small>
          {warmup && (
            <small
              className={`warmup-status ${warmup.status}`}
              title={warmup.error}
            >
              {warmupLabel}
              {warmup.nextResetAt ? ` · ${formatDate(warmup.nextResetAt)}` : ""}
            </small>
          )}
        </div>
        <button
          title={t("账户使用策略")}
          aria-label={t("账户使用策略")}
          onClick={() => {
            const date = account.expiresAt ? new Date(account.expiresAt) : null;
            setExpiry(
              date
                ? new Date(date.getTime() - date.getTimezoneOffset() * 60000)
                    .toISOString()
                    .slice(0, 16)
                : "",
            );
            setMode(account.limitMode || "auto");
            setError("");
            setOpen(true);
          }}
        >
          <SlidersHorizontal size={15} />
        </button>
      </div>
      <ModalPresence>
        {open && (
          <Dialog
            title={t("账户使用策略")}
            busy={busy}
            onClose={() => setOpen(false)}
          >
            <h2>{t("账户使用策略")}</h2>
            <p>{account.label}</p>
            <label>
              {t("套餐到期时间（手动）")}
              <input
                type="datetime-local"
                aria-label={t("套餐到期时间（手动）")}
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </label>
            <p>
              {t("留空表示未知；登录 Token 的过期时间不会用于判断套餐到期。")}
            </p>
            <label>
              {t("额度窗口类型")}
              <select
                aria-label={t("额度窗口类型")}
                value={mode}
                onChange={(e) =>
                  setMode(e.target.value as Account["limitMode"])
                }
              >
                <option value="auto">
                  {t("自动识别，未提供的窗口保持未知")}
                </option>
                <option value="fiveHour">{t("有 5 小时限额")}</option>
                <option value="weeklyOnly">{t("无 5 小时限额")}</option>
              </select>
            </label>
            <p>
              {t("服务器实际返回的额度限制始终有效，手动设置不会绕过限额。")}
            </p>
            <div className="account-value-factors">
              {value.factors.map((f) => (
                <div key={f.key}>
                  <span>{factors[f.key]}</span>
                  <strong>
                    {f.points >= 0 ? "+" : ""}
                    {f.points.toFixed(1)}
                  </strong>
                </div>
              ))}
            </div>
            {error && (
              <p className="panel-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setOpen(false)}>
                {t("取消")}
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  const expiresAt = expiry ? new Date(expiry).getTime() : null;
                  if (expiresAt !== null && !Number.isFinite(expiresAt)) {
                    setError(t("请输入有效的套餐到期时间"));
                    return;
                  }
                  setBusy(true);
                  setError("");
                  try {
                    await call("account.update", {
                      id: account.id,
                      expiresAt,
                      limitMode: mode,
                    });
                    setOpen(false);
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? t("正在保存…") : t("保存")}
              </button>
            </div>
          </Dialog>
        )}
      </ModalPresence>
    </>
  );
}
