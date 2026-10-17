// Opt-in verification of the user's actual installed EXE and populated home.
// Refuse any profile with accounts or actionable jobs to prevent inference.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const { promisify } = require("node:util"),
  { execFile } = require("node:child_process");
(async () => {
  const executable = process.env.RELAY_INSTALLED_EXECUTABLE;
  assert(
    executable && path.isAbsolute(executable),
    "Set RELAY_INSTALLED_EXECUTABLE explicitly",
  );
  const profile = path.join(process.env.APPDATA, "Codex Relay");
  const before = JSON.parse(
    await fs.readFile(path.join(profile, "state.json"), "utf8"),
  );
  assert.equal(
    before.accounts.length,
    0,
    "Actual-profile startup QA must have no accounts",
  );
  assert(
    !(before.jobs || []).some((j) =>
      [
        "queued",
        "waiting",
        "preparing",
        "running",
        "pausing",
        "rotating",
        "watching",
      ].includes(j.state),
    ),
    "Do not dispatch the user's tasks during startup QA",
  );
  const report = {
    executable,
    profile,
    inferenceRequests: 0,
    boots: [],
    errors: [],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let app;
    const started = Date.now();
    try {
      const env = { ...process.env, CODEX_RELAY_STARTUP_TRACE: "1" };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.CODEX_RELAY_DATA_DIR;
      app = await _electron.launch({
        executablePath: executable,
        args: [],
        env,
        timeout: 60000,
      });
      const page = await app.firstWindow();
      page.on("pageerror", (e) => report.errors.push(e.message));
      await page
        .getByRole("button", { name: "新聊天", exact: true })
        .waitFor({ timeout: 60000 });
      const state = await page.evaluate(() => window.relay.snapshot());
      assert.equal(state.accounts.length, 0);
      assert.equal(state.jobs.length, before.jobs.length);
      await page.evaluate(
        (settings) => window.relay.command("settings.save", settings),
        state.settings,
      );
      const appInfo = await app.evaluate(({ app }) => ({
        version: app.getVersion(),
        packaged: app.isPackaged,
        userData: app.getPath("userData"),
      }));
      assert(appInfo.packaged);
      assert.equal(appInfo.version, require("../../package.json").version);
      const pipe = await promisify(execFile)(
        process.execPath,
        [
          path.resolve(__dirname, "../relay.cjs"),
          "status",
          "--data-dir",
          appInfo.userData,
        ],
        { windowsHide: true, timeout: 15000 },
      );
      assert.equal(pipe.stderr, "");
      report.boots.push({
        attempt: attempt + 1,
        elapsedMs: Date.now() - started,
        ...appInfo,
        unchangedSettingsSaved: true,
        namedPipe: "passed",
      });
    } finally {
      if (app) {
        await app.evaluate(({ app }) => app.quit()).catch(() => {});
        await app.close().catch(() => {});
      }
    }
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  await fs.writeFile(
    path.resolve(__dirname, "../../qa-output/installed-startup-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
