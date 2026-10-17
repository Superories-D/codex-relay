// Explicitly targets an owned qa-output profile containing completed live-test history.
// Creates branches locally through the CLI. No turn/start or inference is requested.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const profile = await fs.realpath(
    process.env.RELAY_HISTORY_TEST_PROFILE ||
      path.join(output, "desktop-live-profile"),
  );
  assert.ok(
    profile.startsWith((await fs.realpath(output)) + path.sep),
    "Only owned qa-output profiles are allowed",
  );
  const seed = JSON.parse(
    await fs.readFile(
      path.join(output, "desktop-subagents-report.json"),
      "utf8",
    ),
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const errors = [],
    report = { inferenceRequests: 0, source: seed.jobId };
  let app;
  const launch = () =>
    _electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/electron.exe",
      ),
      args: [root],
      env,
      timeout: 60000,
    });
  try {
    app = await launch();
    let page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    let call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    await page
      .getByRole("button", { name: "Desktop 真实子代理验收", exact: true })
      .click();
    const source = await call("chat.turns", { id: seed.jobId });
    assert.equal(source.data.length, 2);
    const target = source.data[0],
      draft = target.items
        .filter((i) => i.type === "userMessage")
        .flatMap((i) => i.content)
        .map((p) => p.text || "")
        .join("\n\n");
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "会话历史与编辑", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "会话历史", exact: true });
    await dialog
      .locator(".turn-history-entry")
      .first()
      .getByRole("button", { name: "编辑并创建分支", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await page
        .getByLabel("消息", { exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
      "new branch draft receives focus after modal exit",
    );
    assert.equal(
      await page.getByLabel("消息", { exact: true }).inputValue(),
      draft,
    );
    let snapshot = await page.evaluate(() => window.relay.snapshot());
    const fork = snapshot.jobs
      .filter((j) => j.id !== seed.jobId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    assert.notEqual(fork.threadId, seed.parent.threadId);
    assert.equal(fork.runtimeHomeId, seed.jobId);
    const retained = await call("chat.turns", { id: fork.id });
    assert.equal(retained.data.length, 1);
    assert.ok(
      (await call("chat.read", { id: fork.id })).items.some((i) =>
        i.text.includes("SUBAGENTS_OK"),
      ),
    );
    assert.ok(
      !(await call("chat.read", { id: fork.id })).items.some((i) =>
        i.text.includes("MEMORY_OK:"),
      ),
    );
    assert.equal((await call("chat.turns", { id: seed.jobId })).data.length, 2);
    const nested = await call("chat.branchAt", {
      id: fork.id,
      lastTurnId: retained.data[0].id,
    });
    assert.equal(nested.runtimeHomeId, seed.jobId);
    assert.equal((await call("chat.turns", { id: nested.id })).data.length, 1);
    const empty = await call("chat.branchAt", {
      id: seed.jobId,
      beforeTurnId: source.data.at(-1).id,
    });
    assert.equal((await call("chat.turns", { id: empty.id })).data.length, 0);
    report.editExcludesSelectedAndLaterTurns = "passed";
    report.originalPreserved = "passed";
    report.nestedAndEmptyBranches = "passed";
    await page.screenshot({
      path: path.join(output, "desktop-history-edit.png"),
    });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    await page.getByRole("button", { name: "新聊天", exact: true }).waitFor();
    assert.equal((await call("chat.turns", { id: fork.id })).data.length, 1);
    assert.equal((await call("chat.turns", { id: seed.jobId })).data.length, 2);
    assert.deepEqual(errors, []);
    report.restartPersistence = "passed";
    report.rendererErrors = errors;
    await fs.writeFile(
      path.join(output, "history-native-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    if (app) await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
