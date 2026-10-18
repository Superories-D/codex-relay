// Local deterministic protocol peer. No network, credentials or model calls.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const home = process.env.RELAY_TEST_HOME;
const saved = path.join(home, "synthetic-thread.json");
const parallel = fs.existsSync(path.join(home, "parallel-fixture.json"));
let thread = parallel ? `synthetic-${path.basename(home)}` : "synthetic-thread",
  account = "";
let runningTurn;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method, params) => send({ method, params });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  const p = m.params ?? {};
  try {
    if (m.method === "account/login/start") account = p.chatgptAccountId;
    if (m.method === "windowsSandbox/readiness") result = { status: "ready" };
    if (m.method === "account/rateLimits/read")
      result = {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 10,
            windowDurationMins: 300,
            resetsAt: Math.floor(Date.now() / 1000) + 3600,
          },
          secondary: null,
        },
      };
    if (m.method === "thread/start" || m.method === "thread/resume") {
      if (m.method === "thread/resume" && p.path) {
        const meta = JSON.parse(fs.readFileSync(p.path, "utf8").split("\n")[0]);
        if (meta.type !== "session_meta" || meta.payload.id !== p.threadId)
          throw Error("Imported history mismatch");
        thread = meta.payload.id;
        fs.writeFileSync(saved, JSON.stringify({ id: thread }));
      } else if (m.method === "thread/resume" && fs.existsSync(saved))
        thread = JSON.parse(fs.readFileSync(saved, "utf8")).id;
      if (
        !["workspace-write", "read-only", "danger-full-access"].includes(
          p.sandbox,
        )
      )
        throw Error("Wrong sandbox wire value");
      if (m.method === "thread/resume" && !fs.existsSync(saved))
        throw Error("Thread not materialized");
      result = { thread: { id: thread }, model: "synthetic-model" };
    }
    if (m.method === "thread/archive")
      fs.writeFileSync(saved, JSON.stringify({ id: thread }));
    if (m.method === "turn/start") {
      if (!Array.isArray(p.input[0].text_elements))
        throw Error("Missing text_elements");
      runningTurn = "turn-" + account;
      result = { turn: { id: runningTurn } };
      fs.appendFileSync(
        path.join(home, "synthetic-journal.jsonl"),
        JSON.stringify({
          account,
          threadId: p.threadId,
          input: p.input[0].text,
          pid: process.pid,
        }) + "\n",
      );
      notify("turn/started", { threadId: thread, turn: { id: runningTurn } });
      const complete = () => {
        if (account === "a")
          notify("error", {
            threadId: thread,
            turnId: runningTurn,
            error: {
              codexErrorInfo: "usageLimitExceeded",
              message: "Quota stopped the task",
            },
            willRetry: false,
          });
        else
          notify("item/completed", {
            threadId: thread,
            turnId: runningTurn,
            item: {
              type: "agentMessage",
              phase: "final_answer",
              text: "Original task completed.",
            },
          });
        notify("turn/completed", {
          threadId: thread,
          turn: { id: runningTurn, status: "completed", error: null },
        });
      };
      if (parallel) {
        const gate = setInterval(() => {
          if (!fs.existsSync(path.join(home, "complete-turn"))) return;
          clearInterval(gate);
          complete();
        }, 20);
      } else setTimeout(complete, 5);
    }
    if (m.method === "turn/interrupt")
      notify("turn/completed", {
        threadId: thread,
        turn: { id: runningTurn, status: "interrupted" },
      });
    send({ id: m.id, result });
  } catch (e) {
    send({ id: m.id, error: { code: -32602, message: e.message } });
  }
});
