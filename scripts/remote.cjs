#!/usr/bin/env node
// HTTP controller. No credentials in URLs or command-line token arguments.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { RemoteStore, endpoint, privateRead } = require("./remote-store.cjs");
const { parseArgs } = require("node:util");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    profile: { type: "string" },
    host: { type: "string" },
    "local-port": { type: "string" },
    "remote-port": { type: "string" },
    "ssh-port": { type: "string" },
    "token-file": { type: "string" },
    id: { type: "string" },
    "request-id": { type: "string" },
    cwd: { type: "string" },
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    model: { type: "string", default: "" },
    effort: { type: "string", default: "" },
    title: { type: "string" },
    file: { type: "string" },
    detach: { type: "boolean" },
    "no-reconnect": { type: "boolean" },
  },
});
const operation = positionals[0] || "help";
if (operation === "help") {
  console.log(`Codex Relay remote CLI (Node.js 24)
 --url http://127.0.0.1:7899 --token-file /private/http-token
 init (create a private client home)
 profile save NAME --url ORIGIN --token-file FILE [--cwd SERVER_PATH] [--host user@server]
 profile list|show|remove [NAME] · --profile NAME selects a saved connection
 requests | recover --request-id UUID
 health | doctor | status | watch [--id UUID] | report --id UUID | approvals
 run --cwd /server/project --prompt-file task.txt [--request-id UUID] [--detach]
 send --id UUID --prompt-file followup.txt [--request-id UUID]
 pause|resume|cancel --id UUID
 workflow --file workflow.json [--request-id UUID]
 respond --file response.json
 command --file command.json
Durable mutations save their exact payload and server identity before sending. Use requests/recover after an interrupted client. Other mutations are never replayed.
Watch reconnects automatically; Ctrl+C disconnects the viewer without stopping server tasks.
Use SSH port forwarding for HTTP. Non-loopback endpoints require HTTPS.`);
  process.exit(0);
}
const controller = new AbortController();
process.on("SIGINT", () => {
  controller.abort();
  process.exitCode = 130;
});
process.on("SIGTERM", () => {
  controller.abort();
  process.exitCode = 143;
});
const sleep = (ms) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    controller.signal.addEventListener("abort", done, { once: true });
  });
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
let base, token, localStore;
const store = () => (localStore ||= new RemoteStore());
const durableNames = new Set([
  "job.submit",
  "chat.submit",
  "workflow.add",
  "task.steer",
  "task.model",
  "goal.update",
  "workflow.retry",
  "workflow.control",
  "schedule.create",
  "schedule.save",
  "schedule.run",
  "schedule.remove",
]);
async function api(route, body) {
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
    redirect: "error",
  });
  const data = await response.json();
  if (!response.ok)
    throw new HttpError(
      response.status,
      data.error || `HTTP ${response.status}`,
    );
  return body ? data.result : data;
}
async function command(name, args, retry = false) {
  let record;
  if (durableNames.has(name)) {
    args = { ...args, requestId: args.requestId || crypto.randomUUID() };
    const meta = await api("/api/meta");
    record = store().begin(base, meta.serverId, name, args);
    retry = true;
    if (record.state === "confirmed") return record.result;
    if (record.state === "rejected") throw Error(record.error);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await api("/api/command", { name, args });
      if (record) store().finish(record, result);
      return result;
    } catch (error) {
      // A gateway error can be returned after the server committed the request.
      // Preserve the original payload and ID; 4xx still stop this attempt so
      // validation and authentication errors do not create an automatic loop.
      if (controller.signal.aborted) throw error;
      if (
        !retry ||
        attempt >= 4 ||
        (error instanceof HttpError &&
          error.status < 500 &&
          error.status !== 429)
      )
        throw error;
      console.error(
        `Connection uncertain; retrying request ${args.requestId} without creating a new ID`,
      );
      await sleep(Math.min(8000, 1000 * 2 ** attempt));
    }
  }
}
function summary(snap, id) {
  return {
    event: "status",
    tasks: snap.jobs
      .filter((j) => !id || j.id === id)
      .map((j) => ({
        id: j.id,
        title: j.title,
        state: j.state,
        recovery: j.autoRecovery,
        queuedMessages: j.queuedMessages?.length || 0,
        pendingApprovals: snap.approvals.filter((a) => a.jobId === j.id).length,
      })),
  };
}
async function watch(id) {
  let attempt = 0,
    last = "";
  while (!controller.signal.aborted) {
    try {
      const response = await fetch(base + "/api/events", {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok)
        throw new HttpError(
          response.status,
          `Status stream: HTTP ${response.status}`,
        );
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 32 * 1024 * 1024)
            throw Error("Status frame too large");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const snap = JSON.parse(line.slice(6));
            attempt = 0;
            const output = JSON.stringify(summary(snap, id));
            if (output !== last) {
              console.log(output);
              last = output;
            }
            const job = snap.jobs.find((j) => j.id === id);
            if (
              job &&
              !job.autoRecovery &&
              ["completed", "paused", "cancelled", "needs_attention"].includes(
                job.state,
              )
            ) {
              process.exitCode = job.state === "completed" ? 0 : 2;
              return;
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof HttpError && [401, 403].includes(error.status))
        throw error;
      if (values["no-reconnect"]) throw error;
    }
    if (values["no-reconnect"])
      throw Error("Connection closed; task status is unknown");
    if (controller.signal.aborted) return;
    console.error(
      "Status connection lost; resubscribing without replaying commands",
    );
    await sleep(Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)));
  }
}
async function main() {
  if (operation === "init") {
    console.log(
      JSON.stringify({
        directory: store().root,
        credentials: path.join(store().root, "credentials"),
      }),
    );
    return;
  }
  if (operation === "profile") {
    const action = positionals[1],
      name = positionals[2];
    let result;
    if (action === "list") result = store().profiles();
    else if (action === "show") result = { name, ...store().profile(name) };
    else if (action === "remove") result = store().removeProfile(name);
    else if (action === "save") {
      if (!values["token-file"])
        throw Error("--token-file is required to save a profile");
      let tunnel;
      if (values.host) {
        const { tunnelArguments } = require("./remote-tunnel.cjs");
        tunnelArguments(values);
        tunnel = {
          host: values.host,
          ...Object.fromEntries(
            ["local-port", "remote-port", "ssh-port"]
              .filter((k) => values[k])
              .map((k) => [k, values[k]]),
          ),
        };
      }
      result = store().saveProfile(name, {
        url: values.url || "http://127.0.0.1:7899",
        tokenFile: values["token-file"],
        cwd: values.cwd,
        tunnel,
      });
    } else throw Error("Use profile save|list|show|remove");
    console.log(JSON.stringify(result));
    return;
  }
  if (operation === "requests") {
    console.log(JSON.stringify(store().requests()));
    return;
  }
  if (values.profile) {
    const profile = store().profile(values.profile);
    values.url ??= profile.url;
    values["token-file"] ??= profile.tokenFile;
    values.cwd ??= profile.cwd;
  }
  base = endpoint(values.url || "http://127.0.0.1:7899");
  if (!values["token-file"])
    throw Error("--token-file or --profile is required");
  token = privateRead(path.resolve(values["token-file"]), 1024).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Invalid HTTP token file");
  if (operation === "recover") {
    const record = store().read(values["request-id"]);
    if (
      !durableNames.has(record.name) ||
      record.args?.requestId !== record.requestId
    )
      throw Error("Stored command is not safely recoverable");
    if (record.url !== base)
      throw Error("Recovery endpoint differs from the recorded endpoint");
    const meta = await api("/api/meta");
    if (meta.serverId !== record.serverId)
      throw Error(
        "Recovery server installation differs from the recorded server",
      );
    if (record.state === "rejected") store().reopen(record);
    console.log(JSON.stringify(await command(record.name, record.args, true)));
    return;
  }
  const text = () =>
    values["prompt-file"]
      ? fs.readFileSync(path.resolve(values["prompt-file"]), "utf8")
      : values.prompt || "";
  const json = () =>
    JSON.parse(fs.readFileSync(path.resolve(values.file), "utf8"));
  let result;
  if (operation === "status") {
    console.log(JSON.stringify(summary(await api("/api/snapshot"))));
    return;
  }
  if (operation === "watch") return watch(values.id);
  if (operation === "run") {
    if (!values.cwd) throw Error("--cwd must name a server-side workspace");
    const prompt = text(),
      requestId = values["request-id"] || crypto.randomUUID();
    console.error(JSON.stringify({ requestId }));
    result = await command(
      "job.submit",
      {
        requestId,
        input: {
          title: values.title || prompt.trim().split("\n")[0].slice(0, 120),
          prompt,
          cwd: values.cwd,
          mode: "cli",
          model: values.model,
          effort: values.effort,
          bucket: "codex",
          approvalPolicy: "on-request",
          sandbox: "workspaceWrite",
          interactive: true,
        },
      },
      true,
    );
    console.log(JSON.stringify({ event: "created", id: result.id, requestId }));
    if (!values.detach) return watch(result.id);
    return;
  }
  if (operation === "send") {
    const requestId = values["request-id"] || crypto.randomUUID();
    console.error(JSON.stringify({ requestId }));
    await command(
      "chat.submit",
      {
        requestId,
        input: {
          id: values.id,
          text: text(),
          attachments: [],
          action: "queue",
        },
      },
      true,
    );
    console.log(JSON.stringify({ ok: true, requestId }));
    return;
  }
  if (operation === "workflow") {
    const input = json();
    input.requestId =
      values["request-id"] || input.requestId || crypto.randomUUID();
    console.error(JSON.stringify({ requestId: input.requestId }));
    result = await command("workflow.add", input, true);
  } else if (["pause", "resume", "cancel"].includes(operation))
    result = await command("job.control", { id: values.id, action: operation });
  else if (operation === "health") result = await command("health");
  else if (operation === "doctor") result = await command("environment.check");
  else if (operation === "approvals") result = await command("approval.list");
  else if (operation === "respond")
    result = await command("approval.respond", json());
  else if (operation === "report")
    result = await command("job.report", values.id);
  else if (operation === "command") {
    const input = json();
    result = await command(input.name, input.args);
  } else throw Error("Unknown command; use help");
  console.log(JSON.stringify(result === undefined ? { ok: true } : result));
}
main().catch((error) => {
  if (!controller.signal.aborted) {
    console.error(error.message);
    console.error(
      "If a mutation lost its response, inspect server state before sending a different request.",
    );
    process.exitCode = 1;
  }
});
