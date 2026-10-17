import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  Download,
  LoaderCircle,
  Square,
  TriangleAlert,
} from "lucide-react";
import {
  emptyImportProgress,
  importRunning,
  type ImportProgress,
} from "../shared/history-import";
import { t, useI18n } from "./i18n";

export function ImportAllControl({
  call,
  compact = false,
  changed,
}: {
  call: (name: string, args?: unknown) => Promise<any>;
  compact?: boolean;
  changed?: () => void;
}) {
  useI18n();
  const [progress, setProgress] = useState<ImportProgress>(emptyImportProgress),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const changedRef = useRef(changed);
  changedRef.current = changed;
  useEffect(() => {
    let alive = true,
      loading = false;
    let previous = "";
    const read = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await call("history.importAll.status");
        if (alive && next?.phase) {
          setProgress(next);
          const key = `${next.id}:${next.imported}:${next.projects}`;
          if (key !== previous && (previous || next.imported || next.projects))
            changedRef.current?.();
          previous = key;
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        loading = false;
      }
    };
    void read();
    const timer = setInterval(read, 750);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const run = async (name: string) => {
    setBusy(true);
    setError("");
    try {
      setProgress(await call(name));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const active = importRunning(progress.phase);
  const phase =
    progress.phase === "scanning"
      ? t("正在扫描本机 Desktop 和 CLI…")
      : progress.phase === "cancelling"
        ? t("正在停止，已导入记录会保留…")
        : active
          ? t("正在后台导入…")
          : progress.phase === "completed"
            ? t("全部扫描完成")
            : progress.phase === "cancelled" || progress.phase === "interrupted"
              ? t("导入已停止，可以继续导入")
              : progress.phase === "failed"
                ? t("导入未完成，请查看详情")
                : "";
  return (
    <section
      className={`import-all-control ${compact ? "compact" : ""}`}
      aria-label={t("批量导入项目和对话")}
    >
      {!compact && (
        <>
          <h2>{t("导入 Desktop 和 CLI")}</h2>
          <p>
            {t(
              "自动发现本机的全部项目、会话和归档，在后台导入独立副本。重复记录会自动跳过，导入时可以继续使用界面。",
            )}
          </p>
        </>
      )}
      <button
        className={compact ? "agent-sidebar-link" : "primary"}
        disabled={busy || active}
        onClick={() => void run("history.importAll.start")}
      >
        {active ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <Download size={15} />
        )}{" "}
        {t("一键导入全部项目和对话")}
      </button>
      {progress.phase !== "idle" && (
        <div className="import-all-progress" role="status" aria-live="polite">
          <span>
            {progress.phase === "completed" ? (
              <Check size={14} />
            ) : active ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <TriangleAlert size={14} />
            )}{" "}
            {phase}
          </span>
          {active && (
            <progress
              max={Math.max(1, progress.total)}
              value={
                progress.phase === "scanning" ? undefined : progress.processed
              }
              aria-label={t("导入进度")}
            />
          )}
          <small>
            {t(
              "项目 {projects} · 对话 {chats} · 跳过 {skipped} · 失败 {failed}",
              {
                projects: progress.projects,
                chats: progress.imported,
                skipped: progress.skipped,
                failed: progress.failed,
              },
            )}
          </small>
          {active && (
            <small title={progress.current}>
              {progress.phase === "scanning"
                ? t("已发现 {count} 个会话", { count: progress.scanned })
                : t("已处理 {done} / {total}", {
                    done: progress.processed,
                    total: progress.total,
                  })}
            </small>
          )}
          {active && (
            <button
              disabled={busy || progress.phase === "cancelling"}
              onClick={() => void run("history.importAll.cancel")}
            >
              <Square size={12} />
              {t("停止导入")}
            </button>
          )}
          {!compact && progress.missingProjects > 0 && (
            <p>
              {t("{count} 个项目目录当前不可用，项目信息已保留。", {
                count: progress.missingProjects,
              })}
            </p>
          )}
          {!compact && progress.readOnly > 0 && (
            <p>
              {t("{count} 个会话有兼容性限制，已导入可读取的记录并标明原因。", {
                count: progress.readOnly,
              })}
            </p>
          )}
          {!!(progress.failures.length || progress.warnings.length) && (
            <details>
              <summary>{t("查看导入详情")}</summary>
              {progress.failures.map((failure, index) => (
                <p key={index}>
                  {failure.title}: {failure.message}
                </p>
              ))}
              {progress.warnings.map((warning, index) => (
                <p key={`warning-${index}`}>{warning}</p>
              ))}
            </details>
          )}
        </div>
      )}
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
