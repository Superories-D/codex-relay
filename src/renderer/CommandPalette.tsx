import React, { useEffect, useId, useRef, useState } from "react";
import { Search, MessageSquare, Command, ArrowUpRight } from "lucide-react";
import type { Job } from "../shared/types";
import { Dialog } from "./Dialog";
import { t } from "./i18n";
import { projectShortName } from "./workspace-home";
export interface WorkspaceCommand { id: string; label: string; hint?: string; run: () => void }
export function CommandPalette({jobs, commands, choose, close}: {jobs: Job[]; commands: WorkspaceCommand[]; choose: (job:Job)=>void;close:()=>void}) {
  const [query,setQuery]=useState(''),[index,setIndex]=useState(0);
  const list=useRef<HTMLDivElement>(null), id=useId();
  const commandsOnly=query.trimStart().startsWith('>');
  const term=query.trim().replace(/^>\s*/, '').toLocaleLowerCase();
  const actions=commands.filter(c=>`${c.label} ${c.hint || ''}`.toLocaleLowerCase().includes(term)).map(c=>({...c,kind:'command'}));
  const chats=commandsOnly?[]:[...jobs].filter(j=>`${j.title} ${j.cwd}`.toLocaleLowerCase().includes(term)).sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||b.updatedAt-a.updatedAt).slice(0,30).map(j=>({id:j.id,label:j.title,hint:`${projectShortName(j.cwd)}${j.archived ? t(' · 已归档'):''}`,run:()=>choose(j),kind:'chat'}));
  const results=[...actions,...chats], current=Math.max(0,Math.min(index,results.length-1));
  useEffect(()=>{list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[current,query]);
  return <Dialog title={t("搜索与快捷操作")} onClose={close}><div className="workspace-command-palette"><header><Command size={18}/><strong>{t("搜索与快捷操作")}</strong><kbd>Ctrl K</kbd></header><div className="workspace-command-input"><Search size={20}/><input autoFocus role="combobox" aria-label={t("查找聊天或项目")} aria-expanded="true" aria-controls={id} aria-autocomplete="list" aria-activedescendant={results.length ? `${id}-${current}` : undefined} placeholder={t("搜索聊天、项目或操作…")} value={query} onChange={e=>{setQuery(e.target.value);setIndex(0);}} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setIndex(Math.max(0,Math.min(results.length-1,current+(e.key==='ArrowDown'?1:-1))));}if(e.key==='Enter'&&results[current]){e.preventDefault();results[current].run();close();}}}/></div><div className="workspace-command-results" role="listbox" id={id} ref={list} aria-label={t("搜索结果")}>{results.map((r,i)=><button key={`${r.kind}-${r.id}`} id={`${id}-${i}`} role="option" aria-selected={current===i} tabIndex={-1} onMouseEnter={()=>setIndex(i)} onClick={()=>{r.run();close();}}>{r.kind==='command'?<Command size={17}/>:<MessageSquare size={17}/>}<span><strong>{r.label}</strong><small>{r.hint || t("快捷操作")}</small></span><ArrowUpRight size={15}/></button>)}{!results.length&&<p role="status">{t("没有匹配结果，试试其他关键词")}</p>}</div><footer><span>{t("↑↓ 选择 · Enter 打开")}</span><span>{t("输入 > 只查找操作")}</span></footer></div></Dialog>;
}
