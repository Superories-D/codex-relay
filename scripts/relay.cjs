#!/usr/bin/env node
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const argv = process.argv.slice(2);
const operation = argv[0] || "help";
const options = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    const key = argv[i].slice(2);
    options[key] =
      argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
}
if (operation === "help") {
  console.log(`Codex Relay CLI — keep the desktop app running first.
  node scripts/relay.cjs run --cwd C:\\Project --prompt "Finish the task" [--model MODEL] [--effort high] [--mode cli|desktop]
  node scripts/relay.cjs run --cwd C:\\Project --prompt-file task.txt
  node scripts/relay.cjs run --cwd C:\\Project --prompt "Finish the task" --completion-marker "[TASK_DONE]" --completion-retries 3
  node scripts/relay.cjs report --id JOB_ID
  node scripts/relay.cjs status [--json]
  node scripts/relay.cjs watch [--id JOB_ID] [--json] [--no-reconnect]
  node scripts/relay.cjs pause|resume|cancel --id JOB_ID
  node scripts/relay.cjs sessions [--home C:\\Users\\you\\.codex]
  node scripts/relay.cjs attach --session THREAD_UUID [--home PATH] [--when quota|now] [--mode cli|desktop] [--allow-stop]
  node scripts/relay.cjs handoff --id JOB_ID
  --allow-stop authorizes ending the identified Codex instance and its children at handoff, including other chats in that desktop instance.
  Watch reconnects automatically after a lost connection; it never replays task commands.
  Ctrl+C disconnects the viewer; the task continues in the desktop app.
  --ipc-port PORT uses authenticated loopback TCP instead of a local socket.
  Server commands: accounts | import-account --file auth.json [--label NAME] | approvals | respond --file response.json
  --data-dir PATH overrides the default app data location.`);
  process.exit(0);
}
const base =
  process.platform === "win32"
    ? process.env.APPDATA
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const root = options["data-dir"] || path.join(base, "Codex Relay");
const key = crypto
  .createHash("sha256")
  .update(root.toLowerCase())
  .digest("hex")
  .slice(0, 20);
const endpoint =
  process.platform === "win32"
    ? `\\\\.\\pipe\\codex-relay-${key}`
    : path.join(root, "relay.sock");
let token, socket, reconnectTimer;
let reconnectAttempt = 0;
let expectedClose = false;
const canReconnect = () =>
  options["no-reconnect"] !== true && (watching || operation === "watch");
const disconnect = () => {
  expectedClose = true;
  clearTimeout(reconnectTimer);
  socket?.end();
};
const lostConnection = () => {
  if (expectedClose) return;
  if (!canReconnect()) {
    console.error("连接中断，任务状态未知；请重新连接查看，不能视为任务完成。");
    process.exitCode = 1;
    return;
  }
  const delay = Math.min(30000, 2000 * 2 ** Math.min(reconnectAttempt++, 4));
  console.error(
    `连接中断，${delay / 1000} 秒后自动重连；只订阅状态，不重发任务。`,
  );
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
};
function connect() {
  if (expectedClose) return;
  try {
    token = fs.readFileSync(path.join(root, "ipc-token"), "utf8");
  } catch {
    lostConnection();
    return;
  }
  buffer = "";
  const current = net.createConnection(options["ipc-port"] !== undefined ? {host:"127.0.0.1",port:Number(options["ipc-port"])} : endpoint);
  socket = current;
  current.setEncoding("utf8");
  current.on("connect", onConnect);
  current.on("data", onData);
  current.on("close", () => {
    if (socket === current) lostConnection();
  });
  current.on("error", (error) => {
    console.error(`连接失败：${error.message}。请保持桌面程序运行。`);
    if (!canReconnect()) process.exitCode = 1;
  });
}
let buffer = "";
let watching = false;
let jobId = options.id;
let lastLogs = new Map();
let shownApprovals = new Set();
const send = (id, command, args) =>
  socket.write(JSON.stringify({ id, token, command, args }) + "\n");
