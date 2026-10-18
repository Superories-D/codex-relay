// Real Electron rendering, isolated synthetic chat records, no model requests.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const profile = await fs.mkdtemp(path.join(output, "reasoning-native-")),
    id = randomUUID(),
    now = Date.now();
  await fs.mkdir(path.join(profile, "chats"));
  const job = {
    id,
    title: "Reasoning fixture",
    prompt: "Synthetic summary rendering",
    cwd: root,
    mode: "cli",
    model: "",
    effort: "",
    bucket: "codex",
    state: "completed",
    rotations: 0,
    createdAt: now,
    updatedAt: now,
    approvalPolicy: "on-request",
    sandbox: "workspaceWrite",
    interactive: true,
  };
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts: [],
      jobs: [job],
      logs: [],
      cursor: 0,
      settings: { resetWarmupEnabled: false },
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [
        { id: randomUUID(), name: "Summary QA", cwd: root, pinned: true },
      ],
      schedules: [],
      preferences: { language: "zh-CN", theme: "dark", notifications: false },
    }),
  );
  await fs.writeFile(
    path.join(profile, "chats", `${id}.jsonl`),
    [
      {
        id: "empty",
        role: "tool",
        kind: "reasoning",
        text: "",
        status: "completed",
        at: now,
        detail: '{"type":"reasoning","summary":[],"content":[]}',
      },
      {
        id: "summary",
        role: "tool",
        kind: "reasoning",
        text: "**Public summary fixture**\n\n日本語の要約。",
        status: "completed",
        at: now + 1,
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const report = { profile, inferenceRequests: 0, checks: [], errors: [] };
  let app, page;
  try {
    const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
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
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page
      .getByRole("button", { name: job.title, exact: true })
      .last()
      .click();
    const entries = page.locator(".reasoning-activity");
    await entries.nth(1).waitFor();
    for (let i = 0; i < 2; i++) await entries.nth(i).locator("summary").click();
    await entries
      .first()
      .getByText("此条记录未提供可显示的思考摘要。", { exact: true })
      .waitFor();
    assert.equal(await entries.first().locator(".code-block").count(), 0);
    await entries.nth(1).locator("strong").waitFor({ state: "visible" });
    assert.equal(
      await entries.nth(1).locator("strong").innerText(),
      "Public summary fixture",
    );
    assert.ok((await entries.nth(1).innerText()).includes("日本語の要約。"));
    await page.screenshot({
      path: path.join(output, "reasoning-native-zh.png"),
    });
    report.checks.push(
      "expanded legacy empty JSON is replaced by a clear empty state; actual summary renders markdown and paragraphs",
    );
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("语言", { exact: true }).selectOption("ja");
    await page.locator("html[lang='ja']").waitFor();
    await page.locator(".settings-page .feature-header button").click();
    for (let i = 0; i < 2; i++) {
      if (
        !(await entries
          .nth(i)
          .locator("details")
          .evaluate((element) => element.open))
      )
        await entries.nth(i).locator("summary").click();
    }
    await entries
      .first()
      .getByText("この項目には表示できる思考の要約がありません。", {
        exact: true,
      })
      .waitFor();
    await entries.nth(1).locator("strong").waitFor({ state: "visible" });
    assert.equal(
      await entries.nth(1).locator("strong").innerText(),
      "Public summary fixture",
    );
    await page.screenshot({
      path: path.join(output, "reasoning-native-ja.png"),
    });
    report.checks.push(
      "Japanese switching localizes empty-state text and preserves original summary",
    );
    assert.deepEqual(report.errors, []);
    report.status = "passed";
  } catch (error) {
    report.failure = String(error);
    if (page) {
      report.reasoning = await page
        .locator(".reasoning-activity")
        .evaluateAll((entries) => entries.map((entry) => entry.outerHTML))
        .catch(() => []);
      await page
        .screenshot({ path: path.join(output, "reasoning-native-failed.png") })
        .catch(() => {});
    }
    throw error;
  } finally {
    const watchdog =
      app &&
      setTimeout(
        () =>
          execFile(
            "taskkill",
            ["/PID", String(app.process().pid), "/T", "/F"],
            { windowsHide: true },
          ),
        15000,
      );
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    clearTimeout(watchdog);
    await fs.writeFile(
      path.join(output, "reasoning-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
