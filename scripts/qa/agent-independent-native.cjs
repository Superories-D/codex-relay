// Reopens the completed live corpus, with all QA accounts disabled. Three UI
// languages, narrow layout, original child navigation, no new model turns.
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
      path.join(output, "agent-independent-live-report.json"),
      "utf8",
    ),
  );
  assert.equal(seed.status, "passed");
  const profile = await fs.realpath(seed.profile);
  assert(profile.startsWith((await fs.realpath(output)) + path.sep));
  const env = {
    ...process.env,
    CODEX_RELAY_DATA_DIR: profile,
    CODEX_RELAY_DISABLE_RESET_WARMUP: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.RELAY_EXECUTABLE;
  let app, page, call, enabled, preferences;
  const report = {
    status: "running",
    newTurns: 0,
    languages: [],
    rendererErrors: [],
  };
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
    await page.waitForLoadState("load");
    await page.getByRole("button", { name: "新聊天", exact: true }).waitFor();
    call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    const state = await call("snapshot");
    assert(
      !state.jobs.some(
        (j) =>
          j.recoveryRequired ||
          [
            "queued",
            "preparing",
            "running",
            "waiting",
            "rotating",
            "pausing",
          ].includes(j.state),
      ),
    );
    enabled = state.accounts.map((a) => ({ id: a.id, enabled: a.enabled }));
    for (const a of enabled)
      if (a.enabled) await call("account.update", { id: a.id, enabled: false });
    preferences = (await call("desktop.read")).preferences;
    const parent = state.jobs.find((j) => j.id === seed.parentId),
      child = state.jobs.find((j) => j.id === seed.childId);
    assert(parent && child);
    const before = (await call("chat.turns", { id: child.id })).data.length;
    for (const [language, open, back, details, agents] of [
      ["zh-CN", "打开子代理聊天", "返回主会话", "会话信息", "代理"],
      [
        "en",
        "Open agent chat",
        "Back to parent chat",
        "Chat details",
        "Agents",
      ],
      ["zh-TW", "開啟子代理聊天", "返回主會話", "會話資訊", "代理"],
    ]) {
      await call("desktop.preferences", {
        language,
        theme: language === "en" ? "light" : "dark",
      });
      await page.reload();
      await page
        .getByRole("button", { name: parent.title, exact: true })
        .click();
      if (!(await page.locator(".workbench-tabs").count()))
        await page.getByRole("button", { name: details, exact: true }).click();
      await page
        .locator(".workbench-tabs")
        .getByRole("button", { name: new RegExp(agents) })
        .click();
      await page.locator(".agent-tree > button").first().click();
      const button = page.getByRole("button", { name: open, exact: true });
      assert(await button.isEnabled());
      await button.click();
      await page.getByRole("button", { name: back, exact: true }).waitFor();
      assert.equal(
        (await call("snapshot")).jobs.filter((j) => j.threadId === child.id)
          .length,
        1,
      );
      const permission = page
        .getByRole("combobox")
        .filter({ has: page.locator('option[value="native"]') });
      assert.equal(await permission.inputValue(), "native");
      await page
        .locator(".agent-transcript")
        .getByText(/CHILD_INDEPENDENT_OK SEED=41 FOLLOWUP=42/)
        .waitFor();
      assert.equal(await page.locator(".agent-message.user .katex").count(), 0);
      for (const width of [1440, 900]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({
          path: path.join(
            output,
            `desktop-independent-${language}-${width}.png`,
          ),
        });
      }
      await page.getByRole("button", { name: back, exact: true }).click();
      await page.locator(".agent-tree").waitFor();
      report.languages.push(language);
    }
    assert.equal(
      (await call("chat.turns", { id: child.id })).data.length,
      before,
    );
    assert.deepEqual(report.rendererErrors, []);
    report.status = "passed";
  } catch (e) {
    report.status = "failed";
    report.error = e.message;
    if (page)
      await page
        .screenshot({
          path: path.join(output, "agent-independent-native-failed.png"),
        })
        .catch(() => {});
    throw e;
  } finally {
    if (app && call) {
      if (preferences)
        await call("desktop.preferences", {
          language: preferences.language,
          theme: preferences.theme,
        }).catch(() => {});
      for (const a of enabled || [])
        await call("account.update", a).catch(() => {});
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    await fs.writeFile(
      path.join(output, "agent-independent-native-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
