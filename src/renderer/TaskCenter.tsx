import { WorkflowReport } from "./WorkflowReport";
import { WorkspaceCheckpoints } from "./WorkspaceCheckpoints";
import { DeliveryCenter } from "./DeliveryCenter";
import { OperationsCenter } from "./OperationsCenter";
import { WorkflowBuilder } from "./WorkflowBuilder";
import { dispatchHeld, projectKey, projectLimit } from "../shared/dispatch";
import { dependencyBlockers } from "../shared/task-dependencies";
import { TaskDependencies } from "./TaskDependencies";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, CheckCheck, ChevronDown, CircleAlert, Columns3, Folder, GitBranch, List, ListTodo, Pause, Play, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import type { Job, Snapshot, Approval } from "../shared/types";
import { canControlTask, matchesTaskFilter, readTaskView, sortTaskView, taskLane, taskScope, type TaskFilter, type TaskLane, type TaskSort } from "../shared/task-view";
import { priorityRejection, type BulkPriorityResult, type TaskPriority } from "../shared/task-priority";
import { t, useI18n, errorText, formatDate } from "./i18n";
import { RecoveryNotice } from "./RecoveryNotice";
import "./task-center.css";
const labels: Record<string, string> = {
  queued: "排队中", running: "正在工作", preparing: "连接中", rotating: "自动切换账户",
  waiting: "等待可用额度", pausing: "正在停止", paused: "已暂停", needs_attention: "需要处理",
  completed: "本轮完成", cancelled: "已取消", watching: "监控中",
};
const filters: { value: TaskFilter; label: string }[] = [
  { value: "all", label: "全部任务" }, { value: "active", label: "进行中" },
  { value: "attention", label: "需要处理" }, { value: "paused", label: "已暂停" },
  { value: "recovering", label: "自动恢复" }, { value: "completed", label: "本轮完成" },
];
const lanes: { value: TaskLane; label: string }[] = [
  { value: "attention", label: "需要处理" }, { value: "ready", label: "待推进" },
  { value: "working", label: "正在工作" }, { value: "finished", label: "已结束" },
];
const basename = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
type ControlResult = { id: string; ok: boolean; error?: string };
export function TaskCenter({ snapshot, call, open, close, approval, manage }: {
  snapshot: Snapshot; call: (name: string, args?: unknown) => Promise<any>; open: (job: Job) => void;
  close: () => void; approval?: (a: Approval, respond: (v: unknown) => void) => React.ReactNode;
  manage?: (section: string) => void;
}) {
  useI18n();
  const [workflowReport, setWorkflowReport] = useState<string>();
  const [checkpoints, setCheckpoints] = useState(false);
  const [deliveryCenter, setDeliveryCenter] = useState(false);
  const [cockpit, setCockpit] = useState(false);
  const [building, setBuilding] = useState(false);
  const [editing, setEditing] = useState<Job>();
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState(() => readTaskView(localStorage));
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const actionLock = useRef(false);
  const [priority, setPriority] = useState<TaskPriority>("high");
  const [operation, setOperation] = useState("");
  const [report, setReport] = useState<ControlResult[]>();
  const [error, setError] = useState("");
  useEffect(() => { try { localStorage.setItem("relay.taskView", JSON.stringify(view)); } catch { /* View remains usable without persistent storage. */ } }, [view]);
  const jobs = useMemo(() => snapshot.jobs.filter(job => !job.archived), [snapshot.jobs]);
  const scoped = useMemo(() => taskScope(jobs, { project, query, platform: snapshot.platform }), [jobs, project, query, snapshot.platform]);
  const filtered = useMemo(() => sortTaskView(scoped.filter(job => matchesTaskFilter(job, filter, snapshot.approvals)), view.sort), [scoped, filter, snapshot.approvals, view.sort]);
  const eligible = filtered.filter(job => !priorityRejection(job) || canControlTask(job, "pause") || canControlTask(job, "resume"));
  const targets = eligible.filter(job => selected.includes(job.id));
  const priorityTargets = targets.filter(job => !priorityRejection(job));
  const pauseTargets = targets.filter(job => canControlTask(job, "pause"));
  const resumeTargets = targets.filter(job => canControlTask(job, "resume"));
  const hiddenSelection = selected.filter(id => jobs.some(job => job.id === id) && !filtered.some(job => job.id === id)).length;
  const projects = [...new Map([...jobs.map(job => job.projectCwd || job.cwd), ...(snapshot.dispatch?.projects || []), ...(snapshot.projectLimits || []).map(limit => limit.cwd)]
    .map(cwd => [projectKey(cwd, snapshot.platform), cwd])).values()];
  const projectPaused = snapshot.dispatch?.projects.some(cwd => projectKey(cwd, snapshot.platform) === projectKey(project, snapshot.platform));
  async function action(name: string, args: unknown) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true); setError(""); setReport(undefined);
    setOperation(name === "chat.priority" ? "调整任务优先级" : "更新调度设置");
    try { await call(name, args); } catch (e) { setError(errorText(e)); } finally { actionLock.current = false; setBusy(false); }
  }
  async function run(control: "pause" | "resume", chosen: Job[]) {
    if (!chosen.length || actionLock.current) return;
    actionLock.current = true;
    setBusy(true); setError(""); setReport(undefined); setOperation(control === "pause" ? "暂停所选" : "恢复所选");
    try {
      const response = await call("jobs.control", { ids: chosen.map(job => job.id), action: control });
      setReport(response.results);
      const succeeded = new Set(response.results.filter((result: ControlResult) => result.ok).map((result: ControlResult) => result.id));
      setSelected(ids => ids.filter(id => !succeeded.has(id)));
    } catch (e) { setError(errorText(e)); } finally { actionLock.current = false; setBusy(false); }
  }
  async function setPriorities() {
    if (!priorityTargets.length || actionLock.current) return;
    actionLock.current = true;
    setBusy(true); setError(""); setReport(undefined); setOperation("批量调整优先级");
    // Capture the visible IDs now. A later filter change never adds hidden tasks.
    const ids = priorityTargets.map(job => job.id);
    try {
      const response = await call("jobs.priority", { ids, priority }) as BulkPriorityResult;
      setReport(response.results);
      const succeeded = new Set(response.results.filter(result => result.ok).map(result => result.id));
      setSelected(previous => previous.filter(id => !succeeded.has(id)));
    } catch (e) { setError(errorText(e)); } finally { actionLock.current = false; setBusy(false); }
  }
  function resetFilters() { setQuery(""); setProject(""); setFilter("all"); }
  function card(job: Job) {
    const pending = snapshot.approvals.filter(item => item.jobId === job.id && !item.responsePending);
    const lane = taskLane(job, snapshot.approvals);
    const blockers = dependencyBlockers(job, snapshot.jobs);
    return <article key={job.id} className={`task-work-card lane-${lane} ${selected.includes(job.id) ? "is-selected" : ""}`} data-testid={`task-card-${job.id}`}>
      <div className="tw-card-top">
        <input type="checkbox" aria-label={t("选择任务：{title}", { title: job.title })} disabled={busy || !eligible.includes(job)} checked={selected.includes(job.id)} onChange={event => setSelected(ids => event.target.checked ? [...new Set([...ids, job.id])].slice(-100) : ids.filter(id => id !== job.id))} />
        <span className={`tw-state state-${job.state}`}><i />{job.autoRecovery ? t("正在自动恢复") : t(labels[job.state])}</span>
        <time title={formatDate(job.updatedAt)}>{formatDate(job.updatedAt)}</time>
      </div>
      <button className="tw-card-title" onClick={() => open(job)}>{job.title}<ArrowUpRight size={15} /></button>
      <div className="tw-card-project" title={job.projectCwd || job.cwd}><Folder size={13}/><span>{basename(job.projectCwd || job.cwd)}</span>{job.queuedMessages?.length ? <span className="tw-queue-count">{t("待发送 {count}", { count: job.queuedMessages.length })}</span> : null}</div>
      {pending.length > 0 && <button className="tw-approval" onClick={() => open(job)}><CircleAlert size={14}/>{t("{count} 项请求等待你回应", { count: pending.length })}<ArrowUpRight size={13}/></button>}
      {job.workflow && <button className="tw-workflow" onClick={() => setWorkflowReport(job.workflow!.id)} title={t("工作流交付报告")}><GitBranch size={13}/><span>{job.workflow.title}</span><small>{job.workflow.step}/{job.workflow.total}</small></button>}
      {dispatchHeld(snapshot, job, snapshot.platform) && ["queued", "waiting"].includes(job.state) && <p className="tw-hold"><Pause size={12}/>{t("调度已暂停")}</p>}
      {blockers.length > 0 && <p className="tw-hold">{t("等待 {count} 项完成", { count: blockers.length })}</p>}
      {job.lastError && !job.autoRecovery && <p className="tw-card-error" title={job.lastError}>{job.lastError}</p>}
      {job.autoRecovery && <RecoveryNotice job={job} />}
      <div className="tw-card-bottom">
        <select data-testid={`task-priority-${job.id}`} aria-label={t("任务优先级：{title}", { title: job.title })} value={job.priority || "normal"} disabled={busy || !!priorityRejection(job)} onChange={event => void action("chat.priority", { id: job.id, priority: event.target.value })}>
          <option value="high">{t("优先执行")}</option><option value="normal">{t("普通优先级")}</option><option value="low">{t("空闲时执行")}</option>
        </select>
        <div className="tw-card-actions">
          {["queued", "waiting", "paused"].includes(job.state) && <button className="tw-icon" onClick={() => setEditing(job)} title={t("设置前置任务")} aria-label={t("设置前置任务")}><GitBranch size={14}/></button>}
          {canControlTask(job, "pause") && <button data-testid={`task-pause-${job.id}`} disabled={busy} onClick={() => void run("pause", [job])} title={t("暂停任务")} aria-label={t("暂停任务")}><Pause size={14}/></button>}
          {canControlTask(job, "resume") && <button data-testid={`task-resume-${job.id}`} disabled={busy} onClick={() => void run("resume", [job])} title={t("恢复任务")} aria-label={t("恢复任务")}><Play size={14}/></button>}
        </div>
      </div>
      {!!job.dependsOn?.length && <details className="tw-details"><summary>{t("前置任务")} <ChevronDown size={12}/></summary><p>{job.dependsOn.map(id => snapshot.jobs.find(item => item.id === id)?.title || t("已删除的任务")).join(" → ")}</p></details>}
    </article>;
  }
  if (deliveryCenter) return <DeliveryCenter snapshot={snapshot} call={call} open={open} back={() => setDeliveryCenter(false)}/>;
  if (cockpit) return <OperationsCenter snapshot={snapshot} call={call} open={open} back={() => setCockpit(false)} approval={approval} manage={manage}/>;
  return <main className="task-center task-workspace">
    <header className="tw-header"><div className="tw-heading"><span className="tw-eyebrow"><ListTodo size={14}/>{t("项目执行工作台")}</span><h1>{t("任务中心")}</h1><p>{t("把待办变成进展，让需要你的任务先被看见。")}</p></div><div className="tw-header-actions"><button onClick={close}><ArrowLeft size={15}/>{t("返回聊天")}</button><button className="tw-primary workflow-trigger" onClick={() => setBuilding(true)}><Plus size={16}/>{t("新建工作流")}</button></div></header>
    <nav className="tw-tools" aria-label={t("任务工作台工具")}><button onClick={() => setDeliveryCenter(true)}><CheckCheck size={15}/>{t("交付中心")}</button><button onClick={() => setCockpit(true)}><SlidersHorizontal size={15}/>{t("任务运行台")}</button><button onClick={() => setCheckpoints(true)}><GitBranch size={15}/>{t("工作区检查点")}</button><span className={`tw-dispatch-state ${snapshot.dispatch?.paused ? "is-paused" : ""}`}><i/>{t(snapshot.dispatch?.paused ? "调度已暂停" : "自动调度已开启")}</span></nav>
    <details className="tw-dispatch"><summary><SlidersHorizontal size={14}/>{t("调度与并发设置")}<ChevronDown size={14}/></summary><div className="tw-dispatch-content"><p>{t("暂停调度只阻止新任务启动，当前任务会继续完成。设置在重启后保留。")}</p><button disabled={busy} onClick={() => void action("scheduler.dispatch", { paused: !snapshot.dispatch?.paused })}>{t(snapshot.dispatch?.paused ? "开启全局调度" : "暂停全局调度")}</button>{project && <><button disabled={busy} onClick={() => void action("scheduler.dispatch", { paused: !projectPaused, cwd: project })}>{t(projectPaused ? "开启此项目调度" : "暂停此项目调度")}</button><label>{t("项目并发上限")}<select disabled={busy} value={projectLimit(snapshot, { cwd: project }, snapshot.platform) || ""} onChange={event => void action("scheduler.projectLimit", { cwd: project, limit: event.target.value ? Number(event.target.value) : null })}><option value="">{t("跟随全局上限")}</option>{[1,2,3,4,5,6,7,8].map(n => <option value={n} key={n}>{n}</option>)}</select></label><small>{t("降低上限不会中断正在运行的任务；名额释放后自动继续排队任务。")}</small></>}</div></details>
    <div className="tw-filters"><label className="tw-search"><Search size={16}/><input aria-label={t("搜索任务")} placeholder={t("搜索任务、项目或工作流")} value={query} onChange={event => setQuery(event.target.value)}/>{query && <button onClick={() => setQuery("")} aria-label={t("清除搜索")}><X size={14}/></button>}</label><select aria-label={t("筛选项目")} value={project} onChange={event => setProject(event.target.value)}><option value="">{t("全部项目")}</option>{projects.map(cwd => <option key={cwd} value={cwd}>{cwd}</option>)}</select><select data-testid="task-sort" aria-label={t("任务排序")} value={view.sort} onChange={event => setView(previous => ({ ...previous, sort: event.target.value as TaskSort }))}><option value="priority">{t("按优先级")}</option><option value="recent">{t("最近更新")}</option><option value="oldest">{t("最早创建")}</option></select><div className="tw-view-switch" role="group" aria-label={t("任务视图")}><button data-testid="task-layout-list" aria-pressed={view.layout === "list"} title={t("列表视图")} aria-label={t("列表视图")} onClick={() => setView(previous => ({ ...previous, layout: "list" }))}><List size={17}/></button><button data-testid="task-layout-board" aria-pressed={view.layout === "board"} title={t("看板视图")} aria-label={t("看板视图")} onClick={() => setView(previous => ({ ...previous, layout: "board" }))}><Columns3 size={17}/></button></div></div>
    <div className="tw-filter-tabs" role="group" aria-label={t("任务状态筛选")}>{filters.map(item => <button key={item.value} data-testid={`task-filter-${item.value}`} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{t(item.label)}<span>{scoped.filter(job => matchesTaskFilter(job, item.value, snapshot.approvals)).length}</span></button>)}</div>
    <div className="tw-selection"><label><input type="checkbox" aria-label={t("选择当前列表")} disabled={busy || !eligible.length} checked={eligible.length > 0 && eligible.every(job => selected.includes(job.id))} onChange={event => setSelected(event.target.checked ? eligible.slice(0,100).map(job => job.id) : selected.filter(id => !eligible.some(job => job.id === id)))}/>{t("显示 {count} 项任务", { count: filtered.length })}</label>{selected.length > 0 && <><span>{t("已选择 {count} 项", { count: targets.length })}</span><button disabled={busy || !pauseTargets.length} onClick={() => void run("pause", pauseTargets)}><Pause size={13}/>{t("暂停所选")} ({pauseTargets.length})</button><button disabled={busy || !resumeTargets.length} onClick={() => void run("resume", resumeTargets)}><Play size={13}/>{t("恢复所选")} ({resumeTargets.length})</button><label className="tw-bulk-priority">{t("批量优先级")}<select data-testid="task-bulk-priority" aria-label={t("批量优先级")} disabled={busy || !priorityTargets.length} value={priority} onChange={event => setPriority(event.target.value as TaskPriority)}><option value="high">{t("优先执行")}</option><option value="normal">{t("普通优先级")}</option><option value="low">{t("空闲时执行")}</option></select></label><button data-testid="task-bulk-priority-apply" disabled={busy || !priorityTargets.length} onClick={() => void setPriorities()}>{t("应用到 {count} 项", { count: priorityTargets.length })}</button><button disabled={busy} onClick={() => setSelected([])}>{t("清除选择")}</button></>}{hiddenSelection > 0 && <small>{t("另有 {count} 项选择已被筛选隐藏", { count: hiddenSelection })}</small>}</div>
    {busy && <p className="tw-operation" role="status">{t("正在执行：{operation}", { operation: t(operation) })}</p>}
    {error && <p className="tw-error" role="alert"><strong>{t(operation)}</strong> · {error}</p>}
    {report && <div role="status" className="task-report tw-result"><strong>{t(operation)}</strong><p>{t("已完成 {ok} 项，失败 {failed} 项", { ok: report.filter(item => item.ok).length, failed: report.filter(item => !item.ok).length })}</p>{report.filter(item => !item.ok).map(item => <p key={item.id}>{jobs.find(job => job.id === item.id)?.title || item.id}: {errorText(item.error)}</p>)}</div>}
    {!filtered.length ? <section className="tw-empty"><ListTodo size={34}/><h2>{t(jobs.length ? "没有符合条件的任务" : "从一项清晰的工作开始")}</h2><p>{t(jobs.length ? "调整搜索或筛选，找到下一步要推进的任务。" : "创建工作流串联多个步骤，或回到聊天开始一项任务。")}</p><button className="tw-primary" onClick={jobs.length ? resetFilters : () => setBuilding(true)}>{t(jobs.length ? "重置筛选" : "新建工作流")}</button></section> : view.layout === "board" ? <div className="tw-board">{lanes.map(lane => { const items = filtered.filter(job => taskLane(job, snapshot.approvals) === lane.value); return <section key={lane.value} className={`tw-lane lane-${lane.value}`} aria-label={t(lane.label)}><header><span><i/>{t(lane.label)}</span><b>{items.length}</b></header><div className="tw-lane-cards">{items.map(card)}{!items.length && <p className="tw-lane-empty">{t("暂无任务")}</p>}</div></section>; })}</div> : <div className="tw-list">{filtered.map(card)}</div>}
    {checkpoints && <WorkspaceCheckpoints call={call} jobs={jobs} initialCwd={project} initialJob={jobs.find(job => selected.length === 1 && job.id === selected[0])} close={() => setCheckpoints(false)} open={job => { setCheckpoints(false); open(job); }}/>}
    {workflowReport && <WorkflowReport id={workflowReport} call={call} close={() => setWorkflowReport(undefined)}/>}
    {building && <WorkflowBuilder jobs={snapshot.jobs} cwd={project} call={call} close={() => setBuilding(false)}/>}
    {editing && <TaskDependencies job={snapshot.jobs.find(job => job.id === editing.id) || editing} jobs={snapshot.jobs} call={call} close={() => setEditing(undefined)}/>}
  </main>;
}