function onConnect() {
  if (watching) {
    send(2, "watch");
    return;
  }
  if (["sessions", "attach"].includes(operation)) {
    if (operation === "attach" && typeof options.session !== "string") {
      console.error(
        "attach requires --session THREAD_UUID; use sessions to list saved sessions.",
      );
      disconnect();
      process.exitCode = 1;
      return;
    }
    send(10, "session.scan", {
      ...(options.home ? { home: path.resolve(options.home) } : {}),
      ...(options.session ? { threadId: options.session } : {}),
    });
  } else if (operation === "handoff") send(1, "session.handoff", options.id);
  else if (operation === "run") {
    let prompt = options.prompt || "";
    try {
      if (options["prompt-file"])
        prompt = fs.readFileSync(path.resolve(options["prompt-file"]), "utf8");
    } catch (e) {
      console.error(e.message);
      disconnect();
      process.exitCode = 1;
      return;
    }
    send(1, "job.add", {
      title: options.title || prompt.slice(0, 60) || "CLI task",
      prompt,
      cwd: path.resolve(options.cwd || process.cwd()),
      mode: options.mode || "cli",
      model: options.model || "",
      effort: options.effort || "",
      bucket: options.bucket || "codex",
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
      ...(options["completion-marker"]
        ? { completionMarker: options["completion-marker"] }
        : {}),
      ...(options["completion-retries"] !== undefined
        ? { maxCompletionRetries: Number(options["completion-retries"]) }
        : {}),
    });
  } else if (operation === "status") send(1, "snapshot");
  else if (operation === "accounts") send(1,"account.list");
  else if (operation === "approvals") send(1,"approval.list");
  else if (operation === "import-account") {
    try {send(1,"account.importText",{text:fs.readFileSync(path.resolve(options.file),"utf8"),...(options.label ? {label:options.label} : {})});}
    catch(e){console.error(e.message);disconnect();process.exitCode=1;}
  }
  else if (operation === "respond") {
    try {send(1,"approval.respond",JSON.parse(fs.readFileSync(path.resolve(options.file),"utf8")));}
    catch(e){console.error(e.message);disconnect();process.exitCode=1;}
  }
  else if (operation === "report") send(1, "job.report", jobId);
  else if (operation === "watch") {
    watching = true;
    send(2, "watch");
  } else if (["pause", "resume", "cancel"].includes(operation))
    send(1, "job.control", { id: jobId, action: operation });
  else {
    console.error("Unknown command; use help");
    disconnect();
    process.exitCode = 1;
  }
}
let lastStatus = "",
  lastRecovery = "";
