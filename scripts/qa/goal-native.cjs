// Real Electron and CLI goal metadata, with an isolated, unauthenticated runtime.
// No turn/start is sent. An active persisted Goal must not dispatch during reads.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const esbuild = require("esbuild");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
const built = esbuild.buildSync({
  stdin: {
    contents:
      'export { Rpc } from "./src/core/rpc"; export { Store } from "./src/core/store"; export { prepareThread } from "./src/core/thread";',
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
const { Rpc, Store, prepareThread } = bundled.exports;
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Goal verification timed out");
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, "goal-native-"));
  const cwd = path.join(fixture, "project"),
    profile = path.join(fixture, "profile");
  await fs.mkdir(cwd);
  const store = new Store(profile),
    id = randomUUID(),
    now = Date.now();
  const cli = path.join(
    root,
    "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  );
  store.data.settings.cliPath = cli;
  const job = {
    id,
    title: "原生目标状态验收",
    prompt: "No inference",
    cwd,
    mode: "cli",
    model: "",
    effort: "",
    bucket: "codex",
    state: "completed",
    rotations: 0,
    createdAt: now,
    updatedAt: now,
    approvalPolicy: "on-request",
    sandbox: "readOnly",
    interactive: true,
  };
  store.data.jobs.push(job);
  const home = store.jobHome(id);
  let rpc, app, page;
  let startedTurns = 0;
  const errors = [],
    report = { fixture, inferenceRequests: 0 };
  const open = async () => {
    rpc = await Rpc.open(cli, home);
    rpc.on("notification", (m) => {
      if (m.method === "turn/started") startedTurns++;
    });
    rpc.on("request", (m) => rpc.reject(m.id, "Local metadata test only"));
    return rpc;
  };
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    app = await _electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/electron.exe",
      ),
      args: [root],
      env,
      timeout: 60000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("button", { name: job.title, exact: true }).click();
    if (!(await page.locator(".workbench-tabs").count()))
      await page.getByRole("button", { name: "会话信息", exact: true }).click();
  };
  const call = (name, args) =>
    page.evaluate(({ name, args }) => window.relay.command(name, args), {
      name,
      args,
    });
  const current = async () =>
    (await page.evaluate(() => window.relay.snapshot())).jobs.find(
      (j) => j.id === id,
    );
  const menu = async (name) => {
    await page.getByLabel("目标操作", { exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
  };
  try {
    await open();
    const created = await prepareThread(rpc, undefined, {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: { "features.goals": false },
    });
    job.threadId = created.thread.id;
    await rpc.close();
    rpc = undefined;
    // Mutate an UNLOADED thread. Loading an active Goal is intentionally avoided.
    await open();
    const initial = await rpc.call("thread/goal/set", {
      threadId: job.threadId,
      objective: "保留目标及进度，读取历史不开始执行。",
      status: "active",
      origin: "user",
      tokenBudget: 5000,
    });
    await rpc.close();
    rpc = undefined;
    await store.save();
    await fs.writeFile(
      path.join(profile, "desktop.json"),
      JSON.stringify({
        projects: [{ id: randomUUID(), name: "Goal QA", cwd }],
        schedules: [],
        preferences: { theme: "dark", language: "zh-CN", notifications: false },
      }),
    );
    await launch();
    await page.getByLabel("会话目标", { exact: true }).waitFor();
    await page.getByText(initial.goal.objective, { exact: true }).waitFor();
    assert.equal((await current()).goal.status, "active");
    assert.equal((await call("chat.turns", { id })).data.length, 0);
    assert.equal((await call("chat.goal.read", { id })).goal.status, "active");
    assert.equal((await current()).state, "completed");
    report.historyDoesNotDispatchGoal = true;
    await page.getByLabel("目标操作", { exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".goal-menu[open]").count(), 0);
    await page.screenshot({ path: path.join(output, "desktop-goal.png") });
    await menu("调整目标预算");
    let dialog = page.getByRole("dialog", {
      name: "调整目标预算",
      exact: true,
    });
    await dialog.getByLabel("目标 Token 预算", { exact: true }).fill("-1");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.getByRole("alert").waitFor();
    assert.equal((await current()).goal.tokenBudget, 5000);
    await dialog.getByLabel("目标 Token 预算", { exact: true }).fill("3000");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await until(async () => (await current()).goal.tokenBudget === 3000);
    assert.equal((await current()).goal.objective, initial.goal.objective);
    assert.equal((await current()).goal.createdAt, initial.goal.createdAt);
    await app.close();
    app = undefined;
    await launch();
    await page.getByLabel("会话目标", { exact: true }).waitFor();
    assert.equal((await call("chat.goal.read", { id })).goal.tokenBudget, 3000);
    report.nativePersistenceAndBudget = true;
    await menu("暂停目标");
    await until(async () => (await current()).goal.status === "paused");
    assert.equal((await current()).state, "completed");
    await menu("调整目标预算");
    dialog = page.getByRole("dialog", { name: "调整目标预算", exact: true });
    await dialog.getByLabel("目标 Token 预算", { exact: true }).fill("");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await until(async () => (await current()).goal.tokenBudget === null);
    assert.equal((await current()).goal.status, "paused");
    await call("desktop.preferences", { language: "en" });
    await page.reload();
    await page.getByRole("button", { name: job.title, exact: true }).click();
    await page.getByLabel("Chat goal", { exact: true }).waitFor();
    await page.getByText("Goal paused", { exact: true }).waitFor();
    await call("desktop.preferences", { language: "zh-TW" });
    await page.reload();
    await page.getByRole("button", { name: job.title, exact: true }).click();
    await page.getByLabel("會話目標", { exact: true }).waitFor();
    await call("desktop.preferences", { language: "zh-CN" });
    await page.reload();
    await page.getByRole("button", { name: job.title, exact: true }).click();
    await page.getByLabel("会话目标", { exact: true }).waitFor();
    await menu("清除目标");
    dialog = page.getByRole("dialog", { name: "清除目标", exact: true });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await current()).goal.status, "paused");
    await menu("清除目标");
    await dialog.getByRole("button", { name: "清除目标", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await until(async () => (await current()).goal === null);
    assert.equal(await page.getByLabel("会话目标", { exact: true }).count(), 0);
    assert.equal(
      await page
        .locator(".workbench-tabs button.selected")
        .evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal((await call("chat.goal.read", { id })).goal, null);
    report.pauseClearAndThreeLanguages = true;
    await app.close();
    app = undefined;
    await open();
    await prepareThread(rpc, job.threadId, {
      cwd,
      excludeTurns: true,
      config: { "features.goals": false },
    });
    const history = await rpc.call("thread/turns/list", {
      threadId: job.threadId,
      limit: 20,
    });
    assert.equal(
      history.data.length,
      0,
      "No turn was created by metadata, budget, restart, or history operations",
    );
    assert.equal(startedTurns, 0);
    report.turnsCreated = history.data.length;
    assert.deepEqual(errors, []);
    report.rendererErrors = errors;
    report.status = "passed";
    console.log(JSON.stringify(report));
  } catch (e) {
    report.status = "failed";
    report.error = e.stack || String(e);
    if (page)
      await page
        .screenshot({ path: path.join(output, "goal-native-failed.png") })
        .catch(() => {});
    throw e;
  } finally {
    await app?.close();
    await rpc?.close();
    await fs.writeFile(
      path.join(output, "goal-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
})().catch((e) => {
  console.error(e.stack || e);
  process.exitCode = 1;
});
