import { CommandError } from "./client";
import React, { useEffect, useState, useRef } from "react";
import { t, errorText } from "../../renderer/i18n";
import type { Job } from "../../shared/types";
// Keep the exact payload until an acknowledgment arrives, including on reload.
export function useRemoteAction(
  id: string,
  call: (name: string, args?: any) => Promise<any>,
  scope = "live",
) {
  const key =
    scope === "live"
      ? `relay.remote.action.${id}`
      : `relay.remote.action.${scope}.${id}`;
  const [pending, setPending] = useState<any>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  });
  const callRef=useRef(call);callRef.current=call;
  const [receipt, setReceipt] = useState<any>(),
    [error, setError] = useState("");
  useEffect(() => {
    if (!pending) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const send = async () => {
      try {
        const r = await callRef.current(pending.name, pending.args);
        if (!alive) return;
        sessionStorage.removeItem(key);
        setReceipt(r);
        setPending(null);
        setError("");
      } catch (e) {
        if (alive) {
          setError(errorText(e));
          if (e instanceof CommandError && e.status >= 400 && e.status < 500 && ![401,403,429].includes(e.status)) {
            // A gateway may report a persistence failure after the native effect.
            // Check the durable intent before treating an HTTP error as rejection.
            try {
              const recorded=await callRef.current("action.read",pending.args.requestId);
              if(!alive)return;
              if(recorded)setReceipt(recorded);
              sessionStorage.removeItem(key);setPending(null);
            } catch { if(alive)timer=setTimeout(()=>void send(),5000); }
          } else timer = setTimeout(() => void send(), 5000);
        }
      }
    };
    void send();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pending, id]);
  function submit(name: string, args: any) {
    if (pending) return;
    try {
      const value = {
        name,
        args: { ...args, requestId: crypto.randomUUID() },
      };
      sessionStorage.setItem(key, JSON.stringify(value));
      setReceipt(undefined);
      setPending(value);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  return { submit, pending, receipt, error };
}
export function ActionStatus({
  action,
}: {
  action: ReturnType<typeof useRemoteAction>;
}) {
  return (
    <>
      {action.pending && (
        <p role="status">{t("正在确认操作回执，断线后自动恢复。")}</p>
      )}
      {action.error && <p role="alert">{action.error}</p>}
      {action.receipt?.error && <p role="alert">{errorText(action.receipt.error)}</p>}
      {action.receipt && (
        <p role="status">
          {action.receipt.state === "succeeded"
            ? t("操作已确认")
            : t("操作结果未知，请检查任务状态；不会自动重复执行。")}{" "}
          {action.receipt.result?.applied === false &&
            t("任务状态已变化，操作未应用。")}
        </p>
      )}
    </>
  );
}
export function LiveControls({
  job,
  call,
}: {
  job: Job;
  call: (name: string, args?: any) => Promise<any>;
}) {
  const action = useRemoteAction(job.id, call),
    [text, setText] = useState(""),
    [model, setModel] = useState(job.model),
    [effort, setEffort] = useState(job.effort),
    [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void call("models.list")
      .then((rows) => {
        if (alive)
          setModels([...new Set<string>(rows.flatMap((r: any) => r.ids))]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [job.id]);
  return (
    <section>
      <ActionStatus action={action} />
      {job.state === "running" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.submit("task.steer", { id:job.id,text });
          }}
        >
          <label>
            {t("立即补充当前执行")}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={100000}
              required
            />
          </label>
          <button disabled={!!action.pending}>{t("立即补充")}</button>
        </form>
      )}
      {job.waitingFor === "model" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.submit("task.model", { id:job.id,model, effort });
          }}
        >
          <label>
            {t("切换模型并恢复")}
            <input
              list="remote-models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
              maxLength={200}
            />
          </label>
          <datalist id="remote-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <label>
            {t("推理强度")}
            <input
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
              maxLength={20}
              pattern="(?:[a-z][a-z0-9_-]*)?"
            />
          </label>
          <button disabled={!!action.pending}>{t("切换模型并恢复")}</button>
          <p>{t("候选模型来自已缓存的账号能力，实际可用性以执行结果为准。")}</p>
        </form>
      )}
    </section>
  );
}
