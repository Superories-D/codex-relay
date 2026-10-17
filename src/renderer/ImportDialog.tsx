import { t, useI18n } from "./i18n";
import React, { useState } from "react";
import { Dialog } from "./Dialog";
import type { ImportPreview } from "../core/account-import";
export function ImportDialog({
  preview,
  commit,
  cancel,
}: {
  preview: ImportPreview;
  commit: (indices: number[]) => Promise<{
    imported: number;
    results: { index: number; label: string; ok: boolean; error?: string }[];
  }>;
  cancel: () => void;
}) {
  useI18n();

  const [selected, setSelected] = useState(() =>
    preview.rows.filter((r) => r.action !== "skip").map((r) => r.index),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof commit>>>();
  return (
    <Dialog title={t("预览账户导入")} busy={busy} onClose={cancel}>
      <p className="eyebrow">ACCOUNT IMPORT</p>
      <h2>{result ? t("导入结果") : t("确认要导入的账户")}</h2>
      <p className="subtle">
        {t(
          "支持官方 auth.json、CodexPilot / cockpit-tools JSON、JSONL。已存在账户会更新凭据，旧备份的额度读数不会直接作为可用依据。",
        )}
      </p>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      {result ? (
        <>
          <p role="status">
            {t("已导入")}
            {result.imported} {t("个账户。额度将由后台核实。")}
          </p>
          {result.results.map((r) => (
            <div className="import-row" key={r.index}>
              <b>{r.label}</b>
              <span>{r.ok ? t("已保存") : r.error}</span>
            </div>
          ))}
          <button className="primary full" onClick={cancel}>
            {t("完成")}
          </button>
        </>
      ) : (
        <>
          <div className="import-list">
            {preview.rows.map((row) => (
              <label className="import-row" key={row.index}>
                <input
                  type="checkbox"
                  checked={selected.includes(row.index)}
                  disabled={busy || row.action === "skip"}
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, row.index]
                        : ids.filter((i) => i !== row.index),
                    )
                  }
                />
                <span>
                  <b>{row.label}</b>
                  <small>
                    {row.email} {row.plan && `· ${row.plan}`}
                  </small>
                  {row.error && (
                    <small className="danger-text">{row.error}</small>
                  )}
                </span>
                <em>
                  {
                    { add: t("新增"), update: t("更新"), skip: t("跳过") }[
                      row.action
                    ]
                  }
                </em>
              </label>
            ))}
          </div>
          <p className="subtle">
            {t(
              "预览有效期 10 分钟。正在运行或等待进程恢复的账户需先暂停并完成恢复检查。",
            )}
          </p>
          <button
            className="primary full"
            disabled={busy || !selected.length}
            onClick={() => {
              setBusy(true);
              setError("");
              void commit(selected)
                .then(setResult)
                .catch((e) => setError(String(e).replace(/^Error: /, "")))
                .finally(() => setBusy(false));
            }}
          >
            {busy
              ? t("正在安全保存…")
              : t("确认导入 {p0} 个账户", { p0: selected.length })}
          </button>
        </>
      )}
    </Dialog>
  );
}
