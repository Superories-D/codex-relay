// Actual CLI admission/configuration behavior with an explicitly unauthenticated
// isolated home. Interrupt the automatic Goal turn. No paid inference is allowed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
const built = buildSync({
  stdin: {
    contents:
      'export { Rpc } from "./src/core/rpc"; export { prepareThread } from "./src/core/thread";',
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
const { Rpc, prepareThread } = bundled.exports;
(async () => {
  const home = await fs.mkdtemp(path.join(output, "goal-admission-")),
    cli = path.join(
      root,
      "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    );
  let rpc, threadId, lastTurn, interrupted;
  const report = {
    home,
    authenticatedAccount: false,
    manualTurnStartRequests: 0,
    automaticTurns: 0,
    goalTokensUsed: 0,
  };
  const open = async () => {
    rpc = await Rpc.open(cli, home);
    rpc.on("request", (m) =>
      rpc.reject(m.id, "Unauthenticated configuration probe only"),
    );
    const call = rpc.call.bind(rpc);
    rpc.call = (method, ...args) => {
      if (method === "turn/start") report.manualTurnStartRequests++;
      return call(method, ...args);
    };
    return rpc;
  };
  try {
    await open();
    const identity = await rpc.call("account/read", { refreshToken: false });
    assert.equal(
      identity.account,
      null,
      "Never run this probe with a signed-in identity",
    );
    const models = (await rpc.call("model/list", { limit: 100 })).data;
    const model =
      models.find((m) => !m.hidden && m.isDefault) ||
      models.find((m) => !m.hidden);
    assert(model);
    const effort = [
      "none",
      "minimal",
      "low",
      model.defaultReasoningEffort,
    ].find((e) =>
      model.supportedReasoningEfforts.some((s) => s.reasoningEffort === e),
    );
    const initial = await prepareThread(rpc, undefined, {
      cwd: home,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: model.model,
      config: { "features.goals": false },
    });
    threadId = initial.thread.id;
    await rpc.close();
    await open();
    await rpc.call("thread/goal/set", {
      threadId,
      objective:
        "Unauthenticated admission probe only. Do not read files or use tools.",
      tokenBudget: 1,
      status: "active",
      origin: "user",
    });
    let resolveStarted, resolveEnded;
    const started = new Promise((r) => {
        resolveStarted = r;
      }),
      ended = new Promise((r) => {
        resolveEnded = r;
      });
    rpc.on("notification", (m) => {
      if (m.params?.threadId !== threadId) return;
      if (m.method === "turn/started") {
        report.automaticTurns++;
        lastTurn = m.params.turn.id;
        resolveStarted();
        interrupted = rpc
          .call("turn/interrupt", { threadId, turnId: lastTurn })
          .catch(() => {});
      }
      if (m.method === "turn/completed") resolveEnded();
    });
    const resumed = await rpc.call("thread/resume", {
      threadId,
      cwd: home,
      model: model.model,
      serviceTier: "default",
      sandbox: "read-only",
      approvalPolicy: "never",
      config: { "features.goals": true, model_reasoning_effort: effort },
    });
    assert.equal(resumed.model, model.model);
    assert.equal(resumed.reasoningEffort, effort);
    report.model = resumed.model;
    report.effort = resumed.reasoningEffort;
    report.serviceTier = resumed.serviceTier;
    let timer;
    try {
      await Promise.race([
        Promise.all([started, ended]),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Automatic admission was not observed")),
            12000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await interrupted;
    await rpc.call("thread/goal/set", {
      threadId,
      status: "paused",
      origin: "user",
    });
    report.goalTokensUsed = (
      await rpc.call("thread/goal/get", { threadId })
    ).goal.tokensUsed;
    assert.equal(report.manualTurnStartRequests, 0);
    assert.equal(report.automaticTurns, 1);
    assert.equal(report.goalTokensUsed, 0);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    throw error;
  } finally {
    await rpc?.close();
    await fs.writeFile(
      path.join(output, "goal-admission-native-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
