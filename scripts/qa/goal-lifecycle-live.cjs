// Bounded, real native Goal execution. Read user-authorized credentials from
// this chat's rollout, keep only the access token in memory, never refresh it.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "qa-output");
const built = buildSync({
  stdin: {
    contents:
      'export { Rpc } from "./src/core/rpc"; export { CliWorker } from "./src/core/cli-worker"; export { prepareThread } from "./src/core/thread"; export { parseQuotas } from "./src/core/quota"; export { redact } from "./src/core/redact";',
    loader: "ts",
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const bundled = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  require,
  bundled,
  bundled.exports,
);
const { Rpc, CliWorker, prepareThread, parseQuotas, redact } = bundled.exports;

async function authorizedAccess() {
  const source = process.env.RELAY_TEST_CREDENTIAL_ROLLOUT;
  assert(
    source,
    "Set RELAY_TEST_CREDENTIAL_ROLLOUT to the authorized chat rollout",
  );
  const records = (await fs.readFile(source, "utf8")).split("\n");
  for (const line of records.reverse()) {
    if (!line.includes("access_token") || !line.includes("做测试")) continue;
    const record = JSON.parse(line),
      p = record.payload;
    if (record.type !== "response_item" || p?.role !== "user") continue;
    const text = p.content?.map((c) => c.text || "").join("\n") || "";
    if (!text.includes("做测试")) continue;
    const start = text.indexOf("["),
      end = text.lastIndexOf("]");
    if (start < 0 || end < start) continue;
    let values;
    try {
      values = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    const value = values.find(
      (v) => v.access_token && v.account_id && v.type === "codex",
    );
    if (!value) continue;
    const claims = JSON.parse(
      Buffer.from(value.access_token.split(".")[1], "base64url"),
    );
    assert(claims.exp * 1000 > Date.now() + 120000, "Access token is expired");
    const auth = claims["https://api.openai.com/auth"];
    assert.equal(auth.chatgpt_account_id, value.account_id);
    return {
      accessToken: value.access_token,
      chatgptAccountId: value.account_id,
      chatgptPlanType: auth.chatgpt_plan_type,
    };
  }
  throw Error("No authorized credential array found in this chat");
}

(async () => {
  const scenario = process.env.RELAY_GOAL_LIVE_CASE || "lifecycle";
  assert(["lifecycle", "budget"].includes(scenario));
  const budgetCase = scenario === "budget",
    maxTurns = budgetCase ? 2 : 3;
  const auth = await authorizedAccess();
  const home = await fs.mkdtemp(path.join(output, "goal-lifecycle-live-"));
  const cli = path.join(
    root,
    "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  );
  const report = {
    home,
    scenario,
    manualTurnStartRequests: 0,
    automaticTurns: 0,
    completedTurns: 0,
    refreshTokenRequests: 0,
    toolTypes: [],
    stages: [],
    outcomes: [],
    status: "running",
  };
  let rpc,
    worker,
    threadId,
    timer,
    exceeded = false;
  const active = new Set();
  const originalOpen = Rpc.open.bind(Rpc);
  Rpc.open = async (...args) => {
    const instance = await originalOpen(...args);
    active.add(instance);
    const call = instance.call.bind(instance);
    instance.call = (method, ...rest) => {
      if (method === "turn/start") report.manualTurnStartRequests++;
      return call(method, ...rest);
    };
    instance.on("request", (m) => {
      if (/authTokens\/refresh/.test(m.method)) report.refreshTokenRequests++;
    });
    instance.on("notification", (m) => {
      if (m.params?.threadId !== threadId) return;
      if (m.method === "turn/started") {
        report.automaticTurns++;
        console.log(
          JSON.stringify({
            event: "automatic-turn",
            number: report.automaticTurns,
          }),
        );
        if (report.automaticTurns > maxTurns) {
          exceeded = true;
          void instance
            .call("turn/interrupt", { threadId, turnId: m.params.turn.id })
            .catch(() => {});
          void instance
            .call("thread/goal/set", {
              threadId,
              status: "paused",
              origin: "user",
            })
            .catch(() => {});
        }
      }
      if (m.method === "turn/completed") {
        report.completedTurns++;
        report.stages.push({ event: "terminal", status: m.params.turn.status });
      }
      if (m.method === "item/completed") {
        const item = m.params.item;
        if (item.type === "agentMessage")
          report.stages.push({
            event: "answer",
            text: redact(item.text).slice(0, 200),
          });
        else if (!report.toolTypes.includes(item.type))
          report.toolTypes.push(item.type);
      }
    });
    return instance;
  };
  const open = async () => {
    rpc = await Rpc.open(cli, home);
    rpc.on("request", (m) =>
      rpc.reject(
        m.id,
        "No refresh token or user interaction in this bounded test",
      ),
    );
    await rpc.call("account/login/start", {
      type: "chatgptAuthTokens",
      ...auth,
    });
    return rpc;
  };
  const close = async () => {
    if (rpc) {
      await rpc.close();
      active.delete(rpc);
      rpc = undefined;
    }
  };
  try {
    await open();
    report.before = parseQuotas(
      await rpc.call("account/rateLimits/read"),
    ).codex;
    assert(report.before && !report.before.reached);
    for (const window of [
      report.before.primary,
      report.before.secondary,
    ].filter(Boolean))
      assert(
        window.usedPercent <= 95,
        "Require 5% remaining in every reported window",
      );
    const models = (await rpc.call("model/list", { limit: 100 })).data.filter(
      (m) => !m.hidden,
    );
    const model =
      models.find((m) => /luna|mini/i.test(m.model)) ||
      models.find((m) => m.isDefault) ||
      models[0];
    assert(model);
    const effort = [
      "none",
      "minimal",
      "low",
      model.defaultReasoningEffort,
    ].find((e) =>
      model.supportedReasoningEfforts.some((s) => s.reasoningEffort === e),
    );
    report.model = model.model;
    report.effort = effort;
    const base = {
      cwd: home,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: model.model,
      config: {
        "features.goals": false,
        "features.multi_agent": false,
        "features.shell_tool": false,
        "features.browser_use": false,
        "features.computer_use": false,
        "features.image_generation": false,
        web_search: "disabled",
      },
    };
    threadId = (await prepareThread(rpc, undefined, base)).thread.id;
    report.threadId = threadId;
    await close();
    await open();
    const objective = budgetCase
      ? "This is a two-turn Goal budget acceptance test. Do not use shell, files, network, images, or subagents. Do not change the goal budget or status in the first turn. First turn: if no prior answer contains GOAL_BUDGET_ONE, answer exactly GOAL_BUDGET_ONE, leave this Goal active and end the turn. The user will increase the budget and resume this same Goal. Second turn: if GOAL_BUDGET_ONE exists, use the native goal update tool to mark this Goal complete, then answer exactly GOAL_BUDGET_TWO. Never combine stages or create a new goal."
      : "This is a three-turn Goal lifecycle acceptance test, not an open-ended task. Do not use shell, files, network, images, or subagents. Use only the native goal tools when instructed. Turn 1: if no prior answer contains GOAL_STAGE_ONE, answer exactly GOAL_STAGE_ONE, keep this Goal active, end the turn. Turn 2: if GOAL_STAGE_ONE exists but GOAL_STAGE_TWO does not, use the native goal update tool to pause this Goal, then answer exactly GOAL_STAGE_TWO, end the turn. Turn 3 after the user resumes the paused Goal: if GOAL_STAGE_TWO exists, mark this Goal complete using the native goal update tool, answer exactly GOAL_STAGE_THREE, end the turn. Never combine stages in one turn. Do not ask questions or create a new goal.";
    await rpc.call("thread/goal/set", {
      threadId,
      objective,
      tokenBudget: budgetCase ? 1 : 45000,
      status: "paused",
      origin: "user",
    });
    report.initialGoal = (await rpc.call("thread/goal/get", { threadId })).goal;
    await rpc.call("thread/goal/set", {
      threadId,
      status: "active",
      origin: "user",
    });
    await close();
    const job = {
      id: "bounded-goal-live",
      title: "Goal lifecycle acceptance",
      prompt: "",
      cwd: home,
      mode: "cli",
      threadId,
      model: model.model,
      effort,
      serviceTier: "default",
      bucket: "codex",
      state: "running",
      rotations: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      approvalPolicy: "never",
      sandbox: "readOnly",
      multiAgent: false,
      goalStartRequested: true,
    };
    const run = async () => {
      worker = new CliWorker({
        job,
        home,
        cli,
        resumePrompt: "",
        shouldStart: () => !exceeded,
        checkpoint: async (id, turnId) => {
          assert.equal(id, threadId);
          if (turnId) {
            job.turnId = turnId;
            job.goalStartRequested = false;
          }
        },
        refresh: async () => {
          throw Error("Token refresh is disabled in this acceptance test");
        },
      });
      worker.on("approval", (request) =>
        worker.respond(request.id, { decision: "decline" }),
      );
      worker.on("goal", (goal) => {
        if (goal)
          report.stages.push({
            event: "goal",
            status: goal.status,
            tokensUsed: goal.tokensUsed,
          });
      });
      await worker.start(auth);
      const result = await worker.done;
      report.outcomes.push({
        kind: result.kind,
        ...(result.error ? { error: redact(String(result.error)) } : {}),
      });
      await worker.close();
      worker = undefined;
      return result;
    };
    timer = setTimeout(() => {
      exceeded = true;
      for (const instance of active)
        void instance
          .call("thread/goal/set", {
            threadId,
            status: "paused",
            origin: "user",
          })
          .catch(() => {});
      void worker
        ?.stop()
        .catch(() => {})
        .finally(() => worker?.close());
    }, 90000);
    assert.equal((await run()).kind, "goalStopped");
    assert.equal(
      report.automaticTurns,
      budgetCase ? 1 : 2,
      "Stop at the native Goal boundary without extra automatic rounds",
    );
    await open();
    report.pausedGoal = (await rpc.call("thread/goal/get", { threadId })).goal;
    assert.equal(
      report.pausedGoal.status,
      budgetCase ? "budgetLimited" : "paused",
    );
    assert(report.pausedGoal.tokensUsed > 0);
    assert.equal(report.pausedGoal.objective, objective);
    if (budgetCase) {
      const updated = await rpc.call("thread/goal/set", {
        threadId,
        tokenBudget: report.pausedGoal.tokensUsed + 16000,
        origin: "user",
      });
      assert.equal(updated.goal.tokensUsed, report.pausedGoal.tokensUsed);
      assert.equal(
        updated.goal.status,
        "budgetLimited",
        "Changing budget must not start the Goal",
      );
      report.adjustedGoal = updated.goal;
    }
    await rpc.call("thread/goal/set", {
      threadId,
      status: "active",
      origin: "user",
    });
    await close();
    job.goalStartRequested = true;
    assert.equal((await run()).kind, "completed");
    await open();
    report.finalGoal = (await rpc.call("thread/goal/get", { threadId })).goal;
    report.after = parseQuotas(await rpc.call("account/rateLimits/read")).codex;
    assert.equal(report.finalGoal.status, "complete");
    assert.equal(report.finalGoal.objective, objective);
    assert.equal(report.finalGoal.createdAt, report.initialGoal.createdAt);
    assert(report.finalGoal.tokensUsed >= report.pausedGoal.tokensUsed);
    assert.equal(report.automaticTurns, maxTurns);
    assert.equal(report.completedTurns, maxTurns);
    assert.equal(report.manualTurnStartRequests, 0);
    assert.equal(report.refreshTokenRequests, 0);
    assert.equal(exceeded, false);
    const answers = report.stages
      .filter((s) => s.event === "answer")
      .map((s) => s.text);
    for (const marker of budgetCase
      ? ["GOAL_BUDGET_ONE", "GOAL_BUDGET_TWO"]
      : ["GOAL_STAGE_ONE", "GOAL_STAGE_TWO", "GOAL_STAGE_THREE"])
      assert(
        answers.some((a) => a.includes(marker)),
        marker,
      );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = redact(error.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    for (const instance of active) {
      if (threadId && report.status !== "passed")
        await instance
          .call("thread/goal/set", {
            threadId,
            status: "paused",
            origin: "user",
          })
          .catch(() => {});
      await instance.close().catch(() => {});
    }
    // External auth must remain ephemeral. Persist only a non-secret result.
    report.authFileWritten = await fs.stat(path.join(home, "auth.json")).then(
      () => true,
      () => false,
    );
    if (report.authFileWritten) {
      report.status = "failed";
      report.error = "Unexpected persisted auth file";
      process.exitCode = 1;
    }
    await fs.writeFile(
      path.join(output, `goal-${scenario}-live-report.json`),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        status: report.status,
        automaticTurns: report.automaticTurns,
        completedTurns: report.completedTurns,
        manualTurnStartRequests: report.manualTurnStartRequests,
        error: report.error,
      }),
    );
  }
})().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
