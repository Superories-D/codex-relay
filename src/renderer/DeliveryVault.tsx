import React, { useEffect, useRef, useState } from "react";
import { Archive, FolderOpen, Download, ShieldCheck, HardDrive, Trash2 } from "lucide-react";
import { Dialog } from "./Dialog";
import { t, useI18n, errorText, formatDate } from "./i18n";
import type { VaultView, VaultPreview, VaultManifest, VaultEntry } from "../shared/vault";
import "./delivery-vault.css";
const sizes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`;
const status = {copying:"正在保存",ready:"版本已保存",failed:"保存未完成",cancelled:"已取消",interrupted:"需要恢复复核",deleting:"删除未完成"};
const phase = {copying:"正在复制实际文件",verifying:"正在重新读取校验",sealing:"正在封存版本",packing:"正在创建完整交付包",checkingArchive:"正在复核交付包"};
const taskState = {completed:"已完成",paused:"已暂停",cancelled:"已取消",needs_attention:"需要处理"};
type Call = (name: string, args?: unknown) => Promise<any>;
export function DeliveryVault({call, selected, previewOnOpen, close}: {call:Call; selected:string[]; previewOnOpen:boolean; close:()=>void}) {
  useI18n();
  const [view,setView]=useState<VaultView>(),[preview,setPreview]=useState<VaultPreview>(),[title,setTitle]=useState("");
  const [detail,setDetail]=useState<{entry:VaultEntry;manifest:VaultManifest}>(),[remove,setRemove]=useState<VaultEntry>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[filter,setFilter]=useState("");
  const alive=useRef(true),pending=useRef(false),polling=useRef(false),callRef=useRef(call);callRef.current=call;
  const epoch=useRef(0);
  const apply=(value:VaultView)=>setView(old=>!old || value.revision>=old.revision?value:old);
  const run=async(action:()=>Promise<void>)=>{if(pending.current)return;pending.current=true;epoch.current++;setBusy(true);setError("");try{await action();}catch(e){if(alive.current)setError(errorText(e));}finally{pending.current=false;if(alive.current)setBusy(false);}};
  useEffect(()=>{
    alive.current=true;
    void run(async()=>{apply(await callRef.current("vault.list"));if(previewOnOpen){const p=await callRef.current("vault.preview",selected);if(alive.current){setPreview(p);setTitle(p.title);}}});
    const timer=setInterval(()=>{if(polling.current||pending.current)return;polling.current=true;const generation=epoch.current;void callRef.current("vault.list").then(v=>{if(alive.current&&epoch.current===generation)apply(v);}).catch(e=>{if(alive.current&&epoch.current===generation)setError(errorText(e));}).finally(()=>{polling.current=false;});},750);
    return()=>{alive.current=false;clearInterval(timer);};
  },[]);
  const active=view?.active,progress=view?.progress,blocked=busy||!!active||!!view?.issue;
  const entries=view?.entries.slice().reverse().filter(e=>e.title.toLowerCase().includes(filter.toLowerCase())) || [];
  const current=detail&&view?.entries.find(e=>e.id===detail.entry.id);
  return <Dialog title={t("交付保险库")} busy={busy} onClose={close}><div className="delivery-vault">
    <header><span className="vault-icon"><Archive size={25}/></span><div><h2>{t("交付保险库")}</h2><p>{t("把验收通过的实际文件保存为独立版本，随时复核与完整交付。")}</p></div></header>
    {error&&<p className="dc-error" role="alert">{error}</p>}{view?.issue&&<p className="dc-error" role="alert">{t(view.issue)}</p>}
    <div className="vault-storage"><HardDrive size={17}/><div><strong>{t("新版本保存位置")}</strong><code>{view?.storage||t("正在读取")}</code></div><button disabled={blocked} onClick={()=>void run(async()=>{apply(await call("vault.storage"));setPreview(undefined);})}>{t("更换位置")}</button></div>
    <p className="vault-caption">{t("更换位置会保留旧位置的版本。完整交付包包含实际文件、验收清单、离线索引和 Windows 校验器。")}</p>
    {active&&<section className="vault-progress" aria-live="polite"><strong>{t(progress?phase[progress.phase]:"正在准备交付操作")}</strong><span>{view?.entries.find(e=>e.id===active.entryId)?.title}</span>
      <progress max={progress?.totalBytes||1} value={progress?.bytes||0}/><p>{progress?`${sizes(progress.bytes)} / ${sizes(progress.totalBytes)} · ${progress.files}/${progress.totalFiles}`:t("正在准备")}</p>{progress?.path&&<code>{progress.path}</code>}
      <button disabled={busy||active.publishing} onClick={()=>void run(async()=>apply(await call("vault.cancel",active.id)))}>{t(active.publishing?"正在完成写入":"取消当前操作")}</button>
      <small>{t("关闭窗口后操作继续；退出应用会安全取消尚未发布的操作。")}</small></section>}
    {preview&&<section className="vault-preview"><h3>{t("确认保存交付版本")}</h3><p>{t("保存过程会重新核对当前验收与文件内容，不会启动模型或改变任务的暂停状态。")}</p>
      <label>{t("交付版本名称")}<input value={title} maxLength={200} disabled={blocked} onChange={e=>setTitle(e.target.value)}/></label>
      <div className="vault-totals"><strong>{sizes(preview.totalBytes)}</strong><span>{t("{count} 个完整文件",{count:preview.artifacts.length})}</span><span>{t("{count} 项任务",{count:preview.tasks.length})}</span></div>
      {preview.freeBytes!==undefined&&<p>{t("目标磁盘可用空间")}: {sizes(preview.freeBytes)}{preview.freeBytes<preview.totalBytes&&` · ${t("空间可能不足，请更换位置或释放磁盘空间。")}`}</p>}
      <div className="vault-preview-files">{preview.tasks.map(task=><details key={task.id}><summary>{task.title} · {t(taskState[task.stateAtCapture])}{task.workflow&&` · ${task.workflow.title} (${task.workflow.step}/${task.workflow.total})`}</summary>{preview.artifacts.filter(a=>a.jobId===task.id).map(a=><p key={a.id}><code>{a.relative}</code><span>{sizes(a.bytes)}</span></p>)}</details>)}</div>
      <div className="vault-actions"><button disabled={blocked||!title.trim()} className="vault-primary" onClick={()=>void run(async()=>{await call("vault.capture",{previewId:preview.id,title:title.trim()});setPreview(undefined);apply(await call("vault.list"));})}><Archive size={15}/>{t("保存完整版本")}</button><button disabled={busy} onClick={()=>setPreview(undefined)}>{t("取消")}</button></div>
    </section>}
    <div className="vault-heading"><h3>{t("已保存的版本")}</h3><input aria-label={t("搜索交付版本")} placeholder={t("搜索交付版本")} value={filter} onChange={e=>setFilter(e.target.value)}/></div>
    {!entries.length&&<div className="vault-empty"><ShieldCheck size={28}/><p>{t("还没有保存的交付版本")}</p><small>{t("在交付中心选择验收通过的任务，再保存完整版本。")}</small></div>}
    <div className="vault-entries">{entries.map(entry=><article key={entry.id} data-vault-id={entry.id}>
      <div className="vault-entry-title"><strong>{entry.title}</strong><span data-state={entry.verification?.status||entry.status}>{t(entry.verification?.status==="failed"?"版本文件已变化":entry.verification?.status==="unverified"?"版本完整性待确认":status[entry.status])}</span></div>
      <p>{formatDate(entry.sealedAt??entry.createdAt)} · {sizes(entry.totalBytes)} · {t("{count} 个完整文件",{count:entry.artifactCount})}</p>
      {entry.issue&&<p className="dc-error">{t(entry.issue)}</p>}{entry.exportIssue&&<p className="dc-error">{t(entry.exportIssue)}</p>}
      {entry.exportAttempt?.state==="interrupted"&&<div className="vault-interrupted"><code>{entry.exportAttempt.destination}</code><p>{t("核对会完整读取可能已导出的文件，并只清理本次操作拥有的临时文件。")}</p><button disabled={blocked} onClick={()=>void run(async()=>apply(await call("vault.export.recover",entry.id)))}>{t("核对上次导出")}</button></div>}
      <div className="vault-actions"><button disabled={busy||!entry.manifestSha256} onClick={()=>void run(async()=>setDetail(await call("vault.detail",entry.id)))}>{t("查看版本清单")}</button>
        <button disabled={blocked||!entry.manifestSha256||entry.status==="deleting"} onClick={()=>void run(async()=>apply(await call("vault.verify",entry.id)))}><ShieldCheck size={14}/>{t(entry.status==="interrupted"?"复核并恢复":"复核完整版本")}</button>
        <button disabled={busy||entry.status!=="ready"} onClick={()=>void run(async()=>{await call("vault.open",entry.id);})}><FolderOpen size={14}/>{t("打开版本目录")}</button>
        <button disabled={blocked||entry.status!=="ready"||!!entry.exportAttempt} onClick={()=>void run(async()=>apply(await call("vault.export",entry.id)))}><Download size={14}/>{t("导出完整交付包")}</button>
        <button disabled={blocked||!!entry.exportAttempt} onClick={()=>setRemove(entry)} aria-label={t("删除版本：{title}",{title:entry.title})}><Trash2 size={14}/></button></div>
      {entry.lastExport&&<details className="vault-export"><summary>{t("上次完整导出")} · {formatDate(entry.lastExport.at)}</summary><code>{entry.lastExport.path}</code><p>{sizes(entry.lastExport.bytes)} · SHA256 <code>{entry.lastExport.sha256}</code></p><small>{t("此指纹记录导出完成时的文件；外部文件后来更改时，需要另行核对。")}</small></details>}
    </article>)}</div>
    {detail&&<section className="vault-detail"><div className="vault-heading"><h3>{detail.entry.title}</h3><button onClick={()=>setDetail(undefined)}>{t("收起清单")}</button></div>
      <p>{t("清单 SHA256")}</p><code>{detail.entry.manifestSha256}</code><p>{t("版本保存位置")}: <code>{detail.entry.root}</code></p>
      <p>{t("查看清单只读取清单；复核完整版本会重新读取所有实际文件。")}</p>
      {current?.verification&&<p>{t("最近复核")}: {formatDate(current.verification.at)} · {t(current.verification.status==="passed"?"完整性校验通过":current.verification.status==="failed"?"版本文件已变化":"版本完整性待确认")}</p>}
      {current?.verification?.changed.map(p=><p key={p} className="dc-error"><code>{p}</code></p>)}
      {detail.manifest.tasks.map(task=><details key={task.id}><summary>{task.title} · {t(taskState[task.stateAtCapture])}</summary><p>{task.project} {task.workflow&&` · ${task.workflow.title} (${task.workflow.step}/${task.workflow.total})`}</p>{task.report.findings.map((f,i)=><p key={i}>{f.check.label} · <code>{f.check.path}</code></p>)}</details>)}
      {detail.manifest.artifacts.map(a=><div className="vault-file" key={a.id}><strong>{a.relative}</strong><span>{sizes(a.bytes)}</span><code>SHA256 {a.sha256}</code></div>)}
    </section>}
    {remove&&<section className="vault-delete" role="alert"><h3>{t("删除保存的交付版本")}</h3><p>{remove.title}</p><p>{t("将删除保险库中的实际文件和版本记录。原工作目录与已经导出的 ZIP 保留。")}</p><button disabled={blocked} onClick={()=>void run(async()=>{apply(await call("vault.remove",remove.id));if(detail?.entry.id===remove.id)setDetail(undefined);setRemove(undefined);})}>{t("确认删除此版本")}</button><button disabled={busy} onClick={()=>setRemove(undefined)}>{t("取消")}</button></section>}
  </div></Dialog>;
}
