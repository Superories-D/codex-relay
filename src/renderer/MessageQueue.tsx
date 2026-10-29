import React, { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, Pencil, Trash2 } from "lucide-react";
import type { Job } from "../shared/types";
import { t, useI18n, errorText } from "./i18n";
import { CopyButton } from "./CopyButton";
import { discardQueueEdit, queueEditKey, queueEditStatus, readQueueEdits, setQueueEdit, type QueueEdits, validQueueEdits } from "./queue-edits";
import "./queue-workspace.css";

type QueueChange = {id:string;messageId:string;revision:number;action:"edit"|"remove"|"up"|"down";text?:string};
export function MessageQueue({job,pending,onChange}:{job:Job;pending:boolean;onChange:(args:QueueChange)=>Promise<unknown>|void}) {
  useI18n();
  const [editing,setEditing]=useState<string>();
  const [storageBlocked,setStorageBlocked]=useState(()=>{try{return !validQueueEdits(localStorage.getItem(queueEditKey(job.id)));}catch{return true;}});
  const [backupRaw]=useState(()=>{try{return localStorage.getItem(queueEditKey(job.id))||'';}catch{return '';}});
  const [edits,setEdits]=useState<QueueEdits>(()=>{try{return readQueueEdits(localStorage.getItem(queueEditKey(job.id)));}catch{return {};}});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [remove,setRemove]=useState<{id:string;revision:number}>();
  const latest=useRef(edits);latest.current=edits;
  const messages=job.queuedMessages || [];
  useEffect(()=>{
    const persist=()=>{if(storageBlocked)return;try{localStorage.setItem(queueEditKey(job.id),JSON.stringify(latest.current));}catch{setNotice(t("队列编辑草稿无法保存，请先复制内容。"));}};
    persist();window.addEventListener('pagehide',persist);return()=>{persist();window.removeEventListener('pagehide',persist);};
  },[job.id,edits,storageBlocked]);
  const orphaned=Object.entries(edits).filter(([id,edit])=>!messages.some(message=>message.id===id)&&edit.text.trim());
  async function change(action:QueueChange['action'],id:string,revision=job.queueRevision || 0,text?:string){
    if(busy||pending)return;
    setBusy(true);setError('');setNotice('');
    try {
      await onChange({id:job.id,messageId:id,revision,action,text});
      if(action==='edit'){setEdits(old=>discardQueueEdit(old,id));setEditing(undefined);setNotice(t("排队消息已保存"));}
      if(action==='remove')setRemove(undefined);
    }catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  if(!messages.length&&!orphaned.length&&!storageBlocked)return null;
  return <details className="message-queue queue-workspace" open><summary>{t("待发送队列")} · {messages.length}<ChevronDown size={14}/></summary>
    <p className="queue-explanation">{t("按顺序在当前轮次结束后发送；编辑不会重新发送已投递的消息。")}</p>
    {error&&<p role="alert" className="queue-feedback">{error}</p>}{notice&&<p role="status" className="queue-feedback">{notice}</p>}
    {storageBlocked&&<section className="queue-conflict" role="alert"><p>{t("本地队列编辑无法读取，原始内容仍保留。复制后可明确重置。")}</p><CopyButton text={backupRaw} label={t("复制队列编辑备份")}/><button onClick={()=>{setEdits({});setStorageBlocked(false);}}>{t("明确重置队列编辑")}</button></section>}
    <ol>{messages.map((message,index)=>{
      const id=message.id,edit=id?edits[id]:undefined,status=edit?queueEditStatus(edit,message.text):undefined;
      return <li key={id||index} data-queue-id={id}><div className="queue-item-heading"><span className="queue-position">{index+1}</span><strong>{t("排队消息")}</strong>{edit&&<small>{t("有本地编辑")}</small>}<small>{message.attachments.length ? t("附件 · {count}",{count:message.attachments.length}):''}</small></div>
      {editing===id&&id ? <div className="queue-edit-panel"><label>{t("编辑排队消息")}<textarea data-queue-editor={id} value={edit?.text ?? message.text} maxLength={100000} onChange={event=>setEdits(old=>setQueueEdit(old,id,message.text,event.target.value))}/></label>
        {status==='conflict'&&<div className="queue-conflict" role="alert"><strong>{t("这条排队消息已在别处修改")}</strong><details><summary>{t("查看当前队列内容")}</summary><pre>{message.text}</pre></details><p>{t("你的编辑仍保留。对照内容后，选择使用当前版本或明确保留本地编辑。")}</p><button disabled={busy||pending} onClick={()=>setEdits(old=>({...old,[id]:{base:message.text,text:message.text,updatedAt:Date.now()}}))}>{t("使用当前版本")}</button><button disabled={busy||pending} onClick={()=>setEdits(old=>({...old,[id]:{...old[id],base:message.text}}))}>{t("保留我的编辑并重新检查")}</button></div>}
        <div className="queue-actions"><button data-queue-save={id} disabled={busy||pending||!edit?.text.trim()||status==='conflict'} onClick={()=>void change('edit',id,job.queueRevision||0,edit!.text)}><Check size={13}/>{t("保存")}</button><button disabled={busy} onClick={()=>setEditing(undefined)}>{t("收起并保留编辑")}</button><button disabled={busy} onClick={()=>{setEdits(old=>discardQueueEdit(old,id));setEditing(undefined);}}>{t("放弃本地编辑")}</button></div>
      </div>:<><details className="queue-message-preview"><summary>{message.text.replace(/\s+/g,' ').slice(0,180)}</summary><pre>{message.text}</pre></details><div className="queue-actions"><button disabled={busy||pending||storageBlocked||!id} onClick={()=>{if(id){setEdits(old=>old[id]?old:setQueueEdit(old,id,message.text,message.text));setEditing(id);}}}><Pencil size={13}/>{edit?t("继续编辑"):t("编辑")}</button><button aria-label={t("上移")} title={t("上移")} disabled={busy||pending||index===0||!id} onClick={()=>id&&void change('up',id)}><ArrowUp size={14}/></button><button aria-label={t("下移")} title={t("下移")} disabled={busy||pending||index===messages.length-1||!id} onClick={()=>id&&void change('down',id)}><ArrowDown size={14}/></button><button disabled={busy||pending||!id} onClick={()=>id&&setRemove({id,revision:job.queueRevision||0})}><Trash2 size={13}/>{t("移除")}</button></div></>}
      {remove?.id===id&&<div className="queue-remove-confirm" role="alert"><p>{t("确认从待发送队列移除这条消息？这不会取消当前任务。")}</p><button disabled={busy||pending} onClick={()=>id&&void change('remove',id,remove!.revision)}>{t("确认移除排队消息")}</button><button disabled={busy} onClick={()=>setRemove(undefined)}>{t("取消")}</button></div>}</li>;
    })}</ol>
    {!!orphaned.length&&<section className="queue-recovered"><h4>{t("未发送的本地编辑")}</h4><p>{t("原消息已离开队列，编辑内容留在本机，不会自动重新发送。")}</p>{orphaned.map(([id,edit])=><article key={id}><pre>{edit.text}</pre><div className="queue-actions"><CopyButton text={edit.text} label={t("复制编辑内容")}/><button onClick={()=>setEdits(old=>discardQueueEdit(old,id))}>{t("放弃本地编辑")}</button></div></article>)}</section>}
  </details>;
}
