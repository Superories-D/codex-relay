// Production renderer and synthetic setup phases; no downloads or CLI calls.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const { chromium } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const { fixture } = require("./review-ui.cjs");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const report = { modelRequests: 0, downloads: 0, layouts: [], errors: [] };
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
    for (const [language, theme, width] of [
      ["en", "dark", 1280],
      ["zh-CN", "light", 1280],
      ["ja", "dark", 900],
      ["zh-TW", "light", 900],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 850 } });
      page.on("pageerror", (e) => report.errors.push(e.message));
      await page.addInitScript(fixture, { language, theme });
      await page.addInitScript(() => {
        const command = window.relay.command;
        let state = { phase: "checking" };
        window.cliTestPhase = (value) => {
          state = value;
        };
        window.cliRetries = 0;
        window.relay.command = async (name, args) => {
          if (name === "cli.status") return structuredClone(state);
          if (name === "cli.ensure") {
            window.cliRetries++;
            state = { phase: "installing" };
            await new Promise((resolve) => setTimeout(resolve, 1800));
            state = { phase: "ready", version: "codex-cli fixture" };
            return structuredClone(state);
          }
          return command(name, args);
        };
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const notice = page.locator(".cli-setup-notice");
      await notice.waitFor();
      assert.equal(await notice.getAttribute("role"), "status");
      await page.evaluate(() => window.cliTestPhase({ phase: "downloading" }));
      await notice.locator("svg.lucide-download").waitFor();
      await page.screenshot({
        path: path.join(output, `cli-setup-downloading-${language}.png`),
      });
      await page.evaluate(() =>
        window.cliTestPhase({
          phase: "error",
          error: "Synthetic network failure; no credentials.",
        }),
      );
      await notice.locator("button").waitFor();
      assert.equal(await notice.getAttribute("role"), "alert");
      await notice.locator("summary").click();
      await page.waitForFunction(() => document.querySelector('.cli-setup-notice pre')?.innerText.includes('Synthetic network failure'));
      assert.match(
        await notice.locator("pre").innerText(),
        /Synthetic network failure/,
      );
      await page.screenshot({
        path: path.join(output, `cli-setup-error-${language}.png`),
      });
      await notice.locator("button").click();
      await page.waitForFunction(
        () =>
          document.querySelector(".cli-setup-notice")?.getAttribute("role") ===
          "status",
      );
      await notice.waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => window.cliRetries), 1);
      assert.ok(await page.locator(".agent-composer textarea").isEnabled());
      report.layouts.push({ language, theme, width });
      await page.close();
    }
    assert.deepEqual(report.errors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } finally {
    fs.writeFileSync(
      path.join(output, "cli-setup-ui-report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
