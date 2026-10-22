export type JobState =
  | "queued"
  | "preparing"
  | "running"
  | "pausing"
  | "rotating"
  | "waiting"
  | "watching"
  | "paused"
  | "needs_attention"
  | "completed"
  | "cancelled";
export interface WindowQuota {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
export interface Quota {
  primary: WindowQuota | null;
  secondary: WindowQuota | null;
  limitId: string;
  observedAt: number;
  reached: boolean;
  unlimited?: boolean;
}
export interface Account {
  modelAccess?: ModelAccess;
  modelDenials?: Record<string, number>;
  resetWindows?: Record<
    string,
    {
      resetAt: number;
      observedAt: number;
      evidence: "usage" | "stable" | "activity";
    }
  >;
  warmups?: Record<string, ResetWarmup>;
  expiresAt?: number | null;
  limitMode?: "auto" | "fiveHour" | "weeklyOnly";
  id: string;
  identity: string;
  userIdentity?: string;
  label: string;
  email: string;
  plan: string;
  enabled: boolean;
  status: "ready" | "unknown" | "limited" | "reauth" | "offline";
  quotas: Record<string, Quota>;
  blockedUntil: number | null;
  failureCount: number;
  lastError?: string;
}
export interface ModelAccess {
  ids: string[];
  observedAt: number;
  complete: boolean;
}
export interface ResetWarmup {
  home?: string;
  processSafe?: boolean;
  resetAt: number;
  status:
    | "queued"
    | "running"
    | "confirmed"
    | "sent"
    | "failed"
    | "uncertain"
    | "covered"
    | "yielded";
  queuedAt: number;
  finishedAt?: number;
  nextResetAt?: number;
  error?: string;
}
export interface TokenCounts {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
}
export interface JobTokenUsage extends TokenCounts {
  // Keep the flat cumulative counters compatible with older saved jobs.
  last?: TokenCounts;
  modelContextWindow?: number | null;
}
export interface RecoveryEvent {
  at: number;
  kind: "scheduled" | "resumed" | "stopped" | "completed";
  attempt: number;
  detail?: string;
}
export interface Job {
  recoveryHistory?: RecoveryEvent[];
  schedule?: { taskId: string; runId: string; requestedAt: number };
  projectCwd?: string;
  agentOrigin?: { jobId: string; parentThreadId: string };
  preserveNativePermissions?: boolean;
  goal?: ThreadGoal | null;
  goalResumeAfterQuota?: boolean;
  goalResumeAfterModelChange?: boolean;
  goalStartRequested?: boolean;
  runtimeHomeId?: string;
  pinned?: boolean;
  planMode?: boolean;
  multiAgent?: boolean;
  serviceTier?: string;
  agents?: AgentState[];
  tokenUsage?: JobTokenUsage;
  interactive?: boolean;
  pendingMessage?: string;
  attachments?: ChatAttachment[];
  queueRevision?: number;
  queuedMessages?: {
    id?: string;
    text: string;
    attachments: ChatAttachment[];
    model?: string;
    effort?: string;
    review?: boolean;
    planMode?: boolean;
    multiAgent?: boolean;
    serviceTier?: string;
  }[];
  archived?: boolean;
  historySource?: {
    threadId: string;
    source: string;
    issue?: string;
    storage?: "sqlite";
    itemCount?: number;
    journalVersion?: number;
    parentThreadId?: string;
  };
  review?: boolean;
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  mode: "cli" | "desktop";
  model: string;
  effort: string;
  bucket: string;
  state: JobState;
  waitingFor?: "model" | "recovery";
  stage?: string;
  lastActivityAt?: number;
  lastHeartbeatAt?: number;
  threadId?: string;
  turnId?: string;
  accountId?: string;
  recoveryRequired?: boolean;
  // Persist user intent before stopping so crash recovery never undoes it.
  stopIntent?: "pause" | "cancel";
  recoveryAttempts?: number;
  autoRecovery?: {
    reason: "process" | "interrupted" | "unknown";
    attempt: number;
    nextAttemptAt: number;
  };
  desktopSubmissionPending?: boolean;
  // Written before sending input; cleared only after a confirmed acceptance.
  submissionUncertain?: boolean;
  completionMarker?: string;
  maxCompletionRetries?: number;
  completionRetries?: number;
  importedRollout?: string;
  existing?: ExistingLink;
  nextWakeAt?: number;
  rotations: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  approvalPolicy: "on-request" | "never";
  sandbox: "workspaceWrite" | "readOnly" | "dangerFullAccess";
}
export interface ThreadGoal {
  threadId: string;
  objective: string;
  status:
    | "active"
    | "paused"
    | "blocked"
    | "usageLimited"
    | "budgetLimited"
    | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
export interface ProcessIdentity {
  pid: number;
  startedAt: string;
  executable: string;
  title: string;
}
export interface ExistingLink {
  sourceHome: string;
  sourceFile: string;
  phase: "watching" | "handoff" | "managed";
  strategy: "quota" | "now";
  processes: ProcessIdentity[];
  allowStop: boolean;
  attachedAt: number;
  sourceStamp?: string;
  lastObservedTurn?: string;
  completionEligible?: boolean;
  stopAttempted?: boolean;
  stopConfirmed?: boolean;
}
export interface ExistingCandidate {
  id: string;
  threadId: string;
  title: string;
  cwd: string;
  model: string;
  source: string;
  updatedAt: number;
  status: "running" | "quota" | "completed" | "interrupted" | "unknown";
  preview: string;
  issue?: string;
}
export interface ExistingInspection {
  candidate: ExistingCandidate;
  processes: ProcessIdentity[];
  canHandoff: boolean;
  issue?: string;
}
export interface Approval {
  historyId?: string;
  createdAt?: number;
  responsePending?: boolean;
  id: string;
  jobId: string;
  method: string;
  params: unknown;
  kind:
    | "command"
    | "file"
    | "input"
    | "permissions"
    | "elicitation"
    | "unsupported";
}
export interface UserQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[] | null;
}
export interface QuestionRecord {
  id: string;
  requestId: string;
  threadId?: string;
  turnId?: string;
  questions: UserQuestion[];
  status: "pending" | "answered" | "expired" | "unconfirmed";
  isBlocking: boolean;
  answers?: Record<string, { answers: string[] }>;
  at: number;
}
export interface Log {
  id: string;
  at: number;
  level: "info" | "warning" | "error" | "output";
  message: string;
  jobId?: string;
}
export interface Settings {
  maxConcurrentTasks?: number;
  accountSelection?: "smart" | "roundRobin";
  resetWarmupEnabled?: boolean;
  cliPath: string;
  desktopPath: string;
  pollSeconds: number;
  retrySeconds: number;
  resumePrompt: string;
  desktop: {
    editorSelector: string;
    sendSelector: string;
    stopSelector: string;
    threadSelector: string;
    projectSelector: string;
  };
}
export interface AppState {
  version: 1;
  accounts: Account[];
  jobs: Job[];
  logs: Log[];
  settings: Settings;
  cursor: number;
}
export interface Snapshot extends AppState {
  approvals: Approval[];
  login?: { accountId: string; url: string; code?: string };
  loginError?: string;
  loginResult?: { accountId: string; email: string; updated: boolean };
  platform: string;
}
export type NewJob = Pick<
  Job,
  | "title"
  | "prompt"
  | "cwd"
  | "mode"
  | "model"
  | "effort"
  | "bucket"
  | "approvalPolicy"
  | "sandbox"
  | "completionMarker"
  | "maxCompletionRetries"
  | "interactive"
  | "attachments"
  | "review"
  | "planMode"
  | "multiAgent"
  | "serviceTier"
>;
export interface AgentState {
  conversationId?: string;
  threadId: string;
  parentThreadId?: string;
  name: string;
  role?: string;
  status: string;
  prompt?: string;
  message?: string;
  model?: string;
  effort?: string;
  turnId?: string;
  updatedAt: number;
}
export interface ChatAttachment {
  type: "localImage" | "mention";
  path: string;
  name: string;
}
export interface ChatItem {
  images?: ChatImage[];
  sourceTruncated?: boolean;
  turnId?: string;
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  kind: string;
  text: string;
  at: number;
  status?: string;
  detail?: string;
  data?: Record<string, any>;
}
export interface ChatImage {
  url?: string;
  id: string;
  origin: "input" | "view" | "generated";
  name: string;
  path?: string;
  data?: string;
  mime?: string;
}
export interface ChatAsset {
  url?: string;
  path: string;
  name: string;
  kind: "image" | "file";
}
export interface ChatPage {
  items: ChatItem[];
  total: number;
  before?: number;
}
export interface HistoryEntry {
  storage?: "sqlite";
  projectCwd?: string;
  parentThreadId?: string;
  id: string;
  threadId: string;
  title: string;
  cwd: string;
  source: string;
  updatedAt: number;
  archived: boolean;
  issue?: string;
  imported?: boolean;
}
export interface CatalogLoginUpdate {
  name: string;
  success: boolean;
  error?: string;
  loginId?: string;
}
export interface TerminalSession {
  id: string;
  cwd: string;
  name: string;
  state: "starting" | "running" | "closing" | "exited" | "error";
  exitCode?: number;
  error?: string;
}
export interface Bridge {
  filePath?: (file: File) => string;
  snapshot(): Promise<Snapshot>;
  command(name: string, args?: unknown): Promise<unknown>;
  onSnapshot(fn: (snapshot: Snapshot) => void): () => void;
  onChat?(fn: (update: { id: string; page: ChatPage }) => void): () => void;
  onCatalogLogin?(fn: (update: CatalogLoginUpdate) => void): () => void;
}
