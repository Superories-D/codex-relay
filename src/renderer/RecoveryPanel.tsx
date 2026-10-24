import React,{useEffect,useRef,useState} from "react";
import {RefreshCw,ShieldCheck,ShieldAlert,ArrowUpRight} from "lucide-react";
import type {RecoveryPlan} from "../shared/recovery";
import type {Snapshot,Job} from "../shared/types";
import {t,useI18n,errorText,formatDate} from "./i18n";
import "./recovery.css";
import {WorkspaceCheckpoints} from "./WorkspaceCheckpoints";
const reasons:Record<string,string>={contained:"已核实受管进程域与资源归属",missingProof:"缺少可验证的运行凭据，继续全局等待",changedResources:"任务资源已变化，需要重新核查",unknownOwner:"归属记录无法核实，继续全局等待",externalSession:"已有会话或 Desktop 需要全局核查",unconfined:"原有权限或额外授权需要全局核查",storage:"恢复证据未能落盘，继续全局等待"};
export function RecoveryPanel({call,snapshot,open}:{call:(name:string,args?:unknown)=>Promise<any>;snapshot:Snapshot;open:(job:Job)=>void}){
  useI18n();const [plan,setPlan]=useState<RecoveryPlan>(),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [checkpoints,setCheckpoints]=useState(false);
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});const live=useRef(true),generation=useRef(0),pending=useRef(false);
  async function load(){const ticket=++generation.current;try{const value=await call("recovery.plan");if(live.current&&ticket===generation.current)setPlan(value);}catch(e){if(live.current&&ticket===generation.current)setError(errorText(e));}}
  useEffect(()=>{live.current=true;void load();return()=>{live.current=false;generation.current++;};},[]);
  async function inspect(){if(!plan||pending.current)return;pending.current=true;setBusy(true);setError("");const ticket=++generation.current;
    try{const value=await call("recovery.inspect",{id:plan.id});if(live.current&&ticket===generation.current)setPlan(value);}
    catch(e){if(live.current){setError(errorText(e));await load();}}
    finally{pending.current=false;if(live.current)setBusy(false);}
  }
  const choose=(id:string)=>{const job=snapshot.jobs.find(j=>j.id===id);if(job)open(job);};
  return <section className="recovery-plan"><header><div><h2>{t("Windows 恢复计划")}</h2><p>{t("核对故障影响范围，保留原任务的暂停、取消与恢复意图。")}</p></div><button disabled={busy||!plan} onClick={()=>void inspect()}><RefreshCw size={15}/>{t(busy?"正在核查归属…":"重新核查归属")}</button></header>
    <p className="recovery-plan-caption">{t("核查只读取归属并保存证据，不会发送模型请求或停止进程。自动恢复仍按原任务意图进行。")}</p>
    <button onClick={()=>setCheckpoints(true)}>{t("核对工作区检查点")}</button>
    {checkpoints&&<WorkspaceCheckpoints call={call} jobs={snapshot.jobs} close={()=>setCheckpoints(false)} open={open}/>}
    {error&&<p className="ops-error" role="alert">{error}</p>}
    {!plan?<p role="status">{t("正在读取恢复计划…")}</p>:!plan.entries.length?<div className="recovery-clear"><ShieldCheck size={28}/><h3>{t("当前没有待核查的恢复占用")}</h3><p>{t("任务仍按账户额度、依赖与并发条件调度。")}</p></div>:<>
      <div className="recovery-summary"><span>{t("局部占用：{count}",{count:plan.entries.filter(e=>e.status==="scoped").length})}</span><span>{t("全局等待：{count}",{count:plan.entries.filter(e=>e.status==="global").length})}</span></div>
      {plan.entries.map(entry=><article className="recovery-entry" key={entry.id} data-scope={entry.status}><header><div><h3>{entry.status==="scoped"?<ShieldCheck size={18}/>:<ShieldAlert size={18}/>}<button onClick={()=>choose(entry.id)}>{entry.title}<ArrowUpRight size={13}/></button></h3><strong>{t(entry.status==="scoped"?"影响范围已隔离":"保留全局恢复等待")}</strong></div><span>{t(entry.intent==="pause"?"保留用户暂停":entry.intent==="cancel"?"保留用户取消":"保留原任务恢复意图")}</span></header>
        <p>{t(reasons[entry.reason]||"归属记录无法核实，继续全局等待")}</p>
        {entry.status==="scoped"&&<p>{t("相关项目与会话家族继续等待，相关账户暂不参与选择；独立任务仍需满足各自调度条件。")}</p>}
        {(entry.projects.length>0||entry.accounts.length>0)&&<dl>{entry.projects.length>0&&<><dt>{t("关联项目")}</dt><dd>{entry.projects.join(" · ")}</dd></>}{entry.accounts.length>0&&<><dt>{t("暂时保留的账户")}</dt><dd>{entry.accounts.map(a=>a.label).join(" · ")}</dd></>}</dl>}
        <div className="recovery-facts">{entry.checkedAt&&<span>{t("最近核查")}: {formatDate(entry.checkedAt)}</span>}{entry.processes!==undefined&&<span>{t("占用进程（含管理宿主）：{count}",{count:entry.processes})}</span>}{entry.attempt!==undefined&&<span>{t("恢复次数：{count}",{count:entry.attempt})}</span>}{entry.nextAt&&<span>{t("下次核实时间")}: {formatDate(entry.nextAt)}</span>}</div>
        <details><summary>{t("受影响队列：{count}",{count:entry.affected.length})}</summary><div className="recovery-affected">{(expanded[entry.id]?entry.affected:entry.affected.slice(0,10)).map(id=><button key={id} onClick={()=>choose(id)}>{snapshot.jobs.find(j=>j.id===id)?.title||id}<ArrowUpRight size={12}/></button>)}{entry.affected.length>10&&<button onClick={()=>setExpanded(v=>({...v,[entry.id]:!v[entry.id]}))}>{t(expanded[entry.id]?"收起":"展开全部 {count} 项",{count:entry.affected.length})}</button>}</div></details>
        {entry.nonce&&<details><summary>{t("运行凭据身份")}</summary><code>{entry.nonce}</code></details>}
      </article>)}
    </>}
  </section>;
}
