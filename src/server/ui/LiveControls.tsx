import {actionRecovery,supportsActionRecovery,type PendingAction} from "./action-recovery";
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
  const recovery=actionRecovery();
  const [pending,setPending]=useState<PendingAction|null>(()=>recovery.read(key));
  const pendingRef=useRef(pending);pendingRef.current=pending;
  const callRef=useRef(call);callRef.current=call;
  const [receipt,setReceipt]=useState<any>(()=>recovery.read(key)?undefined:recovery.latest(key)?.receipt),[error,setError]=useState(()=>{const error=recovery.read(key)?undefined:recovery.latest(key)?.error;return error?errorText(error):"";});
  useEffect(()=>recovery.subscribe(update=>{
    if(update.key!==key||!pendingRef.current||JSON.stringify(update.record)!==JSON.stringify(pendingRef.current))return;
    setError(update.outcome.error?errorText(update.outcome.error):"");
    if(update.outcome.settled){setReceipt(update.outcome.receipt);pendingRef.current=null;setPending(null);}
  }),[key]);
  useEffect(()=>{
    if(!pending)return;
    let alive=true,timer:ReturnType<typeof setTimeout>;
    const send=async()=>{
      const outcome=await recovery.attempt(key,(name,args)=>callRef.current(name,args));
      if(!alive)return;
      // Background recovery may finish between initial state and subscription.
      if(outcome&&pendingRef.current&&JSON.stringify(pendingRef.current)===JSON.stringify(pending)) {
        setError(outcome.error?errorText(outcome.error):"");
        if(outcome.settled){setReceipt(outcome.receipt);pendingRef.current=null;setPending(null);}
      }
      if(!outcome?.settled)timer=setTimeout(()=>void send(),5000);
    };
    void send();return()=>{alive=false;clearTimeout(timer);};
  },[pending,key]);
  function submit(name: string, args: any) {
    if (pendingRef.current||recovery.read(key)) return false;
    try {
      if(!supportsActionRecovery(name))throw Error("Unsupported durable operation");
      const value = {
        name,
        args: { ...args, requestId: crypto.randomUUID() },
      };
      sessionStorage.setItem(key, JSON.stringify(value));
      setReceipt(undefined);
      pendingRef.current=value;setPending(value);
      setError("");
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
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
