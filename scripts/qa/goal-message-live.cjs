// One real native Goal turn plus a pending user message and actual attachments.
// Read an existing owned access-only QA vault; never touch that source profile's
// settings, runtime or refresh authority. All execution uses a new QA profile.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  { spawn } = require("node:child_process"),
  { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
async function nativeMain(config) {
  const { app, safeStorage, BrowserWindow } = require("electron"),
    fs = require("node:fs/promises"),
    path = require("node:path"),
    assert = require("node:assert/strict");
  const {
    Store,
    Accounts,
    Scheduler,
    CliWorker,
    Rpc,
    Attachments,
    redact,
  } = require(config.helper);
  app.setName("Codex Relay");
  app.setPath("userData", config.profile);
  if (!app.requestSingleInstanceLock()) {
    app.exit(2);
    return;
  }
  await app.whenReady();
  const report = {
    status: "starting",
    profile: config.profile,
    sourceProfileReadOnly: true,
    refreshTokenCopied: false,
    simulatedQuotaRecoveryFlag: true,
    automaticTurns: 0,
    manualTurnStartRequests: 0,
    steerRequests: 0,
    completedTurns: 0,
    checks: [],
    startedAt: Date.now(),
  };
  let store,
    accounts,
    scheduler,
    job,
    metadata,
    canvas,
    timeout,
    limited = false;
  const active = new Set();
  let write = Promise.resolve();
  const save = () => {
    write = write.then(() =>
      fs.writeFile(config.reportFile, JSON.stringify(report, null, 2)),
    );
    return write;
  };
  const until = async (fn, ms = 120000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Live Goal input verification timed out");
  };
  try {
    if (!safeStorage.isEncryptionAvailable())
      throw Error("Encrypted storage unavailable");
    const cipher = {
      encrypt: (v) => safeStorage.encryptString(v),
      decrypt: (v) => safeStorage.decryptString(v),
    };
    const source = new Store(config.source);
    await source.load();
    source.save = async () => {
      throw Error("Source profile is read-only");
    };
    const selected = source.data.accounts.find(
      (a) => a.enabled && a.status !== "reauth",
    );
    if (!selected) throw Error("No usable owned QA account");
    const auth = await new Accounts(source, cipher, () => {}).auth(selected.id);
    if (auth.tokens.refresh_token)
      throw Error(
        "Use an access-only QA vault; this test will not copy refresh authority",
      );
    if (process.env.RELAY_GOAL_METADATA_ONLY === "1") {
      report.status = "passed";
      report.checks = ["read-only encrypted vault access; no execution"];
      return;
    }
    store = new Store(config.profile);
    await store.load();
    store.data.settings.cliPath = config.cli;
    store.data.settings.resetWarmupEnabled = false;
    store.data.settings.pollSeconds = 30;
    accounts = new Accounts(store, cipher, () => {});
    const account = await accounts.import(
      JSON.stringify(auth),
      "Goal input verification",
    );
    const open = Rpc.open.bind(Rpc);
    Rpc.open = async (...args) => {
      const rpc = await open(...args);
      active.add(rpc);
      const call = rpc.call.bind(rpc);
      let admitted;
      const admission = new Promise((r) => {
        admitted = r;
      });
      rpc.on("notification", (m) => {
        if (m.params?.threadId !== job?.threadId) return;
        if (m.method === "turn/started") {
          report.automaticTurns++;
          admitted();
          if (report.automaticTurns > 1) {
            limited = true;
            void call("thread/goal/set", {
              threadId: job.threadId,
              status: "paused",
              origin: "user",
            }).catch(() => {});
            void call("turn/interrupt", {
              threadId: job.threadId,
              turnId: m.params.turn.id,
            }).catch(() => {});
          }
        }
        if (m.method === "turn/completed") report.completedTurns++;
      });
      rpc.call = async (method, params, ...rest) => {
        if (method === "turn/start" || method === "review/start") {
          report.manualTurnStartRequests++;
          throw Error("This real test permits only native Goal admission");
        }
        if (method === "turn/steer") {
          report.steerRequests++;
          if (report.steerRequests > 1)
            throw Error("Only one pending message may be submitted");
          report.submittedInputTypes = params.input.map((i) => i.type);
          report.expectedTurnId = params.expectedTurnId;
        }
        const result = await call(method, params, ...rest);
        if (
          method === "thread/resume" &&
          params.threadId === job?.threadId &&
          params.config?.["features.goals"]
        ) {
          await Promise.race([
            admission,
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(Error("No native Goal turn admitted")),
                10000,
              );
            }),
          ]);
          clearTimeout(timeout);
          await until(() => job.turnId, 3000);
          report.pendingAtAdmission = job.pendingMessage === config.text;
          report.attachmentsAtAdmission = job.attachments?.length;
        }
        if (method === "turn/steer") report.steerAcknowledged = true;
        return result;
      };
      return rpc;
    };
    const prepared = await accounts.inspect(account.id, true);
    report.before = prepared.quotas.codex;
    const windows = [report.before?.primary, report.before?.secondary].filter(
      Boolean,
    );
    if (
      !windows.length ||
      report.before.reached ||
      windows.some((w) => w.usedPercent > 95)
    )
      throw Error(
        "At least 5% remaining is required in every reported quota window",
      );
    const models = prepared.models.filter((m) => !m.hidden),
      model =
        models.find((m) => /luna|mini/i.test(m.model)) ||
        models.find((m) => m.isDefault) ||
        models[0];
    if (!model) throw Error("No model available");
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
    const cwd = path.join(config.profile, "project");
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "seed.txt"), "SEED=9\n");
    const note = path.join(cwd, "note.txt"),
      image = path.join(cwd, "visual.png");
    await fs.writeFile(note, "FILE_VALUE=42\n");
    // A deterministic test fixture, drawn locally; no image-generation inference.
    canvas = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true },
    });
    await canvas.loadURL("about:blank");
    const imageData = await canvas.webContents.executeJavaScript(
      "(()=>{const c=document.createElement('canvas');c.width=400;c.height=120;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,400,120);x.fillStyle='black';x.font='bold 36px sans-serif';x.fillText('IMAGE_VALUE=17',18,75);return c.toDataURL('image/png')})()",
    );
    await fs.writeFile(image, Buffer.from(imageData.split(",")[1], "base64"));
    scheduler = new Scheduler(store, accounts, {
      cli: (ctx) =>
        new CliWorker({
          ...ctx,
          refresh: async () => {
            throw Error(
              "This access-only test does not refresh login credentials",
            );
          },
        }),
      desktop: () => {
        throw Error("CLI mode only");
      },
    });
    const objective =
      "This is a bounded Goal acceptance task. Read seed.txt in the QA workspace first. Incorporate the incoming user follow-up and its file/image attachments before finishing. Use only read-only local tools in this workspace and the native Goal tool. Do not use network, subagents, approvals, or image generation; do not change budgets or create another Goal. When the requested values are verified, mark this Goal complete using its native Goal update tool, then return exactly the response requested by the follow-up. Do not ask questions.";
    job = await scheduler.createGoal(
      {
        title: "Goal pending message live",
        prompt: objective,
        cwd,
        mode: "cli",
        model: model.model,
        effort,
        serviceTier: "default",
        bucket: "codex",
        sandbox: "readOnly",
        approvalPolicy: "never",
        interactive: true,
        multiAgent: false,
      },
      20000,
      false,
    );
    metadata = await Rpc.open(config.cli, store.jobHome(job.id));
    const saved = await metadata.call("thread/goal/set", {
      threadId: job.threadId,
      status: "active",
      origin: "user",
    });
    job.goal = saved.goal;
    report.initialGoal = structuredClone(saved.goal);
    await metadata.close();
    active.delete(metadata);
    metadata = undefined;
    // Reproduce the production pending-message branch after authorized quota recovery,
    // without exhausting quota or falsifying any real server quota observation.
    job.goalResumeAfterQuota = true;
    await store.save();
    const attachments = await new Attachments(config.profile).files([
      note,
      image,
    ]);
    report.jobId = job.id;
    report.threadId = job.threadId;
    report.status = "executing";
    await save();
    await scheduler.send({
      id: job.id,
      text: config.text,
      attachments,
      action: "send",
      model: model.model,
      effort,
      planMode: false,
      multiAgent: false,
      serviceTier: "default",
    });
    scheduler.start();
    await until(() => {
      if (limited) throw Error("Unexpected second native turn was interrupted");
      if (scheduler.approvals.length)
        throw Error("Unexpected request for user approval/input");
      if (["needs_attention", "paused", "cancelled"].includes(job.state))
        throw Error("Goal did not complete: " + job.lastError);
      return job.state === "completed";
    });
    const journal = await scheduler.chats.read(job.id),
      answers = journal.items
        .filter((i) => i.role === "assistant")
        .map((i) => i.text)
        .join("\n");
    report.answer = redact(answers).slice(-800);
    report.finalGoal = job.goal;
    report.pendingCleared = !job.pendingMessage && !job.attachments;
    assert.match(answers, /GOAL_INPUT_LIVE_OK FILE=42 IMAGE=17/);
    assert.equal(job.goal?.status, "complete");
    assert.equal(job.goal.objective, objective);
    assert.equal(job.goal.tokenBudget, 20000);
    assert.equal(report.automaticTurns, 1);
    assert.equal(report.completedTurns, 1);
    assert.equal(report.manualTurnStartRequests, 0);
    assert.equal(report.steerRequests, 1);
    assert(
      report.steerAcknowledged &&
        report.pendingAtAdmission &&
        report.attachmentsAtAdmission === 2 &&
        report.pendingCleared,
    );
    metadata = await Rpc.open(config.cli, store.jobHome(job.id));
    const native = (
      await metadata.call("thread/read", {
        threadId: job.threadId,
        includeTurns: true,
      })
    ).thread;
    const users = native.turns
      .flatMap((t) => t.items)
      .filter(
        (i) =>
          i.type === "userMessage" &&
          JSON.stringify(i).includes("GOAL_INPUT_LIVE_OK"),
      );
    report.nativeUserCopies = users.length;
    report.nativeUserContentTypes = users.flatMap((i) =>
      (i.content || []).map((c) => c.type),
    );
    assert.equal(users.length, 1);
    await metadata.close();
    active.delete(metadata);
    metadata = undefined;
    report.after = (await accounts.inspect(account.id, true)).quotas.codex;
    report.checks = [
      "actual native Goal resume with a delayed reply",
      "pending text and both attachments survive automatic admission",
      "one acknowledged steer, no duplicate turn/start",
      "actual model reads mentioned file and local image",
      "one native user message, original Goal accounting and completion preserved",
    ];
    report.status = "passed";
  } catch (e) {
    report.status = "failed";
    report.error = redact(e instanceof Error ? e.message : String(e));
    if (job) report.jobState = job.state;
  } finally {
    clearTimeout(timeout);
    await metadata?.close().catch(() => {});
    if (scheduler) {
      await scheduler.shutdown().catch((e) => {
        report.status = "failed";
        report.cleanupError = redact(String(e));
      });
    }
    for (const rpc of active) await rpc.close().catch(() => {});
    if (accounts) await accounts.drain();
    report.finishedAt = Date.now();
    await save();
    canvas?.destroy();
    app.exit(report.status === "passed" ? 0 : 1);
  }
}
(async () => {
  if (!process.env.RELAY_ACCESS_PROFILE)
    throw Error("Set RELAY_ACCESS_PROFILE to an owned access-only QA profile");
  const source = await fs.realpath(process.env.RELAY_ACCESS_PROFILE);
  if (!source.startsWith((await fs.realpath(output)) + path.sep))
    throw Error("Only owned qa-output profiles are allowed");
  const profile = await fs.mkdtemp(path.join(output, "goal-message-live-")),
    helper = path.join(output, "goal-message-live-core.cjs"),
    entry = path.join(output, "goal-message-live-entry.cjs"),
    reportFile = path.join(profile, "report.json");
  // Windows safeStorage uses a profile-specific key wrapped by OS protection.
  // Seed only this encrypted key metadata before Electron initializes; no
  // source preferences, login runtime files or plaintext secrets are copied.
  const sourceState = JSON.parse(
    await fs.readFile(path.join(source, "Local State"), "utf8"),
  );
  if (!sourceState.os_crypt?.encrypted_key)
    throw Error("Owned QA encryption metadata is missing");
  await fs.writeFile(
    path.join(profile, "Local State"),
    JSON.stringify({ os_crypt: sourceState.os_crypt }),
  );
  buildSync({
    stdin: {
      contents:
        'export { Store } from "./src/core/store";export { Accounts } from "./src/core/accounts";export { Scheduler } from "./src/core/scheduler";export { CliWorker } from "./src/core/cli-worker";export { Rpc } from "./src/core/rpc";export { Attachments } from "./src/core/attachments";export { redact } from "./src/core/redact";',
      loader: "ts",
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: helper,
  });
  const config = {
    source,
    profile,
    helper,
    reportFile,
    cli: path.join(
      root,
      "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    ),
    text: "Read the attached note and image. Find FILE_VALUE in the note, and IMAGE_VALUE printed in the image. Verify both, mark the existing Goal complete without changing its objective or budget, then reply exactly GOAL_INPUT_LIVE_OK FILE=<value> IMAGE=<value>, substituting the values. Use no network or writes; do not ask questions.",
  };
  await fs.writeFile(
    entry,
    `(${nativeMain.toString()})(${JSON.stringify(config)}).catch(async error=>{await require('node:fs/promises').writeFile(${JSON.stringify(reportFile)},JSON.stringify({status:'failed',profile:${JSON.stringify(profile)},initializationError:String(error.message)}));require('electron').app.exit(1)});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    path.join(root, "node_modules/electron/dist/electron.exe"),
    [entry],
    { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-16000);
  });
  console.log(
    JSON.stringify({
      status: "launched",
      pid: child.pid,
      profile,
      reportFile,
      maximumGoalTurns: 1,
    }),
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await fs.writeFile(
    path.join(profile, "electron-diagnostics.txt"),
    require(helper).redact(diagnostics),
  );
  const report = JSON.parse(
    await fs.readFile(reportFile, "utf8").catch((error) => {
      throw Error(
        "Electron exited (" +
          code +
          ") without a report; diagnostic path: " +
          path.join(profile, "electron-diagnostics.txt"),
      );
    }),
  );
  if (report.profile !== profile) throw Error("Unexpected report owner");
  await fs.writeFile(
    path.join(output, "goal-message-live-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  process.exitCode = Number(code) || (report.status === "passed" ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
