import React, { useEffect, useState } from "react";
import { Dialog } from "./Dialog";
import { CopyButton } from "./CopyButton";
import { t, useI18n, errorText } from "./i18n";
import type { taskReport } from "../core/task-report";
export function TaskReport({
  id,
  call,
  close,
}: {
  id: string;
  call: (name: string, args?: unknown) => Promise<any>;
  close: () => void;
}) {
  useI18n();
  const [report, setReport] = useState<ReturnType<typeof taskReport>>();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void call("job.report", id)
      .then((value) => {
        if (current) setReport(value);
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      });
    return () => {
      current = false;
    };
  }, [id]);
  const labels: Record<string, string> = {
    ownership: "正在核验原进程",
    recovery: "等待自动恢复",
    approval: "等待你的审批或回答",
    paused: "已保留用户停止请求",
    model: "等待模型账户",
    accounts: "没有启用的账户",
    authentication: "账户需要重新登录",
    availability: "等待账户条件满足",
    history: "历史会话暂不可恢复",
    handoff: "原窗口尚未完成交接",
  };
  return (
    <Dialog title={t("会话诊断报告")} onClose={close} busy={busy}>
      <div className="task-report-preview">
        <p>
          {t("报告包含任务状态、恢复记录和近期诊断日志，导出前可在下方预览。")}
        </p>
        {error && <p role="alert">{error}</p>}
        {report && (
          <>
            <ul>
              {report.blockers.length ? (
                report.blockers.map((code) => (
                  <li key={code}>{t(labels[code] || code)}</li>
                ))
              ) : (
                <li>{t("未发现已知的等待条件")}</li>
              )}
            </ul>
            <div className="queue-actions">
              <CopyButton
                text={JSON.stringify(report, null, 2)}
                label={t("复制报告")}
              />
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const result = await call("job.report.save", id);
                    setSaved(!!result?.saved);
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("导出诊断报告")}
              </button>
            </div>
            {saved && <p role="status">{t("报告已保存")}</p>}
            <pre>{JSON.stringify(report, null, 2)}</pre>
          </>
        )}
      </div>
    </Dialog>
  );
}
