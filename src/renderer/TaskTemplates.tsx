import React, { useEffect, useState } from "react";
import type { TaskTemplate, TemplateState } from "../core/templates";
import { Dialog } from "./Dialog";
import { t, useI18n, errorText } from "./i18n";
export function TaskTemplates({
  draft,
  preferences,
  call,
  apply,
  close,
}: {
  draft: string;
  preferences: Pick<
    TaskTemplate,
    "model" | "effort" | "planMode" | "multiAgent"
  >;
  call: (name: string, args?: unknown) => Promise<any>;
  apply: (template: TaskTemplate) => void;
  close: () => void;
}) {
  useI18n();
  const [state, setState] = useState<TemplateState>();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState(draft);
  const [editing, setEditing] = useState<TaskTemplate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void call("templates.list")
      .then((value) => {
        if (alive) setState(value);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  const mutate = async (method: string, args: unknown) => {
    setBusy(true);
    setError("");
    try {
      setState(await call(method, args));
      setEditing(undefined);
      setName("");
      setPrompt("");
    } catch (e) {
      setError(errorText(e));
      try {
        setState(await call("templates.list"));
      } catch {}
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("任务模板")} onClose={close} busy={busy}>
      <div className="task-templates">
        <p>{t("模板只插入草稿，由你确认后发送。")}</p>
        {error && <p role="alert">{error}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!state) return;
            const prefs = editing || preferences;
            void mutate("templates.save", {
              revision: state.revision,
              ...(editing ? { id: editing.id } : {}),
              template: {
                name,
                prompt,
                model: prefs.model,
                effort: prefs.effort,
                planMode: prefs.planMode,
                multiAgent: prefs.multiAgent,
              },
            });
          }}
        >
          <label>
            {t("模板名称")}
            <input
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            {t("任务指令")}
            <textarea
              value={prompt}
              maxLength={100000}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <button
            disabled={busy || !state || !name.trim() || !prompt.trim()}
            type="submit"
          >
            {editing ? t("保存修改") : t("保存为模板")}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(undefined);
                setName("");
                setPrompt(draft);
              }}
            >
              {t("取消编辑")}
            </button>
          )}
        </form>
        <div className="template-list">
          {state?.items.map((template) => (
            <article key={template.id}>
              <strong>{template.name}</strong>
              <p>{template.prompt}</p>
              <small>
                {template.model || t("默认模型")}
                {template.planMode ? ` · ${t("规划模式")}` : ""}
              </small>
              <div className="queue-actions">
                <button
                  disabled={busy}
                  onClick={() => {
                    apply(template);
                    close();
                  }}
                >
                  {t("插入草稿")}
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setEditing(template);
                    setName(template.name);
                    setPrompt(template.prompt);
                  }}
                >
                  {t("编辑")}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void mutate("templates.remove", {
                      id: template.id,
                      revision: state.revision,
                    })
                  }
                >
                  {t("删除")}
                </button>
              </div>
            </article>
          ))}
        </div>
        {state && !state.items.length && (
          <p>{t("还没有模板，可以把当前草稿保存为第一个模板。")}</p>
        )}
      </div>
    </Dialog>
  );
}