function taskStatus(job, approvals) {
  return {
    id: job.id,
    title: job.title,
    state: job.state,
    priority: job.priority || "normal",
    rotations: job.rotations,
    recovering: !!job.autoRecovery,
    recovery: job.autoRecovery,
    waitingFor: job.waitingFor,
    nextWakeAt: job.nextWakeAt,
    queuedMessages: job.queuedMessages?.length || 0,
    pendingApprovals: approvals.filter((a) => a.jobId === job.id).length,
  };
}
function show(snapshot) {
  if (!snapshot?.jobs) return;
  reconnectAttempt = 0;
  const statuses = snapshot.jobs
    .filter((j) => !jobId || j.id === jobId)
    .map((j) => taskStatus(j, snapshot.approvals || []));
  if (options.json === true) {
    const value = JSON.stringify({ event: "status", tasks: statuses });
    if (operation === "status" || value !== lastStatus) console.log(value);
    lastStatus = value;
    if (operation === "status") {
      disconnect();
      return;
    }
  }
  if (operation === "status") {
    console.table(
      snapshot.jobs.map((j) => ({
        id: j.id,
        title: j.title,
        state: j.state,
        rotations: j.rotations,
      })),
    );
    disconnect();
    return;
  }
  for (const log of (options.json ? [] : snapshot.logs || []).filter(
    (l) => !jobId || l.jobId === jobId,
  )) {
    const before = lastLogs.get(log.id) || "";
    if (before !== log.message) {
      const delta = log.message.startsWith(before)
        ? log.message.slice(before.length)
        : log.message;
      process.stdout.write(delta + (log.level === "output" ? "" : "\n"));
      lastLogs.set(log.id, log.message);
    }
  }
  if (lastLogs.size > 2000) lastLogs = new Map([...lastLogs].slice(-1000));
  const j = snapshot.jobs.find((j) => j.id === jobId);
  for (const a of (snapshot.approvals || []).filter((a) => a.jobId === jobId)) {
    const key = a.jobId + ":" + a.id;
    if (!shownApprovals.has(key)) {
      shownApprovals.add(key);
      process.stderr.write("\n需要审批：请在 Codex Relay 窗口中处理。\n");
    }
  }
  if (j?.autoRecovery && options.json !== true) {
    const signature = JSON.stringify(j.autoRecovery);
    if (signature !== lastRecovery)
      console.error(
        `[自动恢复 #${j.autoRecovery.attempt}] ${j.stopIntent ? "正在确认停止" : "无需点击继续"}`,
      );
    lastRecovery = signature;
  }
  if (
    j &&
    !j.autoRecovery &&
    ["completed", "cancelled", "needs_attention", "paused"].includes(j.state)
  ) {
    if (options.json !== true)
      console.log(`\n[${j.state}] ${j.lastError || ""}`);
    disconnect();
    process.exitCode = j.state === "completed" ? 0 : 2;
  }
}
function onData(data) {
  buffer += data;
  if (buffer.length > 32 * 1024 * 1024) {
    socket.destroy(new Error("Frame too large"));
    return;
  }
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.error) {
      console.error(m.error);
      disconnect();
      process.exitCode = 1;
      return;
    }
    if (m.id === 10) {
      for (const warning of m.result.warnings ?? []) console.error(warning);
      if (operation === "sessions") {
        console.table(
          m.result.candidates.map((c) => ({
            session: c.threadId,
            title: c.title,
            state: c.status,
            cwd: c.cwd,
            issue: c.issue || "",
          })),
        );
        disconnect();
      } else {
        const found = m.result.candidates.find(
          (c) => c.threadId === options.session,
        );
        if (!found) {
          console.error("Session not found");
          disconnect();
          process.exitCode = 1;
        } else send(11, "session.inspect", found.id);
      }
    } else if (m.id === 11) {
      const report = m.result;
      console.table(
        report.processes.map((p) => ({
          pid: p.pid,
          executable: p.executable,
          title: p.title,
        })),
      );
      if (
        !report.canHandoff ||
        (report.processes.length && options["allow-stop"] !== true)
      ) {
        console.error(
          report.issue ||
            "Review the process scope above, then add --allow-stop to authorize handoff. The desktop instance's other chats will also stop.",
        );
        disconnect();
        process.exitCode = 2;
      } else
        send(12, "session.attach", {
          id: report.candidate.id,
          mode: options.mode || "cli",
          strategy: options.when || "quota",
          allowStop: options["allow-stop"] === true,
        });
    } else if (m.id === 12) {
      jobId = m.result.id;
      (options.json ? console.error : console.log)(`Attached task ${jobId}`);
      watching = true;
      send(2, "watch");
    } else if (m.event === "snapshot" || m.id === 2) show(m.data || m.result);
    else if (m.id === 1) {
      if (operation === "run") {
        jobId = m.result.id;
        (options.json ? console.error : console.log)(`Task ${jobId}`);
        watching = true;
        send(2, "watch");
      } else if (operation === "status") show(m.result);
      else if (["report","accounts","approvals","import-account"].includes(operation)) {
        console.log(JSON.stringify(m.result, null, 2));
        disconnect();
      } else {
        console.log("OK");
        disconnect();
      }
    }
  }
}
process.on("SIGINT", () => {
  disconnect();
  process.exit(130);
});

process.on("SIGTERM", () => {
  disconnect();
  process.exit(143);
});
connect();
