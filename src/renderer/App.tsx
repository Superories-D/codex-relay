import React, { useEffect, useState } from "react";
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
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [tab, setTab] = useState("dashboard");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"job" | "login" | null>(null);
  const [selected, setSelected] = useState<string>();
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!window.relay) {
      setError("请通过 Codex Relay 桌面程序启动此界面");
      return;
    }
    void window.relay
      .snapshot()
      .then(setSnapshot)
      .catch((e) => setError(String(e)));
    const off = window.relay.onSnapshot(setSnapshot);
    const t = setInterval(() => setClock((x) => x + 1), 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  const cmd = async (name: string, args?: unknown) => {
    setBusy(true);
    setError("");
    try {
      return await window.relay.command(name, args);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const act = (name: string, args?: unknown) =>
    void cmd(name, args).catch(() => {});
  if (!snapshot)
    return (
      <div className="startup">
        <div className="brand-mark">R</div>
        <h1>Codex Relay</h1>
        <p>{error || "正在读取任务与账户…"}</p>
      </div>
    );
  const live =
    snapshot.jobs.find((j) =>
      ["running", "preparing", "pausing", "rotating"].includes(j.state),
    ) ?? snapshot.jobs.find((j) => j.state === "waiting");
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
    setError("");
  };
  const swap = (id: string, offset: number) => {
    const ids = snapshot.accounts.map((a) => a.id);
    const i = ids.indexOf(id);
    if (i + offset < 0 || i + offset >= ids.length) return;
    [ids[i], ids[i + offset]] = [ids[i + offset], ids[i]];
    act("accounts.reorder", ids);
  };
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
          <span className="status-dot" /> 本地运行 · 凭据加密保存
          <small>Windows companion / v0.1.0</small>
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
              className="primary"
              disabled={busy}
              onClick={() => setModal("job")}
            >
              <Icon name="plus" /> 新建任务
            </button>
          </div>
        </header>
        <div className="content">
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
                          <span>{activeAccount?.label ?? "等待账户"}</span>
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
                        ) : (
                          <div className="activity">
                            <i />
                            <i />
                            <i />
                            <i />
                            <i />
                          </div>
                        )}
                        <button
                          onClick={() =>
                            act("job.control", { id: live.id, action: "pause" })
                          }
                        >
                          <Icon name="pause" /> 暂停
                        </button>
                      </div>
                    </div>
                    <div className="relay-strip">
                      <span>01 保存会话</span>
                      <i />
                      <span>02 确认停止</span>
                      <i />
                      <span>03 切换账户</span>
                      <i />
                      <span>04 从中断处继续</span>
                    </div>
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
                <div className="row gap">
                  <button onClick={() => act("account.import")}>
                    导入 auth.json
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
                          <button onClick={() => act("account.refresh", a.id)}>
                            ↻
                          </button>
                          <button
                            className="danger-text"
                            onClick={() => {
                              if (confirm(`删除 ${a.label} 的本地账户记录？`))
                                act("account.remove", a.id);
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
              <div className="task-layout">
                <section className="task-list">
                  {snapshot.jobs.length ? (
                    snapshot.jobs
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
                      <h3>还没有任务</h3>
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
                    <div className="row gap">
                      {!["completed", "cancelled"].includes(focus.state) && (
                        <>
                          <button
                            className="primary"
                            disabled={[
                              "running",
                              "preparing",
                              "pausing",
                            ].includes(focus.state)}
                            onClick={() =>
                              act("job.control", {
                                id: focus.id,
                                action: "resume",
                              })
                            }
                          >
                            继续
                          </button>
                          <button
                            onClick={() =>
                              act("job.control", {
                                id: focus.id,
                                action: "pause",
                              })
                            }
                          >
                            暂停
                          </button>
                          <button
                            className="danger-text"
                            onClick={() =>
                              act("job.control", {
                                id: focus.id,
                                action: "cancel",
                              })
                            }
                          >
                            取消任务
                          </button>
                        </>
                      )}
                    </div>
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
              <LogList logs={snapshot.logs.slice().reverse()} />
            </>
          )}
          {tab === "settings" && (
            <SettingsForm
              key={JSON.stringify(snapshot.settings)}
              settings={snapshot.settings}
              command={cmd}
            />
          )}
        </div>
        <footer>
          <span>任务与账户仅在本机管理</span>
          <span>关闭窗口后留在托盘运行 · 从托盘退出会先暂停任务</span>
        </footer>
      </main>
      {modal && (
        <div
          className="modal-shade"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section className="modal" role="dialog" aria-modal="true">
            <button
              className="modal-close"
              aria-label="关闭"
              onClick={() => setModal(null)}
            >
              ×
            </button>
            {modal === "login" ? (
              <LoginForm
                busy={busy}
                submit={async (a) => {
                  await cmd("account.login", a);
                  setModal(null);
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
                }}
              />
            )}
          </section>
        </div>
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
  return (
    <div className="log-list">
      {logs.length ? (
        logs.map((l) => (
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
    setForm({ ...form, [key]: value });
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
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void command("settings.save", form)
          .then(() => setSaved(true))
          .catch(() => {});
      }}
    >
      <div className="page-title">
        <div>
          <h1>设置</h1>
          <p>设置本机 Codex 路径与轮换节奏。</p>
        </div>
        <button className="primary">{saved ? "已保存 ✓" : "保存设置"}</button>
      </div>
      <section className="settings-section">
        <h2>本机程序</h2>
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
                    if (v) setForm({ ...form, cliPath: String(v) });
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
                    if (v) setForm({ ...form, desktopPath: String(v) });
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
          客户端界面随版本变化。只有唯一匹配到控件才会执行操作；无法确认时保留任务供检查。
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
createRoot(document.getElementById("root")!).render(<App />);
