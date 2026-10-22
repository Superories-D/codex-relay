import React, { useState } from "react";
import type { Approval } from "../../shared/types";
import { questionList } from "../../shared/user-questions";
import { t, errorText } from "../../renderer/i18n";
export function RemoteApproval({
  approval: a,
  call,
}: {
  approval: Approval;
  call: (name: string, args?: unknown) => Promise<any>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({}),
    [json, setJson] = useState("{}");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function respond(value: unknown) {
    setBusy(true);
    setError("");
    try {
      await call("approval.respond", {
        id: a.id,
        jobId: a.jobId,
        historyId: a.historyId,
        value,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="remote-approval">
      <h3>{t("需要处理")}</h3>
      <pre>{JSON.stringify(a.params, null, 2)}</pre>
      {a.kind === "input" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void respond({
              answers: Object.fromEntries(
                questionList(a.params).map((q) => [
                  q.id,
                  { answers: [answers[q.id] || ""] },
                ]),
              ),
            });
          }}
        >
          {questionList(a.params).map((q) => (
            <label key={q.id}>
              {q.question}
              {q.options?.length && !q.isOther ? (
                <select
                  required
                  disabled={busy || a.responsePending}
                  value={answers[q.id] || ""}
                  onChange={(e) =>
                    setAnswers((old) => ({ ...old, [q.id]: e.target.value }))
                  }
                >
                  <option value="">—</option>
                  {q.options.map((o) => (
                    <option key={o.label} value={o.label}>
                      {o.label} · {o.description}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    required
                    type={q.isSecret ? "password" : "text"}
                    maxLength={10000}
                    disabled={busy || a.responsePending}
                    value={answers[q.id] || ""}
                    onChange={(e) =>
                      setAnswers((old) => ({ ...old, [q.id]: e.target.value }))
                    }
                  />
                  {q.options?.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      disabled={busy || a.responsePending}
                      onClick={() =>
                        setAnswers((old) => ({ ...old, [q.id]: o.label }))
                      }
                    >
                      {o.label}
                    </button>
                  ))}
                </>
              )}
            </label>
          ))}
          <button
            disabled={
              busy || a.responsePending || !questionList(a.params).length
            }
          >
            {t("提交回答")}
          </button>
        </form>
      ) : a.kind === "elicitation" ? (
        <>
          <textarea
            aria-label="JSON"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            disabled={busy}
          />
          <div className="row">
            <button
              disabled={busy}
              onClick={() => {
                try {
                  void respond({
                    action: "accept",
                    content: JSON.parse(json),
                    _meta: null,
                  });
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              {t("提交回答")}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void respond({ action: "decline", content: null, _meta: null })
              }
            >
              {t("拒绝")}
            </button>
          </div>
        </>
      ) : (
        <div className="row">
          <button
            disabled={busy}
            onClick={() => void respond({ decision: "accept" })}
          >
            {t("仅允许本轮")}
          </button>
          <button
            disabled={busy}
            onClick={() => void respond({ decision: "decline" })}
          >
            {t("拒绝")}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
