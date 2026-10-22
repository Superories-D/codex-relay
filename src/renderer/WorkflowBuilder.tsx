import React, { useState } from "react";
import type { Job } from "../shared/types";
import { Dialog } from "./Dialog";
import { t, errorText, useI18n } from "./i18n";
export function WorkflowBuilder({jobs,cwd,call,close}:{jobs:Job[];cwd:string;call:(name:string,args?:unknown)=>Promise<any>;close:()=>void}) {
  useI18n();
  const [requestId] = useState(() => crypto.randomUUID());
  const [title,setTitle] = useState("");
  const [directory,setDirectory] = useState(cwd || jobs[0]?.projectCwd || jobs[0]?.cwd || "");
  const [model,setModel] = useState(jobs[0]?.model || "");
  const [steps,setSteps] = useState([{id:crypto.randomUUID(),text:""},{id:crypto.randomUUID(),text:""}]);
  const [busy,setBusy] = useState(false),[error,setError] = useState("");
  async function save() {
    setBusy(true); setError("");
    try {
      await call("workflow.add",{requestId,title,steps:steps.map((step,index) => ({title:`${title} · ${index+1}`.slice(0,120),prompt:step.text,cwd:directory,mode:"cli",model,effort:"",bucket:"codex",approvalPolicy:"on-request",sandbox:"workspaceWrite",interactive:true}))});
      close();
    } catch(e) {setError(errorText(e));} finally {setBusy(false);}
  }
  return <Dialog title={t("新建工作流")} onClose={close} busy={busy}>
    <form className="workflow-builder" onSubmit={e => {e.preventDefault();void save();}}>
      <h2>{t("新建工作流")}</h2><p>{t("各阶段使用独立会话并按顺序执行。通过工作目录中的文件交接成果，请在指令中写清交付路径。")}</p>
      <label>{t("工作流名称")}<input required maxLength={120} value={title} disabled={busy} onChange={e=>setTitle(e.target.value)}/></label>
      <label>{t("工作目录")}<input required value={directory} disabled={busy} onChange={e=>setDirectory(e.target.value)}/></label>
      <label>{t("模型")}<input maxLength={200} value={model} disabled={busy} onChange={e=>setModel(e.target.value)}/></label>
      <p>{t("权限：工作区写入，按需审批。创建后仍受调度暂停和前置任务约束。")}</p>
      <div className="workflow-steps">{steps.map((step,index)=><article key={step.id}>
        <label>{t("阶段 {index}",{index:index+1})}<textarea required maxLength={100000} disabled={busy} value={step.text} onChange={e=>setSteps(old=>old.map(s=>s.id===step.id?{...s,text:e.target.value}:s))}/></label>
        <div className="queue-actions"><button type="button" disabled={busy||index===0} onClick={()=>setSteps(old=>{const next=[...old];[next[index-1],next[index]]=[next[index],next[index-1]];return next;})}>{t("上移")}</button><button type="button" disabled={busy||steps.length<=2} onClick={()=>setSteps(old=>old.filter(s=>s.id!==step.id))}>{t("移除")}</button></div>
      </article>)}</div>
      {error&&<p role="alert">{error}</p>}
      <div className="queue-actions"><button type="button" disabled={busy||steps.length>=12} onClick={()=>setSteps(old=>[...old,{id:crypto.randomUUID(),text:""}])}>{t("添加阶段")}</button><button type="submit" disabled={busy}>{t("创建并排队")} ({steps.length}/12)</button></div>
    </form>
  </Dialog>;
}
