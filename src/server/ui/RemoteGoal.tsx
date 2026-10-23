import React, { useState } from "react";
import type { Job } from "../../shared/types";
import { t, errorText } from "../../renderer/i18n";
import { ActionStatus, useRemoteAction } from "./LiveControls";
export function RemoteGoal({
  job,
  call,
}: {
  job: Job;
  call: (name: string, args?: any) => Promise<any>;
}) {
  const action = useRemoteAction(job.id, call, "goal"),
    [objective, setObjective] = useState(job.goal?.objective || ""),
    [budget, setBudget] = useState(job.goal?.tokenBudget?.toString() || ""),
    [error, setError] = useState(""),
    [confirmClear, setConfirmClear] = useState(false);
  const goal = job.goal,
    compatible =
      !!job.threadId && !job.recoveryRequired && !job.historySource?.issue;
  function update(kind: string) {
    const tokenBudget = budget.trim() ? Number(budget) : null;
    if (
      ["create", "budget"].includes(kind) &&
      tokenBudget !== null &&
      (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
    ) {
      setError(t("请输入正整数预算，留空表示不限制"));
      return;
    }
    setError("");
    action.submit("goal.update", {
      input: {
        id: job.id,
        action: kind,
        ...(kind === "create"
          ? { objective, tokenBudget, start: false }
          : kind === "edit"
            ? { objective }
            : kind === "budget"
              ? { tokenBudget }
              : {}),
      },
    });
  }
  return (
    <details className="remote-goal">
      <summary>
        {t("会话目标")}
        {goal ? ` · ${goal.status}` : ""}
      </summary>
      <ActionStatus action={action} />
      {goal && (
        <>
          <p>{goal.objective}</p>
          <p>
            {goal.tokensUsed} / {goal.tokenBudget ?? t("不限制")} Tokens
          </p>
          {goal.tokenBudget != null && (
            <progress max={goal.tokenBudget} value={goal.tokensUsed} />
          )}
        </>
      )}
      <button
        type="button"
        disabled={!compatible || !!action.pending}
        onClick={() =>
          void call("goal.read", { id: job.id })
            .then(() => setError(""))
            .catch((e) => setError(errorText(e)))
        }
      >
        {t("刷新")}
      </button>
      {!compatible ? (
        <p>{t("任务建立会话后可管理持续目标。")}</p>
      ) : (
        <fieldset disabled={!!action.pending}>
          <label>
            {t("目标")}
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              maxLength={4000}
            />
          </label>
          {goal&&<p>{t("修改目标正文会重置原生目标的已用 Token 和计时；聊天记录与文件会保留。")}</p>}
          <label>
            {t("Token 预算")}
            <input
              type="number"
              min="1"
              step="1"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
          <p>{t("请输入正整数预算，留空表示不限制")}</p>
          <p>{t("预算在轮次结束时核算，当前轮次可能超过设定值。")}</p>
          {goal ? (
            <>
              <button
                type="button"
                disabled={!objective.trim()}
                onClick={() => update("edit")}
              >
                {t("编辑目标")}
              </button>
              <button type="button" onClick={() => update("budget")}>
                {t("调整目标预算")}
              </button>
              <button type="button" onClick={() => update("start")}>
                {t("启动目标")}
              </button>
              <button type="button" onClick={() => update("pause")}>
                {t("暂停目标")}
              </button>
              <button type="button" onClick={() => setConfirmClear(true)}>
                {t("清除目标")}
              </button>
              {confirmClear && (
                <p>
                  {t("确认清除目标？")}
                  <button
                    type="button"
                    onClick={() => {
                      update("clear");
                      setConfirmClear(false);
                    }}
                  >
                    {t("确认")}
                  </button>
                  <button type="button" onClick={() => setConfirmClear(false)}>
                    {t("取消")}
                  </button>
                </p>
              )}
            </>
          ) : (
            <button
              type="button"
              disabled={!objective.trim()}
              onClick={() => update("create")}
            >
              {t("创建目标并暂停")}
            </button>
          )}
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
