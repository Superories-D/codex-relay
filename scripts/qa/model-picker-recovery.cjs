// Production renderer, controlled IPC failures; no accounts or inference.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const { chromium } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const { fixture } = require("./workspace-visual.cjs");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    syntheticData: true,
    inferenceTurns: 0,
    errors: [],
    checks: [],
  };
  const server = http.createServer((req, res) => {
    const file = path.resolve(
      root,
      "dist/renderer",
      "." + (req.url === "/" ? "/index.html" : req.url),
    );
    if (!file.startsWith(path.join(root, "dist/renderer") + path.sep))
      return res.writeHead(403).end();
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    fs.createReadStream(file)
      .on("error", () => res.end())
      .pipe(res);
  });
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({
      executablePath: process.env.RELAY_CHROMIUM_PATH,
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.addInitScript(fixture, { theme: "dark", language: "en" });
    await page.addInitScript(() => {
      const command = window.relay.command;
      const subscribe = window.relay.onSnapshot;
      window.relay.onSnapshot = (fn) => {
        window.pushCatalogSnapshot = fn;
        return subscribe(fn);
      };
      window.catalogTest = { remainingFailures: 2, calls: 0, pending: false };
      window.relay.command = async (name, args) => {
        if (name === "cli.status")
          return { phase: "ready", version: "fixture" };
        if (name === "account.models") {
          const state = window.catalogTest;
          state.calls++;
          if (state.pending)
            await new Promise((resolve) => {
              window.releaseCatalog = resolve;
            });
          if (state.remainingFailures-- > 0)
            throw Error("CLI is not ready (fixture)");
        }
        return command(name, args);
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.catalogTest.calls === 1);
    await page.locator(".agent-model-trigger").press("ArrowDown");
    const popup = page.locator(".agent-model-popover");
    await popup.getByRole("alert").waitFor();
    await page.waitForFunction(() => window.catalogTest.calls === 2);
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => window.catalogTest.calls),
      2,
      "an open error does not spin retries",
    );
    await page.evaluate(() => {
      window.catalogTest.pending = true;
    });
    await popup.getByRole("button", { name: "Reload", exact: true }).click();
    await popup.getByRole("status").waitFor();
    await page.evaluate(() => {
      window.catalogTest.pending = false;
      window.releaseCatalog();
    });
    await popup.getByRole("slider").waitFor();
    await popup.locator(".agent-model-name").click();
    const selected = popup.locator('.agent-model-list [aria-pressed="true"]');
    await popup.locator('input[type="search"]').press('ArrowDown');
    assert.ok(
      await selected.evaluate((node) => node === document.activeElement),
    );
    await page.keyboard.press("Escape");
    assert.ok(
      await popup
        .locator(".agent-model-name")
        .evaluate((node) => node === document.activeElement),
    );
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "detached" });
    assert.ok(
      await page
        .locator(".agent-model-trigger")
        .evaluate((node) => node === document.activeElement),
    );
    await page.keyboard.press("ArrowUp");
    await popup.getByRole("slider").waitFor();
    assert.ok(
      await popup
        .getByRole("slider")
        .evaluate((node) => node === document.activeElement),
    );
    assert.equal(
      await page.evaluate(() => window.catalogTest.calls),
      3,
      "reopening a healthy catalog uses the cache",
    );
    await popup.locator(".agent-model-name").click();
    await page.evaluate(async () => {
      window.catalogTest.pending = true;
      const snapshot = await window.relay.snapshot();
      snapshot.accounts[0].enabled = false;
      window.pushCatalogSnapshot(snapshot);
    });
    await popup.getByRole("status").waitFor();
    await page.waitForFunction(() => window.catalogTest.calls === 4);
    await page.evaluate(() => {
      window.catalogTest.pending = false;
      window.releaseCatalog();
    });
    await selected.waitFor();
    await page.waitForFunction(() => document.querySelector('.agent-model-search input') === document.activeElement);
    report.checks.push(
      "failed startup read retries once on opening",
      "open failure has no retry loop",
      "manual retry survives delayed response",
      "nested Escape and keyboard entry preserve focus",
      "healthy catalog remains cached",
      "account catalog arriving after loading restores search focus",
    );
    assert.deepEqual(report.errors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } finally {
    fs.writeFileSync(
      path.join(output, "model-picker-recovery-report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
