// Uses an already running isolated, logged-in QA profile. Does not send model turns.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
(async () => {
  const browser = await chromium.connectOverCDP(
    process.env.RELAY_CDP_URL || "http://127.0.0.1:9337",
  );
  try {
    const page = browser.contexts()[0].pages()[0];
    await page.reload();
    await page.getByRole("button", { name: "选择模型和思考强度" }).click();
    const picker = page.getByRole("dialog", { name: "模型和思考强度" });
    const slider = picker.getByRole("slider", { name: "思考强度" });
    await slider.waitFor({ timeout: 60000 });
    const before = await slider.getAttribute("aria-valuetext");
    await slider.focus();
    await page.keyboard.press("End");
    const maximum = await slider.getAttribute("aria-valuetext");
    await picker.getByRole("button", { name: "重置思考强度" }).click();
    assert.equal(await slider.getAttribute("aria-valuetext"), before);
    const selected = await picker.locator(".agent-model-name").innerText();
    await picker.locator(".agent-model-name").click();
    const models = await picker
      .locator(".agent-model-list button span")
      .allTextContents();
    assert.ok(models.length > 0);
    await picker.locator(".agent-model-name").click();
    const out = path.resolve(__dirname, "../../qa-output");
    await picker.screenshot({ path: path.join(out, "agent-model-live.png") });
    const report = {
      authenticatedCatalog: true,
      inferenceTurns: 0,
      model: selected.trim(),
      defaultStrength: before,
      maximumStrength: maximum,
      models,
      reset: "passed",
    };
    await fs.writeFile(
      path.join(out, "agent-model-live-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    await page.keyboard.press("Escape");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
