import { t, useI18n } from "./i18n";
import React, { useEffect, useState } from "react";
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
import type { AgentState, ChatItem, ChatPage, Job } from "../shared/types";
import { MarkdownText, RichMessage } from "./RichMessage";
type Call = (name: string, args?: unknown) => Promise<any>;
export type WorkbenchTab = "summary" | "files" | "changes" | "agents";
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
}) {
  useI18n();

  return (
    <aside
      className={`workbench ${file ? "with-preview" : ""}`}
      aria-label={t("工作面板")}
    >
      <header className="workbench-tabs">
        {(
          [
            ["summary", t("摘要"), FileText],
            ["files", t("文件"), Folder],
            ["changes", t("更改"), GitCompareArrows],
            ["agents", t("代理"), Network],
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
          </button>
        ))}
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
      ) : (
        <Summary items={items} job={job} openFile={setFile} setTab={setTab} />
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
}: {
  items: ChatItem[];
  job?: Job;
  openFile: (path: string) => void;
  setTab: (tab: WorkbenchTab) => void;
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
  return (
    <div className="summary-scroll">
      <section className="summary-card">
        <div className="summary-card-title">
          <span>{t("输出内容")}</span>
          <button title={t("浏览项目文件")} onClick={() => setTab("files")}>
            <Plus size={17} />
          </button>
        </div>
        {changes.length ? (
          changes.map((file) => (
            <button
              key={file}
              className="summary-file"
              onClick={() => openFile(file)}
            >
              <FileCode2 size={16} />
              <span>{file.split(/[\\/]/).at(-1)}</span>
            </button>
          ))
        ) : (
          <p>{t("创建文件或站点")}</p>
        )}
        <hr />
        <div className="summary-card-title">
          <span>{t("来源")}</span>
          <button title={t("浏览来源文件")} onClick={() => setTab("files")}>
            <Plus size={17} />
          </button>
        </div>
        {attachments.length ? (
          attachments.map((file) => (
            <button
              key={file}
              className="summary-file"
              onClick={() => openFile(file)}
            >
              <File size={16} />
              <span>{file.split(/[\\/]/).at(-1)}</span>
            </button>
          ))
        ) : (
          <p>{t("添加文件作为任务上下文")}</p>
        )}
        {(changes.length > 0 || attachments.length > 0) && (
          <button className="summary-all" onClick={() => setTab("files")}>
            <GitBranch size={15} />
            {t("查看全部")}
          </button>
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
function FilePreview({
  cwd,
  file,
  call,
  close,
}: {
  cwd: string;
  file: string;
  call: Call;
  close: () => void;
}) {
  useI18n();

  const [data, setData] = useState<any>(),
    [text, setText] = useState(""),
    [edit, setEdit] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(undefined);
    setError("");
    setEdit(false);
    void call("workspace.read", { cwd, path: file })
      .then((value) => {
        if (alive) {
          setData(value);
          setText(value.content);
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [cwd, file]);
  return (
    <div className="file-preview">
      <header>
        <button aria-label={t("返回文件列表")} onClick={close}>
          <ArrowLeft size={15} />
        </button>
        <span title={file}>{file.split(/[\\/]/).at(-1)}</span>
        {data?.kind === "text" && (
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
            void call("workspace.open", { cwd, path: file }).catch((e) =>
              setError(String(e)),
            )
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
              void call("workspace.write", {
                cwd,
                path: file,
                text,
                mtime: data.mtime,
              })
                .then(setData)
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            <Save size={14} />
          </button>
        )}
      </header>
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
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
            onClick={() => void call("workspace.open", { cwd, path: file })}
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
                ? `${text.split("\n").length} 行 · UTF-8 · `
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

  const [selected, setSelected] = useState<AgentState>(),
    [chat, setChat] = useState<ChatPage>(),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (!job || !selected) return;
    let alive = true,
      loading = false;
    const read = async () => {
      if (loading) return;
      loading = true;
      try {
        const value = await call("chat.agent.read", {
          id: job.id,
          threadId: selected.threadId,
        });
        if (alive) setChat(value);
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        loading = false;
      }
    };
    void read();
    const timer = setInterval(read, 1200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [job?.id, selected?.threadId]);
  const states: Record<string, string> = {
    running: t("运行中"),
    pendingInit: t("初始化"),
    completed: t("已完成"),
    shutdown: t("已关闭"),
    interrupted: t("已停止"),
    errored: t("出错"),
    waiting: t("等待中"),
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
            {job.agents.map((a) => (
              <button
                key={a.threadId}
                className={selected?.threadId === a.threadId ? "selected" : ""}
                onClick={() => {
                  setSelected(a);
                  setChat(undefined);
                }}
              >
                <span className={`agent-state-dot ${a.status}`} />
                <span>
                  <strong>{a.name}</strong>
                  <small>
                    {a.role || t("子代理")}
                    {a.model ? ` · ${a.model}` : ""}
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
                  onClick={() =>
                    void call("chat.agent.control", {
                      id: job.id,
                      threadId: selected.threadId,
                      action: "interrupt",
                    }).catch((e) => setError(String(e)))
                  }
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
              {chat?.items.map((i) => (
                <RichMessage
                  key={i.id}
                  item={i}
                  onOpen={openFile}
                  onAgents={() => {}}
                  onChanges={() => {}}
                />
              ))}
              {!chat?.items.length && selected.message && (
                <MarkdownText text={selected.message} />
              )}
              <form
                className="child-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void call("chat.agent.control", {
                    id: job.id,
                    threadId: selected.threadId,
                    action: "send",
                    text: message,
                  })
                    .then(() => setMessage(""))
                    .catch((e) => setError(String(e)));
                }}
              >
                <input
                  aria-label={t("给子代理发送消息")}
                  placeholder={t("向子代理补充要求…")}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <button disabled={!message.trim()} title={t("发送给子代理")}>
                  <ChevronRight size={16} />
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
