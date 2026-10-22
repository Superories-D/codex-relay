// Built web UI -> authenticated HTTP -> real daemon. No accounts/model calls.
const { spawn } = require("node:child_process"),
  { once } = require("node:events");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { chromium } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "relay-remote-ui-")),
    data = path.join(base, "data"),
    workspace = path.join(base, "project");
  await fs.mkdir(workspace);
  const child = spawn(
    process.execPath,
    [
      "dist/server/main.cjs",
      "--data-dir",
      data,
      "--ipc-port",
      "0",
      "--http-port",
      "0",
      "--workspace",
      workspace,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(Error(output || "start timeout")),
        10000,
      );
      child.stderr.on("data", (d) => (output += d));
      child.on("exit", () => {
        clearTimeout(timer);
        reject(Error(output));
      });
      child.stdout.on("data", (d) => {
        output += d;
        const m = output.match(/HTTP port: (\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
    });
    const token = await fs.readFile(path.join(data, "http-token"), "utf8");
    browser = await chromium.launch({
      executablePath: process.env.RELAY_CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    await fs.mkdir("qa-output", { recursive: true });
    const errors = [];
    for (const [language, width] of [
      ["en", 1280],
      ["zh-CN", 390],
      ["ja", 900],
    ]) {
      const context = await browser.newContext({
          viewport: { width, height: 900 },
        }),
        page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      if (language === "en") {
        let droppedStream = false,
          droppedSubmit = false,
          droppedMessage = false;
        await page.route("**/api/events", async (route) => {
          if (!droppedStream) {
            droppedStream = true;
            await route.abort();
          } else await route.continue();
        });
        await page.route("**/api/command", async (route) => {
          if (
            !droppedMessage &&
            route.request().postDataJSON()?.name === "chat.submit"
          ) {
            droppedMessage = true;
            await route.fetch();
            await route.abort();
            return;
          }
          if (
            !droppedSubmit &&
            route.request().postDataJSON()?.name === "job.submit"
          ) {
            droppedSubmit = true;
            await route.fetch();
            await route.abort();
          } else await route.continue();
        });
      }
      await page.addInitScript(
        (lang) => sessionStorage.setItem("relay.remote.language", lang),
        language,
      );
      if (process.env.RELAY_QA_FONT) {
        await page.route("**/__qa_font.woff2", async (route) =>
          route.fulfill({
            contentType: "font/woff2",
            body: await fs.readFile(process.env.RELAY_QA_FONT),
          }),
        );
        await page.route("**/app.css", async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            body:
              (await response.text()) +
              "\n@font-face{font-family:RelayQA;src:url(/__qa_font.woff2)}body{font-family:RelayQA,system-ui,sans-serif}",
          });
        });
      }
      await page.goto(`http://127.0.0.1:${port}`);
      await page.locator(".connect-card input").fill(token);
      await page.locator(".connect-card button").click();
      await page.locator(".connection-bar.online").waitFor();
      await page.locator(".new-task textarea").fill(`Remote QA ${language}`);
      await page.locator(".new-task button[type=submit]").click();
      await page.waitForFunction(
        (text) =>
          document.querySelector(".conversation-header h1")?.textContent ===
          text,
        `Remote QA ${language}`,
      );
      await page.locator(".remote-messages article").waitFor();
      await page.locator(".conversation-header .row button").first().click();
      await page.waitForFunction(async (title) => {
        const response = await fetch("/api/snapshot", {
          headers: {
            Authorization: `Bearer ${sessionStorage.getItem("relay.remote.token")}`,
          },
        });
        const snap = await response.json();
        return snap.jobs.find((j) => j.title === title)?.state === "paused";
      }, `Remote QA ${language}`);
      await page.waitForFunction(
        () =>
          !document.querySelector(".conversation-header .row button")?.disabled,
      );
      await page.waitForFunction(() =>
        /Paused|已暂停|一時停止/.test(
          document.querySelector(".state-pill")?.textContent || "",
        ),
      );
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `qa-output/remote-${language}-${width}.png`,
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${language} horizontal overflow`,
      );
      if (language === "en") {
        await page
          .locator(".remote-followup textarea")
          .fill("Exactly one remote follow-up");
        await page.locator(".remote-followup button").click();
        await page.waitForFunction(
          () =>
            document.querySelector(".remote-followup textarea")?.value === "",
        );
        await page.waitForFunction(async () => {
          const response = await fetch("/api/snapshot", {
            headers: {
              Authorization: `Bearer ${sessionStorage.getItem("relay.remote.token")}`,
            },
          });
          const snap = await response.json();
          return (
            snap.jobs.find((j) => j.title === "Remote QA en")?.messageReceipts
              ?.length === 1
          );
        });
        await page.locator(".remote-workflow").click();
        await page
          .locator(".workflow-builder input")
          .first()
          .fill("Remote pipeline");
        await page
          .locator(".workflow-builder textarea")
          .nth(0)
          .fill("Prepare artifact.md");
        await page
          .locator(".workflow-builder textarea")
          .nth(1)
          .fill("Verify artifact.md");
        await page.locator(".workflow-builder button[type=submit]").click();
        await page.locator(".workflow-builder").waitFor({ state: "detached" });
        await page.waitForFunction(
          () =>
            document.querySelectorAll(".remote-task-list button").length === 3,
        );
        await page.reload();
        await page.locator(".connection-bar.online").waitFor();
        assert.equal(await page.locator(".remote-task-list button").count(), 3);
      }
      await context.close();
    }
    assert.deepEqual(errors, []);
    await browser.close();
    browser = undefined;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0);
    console.log(
      "PASS: real HTTP login, task submission, chat, pause, workflow creation, reload and 390/900/1280px layouts; zero model calls",
    );
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGKILL");
      await stopped.catch(() => {});
    }
    await fs.rm(base, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
