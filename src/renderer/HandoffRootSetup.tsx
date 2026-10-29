import React,{useState} from "react";
import type {HandoffView} from "../shared/handoff";
import {t} from "./i18n";
export function HandoffRootSetup({id,workspaceId,blocked,call,apply,run}:{id:string;workspaceId:string;blocked:boolean;call:(name:string,args?:unknown)=>Promise<any>;apply:(view:HandoffView)=>void;run:(action:()=>Promise<void>)=>Promise<void>}){
  const [setup,setSetup]=useState<""|"base"|"source"|"task"|"omit">("");
  return <section className="handoff-assembly-controls"><label>{t("忽略配置接入方式")}<select value={setup} disabled={blocked} onChange={event=>setSetup(event.target.value as typeof setup)}><option value="">{t("明确选择配置来源")}</option>{(["base","source","task","omit"]as const).map(role=><option key={role} value={role}>{t(role==="base"?"启动检查点":role==="source"?"当前来源":role==="task"?"任务结果":"省略所选忽略配置")}</option>)}</select></label><p className="handoff-caption">{t("配置按完整字节独立复制，保持未暂存；不会自动加入父仓库或子仓库提交。")}</p><button disabled={blocked||!setup} onClick={()=>void run(async()=>apply(await call("handoffs.graphAssemble",{id,workspaceId,requestId:crypto.randomUUID(),setup})))}>{t("建立包含配置的新候选")}</button></section>;
}
