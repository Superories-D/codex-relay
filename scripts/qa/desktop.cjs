// Optional browser-level regression: npm install --no-save playwright; npx playwright install chromium
// Override RELAY_PLAYWRIGHT_MODULE / RELAY_CHROMIUM_PATH for an existing local browser.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const { build } = require("esbuild");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-cdp-qa-"));
  let context, cdp;
  try {
    const bundle = path.join(root, "adapter.cjs");
    await build({
      entryPoints: [path.join(__dirname, "../../src/core/cdp.ts")],
      outfile: bundle,
      platform: "node",
      format: "cjs",
      bundle: true,
    });
    const { Cdp } = require(bundle);
    const profile = path.join(root, "profile");
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: process.env.RELAY_CHROMIUM_PATH || undefined,
      args: [
        ...JSON.parse(process.env.RELAY_BROWSER_ARGS || "[]"),
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
      ],
    });
    const page = context.pages()[0];
    const port = Number(
      (
        await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0],
    );
    cdp = await Cdp.connect(port);
    const selector = '[data-thread-id="thread-good"]';
    const settings = {
      editorSelector: "textarea",
      sendSelector: '[aria-label="Send"]',
      stopSelector: '[aria-label="Stop"]',
      threadSelector: '[data-thread-id="{threadId}"]',
      projectSelector: "",
    };
    await page.setContent(
      `<button data-thread-id="thread-good" onclick="location.hash='thread-good'">Relay test</button><textarea></textarea><button aria-label="Send" onclick="window.sent=(window.sent||0)+1">Send</button><button aria-label="Stop" onclick="window.stopped=true">Stop</button>`,
    );
    assert.equal(await cdp.isThreadSelected("thread-good", selector), false);
    assert.equal(
      await cdp.selectThread(selector, "Relay test", "thread-good"),
      true,
    );
    assert.equal(await cdp.isThreadSelected("thread-good", selector), true);
    const text = "A task\n中文目标";
    await cdp.fill("textarea", text);
    await cdp.fill("textarea", text); // Idempotent retry must not duplicate the draft.
    assert.equal(await page.locator("textarea").inputValue(), text);
    await assert.rejects(cdp.fill("textarea", "overwrite"), /草稿/);
    // Editing the draft between prepare and click must cancel the send.
    await page.locator("textarea").fill("my own draft");
    assert.equal(
      await cdp.clickForThread(settings.sendSelector, "thread-good", selector, {
        selector: "textarea",
        text,
      }),
      false,
    );
    await page.locator("textarea").fill(text);
    // A route containing only a prefix/suffix match is not the target thread.
    await page.evaluate(() => {
      location.hash = "thread-good-other";
    });
    assert.equal(
      await cdp.clickForThread(settings.sendSelector, "thread-good", selector, {
        selector: "textarea",
        text,
      }),
      false,
    );
    assert.equal(
      await cdp.clickForThread(settings.stopSelector, "thread-good", selector),
      false,
    );
    assert.equal(await page.evaluate(() => window.sent || 0), 0);
    await page.evaluate(() => {
      location.hash = "thread-other?from=thread-good";
    });
    assert.equal(await cdp.isThreadSelected("thread-good", selector), false);

    await page.evaluate(() => {
      location.hash = "thread-good";
    });
    assert.equal(
      await cdp.clickForThread(settings.sendSelector, "thread-good", selector, {
        selector: "textarea",
        text,
      }),
      true,
    );
    assert.equal(await page.evaluate(() => window.sent), 1);
    const report = await cdp.inspect(settings, "thread-good");
    assert.equal(report.threadSelected, true);
    assert.equal(report.hasDraft, true);
    assert.equal(report.counts.editorSelector, 1);
    await page
      .locator('[aria-label="Stop"]')
      .evaluate((e) => e.setAttribute("aria-disabled", "true"));
    assert.equal(
      await cdp.clickForThread(settings.stopSelector, "thread-good", selector),
      false,
    );
    await page.setContent("<textarea readonly></textarea>");
    await assert.rejects(cdp.fill("textarea", "blocked"), /草稿/);
    await page.setContent("<textarea></textarea><textarea></textarea>");
    await assert.rejects(cdp.fill("textarea", "ambiguous"), /草稿/);
    await page.setContent('<div role="textbox" contenteditable="true"></div>');
    await cdp.fill('[role="textbox"]', text);
    assert.equal(await page.locator('[role="textbox"]').innerText(), text);
    await context.newPage();
    await assert.rejects(Cdp.connect(port), /候选页面/);
    console.log(
      "PASS Desktop adapter: thread identity, atomic send/stop, draft preservation, retries, Chinese textarea/contenteditable, disabled/ambiguous controls and page isolation.",
    );
  } finally {
    cdp?.close();
    await context?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
