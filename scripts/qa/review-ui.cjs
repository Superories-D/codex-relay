// Production renderer with synthetic IPC. No account reads or inference.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const assert = require("node:assert/strict");
const { chromium } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
function fixture({ theme, language }) {
  const now = Date.now(),
    cwd = "D:\\Projects\\review";
  const job = {
    id: "review-job",
    cwd,
    title: "Review workspace",
    prompt: "Review",
    state: "completed",
    mode: "cli",
    model: "",
    effort: "",
    sandbox: "workspaceWrite",
    approvalPolicy: "on-request",
    bucket: "codex",
    rotations: 0,
    interactive: true,
    createdAt: now,
    updatedAt: now,
  };
  const desktop = {
    projects: [{ id: "review-project", cwd, name: "Review workspace" }],
    schedules: [],
    preferences: { theme, language, notifications: false },
  };
  const snapshot = {
    version: 1,
    platform: "win32",
    cursor: 0,
    logs: [],
    approvals: [],
    settings: { cliPath: "codex", desktop: {}, resetWarmupEnabled: false },
    accounts: [],
    jobs: [job],
  };
  const patch =
    "diff --git a/src/review.ts b/src/review.ts\nindex 1234567..abcdef0 100644\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -1,3 +1,4 @@\n before\n-old line\n+new line\n+extra line " +
    "long_text_".repeat(70) +
    "\n after\n@@ -20 +21 @@ footer\n-old footer\n+new footer\n";
  let version = 1;
  window.reviewCalls = [];
  window.reviewAdvance = () => {
    version++;
  };
  window.relay = {
    snapshot: async () => structuredClone(snapshot),
    onSnapshot: () => () => {},
    onChat: () => () => {},
    command: async (name, args) => {
      window.reviewCalls.push({ name, args });
      if (name === "desktop.read") return structuredClone(desktop);
      if (name === "chat.read") return { items: [], total: 0 };
      if (name === "account.models") return [];
      if (name === "history.importAll.status") return {};
      if (name === "workspace.changes")
        return {
          root: cwd,
          branch: "feature/review",
          revision: String(version),
          error: "",
          files: [
            { path: "src/review.ts", index: " ", worktree: "M" },
            { path: "docs/日本語.md", index: "A", worktree: " " },
          ],
        };
      if (name === "workspace.diff")
        return version === 1
          ? patch
          : patch.replace("new footer", "updated footer");
      if (name === "chat.assets") return { files: [], images: [], sources: [] };
      if (name === "desktop.branch") return "feature/review";
      return undefined;
    },
  };
  localStorage.setItem("relay.lastChat", job.id);
  localStorage.setItem("relay.inspector", "false");
}
module.exports = { fixture };
if (require.main === module)
  (async () => {
    fs.mkdirSync(output, { recursive: true });
    const report = {
      syntheticIPC: true,
      modelRequests: 0,
      layouts: [],
      errors: [],
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
      for (const [language, theme, width] of [
        ["en", "dark", 1600],
        ["zh-CN", "light", 1280],
        ["ja", "dark", 900],
        ["zh-TW", "light", 900],
      ]) {
        const page = await browser.newPage({
          viewport: { width, height: 1000 },
          deviceScaleFactor: 1.25,
        });
        page.on("pageerror", (e) => report.errors.push(e.message));
        await page.addInitScript(fixture, { language, theme });
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
        const panel = page.locator(".changes-pane");
        const filter = panel.locator(".review-file-filter input");
        await filter.fill("日本語");
        assert.equal(await panel.locator(".changed-files button").count(), 1);
        await filter.fill("no-match");
        assert.equal(await panel.locator(".changed-files button").count(), 0);
        await panel.locator(".changed-files [role=status]").waitFor();
        await filter.fill("");
        await panel
          .locator(".changed-files button")
          .filter({ hasText: "src/review.ts" })
          .click();
        const review = panel.locator(".diff-review");
        await review.locator(".review-hunk").nth(1).waitFor();
        assert.equal(await review.locator(".review-added").innerText(), "+3");
        assert.equal(await review.locator(".review-removed").innerText(), "−2");
        assert.equal(
          await review
            .locator(".review-line.added")
            .last()
            .getAttribute("data-new-line"),
          "21",
        );
        assert.equal(
          await review
            .locator(".review-line.removed")
            .last()
            .getAttribute("data-old-line"),
          "20",
        );
        await review.locator(".review-controls button").nth(1).click();
        assert.ok(
          await review
            .locator(".review-disclosure")
            .nth(1)
            .evaluate((e) => e === document.activeElement),
        );
        await page.keyboard.press("Space");
        assert.equal(
          await review
            .locator(".review-disclosure")
            .nth(1)
            .getAttribute("aria-expanded"),
          "false",
        );
        await review.locator(".review-controls button").nth(0).click();
        await review.locator(".review-controls button").nth(2).click();
        assert.deepEqual(
          await review
            .locator(".review-disclosure")
            .evaluateAll((nodes) =>
              nodes.map((e) => e.getAttribute("aria-expanded")),
            ),
          ["false", "false"],
        );
        await review.locator(".review-controls button").nth(2).click();
        assert.equal(
          await review.locator(".review-lines").getAttribute("data-wrap"),
          "true",
        );
        assert.ok(
          await review
            .locator(".review-lines")
            .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
          "wrapped long lines fit the pane",
        );
        await review.locator(".review-controls button").nth(3).click();
        assert.ok(
          await review
            .locator(".review-lines")
            .evaluate((e) => e.scrollWidth > e.clientWidth),
          "unwrapped long lines scroll horizontally",
        );
        await review.locator(".review-controls button").nth(3).click();
        const input = page.locator(".agent-composer textarea");
        await input.fill("Keep my existing draft.");
        const removed = review.locator(".review-line.removed").last();
        await removed.hover();
        await removed.locator("button").click();
        assert.match(await input.inputValue(), /^Keep my existing draft\./);
        assert.match(await input.inputValue(), /src\/review.ts:20/);
        assert.match(await input.inputValue(), /@@ -20 \+21 @@ footer/);
        assert.match(await input.inputValue(), /-old footer\n\+new footer/);
        assert.ok(await input.evaluate((e) => e === document.activeElement));
        await review.locator(".review-line.added").last().hover();
        await review
          .locator(".review-line.added")
          .last()
          .locator("button")
          .click();
        assert.match(await input.inputValue(), /src\/review.ts:21/);
        await page.evaluate(() => window.reviewAdvance());
        await panel.locator(".changes-heading button").nth(1).click();
        await page.waitForFunction(() =>
          document
            .querySelector(".review-lines")
            ?.textContent.includes("updated footer"),
        );
        assert.equal(
          await review
            .locator(".review-disclosure")
            .nth(1)
            .getAttribute("aria-expanded"),
          "true",
        );
        await input.fill("");
        await page.mouse.move(0, 0);
        const originalWidth = await panel.evaluate((e) => e.clientWidth);
        await page.locator(".workbench-size").click();
        await page.waitForFunction(
          (before) =>
            document.querySelector(".changes-pane").clientWidth > before * 1.2,
          originalWidth,
        );
        await page.locator(".motion-region.horizontal").evaluate(async (e) => {
          await Promise.all(e.getAnimations().map((a) => a.finished));
        });
        assert.equal(
          await page.locator(".workbench-size").getAttribute("aria-pressed"),
          "true",
        );
        assert.equal(await review.locator(".review-hunk").count(), 2);
        if (width > 1150)
          assert.ok(
            await page
              .locator(".agent-composer")
              .evaluate((e) => e.clientWidth >= 260),
            "expanded review leaves room for the composer",
          );
        await page.screenshot({
          path: path.join(
            output,
            `review-wide-${theme}-${language}-${width}.png`,
          ),
        });
        await page.locator(".workbench-size").click();
        await page.locator(".motion-region.horizontal").evaluate(async (e) => {
          await Promise.all(e.getAnimations().map((a) => a.finished));
        });
        await page.screenshot({
          path: path.join(output, `review-${theme}-${language}-${width}.png`),
        });
        const geometry = await page.evaluate(() => {
          const pane = document.querySelector(".changes-pane");
          return {
            pageOverflow: document.documentElement.scrollWidth > innerWidth,
            paneOverflow: pane.scrollWidth > pane.clientWidth + 1,
          };
        });
        assert.deepEqual(geometry, {
          pageOverflow: false,
          paneOverflow: false,
        });
        assert.equal(
          (await page.evaluate(() => window.reviewCalls)).some((c) =>
            /^(chat.send|chat.create|job.add)$/.test(c.name),
          ),
          false,
        );
        report.layouts.push({ language, theme, width, ...geometry });
        await page.close();
      }
      assert.deepEqual(report.errors, []);
      report.status = "passed";
      console.log(JSON.stringify(report));
    } finally {
      fs.writeFileSync(
        path.join(output, "review-ui-report.json"),
        JSON.stringify(report, null, 2),
      );
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
    }
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
