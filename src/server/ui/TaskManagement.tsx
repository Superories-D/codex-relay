import React from "react";
import type {Job} from "../../shared/types";
import {taskControlSignature} from "../../shared/task-control";
import {MessageQueue} from "../../renderer/MessageQueue";
import {RecoveryNotice} from "../../renderer/RecoveryNotice";
import {t} from "../../renderer/i18n";
import {ActionStatus,useRemoteAction} from "./LiveControls";

export function TaskManagement({job,call,busy}:{job:Job;call:(name:string,args?:any)=>Promise<any>;busy:boolean}) {
  const operation=useRemoteAction(job.id,call,"management"),pending=busy||!!operation.pending;
  const control=(action:"pause"|"resume"|"cancel")=>operation.submit("task.control",{id:job.id,action,expected:taskControlSignature(job)});
  return <section className="remote-task-management">
    <ActionStatus action={operation}/>
    <div className="row">
      {["paused","needs_attention"].includes(job.state)
        ?<button disabled={pending} onClick={()=>control("resume")}>{t("继续")}</button>
        :!["completed","cancelled"].includes(job.state)&&<button disabled={pending} onClick={()=>control("pause")}>{t("暂停")}</button>}
      {!["completed","cancelled"].includes(job.state)&&<button disabled={pending} onClick={()=>control("cancel")}>{t("取消任务")}</button>}
    </div>
    <RecoveryNotice job={job} onPause={()=>{control("pause");}} pending={pending}/>
    <MessageQueue job={job} pending={pending} onChange={input=>{operation.submit("task.queue",{input});}}/>
  </section>;
}
