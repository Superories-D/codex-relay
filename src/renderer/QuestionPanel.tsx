import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  MessageCircleQuestion,
} from "lucide-react";
import type {
  Approval,
  Job,
  QuestionRecord,
  UserQuestion,
} from "../shared/types";
import {
  questionList,
  validateQuestionAnswers,
} from "../shared/user-questions";
import { t, useI18n, errorText, formatDate } from "./i18n";
import { MarkdownText } from "./RichMessage";

type Draft = Record<
  string,
  { choice?: number | "custom"; text?: string; note?: string }
>;
// Memory only: navigating between tabs keeps drafts, including password fields.
// Resolved requests are pruned; nothing is written to browser storage.
const drafts = new Map<string, Draft>();
const draftKey = (a: Approval) => `${a.jobId}:${a.historyId || a.id}`;
export function pruneQuestionDrafts(
  jobId: string | undefined,
  live: Approval[],
) {
  const keep = new Set(live.map(draftKey));
  for (const key of drafts.keys())
    if ((!jobId || key.startsWith(`${jobId}:`)) && !keep.has(key))
      drafts.delete(key);
}

function answerValue(q: UserQuestion, value?: Draft[string]) {
  const first =
    q.options?.length && typeof value?.choice === "number"
      ? q.options[value.choice]?.label || ""
      : value?.text?.trim() || "";
  return {
    answers: [first, ...(value?.note?.trim() ? [value.note.trim()] : [])],
  };
}
export function QuestionRequest({
  approval: a,
  source,
}: {
  approval: Approval;
  source?: string;
}) {
  useI18n();
  const questions = questionList(a.params),
    key = draftKey(a);
  const [values, setValues] = useState<Draft>(() => drafts.get(key) || {});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const change = (id: string, patch: Draft[string]) =>
    setValues((previous) => {
      const next = { ...previous, [id]: { ...previous[id], ...patch } };
      drafts.set(key, next);
      while (drafts.size > 40) drafts.delete(drafts.keys().next().value!);
      return next;
    });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lock.current || a.responsePending) return;
    const value = {
      answers: Object.fromEntries(
        questions.map((q) => [q.id, answerValue(q, values[q.id])]),
      ),
    };
    try {
      validateQuestionAnswers(a.params, value);
    } catch (e) {
      setError(errorText(e));
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await window.relay.command("approval.respond", {
        id: a.id,
        jobId: a.jobId,
        historyId: a.historyId,
        value,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      className="question-request"
      onSubmit={(e) => void submit(e)}
      aria-label={t("回答 Codex 的问题")}
    >
      <header>
        <MessageCircleQuestion size={18} />
        <strong>{source || "Codex"}</strong>
        <span>
          {(a.params as any)?.isBlocking === false
            ? t("可稍后回答")
            : t("等待你的回答")}
        </span>
      </header>
      {!questions.length ? (
        <p className="panel-error">
          {t("当前问题格式不受支持，请停止本轮后检查")}
        </p>
      ) : (
        questions.map((q, index) => (
          <fieldset key={q.id} disabled={busy || a.responsePending}>
            <legend>
              <small>
                {index + 1} / {questions.length}
              </small>
              {q.header}
            </legend>
            <div className="question-prompt">
              <MarkdownText text={q.question} />
            </div>
            {q.options?.map((option, choice) => (
              <label
                className={`question-option ${values[q.id]?.choice === choice ? "selected" : ""}`}
                key={option.label}
              >
                <input
                  type="radio"
                  name={`${key}:${q.id}`}
                  value={choice}
                  checked={values[q.id]?.choice === choice}
                  onChange={() => change(q.id, { choice })}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                {values[q.id]?.choice === choice && <Check size={15} />}
              </label>
            ))}
            {!!q.options?.length && q.isOther && (
              <label
                className={`question-option ${values[q.id]?.choice === "custom" ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name={`${key}:${q.id}`}
                  checked={values[q.id]?.choice === "custom"}
                  onChange={() => change(q.id, { choice: "custom" })}
                />
                <span>
                  <strong>{t("自定义回答")}</strong>
                </span>
              </label>
            )}
            {(!q.options?.length || values[q.id]?.choice === "custom") && (
              <label className="question-free-text">
                <span>{q.isSecret ? t("私密回答") : t("你的回答")}</span>
                {q.isSecret ? (
                  <input
                    type="password"
                    autoComplete="off"
                    maxLength={10000}
                    value={values[q.id]?.text || ""}
                    onChange={(e) => change(q.id, { text: e.target.value })}
                  />
                ) : (
                  <textarea
                    rows={3}
                    maxLength={10000}
                    value={values[q.id]?.text || ""}
                    onChange={(e) => change(q.id, { text: e.target.value })}
                  />
                )}
              </label>
            )}
            {!q.isSecret && !!q.options?.length && (
              <details className="question-note">
                <summary>{t("补充说明（可选）")}</summary>
                <textarea
                  aria-label={t("给 {p0} 补充说明", { p0: q.header })}
                  rows={2}
                  maxLength={10000}
                  value={values[q.id]?.note || ""}
                  onChange={(e) => change(q.id, { note: e.target.value })}
                />
              </details>
            )}
          </fieldset>
        ))
      )}
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      {a.responsePending ? (
        <p className="question-submitting" role="status">
          <LoaderCircle className="spin" size={15} />
          {t("回答已发送，正在等待服务器确认")}
        </p>
      ) : (
        <button
          className="question-submit"
          disabled={busy || !questions.length}
          type="submit"
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <CheckCircle2 size={15} />
          )}
          {t("提交回答")}
        </button>
      )}
    </form>
  );
}

export function QuestionPanel({
  job,
  requests,
}: {
  job?: Job;
  requests: Approval[];
}) {
  useI18n();
  const [items, setItems] = useState<QuestionRecord[]>([]),
    [before, setBefore] = useState<number>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const owner = useRef(job?.id),
    initialized = useRef(false),
    generation = useRef(0);
  owner.current = job?.id;
  const signature = requests
    .map((a) => `${a.historyId}:${a.responsePending}`)
    .join("|");
  const load = async (older = false) => {
    const id = job?.id;
    if (!id) return;
    const currentGeneration = ++generation.current;
    setBusy(true);
    try {
      const page = (await window.relay.command("chat.questions.read", {
        id,
        ...(older ? { before } : {}),
      })) as { items: QuestionRecord[]; before?: number };
      if (owner.current !== id || generation.current !== currentGeneration)
        return;
      setItems((previous) =>
        [
          ...new Map(
            [...previous, ...page.items].map((a) => [a.id, a]),
          ).values(),
        ].sort((a, b) => b.at - a.at),
      );
      if (older || !initialized.current) setBefore(page.before);
      initialized.current = true;
      setError("");
    } catch (e) {
      if (owner.current === id && generation.current === currentGeneration)
        setError(errorText(e));
    } finally {
      if (owner.current === id && generation.current === currentGeneration)
        setBusy(false);
    }
  };
  useEffect(() => {
    setItems([]);
    setBefore(undefined);
    initialized.current = false;
    void load();
  }, [job?.id]);
  useEffect(() => {
    void load();
  }, [signature]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = window.relay.onChat?.((update) => {
      if (update.id === job?.id) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 200);
      }
    });
    return () => {
      clearTimeout(timer);
      off?.();
    };
  }, [job?.id]);
  const active = new Set(requests.map((a) => a.historyId));
  const history = items.filter((item) => !active.has(item.id));
  const states = {
    answered: t("已回答"),
    expired: t("问题已失效"),
    pending: t("问题已失效"),
    unconfirmed: t("回答尚未确认"),
  };
  return (
    <div className="questions-pane">
      {requests.map((a) => (
        <QuestionRequest
          key={a.historyId || a.id}
          approval={a}
          source={
            job?.agents?.find(
              (agent) => agent.threadId === (a.params as any)?.threadId,
            )?.name
          }
        />
      ))}
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      {!requests.length && !history.length && (
        <div className="panel-empty">
          <MessageCircleQuestion size={30} strokeWidth={1} />
          <p>{t("暂时没有问题")}</p>
          <small>{t("Codex 需要你做决定时，问题和回答会显示在这里。")}</small>
        </div>
      )}
      {!!history.length && (
        <div className="question-history">
          <h3>{t("问题记录")}</h3>
          {history.map((item) => (
            <details key={item.id} className="question-history-item">
              <summary>
                {item.status === "answered" ? (
                  <CheckCircle2 size={15} />
                ) : (
                  <Clock3 size={15} />
                )}
                <span>{item.questions[0]?.header || t("问题")}</span>
                <small>{states[item.status]}</small>
              </summary>
              <time>{formatDate(item.at)}</time>
              {item.status !== "answered" && (
                <p className="question-expired-note">
                  {t(
                    "这个请求已结束，不能继续提交。需要时可在聊天中重新询问 Codex。",
                  )}
                </p>
              )}
              {item.questions.map((q) => (
                <div className="question-history-answer" key={q.id}>
                  <MarkdownText text={q.question} />
                  <strong>{t("回答")}</strong>
                  <p>
                    {item.status === "answered"
                      ? q.isSecret
                        ? t("回答已隐藏")
                        : item.answers?.[q.id]?.answers.join("\n\n") || "—"
                      : "—"}
                  </p>
                </div>
              ))}
            </details>
          ))}
        </div>
      )}
      {before !== undefined && (
        <button
          className="question-load-more"
          disabled={busy}
          onClick={() => void load(true)}
        >
          {t("加载更早的问题")}
        </button>
      )}
    </div>
  );
}
