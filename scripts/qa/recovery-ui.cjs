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
    queueRevision: 0,
    queuedMessages: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        text: "First pending instruction",
        attachments: [],
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        text: "Second pending instruction",
        attachments: [],
      },
    ],
    recoveryHistory: [
      {
        at: now - 1000,
        kind: "scheduled",
        attempt: 3,
        detail: "Synthetic interruption",
      },
    ],
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
  const templates = { version: 1, revision: 0, items: [] };
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
      if (name === "job.report")
        return {
          schemaVersion: 1,
          blockers: ["recovery"],
          task: { id: job.id, state: job.state },
          recovery: [],
          logs: [],
        };
      if (name === "job.report.save") return { saved: true };
      if (name === "templates.list") return structuredClone(templates);
      if (name === "templates.save") {
        templates.items.push({
          ...args.template,
          id: "44444444-4444-4444-8444-444444444444",
          updatedAt: now,
        });
        templates.revision++;
        return structuredClone(templates);
      }
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
      if (name === "chat.search")
        return {
          total: 1,
          items: [
            {
              id: "found",
              role: "assistant",
              at: now,
              excerpt: "needle in earlier history",
            },
          ],
        };
      if (name === "chat.searchItem")
        return {
          text: "Full original needle message",
          detail: "diagnostic context",
        };
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
      if (name === "chat.priority") {
        job.priority = args.priority;
        listeners.forEach((fn) => fn(structuredClone(data)));
        return;
      }
      if (name === "chat.queue") {
        const assertQueueRevision = args.revision === job.queueRevision;
        if (!assertQueueRevision) throw Error("stale queue");
        const index = job.queuedMessages.findIndex(
          (m) => m.id === args.messageId,
        );
        if (args.action === "remove") job.queuedMessages.splice(index, 1);
        else if (args.action === "edit")
          job.queuedMessages[index].text = args.text;
        else {
          const target = index + (args.action === "up" ? -1 : 1);
          [job.queuedMessages[index], job.queuedMessages[target]] = [
            job.queuedMessages[target],
            job.queuedMessages[index],
          ];
        }
        job.queueRevision++;
        listeners.forEach((fn) => fn(structuredClone(data)));
        return;
      }
      if (name === "scheduler.projectLimit") {
        data.projectLimits = args.limit ? [{cwd:args.cwd,limit:args.limit}] : [];
        listeners.forEach(fn => fn(structuredClone(data)));
        return;
      }
      if (name === "scheduler.dispatch") {
        data.dispatch = { paused: args.paused, projects: [], updatedAt: Date.now() };
        listeners.forEach(fn => fn(structuredClone(data)));
        return data.dispatch;
      }
      if (name === "job.dependencies") {
        job.dependsOn = args.ids;
        listeners.forEach(fn => fn(structuredClone(data)));
        return;
      }
      if (name === "jobs.control") {
        job.state = args.action === "pause" ? "paused" : "queued";
        job.autoRecovery = undefined;
        listeners.forEach((fn) => fn(structuredClone(data)));
        return { results: args.ids.map((id) => ({ id, ok: true })) };
      }
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
  if (!localStorage.getItem("relay.composer.v2"))
    localStorage.setItem(
      "relay.composer.v2",
      JSON.stringify({
        version: 2,
        drafts: {},
        files: {
          [job.id]: [
            { type: "mention", path: "D:/notes.txt", name: "notes.txt" },
          ],
        },
      }),
    );
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
      const queue = page.locator(".message-queue");
      await queue.locator("li").nth(1).locator("button").nth(1).click();
      await page.waitForFunction(
        () =>
          document.querySelector(".message-queue li p")?.textContent ===
          "Second pending instruction",
      );
      await queue.locator("li").first().locator("button").first().click();
      await queue.locator("textarea").fill("Updated pending instruction");
      await queue.locator("li").first().locator("button").first().click();
      await page.waitForFunction(
        () =>
          document.querySelector(".message-queue li p")?.textContent ===
          "Updated pending instruction",
      );
      await queue.locator("li").first().locator("button").last().click();
      await page.waitForFunction(
        () => document.querySelectorAll(".message-queue li").length === 1,
      );
      const history = page.locator(".recovery-history");
      await history.locator("summary").click();
      assert.equal(await history.locator("li").count(), 1);
      await notice.locator("button").click();
      await notice.waitFor({ state: "detached" });
      const controls = await page.evaluate(() =>
        window.recoveryCalls.filter((c) => c.name === "job.control"),
      );
      assert.equal(controls.length, 1);
      assert.equal(controls[0].args.action, "pause");
      report.checks.push(
        `${language}/${theme}/${width}: recovery/history, queue edits, draft reload, search, priority, bulk pause, templates, report preview`,
      );
      const composer = page.locator(".agent-composer-wrap textarea");
      await composer.fill("Persist across restart");
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await page.reload();
      if (process.env.RELAY_QA_FONT) {
        await page.addStyleTag({
          content: `@font-face { font-family: "Relay QA"; src: url(/__qa_font.woff2) format("woff2"); } .desktop-shell { font-family: "Relay QA", sans-serif !important; }`,
        });
        await page.evaluate(() => document.fonts.ready);
      }
      await composer.waitFor();
      assert.equal(await composer.inputValue(), "Persist across restart");
      assert.equal(await page.locator(".draft-attachment").count(), 1);
      await page.locator(".task-priority").selectOption("high");
      await page.waitForFunction(
        () =>
          document.querySelector(".task-priority")?.value === "high" &&
          window.recoveryCalls.some((c) => c.name === "chat.priority"),
      );
      await page.locator(".desktop-product").click();
      await page.locator(".thread-menu button:has(svg.lucide-search)").click();
      await page.locator(".chat-search input").fill("needle");
      await page.locator(".search-results button").click();
      await page.waitForFunction(() =>
        document
          .querySelector(".search-detail")
          ?.textContent.includes("Full original needle message"),
      );
      await page.keyboard.press("Escape");
      await page.locator(".chat-search").waitFor({ state: "detached" });
      await page.locator(".task-queue-button").click();
      await page.locator(".task-center").waitFor();
      await page.locator(".dispatch-controls button").click();
      await page.waitForFunction(() => window.recoveryCalls.some(c => c.name === "scheduler.dispatch" && c.args.paused));
      await page.locator(".dispatch-controls button").click();
      await page.waitForFunction(() => window.recoveryCalls.some(c => c.name === "scheduler.dispatch" && !c.args.paused));
      await page.screenshot({
        path: path.join(output, `task-center-${language}.png`),
        fullPage: true,
      });
      await page.locator(".task-filters select").selectOption({index:1});
      await page.locator(".project-limit select").selectOption("1");
      await page.waitForFunction(() => window.recoveryCalls.some(c => c.name === "scheduler.projectLimit" && c.args.limit === 1));
      await page.locator(".task-filters select").selectOption("");
      await page.locator(".workflow-trigger").click();
      await page.locator(".workflow-builder input").nth(0).fill("Release workflow");
      await page.locator(".workflow-builder textarea").nth(0).fill("Implement and save results to implementation.md");
      await page.locator(".workflow-builder textarea").nth(1).fill("Verify implementation.md and write checks.md");
      await page.locator(".workflow-builder button[type=submit]").click();
      await page.waitForFunction(() => window.recoveryCalls.some(c => c.name === "workflow.add" && c.args.steps.length === 2 && c.args.steps.every(s => s.approvalPolicy === "on-request")));
      await page.locator(".workflow-builder").waitFor({state:"detached"});
      await page.locator(".task-center > .queue-actions button").nth(0).click();
      await page.locator(".task-center > .queue-actions button").nth(1).click();
      await page.locator(".task-report").waitFor();
      await page.locator(".task-summary button").nth(3).click();
      await page.locator(".dependencies-trigger").click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("dialog").locator("button").last().click();
      await page.waitForFunction(() => window.recoveryCalls.some(c => c.name === "job.dependencies" && c.args.ids.length === 0));
      assert.equal(await page.locator(".task-list article").count(), 1);
      await page.locator(".task-card-title button").click();
      await page.locator(".template-trigger").click();
      await page.locator(".task-templates input").fill("Recovery checklist");
      await page
        .locator(".task-templates textarea")
        .fill("Inspect before resuming");
      await page.locator(".task-templates button[type=submit]").click();
      await page
        .locator(".template-list article .queue-actions button")
        .first()
        .click();
      await page.locator(".task-templates").waitFor({ state: "detached" });
      assert.equal(
        await composer.inputValue(),
        "Persist across restart\n\nInspect before resuming",
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.recoveryCalls.filter(
              (c) => c.name === "chat.send" || c.name === "job.add",
            ).length,
        ),
        0,
      );
      await page.locator(".desktop-product").click();
      await page.locator(".task-report-trigger").click();
      await page.locator(".task-report-preview pre").waitFor();
      const reportText = await page
        .locator(".task-report-preview pre")
        .innerText();
      assert.equal(
        JSON.parse(reportText).task.id,
        "11111111-1111-4111-8111-111111111111",
      );
      await page
        .locator(".task-report-preview .queue-actions button")
        .last()
        .click();
      await page.locator(".task-report-preview [role=status]").last().waitFor();
      await page.keyboard.press("Escape");
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
