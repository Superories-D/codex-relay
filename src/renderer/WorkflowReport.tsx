import React, { useEffect, useState } from "react";
import { Dialog } from "./Dialog";
import { CopyButton } from "./CopyButton";
import { t, useI18n, errorText } from "./i18n";
import type { WorkflowReports } from "../core/workflow-report";
type Preview = Awaited<ReturnType<WorkflowReports["preview"]>>;
export function WorkflowReport({
  id,
  call,
  close,
}: {
  id: string;
  call: (name: string, args?: unknown) => Promise<any>;
  close: () => void;
}) {
  useI18n();
  const [data, setData] = useState<Preview>();
  const [format, setFormat] = useState<"markdown" | "json">("markdown");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    let current = true;
    void call("workflow.report", id)
      .then((value) => {
        if (current) setData(value);
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      });
    return () => {
      current = false;
    };
  }, [id]);
  async function save() {
    if (!data) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await call("workflow.report.save", {
        previewId: data.previewId,
        format,
      });
      setSaved(result.saved);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const content = data
    ? format === "markdown"
      ? data.markdown
      : JSON.stringify(data.report, null, 2)
    : "";
  return (
    <Dialog title={t("工作流交付报告")} onClose={close} busy={busy}>
      <div className="workflow-report task-report-preview">
        <h2>{t("工作流交付报告")}</h2>
        <p>
          {t(
            "汇总各阶段状态、最近回复、产物路径与恢复记录。路径仅为引用，不会打包文件；回复不代表独立验收结果。",
          )}
        </p>
        {data && (
          <>
            <strong>
              {data.report.title} ·{" "}
              {t(
                data.report.complete ? "全部阶段已完成" : "工作流尚未全部完成",
              )}
            </strong>
            <p>
              {t("已记录 {count} / {total} 个阶段", {
                count: data.report.stages.length,
                total: data.report.expectedStages,
              })}
            </p>
            <select
              aria-label={t("导出格式")}
              disabled={busy}
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as typeof format);
                setSaved(false);
              }}
            >
              <option value="markdown">Markdown</option>
              <option value="json">JSON</option>
            </select>
            <pre>{content}</pre>
            <div className="queue-actions">
              <CopyButton label={t("复制报告")} text={content} />
              <button
                className="workflow-report-save"
                disabled={busy}
                onClick={() => void save()}
              >
                {t("导出当前预览")}
              </button>
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">{t("报告已保存")}</p>}
      </div>
    </Dialog>
  );
}
