// Actual unauthenticated CLI admission, with model submissions blocked locally.
// Quota is simulated only to reach production worker admission. Delay the resume
// reply until the actual native Goal turn starts, exposing a valid event race.
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
const built = buildSync({
  stdin: {
    contents:
      'export { Rpc } from "./src/core/rpc"; export { CliWorker } from "./src/core/cli-worker"; export { prepareThread } from "./src/core/thread";',
    loader: "ts",
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const moduleBox = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  require,
  moduleBox,
  moduleBox.exports,
);
const { Rpc, CliWorker, prepareThread } = moduleBox.exports;
(async () => {
  const home = await fs.mkdtemp(path.join(output, "goal-message-native-")),
    cli = path.join(
      root,
      "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    );
  const baseline = process.env.RELAY_EXPECT_GOAL_MESSAGE_FAILURE === "1",
    report = {
      baseline,
      home,
      authenticatedAccount: false,
      simulatedQuota: true,
      delayedResumeReply: true,
      inferenceRequests: 0,
      automaticTurns: 0,
      submissions: [],
      checkpoints: [],
    };
  let rpc, worker, threadId, job, timer;
  try {
    rpc = await Rpc.open(cli, home);
    assert.equal(
      (await rpc.call("account/read", { refreshToken: false })).account,
      null,
    );
    const models = (await rpc.call("model/list", { limit: 100 })).data,
      model =
        models.find((m) => !m.hidden && m.isDefault) ||
        models.find((m) => !m.hidden);
    threadId = (
      await prepareThread(rpc, undefined, {
        cwd: home,
        model: model.model,
        sandbox: "read-only",
        approvalPolicy: "never",
        config: { "features.goals": false },
      })
    ).thread.id;
    await rpc.close();
    rpc = await Rpc.open(cli, home);
    await rpc.call("thread/goal/set", {
      threadId,
      objective:
        "Unauthenticated input admission probe only. Do not use tools.",
      tokenBudget: 1,
      status: "active",
      origin: "user",
    });
    await rpc.close();
    const open = Rpc.open.bind(Rpc);
    Rpc.open = async (...args) => {
      rpc = await open(...args);
      assert.equal(
        (await rpc.call("account/read", { refreshToken: false })).account,
        null,
      );
      const call = rpc.call.bind(rpc);
      let started;
      const admission = new Promise((r) => {
        started = r;
      });
      rpc.on("notification", (m) => {
        if (m.method === "turn/started" && m.params.threadId === threadId) {
          report.automaticTurns++;
          started();
        }
      });
      rpc.call = async (method, params, ...rest) => {
        if (method === "account/login/start") return {}; // Remain explicitly unauthenticated.
        if (method === "account/rateLimits/read")
          return {
            rateLimits: {
              limitId: "codex",
              primary: {
                usedPercent: 0,
                windowDurationMins: 300,
                resetsAt: Date.now() / 1000 + 18000,
              },
            },
          };
        if (["turn/start", "turn/steer", "review/start"].includes(method)) {
          report.submissions.push({ method, params });
          throw Error("PROBE_INFERENCE_BLOCKED");
        }
        const value = await call(method, params, ...rest);
        if (method === "thread/resume" && params.config?.["features.goals"]) {
          await Promise.race([
            admission,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("No actual Goal turn admitted")),
                8000,
              );
            }),
          ]);
          clearTimeout(timer);
        }
        return value;
      };
      return rpc;
    };
    job = {
      id: "probe",
      threadId,
      prompt: "original goal",
      pendingMessage: "FOLLOWUP_KEEP_42",
      attachments: [
        {
          type: "localImage",
          path: path.join(home, "question.png"),
          name: "question.png",
        },
      ],
      cwd: home,
      mode: "cli",
      model: model.model,
      effort: "low",
      bucket: "codex",
      state: "running",
      rotations: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sandbox: "readOnly",
      approvalPolicy: "never",
      goalResumeAfterQuota: true,
    };
    worker = new CliWorker({
      job,
      home,
      cli,
      resumePrompt: "resume original work",
      shouldStart: () => true,
      refresh: async () => {
        throw Error("No auth refresh");
      },
      checkpoint: async (t, u, submitted) => {
        job.threadId = t;
        if (u) {
          job.turnId = u;
          report.checkpoints.push({
            turnId: u,
            submitted: submitted !== false,
            pendingPresent: !!job.pendingMessage,
          });
          if (submitted !== false) {
            job.pendingMessage = undefined;
            job.attachments = undefined;
          }
        }
      },
    });
    let blocked = false;
    try {
      await worker.start({
        accessToken: "not-used",
        chatgptAccountId: "not-used",
        chatgptPlanType: "plus",
      });
    } catch (e) {
      assert.match(e.message, /PROBE_INFERENCE_BLOCKED/);
      blocked = true;
    }
    assert(blocked);
    assert.equal(report.automaticTurns, 1);
    assert.equal(report.submissions.length, 1);
    report.pendingRetained = job.pendingMessage === "FOLLOWUP_KEEP_42";
    report.goalTokensUsed = (
      await rpc.call("thread/goal/get", { threadId })
    ).goal.tokensUsed;
    assert.equal(report.goalTokensUsed, 0);
    assert.equal(
      (await rpc.call("account/read", { refreshToken: false })).account,
      null,
    );
    if (baseline) {
      assert.equal(report.submissions[0].method, "turn/start");
      assert.equal(report.pendingRetained, false);
      assert.equal(
        report.submissions[0].params.input[0].text,
        "resume original work",
      );
    } else {
      assert.equal(report.submissions[0].method, "turn/steer");
      assert.equal(report.pendingRetained, true);
      assert.equal(
        report.submissions[0].params.input[0].text,
        "FOLLOWUP_KEEP_42",
      );
      assert.equal(report.submissions[0].params.input[1].type, "localImage");
    }
    report.status = "passed";
  } catch (e) {
    report.status = "failed";
    report.error = e.message;
    throw e;
  } finally {
    clearTimeout(timer);
    if (rpc && threadId) {
      await rpc
        .call("thread/goal/set", { threadId, status: "paused", origin: "user" })
        .catch(() => {});
      if (job?.turnId)
        await rpc
          .call("turn/interrupt", { threadId, turnId: job.turnId })
          .catch(() => {});
    }
    await worker?.close().catch(() => {});
    await rpc?.close();
    await fs.writeFile(
      path.join(
        output,
        baseline
          ? "goal-message-native-baseline.json"
          : "goal-message-native-report.json",
      ),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
