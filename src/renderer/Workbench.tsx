import { t, useI18n, errorText } from "./i18n";
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  LoaderCircle,
  MessageSquare,
  MessageCircleQuestion,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Upload,
  X,
} from "lucide-react";
import type {
  AgentState,
  ChatItem,
  ChatPage,
  Job,
  ChatAsset,
  ChatAttachment,
  Approval,
} from "../shared/types";
import { MarkdownText } from "./RichMessage";
import { ActivityTimeline } from "./ActivityTimeline";
import { ImageThumbnail } from "./ChatImages";
import { GoalCard } from "./GoalCard";
import { QuestionPanel } from "./QuestionPanel";
import { mergePage, agentRows } from "./chat-view";
type Call = (name: string, args?: unknown) => Promise<any>;
function readAgentDrafts(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem("relay.agentDrafts") || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
}
function saveAgentDrafts(values: Record<string, string>) {
  try {
    localStorage.setItem(
      "relay.agentDrafts",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(values)
            .filter(([, text]) => text.trim())
            .slice(-40),
        ),
      ),
    );
  } catch {}
}
export type WorkbenchTab =
  | "summary"
  | "files"
  | "changes"
  | "agents"
  | "questions";
type Entry = { name: string; path: string; directory: boolean };
function Tree({
  cwd,
  at = ".",
  call,
  select,
  level = 0,
}: {
  cwd: string;
  at?: string;
  call: Call;
  select: (path: string) => void;
  level?: number;
}) {
  useI18n();

  const [entries, setEntries] = useState<Entry[]>([]),
    [opened, setOpened] = useState<string[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void call("workspace.files", { cwd, path: at })
      .then((v) => {
        if (alive) setEntries(v);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [cwd, at]);
  return (
    <div className="file-tree">
      {error && <p className="panel-error">{error}</p>}
      {entries.map((e) => (
        <React.Fragment key={e.path}>
          <button
            style={{ paddingLeft: 12 + level * 14 }}
            title={e.path}
            onClick={() =>
              e.directory
                ? setOpened((v) =>
                    v.includes(e.path)
                      ? v.filter((p) => p !== e.path)
                      : [...v, e.path],
                  )
                : select(e.path)
            }
          >
            {e.directory ? (
              opened.includes(e.path) ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )
            ) : (
              <span className="tree-indent" />
            )}
            {e.directory ? (
              opened.includes(e.path) ? (
                <FolderOpen size={15} />
              ) : (
                <Folder size={15} />
              )
            ) : (
              <FileCode2 size={15} />
            )}
            <span>{e.name}</span>
          </button>
          {e.directory && opened.includes(e.path) && (
            <Tree
              cwd={cwd}
              at={e.path}
              call={call}
              select={select}
              level={level + 1}
            />
          )}
        </React.Fragment>
      ))}
      {!entries.length && !error && (
        <p className="file-tree-empty">{t("此目录为空")}</p>
      )}
    </div>
  );
}
export function Workbench({
  tab,
  setTab,
  cwd,
  job,
  items,
  call,
  close,
  file,
  setFile,
  setDraft,
  addSources,
  draftAttachments = [],
  questions = [],
}: {
  tab: WorkbenchTab;
  setTab: (v: WorkbenchTab) => void;
  cwd: string;
  job?: Job;
  items: ChatItem[];
  call: Call;
  close: () => void;
  file: string;
  setFile: (v: string) => void;
  setDraft: (v: string) => void;
  addSources?: () => void;
  draftAttachments?: ChatAttachment[];
  questions?: Approval[];
}) {
  const { language } = useI18n();
  const tabs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = tabs.current;
    if (!list) return;
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const selected = list.querySelector(".selected");
        if (!selected || !list.clientWidth) return;
        const bounds = list.getBoundingClientRect(),
          button = selected.getBoundingClientRect();
        if (button.left < bounds.left)
          list.scrollLeft += button.left - bounds.left;
        else if (button.right > bounds.right)
          list.scrollLeft += button.right - bounds.right;
      });
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    list
      .querySelectorAll("button")
      .forEach((button) => observer.observe(button));
    reveal();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [tab, language]);
  return (
    <aside
      className={`workbench ${file ? "with-preview" : ""}`}
      aria-label={t("工作面板")}
    >
      <header className="workbench-tabs">
        <div className="workbench-tab-list" ref={tabs}>
          {(
            [
              ["summary", t("摘要"), FileText],
              ["files", t("文件"), Folder],
              ["changes", t("更改"), GitCompareArrows],
              ["agents", t("代理"), Network],
              ["questions", t("问题"), MessageCircleQuestion],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              className={tab === key ? "selected" : ""}
              onClick={() => {
                setTab(key);
                setFile("");
              }}
            >
              <Icon size={14} />
              {label}
              {key === "agents" && !!job?.agents?.length && (
                <small>{job.agents.length}</small>
              )}
              {key === "questions" && !!questions.length && (
                <small>
                  {questions.reduce(
                    (n, a) => n + ((a.params as any)?.questions?.length || 0),
                    0,
                  )}
                </small>
              )}
            </button>
          ))}
        </div>
        <button
          className="workbench-close"
          aria-label={t("关闭工作面板")}
          onClick={close}
        >
          <X size={16} />
        </button>
      </header>
      {file ? (
        <FilePreview
          cwd={cwd}
          file={file}
          call={call}
          close={() => setFile("")}
          jobId={job?.id}
        />
      ) : tab === "files" ? (
        cwd ? (
          <div className="workbench-content">
            <div className="panel-section-label">
              {cwd.split(/[\\/]/).at(-1)}
            </div>
            <Tree cwd={cwd} call={call} select={setFile} />
          </div>
        ) : (
          <PanelEmpty text={t("选择一个项目来浏览文件")} />
        )
      ) : tab === "changes" ? (
        <Changes cwd={cwd} call={call} openFile={setFile} comment={setDraft} />
      ) : tab === "agents" ? (
        <Agents job={job} call={call} openFile={setFile} />
      ) : tab === "questions" ? (
        <QuestionPanel job={job} requests={questions} />
      ) : (
        <Summary
          items={items}
          job={job}
          openFile={setFile}
          setTab={setTab}
          call={call}
          cwd={cwd}
          addSources={addSources}
          draftAttachments={draftAttachments}
        />
      )}
    </aside>
  );
}
function PanelEmpty({ text }: { text: string }) {
  useI18n();

  return (
    <div className="panel-empty">
      <FileText size={28} strokeWidth={1} />
      <p>{text}</p>
    </div>
  );
}
function Summary({
  items,
  job,
  openFile,
  setTab,
  call,
  cwd,
  addSources,
  draftAttachments,
}: {
  items: ChatItem[];
  job?: Job;
  openFile: (path: string) => void;
  setTab: (tab: WorkbenchTab) => void;
  call: Call;
  cwd: string;
  addSources?: () => void;
  draftAttachments: ChatAttachment[];
}) {
  useI18n();

  const changes = [
    ...new Set(
      items.flatMap((i) =>
        i.kind === "fileChange"
          ? i.data?.changes?.map((f: any) => f.path) || []
          : [],
      ),
    ),
  ] as string[];
  const attachments = [
    ...new Set(
      items
        .filter((i) => i.role === "user")
        .flatMap((i) => i.detail?.split("\n") || []),
    ),
  ].filter(Boolean);
  const plan = [...items].reverse().find((i) => i.kind === "plan");
  const [assetSnapshot, setAll] = useState<{
    id: string;
    outputs: ChatAsset[];
    sources: ChatAsset[];
  }>();
  useEffect(() => {
    if (!job) return;
    let alive = true;
    void call("chat.assets.list", { id: job.id })
      .then((value) => {
        if (
          alive &&
          Array.isArray(value?.outputs) &&
          Array.isArray(value?.sources)
        )
          setAll({ ...value, id: job.id });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [
    job?.id,
    items.length,
    items
      .map(
        (item) =>
          (item.images?.length || 0) + (item.data?.changes?.length || 0),
      )
      .join(","),
  ]);
  const all = assetSnapshot?.id === job?.id ? assetSnapshot : undefined;
  const asset = (file: string): ChatAsset => ({
    path: file,
    name: file.split(/[\\/]/).at(-1) || file,
    kind: /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file) ? "image" : "file",
  });
  const outputs = all?.outputs || changes.map(asset);
  const sources = [
    ...new Map(
      [
        ...(all?.sources || attachments.map(asset)),
        ...(job?.attachments || []).map((attachment) => asset(attachment.path)),
        ...draftAttachments.map((attachment) => asset(attachment.path)),
      ].map((file) => [file.path, file]),
    ).values(),
  ];
  return (
    <div className="summary-scroll">
      <GoalCard key={job?.id} job={job} call={call} />
      <section className="summary-card">
        <div className="summary-card-title">
          <span>{t("输出内容")}</span>
          <button title={t("浏览项目文件")} onClick={() => setTab("files")}>
            <Plus size={17} />
          </button>
        </div>
        {outputs.length ? (
          <AssetList
            files={outputs}
            openFile={openFile}
            jobId={job?.id}
            cwd={cwd}
          />
        ) : (
          <p>{t("创建文件或站点")}</p>
        )}
        <hr />
        <div className="summary-card-title">
          <span>{t("来源")}</span>
          <button
            title={t("添加来源文件")}
            aria-label={t("添加来源文件")}
            onClick={addSources || (() => setTab("files"))}
          >
            <Plus size={17} />
          </button>
        </div>
        {sources.length ? (
          <AssetList
            files={sources}
            openFile={openFile}
            jobId={job?.id}
            cwd={cwd}
          />
        ) : (
          <p>{t("添加文件作为任务上下文")}</p>
        )}
      </section>
      {plan && (
        <section className="summary-card summary-plan">
          <div className="summary-card-title">{t("执行计划")}</div>
          <MarkdownText text={plan.text + "\n" + (plan.detail || "")} />
        </section>
      )}
      {!!job?.agents?.length && (
        <button className="summary-agent-link" onClick={() => setTab("agents")}>
          <Network size={16} />
          <span>
            {job.agents.length} {t("个子代理")}
          </span>
          <ChevronRight size={14} />
        </button>
      )}
      {job?.tokenUsage && (
        <div className="usage-card">
          <span>{t("上下文使用")}</span>
          <strong>{job.tokenUsage.totalTokens.toLocaleString()} tokens</strong>
          {job.tokenUsage.modelContextWindow && (
            <div className="usage-track">
              <i
                style={{
                  width: `${Math.min(100, (job.tokenUsage.totalTokens / job.tokenUsage.modelContextWindow) * 100)}%`,
                }}
              />
            </div>
          )}
          <small>
            {t("输入")}
            {job.tokenUsage.inputTokens.toLocaleString()} {t("· 输出")}{" "}
            {job.tokenUsage.outputTokens.toLocaleString()}
          </small>
        </div>
      )}
    </div>
  );
}
function AssetList({
  files,
  openFile,
  jobId,
  cwd,
}: {
  files: ChatAsset[];
  openFile: (path: string) => void;
  jobId?: string;
  cwd: string;
}) {
  useI18n();
  const [limit, setLimit] = useState(23);
  const row = (file: ChatAsset) => (
    <div className="summary-file-row" key={file.path}>
      {file.kind === "image" ? (
        <ImageThumbnail
          compact
          context={{ id: jobId, cwd }}
          image={{
            id: file.path,
            name: file.name,
            origin: "input",
            path: file.path,
            url: file.url,
          }}
        />
      ) : (
        <span
          className={`asset-file-icon ${/\.(tsx?|jsx?|py|go|rs|json|css|html)$/i.test(file.name) ? "code" : ""}`}
        >
          <FileCode2 size={16} />
        </span>
      )}
      <button
        className="summary-file-label"
        title={file.path}
        onClick={() =>
          file.url
            ? void window.relay.command("link.open", file.url)
            : openFile(file.path)
        }
      >
        <span>{file.name}</span>
        <small>
          {file.kind === "image"
            ? `${file.name.split(".").at(-1)?.toUpperCase() || ""} · ${t("图片")}`
            : file.name.split(".").at(-1)?.toUpperCase()}
        </small>
      </button>
      <ChevronRight className="asset-row-chevron" size={13} />
    </div>
  );
  return (
    <div className="summary-assets">
      {files.slice(0, 3).map(row)}
      {files.length > 3 && (
        <details className="summary-assets-more">
          <summary>
            <GitBranch size={15} />
            <span className="asset-show-more">
              {t("查看全部 {p0} 项", { p0: files.length })}
            </span>
            <span className="asset-show-less">{t("收起列表")}</span>
            <ChevronDown size={13} />
          </summary>
          <div className="summary-assets-extra">
            {files.slice(3, limit).map(row)}
            {files.length > limit && (
              <button
                className="summary-load-more"
                onClick={() => setLimit((value) => value + 20)}
              >
                {t("再显示 {p0} 项", {
                  p0: Math.min(20, files.length - limit),
                })}
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
function FilePreview({
  cwd,
  file,
  call,
  close,
  jobId,
}: {
  cwd: string;
  file: string;
  call: Call;
  close: () => void;
  jobId?: string;
}) {
  useI18n();

  const [data, setData] = useState<any>(),
    [text, setText] = useState(""),
    [edit, setEdit] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(undefined);
    setError("");
    setEdit(false);
    void window.relay
      .command("chat.asset.read", { cwd, path: file, id: jobId })
      .then((value: any) => {
        if (alive) {
          setData(value);
          setText(value.content);
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [cwd, file, jobId, reload]);
  return (
    <div className="file-preview">
      <header>
        <button aria-label={t("返回文件列表")} onClick={close}>
          <ArrowLeft size={15} />
        </button>
        <span title={file}>{file.split(/[\\/]/).at(-1)}</span>
        {data?.kind === "text" && !data.readOnly && (
          <button
            title={edit ? t("预览文件") : t("编辑文件")}
            onClick={() => setEdit(!edit)}
          >
            <Pencil size={14} />
          </button>
        )}
        <button
          title={t("在默认应用中打开")}
          onClick={() =>
            void window.relay
              .command("chat.asset.open", { cwd, path: file, id: jobId })
              .catch((e) => setError(errorText(e)))
          }
        >
          <Upload size={14} />
        </button>
        {edit && (
          <button
            title={t("保存文件")}
            disabled={busy || text === data.content}
            onClick={() => {
              setBusy(true);
              void window.relay
                .command("workspace.write", {
                  cwd,
                  path: file,
                  text,
                  mtime: data.mtime,
                })
                .then(setData)
                .catch((e) => setError(errorText(e)))
                .finally(() => setBusy(false));
            }}
          >
            <Save size={14} />
          </button>
        )}
      </header>
      {error ? (
        <div className="file-preview-error">
          <p role="alert" className="panel-error">
            {error}
          </p>
          <button onClick={() => setReload((v) => v + 1)}>
            <RefreshCw size={14} />
            {t("重试")}
          </button>
        </div>
      ) : !data ? (
        <div className="panel-loading">
          <LoaderCircle className="spin" size={20} />
          {t("读取文件…")}
        </div>
      ) : data.kind === "image" ? (
        <div className="image-preview">
          <img src={data.content} alt={file} />
        </div>
      ) : data.kind === "pdf" ? (
        <div className="panel-empty">
          <FileText size={36} />
          <p>
            {t("PDF 文档 ·")}
            {(data.size / 1024).toFixed(0)} KB
          </p>
          <button
            onClick={() =>
              void call("chat.asset.open", { cwd, path: file, id: jobId })
            }
          >
            {t("在 PDF 阅读器中打开")}
          </button>
        </div>
      ) : data.kind === "binary" ? (
        <PanelEmpty text={t("此文件使用二进制格式，请在默认应用中打开")} />
      ) : edit ? (
        <textarea
          className="file-editor"
          aria-label={t("编辑文件内容")}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : /\.mdx?$/i.test(file) ? (
        <div className="file-markdown">
          <MarkdownText text={text} />
        </div>
      ) : (
        <div className="source-preview">
          <pre>
            {text.split("\n").map((line, i) => (
              <div key={i}>
                <span>{i + 1}</span>
                <code>{line || " "}</code>
              </div>
            ))}
          </pre>
        </div>
      )}
      <footer>
        {data &&
          t("{p0}{p1} KB", {
            p0:
              data.kind === "text"
                ? t("{p0} 行 · UTF-8 · ", { p0: text.split("\n").length })
                : "",
            p1: (data.size / 1024).toFixed(1),
          })}
      </footer>
    </div>
  );
}
function Changes({
  cwd,
  call,
  openFile,
  comment,
}: {
  cwd: string;
  call: Call;
  openFile: (path: string) => void;
  comment: (text: string) => void;
}) {
  useI18n();

  const [state, setState] = useState<any>(),
    [selected, setSelected] = useState(""),
    [diff, setDiff] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [staged, setStaged] = useState(false),
    [commit, setCommit] = useState(false),
    [message, setMessage] = useState(""),
    [confirmRestore, setConfirmRestore] = useState(false);
  const refresh = () =>
    cwd &&
    void call("workspace.changes", { cwd })
      .then(setState)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [cwd]);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setDiff("");
    void call("workspace.diff", { cwd, path: selected, staged })
      .then((value) => {
        if (alive) setDiff(value);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [cwd, selected, staged, state]);
  const action = async (kind: string) => {
    setBusy(true);
    setError("");
    try {
      setState(
        await call("workspace.git", {
          cwd,
          action: kind,
          path: selected || undefined,
          message: message || undefined,
        }),
      );
      if (kind === "commit") {
        setCommit(false);
        setMessage("");
      }
      if (kind === "restore") {
        setConfirmRestore(false);
        setSelected("");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!cwd) return <PanelEmpty text={t("选择项目以查看 Git 更改")} />;
  return (
    <div className="changes-pane">
      <div className="changes-heading">
        <GitBranch size={15} />
        <span>{state?.branch || "Git"}</span>
        <button title={t("刷新变更")} onClick={refresh}>
          <RefreshCw size={14} />
        </button>
        <button title={t("提交更改")} onClick={() => setCommit(!commit)}>
          <GitCommitHorizontal size={16} />
        </button>
      </div>
      {error && (
        <p role="alert" className="panel-error">
          {error}
        </p>
      )}
      {state?.error ? (
        <PanelEmpty text={t("当前项目尚未初始化 Git 仓库")} />
      ) : (
        <>
          {commit && (
            <div className="commit-form">
              <textarea
                aria-label={t("提交信息")}
                placeholder={t("描述这次更改…")}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <div>
                <button
                  disabled={busy || !message.trim()}
                  onClick={() => void action("commit")}
                >
                  <Check size={14} />
                  {t("提交已暂存更改")}
                </button>
                <button disabled={busy} onClick={() => void action("push")}>
                  <Upload size={14} />
                  {t("推送")}
                </button>
              </div>
            </div>
          )}
          <div className="changed-files">
            {state?.files.map((f: any) => (
              <button
                key={f.path}
                className={selected === f.path ? "selected" : ""}
                onClick={() => {
                  setSelected(f.path);
                  setConfirmRestore(false);
                }}
              >
                <FileCode2 size={14} />
                <span>{f.path}</span>
                <small>
                  {f.index === "?" ? "U" : f.worktree.trim() || f.index}
                </small>
              </button>
            ))}
            {state && !state.files.length && (
              <PanelEmpty text={t("工作区没有未提交的更改")} />
            )}
          </div>
          {selected && (
            <>
              <div className="diff-toolbar">
                <button
                  title={t("打开文件")}
                  onClick={() => openFile(selected)}
                >
                  {selected.split("/").at(-1)}
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={staged}
                    onChange={(e) => setStaged(e.target.checked)}
                  />
                  {t("已暂存")}
                </label>
                <button
                  title={t("暂存文件")}
                  disabled={busy}
                  onClick={() => void action(staged ? "unstage" : "stage")}
                >
                  <Plus size={14} />
                </button>
                <button
                  title={t("还原文件")}
                  disabled={busy}
                  onClick={() => setConfirmRestore(true)}
                >
                  <RotateCcw size={14} />
                </button>
              </div>
              {confirmRestore && (
                <div className="restore-confirm">
                  <p>{t("将丢弃此文件尚未暂存的更改。")}</p>
                  <button onClick={() => void action("restore")}>
                    {t("确认还原此文件")}
                  </button>
                  <button onClick={() => setConfirmRestore(false)}>
                    {t("取消")}
                  </button>
                </div>
              )}
              <div className="diff-lines">
                {diff.split("\n").map((line, index) => (
                  <div
                    key={index}
                    className={
                      line.startsWith("+")
                        ? "added"
                        : line.startsWith("-")
                          ? "removed"
                          : line.startsWith("@@")
                            ? "hunk"
                            : ""
                    }
                  >
                    <button
                      title={t("把这一行加入审查意见")}
                      onClick={() =>
                        comment(
                          t(
                            "请检查 {p0} 的以下变更，并根据我的意见修改：\n\n```diff\n{p1}\n```\n\n意见：",
                            { p0: selected, p1: line },
                          ),
                        )
                      }
                    >
                      <Plus size={10} />
                    </button>
                    <code>{line || " "}</code>
                  </div>
                ))}
              </div>
            </>
          )}
          {!selected && state?.files.length > 0 && (
            <PanelEmpty
              text={t("选择文件查看差异，点击行号旁的加号添加审查意见")}
            />
          )}
        </>
      )}
    </div>
  );
}
function Agents({
  job,
  call,
  openFile,
}: {
  job?: Job;
  call: Call;
  openFile: (path: string) => void;
}) {
  useI18n();

  const [selectedId, setSelectedId] = useState(""),
    [chat, setChat] = useState<ChatPage>(),
    [error, setError] = useState(""),
    [messages, setMessages] = useState<Record<string, string>>(readAgentDrafts),
    [controlling, setControlling] = useState(false);
  const controlLock = useRef(false),
    currentSelection = useRef(selectedId);
  currentSelection.current = selectedId;
  const latestMessages = useRef(messages);
  latestMessages.current = messages;
  useEffect(() => {
    const timer = setTimeout(() => saveAgentDrafts(messages), 300);
    return () => clearTimeout(timer);
  }, [messages]);
  useEffect(() => () => saveAgentDrafts(latestMessages.current), []);
  const message = messages[selectedId] || "";
  const selected = job?.agents?.find((agent) => agent.threadId === selectedId);
  useEffect(() => {
    setSelectedId("");
    setChat(undefined);
    setError("");
  }, [job?.id]);
  useEffect(() => {
    if (!job || !selected) return;
    let alive = true,
      loading = false;
    setError("");
    void call("chat.watch", { id: job.id, threadId: selected.threadId }).catch(
      (e) => {
        if (alive) setError(String(e));
      },
    );
    const read = async () => {
      if (loading) return;
      loading = true;
      try {
        const value = await call("chat.agent.read", {
          id: job.id,
          threadId: selected.threadId,
        });
        if (alive)
          setChat((previous) =>
            previous ? mergePage(previous, value) : value,
          );
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        loading = false;
      }
    };
    void read();
    const offChat = window.relay.onChat?.((update) => {
      if (alive && update.id === selected.threadId)
        setChat((previous) =>
          previous ? mergePage(previous, update.page) : update.page,
        );
    });
    const timer = setInterval(read, window.relay.onChat ? 8000 : 1200);
    return () => {
      alive = false;
      clearInterval(timer);
      offChat?.();
      void call("chat.watch", {
        id: job.id,
        threadId: selected.threadId,
        remove: true,
      }).catch(() => {});
    };
  }, [job?.id, selected?.threadId]);
  const control = (action: "send" | "interrupt") => {
    if (controlLock.current || !job || !selected || job.state !== "running")
      return;
    const threadId = selected.threadId;
    if (action === "send" && !message.trim()) return;
    controlLock.current = true;
    setControlling(true);
    setError("");
    void call("chat.agent.control", {
      id: job.id,
      threadId,
      action,
      ...(action === "send" ? { text: message } : {}),
    })
      .then(() => {
        if (action === "send")
          setMessages((previous) =>
            previous[threadId] === message
              ? { ...previous, [threadId]: "" }
              : previous,
          );
      })
      .catch((error) => {
        if (currentSelection.current === threadId) setError(String(error));
      })
      .finally(() => {
        controlLock.current = false;
        setControlling(false);
      });
  };
  const states: Record<string, string> = {
    running: t("运行中"),
    pendingInit: t("初始化"),
    completed: t("已完成"),
    shutdown: t("已关闭"),
    interrupted: t("已停止"),
    errored: t("出错"),
    failed: t("出错"),
    pending: t("初始化"),
    waiting: t("等待中"),
    interrupting: t("正在停止"),
  };
  return (
    <div className="agents-pane">
      {!job?.agents?.length ? (
        <div className="panel-empty">
          <Network size={30} strokeWidth={1} />
          <p>{t("子代理会在这里显示")}</p>
          <small>
            {t(
              "发送需要并行调查的任务，Codex 可按需派出子代理。你能查看每个代理的进展和结果。",
            )}
          </small>
        </div>
      ) : (
        <>
          <div className="agent-tree-root">
            <Network size={16} />
            <span>{t("主代理")}</span>
            <small>
              {job.agents.length} {t("个子代理")}
            </small>
          </div>
          <div className="agent-tree">
            {agentRows(job.agents).map(({ agent: a, depth }) => (
              <button
                key={a.threadId}
                className={selected?.threadId === a.threadId ? "selected" : ""}
                style={{ paddingLeft: 10 + Math.min(depth, 5) * 14 }}
                data-depth={depth}
                onClick={() => {
                  setSelectedId(a.threadId);
                  setChat(undefined);
                }}
              >
                <span className={`agent-state-dot ${a.status}`} />
                <span>
                  <strong>{a.name}</strong>
                  <small>
                    {a.role || t("子代理")}
                    {a.model ? ` · ${a.model}` : ""}
                    {depth > 0 && a.parentThreadId
                      ? ` · ${t("来自 {p0}", { p0: job.agents?.find((parent) => parent.threadId === a.parentThreadId)?.name || t("子代理") })}`
                      : ""}
                  </small>
                </span>
                <em>{states[a.status] || a.status}</em>
              </button>
            ))}
          </div>
          {selected && (
            <div className="child-conversation">
              <header>
                <span>{selected.name}</span>
                <button
                  title={t("停止子代理")}
                  disabled={
                    controlling ||
                    job.state !== "running" ||
                    !["running", "pendingInit", "waiting"].includes(
                      selected.status,
                    )
                  }
                  onClick={() => control("interrupt")}
                >
                  <Square size={13} />
                </button>
              </header>
              {selected.prompt && (
                <div className="child-prompt">
                  <span>{t("任务")}</span>
                  <MarkdownText text={selected.prompt} />
                </div>
              )}
              {error && <p className="panel-error">{error}</p>}
              <ActivityTimeline
                scope={selected.threadId}
                jobId={job?.id}
                items={chat?.items || []}
                onOpen={openFile}
                onAgents={() => {}}
                onChanges={() => {}}
              />
              {!chat?.items.length && selected.message && (
                <MarkdownText text={selected.message} />
              )}
              <form
                className="child-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  control("send");
                }}
              >
                <input
                  aria-label={t("给子代理发送消息")}
                  placeholder={
                    job.state === "running"
                      ? selected.status === "interrupting"
                        ? t("正在停止子代理，确认后可继续…")
                        : [
                              "running",
                              "pendingInit",
                              "pending",
                              "waiting",
                            ].includes(selected.status)
                          ? t("向子代理补充要求…")
                          : t("发送消息继续这个子代理…")
                      : t("父会话结束后，子代理记录为只读")
                  }
                  disabled={job.state !== "running"}
                  value={message}
                  onChange={(e) =>
                    setMessages((previous) => {
                      const { [selectedId]: old, ...rest } = previous;
                      return { ...rest, [selectedId]: e.target.value };
                    })
                  }
                />
                <button
                  disabled={
                    controlling ||
                    !message.trim() ||
                    job.state !== "running" ||
                    selected.status === "interrupting"
                  }
                  title={t("发送给子代理")}
                >
                  {controlling ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <ChevronRight size={16} />
                  )}
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
