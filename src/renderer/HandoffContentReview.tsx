import React,{useEffect,useRef,useState} from "react";
import type {HandoffContentDocument,HandoffContentSelection,HandoffView} from "../shared/handoff";
import {t,errorText,useI18n} from "./i18n";

const roles=["base","source","task","result"] as const;
const names={base:"启动检查点",source:"当前来源",task:"任务结果",result:"集成结果"};
const layers={working:"保留的工作内容",index:"原始暂存阶段",undo:"冲突撤销阶段",edited:"候选当前编辑"};
const kinds={absent:"此层未包含该路径",link:"链接目标",gitlink:"子仓库引用",tree:"稀疏目录树",sparse:"仅保存在索引",file:"文件内容"};
function hex(document:HandoffContentDocument){const window=document.window;if(!window)return"";const bytes=atob(window.rawBase64),lines:string[]=[];for(let offset=0;offset<bytes.length;offset+=16){const row=bytes.slice(offset,offset+16),values=Array.from(row,char=>char.charCodeAt(0).toString(16).padStart(2,"0")).join(" ");lines.push(`${(window.offset+offset).toString(16).padStart(12,"0")}  ${values.padEnd(47," ")}  ${row.replace(/[^\x20-\x7e]/g,".")}`);}return lines.join("\n");}
export function HandoffContentReview({id,workspaceId,path,call,apply,blocked,close}:{id:string;workspaceId?:string;path:string;call:(name:string,args?:unknown)=>Promise<any>;apply:(view:HandoffView)=>void;blocked:boolean;close:()=>void}){
  useI18n();const [documents,setDocuments]=useState<Partial<Record<HandoffContentSelection["role"],HandoffContentDocument>>>({}),[choices,setChoices]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState(""),[display,setDisplay]=useState<Record<string,"text"|"hex">>({}),[positions,setPositions]=useState<Record<string,string>>({});
  const live=useRef(true),ticket=useRef(0),operation=useRef<string|undefined>(undefined),pending=useRef(false),root=useRef<HTMLElement>(null);
  useEffect(()=>{live.current=true;root.current?.scrollIntoView({block:"nearest"});return()=>{live.current=false;ticket.current++;};},[]);
  const selection=(role:HandoffContentSelection["role"],offset=0):HandoffContentSelection=>{const [layer,stage]=(choices[role]||"working:0").split(":");return{role,path,layer:layer as HandoffContentSelection["layer"],stage:Number(stage),offset,length:32768};};
  async function read(selections:HandoffContentSelection[]){
    if(pending.current)return;pending.current=true;setBusy(true);setError("");const current=++ticket.current,requestId=crypto.randomUUID();
    try{let view:HandoffView=await call("handoffs.content",{id,requestId,selections});operation.current=view.active?.kind==="content"?view.active.id:undefined;
      for(;;){if(!live.current||ticket.current!==current)return;apply(view);
        if(view.contentReview?.requestId===requestId){if(view.contentReview.workspaceId!==workspaceId)throw Error(t("集成候选已变化，请重新读取"));const result:{documents:HandoffContentDocument[]}=await call("handoffs.contentResult",{id,requestId});if(!live.current||ticket.current!==current)return;setDocuments(previous=>{const next={...previous};for(const document of result.documents)next[document.selection.role]=document;return next;});break;}
        if(!view.active)throw Error(view.entries.find(item=>item.id===id)?.issue||t("内容审阅窗口已失效，请重新读取"));
        await new Promise(resolve=>setTimeout(resolve,400));if(!live.current||ticket.current!==current)return;view=await call("handoffs.list");
      }
    }catch(value){if(live.current&&ticket.current===current)setError(errorText(value));}finally{if(ticket.current===current){operation.current=undefined;pending.current=false;if(live.current)setBusy(false);}}
  }
  const stop=async()=>{const op=operation.current;ticket.current++;pending.current=false;operation.current=undefined;setBusy(false);if(op)try{apply(await call("handoffs.cancel",op));}catch{}close();};
  return <section ref={root} className="handoff-content" aria-label={t("四方内容审阅")}>
    <div className="handoff-section-heading"><h3>{t("四方内容审阅")}</h3><button onClick={()=>void stop()}>{t("关闭内容审阅")}</button></div><code className="handoff-content-path">{path}</code>
    <p className="handoff-caption">{t("每次读取完整字节并校验，仅将当前窗口分页显示。文本保留换行，跨页字符可能重叠。")}</p>
    <button disabled={busy||blocked} onClick={()=>void read(roles.map(role=>selection(role)))}>{t("读取四方内容")}</button>{busy&&<span role="status">{t("正在完整读取")}</span>}{error&&<p className="handoff-error" role="alert">{error}</p>}
    <div className="handoff-content-grid">{roles.map(role=>{const document=documents[role],window=document?.window,mode=window?.encoding==="binary"?"hex":display[role]||"text",position=positions[role]||"0";return <article key={role} className="handoff-content-pane" aria-label={t(names[role])}>
      <h4>{t(names[role])}</h4><label><span>{t("审阅层")}</span><select aria-label={`${t(names[role])}: ${t("审阅层")}`} value={choices[role]||"working:0"} disabled={busy||blocked} onChange={event=>{setChoices(previous=>({...previous,[role]:event.target.value}));setDocuments(previous=>({...previous,[role]:undefined}));setPositions(previous=>({...previous,[role]:"0"}));}}>
        <option value="working:0">{t(layers.working)}</option>{([0,1,2,3] as const).map(stage=><option key={`index${stage}`} value={`index:${stage}`}>{t(layers.index)} {stage}</option>)}{role!=="result"?[1,2,3].map(stage=><option key={`undo${stage}`} value={`undo:${stage}`}>{t(layers.undo)} {stage}</option>):<option value="edited:0">{t(layers.edited)}</option>}
      </select></label><button disabled={busy||blocked} onClick={()=>void read([selection(role)])}>{t("读取此版本")}</button>
      {document&&<><strong>{t(kinds[document.kind])}</strong>{document.bytes!==undefined&&<small>{t("完整文件 {bytes} 字节",{bytes:document.bytes.toLocaleString()})}</small>}{document.sha256&&<code className="handoff-content-digest">SHA256 {document.sha256}</code>}{document.oid&&<code className="handoff-content-digest">Git {document.oid}</code>}{document.linkTarget&&<code>{document.linkTarget}</code>}
        {window&&<><div className="handoff-content-controls"><label>{t("显示方式")}<select value={mode} disabled={window.encoding==="binary"} onChange={event=>setDisplay(previous=>({...previous,[role]:event.target.value as "text"|"hex"}))}><option value="text">{t("文本")}</option><option value="hex">{t("十六进制")}</option></select></label><small>{t("字节 {start}–{end} / {total}",{start:window.offset,end:window.offset+window.length,total:document.bytes||0})}</small>{mode==="text"&&<small>{t("从第 {line} 行开始",{line:window.firstLine||1})}</small>}</div>
          <pre className="handoff-content-bytes" tabIndex={0} aria-label={`${t(names[role])}: ${t("文件内容")}`}>{mode==="hex"?hex(document):window.text}</pre>
          <div className="handoff-pagination"><button disabled={busy||blocked||window.offset===0} onClick={()=>void read([selection(role,Math.max(0,window.offset-32768))])}>{t("上一页")}</button><button disabled={busy||blocked||window.eof} onClick={()=>void read([selection(role,window.offset+window.length)])}>{t("下一页")}</button></div>
          <label className="handoff-content-jump">{t("跳转到字节")}<input inputMode="numeric" value={position} onChange={event=>setPositions(previous=>({...previous,[role]:event.target.value}))}/><button disabled={busy||blocked||!/^\d+$/.test(position)||!Number.isSafeInteger(Number(position))||Number(position)>Number.MAX_SAFE_INTEGER-65539} onClick={()=>void read([selection(role,Number(position))])}>{t("跳转")}</button></label>
        </>}
      </>}
    </article>;})}</div>
  </section>;
}
