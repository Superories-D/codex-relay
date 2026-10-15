const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { chromium: playwright } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../..");
const output = process.env.RELAY_QA_OUTPUT || path.join(root, "qa-output");
let activeBrowser, activeServer;
(async () => {
  const server = (activeServer = http
    .createServer((req, res) => {
      const p = req.url.startsWith("/fonts/")
        ? path.join(process.env.RELAY_QA_FONT_DIR || "", req.url.slice(7))
        : path.join(
            root,
            "dist/renderer",
            req.url === "/" ? "index.html" : req.url,
          );
      res.setHeader(
        "Content-Type",
        p.endsWith(".js")
          ? "text/javascript"
          : p.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      fs.createReadStream(p)
        .on("error", () => res.end())
        .pipe(res);
    })
    .listen(0, "127.0.0.1"));
  await new Promise((r) => server.once("listening", r));
  const browser = (activeBrowser = await playwright.launch({
    executablePath: process.env.RELAY_CHROMIUM_PATH || undefined,
    args: JSON.parse(process.env.RELAY_BROWSER_ARGS || "[]"),
    headless: true,
  }));
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const now = Date.now();
    const q = (used, hours, mins) => ({
      usedPercent: used,
      resetsAt: now + hours * 3600000,
      windowDurationMins: mins,
    });
    const accounts = [
      ["a", "主力账户", "dev@example.test", 0, 100, 86, "limited"],
      ["b", "项目账户", "project@example.test", 1, 38, 64, "ready"],
      ["c", "备用账户", "backup@example.test", 2, 12, 25, "ready"],
    ].map(([id, label, email, i, primary, secondary, status]) => ({
      id,
      identity: id,
      label,
      email,
      plan: "plus",
      enabled: true,
      status,
      blockedUntil: null,
      failureCount: 0,
      quotas: {
        codex: {
          primary: q(primary, 3, 300),
          secondary: q(secondary, 52, 10080),
          limitId: "codex",
          observedAt: now,
          reached: false,
        },
      },
    }));
    const snapshot = {
      version: 1,
      platform: "win32",
      accounts,
      approvals: [],
      cursor: 1,
      settings: {
        cliPath: "codex",
        desktopPath: "",
        pollSeconds: 30,
        retrySeconds: 60,
        resumePrompt:
          "继续之前的任务。先检查工作目录与已完成的操作，从中断处继续。",
        desktop: {
          editorSelector: "textarea",
          sendSelector: 'button[aria-label="Send"]',
          stopSelector: 'button[aria-label="Stop"]',
          threadSelector: '[data-thread-id="{threadId}"]',
        },
      },
      jobs: [
        {
          id: "job",
          title: "完成账户管理与权限模块",
          prompt: "为现有应用实现账户管理和权限检查，补充必要的验证。",
          cwd: "C:\\Projects\\workspace",
          mode: "desktop",
          stage: "客户端正在执行；需要审批时请在官方窗口处理",
          lastHeartbeatAt: now,
          model: "默认模型",
          effort: "",
          bucket: "codex",
          state: "running",
          threadId: "019d9f29-demo",
          turnId: "turn",
          accountId: "b",
          rotations: 3,
          createdAt: now - 86400000,
          updatedAt: now,
          approvalPolicy: "on-request",
          sandbox: "workspaceWrite",
        },
      ],
      logs: [
        {
          id: "1",
          at: now - 50000,
          level: "warning",
          message: "检测到额度中断：会话已保存，准备轮换账户。任务尚未完成。",
          jobId: "job",
        },
        {
          id: "2",
          at: now - 40000,
          level: "info",
          message: "原任务已确认停止，切换至项目账户。",
          jobId: "job",
        },
        {
          id: "3",
          at: now - 30000,
          level: "info",
          message: "已恢复原会话，继续完成账户管理与权限模块。",
          jobId: "job",
        },
      ],
    };
    window.qa = {
      snapshot,
      calls: [],
      push: () => {
        snapshot.jobs[0].updatedAt = Date.now();
        window.qa.listener?.(structuredClone(snapshot));
      },
    };
    window.relay = {
      snapshot: async () => structuredClone(snapshot),
      onSnapshot: (fn) => {
        window.qa.listener = fn;
        return () => {};
      },
      command: async (name, args) => {
        window.qa.calls.push({ name, args });
        if (name === "health") return {};
        const candidate = {
          id: "existing-preview",
          threadId: "019d9f29-ace0-7000-8123-aaaaaaaaaaaa",
          title: "继续原窗口中的账户管理任务",
          cwd: "C:\\Projects\\workspace",
          source: "cli",
          status: "running",
          updatedAt: now,
          model: "",
          preview: "完成项目",
        };
        if (name === "session.scan")
          return {
            home: "C:\\Users\\Developer\\.codex",
            candidates: [candidate],
            warnings: [],
          };
        if (name === "session.inspect")
          return {
            candidate,
            processes: [
              {
                pid: 1234,
                startedAt: "638000000000000000",
                executable: "C:\\Apps\\Codex.exe",
                title: "Codex · 现有项目",
              },
            ],
            canHandoff: true,
          };
        if (name === "session.attach") {
          if (window.qa.attachFailure) {
            window.qa.attachFailure = false;
            throw new Error("合成错误：进程列表已改变，请重新检查");
          }
          const job = {
            ...snapshot.jobs[0],
            id: "adopted",
            title: candidate.title,
            state: "watching",
            mode: args.mode,
            existing: { phase: "watching", strategy: args.strategy },
          };
          snapshot.jobs.push(job);
          window.qa.push();
          return job;
        }

        if (name === "environment.check")
          return {
            checks: [
              { name: "Codex CLI", status: "ok", detail: "codex-cli 0.162.1" },
              {
                name: "真实账户与客户端",
                status: "warning",
                detail: "尚需实际运行核实",
              },
            ],
          };
        if (["account.import", "account.importLocal"].includes(name))
          return {
            id: "import-preview",
            expiresAt: Date.now() + 600000,
            rows: [
              {
                index: 0,
                label: "待导入账户",
                email: "import@example.test",
                plan: "plus",
                action: "add",
              },
              {
                index: 1,
                label: "已删除账户",
                email: "",
                plan: "",
                action: "skip",
                error: "已删除，默认跳过",
              },
            ],
          };
        if (name === "account.importCommit")
          return {
            imported: 1,
            results: [{ index: 0, label: "待导入账户", ok: true }],
          };
        if (name === "account.models") return [];
        if (name === "account.refresh")
          return new Promise((r) => {
            window.qa.release = r;
          });
        if (name === "desktop.detect")
          return {
            candidates: [
              {
                executable: "C:\\Apps\\Codex.exe",
                name: "Codex",
                version: "test",
                source: "Synthetic",
              },
            ],
          };
        if (name === "job.desktop.inspect")
          return {
            connected: true,
            threadSelected: true,
            hasDraft: false,
            counts: {
              editorSelector: 1,
              sendSelector: 0,
              stopSelector: 1,
              threadSelector: 1,
            },
          };
        if (name === "job.add") throw new Error("合成错误：工作目录不可用");
        if (name === "settings.save") {
          snapshot.settings = args;
          window.qa.push();
          return;
        }
        return null;
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole("heading", { name: "接力工作，不丢进度。" }).waitFor();

  if (process.env.RELAY_QA_FONT_DIR) {
    await page.addStyleTag({ url: "/fonts/index.css" });
    await page.addStyleTag({
      content:
        'body,button,input,select,textarea,pre{font-family:"Noto Sans SC",sans-serif!important}',
    });
    await page.evaluate(() => document.fonts.ready);
  }
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "ui-dashboard.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "检查适配", exact: true }).click();
  await page.getByRole("dialog", { name: "客户端适配检查" }).waitFor();
  assert.equal(
    await page.getByRole("dialog").getByText("已确认", { exact: true }).count(),
    1,
  );
  await page.screenshot({
    path: path.join(output, "ui-desktop-check.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(
      () => window.qa.calls.filter((c) => c.name === "job.control").length,
    ),
    0,
  );
  await page
    .getByRole("button", { name: "刷新额度", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "新建任务", exact: false })
    .first()
    .click();
  const modal = page.getByRole("dialog");
  await modal.waitFor();
  await modal.getByRole("button", { name: "读取", exact: true }).click();
  await modal
    .getByRole("alert")
    .filter({ hasText: "同一账户正在处理另一项操作" })
    .waitFor();

  await modal.getByLabel("任务名称").fill("UI regression");
  await modal
    .getByRole("textbox", { name: "工作目录", exact: false })
    .fill("C:\\Projects\\test");
  await modal.getByLabel("任务目标").fill("合成检查");
  await modal.getByLabel("执行方式").selectOption("desktop");
  await modal.getByText("完成校验（可选）", { exact: true }).click();
  await modal.getByLabel("完成标记", { exact: true }).fill("[TASK_DONE]");
  await modal.getByLabel("自动补完次数上限").fill("2");
  await page.screenshot({
    path: path.join(output, "ui-new-task.png"),
    fullPage: true,
  });
  await modal
    .getByRole("button", { name: "加入队列并开始", exact: false })
    .click();
  await modal
    .getByRole("alert")
    .filter({ hasText: "工作目录不可用" })
    .waitFor();
  assert.equal(
    await modal.getByLabel("任务名称").inputValue(),
    "UI regression",
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.qa.release());
  assert.equal(
    await page.evaluate(
      () =>
        window.qa.calls.find((c) => c.name === "job.add").args.completionMarker,
    ),
    "[TASK_DONE]",
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.qa.calls.find((c) => c.name === "job.add").args
          .maxCompletionRetries,
    ),
    2,
  );
  await page.getByRole("button", { name: "账户轮换", exact: true }).click();
  await page.getByRole("button", { name: "导入账户备份", exact: true }).click();
  const imports = page.getByRole("dialog", { name: "预览账户导入" });
  await imports.waitFor();
  assert.equal(await imports.getByRole("checkbox").nth(1).isDisabled(), true);
  await page.screenshot({
    path: path.join(output, "ui-import.png"),
    fullPage: true,
  });
  await imports
    .getByRole("button", { name: "确认导入 1 个账户", exact: true })
    .click();
  await imports.getByText("已导入 1 个账户。额度将由后台核实。").waitFor();
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.qa.calls.find((c) => c.name === "account.importCommit").args
          .indices,
    ),
    [0],
  );
  await imports.getByRole("button", { name: "完成", exact: true }).click();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "检查运行环境", exact: true }).click();
  await page.getByText("codex-cli 0.162.1", { exact: true }).waitFor();
  const cli = page.locator(".settings-form input").first();
  await cli.fill("draft-codex.exe");
  await page.evaluate(() => window.qa.push());
  assert.equal(await cli.inputValue(), "draft-codex.exe");
  await page.getByRole("button", { name: "自动检测官方客户端" }).click();
  await page.getByText("发现 1 个安装；选择后保存设置。").waitFor();
  assert.equal(
    await page
      .getByPlaceholder("留空尝试发现 Microsoft Store 安装")
      .inputValue(),
    "C:\\Apps\\Codex.exe",
  );
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByRole("button", { name: "已保存 ✓", exact: true }).waitFor();
  await page.screenshot({
    path: path.join(output, "ui-settings.png"),
    fullPage: true,
  });
  await page.evaluate(() => {
    window.qa.snapshot.jobs[0].state = "paused";
    window.qa.push();
  });
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "继续任务", exact: true }).waitFor();
  assert.equal(await page.locator(".activity").count(), 0);
  await page.evaluate(() => {
    window.qa.attachFailure = true;
  });
  await page.getByRole("button", { name: "接入已有会话", exact: true }).click();
  const existing = page.getByRole("dialog", { name: "接入已有 Codex 会话" });
  await existing
    .getByRole("button", { name: "扫描本机会话", exact: true })
    .click();
  const source = existing.getByRole("button", {
    name: /继续原窗口中的账户管理任务/,
  });
  await source.click();
  const accept = existing.getByRole("button", {
    name: "接入并等待额度中断",
    exact: true,
  });
  assert.equal(await accept.isDisabled(), true);
  await existing.getByRole("checkbox").check();
  await existing.getByLabel("交接后的运行方式").selectOption("desktop");
  await accept.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "ui-existing-session.png"),
    fullPage: true,
  });
  await accept.click();
  await existing
    .getByRole("alert")
    .filter({ hasText: "进程列表已改变" })
    .waitFor();
  assert.equal(await existing.isVisible(), true);
  await source.click();
  assert.equal(await existing.getByRole("checkbox").isChecked(), false);
  await existing.getByRole("checkbox").check();
  await page.setViewportSize({ width: 860, height: 620 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await accept.click();
  await existing.waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "立即交接并继续", exact: true })
    .waitFor();
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.qa.calls.filter((c) => c.name === "session.attach").at(-1).args,
    ),
    {
      id: "existing-preview",
      strategy: "quota",
      mode: "desktop",
      allowStop: true,
    },
  );
  await page.evaluate(() => {
    window.qa.snapshot.jobs = window.qa.snapshot.jobs.filter(
      (j) => j.id !== "adopted",
    );
    window.qa.push();
  });

  const sizes = [
    { width: 1440, height: 900 },
    { width: 1000, height: 700 },
    { width: 860, height: 620 },
  ];
  for (const size of sizes) {
    await page.setViewportSize(size);
    for (const tab of ["工作台", "账户轮换", "任务队列", "运行记录", "设置"]) {
      await page
        .getByRole("button", { name: tab, exact: tab !== "任务队列" })
        .first()
        .click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${size.width}px ${tab} horizontal overflow`,
      );
    }
  }
  await page
    .getByRole("button", { name: "任务队列", exact: false })
    .first()
    .click();
  await page.screenshot({
    path: path.join(output, "ui-compact.png"),
    fullPage: true,
  });
  await page.getByLabel("搜索任务").fill("no matching title");
  await page.getByRole("heading", { name: "没有匹配的任务" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      checks:
        "Existing-session scan/inspection/explicit consent/error recovery/attachment, import preview/selection, completion criteria, environment check, Desktop diagnostics, cancellation, long command responsiveness, form errors, draft persistence, autodetection, saved feedback, paused state, search, 3 viewport sizes / 5 tabs",
      errors,
      screenshots: 7,
      overflow: await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    }),
  );
  await browser.close();
  server.close();
})().catch(async (e) => {
  console.error(e);
  await activeBrowser?.close();
  activeServer?.close();
  process.exitCode = 1;
});
