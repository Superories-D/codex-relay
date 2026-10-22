import { t, useI18n, setLanguage, errorText } from "./i18n";
import { CopyButton } from "./CopyButton";
import { RecoveryNotice, RecoveryHistory } from "./RecoveryNotice";
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
} from "react";
import type {
  Approval,
  ChatAttachment,
  ChatItem,
  ChatPage,
  HistoryEntry,
  Job,
  Snapshot,
} from "../shared/types";
import { capabilities } from "../shared/capabilities";
import { GOAL_OBJECTIVE_MAX_LENGTH } from "../shared/goal";
import { Dialog } from "./Dialog";
import { ModelPicker } from "./ModelPicker";
import { PermissionPicker } from "./PermissionPicker";
import { ImageThumbnail } from "./ChatImages";
import { ActivityTimeline } from "./ActivityTimeline";
import { importPastedFiles } from "./paste-files";
import { MotionRegion, ModalPresence } from "./MotionRegion";
import { mergePage } from "./chat-view";
import { followChat } from "./chat-scroll";
import { TerminalPane } from "./TerminalPane";
import { Workbench, type WorkbenchTab } from "./Workbench";
import { ExtensionsPage, SchedulesPage } from "./FeaturePages";
import { SettingsPage } from "./SettingsPage";
import { TurnHistory } from "./TurnHistory";
import { ImportAllControl } from "./ImportAllControl";
import { pruneQuestionDrafts } from "./QuestionPanel";
import type { DesktopData } from "../core/desktop";
import {
  Archive,
  ArrowLeft,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  Blocks,
  BookOpen,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleHelp,
  Clipboard,
  Command,
  Download,
  Ellipsis,
  ExternalLink,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  Home,
  ListTodo,
  LoaderCircle,
  Menu,
  MessageSquare,
  MessageCircleQuestion,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePen,
  SquareTerminal,
  Target,
  Undo2,
  X,
} from "lucide-react";
import "./agent.css";
import "./desktop.css";

const names: Record<string, string> = {
  queued: "排队中",
  preparing: "连接中",
  running: "正在工作",
  pausing: "正在停止",
  rotating: "自动切换账户",
  waiting: "等待可用额度",
  paused: "已暂停",
  watching: "监控中",
  needs_attention: "需要处理",
  completed: "本轮完成",
  cancelled: "已取消",
};
const running = (j?: Job) =>
  !!j &&
  (!!j.autoRecovery ||
    [
      "queued",
      "preparing",
      "running",
      "pausing",
      "rotating",
      "waiting",
      "watching",
    ].includes(j.state));
const jobLabel = (j: Job) =>
  j.autoRecovery
    ? "正在自动恢复"
    : j.state === "waiting" && j.waitingFor === "model"
      ? "等待模型账户"
      : names[j.state];
