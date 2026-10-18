// Deterministic local protocol peer. No network or actual model inference.
const fs = require("node:fs"),
  path = require("node:path"),
  readline = require("node:readline");
const home = process.env.RELAY_TEST_HOME;
const root = "agent-root",
  child = "agent-child",
  nested = "agent-nested";
let account,
  exhausted = false,
  goal = "active",
  spawned = false;
const turns = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method, params) => send({ method, params });
const goalValue = () => ({
  threadId: root,
  objective: "Preserve the entire nested task",
  status: goal,
  tokenBudget: 50000,
  tokensUsed: 1234,
  timeUsedSeconds: 12,
});
function start(threadId, id) {
  turns.set(threadId, id);
  notify("turn/started", { threadId, turn: { id } });
}
function complete(threadId, id) {
  notify("turn/completed", {
    threadId,
    turn: { id, status: "interrupted", error: null },
  });
  if (turns.get(threadId) === id) turns.delete(threadId);
}
function spawn(threadId, parent, name) {
  notify("thread/started", {
    thread: {
      id: threadId,
      agentNickname: name,
      source: { subAgent: { thread_spawn: { parent_thread_id: parent } } },
    },
  });
  notify("item/completed", {
    threadId: parent,
    item: {
      type: "subAgentActivity",
      id: `activity-${threadId}`,
      agentThreadId: threadId,
      agentPath: name,
      kind: "started",
      model: "synthetic-nested",
      reasoningEffort: "high",
    },
  });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line),
    p = m.params || {};
  if (m.id === undefined) return;
  fs.appendFileSync(
    path.join(home, "agents-journal.jsonl"),
    JSON.stringify({
      method: m.method,
      account,
      threadId: p.threadId,
      pid: process.pid,
      ...(m.method.startsWith("thread/goal/") ? { params: p } : {}),
      ...(m.method === "turn/start"
        ? { text: p.input?.[0]?.text, effort: p.effort }
        : {}),
    }) + "\n",
  );
  let result = {};
  if (m.method === "account/login/start") account = p.chatgptAccountId;
  if (m.method === "windowsSandbox/readiness") result = { status: "ready" };
  if (m.method === "account/rateLimits/read")
    result = {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: exhausted ? 100 : 10,
          windowDurationMins: 300,
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    };
  if (m.method === "thread/goal/get") result = { goal: goalValue() };
  if (m.method === "thread/goal/set") {
    goal = p.status;
    result = { goal: goalValue() };
    notify("thread/goal/updated", { threadId: root, goal: goalValue() });
  }
  if (m.method === "thread/start" || m.method === "thread/resume") {
    result = { thread: { id: p.threadId || root }, model: "synthetic-root" };
    if (m.method === "thread/resume" && p.threadId === root && account === "b")
      start(root, "root-b");
  }
  if (m.method === "turn/start") {
    if (p.threadId === root) {
      start(root, "root-a");
      result = { turn: { id: "root-a" } };
      notify("thread/goal/updated", { threadId: root, goal: goalValue() });
      spawn(child, root, "Scout");
      start(child, "child-a");
      spawn(nested, child, "Scout/Nested");
      start(nested, "nested-a");
      notify("item/completed", {
        threadId: root,
        turnId: "root-a",
        item: {
          type: "collabAgentToolCall",
          id: "cross-message",
          tool: "sendMessage",
          senderThreadId: root,
          receiverThreadIds: [nested],
          agentsStates: {},
          model: null,
          reasoningEffort: null,
        },
      });
      spawned = true;
    } else {
      start(p.threadId, "requested-b");
      complete(p.threadId, "requested-b");
      start(p.threadId, "newer-b");
      result = { turn: { id: "requested-b" } };
    }
  }
  if (m.method === "turn/interrupt") complete(p.threadId, p.turnId);
  send({ id: m.id, result });
});
setInterval(() => {
  if (
    account !== "a" ||
    !spawned ||
    exhausted ||
    !fs.existsSync(path.join(home, "exhaust-nested"))
  )
    return;
  exhausted = true;
  notify("error", {
    threadId: nested,
    turnId: "nested-a",
    error: {
      codexErrorInfo: "usageLimitExceeded",
      message: "synthetic child quota",
    },
    willRetry: false,
  });
}, 20);
