import React, {useState} from "react";
import type {Job} from "../../shared/types";
import type {DeliveryCheck} from "../../shared/delivery";
import {DeliveryDialog, DeliveryEvidence} from "../../renderer/DeliveryDialog";
import {t, errorText} from "../../renderer/i18n";
import {ActionStatus, useRemoteAction} from "./LiveControls";

export function RemoteDelivery({job,call,repair}: {
  job:Job;
  call:(name:string,args?:any)=>Promise<any>;
  repair:(text:string)=>void;
}) {
  const action=useRemoteAction(job.id,call,"delivery");
  const [editing,setEditing]=useState<{revision:number;checks:DeliveryCheck[]}>();
  const [error,setError]=useState(""),[preparing,setPreparing]=useState(false);
  const state=job.delivery || {revision:0,checks:[],reports:[]};
  const latest=state.reports.at(-1);
  const current=latest?.revision===state.revision && state.staleEvidence?.reportId!==latest?.id;
  const blocked=!!job.recoveryRequired || ["preparing","running","pausing","rotating","watching"].includes(job.state);
  const label=state.pendingCompletion ? "正在验收交付产物" : state.staleEvidence?.reportId===latest?.id && latest ? "交付证据已失效" : current && latest ? {passed:"验收通过",failed:"验收未通过",unverified:"暂无法验证"}[latest.status] : "等待交付验收";
  async function prepareRepair() {
    setPreparing(true);setError("");
    try { repair(await call("delivery.repair",job.id)); }
    catch(e) {setError(errorText(e));}
    finally {setPreparing(false);}
  }
  return <details className="remote-delivery">
    <summary>{t("交付验收")} · {state.checks.length}{state.checks.length ? ` · ${t(label)}` : ""}</summary>
    <ActionStatus action={action}/>
    {error && <p role="alert">{error}</p>}
    {blocked && <p>{t("请先暂停任务，再修改或运行验收。")}</p>}
    {state.staleEvidence && <p>{t("产物已变化或当前证据无法确认。历史通过记录保留，请重新验收后继续。")}</p>}
    <fieldset disabled={!!action.pending || blocked || preparing}>
      <legend>{t("验收条件")}</legend>
      {!state.checks.length && <p>{t("尚未设置验收条件")}</p>}
      {state.checks.map((check,i)=><p key={i}><strong>{check.label}</strong> · <code>{check.path}</code></p>)}
      <div className="delivery-actions">
        <button type="button" onClick={()=>setEditing({revision:state.revision,checks:structuredClone(state.checks)})}>{t("编辑验收条件")}</button>
        <button type="button" disabled={!state.checks.length} onClick={()=>action.submit("delivery.run",{id:job.id,revision:state.revision,reportId:latest?.id})}>{t("重新验收")}</button>
        <button type="button" disabled={!current || !latest || latest.status==="passed"} onClick={()=>void prepareRepair()}>{t("将修正要求加入草稿")}</button>
      </div>
    </fieldset>
    <DeliveryEvidence state={state}/>
    {editing && <DeliveryDialog initial={editing.checks} purpose="existing" call={call} saveDraft={checks=>{
      if(!action.submit("delivery.save",{id:job.id,revision:editing.revision,checks})) throw Error(t("操作请求未能保存，请保留条件并重试。"));
    }} close={()=>setEditing(undefined)}/>}
  </details>;
}
