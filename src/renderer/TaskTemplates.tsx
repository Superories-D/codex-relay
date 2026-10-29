import React, { useEffect, useState } from "react";
import type { TaskTemplate, TemplateState } from "../core/templates";
import { Dialog } from "./Dialog";
import { t, useI18n, errorText } from "./i18n";
import {DeliveryDialog} from "./DeliveryDialog";
import type {DeliveryCheck} from "../shared/delivery";
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
    "model" | "effort" | "planMode" | "multiAgent" | "deliveryChecks"
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
  const [checks,setChecks]=useState<DeliveryCheck[]>(()=>structuredClone(preferences.deliveryChecks||[]));
  const [editingChecks,setEditingChecks]=useState(false);
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
      setChecks(structuredClone(preferences.deliveryChecks||[]));
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
        <p>{t("模板中的验收条件只用于新任务，已有任务的条件保持不变。")}</p>
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
                deliveryChecks: checks,
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
          <button type="button" disabled={busy} onClick={()=>setEditingChecks(true)}>{t("交付验收")} · {checks.length}</button>
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
                setChecks(structuredClone(preferences.deliveryChecks||[]));
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
                {` · ${t("交付验收")} ${template.deliveryChecks?.length||0}`}
              </small>
              <div className="queue-actions">
                <button
                  disabled={busy}
                  onClick={() => {
                    try {apply(template);close();}
                    catch(e) {setError(errorText(e));}
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
                    setChecks(structuredClone(template.deliveryChecks||[]));
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
        {editingChecks&&<DeliveryDialog purpose="plan" initial={checks} call={call} saveDraft={setChecks} close={()=>setEditingChecks(false)}/>}
      </div>
    </Dialog>
  );
}
