// Large synthetic CLI catalog in the production renderer. No inference or login.
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
  const report = {
    syntheticData: true,
    inferenceTurns: 0,
    layouts: [],
    errors: [],
  };
  let browser;
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
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({
      executablePath: process.env.RELAY_CHROMIUM_PATH,
      headless: true,
    });
    for (const [language, theme, width] of [
      ["en", "dark", 1600],
      ["zh-CN", "light", 900],
      ["zh-TW", "dark", 900],
      ["ja", "light", 1100],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height: 850 },
        deviceScaleFactor: 1.5,
      });
      page.on("pageerror", (e) => report.errors.push(e.message));
      await page.addInitScript(fixture, { theme, language });
      await page.addInitScript(() => {
        const command = window.relay.command;
        window.relay.command = async (name, args) => {
          if (name === "cli.status") return { phase: "ready" };
          const result = await command(name, args);
          if (name !== "account.models") return result;
          return [
            ...result,
            ...Array.from({ length: 64 }, (_, i) => ({
              ...result[0],
              id: `catalog-${i}`,
              model: `catalog-${i}`,
              displayName: `Worker Model ${i}`,
              isDefault: false,
            })),
            {
              ...result[0],
              id: "hidden-only",
              model: "hidden-only",
              displayName: "Private hidden option",
              hidden: true,
              isDefault: false,
            },
          ];
        };
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.locator(".agent-model-trigger").click();
      const popup = page.locator(".agent-model-popover");
      await popup.locator(".agent-model-name:not(:disabled)").waitFor();
      await popup.locator(".agent-model-name").click();
      const search = popup.locator('input[type="search"]'),
        rows = popup.locator(".agent-model-list button");
      assert.equal(await rows.count(), 72);
      assert.ok(
        await search.evaluate((node) => node === document.activeElement),
      );
      await search.fill("not-a-model");
      assert.equal(await rows.count(), 0);
      await popup.getByRole("status").waitFor();
      await search.press("Enter");
      assert.equal(await popup.getAttribute("data-view"), "models");
      await search.fill("worker model");
      assert.equal(await rows.count(), 64);
      await search.press("Enter");
      assert.equal(
        await popup.getAttribute("data-view"),
        "models",
        "ambiguous Enter does not choose",
      );
      await search.fill("ＣＡＴＡＬＯＧ－４２");
      assert.equal(await rows.count(), 1);
      assert.equal(await rows.first().innerText(), "Worker Model 42");
      await search.dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing: true,
      });
      assert.equal(
        await popup.getAttribute("data-view"),
        "models",
        "IME confirmation does not commit selection",
      );
      await search.dispatchEvent("keydown", {
        key: "Escape",
        code: "Escape",
        isComposing: true,
      });
      assert.equal(
        await popup.getAttribute("data-view"),
        "models",
        "IME cancel does not dismiss the picker",
      );
      await search.press("Enter");
      assert.equal(await popup.getAttribute("data-view"), "effort");
      assert.equal(
        await popup.locator(".agent-model-name").innerText(),
        "Worker Model 42",
      );
      await popup.locator(".agent-model-name").click();
      assert.equal(await search.inputValue(), "");
      assert.equal(await rows.count(), 72);
      await search.fill("hidden-only");
      assert.equal(
        await rows.count(),
        0,
        "search must not reveal hidden catalog entries",
      );
      await popup.locator(".agent-model-search button").click();
      assert.equal(await search.inputValue(), "");
      assert.ok(
        await search.evaluate((node) => node === document.activeElement),
      );
      await search.fill("Worker 63");
      assert.equal(await rows.count(), 1);
      await search.press("ArrowUp");
      assert.ok(
        await rows.last().evaluate((node) => node === document.activeElement),
      );
      await page.keyboard.press("Enter");
      assert.equal(
        await popup.locator(".agent-model-name").innerText(),
        "Worker Model 63",
      );
      await popup.locator(".agent-model-name").click();
      const defaultLabel = await popup.locator('.agent-model-default span').evaluate(node => node.firstChild.textContent);
      await search.fill(defaultLabel);
      assert.equal(await rows.count(), 1, 'localized default option is searchable');
      await search.press('Enter');
      await popup.locator('.agent-model-name').click();
      assert.equal(await popup.locator('.agent-model-default').getAttribute('aria-pressed'), 'true');
      await search.fill("model-0");
      assert.equal(await rows.count(), 1);
      await search.press("ArrowDown");
      assert.ok(
        await rows.first().evaluate((node) => node === document.activeElement),
      );
      await popup.screenshot({
        path: path.join(output, `model-search-${language}.png`),
      });
      const box = await popup.boundingBox();
      assert.ok(
        box.x >= 0 &&
          box.x + box.width <= width &&
          box.y >= 0 &&
          box.y + box.height <= 850,
      );
      const calls = await page.evaluate(() => window.visualCalls);
      assert.equal(
        calls.some((name) =>
          ["chat.send", "job.add", "chat.create"].includes(name),
        ),
        false,
      );
      report.layouts.push({
        language,
        theme,
        width,
        models: 72,
        checks: [
          "name/ID and multi-term search",
          "full-width normalization",
          "empty and ambiguous Enter",
          "IME Enter/Escape",
          "clear and reset",
          "hidden model filtering",
          "arrow navigation",
          "viewport bounds",
        ],
      });
      await page.close();
    }
    assert.deepEqual(report.errors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } finally {
    fs.writeFileSync(
      path.join(output, "model-search-report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
