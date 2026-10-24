import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, FileCheck2, Download, RefreshCw, Plus } from "lucide-react";
import type { Job, Snapshot } from "../shared/types";
import { deliveryAccepted, type DeliveryCheck } from "../shared/delivery";
import { deliveryPlanContent, type DeliveryPlan, type DeliveryPlanState, type DeliveryBatchState } from "../shared/delivery-center";
import { DeliveryDialog } from "./DeliveryDialog";
import { WorkflowReport } from "./WorkflowReport";
import { Dialog } from "./Dialog";
import { t, useI18n, errorText, formatDate } from "./i18n";
import "./delivery-center.css";

type Call = (name: string, args?: unknown) => Promise<any>;
const batchLabels = {running: "正在检查", completed: "本批次已结束", cancelled: "已取消", interrupted: "已中断"};
const itemLabels = {queued: "等待检查", checking: "正在检查", passed: "检查通过", failed: "检查未通过", unverified: "暂无法验证", skipped: "已跳过", cancelled: "已取消"};
const evidenceLabels = {current: "与验收时一致", changed: "产物已变化", unverified: "当前证据无法确认", noBaseline: "尚无验收基线"};
function jobLabel(job: Job) {
  const d = job.delivery, report = d?.reports.at(-1);
  if (!d?.checks.length) return "未配置验收";
  if (d.pendingCompletion) return "正在验收交付产物";
  if (d.staleEvidence && d.staleEvidence.reportId === report?.id && report) return "交付证据已失效";
  if (!report || report.revision !== d.revision) return "等待交付验收";
  return deliveryAccepted(d) ? "验收通过" : report.status === "failed" ? "验收未通过" : "暂无法验证";
}
const unavailable = (j: Job) => ["preparing", "running", "pausing", "rotating", "watching"].includes(j.state) || !!j.recoveryRequired;
const checkCount = (count: number) => t("验收条件：{count}", {count});
type PlanDraft = {id?: string; name: string; description: string; checks: DeliveryCheck[]; revision: number};
export function DeliveryCenter({snapshot, call, open, back}: {snapshot: Snapshot; call: Call; open: (job: Job) => void; back: () => void}) {
  useI18n();
  const [plans, setPlans] = useState<DeliveryPlanState>(), [history, setHistory] = useState<DeliveryBatchState & {issue?: string}>();
  const [selected, setSelected] = useState<string[]>([]), [project, setProject] = useState(""), [workflow, setWorkflow] = useState("");
  const [query, setQuery] = useState(""), [page, setPage] = useState(0), [planId, setPlanId] = useState("");
  const [batchId, setBatchId] = useState(""), [draft, setDraft] = useState<PlanDraft>(), [editingChecks, setEditingChecks] = useState(false);
  const [jobEditor, setJobEditor] = useState<Job>(), [workflowReport, setWorkflowReport] = useState<string>();
  const [confirm, setConfirm] = useState<"apply" | "verify" | "remove">();
  const [frozen, setFrozen] = useState<{targets: {id: string; title: string; revision: number}[]; plan?: DeliveryPlan; planRevision: number}>({targets: [], planRevision: 0});
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [application, setApplication] = useState<{id: string; applied: boolean; issue?: string}[]>();
  const live = useRef(true), pending = useRef(false), callRef = useRef(call); callRef.current = call;
  const jobs = snapshot.jobs.filter(j => !j.archived);
  const filtered = jobs.filter(j => (!project || (j.projectCwd || j.cwd) === project) && (!workflow || j.workflow?.id === workflow) &&
    `${j.title} ${j.cwd}`.toLowerCase().includes(query.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 30)), shown = filtered.slice(Math.min(page, pages - 1) * 30, (Math.min(page, pages - 1) + 1) * 30);
  const targets = jobs.filter(j => selected.includes(j.id)), configured = targets.filter(j => j.delivery?.checks.length);
  const plan = plans?.items.find(p => p.id === planId);
  const active = history?.batches.find(b => b.status === "running"), batch = history?.batches.find(b => b.id === batchId) ?? history?.batches.at(-1);
  const applyHistory = (value: DeliveryBatchState & {issue?: string}) => setHistory(old => !old || value.revision >= old.revision ? value : old);
  useEffect(() => {setPage(p => Math.min(p, pages - 1));}, [pages]);
  useEffect(() => {
    live.current = true;
    void Promise.allSettled([callRef.current("delivery.plans"), callRef.current("delivery.batches")]).then(results => {
      if (!live.current) return;
      if (results[0].status === "fulfilled") setPlans(results[0].value); else setError(errorText(results[0].reason));
      if (results[1].status === "fulfilled") applyHistory(results[1].value); else setError(errorText(results[1].reason));
    });
    const timer = setInterval(() => {
      if (pending.current) return;
      void callRef.current("delivery.batches").then(v => {if (live.current) applyHistory(v);}).catch(e => {if (live.current) setError(errorText(e));});
    }, 2000);
    return () => {live.current = false; clearInterval(timer);};
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(""); setNotice("");
    try {await action();} catch (e) {if (live.current) setError(errorText(e));}
    finally {pending.current = false; if (live.current) setBusy(false);}
  };
  const ask = (kind: "apply" | "verify" | "remove") => {
    setError(""); setFrozen({targets: (kind === "verify" ? configured : targets).map(j => ({id: j.id, title: j.title, revision: j.delivery?.revision || 0})),
      plan: plan ? structuredClone(plan) : undefined, planRevision: plans?.revision || 0});
    setConfirm(kind);
  };
  const begin = (mode: "inspect" | "verify", chosen = configured.map(j => ({id: j.id, revision: j.delivery!.revision}))) => run(async () => {
    const result = await call("delivery.batch.start", {mode, targets: chosen.map(({id, revision}) => ({id, revision}))});
    if (live.current) {setBatchId(result.id); applyHistory(await call("delivery.batches")); setConfirm(undefined);}
  });
  const editPlan = (value?: DeliveryPlan) => {
    if (!plans) return;
    setError("");
    setDraft(value ? {...structuredClone(value), revision: plans.revision} : {name: "", description: "", checks: structuredClone(targets[0]?.delivery?.checks || []), revision: plans.revision});
  };
  const download = () => run(async () => {
    const value = await call("delivery.batch.export", batch!.id), url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: "application/json"}));
    const link = document.createElement("a"); link.href = url; link.download = `delivery-batch-${batch!.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  return <main className="delivery-center">
    <header><div><h1><FileCheck2 size={24}/>{t("交付中心")}</h1><p>{t("复用验收方案，检查产物变化，集中核对工作流证据。")}</p></div><button onClick={back}><ArrowLeft size={16}/>{t("返回任务中心")}</button></header>
    <p className="dc-note">{t("通过记录证明验收当时的文件。检测证据会重新读取完整文件；发现变化或无法确认时，使旧证据失效并阻止新的依赖任务启动。")}</p>
    {error && <p role="alert" className="dc-error">{error}</p>}{history?.issue && <p role="alert" className="dc-error">{t(history.issue)}</p>}{notice && <p role="status">{notice}</p>}
    <section className="dc-filters">
      <input aria-label={t("搜索交付任务")} placeholder={t("搜索交付任务")} value={query} onChange={e => {setQuery(e.target.value); setPage(0);}}/>
      <select aria-label={t("筛选项目")} value={project} onChange={e => {setProject(e.target.value); setPage(0);}}><option value="">{t("全部项目")}</option>{[...new Set(jobs.map(j => j.projectCwd || j.cwd))].map(p => <option key={p} value={p}>{p}</option>)}</select>
      <select aria-label={t("筛选工作流")} value={workflow} onChange={e => {setWorkflow(e.target.value); setPage(0);}}><option value="">{t("全部工作流")}</option>{[...new Map(jobs.filter(j => j.workflow).map(j => [j.workflow!.id, j.workflow!])).values()].map(w => <option key={w.id} value={w.id}>{w.title}</option>)}</select>
      {workflow && <button onClick={() => setWorkflowReport(workflow)}>{t("工作流交付报告")}</button>}
    </section>
    {targets.length > 100 && <p role="status">{t("每批最多处理 100 项任务，请减少选择。文件仍会完整读取。")}</p>}
    <section className="dc-toolbar"><span>{t("已选 {count} 项", {count: targets.length})}</span>
      <button disabled={busy || !shown.some(j => !unavailable(j))} onClick={() => setSelected(old => [...new Set([...old, ...shown.filter(j => !unavailable(j)).map(j => j.id)])])}>{t("选择本页")}</button><button onClick={() => setSelected([])} disabled={busy}>{t("清空选择")}</button>
      <button disabled={busy || !!active || !configured.length || configured.length > 100 || !!history?.issue} onClick={() => void begin("inspect")}>{t("检测交付证据")}</button>
      <button disabled={busy || !!active || !configured.length || configured.length > 100 || !!history?.issue} onClick={() => ask("verify")}>{t("批量重新验收")}</button>
    </section>
    <div className="dc-task-list">{shown.map(job => <article key={job.id}>
      <label><input type="checkbox" aria-label={job.title} disabled={busy || unavailable(job)} checked={selected.includes(job.id)} onChange={e => setSelected(old => e.target.checked ? [...new Set([...old, job.id])] : old.filter(id => id !== job.id))}/><button onClick={() => open(job)}>{job.title}</button></label>
      <span className={job.delivery?.staleEvidence ? "dc-stale" : ""}>{t(jobLabel(job))}</span><span>{checkCount(job.delivery?.checks.length || 0)}</span>
      <button onClick={() => setJobEditor(job)}>{t("验收条件")}</button>
      <small>{job.workflow ? `${job.workflow.title} · ${job.workflow.step}/${job.workflow.total}` : job.projectCwd || job.cwd}</small>
      {job.delivery?.reports.at(-1) && <small>{t("上次验收")}: {formatDate(job.delivery.reports.at(-1)!.finishedAt)}</small>}
    </article>)}</div>
    {!shown.length && <p className="dc-note">{t("没有匹配的交付任务")}</p>}
    <div className="dc-pages"><button disabled={page <= 0} onClick={() => setPage(p => p - 1)}>{t("上一页")}</button><span>{Math.min(page, pages - 1) + 1} / {pages}</span><button disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>{t("下一页")}</button></div>
    <section className="dc-plans"><h2>{t("可复用验收方案")}</h2><p className="dc-note">{t("方案只包含验收条件，应用时不会替换任务提示词、模型或聊天草稿。路径仍相对于各任务目录。")}</p>
      <div className="dc-toolbar"><select aria-label={t("选择验收方案")} value={planId} onChange={e => setPlanId(e.target.value)}><option value="">{t("选择验收方案")}</option>{plans?.items.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button disabled={!plans || busy} onClick={() => editPlan()}><Plus size={15}/>{t("新建验收方案")}</button><button disabled={!plan || busy} onClick={() => editPlan(plan)}>{t("编辑方案")}</button>
        <button disabled={!plan || !targets.length || targets.length > 100 || busy || !!active} onClick={() => ask("apply")}>{t("应用到所选任务")}</button>
        <button disabled={!plan || busy} onClick={() => ask("remove")}>{t("删除方案")}</button>
        <button disabled={busy} onClick={() => void run(async () => {setPlans(await call("delivery.plans")); applyHistory(await call("delivery.batches"));})}><RefreshCw size={14}/>{t("刷新")}</button>
      </div>{plan && <p>{plan.description} · {checkCount(plan.checks.length)}</p>}
      {application && <div role="status">{application.map(a => <p key={a.id}>{jobs.find(j => j.id === a.id)?.title || a.id} · {t(a.applied ? "方案已应用" : "应用未完成")}{a.issue && ` · ${t(a.issue)}`}</p>)}</div>}
    </section>
    <section className="dc-history"><h2>{t("批量验收记录")}</h2><div className="dc-toolbar"><select aria-label={t("选择验收批次")} value={batch?.id || ""} onChange={e => setBatchId(e.target.value)}>{history?.batches.slice().reverse().map(b => <option key={b.id} value={b.id}>{formatDate(b.createdAt)} · {t(b.mode === "inspect" ? "证据检测" : "重新验收")} · {b.items.length}</option>)}</select>
      {batch && <><button disabled={busy} onClick={() => void download()}><Download size={15}/>{t("导出批次证据")}</button>{batch.status === "running" && <button disabled={busy} onClick={() => void run(async () => applyHistory(await call("delivery.batch.cancel", batch.id)))}>{t("取消本批次")}</button>}</>}
    </div>{batch ? <><p role="status">{t(batchLabels[batch.status])} · {batch.items.filter(i => !["queued", "checking"].includes(i.status)).length}/{batch.items.length}</p>
      {batch.items.map(item => <details key={item.id} className="dc-result"><summary><strong>{item.title || item.id}</strong><span data-status={item.status}>{t(itemLabels[item.status])}</span>{item.comparison && <span>{t(evidenceLabels[item.comparison.status])}</span>}</summary>
        {item.issue && <p>{t(item.issue)}</p>}{item.workflow && <p>{item.workflow.title} · {item.workflow.step}/{item.workflow.total}</p>}
        {item.comparison?.status === "changed" && batch.mode === "verify" && item.status === "passed" && <p>{t("产物已变化，本次已重新验收通过。")}</p>}
        {item.report?.findings.map((f, i) => <div key={i} className="dc-finding"><strong>{f.check.label}</strong><code>{f.check.path}</code><span>{t(f.status === "passed" ? "条件满足" : f.status === "failed" ? "验收未通过" : "暂无法验证")}</span>{f.sha256 && <code>SHA256 {f.sha256}</code>}{f.bytes !== undefined && <span>{f.bytes.toLocaleString()} B</span>}</div>)}
      </details>)}</> : <p className="dc-note">{t("暂无批量验收记录")}</p>}</section>
    {confirm && <Dialog title={t("确认交付操作")} busy={busy} onClose={() => setConfirm(undefined)}><div className="dc-confirm">
      <h2>{t(confirm === "apply" ? "替换所选任务的验收条件" : confirm === "verify" ? "重新验收并更新调度" : "删除验收方案")}</h2>
      <p>{confirm === "verify" ? t("验收通过会更新任务证据，并可能恢复之前等待的消息和依赖任务。") : confirm === "apply" ? `${frozen.plan?.name} · ${t("已选 {count} 项", {count: frozen.targets.length})} · ${checkCount(frozen.plan?.checks.length || 0)}` : frozen.plan?.name}</p>
      {error && <p role="alert" className="dc-error">{error}</p>}
      {confirm !== "remove" && <ul>{frozen.targets.map(j => <li key={j.id}>{j.title}</li>)}</ul>}
      <button disabled={busy} onClick={() => confirm === "verify" ? void begin("verify", frozen.targets) : void run(async () => {
        if (confirm === "apply") {const result = await call("delivery.plan.apply", {planId: frozen.plan!.id, planRevision: frozen.planRevision, targets: frozen.targets.map(({id, revision}) => ({id, revision}))}); setApplication(result.results);}
        else {setPlans(await call("delivery.plan.remove", {id: frozen.plan!.id, revision: frozen.planRevision})); setPlanId("");}
        setConfirm(undefined);
      })}>{t("确认执行")}</button><button disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button>
    </div></Dialog>}
    {draft && <Dialog title={t("编辑验收方案")} busy={busy} onClose={() => setDraft(undefined)}><div className="dc-plan-editor"><h2>{t("编辑验收方案")}</h2>
      <label>{t("方案名称")}<input disabled={busy} value={draft.name} maxLength={120} onChange={e => setDraft({...draft, name: e.target.value})}/></label><label>{t("方案说明")}<textarea disabled={busy} value={draft.description} maxLength={2000} onChange={e => setDraft({...draft, description: e.target.value})}/></label>
      <p>{checkCount(draft.checks.length)}</p><button disabled={busy} onClick={() => setEditingChecks(true)}>{t("编辑验收条件")}</button>
      {error && <p role="alert" className="dc-error">{error}</p>}
      <button disabled={busy} onClick={() => void run(async () => {
        const parsed = deliveryPlanContent.safeParse({name: draft.name, description: draft.description, checks: draft.checks});
        if (!parsed.success) throw Error(t("请填写方案名称，并至少设置一项有效验收条件。"));
        const value = await call("delivery.plan.save", {revision: draft.revision, ...(draft.id ? {id: draft.id} : {}), plan: parsed.data});
        setPlans(value); setPlanId(draft.id || value.items.at(-1).id); setDraft(undefined);
      })}>{t("保存验收方案")}</button>
    </div></Dialog>}
    {draft && editingChecks && <DeliveryDialog purpose="plan" initial={draft.checks} call={call} saveDraft={checks => setDraft({...draft, checks})} close={() => setEditingChecks(false)}/>}
    {jobEditor && <DeliveryDialog job={snapshot.jobs.find(j => j.id === jobEditor.id) || jobEditor} call={call} close={() => setJobEditor(undefined)}/>}
    {workflowReport && <WorkflowReport id={workflowReport} call={call} close={() => setWorkflowReport(undefined)}/>}
  </main>;
}
