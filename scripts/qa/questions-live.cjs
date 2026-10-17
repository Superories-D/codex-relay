// Two bounded real model turns through the production Electron Main/Scheduler/
// CliWorker/renderer. An authorized access token is stored only in the OS vault;
// no refresh token is copied, so this test cannot rotate the user's login.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { buildSync } = require("esbuild");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw Error("Timed out waiting for actual Codex question lifecycle");
}
(async () => {
  const source = process.env.RELAY_TEST_CREDENTIAL_ROLLOUT;
  assert(
    source,
    "Set RELAY_TEST_CREDENTIAL_ROLLOUT to the authorized chat rollout",
  );
  const profile = await fs.mkdtemp(path.join(output, "questions-live-"));
  const cwd = path.join(profile, "project");
  await fs.mkdir(cwd);
  const helper = path.join(profile, "seed.cjs"),
    entry = path.join(profile, "entry.cjs");
  buildSync({
    stdin: {
      contents:
        'export { Store } from "./src/core/store"; export { Accounts } from "./src/core/accounts";',
      loader: "ts",
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: helper,
  });
  // No credential content in generated files or child process arguments.
  await fs.writeFile(
    entry,
    `const {app}=require('electron'); globalThis.qaRequire=require; app.setName('Codex Relay'); app.setPath('userData', ${JSON.stringify(profile)}); app.whenReady().then(()=>{});`,
  );
  const env = {
    ...process.env,
    CODEX_RELAY_DATA_DIR: profile,
    CODEX_RELAY_DISABLE_RESET_WARMUP: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const report = {
    status: "running",
    profile,
    maximumRootTurns: 2,
    submittedTurns: 0,
    refreshTokenCopied: false,
    checks: [],
    rendererErrors: [],
  };
  const save = () =>
    fs.writeFile(
      path.join(output, "questions-live-report.json"),
      JSON.stringify(report, null, 2),
    );
  let app, page, call, id;
  async function launch(args) {
    app = await _electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/electron.exe",
      ),
      args,
      env,
      timeout: 60000,
    });
  }
  async function connect() {
    page = await app.firstWindow();
    page.on("pageerror", (e) => report.rendererErrors.push(e.message));
    call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    await page.waitForFunction(() => !!window.relay);
  }
  async function close() {
    if (!app) return;
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
    app = undefined;
  }
  try {
    await launch([entry]);
    // Parsing and encryption happen inside Electron's main process. Only the
    // selected account's nonsecret ID comes back to the test driver.
    report.accountId = await app.evaluate(
      async ({ app, safeStorage }, { source, profile, helper, root }) => {
        const require = globalThis.qaRequire;
        const fs = require("node:fs/promises"),
          path = require("node:path");
        const { Store, Accounts } = require(helper);
        let selected;
        for (const line of (await fs.readFile(source, "utf8"))
          .split("\n")
          .reverse()) {
          if (!line.includes("access_token") || !line.includes("做测试"))
            continue;
          const record = JSON.parse(line);
          if (
            record.type !== "response_item" ||
            record.payload?.role !== "user"
          )
            continue;
          const text = record.payload.content
            .map((c) => c.text || "")
            .join("\n");
          try {
            selected = JSON.parse(
              text.slice(text.indexOf("["), text.lastIndexOf("]") + 1),
            ).find((v) => v.type === "codex" && v.access_token);
          } catch {}
          if (selected) break;
        }
        if (!selected) throw Error("No user-authorized test credentials");
        const claims = JSON.parse(
          Buffer.from(selected.access_token.split(".")[1], "base64url"),
        );
        if (claims.exp * 1000 < Date.now() + 120000)
          throw Error("Authorized access token has expired");
        if (!safeStorage.isEncryptionAvailable())
          throw Error("OS credential encryption unavailable");
        const store = new Store(profile);
        await store.load();
        store.data.settings.resetWarmupEnabled = false;
        store.data.settings.cliPath = path.join(
          root,
          "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        );
        const accounts = new Accounts(
          store,
          {
            encrypt: (v) => safeStorage.encryptString(v),
            decrypt: (v) => safeStorage.decryptString(v),
          },
          () => {},
        );
        const account = await accounts.import(
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              id_token: selected.id_token || "",
              access_token: selected.access_token,
              refresh_token: "",
              account_id: selected.account_id,
            },
            last_refresh: selected.last_refresh,
          }),
        );
        await store.save();
        app.setAppPath(root);
        require(path.join(root, "dist/main/main.cjs"));
        return account.id;
      },
      { source, profile, helper, root },
    );
    await connect();
    const quotas = await call("account.refresh", report.accountId);
    report.before = quotas.codex;
    assert(report.before, "Actual subscription quota required");
    for (const window of [
      report.before.primary,
      report.before.secondary,
    ].filter(Boolean))
      assert(window.usedPercent <= 95, "At least 5% quota must remain");
    const models = await call("account.models", report.accountId);
    const model =
      models.find((m) => !m.hidden && /luna|mini/i.test(m.model)) ||
      models.find((m) => m.isDefault);
    assert(model);
    report.model = model.model;
    report.effort = ["minimal", "low", model.defaultReasoningEffort].find((e) =>
      model.supportedReasoningEfforts.some((s) => s.reasoningEffort === e),
    );
    const job = await call("job.add", {
      title: "真实问题交互验收",
      prompt:
        "This is a bounded question UI integration test. Call request_user_input exactly once with two questions. First: id=direction, header=Direction, question=Choose a direction, options=[{label:Small,description:Narrow change},{label:Large,description:Broad change}], isOther=true. Second: id=finish, header=Finish, question=Choose a finish, options=[{label:Smooth,description:Fluid motion},{label:Static,description:No motion}], isOther=true. Wait for the actual human response, then reply only QUESTION_E2E_OK followed by both received answer values. Do not call other tools or create agents. Do not choose answers yourself.",
      cwd,
      mode: "cli",
      interactive: true,
      model: report.model,
      effort: report.effort,
      bucket: "codex",
      approvalPolicy: "never",
      sandbox: "readOnly",
      multiAgent: false,
    });
    id = job.id;
    report.jobId = id;
    report.submittedTurns++;
    await save();
    await page.getByRole("button", { name: job.title, exact: true }).click();
    const request = await until(async () =>
      (await call("snapshot")).approvals.find(
        (a) => a.jobId === id && a.kind === "input",
      ),
    );
    report.threadId = request.params.threadId;
    report.firstTurnId = request.params.turnId;
    assert.equal(request.params.questions.length, 2);
    report.firstRequestBlocking = request.params.isBlocking;
    if (request.params.isBlocking === false)
      await page.locator(".question-callout").click();
    await page.getByRole("form", { name: "回答 Codex 的问题" }).waitFor();
    const fields = page.locator(".question-request fieldset");
    await fields.nth(0).getByLabel("自定义回答", { exact: true }).check();
    await fields
      .nth(0)
      .getByLabel("你的回答", { exact: true })
      .fill("Custom-blue");
    await fields
      .nth(1)
      .getByRole("radio", { name: /Smooth/ })
      .check();
    // Recycled wire IDs must never permit a stale UI to answer a new request.
    const stale = await call("approval.respond", {
      id: request.id,
      historyId: "stale-history",
      value: { answers: {} },
    }).then(
      () => "",
      (e) => e.message,
    );
    assert(stale.includes("问题已更新"));
    await page.screenshot({
      path: path.join(output, "desktop-questions-live.png"),
    });
    await page.getByRole("button", { name: "提交回答", exact: true }).click();
    await until(
      async () =>
        (await call("snapshot")).jobs.find((j) => j.id === id).state ===
        "completed",
    );
    const history = await call("chat.questions.read", { id });
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].status, "answered");
    assert.deepEqual(history.items[0].answers, {
      direction: { answers: ["Custom-blue"] },
      finish: { answers: ["Smooth"] },
    });
    const transcript = await call("chat.read", { id });
    assert(
      transcript.items.some(
        (i) =>
          i.role === "assistant" &&
          i.text.includes("QUESTION_E2E_OK") &&
          i.text.includes("Custom-blue") &&
          i.text.includes("Smooth"),
      ),
    );
    assert.equal(
      (await call("snapshot")).jobs.find((j) => j.id === id).turnId,
      report.firstTurnId,
    );
    report.checks.push(
      "native default-mode questions open through the chat callout",
      "UI custom and option answers acknowledged by actual server",
      "same native turn continues with both received values",
      "stale request identity rejected",
    );
    await save();
    await call("chat.send", {
      id,
      text: "Second bounded UI test. Call request_user_input exactly once with one question, id=stop_test, header=Stop, question=Choose a finish, options=[{label:Smooth,description:Fluid},{label:Static,description:Still}], isOther=true. Wait for the human; do not answer it or use any other tools. If the test interrupts you, do not retry.",
      action: "send",
      attachments: [],
      model: report.model,
      effort: report.effort,
    });
    report.submittedTurns++;
    await save();
    const stopped = await until(async () =>
      (await call("snapshot")).approvals.find(
        (a) => a.jobId === id && a.kind === "input",
      ),
    );
    await call("job.control", { id, action: "pause" });
    await until(
      async () =>
        (await call("snapshot")).jobs.find((j) => j.id === id).state ===
        "paused",
    );
    assert.equal(
      (await call("snapshot")).approvals.filter((a) => a.jobId === id).length,
      0,
    );
    assert.equal(
      (await call("chat.questions.read", { id })).items.find(
        (q) => q.id === stopped.historyId,
      ).status,
      "expired",
    );
    await close();
    await launch([root]);
    await connect();
    await page.getByRole("button", { name: job.title, exact: true }).click();
    if (!(await page.locator(".workbench-tabs").count()))
      await page.getByRole("button", { name: "会话信息", exact: true }).click();
    await page
      .locator(".workbench-tabs")
      .getByRole("button", { name: /问题/ })
      .click();
    await page.getByText("问题已失效", { exact: true }).waitFor();
    assert.equal(await page.locator(".question-request").count(), 0);
    const restored = await call("chat.questions.read", { id });
    assert.equal(
      restored.items.find((q) => q.id === request.historyId).status,
      "answered",
    );
    assert.equal(
      restored.items.find((q) => q.id === stopped.historyId).status,
      "expired",
    );
    const late = await call("approval.respond", {
      id: stopped.id,
      historyId: stopped.historyId,
      value: { answers: {} },
    }).then(
      () => "",
      (e) => e.message,
    );
    assert(late.includes("请求已经结束"));
    report.checks.push(
      "stop expires actual pending request",
      "cold restart preserves answered and expired history",
      "expired question is read-only and rejects late answers",
    );
    report.after = (await call("account.refresh", report.accountId)).codex;
    assert.deepEqual(report.rendererErrors, []);
    report.status = "passed";
    await save();
    console.log(JSON.stringify(report));
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    await save();
    if (page)
      await page
        .screenshot({ path: path.join(output, "questions-live-failed.png") })
        .catch(() => {});
    throw error;
  } finally {
    if (app && call && id)
      await call("job.control", { id, action: "pause" }).catch(() => {});
    await close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
