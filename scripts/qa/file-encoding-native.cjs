// Actual Electron file preview/edit with synthetic local files and no accounts.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { randomUUID } = require("node:crypto"), { execFile } = require("node:child_process");
const { _electron } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "../.."), output = path.join(root, "qa-output");
(async () => {
  const profile = await fs.mkdtemp(path.join(output, "file-encoding-native-"));
  const cwd = path.join(profile, "project");
  await fs.mkdir(cwd);
  const legacy = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
  await fs.writeFile(path.join(cwd, "legacy.txt"), legacy);
  await fs.writeFile(path.join(cwd, "unicode.txt"), "\ufeff日本語 中文 😀\r\n");
  const now = Date.now(), id = randomUUID();
  await fs.writeFile(path.join(profile, "state.json"), JSON.stringify({ version: 1, accounts: [], logs: [], cursor: 0, settings: { resetWarmupEnabled: false }, jobs: [{ id, title: "File encoding fixture", prompt: "No inference", cwd, mode: "cli", model: "", effort: "", bucket: "codex", state: "completed", interactive: true, rotations: 0, createdAt: now, updatedAt: now, sandbox: "workspaceWrite", approvalPolicy: "on-request" }] }));
  await fs.writeFile(path.join(profile, "desktop.json"), JSON.stringify({ projects: [{ id: randomUUID(), name: "Encoding QA", cwd }], schedules: [], preferences: { language: "zh-CN", theme: "dark", notifications: false } }));
  const report = { profile, inferenceRequests: 0, errors: [], checks: [] };
  let app, page;
  try {
    const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: path.join(root, "node_modules/electron/dist/electron.exe"), args: [root], env, timeout: 60000 });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => report.errors.push(e.message));
    const call = (name, args) => page.evaluate(({ name, args }) => window.relay.command(name, args), { name, args });
    await page.getByRole("button", { name: "File encoding fixture", exact: true }).last().click();
    await page.getByRole("button", { name: "项目文件", exact: true }).click();
    await page.locator(".file-tree").getByRole("button", { name: "legacy.txt", exact: true }).click();
    const preview = page.locator(".file-preview");
    await preview.getByText("无法按 UTF-8 读取此文件，请在外部编辑器中打开以保留原始编码", { exact: true }).waitFor();
    assert.equal(await preview.getByTitle("编辑文件", { exact: true }).count(), 0);
    await preview.getByTitle("在默认应用中打开", { exact: true }).waitFor();
    const read = await call("workspace.read", { cwd, path: "legacy.txt" });
    await assert.rejects(call("workspace.write", { cwd, path: "legacy.txt", text: "destructive replacement", mtime: read.mtime }), /UTF-8/);
    assert.deepEqual(await fs.readFile(path.join(cwd, "legacy.txt")), legacy);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("语言", { exact: true }).selectOption("ja");
    await page.locator("html[lang='ja']").waitFor();
    await page.locator(".settings-page .feature-header button").click();
    // Returning from settings mounts the workbench again; select the file anew.
    if (await page.locator(".file-tree").count())
      await page.locator(".file-tree").getByRole("button", { name: "legacy.txt", exact: true }).click();
    await preview.getByText("このファイルは UTF-8 として読み取れません。文字コードを保持するため、外部エディターで開いてください。", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "file-encoding-native-ja.png") });
    await preview.locator("header button").first().click();
    await page.locator(".file-tree").getByRole("button", { name: "unicode.txt", exact: true }).click();
    await preview.getByTitle("ファイルを編集", { exact: true }).click();
    const replacement = "\ufeff日本語を編集しました 😀\n";
    await preview.locator("textarea.file-editor").fill(replacement);
    await preview.getByTitle("ファイルを保存", { exact: true }).click();
    const deadline = Date.now() + 10000;
    while ((await fs.readFile(path.join(cwd, "unicode.txt"), "utf8")) !== replacement) {
      assert.ok(Date.now() < deadline, "UTF-8 edit did not persist");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await fs.readFile(path.join(cwd, "legacy.txt")), legacy);
    assert.deepEqual(report.errors, []);
    report.checks.push("legacy bytes remain intact after Chinese/Japanese preview and rejected direct IPC write; external-open affordance remains available; Japanese UTF-8/BOM text saves through the actual editor");
    report.status = "passed";
  } catch (error) {
    report.failure = String(error);
    if (page) await page.screenshot({ path: path.join(output, "file-encoding-native-failed.png") }).catch(() => {});
    throw error;
  } finally {
    const watchdog = app && setTimeout(() => execFile("taskkill", ["/PID", String(app.process().pid), "/T", "/F"], { windowsHide: true }), 15000);
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    clearTimeout(watchdog);
    await fs.writeFile(path.join(output, "file-encoding-native-report.json"), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));
})().catch((error) => { console.error(error); process.exitCode = 1; });
