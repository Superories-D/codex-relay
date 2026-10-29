import { FileBrowser } from "./FileBrowser";
import { t, useI18n, errorText } from "./i18n";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { DiffReview } from "./DiffReview";
import { reviewReport, verifyReviewSession, reviewableDiff, reviewNote, diffFingerprint, fileReviewed, nextReviewFile, readReviewSession, reviewKey, reviewSides, reviewStorageKey, updateReviewMark, type ReviewSession } from "./review-session";
import "./review-workspace.css";
import {
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  Download,
  Check,
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitMerge,
  GitCommitHorizontal,
  GitCompareArrows,
  LoaderCircle,
  MessageSquare,
  MessageCircleQuestion,
  Maximize2,
  Minimize2,
  Network,
  Pencil,
  Plus,
  Minus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
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
import { MarkdownText, UserText } from "./RichMessage";
import { ActivityTimeline } from "./ActivityTimeline";
import { ImageThumbnail } from "./ChatImages";
import { GoalCard } from "./GoalCard";
import { TokenUsageCard } from "./TokenUsageCard";
import { GitBranchPicker } from "./GitBranchPicker";
import {WorkspaceCheckpoints} from "./WorkspaceCheckpoints";
import {HandoffCenter} from "./HandoffCenter";
import { QuestionPanel } from "./QuestionPanel";
import { mergePage, agentRows } from "./chat-view";
import {
  gitConflict,
  gitStaged,
  gitUnstaged,
  type GitChanges,
} from "../shared/git";
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
  onOpenConversation,
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
  onOpenConversation?: (job: Job) => void;
}) {
  const { language } = useI18n();
  const [wide, setWide] = useState(false);
  const [checkpoints,setCheckpoints]=useState(false);
  const [handoffs,setHandoffs]=useState(false);
  const [gitPreview, setGitPreview] = useState<{
    cwd: string;
    root: string;
    file: string;
  }>();
  useEffect(() => {
    if (!file) setGitPreview(undefined);
  }, [file]);
  const repositoryPreview =
    tab === "changes" && gitPreview?.cwd === cwd && gitPreview.file === file;
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
      data-wide={wide}
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
        <button title={t("工作区检查点")} aria-label={t("工作区检查点")} disabled={!cwd} onClick={()=>setCheckpoints(true)}><Save size={14}/></button>
        {(job?.checkpoint||job?.handoff)&&<button title={t("任务成果交接")} aria-label={t("任务成果交接")} onClick={()=>setHandoffs(true)}><GitMerge size={14}/></button>}
        <button
          className="workbench-size"
          aria-label={wide ? t("收窄工作面板") : t("扩大工作面板")}
          title={wide ? t("收窄工作面板") : t("扩大工作面板")}
          aria-pressed={wide}
          onClick={() => setWide(!wide)}
        >
          {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button
          className="workbench-close"
          aria-label={t("关闭工作面板")}
          onClick={close}
        >
          <X size={16} />
        </button>
      </header>
      {checkpoints&&<WorkspaceCheckpoints call={call} initialCwd={cwd} initialJob={job} jobs={job?[job]:[]} close={()=>setCheckpoints(false)} open={onOpenConversation}/>}
      {handoffs&&<HandoffCenter call={call} initialJob={job} jobs={job?[job]:[]} close={()=>setHandoffs(false)} open={onOpenConversation}/>}
      {file ? (
        <FilePreview
          cwd={repositoryPreview ? gitPreview.root : cwd}
          file={file}
          call={call}
          close={() => setFile("")}
          jobId={repositoryPreview ? undefined : job?.id}
        />
      ) : tab === "files" ? (
        cwd ? (
          <div className="workbench-content">
            <div className="panel-section-label">
              {cwd.split(/[\\/]/).at(-1)}
            </div>
            <FileBrowser key={cwd} cwd={cwd} call={call} select={setFile} />
          </div>
        ) : (
          <PanelEmpty text={t("选择一个项目来浏览文件")} />
        )
      ) : tab === "changes" ? (
        <Changes
          key={cwd}
          cwd={cwd}
          call={call}
          openFile={(file, root) => {
            setGitPreview({ cwd, root, file });
            setFile(file);
          }}
          comment={setDraft}
        />
      ) : tab === "agents" ? (
        <Agents
          job={job}
          call={call}
          openFile={setFile}
          onOpenConversation={onOpenConversation}
        />
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
      {job?.handoff&&<section className="summary-card"><h3>{t("集成候选续接任务")}</h3><code>{job.handoff.commit}</code><p>{t("源交接记录")}: {job.handoff.id}</p><p>{t("在当前续接任务中管理交付验收。")}</p></section>}
      {job?.checkpoint&&<section className="summary-card"><h3>{t("检查点任务分支")}</h3><code>{job.checkpoint.branch}</code><p>{t("来源工作区")}: {job.checkpoint.sourceCwd}</p><small>SHA256 {job.checkpoint.manifestSha256}</small><p>{t("验收条件需要在当前分支重新验证。")}</p></section>}
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
      {job?.tokenUsage && <TokenUsageCard usage={job.tokenUsage} />}
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
      ) : data.kind === "encoded" ? (
        <PanelEmpty text={t("无法按 UTF-8 读取此文件，请在外部编辑器中打开以保留原始编码")} />
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
  openFile: (path: string, root: string) => void;
  comment: (text: string) => void;
}) {
  useI18n();

  const [state, setState] = useState<GitChanges>(),
    [selected, setSelected] = useState(""),
    [diff, setDiff] = useState(""),
    [diffSnapshot, setDiffSnapshot] = useState<{
      snapshot: GitChanges;
      revision: string;
      path: string;
      staged: boolean;
    }>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [staged, setStaged] = useState(false),
    [commit, setCommit] = useState(false),
    [message, setMessage] = useState(""),
    [branches, setBranches] = useState(false),
    [confirmRestore, setConfirmRestore] = useState(false),
    [fileFilter, setFileFilter] = useState("");
  const [reviewFilter, setReviewFilter] = useState("all");
  const [session, setSession] = useState<{root: string; value: ReviewSession}>({root: "", value: {marks: [], notes: {}}});
  const [verification, setVerification] = useState<{snapshot?: GitChanges; keys: Set<string>}>({keys: new Set()});
  const [fingerprint, setFingerprint] = useState<{diff: string; hash: string}>();
  const [reviewNotice, setReviewNotice] = useState("");
  const verifyingReviews = useRef(false);
  const [reviewChecking, setReviewChecking] = useState(false);
  const reviewRoot = state?.root || cwd;
  const currentSession = session.root === reviewRoot ? session.value : {marks: [], notes: {}};
  const verified = verification.snapshot === state ? verification.keys : new Set<string>();
  const changeSession = (change: (old: ReviewSession) => ReviewSession) => {
    setSession(old => {
      const value = change(old.root === reviewRoot ? old.value : {marks: [], notes: {}});
      try { localStorage.setItem(reviewStorageKey(reviewRoot), JSON.stringify(value)); }
      catch { setReviewNotice(t("审阅记录无法保存；本次会话仍可继续。")); }
      return {root: reviewRoot, value};
    });
  };
  useEffect(() => {
    let value: ReviewSession;
    try { value = readReviewSession(localStorage.getItem(reviewStorageKey(reviewRoot))); }
    catch { value = {marks: [], notes: {}}; }
    setSession({root: reviewRoot, value});
    setReviewNotice("");
  }, [reviewRoot]);
  useEffect(() => {
    let alive = true;
    setFingerprint(undefined);
    void diffFingerprint(diff).then(hash => { if (alive) setFingerprint({diff, hash}); }).catch(() => {});
    return () => { alive = false; };
  }, [diff]);
  // Git status revisions omit unstaged bytes. Re-read every marked side before
  // counting it as reviewed, including when the status revision is unchanged.
  useEffect(() => {
    if (!state || session.root !== reviewRoot) return;
    let alive = true;
    verifyingReviews.current = true;
    setReviewChecking(true);
    const marks = session.value.marks;
    void verifyReviewSession(session.value, state, (path, staged) => call("workspace.diff", {cwd, path, staged}), () => alive).then(({verified: keys, stale}) => {
      if (!alive) return;
      verifyingReviews.current = false;
      setReviewChecking(false);
      setVerification({snapshot: state, keys});
      if (stale.size) {
        setReviewNotice(t("更改已更新，相关审阅标记已失效。"));
        changeSession(old => ({...old, marks: old.marks.filter(mark => !stale.has(mark.key) || !marks.some(previous => previous.key === mark.key && previous.revision === mark.revision && previous.fingerprint === mark.fingerprint))}));
      }
    });
    return () => { alive = false; verifyingReviews.current = false; };
  }, [state, session.root, session.value.marks, reviewRoot, cwd]);
  const revision = useRef(0),
    mutating = useRef(false),
    refreshing = useRef(false);
  const refresh = async () => {
    if (!cwd || mutating.current || refreshing.current || verifyingReviews.current) return;
    refreshing.current = true;
    const request = ++revision.current;
    try {
      const result = await call("workspace.changes", { cwd });
      if (request === revision.current) setState(result);
    } catch (e) {
      if (request === revision.current) {
        setError(errorText(e)); setDiffSnapshot(undefined); setVerification({keys: new Set()});
      }
    } finally {
      refreshing.current = false;
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      clearInterval(timer);
      ++revision.current;
    };
  }, [cwd]);
  const entry = state?.files.find((file) => file.path === selected);
  const hasStaged = !!entry && gitStaged(entry),
    hasUnstaged = !!entry && gitUnstaged(entry);
  const showingStaged = hasStaged && (!hasUnstaged || staged);
  const filteredFiles = useMemo(() => {
    const query = fileFilter.toLocaleLowerCase();
    return state?.files.filter(file => file.path.toLocaleLowerCase().includes(query) &&
      (reviewFilter === "all" || (reviewFilter === "reviewed" ? fileReviewed(file, verified) : reviewFilter === "unreviewed" ? !fileReviewed(file, verified) : gitConflict(file)))) ?? [];
  }, [state?.files, fileFilter, reviewFilter, verification, state]);
  const diffReady = !!diffSnapshot &&
    diffSnapshot.snapshot === state &&
    diffSnapshot.revision === state?.revision &&
    diffSnapshot.path === selected && diffSnapshot.staged === showingStaged;
  useEffect(() => {
    setConfirmRestore(false);
  }, [state?.revision]);
  useEffect(() => {
    if (selected && state && !entry) {
      setSelected("");
      setDiff("");
      setDiffSnapshot(undefined);
      setConfirmRestore(false);
    }
  }, [selected, state, entry]);
  useEffect(() => {
    if (!entry) return;
    let alive = true;
    void call("workspace.diff", { cwd, path: selected, staged: showingStaged })
      .then((value) => {
        if (alive) {
          if (value !== diff) setConfirmRestore(false);
          setDiff(value);
          setDiffSnapshot({
            snapshot: state!,
            revision: state!.revision,
            path: selected,
            staged: showingStaged,
          });
        }
      })
      .catch((e) => {
        if (alive) {
          setDiff("");
          setDiffSnapshot(undefined);
          setError(errorText(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [cwd, selected, showingStaged, state]);
  const selectFile = (file: GitChanges["files"][number]) => {
    setSelected(file.path);
    setStaged(gitStaged(file) && (!gitUnstaged(file) || !verified.has(reviewKey(file.path, true))));
    setDiff(""); setDiffSnapshot(undefined); setError(""); setConfirmRestore(false);
  };
  const currentKey = reviewKey(selected, showingStaged);
  const marked = verified.has(currentKey);
  const textReviewable = !!entry && reviewableDiff(diff, entry);
  const currentNote = reviewNote(currentSession, selected);
  const reviewReady = textReviewable && diffReady && !!fingerprint && fingerprint.diff === diff && !!state?.revision && !busy && !gitConflict(entry || {path: "", index: " ", worktree: " "});
  const reviewedCount = state?.files.filter(file => fileReviewed(file, verified)).length || 0;
  const markReview = (advance = false) => {
    if (!reviewReady || !fingerprint || !state) return;
    changeSession(old => updateReviewMark(old, {key: currentKey, revision: state.revision, fingerprint: fingerprint.hash}, advance || !marked));
    const nextKeys = new Set(verified);
    if (advance || !marked) nextKeys.add(currentKey); else nextKeys.delete(currentKey);
    setVerification({snapshot: state, keys: nextKeys});
    if (advance && entry) {
      const otherSide = reviewSides(entry).find(side => !nextKeys.has(reviewKey(selected, side)));
      if (otherSide !== undefined) { setStaged(otherSide); setDiffSnapshot(undefined); }
      else { const next = nextReviewFile(state.files, selected, nextKeys, true); if (next) selectFile(next); }
    }
  };
  const navigationFiles = state?.files.filter(file => file.path.toLocaleLowerCase().includes(fileFilter.toLocaleLowerCase())) || [];
  const navigate = (direction: number, unreviewed = false) => {
    if (!state || busy) return;
    const files = navigationFiles;
    if (unreviewed) { const next = nextReviewFile(files, selected, verified, true); if (next) selectFile(next); return; }
    const index = files.findIndex(file => file.path === selected);
    const next = files[index + direction]; if (next) selectFile(next);
  };
  const exportReview = async () => {
    if (busy || mutating.current || refreshing.current || verifyingReviews.current || !state || verification.snapshot !== state) return;
    mutating.current = true;
    const request = ++revision.current;
    setBusy(true); setError("");
    try {
      const fresh: GitChanges = await call("workspace.changes", {cwd});
      if (fresh.error || fresh.root !== reviewRoot) throw Error(t("无法读取 Git 状态"));
      const result = await verifyReviewSession(currentSession, fresh, (path, staged) => call("workspace.diff", {cwd, path, staged}), () => request === revision.current);
      const after: GitChanges = await call("workspace.changes", {cwd});
      if (after.error || after.root !== fresh.root || after.branch !== fresh.branch || after.revision !== fresh.revision) throw Error(t("导出期间 Git 状态已变化，请重试。"));
      if (request !== revision.current) return;
      const content = reviewReport({state: fresh, session: currentSession, verified: result.verified, capturedAt: new Date().toISOString(), labels: {
        title: t("代码审阅报告"), scope: t("这是导出时重新读取差异得到的审阅记录；后续更改需重新审阅。标记不代表测试通过或批准合并。"),
        project: t("项目"), branch: t("分支"), revision: t("Git 状态指纹"), captured: t("记录时间"), summary: t("文件审阅进度"),
        staged: t("已暂存"), working: t("未暂存"), reviewed: t("已审阅"), pending: t("未验证"), notes: t("文件审阅笔记"),
      }});
      const url = URL.createObjectURL(new Blob([content], {type: "text/markdown;charset=utf-8"}));
      const link = document.createElement("a"); link.href = url; link.download = `codex-relay-review-${new Date().toISOString().slice(0, 10)}.md`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState(fresh); setVerification({snapshot: fresh, keys: result.verified});
      setReviewNotice(t("已导出审阅报告。"));
    } catch (e) { if (request === revision.current) setError(errorText(e)); }
    finally { mutating.current = false; if (request === revision.current) setBusy(false); }
  };
  const action = async (
    kind: string,
    branch?: { ref: string; expectedHead: string; name?: string },
    hunk?: number,
  ) => {
    if (mutating.current) return false;
    if (
      !branch && (!state?.revision ||
        (["stage", "unstage", "restore", "hunk"].includes(kind) && !diffReady))
    ) return false;
    mutating.current = true;
    const request = ++revision.current;
    setBusy(true);
    setError("");
    try {
      const result = branch
        ? await call("workspace.switchBranch", { cwd, ...branch })
        : hunk !== undefined
        ? await call("workspace.gitHunk", {
            cwd, path: selected, staged: showingStaged, hunk,
            expectedRevision: state!.revision, expectedDiff: diff,
          })
        : await call("workspace.git", {
            cwd,
            action: kind,
            path: selected || undefined,
            message: message || undefined,
            expectedRevision: state!.revision,
            ...(["stage", "unstage", "restore"].includes(kind) ? { expectedDiff: diff } : {}),
          });
      if (request !== revision.current) return false;
      setState(result);
      setDiff("");
      setDiffSnapshot(undefined);
      if (kind === "stage") setStaged(true);
      if (kind === "unstage") setStaged(false);
      if (kind === "hunk") setStaged(showingStaged);
      if (kind === "commit") {
        setCommit(false);
        setMessage("");
      }
      if (kind === "restore") {
        setConfirmRestore(false);
        setSelected("");
      }
      if (branch) {
        setSelected("");
        setConfirmRestore(false);
        setCommit(false);
      }
      return true;
    } catch (e) {
      if (request === revision.current) {
        setError(errorText(e));
        if (["stage", "unstage", "restore", "hunk"].includes(kind)) {
          setDiffSnapshot(undefined);
          setConfirmRestore(false);
        }
      }
      return false;
    } finally {
      mutating.current = false;
      if (request === revision.current) setBusy(false);
    }
  };
  if (!cwd) return <PanelEmpty text={t("选择项目以查看 Git 更改")} />;
  return (
    <div className="changes-pane" onKeyDown={event => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && ["ArrowUp", "ArrowDown"].includes(event.key) && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault(); navigate(event.key === "ArrowDown" ? 1 : -1);
      }
    }}>
      <div className="changes-heading">
        <GitBranch size={15} />
        <span>{state?.branch || "Git"}</span>
        <button
          title={t("切换或创建分支")}
          aria-expanded={branches}
          disabled={busy || !state || !!state.error}
          onClick={() => setBranches(!branches)}
        >
          <ChevronDown size={14} />
        </button>
        <button
          title={t("刷新变更")}
          disabled={busy}
          onClick={() => {
            setError("");
            void refresh();
          }}
        >
          <RefreshCw size={14} />
        </button>
        <button
          title={t("提交更改")}
          disabled={busy || !state || !!state.error}
          onClick={() => setCommit(!commit)}
        >
          <GitCommitHorizontal size={16} />
        </button>
      </div>
      {branches && (
        <GitBranchPicker
          cwd={cwd}
          call={call}
          busy={busy}
          close={() => setBranches(false)}
          change={(ref, expectedHead, name) =>
            action("branch", { ref, expectedHead, name })
          }
        />
      )}
      {error && (
        <p role="alert" className="panel-error">
          {error}
        </p>
      )}
      {state?.error ? (
        <div>
          <PanelEmpty text={t("无法读取 Git 状态")} />
          <p className="panel-error">{state.error}</p>
        </div>
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
                  disabled={
                    busy ||
                    !state?.revision ||
                    !message.trim() ||
                    !state?.files.some(gitStaged) ||
                    state.files.some(gitConflict)
                  }
                  onClick={() => void action("commit")}
                >
                  <Check size={14} />
                  {t("提交已暂存更改")}
                </button>
                <button disabled={busy || !state?.revision} onClick={() => void action("push")}>
                  <Upload size={14} />
                  {t("推送")}
                </button>
              </div>
            </div>
          )}
          {!!state?.files.length && <section className="review-session-summary" aria-label={t("文件审阅进度")}>
            <div><CheckCheck size={16}/><strong>{t("已审阅 {done} / {total} 个文件", {done: reviewedCount, total: state.files.length})}</strong></div>
            <progress value={reviewedCount} max={state.files.length} aria-label={t("文件审阅进度")}/>
            <small>{t("按当前差异记录；文件变化后需重新审阅。")}</small>
            <div className="review-session-filters" role="group" aria-label={t("审阅筛选")}>
              {[["all", "全部文件"], ["unreviewed", "待审阅"], ["reviewed", "已审阅"], ["conflicts", "合并冲突"]].map(([value, label]) => <button key={value} data-review-filter={value} aria-pressed={reviewFilter === value} onClick={() => setReviewFilter(value)}>{t(label)}</button>)}
            </div>
            <button className="review-export" data-review-export disabled={busy || reviewChecking || verification.snapshot !== state} onClick={() => void exportReview()}><Download size={13}/>{t("导出审阅报告")}</button>
            {reviewNotice && <p role="status">{reviewNotice}</p>}
          </section>}
          {!!state?.files.length && (
            <div className="review-file-filter">
              <Search size={13} aria-hidden="true" />
              <input
                type="search"
                aria-label={t("筛选更改文件")}
                placeholder={t("筛选更改文件")}
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
              />
              <span>{filteredFiles.length} / {state.files.length}</span>
            </div>
          )}
          <div className="changed-files">
            {filteredFiles.map((f) => (
              <button
                key={f.path}
                className={selected === f.path ? "selected" : ""}
                disabled={busy}
                title={f.original ? `${f.original} → ${f.path}` : f.path}
                onClick={() => {
                  if (selected === f.path) {
                    setError("");
                    setConfirmRestore(false);
                    void refresh();
                    return;
                  }
                  selectFile(f);
                }}
              >
                {fileReviewed(f, verified) ? <CheckCheck size={14} className="review-file-done" aria-label={t("已审阅")}/> : <FileCode2 size={14} />}
                <span>{f.path}</span>
                {gitConflict(f) ? (
                  <small title={t("合并冲突")}>!</small>
                ) : (
                  <>
                    {gitStaged(f) && (
                      <small title={t("已暂存")}>{f.index}</small>
                    )}
                    {gitUnstaged(f) && (
                      <small title={t("未暂存")}>
                        {f.worktree === "?" ? "?" : f.worktree}
                      </small>
                    )}
                  </>
                )}
              </button>
            ))}
            {state && !state.files.length && (
              <PanelEmpty text={t("工作区没有未提交的更改")} />
            )}
            {!!state?.files.length && !filteredFiles.length && (
              <p className="diff-note" role="status">{t("没有匹配的更改文件")}</p>
            )}
          </div>
          {entry && (
            <>
              <div className="review-file-navigation" aria-label={t("文件审阅导航")}>
                <button data-review-nav="previous" title={t("上一个文件（Alt+↑）")} aria-label={t("上一个文件（Alt+↑）")} disabled={busy || navigationFiles.findIndex(file => file.path === selected) <= 0} onClick={() => navigate(-1)}><ArrowLeft size={14}/></button>
                <span title={selected}>{selected}</span>
                <button data-review-nav="next" title={t("下一个文件（Alt+↓）")} aria-label={t("下一个文件（Alt+↓）")} disabled={busy || navigationFiles.findIndex(file => file.path === selected) >= navigationFiles.length - 1} onClick={() => navigate(1)}><ArrowRight size={14}/></button>
                <button data-review-nav="unreviewed" disabled={busy || !nextReviewFile(navigationFiles, selected, verified, true)} onClick={() => navigate(1, true)}>{t("下一待审阅")}</button>
              </div>
              <div className="diff-toolbar">
                <button
                  title={t("打开文件")}
                  disabled={
                    busy ||
                    (entry.index === "D" && entry.worktree === " ") ||
                    entry.worktree === "D"
                  }
                  onClick={() => openFile(selected, state!.root)}
                >
                  {selected.split("/").at(-1)}
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={showingStaged}
                    disabled={busy || !hasStaged || !hasUnstaged}
                    onChange={(e) => {
                      setStaged(e.target.checked);
                      setDiff("");
                      setConfirmRestore(false);
                    }}
                  />
                  {t("已暂存")}
                </label>
                <button
                  title={showingStaged ? t("取消暂存文件") : t("暂存文件")}
                  disabled={busy || !diffReady || !(showingStaged ? hasStaged : hasUnstaged)}
                  onClick={() =>
                    void action(showingStaged ? "unstage" : "stage")
                  }
                >
                  {showingStaged ? <Minus size={14} /> : <Plus size={14} />}
                </button>
                <button
                  title={t("还原文件")}
                  disabled={
                    busy ||
                    !diffReady ||
                    showingStaged ||
                    !hasUnstaged ||
                    entry.index === "?" ||
                    gitConflict(entry)
                  }
                  onClick={() => setConfirmRestore(true)}
                >
                  <RotateCcw size={14} />
                </button>
              </div>
              {confirmRestore && (
                <div className="restore-confirm">
                  <p>{t("将丢弃此文件尚未暂存的更改。")}</p>
                  <button
                    disabled={busy || !diffReady}
                    onClick={() => void action("restore")}
                  >
                    {t("确认还原此文件")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setConfirmRestore(false)}
                  >
                    {t("取消")}
                  </button>
                </div>
              )}
              <div className="review-completion-actions">
                <button data-review-mark="toggle" aria-pressed={marked} disabled={!reviewReady} onClick={() => markReview()}><Check size={14}/>{t(marked ? "已审阅此差异" : "标记已审阅")}</button>
                <button data-review-mark="advance" disabled={!reviewReady} onClick={() => markReview(true)}>{t("审阅并继续")}<ArrowRight size={14}/></button>
              </div>
              {diffReady && !textReviewable && <p className="diff-note">{t("此文件没有可验证的文本差异，请在原应用中检查。")}</p>}
              <details className="review-note-draft">
                <summary>{t("文件审阅笔记")}{currentNote ? " •" : ""}</summary>
                <textarea aria-label={t("文件审阅笔记")} placeholder={t("记录问题、风险或验证建议…")} maxLength={4000} value={currentNote || ""} onChange={event => { const value = event.target.value; changeSession(old => ({...old, notes: Object.fromEntries(Object.entries({...old.notes, [selected]: value}).slice(-500))})); }}/>
                <button disabled={!currentNote?.trim()} onClick={() => comment(`${t("文件审阅笔记")} · ${selected}\n${currentNote}`)}>{t("将笔记加入聊天草稿")}</button>
                <small>{t("笔记保存在本机，不会自动发送。")}</small>
              </details>
              <DiffReview
                key={`${selected}:${showingStaged}`}
                diff={diff}
                path={selected}
                staged={showingStaged}
                ready={diffReady}
                busy={busy}
                conflict={gitConflict(entry)}
                comment={comment}
                stageHunk={(index) => void action("hunk", undefined, index)}
              />
            </>
          )}
          {!selected && !!state?.files.length && (
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
  onOpenConversation,
}: {
  job?: Job;
  call: Call;
  openFile: (path: string) => void;
  onOpenConversation?: (job: Job) => void;
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
  const ownerJob = useRef(job?.id);
  ownerJob.current = job?.id;
  useEffect(
    () => () => {
      currentSelection.current = "";
    },
    [],
  );
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
  const openConversation = () => {
    if (!job || !selected || controlLock.current) return;
    const id = job.id,
      threadId = selected.threadId;
    controlLock.current = true;
    setControlling(true);
    setError("");
    void call("chat.agent.open", { id, threadId })
      .then((child: Job) => {
        if (ownerJob.current === id && currentSelection.current === threadId)
          onOpenConversation?.(child);
      })
      .catch((error) => {
        if (ownerJob.current === id && currentSelection.current === threadId)
          setError(errorText(error));
      })
      .finally(() => {
        controlLock.current = false;
        setControlling(false);
      });
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
                {onOpenConversation && (
                  <button
                    title={t("打开子代理聊天")}
                    aria-label={t("打开子代理聊天")}
                    disabled={
                      controlling ||
                      (!selected.conversationId &&
                        ![
                          "completed",
                          "paused",
                          "cancelled",
                          "needs_attention",
                        ].includes(job.state)) ||
                      !!job.recoveryRequired
                    }
                    onClick={openConversation}
                  >
                    {controlling ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <MessageSquare size={14} />
                    )}
                  </button>
                )}
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
              {selected.prompt &&
                !chat?.items.some(
                  (item) =>
                    item.role === "user" && item.text === selected.prompt,
                ) && (
                  <div className="child-prompt">
                    <span>{t("任务")}</span>
                    <UserText text={selected.prompt} />
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
                      : t("打开子代理聊天可独立继续任务")
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
