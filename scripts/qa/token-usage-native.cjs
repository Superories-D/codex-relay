// Actual Electron rendering of isolated saved usage snapshots. No accounts/model calls.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { _electron } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "../.."), output = path.join(root, "qa-output");
const counts = (n) => ({ totalTokens: n, inputTokens: n, outputTokens: 0, cachedInputTokens: 0 });
(async () => {
  const profile = await fs.mkdtemp(path.join(output, "token-usage-native-"));
  const cwd = path.join(profile, "project");
  await fs.mkdir(cwd);
  const total = { ...counts(46_867_019), inputTokens: 46_660_479, outputTokens: 206_540 };
  const fixtures = [
    ["Current context", { ...total, last: counts(45_000), modelContextWindow: 200_000 }],
    ["Compacted context", { ...total, totalTokens: 46_877_019, last: counts(16_000), modelContextWindow: 200_000 }],
    ["Legacy totals", { ...total, modelContextWindow: 200_000 }],
    ["Unknown window", { ...total, last: counts(45_000), modelContextWindow: null }],
    ["Zero context", { ...total, last: counts(0), modelContextWindow: 200_000 }],
    ["Above window", { ...total, last: counts(220_000), modelContextWindow: 200_000 }],
  ];
  const jobs = fixtures.map(([title, tokenUsage], i) => ({
    id: randomUUID(), title, tokenUsage, cwd, prompt: "No inference",
    mode: "cli", model: "", effort: "", bucket: "codex", state: "completed",
    rotations: 0, createdAt: Date.now() + i, updatedAt: Date.now() + i,
    approvalPolicy: "on-request", sandbox: "workspaceWrite", interactive: true,
  }));
  await fs.writeFile(path.join(profile, "state.json"), JSON.stringify({ version: 1, accounts: [], jobs, logs: [], cursor: 0, settings: { resetWarmupEnabled: false } }));
  await fs.writeFile(path.join(profile, "desktop.json"), JSON.stringify({ projects: [{ id: randomUUID(), name: "Token usage QA", cwd, pinned: true }], schedules: [], preferences: { language: "zh-CN", theme: "dark", notifications: false } }));
  const report = { profile, inferenceRequests: 0, errors: [], checks: [] };
  let app, page;
  try {
    const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: path.join(root, "node_modules/electron/dist/electron.exe"), args: [root], env, timeout: 60000 });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => report.errors.push(e.message));
    const select = (title) => page.getByRole("button", { name: title, exact: true }).last().click();
    const card = page.locator(".usage-card");
    await select("Current context");
    const info = page.getByRole("button", { name: "会话信息", exact: true });
    if (await info.getAttribute("aria-pressed") !== "true") await info.click();
    await card.waitFor();
    assert.equal(await card.locator(".usage-current").innerText(), "45,000 / 200,000 tokens");
    assert.equal(await card.getByRole("meter").getAttribute("aria-valuenow"), "22.5");
    assert.ok((await card.locator("summary").innerText()).includes("46,867,019"));
    await card.locator("summary").focus();
    await page.keyboard.press("Enter");
    await card.locator("details[open]").waitFor();
    await card.locator("details small").waitFor({ state: "visible" });
    assert.ok((await card.locator("details small").innerText()).includes("46,660,479"));
    await select("Compacted context");
    assert.equal(await card.getByRole("meter").getAttribute("aria-valuenow"), "8");
    assert.ok((await card.locator("summary").innerText()).includes("46,877,019"));
    await select("Legacy totals");
    await card.getByText("当前上下文用量暂不可用", { exact: true }).waitFor();
    assert.equal(await card.getByRole("meter").count(), 0);
    assert.equal(await card.locator(".usage-current").count(), 0);
    await select("Unknown window");
    assert.equal(await card.locator(".usage-current").innerText(), "45,000 tokens");
    assert.equal(await card.getByRole("meter").count(), 0);
    await select("Zero context");
    assert.equal(await card.getByRole("meter").getAttribute("aria-valuenow"), "0");
    await select("Above window");
    assert.equal(await card.getByRole("meter").getAttribute("aria-valuenow"), "100");
    assert.equal(await card.locator(".usage-current").innerText(), "220,000 / 200,000 tokens");
    report.checks.push("saved current/compacted/legacy/null-window/zero/over-window snapshots render distinctly; cumulative details open by keyboard");
    await select("Current context");
    await page.screenshot({ path: path.join(output, "token-usage-native-zh.png") });
    for (const [language, label, settings, languageLabel] of [
      ["en", "Thread total", "设置", "语言"],
      ["zh-TW", "執行緒累計用量", "Settings", "Language"],
      ["ja", "スレッドの累計使用量", "設定", "語言"],
    ]) {
      await page.getByRole("button", { name: settings, exact: true }).click();
      await page.getByLabel(languageLabel, { exact: true }).selectOption(language);
      await page.locator(`html[lang='${language}']`).waitFor();
      await page.locator(".settings-page .feature-header button").click();
      assert.ok((await card.locator("summary").innerText()).includes(label), `${language} translated cumulative label`);
      assert.equal(await card.getByRole("meter").getAttribute("aria-valuenow"), "22.5");
    }
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "外観", exact: true }).click();
    await page.getByRole("button", { name: "ライト", exact: true }).click();
    await page.locator(".desktop-shell[data-theme='light']").waitFor();
    await page.locator(".settings-page .feature-header button").click();
    const viewport = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(1100, 800);
      window.webContents.setZoomFactor(1.25);
      return window.getContentSize().map((value) => value / 1.25);
    });
    await page.waitForFunction(([width, height]) => Math.abs(innerWidth - width) <= 2 && Math.abs(innerHeight - height) <= 2, viewport);
    await card.scrollIntoViewIfNeeded();
    assert.ok(await card.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    await page.waitForFunction(() => {
      const bounds = document.querySelector(".usage-card").getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth + 1;
    });
    report.geometry = await card.evaluate((e) => ({ card: e.getBoundingClientRect().toJSON(), viewport: [innerWidth, innerHeight] }));
    await page.screenshot({ path: path.join(output, "token-usage-native-ja-light.png") });
    await page.reload();
    await select("Current context");
    const infoJa = page.getByRole("button", { name: "会話の情報", exact: true });
    if (await infoJa.getAttribute("aria-pressed") !== "true") await infoJa.click();
    await card.waitFor();
    assert.equal(await card.getByRole("meter").getAttribute("aria-valuenow"), "22.5");
    report.checks.push("four languages, Japanese light theme at 125% zoom, narrow card geometry and reload preserve distinct usage");
    assert.deepEqual(report.errors, []);
    report.status = "passed";
  } catch (error) {
    report.failure = String(error);
    if (page) await page.screenshot({ path: path.join(output, "token-usage-native-failed.png") }).catch(() => {});
    throw error;
  } finally {
    const watchdog = app && setTimeout(() => execFile("taskkill", ["/PID", String(app.process().pid), "/T", "/F"], { windowsHide: true }), 15000);
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    clearTimeout(watchdog);
    await fs.writeFile(path.join(output, "token-usage-native-report.json"), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));
})().catch((error) => { console.error(error); process.exitCode = 1; });
