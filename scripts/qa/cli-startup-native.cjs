// Real Electron, empty profiles and an already verified managed CLI; no accounts.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const installed = JSON.parse(
    await fs.readFile(
      path.join(output, "cli-install-native-report.json"),
      "utf8",
    ),
  );
  assert.equal(installed.status, "passed");
  const selected = JSON.parse(
    await fs.readFile(
      path.join(installed.fixture, "selected-cli.json"),
      "utf8",
    ),
  ).cli;
  const profile = await fs.mkdtemp(path.join(output, "cli-startup-native-"));
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts: [],
      jobs: [],
      logs: [],
      cursor: 0,
      settings: { cliPath: selected, resetWarmupEnabled: false },
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [],
      schedules: [],
      preferences: {
        theme: "dark",
        language: "zh-CN",
        notifications: false,
        closeToTray: false,
      },
    }),
  );
  const report = { profile, modelRequests: 0, launches: [], errors: [] };
  let app;
  try {
    for (let launch = 0; launch < 2; launch++) {
      const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({
        executablePath:
          process.env.RELAY_EXECUTABLE ||
          path.join(root, "node_modules/electron/dist/electron.exe"),
        args: process.env.RELAY_EXECUTABLE ? [] : [root],
        env,
        timeout: 60000,
      });
      const page = await app.firstWindow();
      page.on("pageerror", (e) => report.errors.push(e.message));
      await page.locator(".agent-shell").waitFor();
      let status;
      const deadline = Date.now() + 20000;
      do {
        status = await page.evaluate(() => window.relay.command("cli.status"));
        if (status.phase === "ready" || status.phase === "error") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      report.lastStatus = status;
      assert.equal(status.phase, "ready", status.error);
      assert.equal(status.path, selected);
      assert.match(status.version, /^codex-cli 0\.162\.1/);
      const snapshot = await page.evaluate(() => window.relay.snapshot());
      assert.equal(snapshot.settings.cliPath, selected);
      assert.equal(snapshot.accounts.length, 0);
      assert.equal(snapshot.jobs.length, 0);
      await page.locator(".cli-setup-notice").waitFor({ state: "detached" });
      await fs.access(path.join(profile, "runtime", "managed-cli")).then(
        () => assert.fail("reused CLI must not install again"),
        (e) => assert.equal(e.code, "ENOENT"),
      );
      report.launches.push({
        launch,
        phase: status.phase,
        version: status.version,
        application: await app.evaluate(({ app }) => ({
          version: app.getVersion(),
          packaged: app.isPackaged,
        })),
      });
      await app.evaluate(({ app }) => app.quit());
      await app.close();
      app = undefined;
    }
    assert.deepEqual(report.errors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    await fs.writeFile(
      path.join(
        output,
        process.env.RELAY_EXECUTABLE
          ? "cli-startup-packaged-report.json"
          : "cli-startup-native-report.json",
      ),
      JSON.stringify(report, null, 2),
    );
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
