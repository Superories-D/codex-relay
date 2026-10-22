import React, { useState } from "react";
import type { Job } from "../shared/types";
import { Dialog } from "./Dialog";
import { t, errorText, useI18n } from "./i18n";
export function TaskDependencies({
  job,
  jobs,
  call,
  close,
}: {
  job: Job;
  jobs: Job[];
  call: (name: string, args?: unknown) => Promise<any>;
  close: () => void;
}) {
  useI18n();
  const [ids, setIds] = useState(job.dependsOn || []);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await call("job.dependencies", { id: job.id, ids });
      close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={t("设置前置任务")} onClose={close} busy={busy}>
      <p>{job.title}</p>
      <p>{t("全部前置任务完成后才会执行；取消或删除前置任务不会跳过等待。")}</p>
      <input
        aria-label={t("搜索任务")}
        placeholder={t("搜索任务")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="dependency-options">
        {jobs
          .filter(
            (j) =>
              j.id !== job.id &&
              (!j.archived || ids.includes(j.id)) &&
              `${j.title} ${j.cwd}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((j) => (
            <label key={j.id}>
              <input
                type="checkbox"
                checked={ids.includes(j.id)}
                disabled={busy || (ids.length >= 20 && !ids.includes(j.id))}
                onChange={(e) =>
                  setIds((old) =>
                    e.target.checked
                      ? [...old, j.id]
                      : old.filter((id) => id !== j.id),
                  )
                }
              />
              <span>
                {j.title}
                <small>{j.cwd}</small>
              </span>
            </label>
          ))}
        {ids
          .filter((id) => !jobs.some((j) => j.id === id))
          .map((id) => (
            <label key={id}>
              <input
                type="checkbox"
                checked
                disabled={busy}
                onChange={() =>
                  setIds((old) => old.filter((key) => key !== id))
                }
              />
              {t("已删除的任务")} · {id}
            </label>
          ))}
      </div>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={() => void save()}>
        {t("保存依赖")} ({ids.length}/20)
      </button>
    </Dialog>
  );
}
