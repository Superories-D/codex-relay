// Test a self-extracting portable executable via Chromium CDP. The NSIS launcher
// does not expose the Node inspector required by Playwright's Electron launcher.
const fs = require("node:fs/promises"), path = require("node:path"), net = require("node:net"), assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process"), { promisify } = require("node:util");
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const version = require("../../package.json").version, stamp = version.replaceAll(".", "");
const root = path.resolve(__dirname, "../.."), output = path.join(root, "qa-output");
(async () => {
  const profile = await fs.mkdtemp(path.join(output, `portable-${stamp}-`));
  const installed = JSON.parse(await fs.readFile(path.join(output, "cli-install-native-report.json")));
  const cliPath = JSON.parse(await fs.readFile(path.join(installed.fixture, "selected-cli.json"))).cli;
  await fs.writeFile(path.join(profile, "state.json"), JSON.stringify({ version: 1, accounts: [], jobs: [], logs: [], cursor: 0, settings: { cliPath, resetWarmupEnabled: false } }));
  await fs.writeFile(path.join(profile, "desktop.json"), JSON.stringify({ projects: [], schedules: [], preferences: { theme: "dark", language: "zh-CN", notifications: false, closeToTray: false } }));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const executable = process.env.RELAY_EXECUTABLE || path.join(root, `release/desktop-${version}/Codex-Relay-Portable-${version}-x64.exe`);
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], { env, windowsHide: true, stdio: "ignore" });
  let browser;
  const report = { profile, modelRequests: 0, errors: [] };
  try {
    const deadline = Date.now() + 45000;
    while (true) {
      if (child.exitCode !== null) throw Error(`Portable exited ${child.exitCode}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
      if (Date.now() > deadline) throw Error("Portable CDP startup timed out");
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0], page = context.pages()[0] || await context.waitForEvent("page");
    page.on("pageerror", e => report.errors.push(e.message)); await page.locator('.agent-shell').waitFor();
    let status;
    do {
      status = await page.evaluate(() => window.relay.command("cli.status"));
      if (status.phase === "ready" || status.phase === "error") break;
      if (Date.now() > deadline) throw Error("CLI startup timed out");
      await new Promise(resolve => setTimeout(resolve, 150));
    } while (true);
    assert.equal(status.phase, "ready", status.error); assert.equal(status.path, cliPath);
    const snapshot = await page.evaluate(() => window.relay.snapshot());
    assert.equal(snapshot.accounts.length, 0); assert.equal(snapshot.jobs.length, 0);
    assert.deepEqual(report.errors, []);
    report.cliVersion = status.version; report.status = "passed";
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.close").catch(error => { if (!/closed/i.test(error.message)) throw error; });
    await browser.close().catch(error => { if (!/closed/i.test(error.message)) throw error; }); browser = undefined;
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) {
      await new Promise(resolve => { const timer = setTimeout(resolve, 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
      if (child.exitCode === null) { report.status = 'failed-close'; await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {}); }
    }
    await fs.writeFile(path.join(output, `portable-${stamp}-report.json`), JSON.stringify(report, null, 2));
  }
  assert.equal(report.status, 'passed');
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
