// Real Electron UI replay of the completed live question test. Copies only its
// chat journal into an account-free fixture; no new model turns or credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const seed = JSON.parse(
    await fs.readFile(path.join(output, "questions-live-report.json"), "utf8"),
  );
  assert.equal(seed.status, "passed");
  const source = await fs.realpath(seed.profile);
  assert(source.startsWith((await fs.realpath(output)) + path.sep));
  const profile = await fs.mkdtemp(path.join(output, "questions-native-"));
  const cwd = path.join(profile, "project");
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(profile, "chats"));
  const id = randomUUID(),
    title = "问题记录原生验收",
    now = Date.now();
  await fs.copyFile(
    path.join(source, "chats", seed.jobId + ".jsonl"),
    path.join(profile, "chats", id + ".jsonl"),
  );
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts: [],
      logs: [],
      cursor: 0,
      settings: { resetWarmupEnabled: false },
      jobs: [
        {
          id,
          title,
          cwd,
          prompt: "",
          mode: "cli",
          state: "completed",
          interactive: true,
          model: "",
          effort: "",
          bucket: "codex",
          sandbox: "readOnly",
          approvalPolicy: "never",
          rotations: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [{ id: randomUUID(), name: "Questions QA", cwd }],
      schedules: [],
      preferences: { language: "zh-CN", theme: "dark", notifications: false },
    }),
  );
  const executable = process.env.RELAY_EXECUTABLE,
    env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const report = {
    inferenceRequests: 0,
    accountCount: 0,
    languages: [],
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
    await page.waitForLoadState("load");
    await page.getByRole("button", { name: title, exact: true }).waitFor();
    const call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    for (const [language, questionTab, expired, answered] of [
      ["zh-CN", "问题", "问题已失效", "已回答"],
      ["en", "Questions", "Question expired", "Answered"],
      ["zh-TW", "問題", "問題已失效", "已回答"],
    ]) {
      await call("desktop.preferences", {
        language,
        theme: language === "en" ? "light" : "dark",
      });
      await page.reload();
      await page.getByRole("button", { name: title, exact: true }).click();
      if (!(await page.locator(".workbench-tabs").count()))
        await page
          .getByRole("button", {
            name:
              language === "en"
                ? "Chat details"
                : language === "zh-TW"
                  ? "會話資訊"
                  : "会话信息",
            exact: true,
          })
          .click();
      await page
        .locator(".workbench-tabs")
        .getByRole("button", { name: questionTab, exact: true })
        .click();
      await page.getByText(expired, { exact: true }).waitFor();
      await page.getByText(answered, { exact: true }).waitFor();
      assert.equal(await page.locator(".question-request").count(), 0);
      const history = await call("chat.questions.read", { id });
      assert.equal(history.items.length, 2);
      assert.equal(
        history.items.filter((q) => q.status === "answered").length,
        1,
      );
      assert.equal(
        history.items.filter((q) => q.status === "expired").length,
        1,
      );
      assert.equal((await call("snapshot")).accounts.length, 0);
      const row = page
        .locator(".question-history-item")
        .filter({ hasText: "Direction" });
      await row.locator("summary").click();
      await row.getByText("Custom-blue", { exact: true }).waitFor();
      await row.getByText("Smooth", { exact: true }).waitFor();
      for (const width of [1440, 900]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await page
          .locator(".workbench-tabs")
          .evaluate((header) => {
            const close = header
                .querySelector(".workbench-close")
                .getBoundingClientRect(),
              panel = header.getBoundingClientRect();
            const list = header.querySelector(".workbench-tab-list");
            return {
              closeVisible:
                close.x >= panel.x && close.right <= panel.right + 1,
              singleLine: [...list.querySelectorAll("button")].every(
                (b) => b.getBoundingClientRect().height <= 36,
              ),
            };
          });
        assert(
          geometry.closeVisible && geometry.singleLine,
          "Tabs remain horizontal and close stays visible",
        );
        await page.screenshot({
          path: path.join(
            output,
            `desktop-questions-history-${language}-${width}.png`,
          ),
        });
      }
      report.languages.push(language);
    }
    assert.deepEqual(report.rendererErrors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } catch (e) {
    report.status = "failed";
    report.error = e.message;
    if (page)
      await page
        .screenshot({ path: path.join(output, "questions-native-failed.png") })
        .catch(() => {});
    throw e;
  } finally {
    await fs.writeFile(
      path.join(output, "questions-native-report.json"),
      JSON.stringify(report, null, 2),
    );
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
