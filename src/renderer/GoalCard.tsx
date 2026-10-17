import React, { useEffect, useRef, useState } from "react";
import {
  Ellipsis,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Pencil,
  RefreshCw,
  Target,
  Trash2,
} from "lucide-react";
import type { Job } from "../shared/types";
import { t, useI18n, errorText } from "./i18n";
import { Dialog } from "./Dialog";
import { ModalPresence } from "./MotionRegion";

type Call = (name: string, args?: unknown) => Promise<any>;
export function GoalCard({ job, call }: { job?: Job; call: Call }) {
  const { language } = useI18n();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [editor, setEditor] = useState<
    "budget" | "clear" | "create" | "edit" | null
  >(null);
  const [budget, setBudget] = useState("");
  const [objective, setObjective] = useState("");
  const lock = useRef(false),
    owner = useRef(job?.id);
  const menu = useRef<HTMLDetailsElement>(null);
  const cleared = useRef(false);
  owner.current = job?.id;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target))
        menu.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const read = async (manual = false) => {
    if (!job || lock.current) return;
    const id = job.id;
    lock.current = true;
    setBusy(true);
    try {
      await (manual
        ? call("chat.goal.read", { id })
        : window.relay.command("chat.goal.read", { id }));
      if (owner.current === id) setError("");
    } catch (e) {
      if (manual && owner.current === id) setError(errorText(e));
    } finally {
      lock.current = false;
      if (owner.current === id) setBusy(false);
    }
  };
  useEffect(() => {
    // Incompatible external histories have no usable native goal database.
    if (
      job?.threadId &&
      !job.historySource?.issue &&
      !job.recoveryRequired &&
      [
        "running",
        "completed",
        "paused",
        "cancelled",
        "needs_attention",
      ].includes(job.state)
    )
      void read();
  }, [job?.id, job?.state]);
  const update = async (
    action: "pause" | "budget" | "clear" | "create" | "edit" | "start",
    start = false,
  ) => {
    if (!job || lock.current) return;
    const tokenBudget = budget.trim() ? Number(budget) : null;
    if (
      ["budget", "create"].includes(action) &&
      tokenBudget !== null &&
      (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
    ) {
      setError(t("请输入正整数预算，留空表示不限制"));
      return;
    }
    if (["create", "edit"].includes(action) && !objective.trim()) {
      setError(t("请填写目标"));
      return;
    }
    const id = job.id;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await call("chat.goal.update", {
        id,
        action,
        ...(action === "budget" ? { tokenBudget } : {}),
        ...(action === "create"
          ? { objective: objective.trim(), tokenBudget, start }
          : {}),
        ...(action === "edit" ? { objective: objective.trim() } : {}),
      });
      if (owner.current === id) {
        cleared.current = action === "clear";
        setEditor(null);
      }
    } catch (e) {
      if (owner.current === id) setError(errorText(e));
    } finally {
      lock.current = false;
      if (owner.current === id) setBusy(false);
    }
  };
  const goal = job?.goal;
  const compatible =
    job?.mode === "cli" &&
    job.threadId &&
    !job.historySource?.issue &&
    !job.recoveryRequired &&
    (!job.existing || job.existing.phase === "managed");
  const idle =
    !!job &&
    ["completed", "paused", "cancelled", "needs_attention"].includes(job.state);
  const budgetSpent =
    !!goal && goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget;
  const editorTitle =
    editor === "clear"
      ? t("清除目标")
      : editor === "create"
        ? t("设置持续目标")
        : editor === "edit"
          ? t("编辑目标")
          : t("调整目标预算");
  const labels = {
    active: t("目标有效"),
    paused: t("目标已暂停"),
    blocked: t("目标受阻"),
    usageLimited: t("额度受限"),
    budgetLimited: t("已达目标预算"),
    complete: t("目标已完成"),
  };
  const format = (v: number) => new Intl.NumberFormat(language).format(v);
  const percent = goal?.tokenBudget
    ? Math.min(100, Math.max(0, (goal.tokensUsed / goal.tokenBudget) * 100))
    : null;
  return (
    <>
      {!goal && compatible && (idle || job?.state === "running") && (
        <section className="summary-card goal-empty">
          <button
            className="goal-create"
            disabled={busy}
            onClick={() => {
              setObjective("");
              setBudget("");
              setError("");
              setEditor("create");
            }}
          >
            <Target size={17} />
            <span>{t("设置持续目标")}</span>
            <Plus size={16} />
          </button>
          {error && !editor && (
            <p className="panel-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
      {goal && (
        <section className="summary-card goal-card" aria-label={t("会话目标")}>
          <div className="summary-card-title">
            <span className="goal-heading">
              <Target size={17} />
              {t("目标")}
            </span>
            <div className="goal-actions">
              <button
                disabled={busy}
                aria-label={t("刷新目标状态")}
                title={t("刷新目标状态")}
                onClick={() => void read(true)}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <RefreshCw size={15} />
                )}
              </button>
              <details
                ref={menu}
                className="goal-menu"
                onKeyDown={(event) => {
                  if (event.key === "Escape" && event.currentTarget.open) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.currentTarget.removeAttribute("open");
                    event.currentTarget.querySelector("summary")?.focus();
                  }
                }}
                onBlur={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  )
                    event.currentTarget.removeAttribute("open");
                }}
              >
                <summary aria-label={t("目标操作")}>
                  <Ellipsis size={17} />
                </summary>
                <div>
                  <button
                    disabled={busy}
                    onClick={(e) => {
                      e.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      setObjective(goal.objective);
                      setError("");
                      setEditor("edit");
                    }}
                  >
                    <Pencil size={14} />
                    {t("编辑目标")}
                  </button>
                  <button
                    disabled={busy || goal.status !== "active"}
                    onClick={(e) => {
                      e.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      void update("pause");
                    }}
                  >
                    <Pause size={14} />
                    {t("暂停目标")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={(e) => {
                      e.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      setBudget(goal.tokenBudget?.toString() || "");
                      setError("");
                      setEditor("budget");
                    }}
                  >
                    <Target size={14} />
                    {t("调整目标预算")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={(e) => {
                      e.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      setError("");
                      setEditor("clear");
                    }}
                  >
                    <Trash2 size={14} />
                    {t("清除目标")}
                  </button>
                </div>
              </details>
            </div>
          </div>
          <p className="goal-objective">{goal.objective}</p>
          <div className="goal-state" data-status={goal.status}>
            <span />
            {labels[goal.status] || goal.status}
          </div>
          {percent !== null && (
            <div
              className="goal-meter"
              role="progressbar"
              aria-label={t("目标 Token 预算")}
              aria-valuemin={0}
              aria-valuemax={goal.tokenBudget!}
              aria-valuenow={Math.min(goal.tokensUsed, goal.tokenBudget!)}
            >
              <span style={{ width: `${percent}%` }} />
            </div>
          )}
          <dl className="goal-accounting">
            <div>
              <dt>{t("已用 Token")}</dt>
              <dd>
                {format(goal.tokensUsed)}
                {goal.tokenBudget !== null && (
                  <small> / {format(goal.tokenBudget)}</small>
                )}
              </dd>
            </div>
            <div>
              <dt>{t("执行时间")}</dt>
              <dd>
                {t("{minutes} 分 {seconds} 秒", {
                  minutes: format(Math.floor(goal.timeUsedSeconds / 60)),
                  seconds: format(Math.floor(goal.timeUsedSeconds % 60)),
                })}
              </dd>
            </div>
          </dl>
          {goal.status === "active" && job?.state !== "running" && (
            <p className="goal-note">
              {t("目标仍保留；当前没有运行中的任务。")}
            </p>
          )}
          {goal.status !== "complete" &&
            (goal.status !== "active" || job?.state !== "running") && (
              <div className="goal-lifecycle">
                <button
                  className="goal-start"
                  disabled={
                    busy ||
                    !compatible ||
                    !(idle || job?.state === "running") ||
                    budgetSpent ||
                    !!job?.goalStartRequested
                  }
                  title={
                    budgetSpent
                      ? t("目标预算已用尽，请先增加或取消预算限制")
                      : undefined
                  }
                  onClick={() => void update("start")}
                >
                  {job?.goalStartRequested ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Play size={14} />
                  )}
                  {job?.goalStartRequested ? t("等待开始目标…") : t("继续目标")}
                </button>
                {budgetSpent && (
                  <p className="goal-note">
                    {t("目标预算已用尽，请先增加或取消预算限制")}
                  </p>
                )}
              </div>
            )}
          {error && !editor && (
            <p className="panel-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
      <ModalPresence
        onExitComplete={() => {
          if (cleared.current || !menu.current?.isConnected)
            document
              .querySelector<HTMLElement>(".workbench-tabs button.selected")
              ?.focus({ preventScroll: true });
          else
            menu.current
              .querySelector("summary")
              ?.focus({ preventScroll: true });
          cleared.current = false;
        }}
      >
        {!!editor && (
          <Dialog
            title={editorTitle}
            busy={busy}
            onClose={() => setEditor(null)}
          >
            <h2>{editorTitle}</h2>
            {editor === "clear" ? (
              <p>
                {t(
                  "仅移除会话目标，聊天记录和文件会保留。当前轮次不会被打断。",
                )}
              </p>
            ) : (
              <>
                {editor === "create" || editor === "edit" ? (
                  <>
                    <p>
                      {editor === "create"
                        ? t(
                            "设定清晰的验收结果，让 Codex 持续推进。可以先保存，也可以立即开始。",
                          )
                        : t(
                            "修改目标会保留当前聊天和文件；执行状态由原生目标管理。",
                          )}
                    </p>
                    <label>
                      {t("目标内容")}
                      <textarea
                        aria-label={t("目标内容")}
                        rows={5}
                        maxLength={20000}
                        value={objective}
                        onChange={(e) => setObjective(e.target.value)}
                        placeholder={t("描述期望的最终结果和验收标准…")}
                      />
                    </label>
                  </>
                ) : (
                  <p>
                    {t("调整预算会保留已用 Token 和目标状态，不会重置进度。")}
                  </p>
                )}
                {editor !== "edit" && (
                  <label>
                    {t("目标 Token 预算")}
                    <input
                      aria-label={t("目标 Token 预算")}
                      inputMode="numeric"
                      value={budget}
                      onChange={(e) => setBudget(e.target.value)}
                      placeholder={t("不限制")}
                    />
                  </label>
                )}
              </>
            )}
            {error && (
              <p className="panel-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setEditor(null)}>
                {t("取消")}
              </button>
              {editor === "create" && (
                <button
                  disabled={busy || !objective.trim()}
                  onClick={() => void update("create", false)}
                >
                  {t("仅保存目标")}
                </button>
              )}
              <button
                className="primary"
                disabled={
                  busy ||
                  (["create", "edit"].includes(editor) && !objective.trim())
                }
                onClick={() => void update(editor, editor === "create")}
              >
                {busy
                  ? t("正在保存…")
                  : editor === "clear"
                    ? t("清除目标")
                    : editor === "create"
                      ? t("保存并开始")
                      : t("保存")}
              </button>
            </div>
          </Dialog>
        )}
      </ModalPresence>
    </>
  );
}
