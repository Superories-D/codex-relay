import React, { useEffect, useState } from "react";
import { LoaderCircle, Pause } from "lucide-react";
import type { Job } from "../shared/types";
import { t, useI18n } from "./i18n";

export function RecoveryNotice({
  job,
  onPause,
  pending = false,
}: {
  job: Job;
  onPause?: () => void;
  pending?: boolean;
}) {
  useI18n();
  const [now, setNow] = useState(Date.now);
  const recovery = job.autoRecovery;
  useEffect(() => {
    if (!recovery) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recovery?.nextAttemptAt]);
  if (!recovery) return null;
  const seconds = Math.max(0, Math.ceil((recovery.nextAttemptAt - now) / 1000));
  return (
    <section className="recovery-notice" aria-label={t("自动恢复")}>
      <div className="recovery-notice-heading" role="status">
        <LoaderCircle
          size={17}
          className="recovery-spinner"
          aria-hidden="true"
        />
        <strong>
          {job.stopIntent ? t("正在确认停止") : t("正在自动恢复")}
        </strong>
        {onPause && !job.stopIntent && (
          <button disabled={pending} onClick={onPause}>
            <Pause size={14} />
            {t("暂停自动恢复")}
          </button>
        )}
      </div>
      <p>
        {job.stopIntent
          ? t("已记住你的停止请求，核验结束后不会自动运行。")
          : job.recoveryRequired
            ? t("正在确认原进程已退出，确认后会自动继续原会话。")
            : t("会话和进度已保留，无需点击继续。")}
      </p>
      <small>
        {seconds > 0
          ? t("{seconds} 秒后重试 · 第 {attempt} 次恢复", {
              seconds,
              attempt: recovery.attempt,
            })
          : t("正在检查连接与会话状态…")}
      </small>
      {job.lastError && (
        <details>
          <summary>{t("查看中断原因")}</summary>
          <p>{job.lastError}</p>
        </details>
      )}
    </section>
  );
}
