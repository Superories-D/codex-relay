import React, { useState } from "react";
import type { Job } from "../../shared/types";
import { t, errorText } from "../../renderer/i18n";
import { ActionStatus, useRemoteAction } from "./LiveControls";
export function WorkflowOperations({
  job,
  jobs,
  call,
  open,
}: {
  job: Job;
  jobs: Job[];
  call: (name: string, args?: any) => Promise<any>;
  open: (id: string) => void;
}) {
  const id = job.workflow!.id,
    action = useRemoteAction(id, call, "workflow"),
    [fromStep, setFromStep] = useState(job.workflow!.step),
    [preview, setPreview] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const stages = jobs
    .filter((j) => j.workflow?.id === id)
    .sort((a, b) => a.workflow!.step - b.workflow!.step);
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      setPreview(await call("workflow.previewRetry", { id, fromStep }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="remote-workflow-operations">
      <summary>{t("工作流控制与重试")}</summary>
      <ActionStatus action={action} />
      {job.workflow?.source && (
        <p>
          {t("来源工作流")} · {job.workflow.source.id} ·{" "}
          {job.workflow.source.step}
        </p>
      )}
      <ol>
        {stages.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => open(s.id)}>
              {s.title}
            </button>{" "}
            · {s.state}
          </li>
        ))}
      </ol>
      <fieldset disabled={!!action.pending || busy}>
        <button
          type="button"
          onClick={() =>
            action.submit("workflow.control", { id, action: "pause" })
          }
        >
          {t("暂停未完成阶段")}
        </button>
        <button
          type="button"
          onClick={() =>
            action.submit("workflow.control", { id, action: "resume" })
          }
        >
          {t("恢复未完成阶段")}
        </button>
        <label>
          {t("从阶段重试")}
          <select
            value={fromStep}
            onChange={(e) => {
              setFromStep(Number(e.target.value));
              setPreview(undefined);
            }}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.workflow!.step}>
                {s.workflow!.step}. {s.title}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void prepare()}>
          {t("生成重试预览")}
        </button>
        {preview && (
          <section>
            <p>{t("保留原工作流，携带已完成阶段结果，新分支暂停等待启动。")}</p>
            {preview.steps.map((s: any, i: number) => (
              <details key={i}>
                <summary>{s.title}</summary>
                <pre>{s.prompt}</pre>
              </details>
            ))}
            <button
              type="button"
              onClick={() =>
                action.submit("workflow.retry", { previewId: preview.id })
              }
            >
              {t("创建暂停的重试分支")}
            </button>
          </section>
        )}
      </fieldset>
      {action.receipt?.action === "workflow.retry" &&
        action.receipt.result?.[0]?.id && (
          <button
            type="button"
            onClick={() => open(action.receipt.result[0].id)}
          >
            {t("打开重试分支")}
          </button>
        )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
