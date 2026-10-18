// Real Electron schedule admission and Japanese UI; empty profile, no inference.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "qa-output");

(async () => {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, "schedules-native-"));
  const taskId = randomUUID();
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts: [],
      jobs: [],
      logs: [],
      cursor: 0,
      settings: { resetWarmupEnabled: false },
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [],
      schedules: [
        {
          id: taskId,
          title: "Native schedule fixture",
          prompt: "No account; admission only",
          cwd: profile,
          enabled: true,
          cadence: "interval",
          minutes: 5,
          hour: 9,
          minute: 0,
          weekday: 1,
          worktree: false,
          nextRun: Date.now() - 86400000,
        },
      ],
      preferences: { language: "ja", theme: "dark", notifications: false },
    }),
  );
  const env = {
    ...process.env,
    CODEX_RELAY_DATA_DIR: profile,
    CODEX_RELAY_STARTUP_TRACE: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const report = { profile, inferenceRequests: 0, errors: [], checks: [] };
  try {
    app = await _electron.launch({
      executablePath:
        process.env.RELAY_EXECUTABLE ||
        path.join(root, "node_modules/electron/dist/electron.exe"),
      args: process.env.RELAY_EXECUTABLE ? [] : [root],
      env,
      timeout: 60000,
    });
    app.process().stdout?.on("data", (chunk) => process.stdout.write(chunk));
    app.process().stderr?.on("data", (chunk) => process.stderr.write(chunk));
    const page = await app.firstWindow();
    app.qaPage = page;
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => report.errors.push(error.message));
    const call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    await page
      .getByRole("button", { name: "スケジュールタスク", exact: true })
      .waitFor();
    const deadline = Date.now() + 15000;
    while (!(await call("desktop.read")).schedules[0]?.lastJobId) {
      assert.ok(Date.now() < deadline, "automatic admission timed out");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const initial = (await call("desktop.read")).schedules[0];
    assert.ok(initial.nextRun > Date.now());
    let snapshot = await page.evaluate(() => window.relay.snapshot());
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.jobs[0].schedule.taskId, taskId);
    report.checks.push(
      "overdue startup admits one occurrence and persists its identity",
    );
    const rejected = await page.evaluate(
      async (id) =>
        Promise.all(
          Array.from({ length: 3 }, async () => {
            try {
              await window.relay.command("schedule.run", id);
              return false;
            } catch {
              return true;
            }
          }),
        ),
      taskId,
    );
    assert.deepEqual(rejected, [true, true, true]);
    await call("job.control", { id: initial.lastJobId, action: "cancel" });
    const ids = await page.evaluate(
      async (id) =>
        Promise.all(
          Array.from({ length: 3 }, async () => {
            try {
              return (await window.relay.command("schedule.run", id)).id;
            } catch {
              return null;
            }
          }),
        ),
      taskId,
    );
    const admitted = ids.filter(Boolean);
    assert.ok(admitted.length >= 1);
    assert.equal(new Set(admitted).size, 1);
    snapshot = await page.evaluate(() => window.relay.snapshot());
    assert.equal(snapshot.jobs.length, 2);
    assert.equal(
      (await call("desktop.read")).schedules[0].nextRun,
      initial.nextRun,
    );
    report.checks.push(
      "unfinished run blocks duplicates; simultaneous manual requests admit one after cancellation",
    );
    await call("schedule.remove", taskId);
    await page
      .getByRole("button", { name: "スケジュールタスク", exact: true })
      .click();
    await page
      .locator(".schedule-suggestions button")
      .filter({ hasText: "毎週のコードレビュー" })
      .click();
    assert.equal(await page.getByLabel("頻度").inputValue(), "weekly");
    await page.getByLabel("プロジェクトディレクトリ").fill(profile);
    await page
      .getByRole("button", { name: "スケジュールタスクを保存", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "スケジュールタスクを一時停止",
        exact: true,
      })
      .waitFor();
    const weekly = (await call("desktop.read")).schedules[0];
    assert.equal(weekly.cadence, "weekly");
    assert.equal(weekly.title, "毎週のコードレビュー");
    await page
      .getByRole("button", {
        name: "スケジュールタスクを一時停止",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "スケジュールタスクを有効化", exact: true })
      .waitFor();
    await page.reload();
    await page
      .getByRole("button", { name: "スケジュールタスク", exact: true })
      .click();
    await page
      .getByRole("button", { name: "スケジュールタスクを有効化", exact: true })
      .waitFor();
    assert.equal((await call("desktop.read")).schedules[0].enabled, false);
    report.checks.push(
      "Japanese weekly template, save, pause and reload persistence",
    );
    await page.screenshot({
      path: path.join(output, "schedules-native-ja.png"),
    });
    await page
      .getByRole("button", { name: "毎週のコードレビュー", exact: true })
      .click();
    await page
      .getByRole("button", { name: "スケジュールタスクを削除", exact: true })
      .click();
    await page.locator(".schedule-suggestions").waitFor();
    const disk = JSON.parse(
      await fs.readFile(path.join(profile, "desktop.json"), "utf8"),
    );
    assert.equal(disk.schedules.length, 0);
    snapshot = await page.evaluate(() => window.relay.snapshot());
    assert.equal(snapshot.accounts.length, 0);
    assert.equal(snapshot.jobs.length, 2);
    assert.ok(snapshot.jobs.every((job) => !job.threadId));
    assert.deepEqual(report.errors, []);
    report.checks.push(
      "UI deletion persisted while preserving task history; no accounts or model sessions",
    );
    report.status = "passed";
  } catch (error) {
    report.failure = String(error);
    if (app?.qaPage)
      await app.qaPage
        .screenshot({
          path: path.join(output, "schedules-native-failure.png"),
          timeout: 3000,
        })
        .catch(() => {});
    console.error(error);
    throw error;
  } finally {
    await fs.writeFile(
      path.join(output, "schedules-native-report.json"),
      JSON.stringify(report, null, 2),
    );
    const watchdog =
      app &&
      setTimeout(() => {
        if (process.platform === "win32")
          execFile(
            "taskkill",
            ["/PID", String(app.process().pid), "/T", "/F"],
            { windowsHide: true },
          );
        else app.process().kill("SIGKILL");
      }, 10000);
    if (app) await app.evaluate(({ app }) => app.quit()).catch(() => {});
    if (app) await app.close().catch(() => {});
    clearTimeout(watchdog);
  }
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
