import React,{useRef,useState} from "react";
import type {HandoffEntry,HandoffView} from "../shared/handoff";
import {t} from "./i18n";
export function HandoffRetry({entry,blocked,call,apply,run,select}:{entry:HandoffEntry;blocked:boolean;call:(name:string,args?:unknown)=>Promise<any>;apply:(view:HandoffView)=>void;run:(action:()=>Promise<void>)=>Promise<void>;select:(id:string)=>void}){
  const [mode,setMode]=useState<"retained"|"recapture">("retained"),pending=useRef(false);
  return <section className="handoff-retry"><label>{t("新的交接尝试")}<select value={mode} disabled={blocked} onChange={event=>setMode(event.target.value as typeof mode)}><option value="retained">{t("使用原有完整封存")}</option><option value="recapture">{t("重新捕获当前来源与任务")}</option></select></label><p className="handoff-caption">{t(mode==="retained"?"重新计算封存的三方集成，旧候选及后续编辑继续保留。":"重新读取当前项目和任务文件，启动基准保持原检查点；旧尝试继续保留。")}</p><button disabled={blocked} onClick={()=>{if(pending.current)return;pending.current=true;void run(async()=>{const requestId=crypto.randomUUID(),view:HandoffView=await call("handoffs.retry",{id:entry.id,requestId,title:entry.title,mode});apply(view);select(requestId);}).finally(()=>{pending.current=false;});}}>{t("建立独立的新尝试")}</button></section>;
}
