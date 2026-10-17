import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import type {
  Account,
  Approval,
  Bridge,
  Job,
  NewJob,
  Settings,
  Snapshot,
  WindowQuota,
} from "../shared/types";
import "./style.css";
import { RelayFlow } from "./RelayFlow";
import { ImportDialog } from "./ImportDialog";
import { ExistingDialog } from "./ExistingDialog";
import type { ImportPreview } from "../core/account-import";
import type { Diagnostic } from "../core/diagnostics";
import { Dialog } from "./Dialog";
import { operationKey, operationLabel } from "./operations";
import { AgentApp } from "./AgentApp";
declare global {
  interface Window {
    relay: Bridge;
  }
}
const states: Record<string, string> = {
  ready: "可用",
  unknown: "待核实",
  limited: "额度受限",
  reauth: "需要重新登录",
  offline: "连接异常",
  queued: "等待调度",
  preparing: "准备会话",
  running: "正在工作",
  pausing: "正在暂停",
  rotating: "正在切换",
  waiting: "等待额度恢复",
  watching: "监控原会话",
  paused: "已暂停",
  needs_attention: "需要处理",
  completed: "已完成",
  cancelled: "已取消",
};
const time = (ts?: number | null) =>
  ts
    ? new Date(ts).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "未知";
const duration = (ts?: number) => {
  if (!ts) return "—";
  const s = Math.max(0, Math.ceil((ts - Date.now()) / 1000));
  return s >= 86400
    ? `${Math.floor(s / 86400)}天 ${Math.floor((s % 86400) / 3600)}小时`
    : `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
function Icon({ name }: { name: string }) {
  return (
    <span className="icon" aria-hidden>
      {{
        dashboard: "▦",
        accounts: "◉",
        tasks: "▤",
        settings: "⚙",
        logs: "≡",
        plus: "＋",
        play: "▷",
        pause: "Ⅱ",
        refresh: "↻",
        arrow: "→",
      }[name] ?? name}
    </span>
  );
}
function QuotaBar({
  window: w,
  label,
}: {
  window: WindowQuota | null | undefined;
  label: string;
}) {
  const left = w ? Math.max(0, 100 - w.usedPercent) : null;
  return (
    <div className="quota">
      <div className="row">
        <span>{label}</span>
        <b>{left === null ? "未提供" : `${Number(left.toFixed(1))}%`}</b>
      </div>
      <div className="track">
        <div
          className={left !== null && left < 15 ? "low" : ""}
          style={{ width: `${left ?? 0}%` }}
        />
      </div>
      <small>
        {w?.resetsAt
          ? `${time(w.resetsAt)} 重置`
          : w
            ? "重置时间未提供"
            : "该窗口未返回，按服务器信息判断"}
      </small>
    </div>
  );
}
function App({ initialTab = "dashboard" }: { initialTab?: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [tab, setTab] = useState(initialTab);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<
    Record<string, { name: string; at: number }>
  >({});
  const inFlight = useRef(
    new Map<string, { name: string; promise: Promise<unknown> }>(),
  );
  const [connection, setConnection] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [notice, setNotice] = useState("");
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    run: () => void;
  }>();
  const [importPreview, setImportPreview] = useState<ImportPreview>();
  const [desktopReport, setDesktopReport] = useState<any>();
  const [showExisting, setShowExisting] = useState(false);
  const [logSearch, setLogSearch] = useState("");
  const [logLevel, setLogLevel] = useState("all");
  const [taskFilter, setTaskFilter] = useState("all");
  const [taskSearch, setTaskSearch] = useState("");
  const isPending = (name: string, args?: unknown) =>
    !!pending[operationKey(name, args)];
  const busy = isPending("job.add") || isPending("account.login");
  const [modal, setModal] = useState<"job" | "login" | null>(null);
  const [selected, setSelected] = useState<string>();
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!window.relay) {
      setError("请通过 Codex Relay 桌面程序启动此界面");
      return;
    }
    let alive = true;
    let pinging = false;
    const initialTimer = setTimeout(() => {
      if (alive) {
        setConnection("offline");
        setError("读取状态较慢，请等待后台响应，或重试读取。");
      }
    }, 8000);
    void window.relay
      .snapshot()
      .then((value) => {
        if (alive) {
          setSnapshot(value);
          setConnection("online");
          setError("");
        }
      })
      .catch((e) => {
        if (alive) {
          setError(String(e));
          setConnection("offline");
        }
      })
      .finally(() => clearTimeout(initialTimer));
    const off = window.relay.onSnapshot((value) => {
      if (alive) {
        setSnapshot(value);
        setConnection("online");
      }
    });
    const ping = () => {
      if (pinging) return;
      pinging = true;
      const timeout = setTimeout(() => {
        if (alive) setConnection("offline");
      }, 4000);
      void window.relay
        .command("health")
        .then(
          () => {
            if (alive) setConnection("online");
          },
          () => {
            if (alive) setConnection("offline");
          },
        )
        .finally(() => {
          clearTimeout(timeout);
          pinging = false;
        });
    };
    const health = setInterval(ping, 5000);
    const t = setInterval(() => setClock((x) => x + 1), 1000);
    return () => {
      alive = false;
      off();
      clearTimeout(initialTimer);
      clearInterval(health);
      clearInterval(t);
    };
  }, []);
  const cmd = (name: string, args?: unknown): Promise<unknown> => {
    const key = operationKey(name, args);
    const previous = inFlight.current.get(key);
    if (previous) {
      if (previous.name === name) return previous.promise;
      const message = "同一账户正在处理另一项操作，请等待完成后重试。";
      setError(message);
      return Promise.reject(new Error(message));
    }
    setPending((p) => ({ ...p, [key]: { name, at: Date.now() } }));
    setError("");
    const operation = Promise.resolve()
      .then(() => window.relay.command(name, args))
      .catch((e) => {
        setError(String(e).replace(/^Error: /, ""));
        throw e;
      })
      .finally(() => {
        inFlight.current.delete(key);
        setPending((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
      });
    inFlight.current.set(key, { name, promise: operation });
    return operation;
  };
  const openImport = (name: "account.import" | "account.importLocal") => {
    void cmd(name)
      .then((v) => {
        if (v) setImportPreview(v as ImportPreview);
      })
      .catch(() => {});
  };
  const act = (name: string, args?: unknown) =>
    void cmd(name, args).catch(() => {});
  if (!snapshot)
    return (
      <div className="startup">
        <div className="brand-mark">R</div>
        <h1>Codex Relay</h1>
        <p>{error || "正在读取任务与账户…"}</p>
        {error && window.relay && (
          <button
            onClick={() => {
              setError("正在重新读取…");
              void window.relay
                .snapshot()
                .then((v) => {
                  setSnapshot(v);
                  setError("");
                })
                .catch((e) => setError(String(e)));
            }}
          >
            重试读取
          </button>
        )}
      </div>
    );
  const live =
    snapshot.jobs.find((j) =>
      ["running", "preparing", "pausing", "rotating", "watching"].includes(
        j.state,
      ),
    ) ??
    snapshot.jobs.find((j) => j.state === "waiting") ??
    snapshot.jobs.find((j) => j.state === "needs_attention") ??
    snapshot.jobs.find((j) => j.state === "paused") ??
    snapshot.jobs.find((j) => j.state === "queued");
  const focus =
    snapshot.jobs.find((j) => j.id === selected) ??
    live ??
    snapshot.jobs.at(-1);
  const activeAccount = snapshot.accounts.find((a) => a.id === live?.accountId);
  const ready = snapshot.accounts.filter(
    (a) => a.enabled && a.status === "ready",
  ).length;
  const navigate = (key: string) => {
    setTab(key);
  };
  const swap = (id: string, offset: number) => {
    const ids = snapshot.accounts.map((a) => a.id);
    const i = ids.indexOf(id);
    if (i + offset < 0 || i + offset >= ids.length) return;
    [ids[i], ids[i + offset]] = [ids[i + offset], ids[i]];
    act("accounts.reorder", ids);
  };
  const control = (job: Job, action: "pause" | "resume" | "cancel") => {
    const run = () => act("job.control", { id: job.id, action });
    if (action === "cancel")
      setConfirmAction({
        title:
          job.existing && job.existing.phase !== "managed"
            ? "取消接入？"
            : "取消这个任务？",
        message:
          job.existing && job.existing.phase !== "managed"
            ? "取消 Relay 的接入监控，原窗口保持原状态。如果交接已经开始，需先完成停止确认。"
            : "已生成的文件与会话会保留。取消后不再自动恢复，需要继续时请新建任务。",
        run,
      });
    else run();
  };
  const jobActions = (job: Job) => (
    <div className="job-actions row gap wrap">
      {job.existing &&
        job.existing.phase !== "managed" &&
        !["completed", "cancelled"].includes(job.state) && (
          <button
            className="primary"
            disabled={
              job.state === "pausing" ||
              isPending("session.handoff", job.id) ||
              connection === "offline"
            }
            onClick={() => act("session.handoff", job.id)}
          >
            立即交接并继续
          </button>
        )}
      {["paused", "needs_attention"].includes(job.state) && (
        <button
          className="primary"
          disabled={
            isPending("job.control", { id: job.id }) || connection === "offline"
          }
          onClick={() => control(job, "resume")}
        >
          {job.existing && job.existing.phase !== "managed"
            ? "继续监控 / 恢复检查"
            : job.recoveryRequired
              ? "检查并恢复"
              : "继续任务"}
        </button>
      )}
      {[
        "queued",
        "preparing",
        "running",
        "waiting",
        "rotating",
        "pausing",
        "watching",
      ].includes(job.state) && (
        <button
          disabled={
            job.state === "pausing" ||
            isPending("job.control", { id: job.id }) ||
            connection === "offline"
          }
          onClick={() => control(job, "pause")}
        >
          {job.state === "pausing" || isPending("job.control", { id: job.id })
            ? "正在确认停止…"
            : "暂停任务"}
        </button>
      )}
      {!["completed", "cancelled"].includes(job.state) && (
        <button
          className="danger-text"
          disabled={
            isPending("job.control", { id: job.id }) || connection === "offline"
          }
          onClick={() => control(job, "cancel")}
        >
          {job.existing && job.existing.phase !== "managed"
            ? "取消接入"
            : "取消任务"}
        </button>
      )}
      <button onClick={() => act("job.directory", job.id)}>打开工作目录</button>
      {job.mode === "desktop" &&
        ["preparing", "running", "pausing"].includes(job.state) && (
          <>
            <button
              disabled={isPending("job.desktop.show")}
              onClick={() => act("job.desktop.show", job.id)}
            >
              打开受管客户端 ↗
            </button>
            <button
              disabled={isPending("job.desktop.inspect")}
              onClick={() =>
                void cmd("job.desktop.inspect", job.id)
                  .then(setDesktopReport)
                  .catch(() => {})
              }
            >
              检查适配
            </button>
          </>
        )}
    </div>
  );
  const filteredJobs = snapshot.jobs.filter(
    (j) =>
      (taskFilter === "all" ||
        (taskFilter === "active"
          ? !["completed", "cancelled"].includes(j.state)
          : j.state === taskFilter)) &&
      (j.title + " " + j.cwd).toLowerCase().includes(taskSearch.toLowerCase()),
  );
  const filteredLogs = snapshot.logs.filter(
    (l) =>
      (logLevel === "all" || l.level === logLevel) &&
      l.message.toLowerCase().includes(logSearch.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            Codex Relay<small>让任务继续</small>
          </div>
        </div>
        <nav>
          {[
            ["dashboard", "工作台"],
            ["accounts", "账户轮换"],
            ["tasks", "任务队列"],
            ["logs", "运行记录"],
            ["settings", "设置"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? "nav active" : "nav"}
              onClick={() => navigate(key)}
            >
              <Icon name={key} />
              {label}
              {key === "tasks" && (
                <em>
                  {
                    snapshot.jobs.filter(
                      (j) => !["completed", "cancelled"].includes(j.state),
                    ).length
                  }
                </em>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span
            className={`status-dot ${connection === "offline" ? "offline" : ""}`}
          />{" "}
          {connection === "offline" ? "后台响应较慢" : "后台已连接"} · 本机加密
          <small>Agent client / v0.5.0</small>
          <button className="text-button" onClick={() => act("data.open")}>
            打开数据目录 ↗
          </button>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumbs">
            WORKSPACE <span>/</span>{" "}
            {
              (
                {
                  dashboard: "工作台",
                  accounts: "账户轮换",
                  tasks: "任务队列",
                  logs: "运行记录",
                  settings: "设置",
                } as any
              )[tab]
            }
          </div>
          <div className="header-right">
            <span className="pill">
              {snapshot.platform === "win32" ? "Windows" : "开发环境"}
            </span>
            <button
              disabled={connection === "offline"}
              onClick={() => setShowExisting(true)}
            >
              接入已有会话
            </button>
            <button
              className="primary"
              disabled={connection === "offline"}
              onClick={() => setModal("job")}
            >
              <Icon name="plus" /> 新建任务
            </button>
          </div>
        </header>
        <div className="content">
          {connection === "offline" && (
            <div className="alert" role="status">
              后台暂未响应，任务结果仍未知。界面可继续查看；恢复连接前不要重复提交任务。
            </div>
          )}
          {!!Object.keys(pending).length && (
            <div className="operation-banner" role="status" aria-live="polite">
              <span className="spinner" />
              <div>
                {Object.values(pending)
                  .map((p) => operationLabel(p.name))
                  .join(" · ")}
                <small>
                  {Object.values(pending).some((p) => Date.now() - p.at > 15000)
                    ? "操作耗时较长，正在等待进程或服务器确认。你可以切换页面，状态会自动更新。"
                    : "无需重复点击，可以继续查看其他页面。"}
                </small>
              </div>
            </div>
          )}
          {notice && (
            <div className="success-banner" role="status">
              {notice}
            </div>
          )}
          {error && (
            <div className="alert" role="alert">
              {error}
              <button onClick={() => setError("")}>×</button>
            </div>
          )}
          {snapshot.loginError && (
            <div className="alert">登录未完成：{snapshot.loginError}</div>
          )}
          {snapshot.jobs.some((j) => j.recoveryRequired) && (
            <div className="alert">
              检测到上次异常退出，队列暂时冻结。在任务队列中继续或取消待恢复任务，确认原进程已停止后才能继续调度。
            </div>
          )}
          {snapshot.login && (
            <div className="login-banner">
              <div>
                <b>完成账户登录</b>
                <p>
                  {snapshot.login.code ? (
                    <>
                      在官方页面输入{" "}
                      <strong className="device-code">
                        {snapshot.login.code}
                      </strong>
                    </>
                  ) : (
                    "浏览器登录完成后，账户将自动出现在这里。"
                  )}
                </p>
              </div>
              <button onClick={() => act("account.openLogin")}>
                重新打开登录页 ↗
              </button>
              <button
                className="text-button"
                onClick={() => act("account.cancelLogin")}
              >
                取消
              </button>
            </div>
          )}
          {snapshot.approvals.map((a) => (
            <ApprovalCard
              key={`${a.jobId}:${a.id}`}
              approval={a}
              respond={(value) => act("approval.respond", { id: a.id, value })}
            />
          ))}
          {tab === "dashboard" && (
            <>
              <div className="page-title">
                <div>
                  <p className="eyebrow">STAY IN FLOW</p>
                  <h1>接力工作，不丢进度。</h1>
                  <p>额度用尽后保存会话、轮换账户，恢复后继续原任务。</p>
                </div>
                <span className="subtle">
                  {new Date().toLocaleDateString("zh-CN", {
                    month: "long",
                    day: "numeric",
                    weekday: "long",
                  })}
                </span>
              </div>
              <div className="stats">
                <Stat
                  label="可用账户"
                  value={`${ready}`}
                  note={`/ ${snapshot.accounts.length} 个账户`}
                />
                <Stat
                  label="进行中的任务"
                  value={`${snapshot.jobs.filter((j) => !["completed", "cancelled"].includes(j.state)).length}`}
                  note="按顺序执行"
                />
                <Stat
                  label="累计账户接力"
                  value={`${snapshot.jobs.reduce((n, j) => n + j.rotations, 0)}`}
                  note="保留原始会话"
                />
                <Stat
                  label="已完成任务"
                  value={`${snapshot.jobs.filter((j) => j.state === "completed").length}`}
                  note="额度暂停不计入完成"
                />
              </div>
              <section className="work-card">
                <div className="section-heading">
                  <div>
                    <span className="status-dot" /> 当前任务
                  </div>
                  {live && <Badge state={live.state} />}
                </div>
                {live ? (
                  <>
                    <div className="work-main">
                      <div className="work-copy">
                        <h2>{live.title}</h2>
                        <p className="truncate">{live.cwd}</p>
                        <div className="tags">
                          <span>
                            {live.mode === "cli"
                              ? "Codex CLI"
                              : "官方客户端 · 实验适配"}
                          </span>
                          <span>{live.model || "账户默认模型"}</span>
                          <span>
                            {live.existing && live.existing.phase !== "managed"
                              ? "原窗口账户"
                              : (activeAccount?.label ?? "等待账户")}
                          </span>
                        </div>
                      </div>
                      <div className="work-actions">
                        {live.state === "waiting" ? (
                          <>
                            <small>下次核实额度</small>
                            <strong className="countdown">
                              {duration(live.nextWakeAt)}
                            </strong>
                          </>
                        ) : [
                            "running",
                            "preparing",
                            "rotating",
                            "pausing",
                          ].includes(live.state) ? (
                          <div className="activity">
                            <i />
                            <i />
                            <i />
                            <i />
                            <i />
                          </div>
                        ) : (
                          <Badge state={live.state} />
                        )}
                      </div>
                    </div>
                    <JobStatus job={live} />
                    {live.lastError && (
                      <p className="error-message">{live.lastError}</p>
                    )}
                    {jobActions(live)}
                    <RelayFlow job={live} />
                  </>
                ) : (
                  <div className="empty hero-empty">
                    <span className="empty-orbit">↻</span>
                    <h2>准备好接下一棒</h2>
                    <p>
                      {snapshot.accounts.length
                        ? "创建任务，Relay 会自动选择可用账户。"
                        : "先添加你的 ChatGPT 账户，再创建第一个任务。"}
                    </p>
                    <button
                      className="primary"
                      onClick={() =>
                        setModal(snapshot.accounts.length ? "job" : "login")
                      }
                    >
                      {snapshot.accounts.length ? "创建任务" : "添加账户"}{" "}
                      <Icon name="arrow" />
                    </button>
                  </div>
                )}
              </section>
              <div className="section-heading">
                <h2>
                  账户池{" "}
                  <span className="count-label">
                    {snapshot.accounts.length}
                  </span>
                </h2>
                <button
                  className="text-button"
                  onClick={() => navigate("accounts")}
                >
                  管理账户 →
                </button>
              </div>
              <div className="account-grid">
                {snapshot.accounts.slice(0, 3).map((a) => (
                  <AccountCard
                    key={a.id}
                    account={a}
                    active={a.id === live?.accountId}
                    actions={
                      <button
                        className="text-button"
                        disabled={
                          isPending("account.refresh", a.id) ||
                          (a.id === live?.accountId &&
                            ["preparing", "running", "pausing"].includes(
                              live.state,
                            ))
                        }
                        onClick={() => act("account.refresh", a.id)}
                      >
                        刷新额度 ↻
                      </button>
                    }
                  />
                ))}
                {!snapshot.accounts.length && (
                  <button
                    className="add-account"
                    onClick={() => setModal("login")}
                  >
                    <Icon name="plus" />
                    <b>连接第一个账户</b>
                    <small>使用官方浏览器登录或设备码</small>
                  </button>
                )}
              </div>
              <div className="section-heading">
                <h2>最近记录</h2>
                <button
                  className="text-button"
                  onClick={() => navigate("logs")}
                >
                  全部记录 →
                </button>
              </div>
              <LogList logs={snapshot.logs.slice(-5)} />
            </>
          )}
          {tab === "accounts" && (
            <>
              <div className="page-title">
                <div>
                  <h1>账户轮换</h1>
                  <p>按卡片顺序循环选择。每次接力前重新核实额度。</p>
                </div>
                <div className="row gap wrap">
                  <button
                    disabled={isPending("account.importLocal")}
                    onClick={() => openImport("account.importLocal")}
                  >
                    导入本机登录
                  </button>
                  <button
                    disabled={isPending("account.import")}
                    onClick={() => openImport("account.import")}
                  >
                    导入账户备份
                  </button>
                  <button className="primary" onClick={() => setModal("login")}>
                    ＋ 添加账户
                  </button>
                </div>
              </div>
              <div className="notice">
                无 5
                小时限制的账户可以只返回周额度。未提供的窗口显示为“未提供”，不会被当作
                0%。
              </div>
              <div className="account-grid">
                {snapshot.accounts.map((a, i) => (
                  <AccountCard
                    key={a.id}
                    account={a}
                    active={a.id === live?.accountId}
                    actions={
                      <>
                        <label className="toggle">
                          <input
                            type="checkbox"
                            disabled={isPending("account.update", { id: a.id })}
                            checked={a.enabled}
                            onChange={(e) =>
                              act("account.update", {
                                id: a.id,
                                enabled: e.target.checked,
                              })
                            }
                          />
                          参与轮换
                        </label>
                        <div className="row gap">
                          <button
                            title="向前移动"
                            disabled={i === 0}
                            onClick={() => swap(a.id, -1)}
                          >
                            ←
                          </button>
                          <button
                            title="向后移动"
                            disabled={i === snapshot.accounts.length - 1}
                            onClick={() => swap(a.id, 1)}
                          >
                            →
                          </button>
                          <button
                            title="核实额度"
                            disabled={isPending("account.refresh", a.id)}
                            onClick={() => act("account.refresh", a.id)}
                          >
                            {isPending("account.refresh", a.id)
                              ? "核实中…"
                              : "↻"}
                          </button>
                          <button
                            className="danger-text"
                            disabled={isPending("account.remove", a.id)}
                            onClick={() => {
                              setConfirmAction({
                                title: `删除 ${a.label}？`,
                                message:
                                  "仅移除本机保存的账户凭据。正在执行任务的账户需要先暂停。",
                                run: () => act("account.remove", a.id),
                              });
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </>
                    }
                  />
                ))}
              </div>
            </>
          )}
          {tab === "tasks" && (
            <>
              <div className="page-title">
                <div>
                  <h1>任务队列</h1>
                  <p>暂停保留上下文。恢复会话时，接着完成原始目标。</p>
                </div>
              </div>
              <div className="filter-bar">
                <input
                  aria-label="搜索任务"
                  placeholder="搜索任务名称或工作目录"
                  value={taskSearch}
                  onChange={(e) => setTaskSearch(e.target.value)}
                />
                <select
                  aria-label="任务状态筛选"
                  value={taskFilter}
                  onChange={(e) => setTaskFilter(e.target.value)}
                >
                  <option value="all">全部任务</option>
                  <option value="active">未完成</option>
                  <option value="needs_attention">需要处理</option>
                  <option value="waiting">等待额度</option>
                  <option value="paused">已暂停</option>
                  <option value="completed">已完成</option>
                </select>
              </div>
              <div className="task-layout">
                <section className="task-list">
                  {filteredJobs.length ? (
                    filteredJobs
                      .slice()
                      .reverse()
                      .map((j) => (
                        <button
                          key={j.id}
                          className={`task-item ${focus?.id === j.id ? "selected" : ""}`}
                          onClick={() => setSelected(j.id)}
                        >
                          <div className="row">
                            <b>{j.title}</b>
                            <Badge state={j.state} />
                          </div>
                          <p>{j.cwd}</p>
                          <small>
                            {time(j.createdAt)} · {j.rotations} 次接力
                          </small>
                        </button>
                      ))
                  ) : (
                    <div className="empty">
                      <h3>
                        {snapshot.jobs.length ? "没有匹配的任务" : "还没有任务"}
                      </h3>
                      <button onClick={() => setModal("job")}>新建任务</button>
                    </div>
                  )}
                </section>
                {focus && (
                  <section className="task-detail">
                    <div className="section-heading">
                      <h2>{focus.title}</h2>
                      <Badge state={focus.state} />
                    </div>
                    <p className="prompt">{focus.prompt}</p>
                    <dl>
                      <dt>工作目录</dt>
                      <dd>{focus.cwd}</dd>
                      <dt>会话 ID</dt>
                      <dd>{focus.threadId ?? "等待创建"}</dd>
                      <dt>执行模式</dt>
                      <dd>
                        {focus.mode === "cli"
                          ? "Codex CLI"
                          : "官方客户端（实验）"}
                      </dd>
                      {focus.completionMarker && (
                        <>
                          <dt>完成标记</dt>
                          <dd>
                            {focus.completionMarker} · 自动补完{" "}
                            {focus.completionRetries ?? 0}/
                            {focus.maxCompletionRetries ?? 3}
                          </dd>
                        </>
                      )}
                      <dt>额度分组</dt>
                      <dd>{focus.bucket}</dd>
                      {focus.nextWakeAt && (
                        <>
                          <dt>下次额度核实</dt>
                          <dd>
                            {time(focus.nextWakeAt)} ·{" "}
                            {duration(focus.nextWakeAt)}
                          </dd>
                        </>
                      )}
                    </dl>
                    {focus.lastError && (
                      <p className="error-message">{focus.lastError}</p>
                    )}
                    <JobStatus job={focus} />
                    {jobActions(focus)}
                    <h3>任务输出</h3>
                    <LogList
                      logs={snapshot.logs
                        .filter((l) => l.jobId === focus.id)
                        .slice(-50)}
                    />
                  </section>
                )}
              </div>
            </>
          )}
          {tab === "logs" && (
            <>
              <div className="page-title">
                <div>
                  <h1>运行记录</h1>
                  <p>账户接力、等待原因与任务输出。</p>
                </div>
                <button onClick={() => act("logs.export")}>导出诊断记录</button>
              </div>
              <div className="filter-bar">
                <input
                  aria-label="搜索运行记录"
                  placeholder="搜索错误、账户或输出内容"
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                />
                <select
                  aria-label="日志级别"
                  value={logLevel}
                  onChange={(e) => setLogLevel(e.target.value)}
                >
                  <option value="all">全部记录</option>
                  <option value="error">错误</option>
                  <option value="warning">警告</option>
                  <option value="info">状态</option>
                  <option value="output">任务输出</option>
                </select>
              </div>
              <LogList logs={filteredLogs.slice().reverse()} />
            </>
          )}
          {tab === "settings" && (
            <SettingsForm settings={snapshot.settings} command={cmd} />
          )}
        </div>
        <footer>
          <span>任务与账户仅在本机管理</span>
          <span>
            关闭窗口后留在托盘 ·
            退出会暂停受管任务与监控，尚未交接的原窗口继续运行
          </span>
        </footer>
      </main>
      {modal && (
        <Dialog
          title={modal === "job" ? "新建任务" : "添加账户"}
          busy={busy}
          onClose={() => setModal(null)}
        >
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          {modal === "login" ? (
            <LoginForm
              busy={busy}
              submit={async (a) => {
                await cmd("account.login", a);
                setModal(null);
                setNotice("请在官方页面完成登录，账户会自动添加。");
              }}
            />
          ) : (
            <JobForm
              accounts={snapshot.accounts}
              busy={busy}
              command={cmd}
              submit={async (a) => {
                const job = (await cmd("job.add", a)) as Job;
                setSelected(job.id);
                setModal(null);
                setTab("tasks");
                setNotice("任务已加入队列，可以在这里查看执行进度。");
              }}
            />
          )}
        </Dialog>
      )}
      {showExisting && (
        <ExistingDialog
          command={cmd}
          close={() => setShowExisting(false)}
          attached={(job) => {
            setShowExisting(false);
            setSelected(job.id);
            setTab("tasks");
            setNotice("已接入原会话，可在任务详情查看监控和交接进度。");
          }}
        />
      )}
      {importPreview && (
        <ImportDialog
          key={importPreview.id}
          preview={importPreview}
          commit={(indices) =>
            cmd("account.importCommit", {
              id: importPreview.id,
              indices,
            }) as Promise<any>
          }
          cancel={() => {
            act("account.importCancel", importPreview.id);
            setImportPreview(undefined);
          }}
        />
      )}
      {confirmAction && (
        <Dialog
          title={confirmAction.title}
          onClose={() => setConfirmAction(undefined)}
        >
          <h2>{confirmAction.title}</h2>
          <p>{confirmAction.message}</p>
          <div className="row gap">
            <button onClick={() => setConfirmAction(undefined)}>返回</button>
            <button
              className="primary"
              onClick={() => {
                const action = confirmAction;
                setConfirmAction(undefined);
                action.run();
              }}
            >
              确认
            </button>
          </div>
        </Dialog>
      )}
      {desktopReport && (
        <Dialog
          title="客户端适配检查"
          onClose={() => setDesktopReport(undefined)}
        >
          <p className="eyebrow">DESKTOP CHECK</p>
          <h2>客户端适配检查</h2>
          <div className="diagnostic-grid">
            <p>
              <b>{desktopReport.connected ? "已连接" : "未连接"}</b>受管调试连接
            </p>
            <p>
              <b>{desktopReport.threadSelected ? "已确认" : "未确认"}</b>
              当前目标会话
            </p>
            {Object.entries(desktopReport.counts ?? {}).map(([key, value]) => (
              <p key={key}>
                <b>{String(value)} 个</b>
                {(
                  {
                    editorSelector: "可用输入框",
                    sendSelector: "可用发送按钮",
                    stopSelector: "可用停止按钮",
                    threadSelector: "会话控件",
                  } as any
                )[key] ?? key}
              </p>
            ))}
          </div>
          <p className="notice">
            运行中发送按钮可能不可用；停止按钮应唯一。检测只读取控件状态，不会发送消息或改写草稿。
            {desktopReport.hasDraft ? " 当前输入框内有草稿。" : ""}
          </p>
          <button
            onClick={() => {
              setDesktopReport(undefined);
              setTab("settings");
            }}
          >
            查看适配设置
          </button>
        </Dialog>
      )}
    </div>
  );
}
function JobStatus({ job }: { job: Job }) {
  const explanation: Record<string, string> = {
    watching:
      "原窗口 / 终端继续运行，审批在那里处理。额度中断后自动交接，保留原会话。",
    queued: "等待可用账户，系统会自动启动。",
    waiting: "任务尚未完成。到点会重新核实服务器额度，再接着原会话执行。",
    paused:
      job.existing && job.existing.phase !== "managed"
        ? "接入监控已暂停；原窗口可能仍在运行。可以继续监控或立即交接。"
        : "手动暂停，不会自行恢复。点击继续任务后接续原会话。",
    needs_attention:
      job.existing && job.existing.phase !== "managed"
        ? "请核查原窗口和错误详情，再选择继续监控或立即交接；其他队列任务暂不启动。"
        : job.recoveryRequired
          ? "无法确认旧进程是否停止，整个队列已保护性冻结。确认后点击检查并恢复。"
          : "请查看错误详情。处理问题后点击继续任务，将沿用原会话。",
    completed: "本轮正常结束，最终答复与额度检查通过。",
    cancelled: "任务已取消，已有文件和会话仍保留。",
    pausing: "正在确认停止并保存状态。此时不会启动另一个任务进程。",
  };
  return (
    <div className="job-status" role="status">
      <b>
        {["preparing", "running", "rotating", "watching"].includes(job.state)
          ? (job.stage ?? states[job.state])
          : states[job.state]}
      </b>
      <p>
        {explanation[job.state] ??
          (job.mode === "desktop"
            ? "需要审批或输入时，请打开受管客户端处理。"
            : "正在执行原始任务，长时间思考不等于卡死。")}
      </p>
      {job.lastHeartbeatAt && (
        <small>最近连接确认：{time(job.lastHeartbeatAt)}</small>
      )}
      {job.lastActivityAt && (
        <small>最近输出：{time(job.lastActivityAt)}</small>
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
function Badge({ state }: { state: string }) {
  return <span className={`badge ${state}`}>{states[state] ?? state}</span>;
}
function AccountCard({
  account: a,
  active,
  actions,
}: {
  account: Account;
  active: boolean;
  actions: React.ReactNode;
}) {
  const q = a.quotas.codex;
  const label = (w: WindowQuota | null | undefined, fallback: string) =>
    w?.windowDurationMins === 300
      ? "5 小时剩余"
      : w?.windowDurationMins === 10080
        ? "本周剩余"
        : w?.windowDurationMins
          ? `${w.windowDurationMins} 分钟剩余`
          : fallback;
  return (
    <article
      className={`account-card ${active ? "in-use" : ""} ${!a.enabled ? "disabled-account" : ""}`}
    >
      <div className="row">
        <div className="avatar">{a.label.slice(0, 1).toUpperCase()}</div>
        <div className="account-title">
          <b>{a.label}</b>
          <small>
            {a.plan.toUpperCase()} · {active ? "当前账户" : a.email}
          </small>
        </div>
        <Badge state={a.status} />
      </div>
      <QuotaBar label={label(q?.primary, "主窗口剩余")} window={q?.primary} />
      <QuotaBar
        label={label(q?.secondary, "次窗口剩余")}
        window={q?.secondary}
      />
      {Object.keys(a.quotas)
        .filter((k) => k !== "codex")
        .map((k) => (
          <small key={k} className="subtle">
            {k}:{" "}
            {a.quotas[k].primary
              ? `${100 - a.quotas[k].primary!.usedPercent}%`
              : "未提供"}
          </small>
        ))}
      {a.lastError && <p className="error-message">{a.lastError}</p>}
      <div className="account-actions">{actions}</div>
    </article>
  );
}
function LogList({ logs }: { logs: Snapshot["logs"] }) {
  const [limit, setLimit] = useState(100);
  return (
    <div className="log-list">
      {logs.length ? (
        logs.slice(0, limit).map((l) => (
          <div className={`log-row ${l.level}`} key={l.id}>
            <time>
              {new Date(l.at).toLocaleTimeString("zh-CN", { hour12: false })}
            </time>
            <span className="log-dot" />
            <pre>{l.message}</pre>
          </div>
        ))
      ) : (
        <div className="empty compact">新的运行记录会出现在这里</div>
      )}
      {logs.length > limit && (
        <button className="full" onClick={() => setLimit((n) => n + 100)}>
          再显示 100 条（共 {logs.length} 条）
        </button>
      )}
    </div>
  );
}
function LoginForm({
  busy,
  submit,
}: {
  busy: boolean;
  submit: (a: { label: string; device: boolean }) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [device, setDevice] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit({ label, device }).catch(() => {});
      }}
    >
      <p className="eyebrow">CONNECT ACCOUNT</p>
      <h2>添加 ChatGPT 账户</h2>
      <p>登录由官方 Codex 完成。Relay 保存加密的本机凭据。</p>
      <label>
        账户备注
        <input
          placeholder="例如：主账户 / 备用账户"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <div className="segmented">
        <button
          type="button"
          className={!device ? "chosen" : ""}
          onClick={() => setDevice(false)}
        >
          浏览器登录
        </button>
        <button
          type="button"
          className={device ? "chosen" : ""}
          onClick={() => setDevice(true)}
        >
          设备码登录
        </button>
      </div>
      <p className="subtle">
        添加多个账户时，在浏览器中选择对应账户。设备码登录需要在 ChatGPT
        设置中开启。
      </p>
      <button className="primary full" disabled={busy}>
        {busy ? "正在启动登录…" : "前往官方登录页 ↗"}
      </button>
    </form>
  );
}
function JobForm({
  accounts,
  busy,
  command,
  submit,
}: {
  accounts: Account[];
  busy: boolean;
  command: (name: string, args?: unknown) => Promise<unknown>;
  submit: (a: NewJob) => Promise<void>;
}) {
  const [form, setForm] = useState<NewJob>({
    title: "",
    prompt: "",
    cwd: "",
    mode: "cli",
    model: "",
    effort: "",
    bucket: "codex",
    approvalPolicy: "on-request",
    sandbox: "workspaceWrite",
  });
  const [models, setModels] = useState<any[]>([]);
  const patch = (key: keyof NewJob, value: string) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(form).catch(() => {});
      }}
    >
      <p className="eyebrow">NEW TASK</p>
      <h2>开始一段持续工作</h2>
      <label>
        任务名称
        <input
          required
          maxLength={120}
          placeholder="例如：完成项目的账户管理功能"
          value={form.title}
          onChange={(e) => patch("title", e.target.value)}
        />
      </label>
      <label>
        工作目录
        <div className="input-button">
          <input
            required
            placeholder="C:\Projects\my-project"
            value={form.cwd}
            onChange={(e) => patch("cwd", e.target.value)}
          />
          <button
            type="button"
            onClick={() =>
              void command("choose.directory")
                .then((p) => {
                  if (p) patch("cwd", String(p));
                })
                .catch(() => {})
            }
          >
            选择
          </button>
        </div>
      </label>
      <label>
        任务目标
        <textarea
          required
          rows={4}
          placeholder="描述要完成的任务和验收标准…"
          value={form.prompt}
          onChange={(e) => patch("prompt", e.target.value)}
        />
      </label>
      <div className="form-grid">
        <label>
          执行方式
          <select
            value={form.mode}
            onChange={(e) => patch("mode", e.target.value)}
          >
            <option value="cli">Codex CLI（协议接入）</option>
            <option value="desktop">官方客户端（实验适配）</option>
          </select>
        </label>
        <label>
          额度分组
          <input
            value={form.bucket}
            onChange={(e) => patch("bucket", e.target.value)}
            list="buckets"
          />
          <datalist id="buckets">
            {[
              ...new Set([
                "codex",
                ...accounts.flatMap((a) => Object.keys(a.quotas)),
              ]),
            ].map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </label>
        <label>
          模型
          <div className="input-button">
            <input
              placeholder="留空使用默认模型"
              value={form.model}
              onChange={(e) => patch("model", e.target.value)}
              list="models"
            />
            <button
              type="button"
              disabled={!accounts.length || busy}
              onClick={() =>
                void command("account.models", accounts[0].id)
                  .then((m) => setModels(m as any[]))
                  .catch(() => {})
              }
            >
              读取
            </button>
          </div>
          <datalist id="models">
            {models.map((m) => (
              <option key={m.id} value={m.model}>
                {m.displayName}
              </option>
            ))}
          </datalist>
        </label>
        <label>
          推理强度
          <select
            value={form.effort}
            onChange={(e) => patch("effort", e.target.value)}
          >
            {["", "low", "medium", "high", "xhigh", "max", "ultra"].map((v) => (
              <option key={v} value={v}>
                {v || "模型默认"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details>
        <summary>完成校验（可选）</summary>
        <label>
          完成标记
          <input
            maxLength={80}
            placeholder="例如 [TASK_DONE]，留空使用默认检查"
            value={form.completionMarker ?? ""}
            onChange={(e) => patch("completionMarker", e.target.value)}
          />
        </label>
        <label>
          自动补完次数上限
          <input
            type="number"
            min={0}
            max={10}
            value={form.maxCompletionRetries ?? 3}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                maxCompletionRetries: Number(e.target.value),
              }))
            }
          />
        </label>
        <p className="subtle">
          要求最终答复最后独立一行出现标记。缺失时继续原会话，达到上限后保留任务等待检查。额度耗尽仍优先暂停轮换，标记不能代替实际验收。
        </p>
      </details>
      <details>
        <summary>执行权限</summary>
        <div className="form-grid">
          <label>
            文件权限
            <select
              value={form.sandbox}
              onChange={(e) => patch("sandbox", e.target.value)}
            >
              <option value="workspaceWrite">允许工作目录读写</option>
              <option value="readOnly">只读</option>
              <option value="dangerFullAccess">完整访问（无沙盒）</option>
            </select>
          </label>
          <label>
            审批策略
            <select
              value={form.approvalPolicy}
              onChange={(e) => patch("approvalPolicy", e.target.value)}
            >
              <option value="on-request">需要时由我审批</option>
              <option value="never">不请求审批，超出权限直接拒绝</option>
            </select>
          </label>
        </div>
      </details>
      {form.mode === "desktop" && (
        <p className="notice">
          客户端模式会启动独立实例，通过可见控件操作，并核对本机会话记录。界面不兼容时会保留任务，需调整设置中的选择器。此模式尚未进行
          Windows 实机验证。
        </p>
      )}
      <button
        className="primary full"
        disabled={busy || !accounts.some((a) => a.enabled)}
      >
        {accounts.some((a) => a.enabled)
          ? "加入队列并开始 →"
          : "请先添加并启用账户"}
      </button>
    </form>
  );
}
function ApprovalCard({
  approval: a,
  respond,
}: {
  approval: Approval;
  respond: (v: unknown) => void;
}) {
  const p = a.params as any;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [json, setJson] = useState("{}");
  const [inputError, setInputError] = useState("");
  if (a.kind === "permissions")
    return (
      <section className="approval">
        <h3>需要额外权限</h3>
        <p>{p.reason}</p>
        <pre>{JSON.stringify(p.permissions, null, 2)}</pre>
        <div className="row gap">
          <button onClick={() => respond({ decision: "accept" })}>
            仅允许本轮
          </button>
          <button onClick={() => respond({ decision: "decline" })}>拒绝</button>
        </div>
      </section>
    );
  if (a.kind === "elicitation")
    return (
      <section className="approval">
        <h3>{p.serverName} 请求输入</h3>
        <p>{p.message}</p>
        {p.mode === "url" ? (
          <button
            onClick={() =>
              void window.relay
                .command("link.open", p.url)
                .catch((e) => setInputError(String(e)))
            }
          >
            在浏览器中完成 ↗
          </button>
        ) : (
          <>
            <details>
              <summary>查看表单格式</summary>
              <pre>{JSON.stringify(p.requestedSchema, null, 2)}</pre>
            </details>
            <label>
              表单内容（JSON）
              <textarea
                value={json}
                onChange={(e) => setJson(e.target.value)}
              />
            </label>
          </>
        )}
        {inputError && <p>{inputError}</p>}
        <div className="row gap">
          <button
            onClick={() => {
              try {
                respond({
                  action: "accept",
                  content: p.mode === "url" ? null : JSON.parse(json),
                  _meta: null,
                });
              } catch (e) {
                setInputError(String(e));
              }
            }}
          >
            提交
          </button>
          <button
            onClick={() =>
              respond({ action: "decline", content: null, _meta: null })
            }
          >
            拒绝
          </button>
          <button
            onClick={() =>
              respond({ action: "cancel", content: null, _meta: null })
            }
          >
            取消
          </button>
        </div>
      </section>
    );
  return (
    <section className="approval">
      <h3>需要你的{a.kind === "input" ? "输入" : "审批"}</h3>
      {a.kind === "input" ? (
        <>
          {(p.questions ?? []).map((q: any) => (
            <label key={q.id}>
              {q.question}
              {q.options?.length ? (
                <select
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers({ ...answers, [q.id]: e.target.value })
                  }
                >
                  <option value="">请选择</option>
                  {q.options.map((o: any) => (
                    <option key={o.label} value={o.label}>
                      {o.label} — {o.description}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers({ ...answers, [q.id]: e.target.value })
                  }
                />
              )}
            </label>
          ))}
          <button
            onClick={() =>
              respond({
                answers: Object.fromEntries(
                  Object.entries(answers).map(([key, value]) => [
                    key,
                    { answers: [value] },
                  ]),
                ),
              })
            }
          >
            提交回答
          </button>
        </>
      ) : (
        <>
          <pre>{JSON.stringify(p, null, 2)}</pre>
          <div className="row gap">
            <button
              className="primary"
              onClick={() => respond({ decision: "accept" })}
            >
              允许这一次
            </button>
            <button onClick={() => respond({ decision: "decline" })}>
              拒绝
            </button>
            <button onClick={() => respond({ decision: "cancel" })}>
              取消本轮
            </button>
          </div>
        </>
      )}
    </section>
  );
}
function SettingsForm({
  settings,
  command,
}: {
  settings: Settings;
  command: (name: string, args?: unknown) => Promise<unknown>;
}) {
  const [form, setForm] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [installations, setInstallations] = useState<any[]>([]);
  const [detected, setDetected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>();
  return (
    <form
      onChangeCapture={() => setSaved(false)}
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        void command("settings.save", form)
          .then(() => setSaved(true))
          .catch(() => {})
          .finally(() => setSaving(false));
      }}
    >
      <div className="page-title">
        <div>
          <h1>设置</h1>
          <p>设置本机 Codex 路径与轮换节奏。</p>
        </div>
        <button className="primary" disabled={saving}>
          {saving ? "正在保存…" : saved ? "已保存 ✓" : "保存设置"}
        </button>
      </div>
      <section className="settings-section">
        <h2>本机程序</h2>
        <button
          type="button"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void command("environment.check")
              .then((r: any) => setDiagnostics(r.checks))
              .catch(() => {})
              .finally(() => setChecking(false));
          }}
        >
          {checking ? "正在检查环境…" : "检查运行环境"}
        </button>
        {diagnostics && (
          <div className="environment-checks" role="status">
            {diagnostics.map((d) => (
              <div key={d.name} className={`environment-item ${d.status}`}>
                <b>
                  {d.status === "ok" ? "✓" : d.status === "error" ? "×" : "!"}{" "}
                  {d.name}
                </b>
                <p>{d.detail}</p>
              </div>
            ))}
          </div>
        )}
        <p className="subtle">
          环境检查使用已保存的 CLI 路径。修改路径后请先保存。
        </p>
        <button
          type="button"
          disabled={detecting}
          onClick={() => {
            setDetecting(true);
            void command("desktop.detect")
              .then((r: any) => {
                setDetected(true);
                setInstallations(r.candidates ?? []);
                if (r.candidates?.length === 1)
                  setForm((p) => ({
                    ...p,
                    desktopPath: r.candidates[0].executable,
                  }));
                setSaved(false);
              })
              .catch(() => {})
              .finally(() => setDetecting(false));
          }}
        >
          {detecting ? "正在检测…" : "自动检测官方客户端"}
        </button>
        {detected && (
          <p className="notice">
            {installations.length
              ? `发现 ${installations.length} 个安装；选择后保存设置。`
              : "未找到已知安装位置，请手动选择 Codex.exe。"}
          </p>
        )}
        {installations.length > 1 && (
          <label>
            检测到的安装
            <select
              aria-label="选择客户端安装"
              value={form.desktopPath}
              onChange={(e) =>
                setForm((p) => ({ ...p, desktopPath: e.target.value }))
              }
            >
              <option value="">选择一个安装</option>
              {installations.map((i) => (
                <option key={i.executable} value={i.executable}>
                  {i.name} · {i.version} · {i.source}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Codex CLI
          <div className="input-button">
            <input
              value={form.cliPath}
              onChange={(e) => setForm({ ...form, cliPath: e.target.value })}
            />
            <button
              type="button"
              onClick={() =>
                void command("choose.executable")
                  .then((v) => {
                    if (v) setForm((p) => ({ ...p, cliPath: String(v) }));
                  })
                  .catch(() => {})
              }
            >
              选择文件
            </button>
          </div>
          <small>可以填写 codex、codex.exe 或 npm 安装生成的 codex.cmd。</small>
        </label>
        <label>
          官方客户端路径（可选）
          <div className="input-button">
            <input
              placeholder="留空尝试发现 Microsoft Store 安装"
              value={form.desktopPath}
              onChange={(e) =>
                setForm({ ...form, desktopPath: e.target.value })
              }
            />
            <button
              type="button"
              onClick={() =>
                void command("choose.executable")
                  .then((v) => {
                    if (v) setForm((p) => ({ ...p, desktopPath: String(v) }));
                  })
                  .catch(() => {})
              }
            >
              选择文件
            </button>
          </div>
        </label>
      </section>
      <section className="settings-section">
        <h2>额度与恢复</h2>
        <div className="form-grid">
          <label>
            额度核实间隔 / 秒
            <input
              type="number"
              min={10}
              max={300}
              value={form.pollSeconds}
              onChange={(e) =>
                setForm({ ...form, pollSeconds: Number(e.target.value) })
              }
            />
          </label>
          <label>
            未知重置时间的重试间隔 / 秒
            <input
              type="number"
              min={30}
              max={3600}
              value={form.retrySeconds}
              onChange={(e) =>
                setForm({ ...form, retrySeconds: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <label>
          中断后继续执行的提示
          <textarea
            rows={3}
            value={form.resumePrompt}
            onChange={(e) => setForm({ ...form, resumePrompt: e.target.value })}
          />
        </label>
        <div className="notice">
          所有账户都用尽时，根据每个账户全部受限窗口的重置时间等待。时间到了仍需从服务器确认恢复，不直接假定额度已满。
        </div>
      </section>
      <section className="settings-section">
        <h2>官方客户端适配 · 实验</h2>
        <p>
          先检测安装并保存设置。运行 Desktop
          任务后，可在任务详情打开受管窗口或检查会话与控件。首次启动若出现引导或权限提示，请在官方窗口完成。以下选择器仅在默认适配失败时调整。
        </p>
        {Object.entries(form.desktop)
          .filter(([key]) => key !== "projectSelector")
          .map(([key, value]) => (
            <label key={key}>
              {
                (
                  {
                    editorSelector: "输入框 CSS 选择器",
                    sendSelector: "发送按钮 CSS 选择器",
                    stopSelector: "停止按钮 CSS 选择器",
                    threadSelector: "会话 CSS 选择器，{threadId} 会自动替换",
                  } as any
                )[key]
              }
              <input
                value={value}
                onChange={(e) =>
                  setForm({
                    ...form,
                    desktop: { ...form.desktop, [key]: e.target.value },
                  })
                }
              />
            </label>
          ))}
      </section>
    </form>
  );
}
createRoot(document.getElementById("root")!).render(
  <AgentApp
    management={(tab) => <App initialTab={tab} />}
    approval={(a, respond) => <ApprovalCard approval={a} respond={respond} />}
  />,
);
