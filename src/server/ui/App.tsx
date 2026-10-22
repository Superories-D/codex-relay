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
  const [pending, setPending] = useState<Submission | null>(readPending),
    [followup, setFollowup] = useState("");
  const [chat, setChat] = useState<ChatItem[]>([]),
    [before, setBefore] = useState<number>(),
    [chatError, setChatError] = useState("");
  const [building, setBuilding] = useState(false),
    [report, setReport] = useState<string>();
  const previews = useRef(new Map<string, any>());
  const selection = useRef(selected);
  selection.current = selected;
  const job = snapshot?.jobs.find((j) => j.id === selected);
  useEffect(() => {
    sessionStorage.setItem("relay.remote.draft", prompt);
  }, [prompt]);
  useEffect(() => {
    if (pending)
      sessionStorage.setItem("relay.remote.pending", JSON.stringify(pending));
    else sessionStorage.removeItem("relay.remote.pending");
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
        setSelected(accepted.id);
        setPending(null);
        setPrompt((current) =>
          current === pending.input.prompt ? "" : current,
        );
        setError("");
      }
    }
  }, [snapshot, pending]);
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
        effort: "",
        bucket: "codex",
        approvalPolicy: "on-request" as const,
        sandbox: "workspaceWrite" as const,
        interactive: true,
      },
    };
    setPending(payload);
    try {
      const accepted = await action("job.submit", payload);
      setSelected(accepted.id);
      setPending(null);
      setPrompt((current) => (current === payload.input.prompt ? "" : current));
    } catch (e) {
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
    setPrompt("");
    previews.current.clear();
    for (const key of ["token", "pending", "draft"])
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
          <main className="remote-layout">
            <aside className="remote-sidebar">
              <section className="new-task">
                <h2>{t("新建任务")}</h2>
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
                  <button type="submit" disabled={busy || !directory}>
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
                <div className="remote-task-list">
                  {snapshot?.jobs
                    .filter(
                      (j) =>
                        !j.archived &&
                        `${j.title} ${j.cwd}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                    )
                    .slice()
                    .reverse()
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
                      const submitted = followup;
                      void action("chat.send", {
                        id: job.id,
                        text: submitted,
                        attachments: [],
                        action: "queue",
                      })
                        .then(() =>
                          setFollowup((current) =>
                            current === submitted ? "" : current,
                          ),
                        )
                        .catch(() => {});
                    }}
                  >
                    <label>
                      {t("后续指令")}
                      <textarea
                        required
                        maxLength={100000}
                        value={followup}
                        onChange={(e) => setFollowup(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <button disabled={busy}>{t("加入待发送队列")}</button>
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
          </main>
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
