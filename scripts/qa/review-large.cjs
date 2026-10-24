// Large production-renderer diff fixtures; no accounts, real Git mutation or inference.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const { chromium } = require(
    process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
  ),
  { fixture } = require("./review-ui.cjs");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const report = {
    syntheticIPC: true,
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
      ["zh-CN", "light", 1280],
      ["zh-TW", "dark", 900],
      ["ja", "light", 900],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (e) => report.errors.push(e.message));
      await page.addInitScript(fixture, { theme, language });
      await page.addInitScript(() => {
        const command = window.relay.command;
        window.largeDiffMode = "many";
        const patch = () =>
          "diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n" +
          (window.largeDiffMode === "many"
            ? Array.from(
                { length: 80 },
                (_, i) =>
                  `@@ -${i * 3 + 1},1 +${i * 253 + 1},250 @@\n-old ${i}\n` +
                  Array.from({ length: 250 }, (_, j) => `+new ${i}:${j}`).join(
                    "\n",
                  ) +
                  "\n",
              ).join("")
            : window.largeDiffMode === "single"
              ? "@@ -1,1 +1,10000 @@\n-old\n" +
                Array.from({ length: 10000 }, (_, i) => `+row ${i + 1}`).join(
                  "\n",
                ) +
                "\n"
              : "@@ -1 +1 @@\n-old\n+refreshed\n");
        window.relay.command = async (name, args) => {
          if (name === "workspace.diff") return patch();
          if (name === "workspace.gitHunk") {
            window.reviewCalls.push({ name, args });
            return command("workspace.changes");
          }
          return command(name, args);
        };
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page
        .getByRole("button", {
          name:
            language === "en"
              ? "Git changes"
              : language === "ja"
                ? "Git の変更"
                : "Git 更改",
          exact: true,
        })
        .click();
      const started = Date.now();
      await page
        .locator(".changed-files button")
        .filter({ hasText: "src/review.ts" })
        .click();
      const review = page.locator(".diff-review");
      await review.locator(".review-hunk").nth(79).waitFor();
      assert.equal(await review.locator(".review-line").count(), 251);
      const loadMs = Date.now() - started;
      assert.equal(await review.locator(".review-added").innerText(), "+20000");
      assert.equal(await review.locator(".review-removed").innerText(), "−80");
      assert.equal(
        await review
          .locator('.review-disclosure[aria-expanded="false"]')
          .count(),
        79,
      );
      await review.locator(".review-controls button").nth(2).click();
      assert.equal(
        await review.locator(".review-line").count(),
        0,
        "collapse releases all line DOM",
      );
      await review.locator(".review-controls button").nth(1).click();
      assert.equal(await review.locator(".review-line").count(), 251);
      assert.equal(
        await review
          .locator('[data-hunk="1"] .review-disclosure')
          .getAttribute("aria-expanded"),
        "true",
      );
      const refresh = async (mode) => {
        await page.evaluate((value) => {
          window.largeDiffMode = value;
          window.reviewAdvance();
        }, mode);
        await page.locator(".changes-heading button").nth(1).click();
      };
      await refresh("single");
      await review.locator(".review-pagination select").waitFor();
      const pager = review.locator(".review-pagination");
      assert.equal(await review.locator(".review-line").count(), 400);
      assert.equal(await pager.locator("option").count(), 26);
      assert.equal(
        await review
          .locator(".review-line")
          .last()
          .getAttribute("data-new-line"),
        "399",
      );
      await pager.locator("button").last().click();
      assert.equal(
        await review
          .locator(".review-line")
          .first()
          .getAttribute("data-new-line"),
        "400",
      );
      await pager.locator("select").selectOption("25");
      assert.equal(await review.locator(".review-line").count(), 1);
      assert.equal(
        await review
          .locator(".review-line")
          .first()
          .getAttribute("data-new-line"),
        "10000",
      );
      const input = page.locator(".agent-composer textarea");
      await input.fill("Keep my draft.");
      await review.locator(".review-line button").click();
      assert.match(await input.inputValue(), /^Keep my draft\./);
      assert.match(await input.inputValue(), /src\/review.ts:10000/);
      assert.match(await input.inputValue(), /row 10000/);
      await review.locator(".hunk-control").click();
      await page.waitForFunction(() =>
        window.reviewCalls.some((c) => c.name === "workspace.gitHunk"),
      );
      const mutation = await page.evaluate(() =>
        window.reviewCalls.find((c) => c.name === "workspace.gitHunk"),
      );
      assert.equal(mutation.args.hunk, 0);
      assert.ok(
        mutation.args.expectedDiff.includes("+row 10000\n"),
        "staging sends the complete diff from the last display page",
      );
      await refresh("small");
      await page.waitForFunction(() =>
        document
          .querySelector(".review-lines")
          ?.textContent.includes("refreshed"),
      );
      assert.equal(await pager.count(), 0);
      assert.equal(await review.locator(".review-line").count(), 2);
      await refresh("single");
      await pager.waitFor();
      assert.equal(
        await pager.locator("select").inputValue(),
        "0",
        "refreshed hunk starts on the first page",
      );
      await page.screenshot({
        path: path.join(output, `review-large-${language}.png`),
      });
      const calls = await page.evaluate(() => window.reviewCalls);
      assert.equal(
        calls.some((c) => ["chat.send", "job.add"].includes(c.name)),
        false,
      );
      report.layouts.push({
        language,
        theme,
        width,
        totalRows: 20080,
        initialRows: 251,
        collapsedRows: 0,
        loadMs,
        singleHunkRows: 10001,
        pageRows: 400,
        lastSourceLine: 10000,
        stagesCompleteHunk: true,
      });
      await page.close();
    }
    assert.deepEqual(report.errors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } finally {
    fs.writeFileSync(
      path.join(output, "review-large-report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