const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) || p;
function fitComposer(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  input.style.height = `${Math.min(200, Math.max(40, input.scrollHeight))}px`;
}
export function AgentApp({
  management,
  approval,
}: {
  management: (tab: string) => React.ReactNode;
  approval: (a: Approval, respond: (v: unknown) => void) => React.ReactNode;
}) {
  useI18n();

  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [turnHistory, setTurnHistory] = useState(false);
  const [visibleProjects, setVisibleProjects] = useState(30),
    [visibleThreads, setVisibleThreads] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | undefined>(
    () => localStorage.getItem("relay.lastChat") || undefined,
  );
  const [manage, setManage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [inspector, setInspector] = useState(
    () => localStorage.getItem("relay.inspector") !== "false",
  );
  const [workspaceTab, setWorkspaceTab] = useState<WorkbenchTab>("summary");
  const [previewFile, setPreviewFile] = useState("");
  const [desktop, setDesktop] = useState<DesktopData>({
    projects: [],
    schedules: [],
    preferences: { theme: "dark", notifications: true },
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [screen, setScreen] = useState("chat");
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [composerMenu, setComposerMenu] = useState(false);
  const [threadMenu, setThreadMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const [goalBudget, setGoalBudget] = useState("");
  const [multiAgent, setMultiAgent] = useState(true);
  const [environment, setEnvironment] = useState("local");
  const [branch, setBranch] = useState("HEAD");
  const [branchList, setBranchList] = useState<string[]>([]);
  const [history, setHistory] = useState(false);
  const [operations, setOperations] = useState(false);
  const [operationMethod, setOperationMethod] = useState(
    "thread/compact/start",
  );
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("relay.drafts") || "{}");
    } catch {
      return {};
    }
  });
  const [files, setFiles] = useState<Record<string, ChatAttachment[]>>({});
  const [pasting, setPasting] = useState<Record<string, number>>({});
  const pasteLocks = useRef(new Map<string, number>());
  const [cwd, setCwd] = useState(
    () => localStorage.getItem("relay.project") || "",
  );
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [sandbox, setSandbox] = useState<Job["sandbox"]>("workspaceWrite");
  const [modelPicker, setModelPicker] = useState(false);
  const [page, setPage] = useState<ChatPage>({ items: [], total: 0 });
  const [older, setOlder] = useState<ChatItem[]>([]);
  const [olderBefore, setOlderBefore] = useState<number>();
  const transcript = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollControl = useRef<ReturnType<typeof followChat> | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const lastScroll = useRef<{ id?: string; top: number } | undefined>(
    undefined,
  );
  const viewCache = useRef(
    new Map<
      string,
      {
        page: ChatPage;
        older: ChatItem[];
        before?: number;
        top: number;
        follow: boolean;
      }
    >(),
  );
  const following = useRef(true);
  const selectedRef = useRef(selected);
  const selectAction = useRef(() => {});
  const preferencesRef = useRef(desktop.preferences);
  preferencesRef.current = desktop.preferences;
  const initialSelection = useRef(false);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const focusAfterHistory = useRef(false);
  const modelDirty = useRef(false);
  selectedRef.current = selected;
  const job = snapshot?.jobs.find((j) => j.id === selected);
  const activeTaskCount =
    snapshot?.jobs.filter((j) =>
      ["preparing", "running", "pausing"].includes(j.state),
    ).length || 0;
  const familyOwner =
    job &&
    snapshot?.jobs.find(
      (other) =>
        other.id !== job.id &&
        (other.runtimeHomeId || other.id) === (job.runtimeHomeId || job.id) &&
        ["preparing", "running", "pausing", "rotating"].includes(other.state),
    );
  const inputRequests = (snapshot?.approvals || []).filter(
    (a) => a.kind === "input",
  );
  const chatQuestions = inputRequests.filter((a) => a.jobId === selected);
  const questionsSignature = inputRequests
    .map((a) => `${a.jobId}:${a.historyId}:${a.responsePending}`)
    .join("|");
  const seenQuestions = useRef(new Set<string>());
  useEffect(() => {
    pruneQuestionDrafts(undefined, inputRequests);
    const fresh = chatQuestions.filter(
      (a) => !seenQuestions.current.has(`${a.jobId}:${a.historyId || a.id}`),
    );
    for (const a of fresh)
      seenQuestions.current.add(`${a.jobId}:${a.historyId || a.id}`);
    while (seenQuestions.current.size > 200)
      seenQuestions.current.delete(
        seenQuestions.current.values().next().value!,
      );
    if (fresh.some((a) => (a.params as any)?.isBlocking !== false)) {
      setWorkspaceTab("questions");
      setInspector(true);
      setPreviewFile("");
    }
  }, [selected, questionsSignature]);
  const key = selected ?? "new";
  const draft = drafts[key] ?? "",
    attachments = files[key] ?? [];
  const call = async (name: string, args?: unknown): Promise<any> => {
    try {
      return await window.relay.command(name, args);
    } catch (e) {
      // Git controls retain actionable errors beside the affected draft/diff.
      if (![
        "workspace.branchList", "workspace.switchBranch", "workspace.changes",
        "workspace.diff", "workspace.git", "workspace.gitHunk",
      ].includes(name))
        setError(errorText(e));
      throw e;
    }
  };
  const action = (fn: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError("");
    void fn()
      .catch((e) => setError(errorText(e)))
      .finally(() => setPending(false));
  };
  const addPastedFiles = (
    target: string,
    operation: () => Promise<ChatAttachment[]>,
  ) => {
    pasteLocks.current.set(target, (pasteLocks.current.get(target) || 0) + 1);
    setPasting(Object.fromEntries(pasteLocks.current));
    void operation()
      .then((added) => {
        setFiles((previous) => ({
          ...previous,
          [target]: [...(previous[target] || []), ...added].slice(0, 20),
        }));
      })
      .catch((e) => setError(t(String(e).replace(/^Error: /, ""))))
      .finally(() => {
        const remaining = (pasteLocks.current.get(target) || 1) - 1;
        if (remaining) pasteLocks.current.set(target, remaining);
        else pasteLocks.current.delete(target);
        setPasting(Object.fromEntries(pasteLocks.current));
      });
  };
  const refreshDesktop = () => {
    void window.relay
      .command("desktop.read")
      .then((value) => setDesktop(value as DesktopData))
      .catch((e) => setError(String(e)));
  };
  const openFile = (path: string) => {
    setWorkspaceTab("files");
    setPreviewFile(path);
    setInspector(true);
  };
  useEffect(() => {
    refreshDesktop();
  }, []);
  useEffect(() => {
    setLanguage(desktop.preferences?.language || "auto");
  }, [desktop.preferences?.language]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      const values = Object.entries(drafts)
        .filter(([, text]) => text.trim())
        .slice(-20);
      try {
        localStorage.setItem(
          "relay.drafts",
          JSON.stringify(Object.fromEntries(values)),
        );
      } catch {}
    }, 300);
    return () => clearTimeout(timer);
  }, [drafts]);
  useLayoutEffect(() => {
    if (messageInput.current) fitComposer(messageInput.current);
  }, [draft, key, screen, manage, desktop.preferences?.uiFont]);
  useEffect(() => {
    const input = messageInput.current;
    if (!input) return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      fitComposer(input);
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [screen, manage]);
  useEffect(() => {
    if (modelDirty.current || !job) return;
    setModel(job.model);
    setEffort(job.effort || "");
  }, [job?.model, job?.effort]);
  useEffect(() => {
    localStorage.setItem("relay.inspector", String(inspector));
  }, [inspector]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (document.querySelector("dialog:modal")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        selectAction.current();
      }
      if (mod && e.key === "b") {
        e.preventDefault();
        setSidebarHidden((v) => !v);
      }
      if (mod && e.key === "j") {
        e.preventDefault();
        setTerminal((v) => !v);
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        setManage("settings");
      }
      if (e.key === "Escape") {
        setPalette(false);
        setComposerMenu(false);
        setThreadMenu(false);
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, []);
  useEffect(() => {
    let alive = true;
    void window.relay
      .snapshot()
      .then((s) => {
        if (alive) setSnapshot(s);
      })
      .catch((e) => setError(String(e)));
    const off = window.relay.onSnapshot((s) => {
      if (alive) setSnapshot(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  useEffect(() => {
    const cached = selected ? viewCache.current.get(selected) : undefined;
    setPage(cached?.page || { items: [], total: 0 });
    setOlder(cached?.older || []);
    setOlderBefore(cached?.before);
    following.current = cached?.follow ?? true;
    void window.relay.command("chat.watch", { id: selected }).catch(() => {});
    if (!selected) return;
    let alive = true,
      loading = false;
    const read = async () => {
      if (loading) return;
      loading = true;
      try {
        const value = (await window.relay.command("chat.read", {
          id: selected,
        })) as ChatPage;
        if (alive) setPage((previous) => mergePage(previous, value));
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        loading = false;
      }
    };
    void read();
    const offChat = window.relay.onChat?.((update) => {
      if (alive && update.id === selected)
        setPage((previous) => mergePage(previous, update.page));
    });
    const timer = setInterval(read, window.relay.onChat ? 8000 : 1200);
    return () => {
      alive = false;
      clearInterval(timer);
      offChat?.();
    };
  }, [selected]);
  useEffect(() => {
    if (!scroll.current || !transcript.current) return;
    const viewport = scroll.current;
    const position =
      lastScroll.current?.id === selected
        ? lastScroll.current
        : selected
          ? viewCache.current.get(selected)
          : undefined;
    const control = followChat(
      viewport,
      transcript.current,
      following,
      (away) => {
        lastScroll.current = { id: selected, top: viewport.scrollTop };
        setAwayFromLatest(away);
      },
      !following.current ? position?.top : undefined,
    );
    scrollControl.current = control;
    return () => {
      control.destroy();
      scrollControl.current = null;
    };
  }, [selected, screen, manage]);
  const select = (j?: Job) => {
    setManage("");
    if (selected) {
      viewCache.current.set(selected, {
        page,
        older,
        before: olderBefore,
        top: scroll.current?.scrollTop || 0,
        follow: following.current,
      });
      while (viewCache.current.size > 5)
        viewCache.current.delete(viewCache.current.keys().next().value!);
    }
    setScreen("chat");
    setPreviewFile("");
    setThreadMenu(false);
    setSelected(j?.id);
    if (j) localStorage.setItem("relay.lastChat", j.id);
    else localStorage.removeItem("relay.lastChat");
    modelDirty.current = false;
    setError("");
    if (j) {
      setModel(j.model);
      setEffort(j.effort || "");
      setSandbox(j.sandbox);
      setPlanMode(!!j.planMode);
      setMultiAgent(j.multiAgent !== false);
    }
  };
  selectAction.current = () => select();
  useEffect(() => {
    if (!snapshot || initialSelection.current) return;
    initialSelection.current = true;
    const saved = snapshot.jobs.find((j) => j.id === selected);
    if (saved) {
      select(saved);
      setArchived(!!saved.archived);
    } else if (selected) setSelected(undefined);
  }, [snapshot]);
  const chooseProject = async () => {
    const dir = await call("choose.directory");
    if (dir) {
      setCwd(dir);
      localStorage.setItem("relay.project", dir);
      await call("project.add", dir);
      refreshDesktop();
      if (job) await call("chat.update", { id: job.id, cwd: dir });
    }
  };
  const newProject = async () => {
    const dir = await call("choose.directory");
    if (dir) {
      await call("project.add", dir);
      setCwd(dir);
      localStorage.setItem("relay.project", dir);
      select();
      refreshDesktop();
    }
  };
  const send = async (
    mode: "send" | "queue" | "steer" = "send",
    review = false,
    saveGoalOnly = false,
  ) => {
    if (pasteLocks.current.has(key)) return;
    if (!draft.trim() && !review) return;
    const slash = draft.trim().match(/^\/([a-z]+)(?:\s+(.*))?$/s);
    if (slash && !review) {
      const command = slash[1],
        argument = slash[2] ?? "";
      if (command === "review") review = true;
      else {
        if (command === "new" || command === "clear") select();
        else if (command === "model") {
          if (argument) setModel(argument);
          else setModelPicker(true);
        } else if (["status", "permissions"].includes(command))
          setInspector(true);
        else if (command === "logout") setManage("accounts");
        else if (["skills", "mcp", "plugins"].includes(command))
          setScreen(command);
        else if (command === "plan") setPlanMode(!planMode);
        else if (command === "agents") {
          setWorkspaceTab("agents");
          setInspector(true);
        } else if (command === "goal") {
          if (job) {
            setWorkspaceTab("summary");
            setInspector(true);
          } else setGoalMode(true);
          setDrafts((d) => ({ ...d, [key]: argument }));
          return;
        } else if (command === "terminal") setTerminal(true);
        else if (command === "resume" && job)
          await call("job.control", { id: job.id, action: "resume" });
        else if (command === "fork" && job)
          select(await call("chat.fork", job.id));
        else if (command === "archive" && job)
          await call("chat.update", { id: job.id, archived: true });
        else if (
          ["help", "compact", "skills", "mcp", "config"].includes(command) &&
          job
        ) {
          setOperationMethod(
            (
              {
                help: "model/list",
                compact: "thread/compact/start",
                skills: "skills/list",
                mcp: "mcpServerStatus/list",
                config: "config/read",
              } as Record<string, string>
            )[command],
          );
          setOperations(true);
        } else
          throw new Error(
            t(
              "可用命令：/new /model 模型名 /status /permissions /review /resume /fork /archive /compact /skills /mcp /config /help。会话操作需先选择已有聊天。",
            ),
          );
        setDrafts((d) => ({ ...d, [key]: "" }));
        return;
      }
    }
    const text = review ? t("审查当前项目中尚未提交的修改") : draft;
    const creatingGoal = !job && goalMode && !review;
    const tokenBudget = goalBudget.trim() ? Number(goalBudget) : null;
    if (creatingGoal) {
      if (text.trim().length > GOAL_OBJECTIVE_MAX_LENGTH)
        throw new Error(t("目标最多支持 4000 个字符"));
      if (
        tokenBudget !== null &&
        (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
      )
        throw new Error(t("请输入正整数预算，留空表示不限制"));
      if (attachments.length)
        throw new Error(t("请先创建持续目标，再在聊天中补充文件或发起审查"));
    }
    if (!job) {
      let dir = cwd;
      if (!dir) {
        dir = await call("choose.directory");
        if (!dir) return;
        setCwd(dir);
        localStorage.setItem("relay.project", dir);
      }
      await call("project.add", dir);
      refreshDesktop();
      if (environment === "worktree") {
        const created = await call("workspace.worktree", {
          cwd: dir,
          ref: branch,
        });
        dir = created.cwd;
        refreshDesktop();
      }
      const added = (await call(creatingGoal ? "chat.goal.create" : "job.add", {
        title: text.replace(/\s+/g, " ").slice(0, 80),
        prompt: text,
        cwd: dir,
        mode: "cli",
        model,
        effort,
        bucket: "codex",
        approvalPolicy: "on-request",
        sandbox,
        interactive: true,
        attachments,
        review,
        planMode,
        multiAgent,
        ...(creatingGoal ? { tokenBudget, start: !saveGoalOnly } : {}),
      })) as Job;
      setSelected(added.id);
      localStorage.setItem("relay.lastChat", added.id);
      setGoalMode(false);
    } else {
      if (sandbox !== job.sandbox && !running(job))
        await call("chat.update", { id: job.id, sandbox });
      await call("chat.send", {
        id: job.id,
        text,
        attachments,
        action: familyOwner && mode === "send" ? "queue" : mode,
        model,
        effort,
        review,
        planMode,
        multiAgent,
      });
    }
    setDrafts((d) => ({ ...d, [key]: "" }));
    setFiles((f) => ({ ...f, [key]: [] }));
    following.current = true;
  };
  const jobs = useMemo(() => {
    const projectMatches = new Set(
      (desktop.projects ?? [])
        .filter((project) =>
          `${project.name} ${project.cwd}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .map((project) => project.cwd),
    );
    return (snapshot?.jobs ?? []).filter(
      (j) =>
        !!j.archived === archived &&
        (projectMatches.has(j.projectCwd || j.cwd) ||
          `${j.title} ${j.cwd}`.toLowerCase().includes(search.toLowerCase())),
    );
  }, [snapshot?.jobs, desktop.projects, archived, search]);
  const groups = useMemo(() => {
    const groups = new Map<string, Job[]>();
    for (const project of desktop.projects ?? [])
      if (
        !search ||
        `${project.name} ${project.cwd}`
          .toLowerCase()
          .includes(search.toLowerCase())
      )
        groups.set(project.cwd, []);
    for (const j of [...jobs].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const key = j.projectCwd || j.cwd;
      const group = groups.get(key);
      if (group) group.push(j);
      else groups.set(key, [j]);
    }
    return groups;
  }, [desktop.projects, jobs, search]);
  const visibleGroups = useMemo(() => {
    const entries = [...groups].slice(0, visibleProjects);
    const key = job?.projectCwd || job?.cwd;
    if (key && groups.has(key) && !entries.some(([cwd]) => cwd === key))
      entries.push([key, groups.get(key)!]);
    return entries;
  }, [groups, visibleProjects, job?.cwd, job?.projectCwd]);
  if (manage.startsWith("advanced:"))
    return (
      <div className="legacy-window">
        <div className="desktop-titlebar">
          <span>{t("Codex Relay · 高级管理")}</span>
        </div>
        <button className="agent-return" onClick={() => setManage("")}>
          {t("← 返回对话")}
        </button>
        {management(manage.slice(9))}
      </div>
    );
  const ready =
    snapshot?.accounts.filter((a) => a.enabled && a.status === "ready")
      .length ?? 0;
  const allItems = [
    ...new Map(
      [...older, ...page.items].map((item) => [item.id, item]),
    ).values(),
  ];
  const nextBefore = older.length ? olderBefore : page.before;
  const account = snapshot?.accounts.find((a) => a.id === job?.accountId);
  const currentCwd = job?.cwd || cwd;
  const chrome = (
    <div className="desktop-titlebar">
      <div className="desktop-history">
        <button
          title={t("返回新聊天")}
          aria-label={t("返回新聊天")}
          onClick={() => select()}
        >
          <ArrowLeft size={17} />
        </button>
        <button
          title={t("回到最近会话")}
          onClick={() => {
            const last = snapshot?.jobs[0];
            if (last) select(last);
          }}
        >
          <ArrowRight size={17} />
        </button>
        <button
          title={sidebarHidden ? t("展开侧栏") : t("收起侧栏")}
          aria-label={t("切换侧栏")}
          onClick={() => setSidebarHidden(!sidebarHidden)}
        >
          {sidebarHidden ? (
            <PanelLeftOpen size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
        </button>
      </div>
      <div className="desktop-menu">
        <button onClick={() => void call("window.menu", { menu: "file" })}>
          {t("文件")}
        </button>
        <button onClick={() => void call("window.menu", { menu: "edit" })}>
          {t("编辑")}
        </button>
        <button onClick={() => void call("window.menu", { menu: "view" })}>
          {t("视图")}
        </button>
        <button
          onClick={() =>
            void call("link.open", "https://learn.chatgpt.com/docs/app")
          }
        >
          {t("帮助")}
        </button>
      </div>
      <span className="desktop-window-title">Codex Relay</span>
    </div>
  );
  return (
    <div
      className={`desktop-shell ${sidebarHidden ? "sidebar-hidden" : ""} ${desktop.preferences?.reduceMotion ? "reduce-motion" : ""}`}
      data-theme={desktop.preferences?.theme || "dark"}
      data-color-scheme={
        desktop.preferences?.theme === "light" ||
        (desktop.preferences?.theme === "system" && !systemDark)
          ? "light"
          : "dark"
      }
      style={
        {
          "--chat-size": `${desktop.preferences?.textSize || 15}px`,
          "--code-size": `${desktop.preferences?.codeSize || 12}px`,
          "--desktop-accent": desktop.preferences?.accent || "#4386f5",
          fontFamily: desktop.preferences?.uiFont || undefined,
          "--code-font":
            desktop.preferences?.codeFont ||
            '"Cascadia Code", Consolas, monospace',
        } as React.CSSProperties
      }
    >
      {chrome}
      <div className="agent-shell">
        <nav className="agent-rail" aria-label={t("主导航")}>
          <button
            className={`agent-logo ${screen === "chat" ? "active" : ""}`}
            title={t("对话")}
            onClick={() => select()}
          >
            <Home size={23} strokeWidth={1.7} />
          </button>
          <button
            title={t("导入历史对话")}
            aria-label={t("导入历史对话")}
            onClick={() => setHistory(true)}
          >
            <Download size={21} />
          </button>
          <button
            title={t("账户轮换")}
            aria-label={t("账户轮换")}
            onClick={() => setManage("accounts")}
          >
            <Network size={21} />
          </button>
          <button
            className="task-queue-button"
            title={
              activeTaskCount
                ? t("{count} 个任务正在运行", { count: activeTaskCount })
                : t("任务队列")
            }
            aria-label={t("任务队列")}
            onClick={() => setManage("advanced:tasks")}
          >
            <ListTodo size={21} />
            {activeTaskCount > 0 && (
              <span className="task-count" aria-hidden="true">
                {activeTaskCount}
              </span>
            )}
          </button>
          <button
            aria-label={t("定时任务")}
            title={t("定时任务")}
            className={screen === "schedules" ? "active" : ""}
            onClick={() => {
              setManage("");
              setScreen("schedules");
              refreshDesktop();
            }}
          >
            <CalendarClock size={21} />
          </button>
          <button
            aria-label={t("插件与 Skills")}
            title={t("插件与 Skills")}
            className={screen === "plugins" ? "active" : ""}
            onClick={() => {
              setManage("");
              setScreen("plugins");
            }}
          >
            <Blocks size={21} />
          </button>
          <div className="agent-rail-spacer" />
          <button
            title={t("设置")}
            aria-label={t("设置")}
            onClick={() => setManage("settings")}
          >
            <Settings size={21} />
          </button>
          <span
            className={`agent-dot ${ready ? "online" : ""}`}
            title={t("{p0} 个可用账户", { p0: ready })}
          />
        </nav>
        <aside className="agent-sidebar">
          <div className="agent-brand">
            <button
              className="desktop-product"
              title="Codex Relay"
              onClick={() => setThreadMenu(!threadMenu)}
            >
              Codex <span className="product-edition">Relay</span>
            </button>
            <div>
              <button
                title={t("运行与通知")}
                aria-label={t("运行与通知")}
                onClick={() => setManage("notifications")}
              >
                <Bell size={17} />
              </button>
              <button
                title={t("搜索会话 · Ctrl+K")}
                aria-label={t("搜索全部会话")}
                onClick={() => setPalette(true)}
              >
                <Search size={18} />
              </button>
            </div>
          </div>
          <button className="agent-new" onClick={() => select()}>
            <SquarePen size={17} /> {t("新聊天")}
            <Plus size={14} className="new-chat-plus" />
          </button>
          <input
            className="agent-search"
            aria-label={t("搜索会话")}
            placeholder={t("搜索会话或项目…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="agent-section-label">
            <span>{archived ? t("归档") : t("项目")}</span>
            <button
              title={t("新建项目会话")}
              onClick={() => {
                action(newProject);
              }}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="agent-projects">
            {jobs.some((j) => j.pinned) && (
              <section className="pinned-chats">
                <div className="agent-section-label">{t("置顶")}</div>
                {jobs
                  .filter((j) => j.pinned)
                  .map((j) => (
                    <button
                      className={`agent-thread ${j.id === selected ? "selected" : ""}`}
                      key={j.id}
                      onClick={() => select(j)}
                    >
                      <Pin size={13} />
                      <span>{j.title}</span>
                    </button>
                  ))}
              </section>
            )}
            {visibleGroups.map(([dir, all]) => {
              const background = all.filter((j) =>
                ["subagent", "review"].includes(j.historySource?.source || ""),
              );
              const group = all.filter((j) => !background.includes(j));
              return (
                <details
                  key={dir}
                  open
                  className={`agent-project ${dir === (job?.projectCwd || job?.cwd || cwd) ? "current-project" : ""}`}
                >
                  <summary title={dir}>
                    <ChevronRight size={12} className="project-chevron" />
                    <Folder size={16} />
                    <span className="project-name">
                      {desktop.projects?.find((p) => p.cwd === dir)?.name ||
                        basename(dir) ||
                        t("未关联项目")}
                    </span>
                    <small className="project-count">
                      {group.length || ""}
                    </small>
                    <button
                      className="project-new-chat"
                      title={t("在此项目新建聊天")}
                      onClick={(e) => {
                        e.preventDefault();
                        setCwd(dir);
                        select();
                      }}
                    >
                      <Plus size={14} />
                    </button>
                  </summary>
                  {group
                    .slice(0, visibleThreads[dir] || 20)
                    .concat(
                      group.find((j) => j.id === selected) &&
                        !group
                          .slice(0, visibleThreads[dir] || 20)
                          .some((j) => j.id === selected)
                        ? [group.find((j) => j.id === selected)!]
                        : [],
                    )
                    .map((j) => (
                      <button
                        key={j.id}
                        className={`agent-thread ${j.id === selected ? "selected" : ""}`}
                        onClick={() => select(j)}
                        title={j.title}
                      >
                        <span className={running(j) ? "agent-pulse" : ""}>
                          {running(j) ? (
                            <span className="thread-running-dot" />
                          ) : j.pinned ? (
                            <Pin size={12} />
                          ) : null}
                        </span>
                        <span>{j.title}</span>
                        {j.state === "needs_attention" && !j.autoRecovery && (
                          <b>!</b>
                        )}
                      </button>
                    ))}
                  {group.length > (visibleThreads[dir] || 20) && (
                    <button
                      className="sidebar-show-more"
                      onClick={() =>
                        setVisibleThreads((previous) => ({
                          ...previous,
                          [dir]: (previous[dir] || 20) + 20,
                        }))
                      }
                    >
                      {t("显示更多对话（{count}）", {
                        count: group.length - (visibleThreads[dir] || 20),
                      })}
                    </button>
                  )}
                  {!!background.length && (
                    <details
                      className="sidebar-background"
                      open={
                        background.some((j) => j.id === selected) ||
                        !!search ||
                        undefined
                      }
                    >
                      <summary>
                        {t("子代理与后台记录（{count}）", {
                          count: background.length,
                        })}
                      </summary>
                      {background
                        .slice(0, visibleThreads[`${dir}:background`] || 20)
                        .map((j) => (
                          <button
                            key={j.id}
                            className={`agent-thread ${j.id === selected ? "selected" : ""}`}
                            onClick={() => select(j)}
                            title={j.title}
                          >
                            <span />
                            <span>
                              {j.historySource?.source === "review"
                                ? t("后台审核")
                                : j.title}
                            </span>
                          </button>
                        ))}
                      {background.length >
                        (visibleThreads[`${dir}:background`] || 20) && (
                        <button
                          className="sidebar-show-more"
                          onClick={() =>
                            setVisibleThreads((v) => ({
                              ...v,
                              [`${dir}:background`]:
                                (v[`${dir}:background`] || 20) + 20,
                            }))
                          }
                        >
                          {t("显示更多对话（{count}）", {
                            count:
                              background.length -
                              (visibleThreads[`${dir}:background`] || 20),
                          })}
                        </button>
                      )}
                    </details>
                  )}
                </details>
              );
            })}
            {groups.size > visibleProjects && (
              <button
                className="sidebar-show-more"
                onClick={() => setVisibleProjects((count) => count + 30)}
              >
                {t("显示更多项目（{count}）", {
                  count: groups.size - visibleProjects,
                })}
              </button>
            )}
            {!groups.size && (
              <p className="agent-sidebar-empty">
                {search
                  ? t("没有匹配的会话")
                  : t("创建一个聊天，或导入 CLI / Desktop 的历史。")}
              </p>
            )}
          </div>
          <ImportAllControl
            compact
            call={call}
            changed={refreshDesktop}
            browse={() => setHistory(true)}
          />
          <button
            className="agent-sidebar-link"
            onClick={() => setArchived(!archived)}
          >
            <Archive size={15} />{" "}
            {archived ? t("返回进行中的会话") : t("已归档会话")}
          </button>
          <button
            className="agent-account"
            onClick={() => setManage("accounts")}
          >
            <span className="agent-avatar">
              <Network size={17} />
            </span>
            <span className="account-caption">
              {t("自动账户接力")}
              <small>
                <span
                  className={`account-status-dot ${ready ? "online" : ""}`}
                />
                {ready} {t("个账户可用")}
              </small>
            </span>
            <ChevronRight size={14} className="account-chevron" />
          </button>
        </aside>
        {manage && snapshot ? (
          <SettingsPage
            initial={manage}
            snapshot={snapshot}
            desktop={desktop}
            call={call}
            refresh={refreshDesktop}
            close={() => setManage("")}
            advanced={(tab) => setManage(`advanced:${tab}`)}
          />
        ) : screen === "plugins" || screen === "skills" || screen === "mcp" ? (
          <ExtensionsPage
            initial={screen}
            cwd={currentCwd}
            call={call}
            close={() => setScreen("chat")}
          />
        ) : screen === "schedules" ? (
          <SchedulesPage
            desktop={desktop}
            cwd={currentCwd}
            call={call}
            refresh={refreshDesktop}
            close={() => setScreen("chat")}
            select={(id) => {
              const j = snapshot?.jobs.find((j) => j.id === id);
              if (j) select(j);
              else {
                setSelected(id);
                setScreen("chat");
              }
            }}
          />
        ) : (
          <main className="agent-main">
            <header className="agent-header">
              <div className="conversation-heading">
                <div className="conversation-titles">
                  <span className="conversation-project" title={currentCwd}>
                    <Folder size={13} />
                    {desktop.projects?.find(
                      (p) => p.cwd === (job?.projectCwd || currentCwd),
                    )?.name ||
                      basename(currentCwd) ||
                      t("未关联项目")}
                  </span>
                  {job ? (
                    <button
                      className="conversation-name"
                      title={job.title}
                      aria-label={t("重命名会话")}
                      onClick={() => {
                        setTitle(job.title);
                        setRename(true);
                      }}
                    >
                      <strong>{job.title}</strong>
                      <Pencil size={12} />
                    </button>
                  ) : (
                    <strong>{t("新聊天")}</strong>
                  )}
                </div>
                {job && (
                  <small
                    className={`conversation-state ${running(job) ? "working" : ""}`}
                  >
                    {running(job) ? (
                      <LoaderCircle size={11} className="spin" />
                    ) : job.state === "completed" ? (
                      <Check size={11} />
                    ) : null}
                    {t(jobLabel(job))}
                  </small>
                )}
              </div>
              <div>
                {job && (
                  <>
                    <button
                      aria-label={t("会话菜单")}
                      title={t("更多操作")}
                      onClick={() => setThreadMenu(!threadMenu)}
                    >
                      <Ellipsis size={19} />
                    </button>
                  </>
                )}
                <button
                  title={t("会话信息")}
                  aria-label={t("会话信息")}
                  aria-pressed={inspector}
                  className={inspector ? "selected" : ""}
                  onClick={() => setInspector(!inspector)}
                >
                  <PanelRight size={18} />
                </button>
                <button
                  title={t("项目文件")}
                  aria-label={t("项目文件")}
                  className={
                    inspector && workspaceTab === "files" ? "selected" : ""
                  }
                  onClick={() => {
                    setWorkspaceTab("files");
                    setPreviewFile("");
                    setInspector(true);
                  }}
                >
                  <FolderOpen size={18} />
                </button>
                <button
                  title={t("Git 更改")}
                  aria-label={t("Git 更改")}
                  className={
                    inspector && workspaceTab === "changes" ? "selected" : ""
                  }
                  onClick={() => {
                    setWorkspaceTab("changes");
                    setPreviewFile("");
                    setInspector(true);
                  }}
                >
                  <GitCompareArrows size={18} />
                </button>
                <button
                  title={t("集成终端 · Ctrl+J")}
                  aria-label={t("集成终端")}
                  className={terminal ? "selected" : ""}
                  onClick={() => setTerminal(!terminal)}
                >
                  <SquareTerminal size={18} />
                </button>
              </div>
            </header>
            {error && (
              <div className="agent-error" role="alert">
                <span>{error}</span>
                <button
                  aria-label={t("关闭错误提示")}
                  onClick={() => setError("")}
                >
                  ×
                </button>
              </div>
            )}
            <div className="agent-body">
              <div className="agent-conversation">
                <div
                  className="agent-scroll"
                  ref={scroll}
                  tabIndex={0}
                  aria-label={t("聊天记录")}
                >
                  <div className="agent-transcript" ref={transcript}>
                    {!job && (
                      <div className="agent-welcome">
                        <span className="agent-welcome-mark">
                          <Command size={38} strokeWidth={1.1} />
                        </span>
                        <h1>{t("今天想做些什么？")}</h1>
                        <p>
                          {t("从一个问题、一个想法，或一行待完成的代码开始。")}
                        </p>
                        <div className="agent-suggestions">
                          {[
                            t("了解这个项目的结构"),
                            t("查找并修复一个问题"),
                            t("为项目补充测试"),
                          ].map((t) => (
                            <button
                              key={t}
                              onClick={() =>
                                setDrafts((d) => ({ ...d, new: t }))
                              }
                            >
                              <span>{t}</span>
                              <ArrowUp size={14} />
                            </button>
                          ))}
                        </div>
                        <button
                          className="agent-project-picker"
                          onClick={() => action(chooseProject)}
                        >
                          <Folder size={15} />{" "}
                          {cwd ? basename(cwd) : t("选择项目目录")}
                          <ChevronDown size={13} />
                        </button>
                      </div>
                    )}
                    {job?.historySource && (
                      <div className="agent-history-note">
                        {t("已从")}{" "}
                        {job.historySource.source === "cli"
                          ? "CLI"
                          : job.historySource.source}{" "}
                        {t("导入独立副本")}
                        {job.historySource.issue && (
                          <p>{job.historySource.issue}</p>
                        )}
                      </div>
                    )}
                    {nextBefore !== undefined && (
                      <button
                        className="agent-load-more"
                        disabled={pending}
                        onClick={() =>
                          action(async () => {
                            const id = selected;
                            const p = (await call("chat.read", {
                              id,
                              before: nextBefore,
                            })) as ChatPage;
                            if (selectedRef.current !== id) return;
                            setOlder((v) => [...p.items, ...v]);
                            setOlderBefore(p.before);
                            following.current = false;
                          })
                        }
                      >
                        {t("加载更早的消息")}
                      </button>
                    )}
                    <ActivityTimeline
                      scope={job?.id || "new"}
                      items={allItems}
                      onSource={() => {
                        void call("chat.source.open", {
                          id: selectedRef.current,
                        }).catch(() => {});
                      }}
                      onOpen={openFile}
                      onAgents={() => {
                        setWorkspaceTab("agents");
                        setInspector(true);
                        setPreviewFile("");
                      }}
                      onChanges={() => {
                        setWorkspaceTab("changes");
                        setInspector(true);
                        setPreviewFile("");
                      }}
                    />
                    {job?.agentOrigin && (
                      <div className="agent-origin-note">
                        <button
                          onClick={() => {
                            const parent = snapshot?.jobs.find(
                              (parent) => parent.id === job.agentOrigin!.jobId,
                            );
                            if (parent) {
                              select(parent);
                              setWorkspaceTab("agents");
                              setInspector(true);
                            }
                          }}
                        >
                          <ArrowLeft size={14} />
                          {t("返回主会话")}
                        </button>
                        <span>{t("保留原会话历史 · 自动账户接力")}</span>
                      </div>
                    )}
                    {familyOwner && (
                      <div className="agent-history-note">
                        {t(
                          "同组会话正在运行，这里的消息将在它结束后执行。实时控制可在主会话的代理面板进行。",
                        )}
                      </div>
                    )}
                    {job && !allItems.length && (
                      <p className="agent-muted">
                        {running(job)
                          ? t("正在连接 CLI，准备会话…")
                          : t("暂无消息，发送一条消息开始。")}
                      </p>
                    )}
                    {snapshot?.approvals
                      .filter((a) => a.jobId === selected && a.kind !== "input")
                      .map((a) => (
                        <React.Fragment key={a.id}>
                          {approval(a, (value) =>
                            action(() =>
                              call("approval.respond", {
                                id: a.id,
                                jobId: a.jobId,
                                value,
                              }),
                            ),
                          )}
                        </React.Fragment>
                      ))}
                    {!!chatQuestions.length && (
                      <button
                        className="question-callout"
                        onClick={() => {
                          setWorkspaceTab("questions");
                          setInspector(true);
                          setPreviewFile("");
                        }}
                      >
                        <MessageCircleQuestion size={19} />
                        <span>
                          <strong>{t("Codex 有问题需要你回答")}</strong>
                          <small>
                            {t(
                              "在问题面板选择选项或填写回答，提交后继续执行。",
                            )}
                          </small>
                        </span>
                        <ChevronRight size={17} />
                      </button>
                    )}
                    {job?.autoRecovery && (
                      <RecoveryNotice
                        job={job}
                        pending={pending}
                        onPause={() =>
                          action(() =>
                            call("job.control", {
                              id: job.id,
                              action: "pause",
                            }),
                          )
                        }
                      />
                    )}
                    {job && <RecoveryHistory job={job} />}
                    {job?.lastError && !job.autoRecovery && (
                      <div className="agent-history-note">{job.lastError}</div>
                    )}
                    {running(job) && !job?.autoRecovery && (
                      <div className="agent-activity">
                        <span className="agent-pulse">●</span>{" "}
                        {t(job?.stage || jobLabel(job!))}
                      </div>
                    )}
                    {!!job?.queuedMessages?.length && (
                      <div className="agent-history-note">
                        {t("已排队")}
                        {job.queuedMessages.length}{" "}
                        {t("条消息，将在本轮结束后发送。")}
                      </div>
                    )}
                  </div>
                </div>
                <div className="agent-composer-wrap">
                  {job?.state === "waiting" && job.waitingFor === "model" && (
                    <div className="model-wait-note" role="status">
                      <span>
                        {t(
                          "暂时没有匹配的模型账户。会自动复查，切换模型可继续原任务。",
                        )}
                      </span>
                      <button
                        disabled={pending}
                        onClick={() =>
                          action(async () => {
                            await call("chat.model", {
                              id: job.id,
                              model: job.model,
                              effort: job.effort,
                            });
                          })
                        }
                      >
                        {t("检查模型目录")}
                      </button>
                    </div>
                  )}
                  <button
                    className="chat-follow-latest"
                    aria-label={t("回到最新消息")}
                    title={t("回到最新消息")}
                    data-visible={awayFromLatest}
                    inert={!awayFromLatest}
                    aria-hidden={!awayFromLatest}
                    onClick={() => scrollControl.current?.latest()}
                  >
                    <ArrowDown size={17} />
                  </button>
                  <div
                    className={`composer-controls ${pasting[key] ? "is-pasting" : ""}`}
                    onDragOver={(event) => {
                      if (
                        Array.from(event.dataTransfer.types).includes(
                          "Files",
                        ) &&
                        !job?.archived &&
                        !job?.historySource?.issue
                      ) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                      }
                    }}
                    onDrop={(event) => {
                      if (!event.dataTransfer.files.length) return;
                      event.preventDefault();
                      if (job?.archived || job?.historySource?.issue) return;
                      const dropped = Array.from(event.dataTransfer.files);
                      addPastedFiles(key, () => importPastedFiles(dropped));
                      messageInput.current?.focus();
                    }}
                  >
                    {draft.startsWith("/") && !draft.includes(" ") && (
                      <div
                        className="slash-commands"
                        role="listbox"
                        aria-label={t("斜杠命令")}
                      >
                        {[
                          ["/new", t("新建聊天")],
                          ["/model", t("选择模型和思考强度")],
                          ["/plan", t("切换规划模式")],
                          ["/goal", t("持续目标")],
                          ["/agents", t("查看子代理")],
                          ["/review", t("审查代码")],
                          ["/skills", t("浏览技能")],
                          ["/plugins", t("浏览插件")],
                          ["/mcp", t("MCP 服务器")],
                          ["/terminal", t("打开终端")],
                          ["/compact", t("压缩上下文")],
                          ["/fork", t("创建会话分支")],
                        ]
                          .filter(([command]) => command.startsWith(draft))
                          .map(([command, description]) => (
                            <button
                              key={command}
                              role="option"
                              aria-selected={false}
                              onClick={() => {
                                setDrafts((d) => ({ ...d, [key]: command }));
                              }}
                            >
                              <Command size={14} />
                              <strong>{command}</strong>
                              <span>{description}</span>
                            </button>
                          ))}
                      </div>
                    )}
                    {!!attachments.length && (
                      <div className="agent-attachments">
                        {attachments.map((a, i) => (
                          <div
                            className="draft-attachment"
                            key={a.path}
                            title={a.path}
                          >
                            {a.type === "localImage" ? (
                              <ImageThumbnail
                                compact
                                image={{
                                  id: a.path,
                                  path: a.path,
                                  name: a.name,
                                  origin: "input",
                                }}
                                context={{ id: job?.id, cwd: currentCwd }}
                              />
                            ) : (
                              <FileCode2 size={18} />
                            )}
                            <span>{a.name}</span>
                            <button
                              className="draft-attachment-remove"
                              title={a.path}
                              aria-label={t("移除附件 {p0}", { p0: a.name })}
                              onClick={() =>
                                setFiles((f) => ({
                                  ...f,
                                  [key]: attachments.filter((_, n) => n !== i),
                                }))
                              }
                            >
                              <X size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {!!pasting[key] && (
                      <div className="attachment-progress" role="status">
                        <LoaderCircle size={14} className="spin" />
                        {t("正在添加附件…")}
                      </div>
                    )}
                    <MotionRegion open={!job && goalMode} axis="vertical">
                      <div className="composer-goal-mode">
                        <div>
                          <Target size={15} />
                          <strong>{t("持续目标")}</strong>
                          <span>{t("完成目标前持续推进")}</span>
                          <button
                            aria-label={t("退出持续目标模式")}
                            disabled={pending}
                            onClick={() => setGoalMode(false)}
                          >
                            <X size={14} />
                          </button>
                        </div>
                        <label>
                          {t("目标 Token 预算")}
                          <input
                            aria-label={t("目标 Token 预算")}
                            inputMode="numeric"
                            placeholder={t("不限制")}
                            value={goalBudget}
                            disabled={pending}
                            onChange={(e) => setGoalBudget(e.target.value)}
                          />
                        </label>
                        <p>
                          {t("预算在轮次结束时核算，当前轮次可能超过设定值。")}
                        </p>
                      </div>
                    </MotionRegion>
                    <div className="agent-composer">
                      <div className="composer-attach-control">
                        <button
                          title={t("添加附件")}
                          aria-label={t("添加附件")}
                          onClick={() => setComposerMenu(!composerMenu)}
                        >
                          <Plus size={21} />
                        </button>
                        {composerMenu && (
                          <>
                            <button
                              className="popover-scrim"
                              aria-label={t("关闭添加菜单")}
                              onClick={() => setComposerMenu(false)}
                            />
                            <div
                              className="composer-add-menu"
                              role="menu"
                              aria-label={t("添加到聊天")}
                            >
                              <button
                                role="menuitem"
                                onClick={() => {
                                  setComposerMenu(false);
                                  action(async () => {
                                    const added =
                                      await call("chat.attachments");
                                    setFiles((f) => ({
                                      ...f,
                                      [key]: [...attachments, ...added].slice(
                                        0,
                                        20,
                                      ),
                                    }));
                                  });
                                }}
                              >
                                <Paperclip size={17} />
                                <span>{t("文件和图片")}</span>
                              </button>
                              <button
                                role="menuitem"
                                onClick={() => {
                                  setPlanMode(!planMode);
                                  setComposerMenu(false);
                                }}
                              >
                                <ListTodo size={17} />
                                <span>{t("规划模式")}</span>
                                {planMode && <Check size={15} />}
                              </button>
                              <button
                                role="menuitem"
                                onClick={() => {
                                  setMultiAgent(!multiAgent);
                                  setComposerMenu(false);
                                }}
                              >
                                <Network size={17} />
                                <span>{t("启用子代理")}</span>
                                {multiAgent && <Check size={15} />}
                              </button>
                              {!job && (
                                <button
                                  role="menuitem"
                                  onClick={() => {
                                    setGoalMode(!goalMode);
                                    setComposerMenu(false);
                                    messageInput.current?.focus();
                                  }}
                                >
                                  <Target size={17} />
                                  <span>{t("持续目标")}</span>
                                  {goalMode && <Check size={15} />}
                                </button>
                              )}
                              <hr />
                              <button
                                role="menuitem"
                                onClick={() => {
                                  setScreen("skills");
                                  setComposerMenu(false);
                                }}
                              >
                                <Sparkles size={17} />
                                <span>Skills</span>
                                <ChevronRight size={14} />
                              </button>
                              <button
                                role="menuitem"
                                onClick={() => {
                                  setScreen("plugins");
                                  setComposerMenu(false);
                                }}
                              >
                                <Blocks size={17} />
                                <span>{t("插件")}</span>
                                <ChevronRight size={14} />
                              </button>
                              <button
                                role="menuitem"
                                onClick={() => {
                                  setScreen("mcp");
                                  setComposerMenu(false);
                                }}
                              >
                                <Network size={17} />
                                <span>{t("MCP 服务器")}</span>
                                <ChevronRight size={14} />
                              </button>
                              {job && (
                                <>
                                  <hr />
                                  <button
                                    role="menuitem"
                                    disabled={running(job)}
                                    onClick={() => {
                                      setComposerMenu(false);
                                      action(() => send("send", true));
                                    }}
                                  >
                                    <GitCompareArrows size={17} />
                                    <span>{t("审查代码")}</span>
                                  </button>
                                </>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                      <textarea
                        ref={messageInput}
                        rows={1}
                        aria-label={t("消息")}
                        placeholder={
                          job?.archived
                            ? t("取消归档后继续对话")
                            : job
                              ? t("继续提问，或补充任务要求…")
                              : goalMode
                                ? t("描述期望的最终结果和验收标准…")
                                : t("描述你想完成的任务…")
                        }
                        value={draft}
                        disabled={
                          !!job?.archived || !!job?.historySource?.issue
                        }
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [key]: e.target.value }))
                        }
                        onPaste={(event) => {
                          const pasted = Array.from(event.clipboardData.files);
                          if (pasted.length) {
                            event.preventDefault();
                            addPastedFiles(key, () =>
                              importPastedFiles(pasted),
                            );
                          } else if (
                            !event.clipboardData.getData("text/plain")
                          ) {
                            // Explorer file lists can omit browser File objects.
                            addPastedFiles(key, () =>
                              call("chat.attachments.clipboard"),
                            );
                          }
                        }}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            (desktop.preferences?.enterSends !== false ||
                              e.ctrlKey ||
                              e.metaKey) &&
                            !e.nativeEvent.isComposing
                          ) {
                            e.preventDefault();
                            action(() =>
                              send(
                                running(job)
                                  ? desktop.preferences?.followUp === "steer" &&
                                    job?.state === "running"
                                    ? "steer"
                                    : "queue"
                                  : "send",
                              ),
                            );
                          }
                        }}
                      />
                      <div className="composer-send-controls">
                        {running(job) && (
                          <button
                            className="agent-stop"
                            title={t("停止本轮")}
                            aria-label={t("停止本轮")}
                            disabled={pending}
                            onClick={() =>
                              action(() =>
                                call("job.control", {
                                  id: job!.id,
                                  action: "pause",
                                }),
                              )
                            }
                          >
                            <Square size={13} fill="currentColor" />
                          </button>
                        )}
                        <button
                          className="agent-send"
                          title={
                            familyOwner
                              ? t("排队发送")
                              : running(job)
                                ? desktop.preferences?.followUp === "steer" &&
                                  job?.state === "running"
                                  ? t("立即补充到当前轮次 ↗")
                                  : t("排队发送")
                                : !job && goalMode
                                  ? t("保存并开始")
                                  : t("发送")
                          }
                          aria-label={
                            familyOwner
                              ? t("排队发送")
                              : running(job)
                                ? desktop.preferences?.followUp === "steer" &&
                                  job?.state === "running"
                                  ? t("立即补充到当前轮次 ↗")
                                  : t("排队发送")
                                : !job && goalMode
                                  ? t("保存并开始")
                                  : t("发送")
                          }
                          disabled={
                            pending ||
                            !!pasting[key] ||
                            !draft.trim() ||
                            !!job?.archived ||
                            !!job?.historySource?.issue
                          }
                          onClick={() =>
                            action(() =>
                              send(
                                running(job)
                                  ? desktop.preferences?.followUp === "steer" &&
                                    job?.state === "running"
                                    ? "steer"
                                    : "queue"
                                  : "send",
                              ),
                            )
                          }
                        >
                          {pending ? (
                            <LoaderCircle size={17} className="spin" />
                          ) : (
                            <ArrowUp size={20} />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="agent-composer-toolbar">
                      <div>
                        <div className="composer-environment">
                          <Folder size={13} />
                          <select
                            aria-label={t("工作环境")}
                            value={job ? "local" : environment}
                            disabled={!!job}
                            onChange={(e) => {
                              setEnvironment(e.target.value);
                              if (currentCwd)
                                void call("workspace.branches", {
                                  cwd: currentCwd,
                                })
                                  .then(setBranchList)
                                  .catch(() => {});
                            }}
                          >
                            <option value="local">{t("本地")}</option>
                            <option value="worktree">Worktree</option>
                          </select>
                          <span className="caption-divider" />
                          <GitBranch size={13} />
                          {!job && environment === "worktree" ? (
                            <select
                              aria-label={t("Worktree 起始分支")}
                              value={branch}
                              onChange={(e) => setBranch(e.target.value)}
                            >
                              <option value="HEAD">{t("当前分支")}</option>
                              {branchList.map((value) => (
                                <option value={value} key={value}>
                                  {value}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <button
                              title={currentCwd}
                              onClick={() => action(chooseProject)}
                            >
                              {currentCwd
                                ? basename(currentCwd)
                                : t("选择项目")}
                              <ChevronDown size={11} />
                            </button>
                          )}
                        </div>
                        <PermissionPicker
                          value={
                            job?.preserveNativePermissions &&
                            sandbox === job.sandbox
                              ? "native"
                              : sandbox
                          }
                          native={!!job?.preserveNativePermissions}
                          disabled={running(job) || !!familyOwner}
                          onChange={(value) => {
                            setSandbox(value);
                            if (job?.preserveNativePermissions)
                              action(() =>
                                call("chat.update", {
                                  id: job.id,
                                  sandbox: value,
                                }),
                              );
                          }}
                        />
                        {planMode && (
                          <button
                            className="composer-mode-badge"
                            title={t("退出规划模式")}
                            onClick={() => setPlanMode(false)}
                          >
                            <ListTodo size={13} />
                            {t("规划")}
                            <X size={11} />
                          </button>
                        )}
                        {!job && goalMode && (
                          <button
                            className="composer-goal-save"
                            disabled={
                              pending || !!pasting[key] || !draft.trim()
                            }
                            onClick={() =>
                              action(() => send("send", false, true))
                            }
                          >
                            {t("仅保存目标")}
                          </button>
                        )}
                      </div>
                      <div>
                        <ModelPicker
                          model={model}
                          effort={effort}
                          accountId={
                            snapshot?.accounts.find(
                              (a) => a.enabled && a.status === "ready",
                            )?.id
                          }
                          open={modelPicker}
                          setOpen={setModelPicker}
                          onChange={(m, e) => {
                            if (
                              job?.state === "waiting" &&
                              job.waitingFor === "model" &&
                              pending
                            )
                              return;
                            modelDirty.current = true;
                            setModel(m);
                            setEffort(e);
                            if (
                              job?.state === "waiting" &&
                              job.waitingFor === "model"
                            )
                              action(async () => {
                                await call("chat.model", {
                                  id: job.id,
                                  model: m,
                                  effort: e,
                                });
                              });
                          }}
                        />
                        <div className="agent-composer-caption">
                          {running(job) && draft.trim() ? (
                            <button
                              disabled={pending || job?.state !== "running"}
                              onClick={() => action(() => send("steer"))}
                            >
                              {t("立即补充到当前轮次 ↗")}
                            </button>
                          ) : (
                            <span className="composer-keyboard-hint">
                              {desktop.preferences?.enterSends === false
                                ? t("Ctrl + Enter 发送")
                                : t("Enter 发送 · Shift + Enter 换行")}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <MotionRegion
                open={inspector}
                axis="horizontal"
                preview={!!previewFile}
              >
                <Workbench
                  tab={workspaceTab}
                  setTab={setWorkspaceTab}
                  cwd={currentCwd}
                  job={job}
                  items={allItems}
                  call={call}
                  close={() => setInspector(false)}
                  file={previewFile}
                  setFile={setPreviewFile}
                  setDraft={(text) => {
                    setDrafts((d) => ({ ...d, [key]: text }));
                  }}
                  draftAttachments={attachments}
                  questions={chatQuestions}
                  onOpenConversation={(child) => {
                    select(child);
                    setInspector(false);
                  }}
                  addSources={() => {
                    const target = key;
                    addPastedFiles(target, () => call("chat.attachments"));
                    messageInput.current?.focus();
                  }}
                />
              </MotionRegion>
            </div>
            <MotionRegion open={terminal} axis="vertical">
              <TerminalPane
                cwd={currentCwd}
                call={call}
                close={() => setTerminal(false)}
              />
            </MotionRegion>
          </main>
        )}
        {threadMenu && (
          <>
            <button
              className="popover-scrim"
              aria-label={t("关闭会话菜单")}
              onClick={() => setThreadMenu(false)}
            />
            <div className="thread-menu" role="menu" aria-label={t("会话操作")}>
              {job ? (
                <>
                  <div className="thread-menu-info">
                    <strong>{job.title}</strong>
                    <small>
                      {t(jobLabel(job))} · {account?.label || t("自动账户接力")}
                    </small>
                  </div>
                  <button
                    role="menuitem"
                    disabled={running(job)}
                    onClick={() => {
                      action(() =>
                        call("chat.update", {
                          id: job.id,
                          pinned: !job.pinned,
                        }),
                      );
                      setThreadMenu(false);
                    }}
                  >
                    <Pin size={15} />
                    {job.pinned ? t("取消置顶") : t("置顶会话")}
                  </button>
                  <button
                    role="menuitem"
                    disabled={pending || running(job)}
                    onClick={() => {
                      action(async () =>
                        select(await call("chat.fork", job.id)),
                      );
                      setThreadMenu(false);
                    }}
                  >
                    <GitBranch size={15} />
                    {t("创建会话分支")}
                  </button>
                  <button
                    role="menuitem"
                    disabled={
                      pending ||
                      running(job) ||
                      !job.threadId ||
                      !!job.historySource?.issue
                    }
                    onClick={() => {
                      setTurnHistory(true);
                      setThreadMenu(false);
                    }}
                  >
                    <Pencil size={15} />
                    {t("会话历史与编辑")}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      action(() => call("chat.export", job.id));
                      setThreadMenu(false);
                    }}
                  >
                    <Download size={15} />
                    {t("导出 Markdown")}
                  </button>
                  <button
                    role="menuitem"
                    disabled={running(job)}
                    onClick={() => {
                      action(() =>
                        call("chat.update", {
                          id: job.id,
                          archived: !job.archived,
                        }),
                      );
                      setThreadMenu(false);
                    }}
                  >
                    <Archive size={15} />
                    {job.archived ? t("取消归档") : t("归档会话")}
                  </button>
                  {!job.autoRecovery &&
                    ["paused", "needs_attention"].includes(job.state) && (
                      <button
                        role="menuitem"
                        onClick={() => {
                          action(() =>
                            call("job.control", {
                              id: job.id,
                              action: "resume",
                            }),
                          );
                          setThreadMenu(false);
                        }}
                      >
                        <Undo2 size={15} />
                        {t("继续未完成任务")}
                      </button>
                    )}
                  <hr />
                  <button
                    role="menuitem"
                    onClick={() => {
                      action(() => call("job.directory", job.id));
                      setThreadMenu(false);
                    }}
                  >
                    <FolderOpen size={15} />
                    {t("打开项目目录")}
                  </button>
                  <button
                    role="menuitem"
                    disabled={running(job)}
                    onClick={() => {
                      setOperations(true);
                      setThreadMenu(false);
                    }}
                  >
                    <SlidersHorizontal size={15} />
                    {t("高级 CLI 操作")}
                  </button>
                  <small className="thread-menu-id">
                    {job.threadId || t("等待创建会话")}
                  </small>
                </>
              ) : (
                <>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setScreen("plugins");
                      setThreadMenu(false);
                    }}
                  >
                    <Blocks size={15} />
                    {t("插件与 Skills")}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setScreen("schedules");
                      setThreadMenu(false);
                    }}
                  >
                    <CalendarClock size={15} />
                    {t("定时任务")}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setManage("settings");
                      setThreadMenu(false);
                    }}
                  >
                    <Settings size={15} />
                    {t("设置")}
                  </button>
                </>
              )}
            </div>
          </>
        )}
        {palette && (
          <SearchPalette
            jobs={snapshot?.jobs || []}
            close={() => setPalette(false)}
            choose={(j) => {
              select(j);
              setArchived(!!j.archived);
              setPalette(false);
            }}
            newChat={() => {
              select();
              setPalette(false);
            }}
          />
        )}
        <ModalPresence>
          {history && (
            <HistoryDialog
              call={call}
              close={() => setHistory(false)}
              imported={(id) => {
                setSelected(id);
                setArchived(false);
              }}
            />
          )}
        </ModalPresence>
        <ModalPresence
          onExitComplete={() => {
            if (focusAfterHistory.current) {
              focusAfterHistory.current = false;
              messageInput.current?.focus({ preventScroll: true });
            }
          }}
        >
          {turnHistory && job && (
            <TurnHistory
              job={job}
              call={call}
              close={() => setTurnHistory(false)}
              created={async (created, text) => {
                setSnapshot(await window.relay.snapshot());
                select(created);
                if (text !== undefined)
                  setDrafts((values) => ({ ...values, [created.id]: text }));
                focusAfterHistory.current = true;
              }}
            />
          )}
        </ModalPresence>
        <ModalPresence>
          {operations && job && (
            <Operations
              job={job}
              initialMethod={operationMethod}
              call={call}
              close={() => setOperations(false)}
            />
          )}
        </ModalPresence>
        <ModalPresence>
          {rename && job && (
            <Dialog title={t("重命名会话")} onClose={() => setRename(false)}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  action(async () => {
                    await call("chat.update", { id: job.id, title });
                    setRename(false);
                  });
                }}
              >
                <label>
                  {t("会话名称")}
                  <input
                    autoFocus
                    value={title}
                    maxLength={120}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <button className="primary" disabled={pending || !title.trim()}>
                  {t("保存")}
                </button>
              </form>
            </Dialog>
          )}
        </ModalPresence>
      </div>
    </div>
  );
}

function SearchPalette({
  jobs,
  choose,
  close,
  newChat,
}: {
  jobs: Job[];
  choose: (job: Job) => void;
  close: () => void;
  newChat: () => void;
}) {
  useI18n();

  const [query, setQuery] = useState(""),
    [index, setIndex] = useState(0);
  const results = jobs
    .filter((j) =>
      `${j.title} ${j.cwd}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt,
    )
    .slice(0, 30);
  return (
    <div
      className="search-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="search-palette"
        role="dialog"
        aria-label={t("搜索全部聊天")}
      >
        <div className="search-palette-input">
          <Search size={19} />
          <input
            autoFocus
            aria-label={t("查找聊天或项目")}
            placeholder={t("搜索聊天和项目…")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((v) => Math.min(results.length - 1, v + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((v) => Math.max(0, v - 1));
              }
              if (e.key === "Enter" && results[index]) {
                e.preventDefault();
                choose(results[index]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="search-palette-results">
          <span>
            {query
              ? t("{p0} 个匹配的聊天", { p0: results.length })
              : t("最近的聊天")}
          </span>
          {results.map((j, i) => (
            <button
              className={i === index ? "selected" : ""}
              key={j.id}
              onClick={() => choose(j)}
              onMouseEnter={() => setIndex(i)}
            >
              <MessageSquare size={17} />
              <span>
                <strong>{j.title}</strong>
                <small>
                  {basename(j.cwd)} · {t(jobLabel(j))}
                  {j.archived ? t(" · 已归档") : ""}
                </small>
              </span>
              {j.pinned && <Pin size={13} />}
              <ChevronRight size={15} />
            </button>
          ))}
          {!results.length && <p>{t("没有匹配的聊天")}</p>}
        </div>
        <footer>
          <button onClick={newChat}>
            <SquarePen size={15} />
            {t("新聊天")}
          </button>
          <span>{t("↑↓ 选择 · Enter 打开")}</span>
        </footer>
      </section>
    </div>
  );
}
function Message({ item }: { item: ChatItem }) {
  useI18n();

  if (item.role === "tool")
    return (
      <details className="agent-tool">
        <summary>
          <span>
            {item.kind === "diff" || item.kind === "fileChange" ? "✎" : "⌘"}
          </span>
          <span>{item.text.slice(0, 150)}</span>
          <small>{item.status === "running" ? t("执行中") : ""}</small>
        </summary>
        <pre>{item.detail || item.text}</pre>
      </details>
    );
  return (
    <article className={`agent-message ${item.role}`}>
      <small>
        {item.role === "user"
          ? t("你")
          : item.role === "assistant"
            ? "Codex"
            : t("系统")}
      </small>
      <MessageText text={item.text} />
      {item.detail && (
        <pre className="agent-message-attachments">{item.detail}</pre>
      )}
      {item.role === "assistant" && (
        <CopyButton text={item.text} label={t("复制回答")} />
      )}
    </article>
  );
}
// Text-only Markdown: never execute raw HTML or renderer-supplied URLs.
function MessageText({ text }: { text: string }) {
  useI18n();

  return (
    <div className="agent-markdown">
      {text.split(/(```[\s\S]*?(?:```|$))/g).map((block, i) =>
        block.startsWith("```") ? (
          <pre key={i}>
            <code>
              {block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}
            </code>
          </pre>
        ) : (
          <div key={i}>
            {block.split("\n").map((line, n) => {
              const inline = line
                .replace(/^#{1,6} /, "")
                .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
                .map((v, k) =>
                  v.startsWith("**") ? (
                    <strong key={k}>{v.slice(2, -2)}</strong>
                  ) : v.startsWith("`") ? (
                    <code key={k}>{v.slice(1, -1)}</code>
                  ) : (
                    v
                  ),
                );
              return /^#{1,6} /.test(line) ? (
                <h3 key={n}>{inline}</h3>
              ) : (
                <div
                  className={
                    /^[-*] /.test(line) ? "agent-list-line" : "agent-text-line"
                  }
                  key={n}
                >
                  {inline.length ? inline : <br />}
                </div>
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}
function HistoryDialog({
  call,
  close,
  imported,
}: {
  call: (n: string, a?: unknown) => Promise<any>;
  close: () => void;
  imported: (id: string) => void;
}) {
  useI18n();

  const [entries, setEntries] = useState<HistoryEntry[]>([]),
    [warnings, setWarnings] = useState<string[]>([]),
    [roots, setRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [report, setReport] = useState("");
  const scan = async (homes?: string[]) => {
    setBusy(true);
    setError("");
    try {
      const r = await call("history.scan", homes ? { homes } : {});
      setEntries(r.entries);
      setRoots(r.roots);
      setWarnings(r.warnings);
      setChecked(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void scan();
  }, []);
  const runImport = async (all: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = await call("history.import", all ? {} : { ids: [...checked] });
      setReport(
        t("已导入 {p0} 个，已存在 {p1} 个，失败 {p2} 个。", {
          p0: r.imported.length,
          p1: r.skipped.length,
          p2: r.errors.length,
        }),
      );
      setWarnings(r.errors);
      if (r.imported[0]) imported(r.imported[0]);
      setEntries((e) =>
        e.map((x) => ({
          ...x,
          imported:
            all || checked.has(x.id)
              ? !r.errors.some((s: string) => s.startsWith(x.title + "："))
              : x.imported,
        })),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const filtered = entries.filter((e) =>
    `${e.title} ${e.cwd} ${e.source}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  return (
    <Dialog
      title={t("导入 CLI / Desktop 对话")}
      onClose={busy ? () => {} : close}
    >
      <div className="agent-import">
        <p>
          {t(
            "扫描本机 Codex 目录中的全部会话与归档。历史保存为独立副本；原客户端会话保持原样。",
          )}
        </p>
        <small className="agent-path">
          {roots.join(" · ") || t("默认：CODEX_HOME 和用户 .codex 目录")}
        </small>
        <div className="agent-import-toolbar">
          <button disabled={busy} onClick={() => void scan()}>
            {t("扫描默认目录")}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void call("choose.directory").then(
                (p) => p && scan([...roots, p]),
              )
            }
          >
            {t("添加 Codex 目录")}
          </button>
          <input
            aria-label={t("搜索导入历史")}
            placeholder={t("搜索标题、项目、来源…")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="agent-history-list">
          {filtered.map((e) => (
            <label key={e.id}>
              <input
                type="checkbox"
                checked={checked.has(e.id)}
                disabled={busy || e.imported}
                onChange={(ev) =>
                  setChecked((old) => {
                    const next = new Set(old);
                    ev.target.checked ? next.add(e.id) : next.delete(e.id);
                    return next;
                  })
                }
              />
              <span>
                <strong>{e.title}</strong>
                <small>
                  {basename(e.cwd)} · {e.source} {e.archived ? t("· 归档") : ""}{" "}
                  {e.imported ? t("· 已导入") : ""}
                </small>
                {e.issue && (
                  <small className="agent-import-warning">{e.issue}</small>
                )}
              </span>
            </label>
          ))}
          {!entries.length && (
            <p>
              {busy
                ? t("正在扫描本地历史…")
                : t(
                    "未发现会话。可添加其他 CLI / Desktop 使用的 Codex 数据目录。",
                  )}
            </p>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        {report && <p role="status">{report}</p>}
        {warnings.length > 0 && (
          <details>
            <summary>
              {warnings.length} {t("条导入提示")}
            </summary>
            <pre>{warnings.join("\n")}</pre>
          </details>
        )}
        <div className="agent-import-footer">
          <span>
            {t("找到")}
            {entries.length} {t("个会话")}
          </span>
          <button
            disabled={busy || !checked.size}
            onClick={() => void runImport(false)}
          >
            {t("导入选中 (")}
            {checked.size})
          </button>
          <button
            className="primary"
            disabled={busy || !entries.length}
            onClick={() => void runImport(true)}
          >
            {busy ? t("处理中…") : t("导入全部")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
function Operations({
  job,
  initialMethod,
  call,
  close,
}: {
  job: Job;
  initialMethod: string;
  call: (n: string, a?: unknown) => Promise<any>;
  close: () => void;
}) {
  useI18n();

  const [method, setMethod] = useState<string>(initialMethod),
    [params, setParams] = useState(
      JSON.stringify(
        capabilities.find((c) => c.method === initialMethod)?.params ?? {},
        null,
        2,
      ),
    ),
    [result, setResult] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog title={t("CLI 能力与配置")} onClose={busy ? () => {} : close}>
      <div className="agent-operations">
        <p>
          {t(
            "直接调用当前 CLI 的 app-server 协议。配置保存在此会话的隔离目录。不同 CLI 版本可用的操作和参数会有差异。",
          )}
        </p>
        <label>
          {t("操作")}
          <select
            value={method}
            onChange={(e) => {
              setMethod(e.target.value);
              setParams(
                JSON.stringify(
                  capabilities.find((c) => c.method === e.target.value)?.params,
                  null,
                  2,
                ),
              );
            }}
          >
            {capabilities.map((c) => (
              <option key={c.method} value={c.method}>
                {t(c.label)} · {c.method}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("参数（JSON）")}
          <textarea
            spellCheck={false}
            value={params}
            rows={8}
            onChange={(e) => setParams(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={busy || running(job)}
          onClick={() => {
            setBusy(true);
            setResult("");
            void Promise.resolve()
              .then(() =>
                call("agent.operation", {
                  id: job.id,
                  method,
                  params: JSON.parse(params),
                }),
              )
              .then((r) => setResult(JSON.stringify(r, null, 2)))
              .catch((e) => setResult(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? t("执行中…") : t("执行操作")}
        </button>
        {result && <pre aria-label={t("CLI 操作结果")}>{result}</pre>}
      </div>
    </Dialog>
  );
}
