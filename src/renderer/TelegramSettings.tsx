import React, { useEffect, useRef, useState } from "react";
import { Bell, RefreshCw, Send, ShieldCheck, Trash2 } from "lucide-react";
import { t, formatDate, errorText } from "./i18n";
import type { TelegramView, TelegramEvent, TelegramCandidate } from "../shared/telegram-notifications";
import "./telegram.css";

type Call = (name: string, args?: unknown) => Promise<any>;
const events: [TelegramEvent, string][] = [["completed", "任务已完成"], ["attention", "任务需要处理"],
  ["approval", "任务等待你的回复或批准"], ["waiting", "任务正在等待可用额度"]];
const statuses = { pending: "等待发送", sending: "正在发送", sent: "已发送", failed: "发送失败", uncertain: "结果未知", cancelled: "已取消" };
export function TelegramSettings({call}: {call: Call}) {
  const [view, setView] = useState<TelegramView>();
  const [token, setToken] = useState(""), [chatId, setChatId] = useState("");
  const [enabled, setEnabled] = useState(false), [includeTitles, setIncludeTitles] = useState(false);
  const [selected, setSelected] = useState<TelegramEvent[]>([]), [candidates, setCandidates] = useState<TelegramCandidate[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const live = useRef(true), request = useRef(false), polling=useRef<object|undefined>(undefined),epoch=useRef(0);
  const [historyFilter,setHistoryFilter]=useState("all"),[historyQuery,setHistoryQuery]=useState(""),[historyPage,setHistoryPage]=useState(0);
  const receipts=(view?.receipts||[]).filter(r=>(historyFilter==="all"||(historyFilter==="unresolved"?["pending","sending","failed","uncertain"].includes(r.status):r.status===historyFilter))&&`${r.id} ${r.jobId||""} ${r.text} ${r.issue||""}`.toLowerCase().includes(historyQuery.trim().toLowerCase()));
  const pages=Math.max(1,Math.ceil(receipts.length/20)),page=Math.min(historyPage,pages-1);
  const unresolved=(view?.receipts||[]).filter(r=>["pending","sending","failed","uncertain"].includes(r.status)).length;
  const callRef = useRef(call); callRef.current = call;
  const apply = (value: TelegramView) => {
    setView(value); setChatId(value.chatId); setEnabled(value.enabled);
    setIncludeTitles(value.includeTitles); setSelected(value.events); setToken(""); setDirty(false);
  };
  useEffect(() => {
    live.current = true;
    const initialEpoch=epoch.current,initialRead={};polling.current=initialRead;
    void callRef.current("telegram.read").then(v => {if (live.current&&epoch.current===initialEpoch) apply(v);}).catch(e => {if (live.current&&epoch.current===initialEpoch) setError(errorText(e));}).finally(()=>{if(polling.current===initialRead)polling.current=undefined;});
    const timer = setInterval(() => {
      if (request.current||polling.current) return;
      const observedEpoch=epoch.current,activeRead={};polling.current=activeRead;
      void callRef.current("telegram.read").then((v: TelegramView) => {
        if (live.current&&epoch.current===observedEpoch) setView(old => old&&v.revision===old.revision ? {...old, receipts: v.receipts, issue: v.issue} : old);
      }).catch(() => {}).finally(()=>{if(polling.current===activeRead)polling.current=undefined;});
    }, 2000);
    return () => {live.current = false; epoch.current++;clearInterval(timer);};
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    if (request.current) return;
    epoch.current++;request.current = true; setBusy(true); setError(""); setNotice("");
    try {await action();} catch(e) {if (live.current) setError(errorText(e));}
    finally {request.current = false; if (live.current) setBusy(false);}
  };
  const edit = () => {setDirty(true); setNotice(""); setCandidates([]);};
  const save = () => run(async () => {
    const v = await call("telegram.save", {revision: view!.revision, ...(token.trim() ? {token: token.trim()} : {}),
      chatId: chatId.trim(), enabled, includeTitles, events: selected});
    if (live.current) {apply(v); setNotice(t("Telegram 配置已保存"));}
  });
  return <section className="telegram-settings" aria-labelledby="telegram-heading">
    <div className="telegram-heading"><Send size={20}/><h2 id="telegram-heading">Telegram Bot</h2><span>{t("Windows 通知")}</span></div>
    <p className="telegram-description">{t("接入自己的 Bot，在手机上接收任务进展。先向 Bot 发送 /start，再选择私人聊天。")}</p>
    {error && <div className="telegram-issue" role="alert">{t(error.replace(/^Error: /, ""))}</div>}
    {view?.issue && <div className="telegram-issue" role="alert">{t(view.issue)}</div>}
    {notice && <p role="status">{notice}</p>}
    {!view ? <button onClick={() => void run(async () => apply(await call("telegram.read")))} disabled={busy}>{t("重新加载")}</button> : <>
      <fieldset disabled={busy} className="telegram-fields">
        <label>{t("Bot Token")}<input type="password" autoComplete="off" spellCheck={false} value={token}
          placeholder={view.configured ? t("已加密保存；留空保留现有 Token") : "123456789:…"}
          onChange={e => {setToken(e.target.value); edit();}}/></label>
        <label>{t("私人 Chat ID")}<input inputMode="numeric" autoComplete="off" value={chatId}
          placeholder="123456789" onChange={e => {setChatId(e.target.value); edit();}}/></label>
        <div className="telegram-connect-actions"><button onClick={() => void run(async () => {
          const found: TelegramCandidate[] = await call("telegram.discover", token.trim() ? {token: token.trim()} : {});
          if (live.current) {setCandidates(found); setNotice(found.length ? t("选择一个私人聊天作为接收人") : t("没有找到最近聊天。请先向 Bot 发送 /start，或手动填写 Chat ID。"));}
        })}><RefreshCw size={14}/>{t("读取最近聊天")}</button>
          {view.bot && <span className="telegram-bot">@{view.bot.username}</span>}
          <button onClick={() => void run(() => call("link.open", "https://t.me/BotFather"))}>{t("创建或管理 Bot")}</button>
        </div>
        {!!candidates.length && <div className="telegram-candidates">{candidates.map(c => <button key={c.id}
          aria-pressed={chatId === c.id} onClick={() => {setChatId(c.id); setDirty(true);}}>{c.name} · {c.id}</button>)}</div>}
        <label className="telegram-check"><input type="checkbox" checked={enabled} onChange={e => {setEnabled(e.target.checked); edit();}}/>{t("启用 Telegram 自动通知")}</label>
        <div className="telegram-events">{events.map(([id, label]) => <label key={id} className="telegram-check"><input type="checkbox"
          checked={selected.includes(id)} onChange={e => {setSelected(old => e.target.checked ? [...old, id] : old.filter(v => v !== id)); edit();}}/>{t(label)}</label>)}</div>
        <label className="telegram-check"><input type="checkbox" checked={includeTitles} onChange={e => {setIncludeTitles(e.target.checked); edit();}}/>{t("在 Telegram 消息中包含任务名称")}</label>
        <p className="telegram-description">{t("默认仅发送状态与任务编号。消息不包含对话、文件内容或本机路径。启用后开始通知后续状态变化。")}</p>
      </fieldset>
      <div className="telegram-actions">
        <button className="solid-button" disabled={busy || !!view.issue} onClick={() => void save()}><ShieldCheck size={15}/>{t("验证并保存")}</button>
        <button disabled={busy || dirty || !view.configured || !!view.issue} onClick={() => void run(async () => {
          const value = await call("telegram.test", {revision: view.revision}); if (live.current) {setView(value); setNotice(t("测试通知已加入发送队列"));}
        })}><Bell size={15}/>{t("发送测试通知")}</button>
        <button disabled={busy} onClick={() => void run(async () => {apply(await call("telegram.read")); setCandidates([]);})}><RefreshCw size={15}/>{t("刷新配置")}</button>
        <button className="telegram-remove" disabled={busy} onClick={() => setConfirm("forget")}><Trash2 size={15}/>{t("移除 Bot")}</button>
      </div>
      {dirty && <p role="status" className="telegram-description">{t("有未保存的更改；保存后才能发送测试通知。")}</p>}
      <p className="telegram-description">{t("Token 使用 Windows 系统加密保存在本机。读取最近聊天不会确认更新，也不会接管或修改 Bot 的 Webhook。")}</p>
      {confirm && <div className="telegram-confirm" role="group" aria-label={t("确认操作")}>
        <p>{confirm === "forget" ? t("移除后将删除 Bot 配置与全部发送记录，并停止自动通知。") : t("此通知可能已送达。请先查看 Telegram；再次发送可能产生重复消息。")}</p>
        <button disabled={busy} onClick={() => void run(async () => {
          const value = confirm === "forget" ? await call("telegram.forget", {revision: view.revision}) : await call("telegram.receipt", {id: confirm, action: "retry"});
          if (live.current) {apply(value); setConfirm(undefined);}
        })}>{confirm === "forget" ? t("确认移除 Bot") : t("仍然重试")}</button><button disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button>
      </div>}
      <div className="telegram-history"><h3>{t("发送记录")}</h3>
        <p className="telegram-description">{t("限流会自动重试；结果未知的通知需要手动确认。关闭自动通知会保留队列，重新启用后继续发送。")}</p>
        <div className="telegram-history-tools">
          <label>{t("搜索通知记录")}<input type="search" value={historyQuery} onChange={e=>{setHistoryQuery(e.target.value);setHistoryPage(0);}}/></label>
          <label>{t("通知状态")}<select value={historyFilter} onChange={e=>{setHistoryFilter(e.target.value);setHistoryPage(0);}}><option value="all">{t("全部")}</option><option value="unresolved">{t("待处理通知")}</option>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{t(label)}</option>)}</select></label>
          <button type="button" onClick={()=>{setHistoryFilter("unresolved");setHistoryQuery("");setHistoryPage(0);}}>{t("待处理通知")} · {unresolved}</button>
          <span role="status">{receipts.length} / {view.receipts.length} · {page+1} / {pages}</span>
        </div>
        {!!view.receipts.length&&!receipts.length&&<p>{t("没有匹配的通知记录")}</p>}
        {!view.receipts.length && <p className="telegram-description">{t("暂无发送记录")}</p>}
        {receipts.slice(page*20,(page+1)*20).map(r => <article key={r.id} className={`telegram-receipt is-${r.status}`}>
          <div><strong>{t(statuses[r.status])}</strong><time>{formatDate(r.createdAt)}</time><span>{t("尝试次数")}: {r.attempts}</span></div>
          <pre>{r.text}</pre>{r.issue && <p>{t(r.issue)}</p>}
          {r.status === "pending" && r.dueAt > Date.now() && <p>{t("下次尝试")}: {formatDate(r.dueAt)}</p>}
          {["failed", "uncertain"].includes(r.status) && <button disabled={busy || dirty} onClick={() => r.status === "uncertain" ? setConfirm(r.id) : void run(async () => setView(await call("telegram.receipt", {id: r.id, action: "retry"})))}>{t("重试通知")}</button>}
          {["pending", "failed", "uncertain"].includes(r.status) && <button disabled={busy || dirty} onClick={() => void run(async () => setView(await call("telegram.receipt", {id: r.id, action: "cancel"})))}>{t("取消通知")}</button>}
        </article>)}
        {pages>1&&<nav className="telegram-history-pages" aria-label={t("通知记录分页")}><button type="button" disabled={page===0} onClick={()=>setHistoryPage(page-1)}>{t("上一页")}</button><span>{page+1} / {pages}</span><button type="button" disabled={page+1>=pages} onClick={()=>setHistoryPage(page+1)}>{t("下一页")}</button></nav>}
      </div>
    </>}
  </section>;
}
