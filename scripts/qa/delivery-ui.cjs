// Windows production renderer with controlled IPC; actual files are tested by delivery-native.cjs.
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
function deliveryFixture() {
  const command = window.relay.command,
    snapshot = window.relay.snapshot;
  window.deliveryQA = {
    revision: 1,
    checks: [
      { kind: "file", path: "artifact.txt", label: "Artifact", minBytes: 1 },
    ],
    reports: [],
    saveCalls: 0,
    failSave: true,
  };
  window.relay.snapshot = async () => {
    const data = await snapshot();
    data.jobs[0].delivery = structuredClone(window.deliveryQA);
    return data;
  };
  window.deliveryCommand = async (name, args) => {
    const state = window.deliveryQA;
    if (name === "cli.status") return { phase: "ready" };
    if (name === "delivery.read") {
      await new Promise((r) => setTimeout(r, 100));
      return structuredClone(state);
    }
    if (name === "delivery.save") {
      state.saveCalls++;
      if (state.failSave) {
        state.failSave = false;
        throw Error("Fixture save failure");
      }
      state.revision++;
      state.checks = args.checks;
      return structuredClone(state);
    }
    if (name === "delivery.run") {
      state.reports.push({
        id: "report-" + state.reports.length,
        revision: state.revision,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        source: "manual",
        status: "failed",
        findings: state.checks.map((check) => ({
          check,
          status: "failed",
          code: "missing",
        })),
      });
      return structuredClone(state);
    }
    if (name === "delivery.repair")
      return "Repair the declared artifacts using the acceptance results.";
    if (name === "delivery.export")
      return { schemaVersion: 1, delivery: structuredClone(state) };
    return command(name, args);
  };
  window.relay.command = window.deliveryCommand;
}
(async () => {
  const report = {
    syntheticBackend: true,
    inferenceTurns: 0,
    layouts: [],
    errors: [],
  };
  let browser;
  const server = http.createServer((req, res) => {
    const remote =
        req.url.startsWith("/remote") ||
        req.headers.referer?.includes("/remote/"),
      folder = path.join(root, remote ? "dist/server/ui" : "dist/renderer"),
      part = req.url.replace(/^\/(remote|desktop)/, "") || "/index.html",
      file = path.resolve(folder, "." + (part === "/" ? "/index.html" : part));
    if (!file.startsWith(folder + path.sep)) return res.writeHead(403).end();
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
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    browser = await chromium.launch({
      executablePath: process.env.RELAY_CHROMIUM_PATH,
      headless: true,
    });
    const terms = {
      en: [
        "Delivery acceptance",
        "Save acceptance checks",
        "Add check",
        "Verify again",
        "Add repair instructions to draft",
        "Export acceptance evidence",
      ],
      "zh-CN": [
        "交付验收",
        "保存验收条件",
        "添加验收条件",
        "重新验收",
        "将修正要求加入草稿",
        "导出验收证据",
      ],
      "zh-TW": [
        "交付驗收",
        "儲存驗收條件",
        "新增驗收條件",
        "重新驗收",
        "將修正要求加入草稿",
        "匯出驗收證據",
      ],
      ja: [
        "成果物の検証",
        "検証条件を保存",
        "条件を追加",
        "再検証",
        "修正指示を下書きに追加",
        "検証の証拠をエクスポート",
      ],
    };
    for (const [kind, language, theme, width] of [
      ["desktop", "en", "dark", 1600],
      ["desktop", "zh-CN", "light", 1280],
      ["desktop", "zh-TW", "dark", 900],
      ["desktop", "ja", "light", 900],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        acceptDownloads: true,
      });
      page.on("pageerror", (e) => report.errors.push(e.message));
      await page.addInitScript({
        content: `
        window.__deliveryPreviousChat = localStorage.getItem('relay.lastChat');
        window.__deliverySeeded = sessionStorage.getItem('deliveryQA.seeded');
        (${fixture.toString()})(${JSON.stringify({ theme, language })});
        (${deliveryFixture.toString()})();
        if (window.__deliverySeeded) {
          if (window.__deliveryPreviousChat) localStorage.setItem('relay.lastChat', window.__deliveryPreviousChat);
          else localStorage.removeItem('relay.lastChat');
        }
        sessionStorage.setItem('deliveryQA.seeded','true');
      `,
      });
      if (kind === "remote") {
        await page.addInitScript((lang) => {
          sessionStorage.setItem("relay.remote.token", "fixture-token");
          sessionStorage.setItem("relay.remote.language", lang);
        }, language);
        await page.route("**/api/**", async (route) => {
          const request = route.request();
          assert.equal(request.headers().authorization, "Bearer fixture-token");
          let value;
          if (request.url().endsWith("/api/events")) {
            value = await page.evaluate(() => window.relay.snapshot());
            return route.fulfill({
              contentType: "text/event-stream",
              body: "event: snapshot\ndata: " + JSON.stringify(value) + "\n\n",
            });
          }
          if (request.url().endsWith("/api/meta"))
            value = { workspaces: ["D:\\Projects\\review"] };
          else if (request.url().endsWith("/api/snapshot"))
            value = await page.evaluate(() => window.relay.snapshot());
          else {
            try {
              const input = request.postDataJSON();
              value = {
                result: await page.evaluate(
                  (input) => window.deliveryCommand(input.name, input.args),
                  input,
                ),
              };
            } catch (e) {
              return route.fulfill({
                status: 400,
                contentType: "application/json",
                body: JSON.stringify({ error: e.message }),
              });
            }
          }
          return route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(value),
          });
        });
      }
      await page.goto(`http://127.0.0.1:${server.address().port}/${kind}/`);
      if (kind === "remote")
        await page
          .locator("aside button")
          .filter({ has: page.locator("strong") })
          .filter({ hasText: "Review workspace" })
          .click();
      await page.locator(".delivery-summary").click();
      const dialog = page.getByRole("dialog");
      await dialog.locator("fieldset:not(:disabled)").waitFor();
      const labels = terms[language],
        buttons = dialog.locator("button");
      await dialog.locator("fieldset select").selectOption("json");
      await dialog
        .getByRole("button", { name: labels[2], exact: true })
        .click();
      const row = dialog.locator(".delivery-check").nth(1),
        inputs = row.locator("input");
      await inputs.nth(0).fill("JSON condition");
      await inputs.nth(1).fill("report.json");
      await inputs.nth(2).fill("/ok");
      await inputs.nth(3).fill("{");
      await dialog
        .getByRole("button", { name: labels[1], exact: true })
        .click();
      await dialog.getByRole("alert").waitFor();
      assert.equal(
        await page.evaluate(() => window.deliveryQA.saveCalls),
        0,
        "invalid JSON must not save an old value",
      );
      assert.equal(await inputs.nth(3).inputValue(), "{");
      await inputs.nth(3).fill("true");
      await dialog
        .getByRole("button", { name: labels[1], exact: true })
        .click();
      await dialog.getByRole("alert").waitFor();
      assert.match(
        await dialog.getByRole("alert").innerText(),
        /Fixture save failure/,
      );
      assert.equal(await inputs.nth(1).inputValue(), "report.json");
      await dialog
        .getByRole("button", { name: labels[1], exact: true })
        .click();
      await page.waitForFunction(() => window.deliveryQA.revision === 2);
      assert.equal(
        await page.evaluate(() => window.deliveryQA.checks[1].equals),
        true,
      );
      await dialog
        .getByRole("button", { name: labels[3], exact: true })
        .click();
      await dialog.locator('h3[data-status="failed"]').waitFor();
      assert.equal(
        await dialog.locator(".delivery-results article").count(),
        2,
      );
      const downloading = page.waitForEvent("download");
      await dialog
        .getByRole("button", { name: labels[5], exact: true })
        .click();
      const download = await downloading,
        document = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
      assert.equal(document.delivery.reports.length, 1);
      await page.screenshot({
        path: path.join(output, `delivery-${kind}-${language}.png`),
      });
      const bounds = await dialog.locator(".modal").boundingBox();
      assert.ok(
        bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
        "dialog fits narrow viewport",
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      const composer = page
        .locator(
          kind === "desktop"
            ? ".agent-composer textarea"
            : ".remote-conversation form textarea",
        )
        .last();
      await composer.fill("Existing draft.");
      await page.locator(".delivery-summary").click();
      await dialog
        .getByRole("button", { name: labels[4], exact: true })
        .click();
      await dialog.waitFor({ state: "detached" });
      assert.match(await composer.inputValue(), /^Existing draft\./);
      assert.match(
        await composer.inputValue(),
        /Repair the declared artifacts/,
      );
      // New-task contract drafts are separate from the current task and survive reload.
      if (kind === "desktop") {
        await page.locator(".agent-new").click();
        await page.locator(".composer-attach-control > button").first().click();
        await page
          .getByRole("menuitem", { name: labels[0], exact: true })
          .click();
      } else
        await page
          .locator(".new-task")
          .getByRole("button", { name: new RegExp("^" + labels[0]) })
          .click();
      await dialog.locator("fieldset:not(:disabled)").waitFor();
      assert.equal(await dialog.locator(".delivery-check").count(), 0);
      await dialog
        .getByRole("button", { name: labels[2], exact: true })
        .click();
      const draftRow = dialog.locator(".delivery-check");
      await draftRow.locator("input").nth(0).fill("New contract");
      await draftRow.locator("input").nth(1).fill("artifacts/final.txt");
      await dialog
        .getByRole("button", { name: labels[1], exact: true })
        .click();
      await dialog.waitFor({ state: "detached" });
      await page.reload();
      if (kind === "desktop") {
        await page.locator(".composer-attach-control > button").first().click();
        await page
          .getByRole("menuitem", { name: labels[0], exact: true })
          .click();
      } else
        await page
          .locator(".new-task")
          .getByRole("button", { name: new RegExp("^" + labels[0]) })
          .click();
      await dialog.locator(".delivery-check").waitFor();
      assert.equal(
        await dialog.locator(".delivery-check input").nth(1).inputValue(),
        "artifacts/final.txt",
      );
      report.layouts.push({
        kind,
        language,
        theme,
        width,
        checks: [
          "typed JSON validation",
          "failed save preserves edits",
          "save/recheck",
          "evidence download",
          "repair appends draft",
          "new-task contract survives reload",
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
      path.join(output, "delivery-ui-report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser?.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
