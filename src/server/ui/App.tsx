import {LiveControls} from "./LiveControls";
import {RemoteArtifacts} from "./Artifacts";
import { RemoteAttachments,readAttachments,saveAttachments } from "./Attachments";
import type {ChatAttachment} from "../../shared/types";
import { TaskCenter } from "../../renderer/TaskCenter";
import { RuntimeSettings } from "./RuntimeSettings";
import { TaskTemplates } from "../../renderer/TaskTemplates";
import { ChatSearch } from "../../renderer/ChatSearch";
import { MessageQueue } from "../../renderer/MessageQueue";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Job, Snapshot, ChatItem, NewJob } from "../../shared/types";
import {
  t,
  setLanguage,
  useI18n,
  errorText,
  type Language,
} from "../../renderer/i18n";
import { RecoveryNotice, RecoveryHistory } from "../../renderer/RecoveryNotice";
import { WorkflowBuilder } from "../../renderer/WorkflowBuilder";
import { WorkflowReport } from "../../renderer/WorkflowReport";
import { RemoteApproval } from "./Approvals";
import { request, watch, CommandError } from "./client";
import "./style.css";
type Submission = { requestId: string; input: NewJob };
const readPending = () => {
  try {
    return JSON.parse(
      sessionStorage.getItem("relay.remote.pending") || "null",
    ) as Submission | null;
  } catch {
    return null;
  }
};
setLanguage(
  (sessionStorage.getItem("relay.remote.language") || "auto") as Language,
);
const labels: Record<string, string> = {
  queued: "排队中",
  running: "正在工作",
  preparing: "连接中",
  waiting: "等待可用额度",
  rotating: "自动切换账户",
  pausing: "正在停止",
  paused: "已暂停",
  needs_attention: "需要处理",
  completed: "本轮完成",
  cancelled: "已取消",
  watching: "监控中",
};
function App() {
  useI18n();
  const [token, setToken] = useState(
      sessionStorage.getItem("relay.remote.token") || "",
    ),
    [entry, setEntry] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [status, setStatus] = useState("正在连接"),
    [roots, setRoots] = useState<string[]>([]);
  const [selected, setSelected] = useState(""),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [directory, setDirectory] = useState(""),
    [model, setModel] = useState(""),
    [prompt, setPrompt] = useState(
      sessionStorage.getItem("relay.remote.draft") || "",
    );
  const [templateOptions, setTemplateOptions] = useState({effort:"",planMode:false,multiAgent:false});
  const [newAttachments,setNewAttachments]=useState<ChatAttachment[]>(()=>readAttachments("new"));
  const [followAttachments,setFollowAttachments]=useState<ChatAttachment[]>([]);
  const [newUploading,setNewUploading]=useState(false),[followUploading,setFollowUploading]=useState(false);
  useEffect(()=>setFollowAttachments(readAttachments(selected)),[selected]);
  function clearAttachments(id:string,used:ChatAttachment[]=[]){const paths=new Set(used.map(a=>a.path));const next=readAttachments(id).filter(a=>!paths.has(a.path));saveAttachments(id,next);if(id==="new")setNewAttachments(next);else if(selection.current===id)setFollowAttachments(next);}
  const [pendingMessage, setPendingMessage] = useState<{
    id: string;
    requestId: string;
    text: string;
    attachments?: ChatAttachment[];
  } | null>(() => {
    try {
      return JSON.parse(
        sessionStorage.getItem("relay.remote.message") || "null",
      );
    } catch {
      return null;
    }
  });
  const followupDrafts = useRef<Record<string, string>>(
    (() => {
      try {
        return JSON.parse(
          sessionStorage.getItem("relay.remote.followups") || "{}",
        );
      } catch {
        return {};
      }
    })(),
  );
  const [pending, setPending] = useState<Submission | null>(readPending),
    [followup, setFollowup] = useState("");
  const [chat, setChat] = useState<ChatItem[]>([]),
    [before, setBefore] = useState<number>(),
    [chatError, setChatError] = useState("");
  const [archived, setArchived] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [center, setCenter] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [searching, setSearching] = useState<string>();
  const [building, setBuilding] = useState(false),
    [report, setReport] = useState<string>();
  const previews = useRef(new Map<string, any>());
  const selection = useRef(selected);
  selection.current = selected;
  useEffect(()=>setRenaming(undefined),[selected]);
  const job = snapshot?.jobs.find((j) => j.id === selected);
  useEffect(() => {
    try {
      sessionStorage.setItem("relay.remote.draft", prompt);
    } catch (e) {
      setError(errorText(e));
    }
  }, [prompt]);
  useEffect(() => {
    try {
      if (pending)
        sessionStorage.setItem("relay.remote.pending", JSON.stringify(pending));
      else sessionStorage.removeItem("relay.remote.pending");
    } catch (e) {
      setError(errorText(e));
    }
  }, [pending]);
  useEffect(() => {
    if (!token) return;
    let current = true;
    const controller = new AbortController();
    void fetch("/api/meta", {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw Error("令牌无效，请重新连接");
        const meta = await r.json();
        if (current) {
          setRoots(meta.workspaces);
          setDirectory((old) =>
            meta.workspaces.includes(old) ? old : meta.workspaces[0] || "",
          );
        }
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      });
    void watch(
      token,
      controller.signal,
      (value) => {
        if (current) setSnapshot(value);
      },
      (value) => {
        if (current) setStatus(value);
      },
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [token]);
  useEffect(() => {
    if (pending) {
      const accepted = snapshot?.jobs.find(
        (j) => j.clientRequest?.id === pending.requestId,
      );
      if (accepted) {
        clearAttachments("new",pending.input.attachments);
        setSelected(accepted.id);
        setPending(null);
        setPrompt((current) =>
          current === pending.input.prompt ? "" : current,
        );
        setError("");
      }
    }
  }, [snapshot, pending]);
  useEffect(() => {
    try {
      if (pendingMessage)
        sessionStorage.setItem(
          "relay.remote.message",
          JSON.stringify(pendingMessage),
        );
      else sessionStorage.removeItem("relay.remote.message");
    } catch (e) {
      setError(errorText(e));
    }
  }, [pendingMessage]);
  useEffect(() => {
    setFollowup(
      pendingMessage?.id === selected
        ? pendingMessage.text
        : followupDrafts.current[selected] || "",
    );
  }, [selected]);
  function saveFollowups() {
    try {
      sessionStorage.setItem(
        "relay.remote.followups",
        JSON.stringify(followupDrafts.current),
      );
    } catch (e) {
      setError(errorText(e));
    }
  }
  function acknowledgeMessage(message: { id: string; text: string; attachments?: ChatAttachment[] }) {
    clearAttachments(message.id,message.attachments);
    if (followupDrafts.current[message.id] === message.text) {
      delete followupDrafts.current[message.id];
      saveFollowups();
      if (selection.current === message.id) setFollowup("");
    }
    setPendingMessage(null);
  }
  useEffect(() => {
    if (
      pendingMessage &&
      snapshot?.jobs
        .find((j) => j.id === pendingMessage.id)
        ?.messageReceipts?.some((r) => r.id === pendingMessage.requestId)
    )
      acknowledgeMessage(pendingMessage);
  }, [snapshot, pendingMessage]);
  async function submitFollowup() {
    if (!job || (pendingMessage && pendingMessage.id !== job.id)) return;
    const message = pendingMessage || {
      id: job.id,
      text: followup,
      attachments:followAttachments,
      requestId: crypto.randomUUID(),
    };
    setPendingMessage(message);
    try {
      sessionStorage.setItem("relay.remote.message", JSON.stringify(message));
      await action("chat.submit", {
        requestId: message.requestId,
        input: {
          id: message.id,
          text: message.text,
          attachments: message.attachments || [],
          action: "queue",
        },
      });
      acknowledgeMessage(message);
    } catch (e) {
      setError(errorText(e));
      if (e instanceof CommandError && [400, 401, 403, 422].includes(e.status))
        setPendingMessage(null);
    }
  }
  async function exportChat(id:string) {
    try {
      const result=await action("chat.export",id);
      const url=URL.createObjectURL(new Blob([result.markdown],{type:"text/markdown;charset=utf-8"}));
      const link=document.createElement("a");link.href=url;link.download=`conversation-${id.slice(0,8)}.md`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch {}
  }
  async function call(name: string, args?: any) {
    if (name === "workflow.report.save") {
      const preview = previews.current.get(args.previewId);
      if (!preview) throw Error("报告预览已过期，请重新生成");
      const text =
        args.format === "json"
          ? JSON.stringify(preview.report, null, 2)
          : preview.markdown;
      const url = URL.createObjectURL(
        new Blob([text], {
          type: args.format === "json" ? "application/json" : "text/markdown",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `workflow-handoff.${args.format === "json" ? "json" : "md"}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { saved: true };
    }
    const result = await request(token, name, args);
    if (name === "workflow.report") {
      if (previews.current.size >= 5) previews.current.clear();
      previews.current.set(result.previewId, result);
    }
    return result;
  }
  async function action(name: string, args?: unknown) {
    setBusy(true);
    setError("");
    try {
      return await call(name, args);
    } catch (e) {
      setError(errorText(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const run = (name: string, args?: unknown) => {
    void action(name, args).catch(() => {});
  };
  async function submit() {
    const payload = pending || {
      requestId: crypto.randomUUID(),
      input: {
        title: prompt.trim().split("\n")[0].slice(0, 120),
        prompt: prompt.trim(),
        cwd: directory,
        mode: "cli" as const,
        model,
        ...templateOptions,
        bucket: "codex",
        approvalPolicy: "on-request" as const,
        sandbox: "workspaceWrite" as const,
        interactive: true,
        attachments:newAttachments,
      },
    };
    setPending(payload);
    try {
      sessionStorage.setItem("relay.remote.pending", JSON.stringify(payload));
      const accepted = await action("job.submit", payload);
      clearAttachments("new",payload.input.attachments);
      setSelected(accepted.id);
      setPending(null);
      setPrompt((current) => (current === payload.input.prompt ? "" : current));
    } catch (e) {
      setError(errorText(e));
      if (e instanceof CommandError && [400, 401, 403, 422].includes(e.status))
        setPending(null); /* Keep the request ID on transport failures. */
    }
  }
  useEffect(() => {
    if (!selected || !token) {
      setChat([]);
      setBefore(undefined);
      return;
    }
    let active = true,
      first = true,
      loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const page = await request(token, "chat.read", { id: selected });
        if (active) {
          const initial = first;
          setChat((old) => {
            if (initial) return page.items;
            const updated = new Map<string, ChatItem>(
              page.items.map((i: ChatItem) => [i.id, i]),
            );
            const known = new Set(old.map((i) => i.id));
            return [
              ...old.map((i) => updated.get(i.id) || i),
              ...page.items.filter((i: ChatItem) => !known.has(i.id)),
            ];
          });
          if (first) setBefore(page.before);
          first = false;
          setChatError("");
        }
      } catch (e) {
        if (active) setChatError(errorText(e));
      } finally {
        loading = false;
      }
    };
    setChat([]);
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected, token]);
  async function older() {
    if (before === undefined) return;
    const id = selected;
    try {
      const page = await call("chat.read", { id, before });
      if (selection.current === id) {
        setChat((old) => [...page.items, ...old]);
        setBefore(page.before);
      }
    } catch (e) {
      setChatError(errorText(e));
    }
  }
  function disconnect() {
    setToken("");
    setEntry("");
    setSnapshot(undefined);
    setSelected("");
    setPending(null);
    setPendingMessage(null);
    followupDrafts.current = {};
    setFollowup("");
    setPrompt("");
    previews.current.clear();
    for (const key of ["token", "pending", "draft", "message", "followups"])
      sessionStorage.removeItem(`relay.remote.${key}`);
  }
  return (
    <div className="remote-shell">
      <header className="remote-header">
        <div>
          <strong>Codex Relay</strong>
          <span>{t("远程控制台")}</span>
        </div>
        <div className="row">
          <select
            aria-label={t("语言")}
            defaultValue={
              sessionStorage.getItem("relay.remote.language") || "auto"
            }
            onChange={(e) => {
              sessionStorage.setItem("relay.remote.language", e.target.value);
              setLanguage(e.target.value as Language);
            }}
          >
            <option value="auto">Auto</option>
            <option value="zh-CN">{"简体中文"}</option>
            <option value="en">English</option>
            <option value="ja">{"日本語"}</option>
          </select>
          {token && snapshot && <button onClick={() => setCenter(value => !value)}>{t("任务中心")}</button>}
          {token && snapshot && <button onClick={() => setSettingsOpen(true)}>{t("设置")}</button>}
          {token && <button onClick={disconnect}>{t("断开连接")}</button>}
        </div>
      </header>
      {!token ? (
        <main className="connect-card">
          <h1>{t("连接你的 Relay 服务")}</h1>
          <p>
            {t(
              "使用服务数据目录中的 HTTP 令牌。令牌仅保留在当前浏览器会话中。",
            )}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sessionStorage.setItem("relay.remote.token", entry.trim());
              setToken(entry.trim());
              setError("");
            }}
          >
            <label>
              {t("访问令牌")}
              <input
                type="password"
                required
                autoComplete="off"
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
              />
            </label>
            <button type="submit">{t("连接")}</button>
          </form>
        </main>
      ) : (
        <>
          <div
            className={`connection-bar ${status === "已连接" ? "online" : ""}`}
            role="status"
          >
            {t(status)} · {t("断线只重新订阅状态，不重复提交任务。")}
          </div>
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          {center && snapshot && <TaskCenter snapshot={snapshot} call={call} close={() => setCenter(false)} open={job => {setSelected(job.id);setCenter(false);}} />}
          {!center && <main className="remote-layout">
            <aside className="remote-sidebar">
              <section className="new-task">
                <h2>{t("新建任务")}</h2>
                <button disabled={!!pending || busy} onClick={() => setTemplates(true)}>{t("任务模板")}</button>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                  }}
                >
                  <label>
                    {t("工作目录")}
                    <select
                      required
                      value={directory}
                      disabled={!!pending || busy}
                      onChange={(e) => setDirectory(e.target.value)}
                    >
                      <option value="">—</option>
                      {roots.map((root) => (
                        <option key={root}>{root}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("模型")}
                    <input
                      value={model}
                      maxLength={200}
                      disabled={!!pending || busy}
                      onChange={(e) => setModel(e.target.value)}
                    />
                  </label>
                  <label>
                    {t("任务指令")}
                    <textarea
                      required
                      maxLength={100000}
                      value={prompt}
                      disabled={!!pending || busy}
                      onChange={(e) => setPrompt(e.target.value)}
                    />
                  </label>
                  <RemoteAttachments id="new" token={token} value={newAttachments} onChange={setNewAttachments} onBusy={setNewUploading} disabled={busy||!!pending}/>
                  <button type="submit" disabled={busy || newUploading || !directory}>
                    {t(pending ? "重试同一提交" : "创建并排队")}
                  </button>
                  {pending && (
                    <p>{t("提交结果尚未确认，重试会沿用同一请求编号。")}</p>
                  )}
                </form>
                <button
                  className="remote-workflow"
                  disabled={!roots.length}
                  onClick={() => setBuilding(true)}
                >
                  {t("新建工作流")}
                </button>
              </section>
              <section>
                <div className="row">
                  <h2>{t("任务列表")}</h2>
                  <button
                    disabled={busy}
                    onClick={() =>
                      run("scheduler.dispatch", {
                        paused: !snapshot?.dispatch?.paused,
                      })
                    }
                  >
                    {t(
                      snapshot?.dispatch?.paused
                        ? "开启全局调度"
                        : "暂停全局调度",
                    )}
                  </button>
                </div>
                <input
                  aria-label={t("搜索任务")}
                  placeholder={t("搜索任务")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <label><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)} />{t("已归档会话")}</label>
                <div className="remote-task-list">
                  {snapshot?.jobs
                    .filter(
                      (j) =>
                        !!j.archived === archived &&
                        `${j.title} ${j.cwd}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                    )
                    .slice()
                    .sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||b.createdAt-a.createdAt)
                    .map((j) => (
                      <button
                        key={j.id}
                        aria-pressed={j.id === selected}
                        onClick={() => setSelected(j.id)}
                      >
                        <strong>{j.title}</strong>
                        <span>
                          {t(j.autoRecovery ? "正在自动恢复" : labels[j.state])}
                        </span>
                      </button>
                    ))}
                </div>
              </section>
            </aside>
            <section className="remote-conversation">
              {job ? (
                <>
                  <div className="conversation-header">
                    <h1>{job.title}</h1>
                    <p>{job.cwd}</p>
                    {renaming !== undefined && <form onSubmit={e=>{e.preventDefault();void action("job.metadata",{id:job.id,title:renaming}).then(()=>setRenaming(undefined)).catch(()=>{});}}><input required maxLength={120} value={renaming} onChange={e=>setRenaming(e.target.value)} aria-label={t("重命名会话")}/><button disabled={busy}>{t("保存")}</button></form>}
                    <div className="row">
                      <button onClick={()=>setRenaming(job.title)}>{t("重命名会话")}</button>
                      <button disabled={busy} onClick={()=>run("job.metadata",{id:job.id,pinned:!job.pinned})}>{t(job.pinned?"取消置顶":"置顶会话")}</button>
                      <button disabled={busy} onClick={()=>run("job.metadata",{id:job.id,archived:!job.archived})}>{t(job.archived?"取消归档":"归档会话")}</button>
                    </div>
                    <div className="row">
                      <span className="state-pill">{t(labels[job.state])}</span>
                      {["paused", "needs_attention"].includes(job.state) ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            run("job.control", { id: job.id, action: "resume" })
                          }
                        >
                          {t("继续")}
                        </button>
                      ) : (
                        !["completed", "cancelled"].includes(job.state) && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              run("job.control", {
                                id: job.id,
                                action: "pause",
                              })
                            }
                          >
                            {t("暂停")}
                          </button>
                        )
                      )}
                      {!["completed", "cancelled"].includes(job.state) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            run("job.control", { id: job.id, action: "cancel" })
                          }
                        >
                          {t("取消任务")}
                        </button>
                      )}
                      <button disabled={busy} onClick={() => void exportChat(job.id)}>{t("导出 Markdown")}</button>
                      <button onClick={() => setSearching(job.id)}>{t("搜索会话内容")}</button>
                      {job.workflow && (
                        <button onClick={() => setReport(job.workflow!.id)}>
                          {t("工作流交付报告")}
                        </button>
                      )}
                    </div>
                  </div>
                  <RecoveryNotice
                    job={job}
                    onPause={() =>
                      run("job.control", { id: job.id, action: "pause" })
                    }
                    pending={busy}
                  />
                  <RecoveryHistory job={job} />
                  <LiveControls key={`live-${job.id}`} job={job} call={call}/>
                  <RemoteArtifacts key={job.id} id={job.id} call={call}/>
                  <label>{t("任务优先级")}<select aria-label={t("任务优先级")} value={job.priority || "normal"} disabled={busy} onChange={e => run("chat.priority",{id:job.id,priority:e.target.value})}>
                    <option value="high">{t("高")}</option><option value="normal">{t("普通优先级")}</option><option value="low">{t("低")}</option>
                  </select></label>
                  <MessageQueue key={job.id} job={job} pending={busy} onChange={args => run("chat.queue",args)} />
                  {snapshot?.approvals
                    .filter((a) => a.jobId === job.id)
                    .map((a) => (
                      <RemoteApproval
                        key={`${a.jobId}:${a.id}:${a.historyId}`}
                        approval={a}
                        call={call}
                      />
                    ))}
                  {chatError && <p role="alert">{chatError}</p>}
                  {before !== undefined && (
                    <button onClick={() => void older()}>
                      {t("加载更早消息")}
                    </button>
                  )}
                  <div className="remote-messages">
                    {chat.map((item) => (
                      <article key={item.id} className={`message-${item.role}`}>
                        <small>{item.role}</small>
                        <pre>{item.text}</pre>
                        {item.detail && (
                          <details>
                            <summary>{t("详情")}</summary>
                            <pre>{item.detail}</pre>
                          </details>
                        )}
                      </article>
                    ))}
                  </div>
                  <form
                    className="remote-followup"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submitFollowup();
                    }}
                  >
                    <label>
                      {t("后续指令")}
                      <textarea
                        required
                        maxLength={100000}
                        value={followup}
                        onChange={(e) => {
                          setFollowup(e.target.value);
                          followupDrafts.current[selected] = e.target.value;
                          saveFollowups();
                        }}
                        disabled={busy || !!pendingMessage}
                      />
                    </label>
                    <RemoteAttachments key={selected} id={selected} token={token} value={followAttachments} onChange={setFollowAttachments} onBusy={setFollowUploading} disabled={busy||!!pendingMessage}/>
                    <button
                      disabled={
                        busy || followUploading ||
                        (!!pendingMessage && pendingMessage.id !== selected)
                      }
                    >
                      {t(pendingMessage ? "重试同一提交" : "加入待发送队列")}
                    </button>
                    {pendingMessage && (
                      <p>{t("提交结果尚未确认，重试会沿用同一请求编号。")}</p>
                    )}
                    <span>
                      {t("待发送队列")} · {job.queuedMessages?.length || 0}
                    </span>
                  </form>
                </>
              ) : (
                <div className="remote-empty">
                  <h1>{t("选择任务或开始新的工作")}</h1>
                  <p>{t("任务在服务器继续执行，关闭此页面不会停止任务。")}</p>
                </div>
              )}
            </section>
          </main>}
          {settingsOpen && snapshot && <RuntimeSettings settings={snapshot.settings} call={call} close={() => setSettingsOpen(false)} />}
          {templates && <TaskTemplates draft={prompt} preferences={{model,...templateOptions}} call={call} close={() => setTemplates(false)} apply={template => {
            setPrompt(value => value ? value + "\n\n" + template.prompt : template.prompt);
            setModel(template.model); setTemplateOptions({effort:template.effort,planMode:template.planMode,multiAgent:template.multiAgent}); setTemplates(false);
          }} />}
          {searching && <ChatSearch key={searching} id={searching} call={call} close={() => setSearching(undefined)} />}
          {building && (
            <WorkflowBuilder
              jobs={snapshot?.jobs || []}
              cwd={directory}
              call={call}
              close={() => setBuilding(false)}
            />
          )}
          {report && (
            <WorkflowReport
              id={report}
              call={call}
              close={() => setReport(undefined)}
            />
          )}
        </>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
