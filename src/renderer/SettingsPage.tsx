import { t, useI18n, languages, type Language, formatDate } from "./i18n";
import React, { useEffect, useState } from "react";
import { copyText } from "./clipboard";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bell,
  Check,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Code2,
  Download,
  ExternalLink,
  FileText,
  Fingerprint,
  Keyboard,
  LoaderCircle,
  Monitor,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import type { DesktopData } from "../core/desktop";
import type { Account, Snapshot } from "../shared/types";
import { fiveHour, timerEvidence } from "../shared/reset-window";
import type { ImportPreview } from "../core/account-import";
import { AccountSelection, AccountValueControl } from "./AccountValue";
import { ImportAllControl } from "./ImportAllControl";
type Call = (name: string, args?: unknown) => Promise<any>;
export function SettingsPage({
  initial,
  snapshot,
  desktop,
  call,
  refresh,
  close,
  advanced,
}: {
  initial: string;
  snapshot: Snapshot;
  desktop: DesktopData;
  call: Call;
  refresh: () => void;
  close: () => void;
  advanced: (tab: string) => void;
}) {
  useI18n();

  const [tab, setTab] = useState(
      [
        "accounts",
        "notifications",
        "appearance",
        "developer",
        "shortcuts",
        "personalization",
      ].includes(initial)
        ? initial
        : "general",
    ),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [cli, setCli] = useState(snapshot.settings.cliPath),
    [checks, setChecks] = useState<any[]>([]),
    [instructions, setInstructions] = useState("");
  useEffect(() => {
    setTab(
      [
        "accounts",
        "notifications",
        "appearance",
        "developer",
        "shortcuts",
        "personalization",
      ].includes(initial)
        ? initial
        : "general",
    );
  }, [initial]);
  const prefs = desktop.preferences;
  const run = async (fn: () => Promise<unknown>, text = "") => {
    setError("");
    setBusy(true);
    try {
      await fn();
      if (text) setNotice(text);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const preference = (value: Partial<DesktopData["preferences"]>) =>
    run(async () => {
      await call("desktop.preferences", value);
      refresh();
    });
  useEffect(() => {
    if (tab === "personalization")
      void call("client.instructions.read")
        .then(setInstructions)
        .catch((e) => setError(String(e)));
  }, [tab]);
  return (
    <div className="feature-page settings-page">
      <header className="feature-header">
        <button aria-label={t("返回聊天")} onClick={close}>
          <ArrowLeft size={19} />
        </button>
        <span>{t("设置")}</span>
      </header>
      <div className="feature-layout">
        <nav className="feature-nav">
          {(
            [
              ["general", t("常规"), Settings2],
              ["appearance", t("外观"), Palette],
              ["accounts", t("账户与接力"), UserRound],
              ["notifications", t("通知"), Bell],
              ["personalization", t("个人指令"), FileText],
              ["shortcuts", t("快捷键"), Keyboard],
              ["developer", t("运行环境"), Code2],
            ] as const
          ).map(([key, name, Icon]) => (
            <button
              key={key}
              className={tab === key ? "selected" : ""}
              onClick={() => {
                setTab(key);
                setError("");
                setNotice("");
              }}
            >
              <Icon size={17} />
              {name}
            </button>
          ))}
          <div className="settings-nav-spacer" />
          <button
            onClick={() =>
              void call("link.open", "https://learn.chatgpt.com/docs/app")
            }
          >
            <CircleHelp size={17} />
            {t("帮助文档")}
            <ExternalLink size={12} />
          </button>
        </nav>
        <div className="feature-main settings-main">
          {error && (
            <div className="feature-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="settings-notice" role="status">
              <Check size={14} />
              {notice}
            </div>
          )}
          {tab === "general" && (
            <>
              <h1>{t("常规")}</h1>
              <ImportAllControl call={call} changed={refresh} />
              <SettingRow
                title={t("并发任务")}
                description={t(
                  "允许多个独立会话同时运行。同组父子会话依次执行；调低上限不会中断正在运行的任务。",
                )}
              >
                <select
                  aria-label={t("并发任务上限")}
                  disabled={busy}
                  value={snapshot.settings.maxConcurrentTasks ?? 3}
                  onChange={(e) => {
                    const maxConcurrentTasks = Number(e.target.value);
                    void run(async () => {
                      await call("tasks.policy", { maxConcurrentTasks });
                      refresh();
                    });
                  }}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <SettingRow
                title={t("语言")}
                description={t(
                  "选择界面语言，聊天内容、代码和终端输出会保留原文。",
                )}
              >
                <select
                  aria-label={t("语言")}
                  value={prefs.language || "auto"}
                  onChange={(e) =>
                    void preference({ language: e.target.value as Language })
                  }
                >
                  {languages.map((language) => (
                    <option value={language.value} key={language.value}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <SettingRow
                title={t("发送消息")}
                description={t("选择 Enter 的行为，Shift + Enter 始终换行。")}
              >
                <select
                  aria-label={t("发送消息快捷键")}
                  value={prefs.enterSends === false ? "mod" : "enter"}
                  onChange={(e) =>
                    void preference({ enterSends: e.target.value === "enter" })
                  }
                >
                  <option value="enter">{t("Enter 发送")}</option>
                  <option value="mod">{t("Ctrl + Enter 发送")}</option>
                </select>
              </SettingRow>
              <SettingRow
                title={t("工作中的追问")}
                description={t(
                  "在 Codex 工作时发送新消息，选择补充当前轮次或等待下一轮。",
                )}
              >
                <select
                  aria-label={t("追问行为")}
                  value={prefs.followUp || "queue"}
                  onChange={(e) =>
                    void preference({
                      followUp: e.target.value as "queue" | "steer",
                    })
                  }
                >
                  <option value="queue">{t("排队等待下一轮")}</option>
                  <option value="steer">{t("补充到当前轮次")}</option>
                </select>
              </SettingRow>
              <SettingRow
                title={t("减少动态效果")}
                description={t(
                  "减少界面动画；系统的减少动态效果设置也会生效。",
                )}
              >
                <Toggle
                  label={t("减少动态效果")}
                  value={!!prefs.reduceMotion}
                  onChange={(value) => void preference({ reduceMotion: value })}
                />
              </SettingRow>
              <div className="settings-info">
                <ShieldCheck size={18} />
                <div>
                  <strong>{t("本机执行与自动账户接力")}</strong>
                  <p>
                    {t(
                      "账户由 Windows 加密存储管理。任务会沿用同一条会话继续，额度不足时在确认原进程停止后切换可用账户。",
                    )}
                  </p>
                </div>
              </div>
              <button
                className="settings-deep-link"
                onClick={() => advanced("tasks")}
              >
                {t("查看任务队列与恢复管理")}
                <ChevronRight size={16} />
              </button>
            </>
          )}
          {tab === "appearance" && (
            <>
              <h1>{t("外观")}</h1>
              <p className="settings-intro">
                {t("调整到你习惯的工作空间，设置会即时应用。")}
              </p>
              <div className="theme-choices">
                {(
                  [
                    ["light", t("浅色"), Sun],
                    ["dark", t("深色"), Moon],
                    ["system", t("跟随系统"), Monitor],
                  ] as const
                ).map(([theme, name, Icon]) => (
                  <button
                    className={prefs.theme === theme ? "selected" : ""}
                    key={theme}
                    onClick={() => void preference({ theme })}
                  >
                    <div className={`theme-miniature ${theme}`}>
                      <i />
                      <i />
                      <i />
                    </div>
                    <span>
                      <Icon size={14} />
                      {name}
                      {prefs.theme === theme && <Check size={14} />}
                    </span>
                  </button>
                ))}
              </div>
              <SettingRow title={t("聊天字号")}>
                <div className="size-control">
                  <input
                    aria-label={t("聊天字号")}
                    type="range"
                    min={12}
                    max={20}
                    step={1}
                    value={prefs.textSize || 15}
                    onChange={(e) =>
                      void preference({ textSize: Number(e.target.value) })
                    }
                  />
                  <span>{prefs.textSize || 15} px</span>
                </div>
              </SettingRow>
              <SettingRow title={t("代码字号")}>
                <div className="size-control">
                  <input
                    aria-label={t("代码字号")}
                    type="range"
                    min={10}
                    max={20}
                    step={1}
                    value={prefs.codeSize || 12}
                    onChange={(e) =>
                      void preference({ codeSize: Number(e.target.value) })
                    }
                  />
                  <span>{prefs.codeSize || 12} px</span>
                </div>
              </SettingRow>
              <SettingRow title={t("强调色")}>
                <div className="accent-choices">
                  {[
                    "#4386f5",
                    "#9a7ce0",
                    "#ce8a58",
                    "#69a98a",
                    "#d4778a",
                    "#a0a0a0",
                  ].map((accent) => (
                    <button
                      key={accent}
                      title={accent}
                      aria-label={t("强调色 {p0}", { p0: accent })}
                      style={{ background: accent }}
                      onClick={() => void preference({ accent })}
                    >
                      {(prefs.accent || "#4386f5") === accent && (
                        <Check size={13} />
                      )}
                    </button>
                  ))}
                  <input
                    type="color"
                    aria-label={t("自定义强调色")}
                    value={prefs.accent || "#4386f5"}
                    onChange={(e) =>
                      void preference({ accent: e.target.value })
                    }
                  />
                </div>
              </SettingRow>
              <SettingRow title={t("界面字体")}>
                <input
                  aria-label={t("界面字体")}
                  defaultValue={
                    prefs.uiFont ||
                    '"Segoe UI", "Microsoft YaHei UI", sans-serif'
                  }
                  onBlur={(e) => void preference({ uiFont: e.target.value })}
                />
              </SettingRow>
              <SettingRow title={t("代码字体")}>
                <input
                  aria-label={t("代码字体")}
                  defaultValue={
                    prefs.codeFont || '"Cascadia Code", Consolas, monospace'
                  }
                  onBlur={(e) => void preference({ codeFont: e.target.value })}
                />
              </SettingRow>
              <button
                className="settings-deep-link"
                onClick={() =>
                  void run(
                    () => copyText(JSON.stringify(prefs, null, 2)),
                    t("主题设置已复制"),
                  )
                }
              >
                {t("复制主题设置")}
                <Clipboard size={15} />
              </button>
            </>
          )}
          {tab === "accounts" && <Accounts snapshot={snapshot} call={call} />}
          {tab === "notifications" && (
            <>
              <h1>{t("通知")}</h1>
              <SettingRow
                title={t("任务完成与需要处理")}
                description={t(
                  "当窗口不在前台时，显示任务完成或需要处理的 Windows 通知。",
                )}
              >
                <Toggle
                  label={t("任务通知")}
                  value={prefs.notifications}
                  onChange={(notifications) =>
                    void preference({ notifications })
                  }
                />
              </SettingRow>
              <div className="settings-info">
                <Bell size={18} />
                <p>
                  {t(
                    "点击通知可返回客户端。你也可以在 Windows 系统设置中管理通知权限。",
                  )}
                </p>
              </div>
            </>
          )}
          {tab === "personalization" && (
            <>
              <h1>{t("个人指令")}</h1>
              <p className="settings-intro">
                {t(
                  "告诉 Codex 你希望它如何工作。指令写入客户端的 AGENTS.md，会在后续运行中加载；项目内的 AGENTS.md 也会生效。",
                )}
              </p>
              <textarea
                className="personal-instructions"
                aria-label={t("个人指令")}
                spellCheck={false}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={t(
                  "例如：使用中文回复；修改代码后运行相关测试；提交前先展示差异。",
                )}
              />
              <button
                className="solid-button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => call("client.instructions.write", instructions),
                    t("个人指令已保存"),
                  )
                }
              >
                {t("保存指令")}
              </button>
            </>
          )}
          {tab === "shortcuts" && (
            <>
              <h1>{t("键盘快捷键")}</h1>
              <p className="settings-intro">
                {t("常用操作可以直接通过键盘完成。")}
              </p>
              {[
                [t("搜索聊天"), "Ctrl + K"],
                [t("新聊天"), "Ctrl + Shift + O"],
                [t("显示 / 隐藏侧栏"), "Ctrl + B"],
                [t("显示 / 隐藏终端"), "Ctrl + J"],
                [t("设置"), "Ctrl + ,"],
                [
                  t("发送消息"),
                  prefs.enterSends === false ? "Ctrl + Enter" : "Enter",
                ],
                [t("换行"), "Shift + Enter"],
                [t("关闭菜单或弹窗"), "Esc"],
              ].map(([name, key]) => (
                <SettingRow title={name} key={name}>
                  <kbd>{key}</kbd>
                </SettingRow>
              ))}
            </>
          )}
          {tab === "developer" && (
            <>
              <h1>{t("运行环境")}</h1>
              <p className="settings-intro">
                {t(
                  "客户端使用你选择的官方 Codex CLI，设置需要与当前机器的安装路径对应。",
                )}
              </p>
              <label className="settings-field">
                {t("Codex CLI 路径")}
                <div>
                  <input
                    aria-label={t("Codex CLI 路径")}
                    value={cli}
                    onChange={(e) => setCli(e.target.value)}
                  />
                  <button
                    onClick={() =>
                      void call("choose.executable").then(
                        (value) => value && setCli(value),
                      )
                    }
                  >
                    {t("选择")}
                  </button>
                </div>
              </label>
              <div className="settings-button-row">
                <button
                  className="solid-button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        call("settings.save", {
                          ...snapshot.settings,
                          cliPath: cli,
                        }),
                      t("CLI 路径已保存"),
                    )
                  }
                >
                  {t("保存路径")}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setChecks((await call("environment.check")).checks),
                    )
                  }
                >
                  {busy ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                  {t("检查运行环境")}
                </button>
              </div>
              {checks.map((check, i) => (
                <SettingRow
                  key={i}
                  title={check.name}
                  description={check.detail}
                >
                  <span className={`environment-result ${check.status}`}>
                    {check.status === "ok"
                      ? t("正常")
                      : check.status === "warning"
                        ? t("提示")
                        : t("异常")}
                  </span>
                </SettingRow>
              ))}
              <button
                className="settings-deep-link"
                onClick={() => advanced("settings")}
              >
                {t("高级客户端适配与诊断设置")}
                <ChevronRight size={16} />
              </button>
              <button
                className="settings-deep-link"
                onClick={() => advanced("logs")}
              >
                {t("查看运行记录")}
                <ChevronRight size={16} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  useI18n();

  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}
function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  useI18n();

  return (
    <button
      type="button"
      className={`settings-toggle ${value ? "on" : ""}`}
      aria-label={label}
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
    >
      <i />
    </button>
  );
}
function Accounts({ snapshot, call }: { snapshot: Snapshot; call: Call }) {
  useI18n();

  const [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [preview, setPreview] = useState<ImportPreview>(),
    [selected, setSelected] = useState<number[]>([]),
    [remove, setRemove] = useState<Account>(),
    [models, setModels] = useState<any[]>(),
    [modelAccount, setModelAccount] = useState("");
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  const importAccounts = (local: boolean) =>
    run("import", async () => {
      const result = await call(
        local ? "account.importLocal" : "account.import",
      );
      if (result) {
        setPreview(result);
        setSelected(
          result.rows
            .filter((r: any) => r.action !== "skip")
            .map((r: any) => r.index),
        );
      }
    });
  const move = (id: string, delta: number) => {
    const ids = snapshot.accounts.map((a) => a.id),
      index = ids.indexOf(id),
      next = index + delta;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    void run("order", () => call("accounts.reorder", ids));
  };
  return (
    <>
      <div className="feature-title">
        <div>
          <h1>{t("账户与接力")}</h1>
          <p>{t("自动选择可用账户，让任务保持上下文继续执行。")}</p>
        </div>
        <button
          className="solid-button"
          disabled={!!busy || !!snapshot.login}
          onClick={() =>
            void run("login", () =>
              call("account.login", { label: "", device: false }),
            )
          }
        >
          <Plus size={15} />
          {t("添加账户")}
        </button>
      </div>
      <div className="settings-button-row">
        <button
          disabled={!!busy || !!snapshot.login}
          onClick={() =>
            void run("login", () =>
              call("account.login", { label: "", device: true }),
            )
          }
        >
          <ExternalLink size={14} /> {t("使用设备验证码登录")}
        </button>
        <button disabled={!!busy} onClick={() => void importAccounts(true)}>
          <Download size={14} />
          {t("导入本机登录")}
        </button>
        <button disabled={!!busy} onClick={() => void importAccounts(false)}>
          <Download size={14} />
          {t("导入账户备份")}
        </button>
      </div>
      <AccountSelection snapshot={snapshot} call={call} />
      {snapshot.login && (
        <div className="login-banner">
          <strong>{t("请在官方页面中完成登录")}</strong>
          {snapshot.login.code && <code>{snapshot.login.code}</code>}
          <div>
            <button onClick={() => void call("account.openLogin")}>
              {t("打开登录页面")}
              <ExternalLink size={13} />
            </button>
            <button onClick={() => void call("account.cancelLogin")}>
              {t("取消")}
            </button>
          </div>
        </div>
      )}
      {snapshot.loginError && (
        <p className="panel-error">{snapshot.loginError}</p>
      )}
      {snapshot.loginResult && (
        <div className="login-banner" role="status">
          <strong>
            {t(
              snapshot.loginResult.updated
                ? "已更新现有账户：{email}"
                : "已添加新账户：{email}",
              { email: snapshot.loginResult.email },
            )}
          </strong>
          {snapshot.loginResult.updated && (
            <p>
              {t(
                "浏览器返回了已存在的账户，因此没有新增卡片。添加其他账户时，请在官方页面切换到目标邮箱后再授权。",
              )}
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      <div className="account-settings-list">
        {snapshot.accounts.map((account, index) => {
          const quota =
            account.quotas.codex || Object.values(account.quotas)[0];
          const inUse = snapshot.jobs.some(
            (j) =>
              j.accountId === account.id &&
              ["preparing", "running", "pausing", "rotating"].includes(j.state),
          );
          return (
            <section key={account.id}>
              <div className="account-setting-heading">
                <span className="account-monogram">
                  {account.label[0]?.toUpperCase() || "A"}
                </span>
                <div>
                  <h3>{account.label || account.email}</h3>
                  <p>
                    {account.plan?.toUpperCase()} · {account.email}
                  </p>
                </div>
                <span className={`account-state ${account.status}`}>
                  {inUse
                    ? t("使用中")
                    : account.status === "ready"
                      ? t("可用")
                      : account.status === "limited"
                        ? t("额度受限")
                        : account.status === "reauth"
                          ? t("需要登录")
                          : t("待核实")}
                </span>
              </div>
              {[
                [t("5 小时剩余"), quota?.primary],
                [t("本周剩余"), quota?.secondary],
              ].map(([label, window]: any, i) => (
                <div className="account-quota" key={i}>
                  <div>
                    <span>{label}</span>
                    <strong>
                      {window
                        ? `${Math.max(0, 100 - window.usedPercent).toFixed(0)}%`
                        : t("未提供")}
                    </strong>
                  </div>
                  <div className="account-quota-track">
                    <i
                      style={{
                        width: window
                          ? `${Math.max(0, 100 - window.usedPercent)}%`
                          : "0%",
                      }}
                    />
                  </div>
                  <small>
                    {window?.resetsAt
                      ? i === 0 &&
                        quota === account.quotas.codex &&
                        window.usedPercent === 0 &&
                        fiveHour(account, quota) &&
                        !timerEvidence(account, quota!)
                        ? t("预计 {p0} 重置 · 计时待确认", {
                            p0: formatDate(window.resetsAt),
                          })
                        : t("{p0} 重置", { p0: formatDate(window.resetsAt) })
                      : t("服务器未提供此额度窗口")}
                  </small>
                </div>
              ))}
              {account.lastError && (
                <p className="panel-error">{account.lastError}</p>
              )}
              <AccountValueControl account={account} call={call} />
              <div className="account-setting-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={account.enabled}
                    disabled={!!busy || inUse}
                    onChange={(e) =>
                      void run(account.id, () =>
                        call("account.update", {
                          id: account.id,
                          enabled: e.target.checked,
                        }),
                      )
                    }
                  />
                  {t("参与接力")}
                </label>
                <button
                  title={t("上移账户")}
                  disabled={!!busy || index === 0}
                  onClick={() => move(account.id, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  title={t("下移账户")}
                  disabled={!!busy || index === snapshot.accounts.length - 1}
                  onClick={() => move(account.id, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  title={t("读取可用模型")}
                  disabled={!!busy || inUse}
                  onClick={() =>
                    void run(account.id, async () => {
                      setModelAccount(account.label);
                      setModels(await call("account.models", account.id));
                    })
                  }
                >
                  <Code2 size={15} />
                </button>
                <button
                  title={t("刷新账户额度")}
                  disabled={!!busy || inUse}
                  onClick={() =>
                    void run(account.id, () =>
                      call("account.refresh", account.id),
                    )
                  }
                >
                  {busy === account.id ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                </button>
                <button
                  title={t("移除账户")}
                  disabled={!!busy || inUse}
                  onClick={() => setRemove(account)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {!snapshot.accounts.length && (
        <div className="feature-empty">
          <UserRound size={30} strokeWidth={1} />
          <h3>{t("添加第一个账户")}</h3>
          <p>{t("通过官方页面登录，或导入这台电脑的 Codex 登录状态。")}</p>
        </div>
      )}
      {preview && (
        <div className="feature-detail-backdrop">
          <section
            className="feature-detail"
            role="dialog"
            aria-label={t("导入账户预览")}
          >
            <h2>{t("确认要导入的账户")}</h2>
            <div className="account-import-preview">
              {preview.rows.map((row) => (
                <label key={row.index}>
                  <input
                    type="checkbox"
                    disabled={row.action === "skip"}
                    checked={selected.includes(row.index)}
                    onChange={(e) =>
                      setSelected((v) =>
                        e.target.checked
                          ? [...v, row.index]
                          : v.filter((i) => i !== row.index),
                      )
                    }
                  />
                  <span>
                    <strong>{row.label || row.email}</strong>
                    <small>
                      {row.error ||
                        (row.action === "update"
                          ? t("更新已有账户")
                          : row.action === "add"
                            ? t("添加账户")
                            : t("跳过"))}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <div className="settings-button-row">
              <button
                className="solid-button"
                disabled={!!busy || !selected.length}
                onClick={() =>
                  void run("import", async () => {
                    await call("account.importCommit", {
                      id: preview.id,
                      indices: selected,
                    });
                    setPreview(undefined);
                  })
                }
              >
                {t("导入")}
                {selected.length} {t("个账户")}
              </button>
              <button
                onClick={() => {
                  void call("account.importCancel", preview.id);
                  setPreview(undefined);
                }}
              >
                {t("取消")}
              </button>
            </div>
            {error && <p className="panel-error">{error}</p>}
          </section>
        </div>
      )}
      {remove && (
        <div className="feature-detail-backdrop">
          <section
            className="feature-detail"
            role="dialog"
            aria-label={t("移除账户")}
          >
            <h2>
              {t("移除")}
              {remove.label}？
            </h2>
            <p>{t("会删除此客户端保存的该账户登录凭据。")}</p>
            <div className="settings-button-row">
              <button
                className="solid-button"
                disabled={!!busy}
                onClick={() =>
                  void run(remove.id, async () => {
                    await call("account.remove", remove.id);
                    setRemove(undefined);
                  })
                }
              >
                {t("确认移除")}
              </button>
              <button onClick={() => setRemove(undefined)}>{t("取消")}</button>
            </div>
          </section>
        </div>
      )}
      {models && (
        <div className="feature-detail-backdrop">
          <section
            className="feature-detail"
            role="dialog"
            aria-label={t("账户可用模型")}
          >
            <button
              className="detail-close"
              aria-label={t("关闭模型列表")}
              onClick={() => setModels(undefined)}
            >
              <X size={18} />
            </button>
            <h2>{modelAccount}</h2>
            <p>{t("此账户实际可用的模型与思考强度。")}</p>
            {models.map((m) => (
              <SettingRow
                key={m.id}
                title={m.displayName || m.model}
                description={m.supportedReasoningEfforts
                  ?.map((e: any) => e.reasoningEffort)
                  .join(" · ")}
              >
                <Code2 size={15} />
              </SettingRow>
            ))}
          </section>
        </div>
      )}
    </>
  );
}
