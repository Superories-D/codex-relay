// Run with RELAY_PLAYWRIGHT_MODULE pointing to a locally installed Playwright.
// Uses an isolated profile; never logs in or submits a task.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);

(async () => {
  const root = path.resolve(__dirname, "../..");
  const output = path.join(root, "qa-output");
  await fs.mkdir(output, { recursive: true });
  const executablePath =
    process.env.RELAY_EXECUTABLE ||
    path.join(root, "release/win-unpacked/Codex Relay.exe");
  const profile = await fs.mkdtemp(path.join(output, "packaged-profile-"));
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [],
      schedules: [],
      preferences: { theme: "dark", notifications: false, language: "zh-CN" },
    }),
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath, env, timeout: 60000 });
  app.process().stderr.on("data", (chunk) => process.stderr.write(chunk));
  app.on("console", (message) => console.log("main:", message.text()));
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "新聊天", exact: true }).waitFor();
    const runtime = await app.evaluate(({ app, safeStorage }) => {
      const probe = "Codex Relay Windows encryption probe";
      return {
        packaged: app.isPackaged,
        version: app.getVersion(),
        dataRoot: app.getPath("userData"),
        encrypted:
          safeStorage.isEncryptionAvailable() &&
          safeStorage.decryptString(safeStorage.encryptString(probe)) === probe,
      };
    });
    assert.equal(runtime.packaged, true);
    assert.equal(runtime.encrypted, true);
    const snapshot = await page.evaluate(() => window.relay.snapshot());
    assert.ok(Array.isArray(snapshot.jobs));
    const cli = await promisify(execFile)(
      process.execPath,
      [
        path.join(root, "scripts/relay.cjs"),
        "status",
        "--data-dir",
        runtime.dataRoot,
      ],
      { timeout: 15000, windowsHide: true },
    );
    assert.equal(cli.stderr, "");
    await page.getByRole("button", { name: "账户轮换", exact: true }).click();
    for (const name of [
      "常规",
      "外观",
      "账户与接力",
      "通知",
      "个人指令",
      "快捷键",
      "运行环境",
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
    }
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await page.getByRole("button", { name: "选择模型和思考强度" }).click();
    await page
      .getByText("请先在账户中添加并启用登录。", { exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: path.join(output, "windows-packaged.png") });
    assert.deepEqual(errors, []);
    const report = {
      ...runtime,
      executablePath,
      namedPipe: "passed",
      navigation: "passed",
      rendererErrors: errors,
    };
    await fs.writeFile(
      path.join(output, "windows-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
