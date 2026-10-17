// Reopen the actual completed live Goal in Electron, with every test account
// disabled. Assert original accounting, one user message, and real file/media.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const seed = JSON.parse(
    await fs.readFile(
      path.join(output, "goal-message-live-report.json"),
      "utf8",
    ),
  );
  assert.equal(seed.status, "passed");
  assert.equal(seed.automaticTurns, 1);
  assert.equal(seed.steerRequests, 1);
  const profile = await fs.realpath(seed.profile);
  assert(profile.startsWith((await fs.realpath(output)) + path.sep));
  const stateFile = path.join(profile, "state.json"),
    desktopFile = path.join(profile, "desktop.json"),
    state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert(
    state.jobs.every(
      (j) =>
        ["completed", "paused", "cancelled"].includes(j.state) &&
        !j.recoveryRequired,
    ),
  );
  const enabled = Object.fromEntries(
    state.accounts.map((a) => [a.id, a.enabled]),
  );
  for (const a of state.accounts) a.enabled = false;
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
  const originalDesktop = await fs.readFile(desktopFile, "utf8").catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return undefined;
  });
  const env = {
    ...process.env,
    CODEX_RELAY_DATA_DIR: profile,
    CODEX_RELAY_DISABLE_RESET_WARMUP: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.RELAY_EXECUTABLE;
  const report = {
    profile,
    inferenceRequests: 0,
    languages: [],
    checks: [],
    rendererErrors: [],
  };
  let app, page;
  try {
    app = await _electron.launch({
      executablePath:
        executable ||
        path.join(root, "node_modules/electron/dist/electron.exe"),
      args: executable ? [] : [root],
      env,
      timeout: 60000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => report.rendererErrors.push(e.message));
    const call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    for (const language of ["zh-CN", "en", "zh-TW"]) {
      await call("desktop.preferences", {
        language,
        theme: language === "en" ? "light" : "dark",
        notifications: false,
      });
      await page.reload();
      await page
        .getByRole("button", { name: "Goal pending message live", exact: true })
        .click();
      await page
        .getByText("GOAL_INPUT_LIVE_OK FILE=42 IMAGE=17", { exact: true })
        .waitFor();
      assert.equal(await page.locator(".agent-message.user").count(), 1);
      const thumbnail = page.locator(
        ".agent-message.user .chat-image-thumbnail",
      );
      assert.equal(await thumbnail.count(), 1);
      await thumbnail.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () =>
          document.querySelector(
            ".agent-message.user .chat-image-thumbnail img",
          )?.naturalWidth > 0,
      );
      await thumbnail.click();
      await page.locator(".image-viewer-stage img").waitFor();
      await page.screenshot({
        path: path.join(output, `desktop-goal-input-image-${language}.png`),
      });
      await page.keyboard.press("Escape");
      await page.locator(".image-viewer-stage").waitFor({ state: "hidden" });
      await page
        .locator(".agent-message.user .message-attachments button")
        .filter({ hasText: "note.txt" })
        .click();
      await page.getByText("FILE_VALUE=42", { exact: true }).waitFor();
      await page.screenshot({
        path: path.join(output, `desktop-goal-input-file-${language}.png`),
      });
      const snapshot = await call("snapshot"),
        job = snapshot.jobs.find((j) => j.id === seed.jobId);
      assert.equal(job.state, "completed");
      assert.equal(job.goal.status, "complete");
      assert.equal(job.goal.tokensUsed, seed.finalGoal.tokensUsed);
      assert.equal(job.goal.tokenBudget, seed.finalGoal.tokenBudget);
      assert(snapshot.accounts.every((a) => !a.enabled));
      await page
        .locator(".workbench-tabs")
        .getByRole("button", {
          name: language === "en" ? "Summary" : "摘要",
          exact: true,
        })
        .click();
      await page.locator(".goal-card").screenshot({
        path: path.join(output, `desktop-goal-input-card-${language}.png`),
      });
      report.languages.push(language);
    }
    const deadline = Date.now() + 10000;
    let turns;
    while (Date.now() < deadline) {
      try {
        turns = await call("chat.turns", { id: seed.jobId });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    assert(turns);
    assert.equal(turns.data.length, 1);
    report.nativeTurns = turns.data.length;
    report.checks = [
      "actual live answer and single user message",
      "actual attached image thumbnail and viewer",
      "actual mentioned file preview",
      "original completed Goal accounting",
      "native turn count unchanged with accounts disabled",
    ];
    assert.deepEqual(report.rendererErrors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } catch (e) {
    report.status = "failed";
    report.error = e.message;
    if (page)
      await page
        .screenshot({
          path: path.join(output, "goal-message-history-failed.png"),
        })
        .catch(() => {});
    throw e;
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    const latest = JSON.parse(await fs.readFile(stateFile, "utf8"));
    for (const a of latest.accounts) a.enabled = enabled[a.id];
    await fs.writeFile(stateFile, JSON.stringify(latest, null, 2));
    if (originalDesktop !== undefined)
      await fs.writeFile(desktopFile, originalDesktop);
    await fs.writeFile(
      path.join(output, "goal-message-history-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
