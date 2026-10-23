import React, { useState } from "react";
import type { Settings } from "../../shared/types";
import { Dialog } from "../../renderer/Dialog";
import { t, errorText, useI18n } from "../../renderer/i18n";
export function RuntimeSettings({settings,call,close}:{settings:Settings;call:(name:string,args?:unknown)=>Promise<any>;close:()=>void}) {
  useI18n();
  const [form,setForm]=useState(()=>structuredClone(settings)),[busy,setBusy]=useState(false),[error,setError]=useState(""),[report,setReport]=useState<any>();
  return <Dialog title={t("设置")} busy={busy} onClose={close}><h2>{t("设置")}</h2>
    <form className="runtime-settings" onSubmit={e=>{e.preventDefault();setBusy(true);setError("");void call("settings.save",form).then(close).catch(e=>setError(errorText(e))).finally(()=>setBusy(false));}}>
      <label>Codex CLI<input required value={form.cliPath} onChange={e=>setForm({...form,cliPath:e.target.value})}/></label>
      <label>{t("并发任务上限")}<input type="number" min={1} max={8} required value={form.maxConcurrentTasks||3} onChange={e=>setForm({...form,maxConcurrentTasks:Number(e.target.value)})}/></label>
      <label>{t("额度核实间隔 / 秒")}<input type="number" min={10} max={300} required value={form.pollSeconds} onChange={e=>setForm({...form,pollSeconds:Number(e.target.value)})}/></label>
      <label>{t("未知重置时间的重试间隔 / 秒")}<input type="number" min={30} max={3600} required value={form.retrySeconds} onChange={e=>setForm({...form,retrySeconds:Number(e.target.value)})}/></label>
      <label>{t("中断后继续执行的提示")}<textarea required maxLength={10000} value={form.resumePrompt} onChange={e=>setForm({...form,resumePrompt:e.target.value})}/></label>
      <p>{t("暂停任务后再修改运行设置")}</p>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy}>{t("保存设置")}</button>
      <button type="button" disabled={busy} onClick={()=>{setBusy(true);void call("health").then(setReport).catch(e=>setError(errorText(e))).finally(()=>setBusy(false));}}>{t("详情")}</button>
      {report && <pre>{JSON.stringify(report,null,2)}</pre>}
    </form>
  </Dialog>;
}
