import React,{useEffect,useState} from "react";
import {FileSearch,RefreshCw} from "lucide-react";
import type {HandoffEntry,HandoffView} from "../shared/handoff";
import type {AdoptionPreviewDetail} from "../shared/handoff-adoption-preview";
import {t,formatDate} from "./i18n";
const actions={unchanged:"保持原内容",create:"新增文件",replace:"替换文件内容",delete:"删除文件",blocked:"需要处理特殊情况"};
const issues={link:"链接需要明确的采用策略",sparse:"稀疏路径需要明确的采用策略",directory:"目录变更需要明确的采用策略",newDirectory:"需要建立新目录并核对权限",newFilePermissions:"新文件需要核对项目继承权限",topology:"仓库拓扑需要重新确认",structural:"路径结构存在冲突"};
export function HandoffSourcePreview({entry,accepted,blocked,call,apply,run}:{entry:HandoffEntry;accepted:boolean|undefined;blocked:boolean;call:(name:string,args?:unknown)=>Promise<any>;apply:(view:HandoffView)=>void;run:(action:()=>Promise<void>)=>Promise<void>}){
  const previews=entry.adoptionPreviews||[],latest=previews.at(-1),[selected,setSelected]=useState(latest?.id||""),[detail,setDetail]=useState<AdoptionPreviewDetail>();
  useEffect(()=>{if(latest?.id)setSelected(latest.id);},[latest?.id]);
  const summary=previews.find(item=>item.id===selected),current=detail?.summary.id===selected?detail:undefined;
  async function load(id=selected,offset=0){const value:AdoptionPreviewDetail=await call("handoffs.sourcePreviewDetail",{id:entry.id,previewId:id,offset,limit:100});setSelected(id);setDetail(value);}
  return <section className="handoff-source-preview">
    <div className="handoff-section-heading"><h3>{t("原项目写回预览")}</h3><FileSearch size={18}/></div>
    <p className="handoff-caption">{t("比较当前原项目与完整候选，逐项核对写回内容。")}</p>
    <code className="handoff-source-path">{entry.sourceCwd}</code>
    <button disabled={blocked||!accepted||entry.status!=="reviewable"} onClick={()=>void run(async()=>{apply(await call("handoffs.sourcePreview",{id:entry.id,requestId:crypto.randomUUID(),reviewId:entry.review!.id}));})}><RefreshCw size={15}/>{t("重新核对并建立写回预览")}</button>
    <p className="handoff-caption">{t("此步骤只生成审阅记录。原项目写入与恢复操作尚未接入。")}</p>
    {!!previews.length&&<label>{t("已保存的写回预览")}<select disabled={blocked} value={selected} onChange={event=>{const id=event.target.value;void run(()=>load(id));}}>{previews.slice().reverse().map(preview=><option key={preview.id} value={preview.id}>{formatDate(preview.createdAt)} · {preview.id.slice(0,8)}</option>)}</select></label>}
    {summary&&<>
      <div className="handoff-preview-counts"><span>{t("{count} 个文件",{count:summary.files})}</span><strong>{t("{count} 项内容变化",{count:summary.changes})}</strong><span>{t("{count} 项需要处理",{count:summary.blocked})}</span></div>
      {(summary.workspaceId!==entry.currentWorkspaceId||summary.expiresAt<=Date.now())&&<p className="handoff-caption">{t("这是已保存的历史预览，使用前需要重新核对。")}</p>}
      <button disabled={blocked} onClick={()=>void run(()=>load())}>{t("读取完整文件清单")}</button>
    </>}
    {current&&<>
      <div className="handoff-table-wrap"><table className="handoff-table"><thead><tr><th>{t("路径")}</th><th>{t("写回变化")}</th><th>{t("内容核验")}</th></tr></thead><tbody>{current.files.map(file=><tr key={`${file.repository}/${file.path}`}><th><code>{file.repository?`${file.repository}/${file.path}`:file.path}</code></th><td>{t(actions[file.action])}{file.issue&&<small>{t(issues[file.issue])}</small>}</td><td><details><summary>{t("查看完整字节指纹")}</summary>{file.before&&<div>{t("当前原项目")} · {file.before.bytes}<code>{file.before.sha256}</code></div>}{file.after&&<div>{t("集成结果")} · {file.after.bytes}<code>{file.after.sha256}</code></div>}</details></td></tr>)}</tbody></table></div>
      <div className="handoff-pagination"><span>{t("{from}–{to} / {total}",{from:current.total?current.offset+1:0,to:current.offset+current.files.length,total:current.total})}</span><button disabled={blocked||current.offset===0} onClick={()=>void run(()=>load(selected,Math.max(0,current.offset-100)))}>{t("上一页")}</button><button disabled={blocked||current.offset+current.files.length>=current.total} onClick={()=>void run(()=>load(selected,current.offset+100))}>{t("下一页")}</button></div>
    </>}
  </section>;
}
