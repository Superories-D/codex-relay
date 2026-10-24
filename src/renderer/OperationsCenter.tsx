import React,{useEffect,useRef,useState} from "react";
import { Activity,ArrowLeft,ArrowUpRight,CheckCheck,Clock3,History,RefreshCw,ShieldAlert } from "lucide-react";
import type { Job,Snapshot,Approval } from "../shared/types";
import type { OperationPage,OperationEvent,RecordingStatus } from "../shared/operations";
import type { operationCard,OperationGateCode,AccountGateCode } from "../core/operations";
import type { VaultReferences } from "../shared/vault";
import type { TelegramReceipt,TelegramView } from "../shared/telegram-notifications";
import { DeliveryDialog } from "./DeliveryDialog";
import { DeliveryVault } from "./DeliveryVault";
import { TelegramSettings } from "./TelegramSettings";
import { WorkflowReport } from "./WorkflowReport";
import {RecoveryPanel} from "./RecoveryPanel";
import { Dialog } from "./Dialog";
import { t,useI18n,errorText,formatDate } from "./i18n";
import "./operations.css";
type Card=ReturnType<typeof operationCard>;
type View={at:number;cards:Card[];recording:RecordingStatus};
type Call=(name:string,args?:unknown)=>Promise<any>;
const states:Record<string,string>={queued:"排队中",preparing:"连接中",running:"正在工作",pausing:"正在停止",rotating:"自动切换账户",waiting:"等待可用额度",watching:"监控中",paused:"已暂停",needs_attention:"需要处理",completed:"本轮完成",cancelled:"已取消"};
const gates:Record<OperationGateCode,string>={cli:"等待 CLI 就绪",closing:"应用正在安全退出",maintenance:"调度正在维护",warmupRecovery:"正在核实后台进程归属",ownership:"等待进程归属恢复",handoff:"等待已有会话交接",recovery:"正在恢复原会话",globalDispatch:"全局调度已暂停",projectDispatch:"项目调度已暂停",dependencies:"前置任务尚未释放",family:"同一会话家族尚未释放",control:"等待控制操作结束",globalCapacity:"并发任务名额已满",projectCapacity:"项目并发名额已满",accounts:"当前没有可选账户",delivery:"交付证据尚未通过"};
const accounts:Record<AccountGateCode,string>={disabled:"账户未参与轮换",reauth:"账户需要重新登录",offline:"账户暂时离线",expired:"登录凭据已过期",ownership:"账户运行目录被占用",warmup:"后台开窗尚未确认安全",cooldown:"账户正在等待复查",model:"账户不支持所选模型",quotaMissing:"尚无有效额度证据",quotaStale:"额度证据需要刷新",quotaSpent:"已观察到额度耗尽"};
const requestKinds:Record<Approval["kind"],string>={command:"命令审批",file:"文件修改审批",input:"等待回答",permissions:"权限申请",elicitation:"工具请求输入",unsupported:"不支持的请求"};
const changes:Record<string,string>={added:"任务加入记录",state:"运行状态变化",active:"运行归属状态变化",controlling:"控制操作变化",requests:"待处理请求变化",acceptance:"交付证据变化",recovery:"恢复状态变化",intent:"用户停止意图变化",accountId:"运行账户变化",rotations:"轮换次数变化",queued:"排队消息变化",workflow:"工作流来源变化",title:"任务名称变化",archived:"归档状态变化",waitingFor:"等待原因变化",project:"项目名称变化",projectKey:"项目位置变化",familyId:"会话家族变化",removed:"任务已从列表移除",missingAtStart:"启动时任务已不在列表",dispatch:"调度设置变化"};
const receipts:Record<TelegramReceipt["status"],string>={pending:"等待发送",sending:"正在发送",sent:"已发送",failed:"发送失败",uncertain:"结果未知",cancelled:"已取消"};
const recoveryKinds={scheduled:"恢复已安排",resumed:"原会话已继续",stopped:"恢复已停止",completed:"恢复后本轮完成"};
const attention=(c:Card)=>c.approvals.length>0||c.state==="needs_attention"||c.state==="completed"&&c.acceptance==="held";
function Related({ids,snapshot,choose}:{ids:string[];snapshot:Snapshot;choose:(id:string)=>void}){
  const [expanded,setExpanded]=useState(false);return <div className="ops-related">{(expanded?ids:ids.slice(0,8)).map(id=><button key={id} onClick={()=>choose(id)}>{snapshot.jobs.find(j=>j.id===id)?.title||id}<ArrowUpRight size={12}/></button>)}{ids.length>8&&<button onClick={()=>setExpanded(v=>!v)}>{t(expanded?"收起":"展开全部 {count} 项",{count:ids.length})}</button>}</div>;
}
export function OperationsCenter({snapshot,call,open,back,approval,manage}:{snapshot:Snapshot;call:Call;open:(job:Job)=>void;back:()=>void;approval?:(a:Approval,respond:(v:unknown)=>void)=>React.ReactNode;manage?:(section:string)=>void}){
  useI18n();
  const [view,setView]=useState<View>(),[selected,setSelected]=useState(""),[last,setLast]=useState<{id:string;title:string;familyId?:string}>();
  const [filter,setFilter]=useState("all"),[query,setQuery]=useState(""),[page,setPage]=useState(0),[archived,setArchived]=useState(false);
  const [trail,setTrail]=useState<OperationPage>(),[trailScope,setTrailScope]=useState("all"),[trailBusy,setTrailBusy]=useState(false),[trailError,setTrailError]=useState("");
  const [historyPositions,setHistoryPositions]=useState<OperationPage["position"][]>([]),[historyIndex,setHistoryIndex]=useState(0);
  const [error,setError]=useState(""),[busy,setBusy]=useState(false),[review,setReview]=useState<Approval>();
  const [delivery,setDelivery]=useState<Job>(),[vault,setVault]=useState<{id?:string}>(),[telegram,setTelegram]=useState(false);
  const [workflowReport,setWorkflowReport]=useState<string>();
  const [recovery,setRecovery]=useState(false);
  const [references,setReferences]=useState<VaultReferences>(),[notices,setNotices]=useState<TelegramReceipt[]>(),[linksBusy,setLinksBusy]=useState(false),[linksError,setLinksError]=useState("");
  const alive=useRef(true),pending=useRef(false),polling=useRef(false),reads=useRef(0),historyReads=useRef(0),linkReads=useRef(0),callRef=useRef(call);callRef.current=call;
  const cards=view?.cards||[],chosen=cards.find(c=>c.id===selected),current=snapshot.jobs.find(j=>j.id===selected),detail=chosen||last;
  const shown=cards.filter(c=>(archived||!snapshot.jobs.find(j=>j.id===c.id)?.archived)&&`${c.title} ${snapshot.jobs.find(j=>j.id===c.id)?.cwd||""}`.toLowerCase().includes(query.toLowerCase())&&
    (filter==="all"||filter==="review"&&attention(c)||filter==="blocked"&&c.dispatchable&&!c.ready||filter==="working"&&["preparing","running","pausing","rotating"].includes(c.state)||filter==="finished"&&["completed","cancelled"].includes(c.state)));
  const count=Math.max(1,Math.ceil(shown.length/30)),visible=shown.slice(Math.min(page,count-1)*30,(Math.min(page,count-1)+1)*30);
  const choose=(id:string,historical?:{id:string;title:string;familyId?:string})=>{const metadata=cards.find(c=>c.id===id)||historical;setSelected(id);setLast(metadata);if(!selected||!metadata?.familyId)setTrailScope("task");requestAnimationFrame(()=>{const layout=document.querySelector<HTMLElement>(".ops-layout");if(layout&&getComputedStyle(layout).gridTemplateColumns.split(" ").length===1)document.querySelector(".ops-detail")?.scrollIntoView({block:"start"});});};
  const load=async()=>{const ticket=++reads.current;const value=await callRef.current("operations.read");if(alive.current&&reads.current===ticket)setView(value);};
  const run=async(action:()=>Promise<void>)=>{if(pending.current)return;pending.current=true;setBusy(true);setError("");try{await action();}catch(e){if(alive.current)setError(errorText(e));}finally{pending.current=false;if(alive.current)setBusy(false);}};
  useEffect(()=>{alive.current=true;void load().catch(e=>{if(alive.current)setError(errorText(e));});const timer=setInterval(()=>{if(polling.current||pending.current)return;polling.current=true;void load().catch(e=>{if(alive.current)setError(errorText(e));}).finally(()=>{polling.current=false;});},1200);return()=>{alive.current=false;reads.current++;historyReads.current++;linkReads.current++;clearInterval(timer);};},[]);
  const historyArgs=()=>selected&&trailScope!=="all"?trailScope==="family"?{familyId:detail?.familyId||selected}:{taskId:selected}:{};
  const loadHistory=async()=>{
    const ticket=++historyReads.current;setTrailBusy(true);setTrailError("");setHistoryPositions([]);setHistoryIndex(0);setTrail(undefined);
    try{const value=await callRef.current("operations.history",historyArgs());if(alive.current&&ticket===historyReads.current){setTrail(value);setHistoryPositions([value.position]);}}
    catch(e){if(alive.current&&ticket===historyReads.current)setTrailError(errorText(e));}finally{if(alive.current&&ticket===historyReads.current)setTrailBusy(false);}
  };
  useEffect(()=>{void loadHistory();},[selected,trailScope]);
  const loadLinks=async()=>{
    const ticket=++linkReads.current;setReferences(undefined);setNotices(undefined);setLinksError("");if(!selected)return;setLinksBusy(true);
    const result=await Promise.allSettled([callRef.current("vault.references",selected),callRef.current("telegram.read")]);
    if(!alive.current||ticket!==linkReads.current)return;setLinksBusy(false);
    if(result[0].status==="fulfilled")setReferences(result[0].value);else setLinksError(errorText(result[0].reason));
    if(result[1].status==="fulfilled")setNotices((result[1].value as TelegramView).receipts.filter(r=>r.jobId===selected));else setLinksError(errorText(result[1].reason));
  };
  useEffect(()=>{void loadLinks();},[selected]);
  const nextHistory=async()=>{
    if(!trail?.cursor||trailBusy)return;const ticket=++historyReads.current;setTrailBusy(true);setTrailError("");
    try{const value=await call("operations.history",{...historyArgs(),cursor:trail.cursor});if(alive.current&&ticket===historyReads.current){setTrail(value);setHistoryPositions(old=>[...old.slice(0,historyIndex+1),value.position]);setHistoryIndex(i=>i+1);}}
    catch(e){if(alive.current&&ticket===historyReads.current)setTrailError(errorText(e));}finally{if(alive.current&&ticket===historyReads.current)setTrailBusy(false);}
  };
  const previousHistory=async()=>{
    if(!historyIndex||trailBusy)return;const ticket=++historyReads.current;setTrailBusy(true);setTrailError("");
    try{const value=await call("operations.history",{...historyArgs(),cursor:historyPositions[historyIndex-1]});if(alive.current&&ticket===historyReads.current){setTrail(value);setHistoryIndex(i=>i-1);}}
    catch(e){if(alive.current&&ticket===historyReads.current)setTrailError(errorText(e));}finally{if(alive.current&&ticket===historyReads.current)setTrailBusy(false);}
  };
  const liveReview=review&&snapshot.approvals.find(a=>a.jobId===review.jobId&&a.id===review.id&&a.reviewId===review.reviewId);
  const event=(e:OperationEvent)=><article className="ops-event" key={e.seq}><span className="ops-event-dot"/><div><header><strong>{t(e.kind==="session"?"开始记录本次应用会话":e.kind==="baseline"?"启动时观察":e.kind==="removed"?"任务已从列表移除":e.kind==="dispatch"?"调度设置变化":"已记录状态变化")}</strong><time>{formatDate(e.at)}</time></header>
    {e.title&&<button className="ops-event-task" onClick={()=>choose(e.taskId!,{id:e.taskId!,title:e.title!,familyId:e.current?.familyId||e.previous?.familyId})}>{e.title}</button>}{e.gap&&<p>{t("与上次记录之间存在应用离线或记录间隔。")}{e.previousAt&&` ${formatDate(e.previousAt)}`}</p>}
    {e.current&&<p>{e.previous&&`${t(states[e.previous.state])} → `}{t(states[e.current.state])} · {e.current.project}</p>}
    {e.current?.workflow&&<p>{e.current.workflow.title} · {e.current.workflow.step}/{e.current.workflow.total}</p>}
    {e.dispatch&&<p>{t(e.dispatch.paused?"全局调度已暂停":"自动调度已开启")}{e.dispatch.projects.length>0&&` · ${e.dispatch.projects.map(p=>p.label).join(", ")}`}</p>}
    <div className="ops-tags">{e.changes.map(c=><span key={c}>{t(changes[c]||c)}</span>)}</div>
    {e.current?.acceptance.reportId&&<details><summary>{t("交付证据来源")}</summary><code>{e.current.acceptance.reportId}</code><p>{t("验收条件版本：{revision}",{revision:e.current.acceptance.revision})}</p></details>}
    {e.current?.recovery.last&&e.changes.includes("recovery")&&<p>{t(recoveryKinds[e.current.recovery.last.kind])} · {t("恢复次数：{count}",{count:e.current.recovery.last.attempt})}</p>}
    {e.current?.requests.length? <details><summary>{t("待处理请求：{count}",{count:e.current.requests.length})}</summary>{e.current.requests.map(r=><p key={`${r.id}:${r.reviewId}`}>{t(requestKinds[r.kind])} · <code>{r.reviewId||r.historyId||r.id}</code></p>)}</details>:null}<small>{t("记录序号")} {e.seq}</small></div></article>;
  return <main className="operations-center">
    <header className="ops-header"><div><p className="ops-eyebrow">{t("WINDOWS 运行现场")}</p><h1><Activity size={25}/>{t("任务运行台")}</h1><p>{t("看清任务为何等待，把需要你的处理与真实证据连接起来。")}</p></div><div className="ops-buttons"><button onClick={()=>void run(async()=>{await load();await loadHistory();})} disabled={busy}><RefreshCw size={15}/>{t("刷新")}</button><button onClick={back}><ArrowLeft size={15}/>{t("返回任务中心")}</button></div></header>
    <div className="ops-buttons"><button onClick={()=>setRecovery(true)}><ShieldAlert size={16}/>{t("查看恢复计划")}</button><span className="ops-caption">{t("核查恢复占用，查看哪些任务可以独立继续。")}</span></div>
    {error&&<p role="alert" className="ops-error">{error}</p>}
    <section className="ops-metrics">{[["all","所有任务",cards.length],["review","需要你处理",cards.filter(attention).length],["blocked","队列有阻塞",cards.filter(c=>c.dispatchable&&!c.ready).length],["working","正在工作",cards.filter(c=>["preparing","running","pausing","rotating"].includes(c.state)).length],["finished","已结束的轮次",cards.filter(c=>["completed","cancelled"].includes(c.state)).length]].map(([key,label,n])=><button key={key} aria-pressed={filter===key} onClick={()=>{setFilter(String(key));setPage(0);}}><strong>{n}</strong><span>{t(String(label))}</span></button>)}</section>
    <div className="ops-layout"><section className="ops-queue"><div className="ops-queue-heading"><h2>{t("当前现场")}</h2><span>{t("按真实调度条件观察")}</span></div><input aria-label={t("搜索运行任务")} placeholder={t("搜索任务或项目")} value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/><label className="ops-archive-toggle"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>{t("包含归档任务")}</label>
      {!view?<p>{t("正在读取")}</p>:!visible.length?<p className="ops-empty">{t("当前筛选下没有任务")}</p>:visible.map(c=><button className="ops-task" data-task-id={c.id} key={c.id} aria-pressed={selected===c.id} onClick={()=>choose(c.id)}><span className="ops-task-title">{c.title}{c.approvals.length>0&&<b>{c.approvals.length}</b>}</span><span>{t(states[c.state])}</span><small>{c.approvals.length?t("有待处理请求"):c.gates.find(g=>g.scope==="admission")?t(gates[c.gates.find(g=>g.scope==="admission")!.code]):c.ready?t("当前条件允许排队启动"):t("查看状态与记录")}</small></button>)}
      <nav className="ops-pages" aria-label={t("任务分页")}><button disabled={page<=0} onClick={()=>setPage(p=>p-1)}>{t("上一页")}</button><span>{Math.min(page,count-1)+1}/{count}</span><button disabled={page>=count-1} onClick={()=>setPage(p=>p+1)}>{t("下一页")}</button></nav>
    </section><section className="ops-detail"><header><div><h2>{detail?.title||t("运行总览")}</h2><p>{chosen?t(states[chosen.state]):selected?t("该任务已不在当前列表，历史记录仍保留。"):t("选择任务查看阻塞、待处理请求和交付来源。")}</p></div><button className="ops-back-to-queue" onClick={()=>document.querySelector(".ops-queue")?.scrollIntoView({block:"start"})}>{t("返回任务列表")}</button>{current&&<button onClick={()=>open(current)}><ArrowUpRight size={15}/>{t("打开原会话")}</button>}</header>
      {current?.workflow&&<div className="ops-buttons"><span>{current.workflow.title} · {current.workflow.step}/{current.workflow.total}</span><button onClick={()=>setWorkflowReport(current.workflow!.id)}>{t("工作流交付报告")}</button></div>}
      {chosen&&<><div className="ops-status-strip"><span>{t(chosen.pausedByUser?"用户已主动暂停":chosen.cancelledByUser?"用户已主动取消":chosen.ready?"当前条件允许排队启动":"保留原任务状态")}</span><small>{t("调度条件是当前观察，不代表进程已经启动。")}</small></div>
      {chosen.approvals.length>0&&<section className="ops-requests"><h3><ShieldAlert size={16}/>{t("等待你的处理")}</h3>{chosen.approvals.map(a=><div key={`${a.id}:${a.reviewId}`}><span>{t(requestKinds[a.kind])}{a.responsePending&&` · ${t("正在等待回复确认")}`}</span><button disabled={busy||!a.reviewId} onClick={()=>void run(async()=>{setReview(await call("operations.request",{jobId:chosen.id,id:a.id,reviewId:a.reviewId}));})}>{t("审阅当前请求")}</button></div>)}</section>}
      <section className="ops-gates"><h3>{t("调度与交付条件")}</h3>{!chosen.gates.length?<p>{t("当前没有观察到额外阻塞。")}</p>:chosen.gates.map(g=><article key={g.code}><div><strong>{t(gates[g.code])}</strong><span>{t(g.scope==="admission"?"影响队列启动":"需要核对的证据")}</span></div>{g.related.length>0&&<Related ids={g.related} snapshot={snapshot} choose={choose}/>}</article>)}
        {chosen.accountReasons&&<div className="ops-account-reasons">{Object.entries(chosen.accountReasons).map(([key,n])=><p key={key}>{t(accounts[key as AccountGateCode])}<strong>{n}</strong></p>)}{manage&&<button onClick={()=>manage("accounts")}>{t("检查账户与额度")}</button>}</div>}
        {chosen.nextWakeAt&&<p>{t("下次核实时间")}: {formatDate(chosen.nextWakeAt)}</p>}
      </section></>}
      {selected&&<section className="ops-evidence"><div className="ops-section-heading"><h3><CheckCheck size={16}/>{t("交付与通知来源")}</h3><button disabled={linksBusy} onClick={()=>void loadLinks()}>{t("重新读取来源")}</button></div>
        <div className="ops-buttons">{current?.delivery&&<button onClick={()=>setDelivery(current)}>{t("查看当前交付证据")}</button>}<button onClick={()=>setVault({})}>{t("交付保险库")}</button><button onClick={()=>setTelegram(true)}>{t("Telegram 通知记录")}</button></div>
        {linksBusy&&<p>{t("正在核对保存版本的清单来源…")}</p>}{linksError&&<p role="alert" className="ops-error">{linksError}</p>}
        {references?.unreadable.length? <p className="ops-error">{t("部分版本清单无法读取，请在保险库复核。")}</p>:null}
        {references?.matches.map(v=><div className="ops-saved-reference" key={v.id}><button onClick={()=>setVault({id:v.id})}>{v.title}<ArrowUpRight size={12}/></button><small>{t("保存时的验收条件版本：{revision}",{revision:v.revision})}</small><code>{v.reportId}</code></div>)}
        {references&&!references.matches.length&&!references.unreadable.length&&<p>{t("尚未找到关联的保存版本。")}</p>}
        {notices?.map(r=><details className="ops-receipt" key={r.id}><summary>{t("Telegram 回执")} · {t(receipts[r.status])} · {formatDate(r.updatedAt)}</summary><p>{r.text}</p>{r.issue&&<p>{t(r.issue)}</p>}<code>{r.id}</code></details>)}
        {notices&&!notices.length&&<p>{t("当前没有此任务的 Telegram 回执。")}</p>}<small>{t("保存版本记录验收当时的来源；通知入队不代表已经送达。")}</small>
      </section>}
      <section className="ops-history"><div className="ops-section-heading"><h3><History size={16}/>{t("可追溯运行历史")}</h3><div className="ops-buttons"><select aria-label={t("历史范围")} value={trailScope} onChange={e=>setTrailScope(e.target.value)}><option value="task" disabled={!selected}>{t("当前任务")}</option><option value="family" disabled={!detail?.familyId}>{t("会话家族")}</option><option value="all">{t("全部历史")}</option></select><button disabled={trailBusy} onClick={()=>void loadHistory()}><RefreshCw size={13}/>{t("刷新历史")}</button></div></div>
        <p className="ops-caption">{t("历史保留启用记录后观察到的变化；重启时只记录当时所见，不补造过去的完成事件。")}</p>
        {view?.recording&&<div className="ops-recording" data-phase={view.recording.phase}><Clock3 size={14}/><span>{t(view.recording.phase==="recording"?"运行历史正在记录":view.recording.phase==="starting"?"运行历史正在启动":view.recording.phase==="failed"?"运行历史记录已暂停":"运行历史已关闭")}{view.recording.pending>0&&` · ${t("等待写入 {count} 条",{count:view.recording.pending})}`}</span>{view.recording.lastAt&&<small>{t("最近落盘")}: {formatDate(view.recording.lastAt)}</small>}</div>}
        {view?.recording.issue&&<p className="ops-error" role="alert">{t(view.recording.issue)} <button disabled={busy} onClick={()=>void run(async()=>{await call("operations.recording.retry");await load();await loadHistory();})}>{t("重新启用记录")}</button></p>}
        {trailError&&<p role="alert" className="ops-error">{trailError}</p>}{trailBusy&&<p role="status">{t("正在读取历史…")}</p>}
        {!trailBusy&&!trail?.events.length&&!trailError&&<p className="ops-empty">{t("此范围尚无已保存的运行事件。")}</p>}<div className="ops-timeline">{trail?.events.map(event)}</div>
        <nav className="ops-pages" aria-label={t("历史分页")}><button disabled={trailBusy||historyIndex===0} onClick={()=>void previousHistory()}>{t("较新的记录")}</button><span>{historyIndex+1}</span><button disabled={trailBusy||!trail?.cursor} onClick={()=>void nextHistory()}>{t("较早的记录")}</button></nav>
      </section>
    </section></div>
    {review&&<Dialog title={t("审阅当前请求")} busy={busy} onClose={()=>setReview(undefined)}><div className="ops-review"><h2>{t("审阅当前请求")}</h2><p>{snapshot.jobs.find(j=>j.id===review.jobId)?.title}</p>{error&&<p role="alert" className="ops-error">{error}</p>}{!liveReview&&<p role="alert" className="ops-error">{t("此请求已经结束或更新，请返回列表重新审阅。")}</p>}<fieldset disabled={busy||!liveReview||liveReview.responsePending}>{approval?approval({...review,responsePending:liveReview?.responsePending},value=>void run(async()=>{await call("approval.respond",{id:review.id,jobId:review.jobId,reviewId:review.reviewId,historyId:review.historyId,value});setReview(undefined);await load();})): <button onClick={()=>{const job=snapshot.jobs.find(j=>j.id===review.jobId);if(job)open(job);}}>{t("打开原会话")}</button>}</fieldset></div></Dialog>}
    {delivery&&<DeliveryDialog job={snapshot.jobs.find(j=>j.id===delivery.id)||delivery} call={call} close={()=>setDelivery(undefined)}/>}
    {vault&&<DeliveryVault call={call} selected={[]} previewOnOpen={false} initialId={vault.id} close={()=>{setVault(undefined);void loadLinks();}}/>}
    {telegram&&<Dialog title={t("Telegram 通知记录")} onClose={()=>{setTelegram(false);void loadLinks();}}><TelegramSettings call={call}/></Dialog>}
    {workflowReport&&<WorkflowReport id={workflowReport} call={call} close={()=>setWorkflowReport(undefined)}/>}
    {recovery&&<Dialog title={t("Windows 恢复计划")} onClose={()=>setRecovery(false)}><RecoveryPanel call={call} snapshot={snapshot} open={job=>{setRecovery(false);open(job);}}/></Dialog>}
  </main>;
}
