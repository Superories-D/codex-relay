// Deterministically reloads a real renderer during its initial navigation.
// Owned empty profile, no accounts, no model turns. Override Main for baseline.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const profile = await fs.mkdtemp(path.join(output, "startup-reload-"));
  const entry = path.join(profile, "entry.cjs");
  const main =
    process.env.RELAY_STARTUP_MAIN || path.join(root, "dist/main/main.cjs");
  const baseline = process.env.RELAY_EXPECT_STARTUP_FAILURE === "1";
  await fs.writeFile(
    entry,
    `const { app, BrowserWindow, dialog } = require('electron'); app.setAppPath(${JSON.stringify(root)}); const load=BrowserWindow.prototype.loadFile; BrowserWindow.prototype.loadFile=function(...args){ this.webContents.once('dom-ready',()=>{console.info('QA_INITIAL_RELOAD');this.webContents.reload()}); return load.apply(this,args) }; dialog.showErrorBox=(title,message)=>console.error('QA_STARTUP_ERROR',title,message); require(${JSON.stringify(main)});`,
  );
  const env = {
    ...process.env,
    CODEX_RELAY_DATA_DIR: profile,
    CODEX_RELAY_STARTUP_TRACE: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, page;
  const report = {
    baseline,
    inferenceRequests: 0,
    logs: [],
    rendererErrors: [],
  };
  try {
    app = await _electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/electron.exe",
      ),
      args: [entry],
      env,
      timeout: 60000,
    });
    app.process().stdout.on("data", (b) => report.logs.push(String(b)));
    app.process().stderr.on("data", (b) => report.logs.push(String(b)));
    page = await app.firstWindow();
    page.on("pageerror", (e) => report.rendererErrors.push(e.message));
    await page
      .getByRole("button", { name: "新聊天", exact: true })
      .waitFor({ timeout: 15000 });
    const state = await page.evaluate(() => window.relay.command("snapshot"));
    assert.equal(state.accounts.length, 0);
    assert.equal(state.jobs.length, 0);
    assert(report.logs.some((v) => v.includes("QA_INITIAL_RELOAD")));
    assert(report.logs.some((v) => v.includes("renderer ready")));
    assert(!report.logs.some((v) => v.includes("QA_STARTUP_ERROR")));
    assert.deepEqual(report.rendererErrors, []);
    assert(!baseline, "Expected baseline startup abort");
    report.status = "passed";
  } catch (error) {
    report.error = error.message;
    report.status =
      baseline && report.logs.some((v) => v.includes("ERR_ABORTED"))
        ? "reproduced"
        : "failed";
    if (report.status !== "reproduced") throw error;
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    await fs.writeFile(
      path.join(
        output,
        baseline
          ? "startup-reload-baseline-report.json"
          : "startup-reload-native-report.json",
      ),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
