// Production renderer with synthetic IPC; no accounts, credentials, or model calls.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const assert = require("node:assert/strict");
const { chromium } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
function fixture({ language, theme }) {
  const now = Date.now();
  const job = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "恢复中断的开发任务",
    cwd: "D:\\Projects\\codex-go",
    mode: "cli",
    model: "",
    effort: "",
    bucket: "codex",
    state: "waiting",
    waitingFor: "recovery",
    autoRecovery: { reason: "unknown", attempt: 3, nextAttemptAt: now + 60000 },
    lastError:
      "Codex connection interrupted. The previous process has stopped.",
    threadId: "original-thread",
    prompt: "继续优化用户体验",
    interactive: true,
    rotations: 0,
    createdAt: now,
    updatedAt: now,
    approvalPolicy: "on-request",
    sandbox: "workspaceWrite",
  };
  const data = {
    version: 1,
    platform: "win32",
    accounts: [],
    jobs: [job],
    logs: [],
    approvals: [],
    cursor: 0,
    settings: {
      cliPath: "codex",
      desktopPath: "",
      pollSeconds: 30,
      retrySeconds: 60,
      resumePrompt: "继续",
      desktop: {},
    },
  };
  const desktop = {
    projects: [],
    schedules: [],
    preferences: { language, theme, notifications: true },
  };
  const listeners = new Set();
  window.recoveryCalls = [];
  window.relay = {
    snapshot: async () => structuredClone(data),
    onSnapshot: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onChat: () => () => {},
    command: async (name, args) => {
      window.recoveryCalls.push({ name, args });
      if (name === "desktop.read") return structuredClone(desktop);
      if (name === "history.importAll.status")
        return {
          phase: "idle",
          total: 0,
          processed: 0,
          warnings: [],
          failures: [],
        };
      if (name === "account.models" || name === "workspace.files") return [];
      if (name === "workspace.changes")
        return { root: job.cwd, branch: "main", files: [] };
      if (name === "chat.assets") return { files: [], images: [], sources: [] };
      if (name === "chat.read")
        return {
          total: 2,
          items: [
            {
              id: "user",
              role: "user",
              kind: "message",
              text: "继续优化用户体验，完成中断后的自动恢复。",
              at: now,
            },
            {
              id: "assistant",
              role: "assistant",
              kind: "message",
              text: "已保存当前进度，正在恢复连接。",
              at: now,
            },
          ],
        };
      if (name === "job.control") {
        job.state = "paused";
        job.stopIntent = "pause";
        job.autoRecovery = undefined;
        job.lastError = undefined;
        for (const listener of listeners) listener(structuredClone(data));
      }
      return {};
    },
  };
  localStorage.setItem("relay.lastChat", job.id);
  localStorage.setItem("relay.inspector", "false");
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    if (req.url === "/__qa_font.woff2" && process.env.RELAY_QA_FONT) {
      res.setHeader("Content-Type", "font/woff2");
      fs.createReadStream(process.env.RELAY_QA_FONT)
        .on("error", () => res.end())
        .pipe(res);
      return;
    }
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
          : file.endsWith(".woff2")
            ? "font/woff2"
            : "text/html",
    );
    fs.createReadStream(file)
      .on("error", () => res.end())
      .pipe(res);
  });
  let browser;
  const report = { modelRequests: 0, checks: [], rendererErrors: [] };
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({
      executablePath: process.env.RELAY_CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    for (const [language, theme, width] of [
      ["zh-CN", "dark", 1440],
      ["en", "light", 900],
      ["ja", "dark", 900],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.on("pageerror", (e) => report.rendererErrors.push(e.message));
      await page.addInitScript(fixture, { language, theme });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      if (process.env.RELAY_QA_FONT) {
        await page.addStyleTag({
          content: `@font-face { font-family: "Relay QA"; src: url(/__qa_font.woff2) format("woff2"); } .desktop-shell { font-family: "Relay QA", sans-serif !important; }`,
        });
        await page.evaluate(() => document.fonts.ready);
      }
      const notice = page.locator(".recovery-notice");
      await notice.waitFor();
      await notice.scrollIntoViewIfNeeded();
      const label = {
        "zh-CN": "正在自动恢复",
        en: "Recovering automatically",
        ja: "自動復旧中",
      }[language];
      assert.ok((await notice.innerText()).includes(label));
      const first = await notice.locator("small").innerText();
      await page.waitForFunction(
        (value) =>
          document.querySelector(".recovery-notice small")?.textContent !==
          value,
        first,
      );
      await notice.locator("summary").click();
      await notice.locator("details p").waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const details = document.querySelector(".recovery-notice details");
        const text = details.querySelector("p");
        return (
          text.getBoundingClientRect().bottom <=
            details.getBoundingClientRect().bottom + 1 &&
          Number(getComputedStyle(details, "::details-content").opacity) >= 0.99
        );
      });
      await page.screenshot({
        path: path.join(output, `recovery-${language}-${theme}.png`),
        fullPage: true,
      });
      const geometry = await notice.evaluate((el) => ({
        width: el.clientWidth,
        content: el.scrollWidth,
      }));
      assert.ok(
        geometry.content <= geometry.width + 1,
        "Recovery notice must not overflow",
      );
      await notice.locator("button").click();
      await notice.waitFor({ state: "detached" });
      const controls = await page.evaluate(() =>
        window.recoveryCalls.filter((c) => c.name === "job.control"),
      );
      assert.equal(controls.length, 1);
      assert.equal(controls[0].args.action, "pause");
      report.checks.push(
        `${language}/${theme}/${width}: localized countdown, details, layout, Pause`,
      );
      await page.close();
    }
    assert.deepEqual(report.rendererErrors, []);
    fs.writeFileSync(
      path.join(output, "recovery-ui.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
