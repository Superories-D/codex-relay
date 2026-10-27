import React,{useEffect,useState} from "react";
import type {ScheduledTask,ScheduleRunInput} from "../core/desktop";
import {Dialog} from "./Dialog";
import {t,formatDate} from "./i18n";
import "./schedule-pending.css";

type View={id:string;requestedAt:number;input:ScheduleRunInput;legacy:boolean};
export function SchedulePending({task,busy,abandon}:{task:ScheduledTask;busy:boolean;abandon:(runId:string)=>void}) {
  const run=task.pendingRun,[view,setView]=useState<View>(),[confirm,setConfirm]=useState(false);
  useEffect(()=>{setView(undefined);setConfirm(false);},[run?.id]);
  if(!run)return null;
  return <div className="schedule-pending">
    <button type="button" onClick={()=>{
      const input=run.input||task;
      setView({id:run.id,requestedAt:run.requestedAt,legacy:!run.input,input:structuredClone({title:input.title,prompt:input.prompt,cwd:input.cwd,worktree:input.worktree,deliveryChecks:input.deliveryChecks})});setConfirm(false);
    }}>{t("查看待创建运行")} · {run.id.slice(0,8)}</button>
    {view&&<Dialog title={t("待创建运行")} onClose={()=>setView(undefined)}>
      <div className="schedule-pending-view">
        <h2>{t("待创建运行")}</h2><code>{view.id}</code><p>{formatDate(view.requestedAt)}</p>
        {view.legacy&&<p>{t("旧记录尚无运行快照，恢复时使用当前计划。")}</p>}
        <strong>{view.input.title}</strong><p>{view.input.cwd}</p><pre>{view.input.prompt}</pre>
        {!!view.input.deliveryChecks?.length&&<details><summary>{t("验收条件")} · {view.input.deliveryChecks.length}</summary><pre>{JSON.stringify(view.input.deliveryChecks,null,2)}</pre></details>}
        <p>{t("保留已有文件；已创建任务只恢复记录，不会停止。计划仍按配置继续运行。")}</p>
        {!confirm?<button type="button" disabled={busy} onClick={()=>setConfirm(true)}>{t("放弃待创建运行")}</button>:<div>
          <p>{t("确认放弃这一次尚未创建的运行？")}</p>
          <button type="button" disabled={busy} onClick={()=>{abandon(view.id);setView(undefined);setConfirm(false);}}>{t("确认放弃")}</button>
          <button type="button" onClick={()=>setConfirm(false)}>{t("取消")}</button>
        </div>}
      </div>
    </Dialog>}
  </div>;
}
