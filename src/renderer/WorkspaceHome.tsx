import React from "react";
import { ArrowUpRight, FolderOpen, GitCompareArrows, ListTodo, MessageSquare, Plus, Sparkles, CircleAlert, ArrowRight } from "lucide-react";
import type { Job, Snapshot } from "../shared/types";
import { t } from "./i18n";
import { homeJobs, projectShortName } from "./workspace-home";

export function WorkspaceHome({snapshot, cwd, projects, open, project, choose, tasks, attention: openAttention, prompt}: {
  snapshot?: Snapshot; cwd: string; projects: {cwd: string; name?: string}[];
  open: (job: Job) => void; project: (cwd: string) => void; choose: () => void;
  attention?: () => void; tasks: () => void; prompt: (value: string) => void;
}) {
  const {recent, attention, active} = homeJobs(snapshot?.jobs || [], snapshot?.approvals || []);
  const projectList = [...new Map([...recent.map(j => ({cwd: j.projectCwd || j.cwd, name: projectShortName(j.projectCwd || j.cwd)})), ...projects].map(p => [snapshot?.platform === "win32" ? p.cwd.replace(/\\/g,"/").replace(/\/$/, "").toLowerCase() : p.cwd, p])).values()].slice(0, 6);
  return <section className="workspace-home" aria-label={t("工作台首页")}>
    <header className="workspace-home-heading"><div><span className="workspace-eyebrow">{t("你的工作空间")}</span><h1>{t("从这里，继续向前。")}</h1><p>{t("继续最近的工作，或把下一个想法变成成果。")}</p></div><span className="workspace-home-symbol"><Sparkles size={26}/></span></header>
    <div className="workspace-status-strip"><button onClick={tasks}><span className="workspace-live-dot"/><strong>{active.length}</strong>{t("进行中")}<ArrowUpRight size={14}/></button><button onClick={openAttention || tasks} className={attention.length ? "has-attention" : ""}><CircleAlert size={15}/><strong>{attention.length}</strong>{t("等待你处理")}<ArrowUpRight size={14}/></button><button onClick={tasks}><ListTodo size={16}/>{t("打开任务工作台")}<ArrowRight size={14}/></button></div>
    {!!attention.length && <section className="workspace-attention"><div className="workspace-section-heading"><h2>{t("先处理这些")}</h2><span>{t("审批、问题与异常任务")}</span></div>{attention.slice(0,3).map(job => <button key={job.id} onClick={() => open(job)}><CircleAlert size={16}/><span><strong>{job.title}</strong><small>{projectShortName(job.projectCwd || job.cwd)}</small></span><ArrowRight size={17}/></button>)}</section>}
    <div className="workspace-home-columns"><section><div className="workspace-section-heading"><h2>{t("最近的聊天")}</h2><span>{t("点击继续上下文")}</span></div><div className="workspace-recent">{recent.slice(0,4).map(job => <button key={job.id} onClick={() => open(job)}><MessageSquare size={17}/><span><strong>{job.title}</strong><small>{projectShortName(job.projectCwd || job.cwd)}</small></span><span className={`workspace-state state-${job.state}`}>{t(job.state === 'completed' ? '本轮完成' : job.state === 'paused' ? '已暂停' : job.state === 'needs_attention' ? '需要处理' : active.some(j=>j.id===job.id) ? '进行中' : '已取消')}</span></button>)}{!recent.length && <div className="workspace-empty"><MessageSquare size={22}/><p>{t("你的下一段工作，从下方输入框开始。")}</p></div>}</div></section>
    <section><div className="workspace-section-heading"><h2>{t("项目空间")}</h2><button onClick={choose} title={t("选择项目目录")} aria-label={t("选择项目目录")}><Plus size={17}/></button></div><div className="workspace-projects">{projectList.map(p => <button key={p.cwd} title={p.cwd} aria-pressed={cwd === p.cwd} onClick={() => project(p.cwd)}><FolderOpen size={18}/><span><strong>{p.name || projectShortName(p.cwd)}</strong><small>{p.cwd}</small></span>{cwd === p.cwd && <span className="workspace-project-dot"/>}</button>)}{!projectList.length && <button onClick={choose}><FolderOpen size={20}/>{t("选择项目目录")}</button>}</div></section></div>
    <section className="workspace-starters"><div className="workspace-section-heading"><h2>{t("开始一件新工作")}</h2><span>{t("选择后可在发送前编辑")}</span></div><div>{[{icon:FolderOpen,title:t("理解项目"),text:t("了解这个项目的结构")},{icon:GitCompareArrows,title:t("检查改动"),text:t("审查当前项目中尚未提交的修改")},{icon:Sparkles,title:t("完善测试"),text:t("为项目补充测试")}].map(item => <button key={item.title} onClick={() => prompt(item.text)}><item.icon size={18}/><strong>{item.title}</strong><ArrowUpRight size={15}/></button>)}</div></section>
  </section>;
}
