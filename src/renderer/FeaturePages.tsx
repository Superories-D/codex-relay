import {DeliveryDialog} from "./DeliveryDialog";
import { t, useI18n, formatDate, errorText } from "./i18n";
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Blocks,
  CalendarClock,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  FileCode2,
  LoaderCircle,
  MoreHorizontal,
  Network,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { DesktopData, ScheduledTask } from "../core/desktop";
import { readExtensions } from "./extensions";
type Call = (name: string, args?: unknown) => Promise<any>;
export function ExtensionsPage({
  initial = "plugins",
  cwd,
  call,
  close,
}: {
  initial?: string;
  cwd: string;
  call: Call;
  close: () => void;
}) {
  useI18n();

  const [tab, setTab] = useState(initial),
    [query, setQuery] = useState(""),
    [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<any>(),
    [mcp, setMcp] = useState(false),
    [loginPending, setLoginPending] = useState<Record<string, boolean>>({}),
    [loginMessages, setLoginMessages] = useState<Record<string, string>>({});
  const loadRevision = useRef(0);
  const operation = (method: string, params: unknown = {}) =>
    call("catalog.operation", { method, params });
  const load = async () => {
    const revision = ++loadRevision.current;
    setBusy(true);
    setError("");
    try {
      const result = await readExtensions(tab, cwd, operation);
      if (revision === loadRevision.current) {
        setData(result);
        if (tab === "mcp")
          setSelected(
            (previous: any) =>
              previous &&
              result.data.find((entry: any) => entry.name === previous.name),
          );
      }
    } catch (e) {
      if (revision === loadRevision.current) setError(errorText(e));
    } finally {
      if (revision === loadRevision.current) setBusy(false);
    }
  };
  useEffect(() => {
    setData(undefined);
    setSelected(undefined);
    setQuery("");
    void load();
    return () => {
      ++loadRevision.current;
    };
  }, [tab, cwd]);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(
    () =>
      window.relay.onCatalogLogin?.((update) => {
        setLoginPending((previous) => ({ ...previous, [update.name]: false }));
        setLoginMessages((previous) => ({
          ...previous,
          [update.name]: update.success
            ? t("授权已完成")
            : errorText(update.error || t("授权失败，请重试")),
        }));
        void loadRef.current();
      }),
    [],
  );
  const changeServer = async (remove = false) => {
    setBusy(true);
    setError("");
    try {
      await operation("config/value/write", {
        keyPath: `mcp_servers.${selected.name}${remove ? "" : ".enabled"}`,
        value: remove ? null : !selected.enabled,
        mergeStrategy: "replace",
      });
      await operation("config/mcpServer/reload");
      setSelected(undefined);
      await loadRef.current();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const skills = data?.data?.flatMap((d: any) => d.skills || []) || [];
  const plugins =
    data?.marketplaces?.flatMap((market: any) =>
      (market.plugins || []).map((p: any) => ({
        ...p,
        marketplacePath: market.path,
        remoteMarketplaceName: market.name,
      })),
    ) || [];
  const servers = data?.data || [];
  const entries = (
    tab === "skills" ? skills : tab === "mcp" ? servers : plugins
  ).filter((entry: any) =>
    `${entry.name} ${entry.description || entry.interface?.shortDescription || ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="feature-page">
      <header className="feature-header">
        <button aria-label={t("返回聊天")} onClick={close}>
          <ArrowLeft size={19} />
        </button>
        <span>{t("工具与能力")}</span>
        <button title={t("刷新")} onClick={() => void load()} disabled={busy}>
          <RefreshCw size={17} className={busy ? "spin" : ""} />
        </button>
      </header>
      <div className="feature-layout">
        <nav className="feature-nav">
          {(
            [
              ["plugins", t("插件"), Blocks],
              ["skills", "Skills", Sparkles],
              ["mcp", t("MCP 服务器"), Network],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              className={tab === key ? "selected" : ""}
              key={key}
              onClick={() => setTab(key)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
        <div className="feature-main">
          <div className="feature-title">
            <div>
              <h1>
                {tab === "skills"
                  ? "Skills"
                  : tab === "mcp"
                    ? t("MCP 服务器")
                    : t("插件")}
              </h1>
              <p>
                {tab === "skills"
                  ? t("给 Codex 更多做事的方法。技能会在合适的任务中自动使用。")
                  : tab === "mcp"
                    ? t("连接工具、数据和服务，让 Codex 在任务中直接使用。")
                    : t("为你的工作添加工具、技能和应用连接。")}
              </p>
            </div>
            {tab === "mcp" && (
              <button className="solid-button" onClick={() => setMcp(true)}>
                <Plus size={15} />
                {t("添加服务器")}
              </button>
            )}
          </div>
          <div className="feature-search">
            <Search size={17} />
            <input
              aria-label={t("搜索工具")}
              placeholder={
                tab === "plugins" ? t("搜索插件…") : t("搜索名称和描述…")
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {error && (
            <div className="feature-error" role="alert">
              <p>{error}</p>
              <button onClick={() => void load()}>{t("重试")}</button>
            </div>
          )}
          {busy && !data && (
            <div className="feature-loading">
              <LoaderCircle size={22} className="spin" />
              <p>{t("正在读取你的 CLI 能力…")}</p>
            </div>
          )}
          <div className="feature-grid">
            {entries.map((entry: any) => (
              <button
                className="extension-card"
                disabled={busy}
                key={entry.id || entry.path || entry.name}
                onClick={() => {
                  setSelected(entry);
                  setError("");
                }}
              >
                <span className="extension-icon">
                  {tab === "skills" ? (
                    <Sparkles size={23} />
                  ) : tab === "mcp" ? (
                    <Network size={23} />
                  ) : (
                    <Blocks size={23} />
                  )}
                </span>
                <div>
                  <h3>{entry.interface?.displayName || entry.name}</h3>
                  <p>
                    {entry.description ||
                      entry.interface?.shortDescription ||
                      (tab === "mcp"
                        ? t("{p0} 个工具 · {p1}", {
                            p0: Object.keys(entry.tools || {}).length,
                            p1:
                              entry.authStatus === "notLoggedIn"
                                ? t("需要登录")
                                : entry.authStatus === "oAuth" ||
                                    entry.authStatus === "bearerToken"
                                  ? t("已授权")
                                  : entry.authStatus === "unsupported"
                                    ? t("无需授权")
                                    : t("授权状态未知"),
                          })
                        : "")}
                  </p>
                  <small>
                    {tab === "skills"
                      ? entry.enabled
                        ? t("已启用")
                        : t("已停用")
                      : tab === "mcp"
                        ? !entry.enabled
                          ? t("已停用")
                          : entry.toolsError || entry.runtimeStatus === "failed"
                            ? t("连接失败")
                            : entry.runtimeStatus === "connected"
                              ? t("已连接")
                              : t("已配置")
                        : entry.installed
                          ? t("已安装")
                          : entry.interface?.developerName || t("查看详情")}
                  </small>
                </div>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
          {data && !entries.length && (
            <div className="feature-empty">
              <Blocks size={32} strokeWidth={1} />
              <h3>
                {query
                  ? t("没有匹配的结果")
                  : tab === "mcp"
                    ? t("还没有配置 MCP 服务器")
                    : tab === "skills"
                      ? t("当前目录没有可用技能")
                      : t("CLI 没有返回可用插件")}
              </h3>
              <p>
                {tab === "skills"
                  ? t(
                      "项目技能放在 .agents/skills 或 .codex/skills 中；客户端全局技能保存在数据目录的 cli-profile/skills。",
                    )
                  : t("可以刷新，或检查当前账户及网络连接。")}
              </p>
            </div>
          )}
          {data?.marketplaceLoadErrors?.length > 0 && (
            <div className="feature-error">
              {data.marketplaceLoadErrors.map((e: any, i: number) => (
                <p key={i}>{e.message || JSON.stringify(e)}</p>
              ))}
            </div>
          )}
        </div>
      </div>
      {selected && (
        <div
          className="feature-detail-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelected(undefined);
          }}
        >
          <section
            className="feature-detail"
            role="dialog"
            aria-label={t("工具详情")}
          >
            <button
              className="detail-close"
              aria-label={t("关闭详情")}
              onClick={() => setSelected(undefined)}
            >
              <X size={20} />
            </button>
            <span className="extension-icon large">
              {tab === "skills" ? (
                <Sparkles size={30} />
              ) : tab === "mcp" ? (
                <Network size={30} />
              ) : (
                <Blocks size={30} />
              )}
            </span>
            <h2>{selected.interface?.displayName || selected.name}</h2>
            <p>
              {selected.interface?.longDescription ||
                selected.description ||
                selected.interface?.shortDescription}
            </p>
            {tab === "mcp" ? (
              <>
                <small>
                  {selected.httpOrigin ||
                    selected.serverInfo?.name ||
                    t("本地工具进程")}
                </small>
                <h3>{t("工具")}</h3>
                {selected.toolsError && (
                  <p className="panel-error" role="alert">
                    {selected.toolsError}
                  </p>
                )}
                <div className="mcp-tools">
                  {Object.entries(selected.tools || {}).map(
                    ([name, tool]: [string, any]) => (
                      <details key={name}>
                        <summary>
                          <Code2 size={15} />
                          {name}
                        </summary>
                        <p>{tool.description}</p>
                      </details>
                    ),
                  )}
                </div>
                {selected.enabled &&
                  ["notLoggedIn", "oAuth"].includes(selected.authStatus) && (
                    <button
                      className="solid-button"
                      disabled={busy || loginPending[selected.name]}
                      onClick={async () => {
                        try {
                          setBusy(true);
                          setError("");
                          setLoginMessages((previous) => ({
                            ...previous,
                            [selected.name]: "",
                          }));
                          setLoginPending((previous) => ({
                            ...previous,
                            [selected.name]: true,
                          }));
                          const result = await operation(
                            "mcpServer/oauth/login",
                            {
                              name: selected.name,
                            },
                          );
                          if (result.authorizationUrl)
                            await call("link.open", result.authorizationUrl);
                        } catch (e) {
                          setLoginPending((previous) => ({
                            ...previous,
                            [selected.name]: false,
                          }));
                          setError(errorText(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {loginPending[selected.name]
                        ? t("等待授权…")
                        : t("登录 / 重新授权")}
                      <ArrowUpRight size={15} />
                    </button>
                  )}
                {loginMessages[selected.name] && (
                  <p role="status">{loginMessages[selected.name]}</p>
                )}
                {selected.manageable && (
                  <div className="schedule-form-actions">
                    <button disabled={busy} onClick={() => void changeServer()}>
                      {selected.enabled ? t("停用服务器") : t("启用服务器")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void changeServer(true)}
                    >
                      {t("移除服务器")}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <button
                className="solid-button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    if (tab === "skills")
                      await operation("skills/config/write", {
                        path: selected.path,
                        enabled: !selected.enabled,
                      });
                    else if (selected.installed)
                      await operation("plugin/uninstall", {
                        pluginId: selected.id,
                      });
                    else
                      await operation("plugin/install", {
                        pluginName: selected.name,
                        ...(selected.marketplacePath
                          ? { marketplacePath: selected.marketplacePath }
                          : {
                              remoteMarketplaceName:
                                selected.remoteMarketplaceName,
                            }),
                      });
                    setSelected(undefined);
                    await loadRef.current();
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}
                {tab === "skills"
                  ? selected.enabled
                    ? t("停用技能")
                    : t("启用技能")
                  : selected.installed
                    ? t("卸载插件")
                    : t("安装插件")}
              </button>
            )}
            {error && <p className="panel-error">{error}</p>}
          </section>
        </div>
      )}
      {mcp && (
        <McpForm
          close={() => setMcp(false)}
          save={async (value) => {
            const current = await operation("config/read", {
              includeLayers: false,
            });
            if (Object.hasOwn(current.config?.mcp_servers || {}, value.name))
              throw new Error(t("同名服务器已存在，请使用其他名称"));
            await operation("config/value/write", {
              keyPath: `mcp_servers.${value.name}`,
              value: value.config,
              mergeStrategy: "replace",
            });
            await operation("config/mcpServer/reload");
            setMcp(false);
            await loadRef.current();
          }}
        />
      )}
    </div>
  );
}
function McpForm({
  close,
  save,
}: {
  close: () => void;
  save: (value: { name: string; config: any }) => Promise<void>;
}) {
  useI18n();

  const [name, setName] = useState(""),
    [type, setType] = useState("http"),
    [url, setUrl] = useState(""),
    [command, setCommand] = useState(""),
    [args, setArgs] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="feature-detail-backdrop">
      <form
        className="feature-detail"
        role="dialog"
        aria-label={t("添加 MCP 服务器")}
        onSubmit={(e) => {
          e.preventDefault();
          if (!/^[\w-]+$/.test(name)) {
            setError(t("名称只允许字母、数字、下划线和短横线"));
            return;
          }
          setBusy(true);
          void save({
            name,
            config:
              type === "http"
                ? { url, enabled: true }
                : {
                    command,
                    args: args.split("\n").filter(Boolean),
                    enabled: true,
                  },
          })
            .catch((e) => setError(errorText(e)))
            .finally(() => setBusy(false));
        }}
      >
        <button
          type="button"
          className="detail-close"
          aria-label={t("取消添加")}
          onClick={close}
        >
          <X size={20} />
        </button>
        <h2>{t("添加 MCP 服务器")}</h2>
        <label>
          {t("名称")}
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
          />
        </label>
        <label>
          {t("连接方式")}
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="http">HTTP</option>
            <option value="stdio">{t("本地进程（stdio）")}</option>
          </select>
        </label>
        {type === "http" ? (
          <label>
            {t("服务器 URL")}
            <input
              required
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
            />
          </label>
        ) : (
          <>
            <label>
              {t("可执行程序")}
              <input
                required
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
              />
            </label>
            <label>
              {t("参数（每行一个）")}
              <textarea
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={"-y\n@your/mcp-server"}
              />
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="panel-error">
            {error}
          </p>
        )}
        <button disabled={busy} className="solid-button">
          {busy ? t("正在保存…") : t("保存服务器")}
        </button>
      </form>
    </div>
  );
}
export function SchedulesPage({
  desktop,
  cwd,
  call,
  refresh,
  close,
  select,
}: {
  desktop: DesktopData;
  cwd: string;
  call: Call;
  refresh: () => void;
  close: () => void;
  select: (id: string) => void;
}) {
  useI18n();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const timer = setInterval(() => refreshRef.current(), 3000);
    return () => clearInterval(timer);
  }, []);

  const [editingScheduleChecks,setEditingScheduleChecks]=useState(false);
  const [form, setForm] = useState<Partial<ScheduledTask>>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const add = () =>
    setForm({
      title: "",
      prompt: "",
      cwd,
      enabled: true,
      cadence: "daily",
      minutes: 60,
      hour: 9,
      minute: 0,
      weekday: 1,
      worktree: false,
    });
  return (
    <div className="feature-page">
      <header className="feature-header">
        <button aria-label={t("返回聊天")} onClick={close}>
          <ArrowLeft size={19} />
        </button>
        <span>{t("定时任务")}</span>
      </header>
      <div className="scheduled-main">
        <div className="feature-title">
          <div>
            <h1>{t("让工作按时继续")}</h1>
            <p>
              {t(
                "把重复的工作交给 Codex。任务运行时，需要保持本机和客户端开启。",
              )}
            </p>
          </div>
          <button className="solid-button" onClick={add}>
            <Plus size={16} />
            {t("新建定时任务")}
          </button>
        </div>
        {error && (
          <p role="alert" className="panel-error">
            {error}
          </p>
        )}
        {!desktop.schedules.length ? (
          <div className="schedule-suggestions">
            {[
              [
                t("每天检查项目"),
                t("检查项目的新变更、构建状态和潜在问题，给出简短报告。"),
                "daily",
              ],
              [
                t("定期整理待办"),
                t("查看项目中的 TODO 与待处理事项，整理下一步的工作建议。"),
                "daily",
              ],
              [
                t("每周代码回顾"),
                t("回顾本周提交，概括变更和需要进一步测试的部分。"),
                "weekly",
              ],
            ].map(([title, prompt, cadence]) => (
              <button
                key={title}
                onClick={() =>
                  setForm({
                    title,
                    prompt,
                    cwd,
                    enabled: true,
                    cadence: cadence as ScheduledTask["cadence"],
                    minutes: 60,
                    hour: 9,
                    minute: 0,
                    weekday: 1,
                    worktree: false,
                  })
                }
              >
                <CalendarClock size={23} />
                <h3>{title}</h3>
                <p>{prompt}</p>
                <Plus size={16} />
              </button>
            ))}
          </div>
        ) : (
          <div className="schedule-list">
            {desktop.schedules.map((task) => (
              <section key={task.id}>
                <span className="schedule-icon">
                  <CalendarClock size={22} />
                </span>
                <div>
                  <button onClick={() => setForm({...task,revision:task.revision||0})}>
                    <h3>{task.title}</h3>
                  </button>
                  <p>
                    {task.cadence === "interval"
                      ? t("每 {p0} 分钟", { p0: task.minutes })
                      : task.cadence === "weekly"
                        ? t("每周 {p0} {p1}:{p2}", {
                            p0: [
                              t("日"),
                              t("一"),
                              t("二"),
                              t("三"),
                              t("四"),
                              t("五"),
                              t("六"),
                            ][task.weekday],
                            p1: String(task.hour).padStart(2, "0"),
                            p2: String(task.minute).padStart(2, "0"),
                          })
                        : t("每天 {p0}:{p1}", {
                            p0: String(task.hour).padStart(2, "0"),
                            p1: String(task.minute).padStart(2, "0"),
                          })}{" "}
                    ·{" "}
                    {task.enabled
                      ? t("下次 {p0}", { p0: formatDate(task.nextRun) })
                      : t("已暂停")}
                  </p>
                  {task.lastError && (
                    <p className="panel-error">{t(task.lastError)}</p>
                  )}
                  {task.lastJobId && (
                    <button
                      className="text-link"
                      onClick={() => select(task.lastJobId!)}
                    >
                      {t("查看上次运行")}
                      <ArrowUpRight size={13} />
                    </button>
                  )}
                </div>
                <button
                  title={task.enabled ? t("暂停定时任务") : t("启用定时任务")}
                  onClick={async () => {
                    try {
                      const {
                        nextRun,
                        nextRunZone,
                        lastJobId,
                        lastRun,
                        lastError,
                        pendingRun,
                        ...saved
                      } = task;
                      await call("schedule.save", {
                        ...saved,
                        revision:task.revision||0,
                        enabled: !task.enabled,
                      });
                      refresh();
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                >
                  <Power size={16} />
                </button>
                <button
                  title={t("立即运行一次")}
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const job = await call("schedule.run", task.id);
                      refresh();
                      select(job.id);
                    } catch (e) {
                      setError(errorText(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Play size={16} />
                </button>
              </section>
            ))}
          </div>
        )}
      </div>
      {form && (
        <div className="feature-detail-backdrop">
          <form
            className="feature-detail schedule-form"
            role="dialog"
            aria-label={t("编辑定时任务")}
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              const {
                nextRun,
                nextRunZone,
                lastRun,
                lastJobId,
                lastError,
                pendingRun,
                ...value
              } = form;
              void call("schedule.save", value)
                .then(() => {
                  setForm(undefined);
                  refresh();
                })
                .catch((e) => setError(errorText(e)))
                .finally(() => setBusy(false));
            }}
          >
            <button
              type="button"
              className="detail-close"
              aria-label={t("关闭定时任务编辑")}
              onClick={() => setForm(undefined)}
            >
              <X size={19} />
            </button>
            <h2>{form.id ? t("编辑定时任务") : t("新建定时任务")}</h2>
            {editingScheduleChecks&&<DeliveryDialog purpose="plan" initial={form.deliveryChecks||[]} call={call} saveDraft={checks=>setForm({...form,deliveryChecks:checks})} close={()=>setEditingScheduleChecks(false)}/>}
            <label>
              {t("名称")}
              <input
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>
            <label>
              {t("任务内容")}
              <textarea
                required
                rows={4}
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              />
            </label>
            <label>
              {t("项目目录")}
              <div className="directory-field">
                <input
                  required
                  value={form.cwd}
                  onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                />
                <button
                  type="button"
                  onClick={() =>
                    void call("choose.directory").then(
                      (value) => value && setForm({ ...form, cwd: value }),
                    )
                  }
                >
                  {t("选择")}
                </button>
              </div>
            </label>
            <div className="schedule-time">
              <label>
                {t("频率")}
                <select
                  value={form.cadence}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      cadence: e.target.value as ScheduledTask["cadence"],
                    })
                  }
                >
                  <option value="daily">{t("每天")}</option>
                  <option value="weekly">{t("每周")}</option>
                  <option value="interval">{t("固定间隔")}</option>
                </select>
              </label>
              {form.cadence === "interval" ? (
                <label>
                  {t("间隔（分钟）")}
                  <input
                    type="number"
                    min={5}
                    required
                    value={form.minutes}
                    onChange={(e) =>
                      setForm({ ...form, minutes: Number(e.target.value) })
                    }
                  />
                </label>
              ) : (
                <>
                  <label>
                    {t("时间")}
                    <input
                      type="time"
                      required
                      value={`${String(form.hour).padStart(2, "0")}:${String(form.minute).padStart(2, "0")}`}
                      onChange={(e) => {
                        const [hour, minute] = e.target.value
                          .split(":")
                          .map(Number);
                        setForm({ ...form, hour, minute });
                      }}
                    />
                  </label>
                  {form.cadence === "weekly" && (
                    <label>
                      {t("星期")}
                      <select
                        value={form.weekday}
                        onChange={(e) =>
                          setForm({ ...form, weekday: Number(e.target.value) })
                        }
                      >
                        {[
                          t("日"),
                          t("一"),
                          t("二"),
                          t("三"),
                          t("四"),
                          t("五"),
                          t("六"),
                        ].map((value, i) => (
                          <option value={i} key={i}>
                            {t("周")}
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
            </div>
            <p className="schedule-time-note">
              {t("每天和每周任务跟随系统本地时间。休眠期间错过的运行合并为一次，唤醒后检查。")}
            </p>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={form.worktree}
                onChange={(e) =>
                  setForm({ ...form, worktree: e.target.checked })
                }
              />
              {t("在独立 Git Worktree 中运行")}
            </label>
            <button type="button" disabled={busy} onClick={()=>setEditingScheduleChecks(true)}>{t("每次运行的交付验收")} · {form.deliveryChecks?.length||0}</button>
            <p className="schedule-time-note">{t("计划修改只影响后续运行；已有任务的验收条件保持原样。")}</p>
            {error && (
              <p role="alert" className="panel-error">
                {error}
              </p>
            )}
            <div className="schedule-form-actions">
              {form.id && (
                <button
                  type="button"
                  title={t("删除定时任务")}
                  onClick={() =>
                    void call("schedule.remove", form.id)
                      .then(() => {
                        setForm(undefined);
                        refresh();
                      })
                      .catch((e) => setError(errorText(e)))
                  }
                >
                  <Trash2 size={16} />
                </button>
              )}
              <button className="solid-button" disabled={busy}>
                {busy ? t("正在保存…") : t("保存定时任务")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
