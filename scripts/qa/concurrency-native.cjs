// Real Electron settings/IPC/persistence. Isolated empty profile; no model calls.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "qa-output");
(async () => {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, "concurrency-native-"));
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
      schedules: [],
      preferences: { language: "en", theme: "dark", notifications: false },
    }),
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
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
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const limit = page.getByLabel("Concurrent task limit", { exact: true });
    await limit.waitFor();
    assert.equal(await limit.inputValue(), "3");
    assert.equal(await limit.locator("option").count(), 8);
    await limit.selectOption("5");
    await page.waitForFunction(
      async () =>
        (await window.relay.snapshot()).settings.maxConcurrentTasks === 5,
    );
    const invalid = await page.evaluate(async () => {
      const values = [0, 9, 1.5, "3"];
      return Promise.all(
        values.map(async (maxConcurrentTasks) => {
          try {
            await window.relay.command("tasks.policy", { maxConcurrentTasks });
            return false;
          } catch {
            return true;
          }
        }),
      );
    });
    assert.deepEqual(invalid, [true, true, true, true]);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(profile, "state.json"), "utf8"))
        .settings.maxConcurrentTasks,
      5,
    );
    report.checks.push(
      "default three",
      "UI saves limit",
      "invalid limits rejected",
      "persisted to isolated profile",
    );
    await page.screenshot({
      path: path.join(output, "concurrency-settings-en.png"),
    });
    for (const [language, label, languageLabel] of [
      ["zh-CN", "并发任务上限", "Language"],
      ["zh-TW", "併發任務上限", "语言"],
    ]) {
      await page
        .getByLabel(languageLabel, { exact: true })
        .selectOption(language);
      await page.getByLabel(label, { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel(label, { exact: true }).inputValue(),
        "5",
      );
      await page.screenshot({
        path: path.join(output, `concurrency-settings-${language}.png`),
      });
    }
    report.checks.push("three language labels retain saved value");
    await page.reload();
    await page.getByRole("button", { name: "設定", exact: true }).click();
    assert.equal(
      await page.getByLabel("併發任務上限", { exact: true }).inputValue(),
      "5",
    );
    const snapshot = await page.evaluate(() => window.relay.snapshot());
    assert.equal(snapshot.accounts.length, 0);
    assert.equal(snapshot.jobs.length, 0);
    assert.deepEqual(report.errors, []);
    report.checks.push(
      "renderer reload retains value",
      "no accounts or task submissions",
    );
    report.status = "passed";
  } finally {
    await fs.writeFile(
      path.join(output, "concurrency-native-report.json"),
      JSON.stringify(report, null, 2),
    );
    if (app) await app.evaluate(({ app }) => app.quit()).catch(() => {});
    if (app) await app.close().catch(() => {});
  }
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
