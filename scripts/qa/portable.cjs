// Exercises the final self-extracting launcher with a new isolated profile.
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { chromium } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
(async () => {
  const root = path.resolve(__dirname, "../.."),
    output = path.join(root, "qa-output");
  const { version } = require(path.join(root, "package.json"));
  const profile = await fs.mkdtemp(path.join(output, "portable-profile-"));
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [],
      schedules: [],
      preferences: { theme: "dark", notifications: false, language: "zh-CN" },
    }),
  );
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable =
    process.env.RELAY_EXECUTABLE ||
    path.join(root, `release/Codex-Relay-Portable-${version}-x64.exe`);
  const child = spawn(
    executable,
    [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    { env, windowsHide: true, stdio: "ignore" },
  );
  let browser;
  try {
    const deadline = Date.now() + 60000;
    while (true) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
      } catch {}
      if (Date.now() > deadline) throw Error("Portable startup timed out");
      await new Promise((r) => setTimeout(r, 300));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page =
      context.pages()[0] ||
      (await context.waitForEvent("page", { timeout: 30000 }));
    await page.getByRole("button", { name: "新聊天", exact: true }).waitFor();
    const cliPath = path.join(
      root,
      "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    );
    const checks = await page.evaluate(async (cliPath) => {
      const snapshot = await window.relay.snapshot();
      if (snapshot.jobs.length || snapshot.accounts.length)
        throw Error("QA profile must be empty");
      await window.relay.command("settings.save", {
        ...snapshot.settings,
        cliPath,
      });
      return window.relay.command("environment.check");
    }, cliPath);
    assert.ok(
      checks.checks
        .filter((x) =>
          ["运行平台", "Codex CLI", "Windows PowerShell"].includes(x.name),
        )
        .every((x) => x.status === "ok"),
    );
    const pipe = await promisify(execFile)(
      process.execPath,
      [path.join(root, "scripts/relay.cjs"), "status", "--data-dir", profile],
      { windowsHide: true, timeout: 15000 },
    );
    assert.equal(pipe.stderr, "");
    await page.screenshot({ path: path.join(output, "portable-agent.png") });
    const report = {
      version,
      executable,
      portableStartup: "passed",
      namedPipe: "passed",
      ...checks,
    };
    await fs.writeFile(
      path.join(output, "portable-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.close");
    await browser.close();
  } catch (e) {
    if (browser) {
      const cdp = await browser.newBrowserCDPSession().catch(() => undefined);
      await cdp?.send("Browser.close").catch(() => {});
      await browser.close().catch(() => {});
    }
    if (child.exitCode === null)
      await promisify(execFile)(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
      ).catch(() => {});
    throw e;
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
