// Production renderer, synthetic workspace and IPC only. No credentials or CLI turns.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.RELAY_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "../.."), output = path.join(root, "qa-output");

function fixture({ theme, language }) {
  const now = Date.now(), cwd = "D:\\Projects\\codex-relay";
  const job = {
    id: "11111111-1111-4111-8111-111111111111", cwd,
    title: "请先完整阅读项目交接文档：D:/Projects/codex-relay/docs/HANDOFF-ALL.md，承接已有成果",
    prompt: "阅读项目交接，继续优化桌面体验", state: "completed", mode: "cli",
    model: "gpt-6-astra", effort: "high", sandbox: "workspaceWrite",
    approvalPolicy: "on-request", bucket: "codex", rotations: 1, interactive: true,
    createdAt: now, updatedAt: now,
  };
  const names = ["合作开发", "学校摄影社网站", "TAIANOVA", "Discord-app", "taiko-web", "合并", "codex-relay", "taiko.su", "作业文件处理", "同学", "投屏", "转移"];
  const desktop = {
    projects: Array.from({ length: 60 }, (_, i) => ({
      id: `project-${i}`, name: names[i] || `Project ${i + 1}`,
      cwd: i === 6 ? cwd : `D:\\Projects\\${names[i] || `project-${i}`}`,
    })),
    schedules: [], preferences: { theme, language, notifications: false },
  };
  const data = {
    version: 1, platform: "win32", cursor: 0, logs: [], approvals: [],
    settings: { cliPath: "codex", desktop: {}, resetWarmupEnabled: false },
    accounts: Array.from({ length: 3 }, (_, i) => ({ id: `account-${i}`, label: `Account ${i + 1}`, enabled: true, status: "ready", plan: "team", quotas: {} })),
    jobs: [job, { ...job, id: "second", title: "完善文件导入与检索" }, { ...job, id: "child", title: "检查渲染边界", historySource: { source: "subagent" } }],
  };
  const item = (id, role, kind, text, detail) => ({ id, role, kind, text, detail, at: now, status: "completed", turnId: "turn-1" });
  const items = [
    item("user", "user", "message", "请阅读交接文档，承接已有成果，先说明当前状态和未完成事项。"),
    item("read-1", "tool", "commandExecution", "Get-Content docs/HANDOFF-ALL.md", "Project handoff · UTF-8\nSource read successfully."),
    item("reason-1", "tool", "reasoning", "检查已有证据与当前任务的边界。"),
    item("read-2", "tool", "commandExecution", "git status --short --branch", "## main...origin/main"),
    item("read-3", "tool", "commandExecution", "Get-Content docs/VALIDATION.md", "Validation record loaded."),
    item("answer", "assistant", "message", "已完整阅读 `HANDOFF-ALL.md`，包括技术附录与 Git 记录。\n\n**当前状态**\n\n项目基于真实 CLI 运行，已接通会话、账户接力、子代理、文件预览和集成终端。已有验证记录会继续保留。\n\n- **会话与接力**：支持连续追问、排队发送和同一线程恢复。最近一次真实任务已完成自动换号，任务产物仍需单独验收。\n- **桌面工作台**：项目、文件、Git 更改与终端已接入实际操作，支持简体中文、繁体中文和英文。\n- **仍需完善**：复杂子代理恢复、完整额度重置周期，以及更多长历史和窄窗口场景。\n\n长期目标保持暂停，下一步会按你的具体要求继续。\n\n相关记录保存在 [验收文档](docs/VALIDATION.md)，可随时查看。"),
  ];
  let progress = { id: "import-1", phase: "completed", scanned: 652, total: 652, processed: 652, imported: 0, updated: 0, skipped: 652, failed: 0, projects: 60, projectsTotal: 60, missingProjects: 0, readOnly: 632, current: "", roots: [], warnings: [], failures: [] };
  let listener;
  window.visualCalls = [];
  window.visualImport = (patch) => Object.assign(progress, patch);
  window.relay = {
    snapshot: async () => structuredClone(data),
    onSnapshot: (fn) => { listener = fn; return () => {}; },
    onChat: () => () => {},
    command: async (name, args) => {
      window.visualCalls.push(name);
      if (name === "desktop.read") return structuredClone(desktop);
      if (name === "desktop.preferences") { Object.assign(desktop.preferences, args); return structuredClone(desktop); }
      if (name === "history.importAll.status") return structuredClone(progress);
      if (name === "history.importAll.start") { progress = { ...progress, phase: "importing", processed: 12 }; return structuredClone(progress); }
      if (name === "history.importAll.cancel") { progress.phase = "cancelled"; return structuredClone(progress); }
      if (name === "chat.read") return { items, total: items.length };
      if (name === "chat.update") { Object.assign(job, args); listener?.(structuredClone(data)); return job; }
      if (name === "account.models") return [{ id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", description: "", defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }];
      if (name === "workspace.files") return [];
      if (name === "workspace.changes") return { root: cwd, branch: "main", files: [] };
      if (name === "chat.assets") return { files: [], images: [], sources: [] };
      return {};
    },
  };
  localStorage.setItem("relay.lastChat", job.id);
  localStorage.setItem("relay.inspector", "false");
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  let browser;
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, "dist/renderer", "." + (req.url === "/" ? "/index.html" : req.url));
    if (!file.startsWith(path.join(root, "dist/renderer") + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".woff2") ? "font/woff2" : "text/html");
    fs.createReadStream(file).on("error", () => res.end()).pipe(res);
  });
  const report = { syntheticData: true, modelRequests: 0, layouts: [], checks: [], rendererErrors: [] };
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ executablePath: process.env.RELAY_CHROMIUM_PATH, headless: true });
    for (const [theme, language, width, height] of [
      ["dark", "zh-CN", 1600, 1000], ["light", "zh-CN", 1600, 1000],
      ["dark", "en", 900, 760], ["light", "zh-TW", 1100, 850],
      ["dark", "zh-CN", 900, 1020],
    ]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: width === 900 ? 1.5 : 1.25 });
      page.on("pageerror", (e) => report.rendererErrors.push(e.message));
      await page.addInitScript(fixture, { theme, language });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.locator(".agent-message.assistant").waitFor();
      await page.locator(".sidebar-import .import-summary-status svg").waitFor();
      await page.waitForFunction(() => document.querySelector(".agent-composer textarea").clientHeight <= 42);
      const dimensions = await page.evaluate(() => {
        const rect = (s) => document.querySelector(s).getBoundingClientRect();
        const transcript = rect(".agent-transcript"), composer = rect(".agent-composer"), input = rect(".agent-composer textarea"), send = rect(".agent-send"), model = rect(".agent-model-trigger");
        return { composerHeight: composer.height, controlsHeight: rect(".composer-controls").height, inputHeight: input.height, sendInInputRow: send.y >= composer.y && send.bottom <= composer.bottom, modelBelowInput: model.y >= composer.bottom, alignment: Math.abs(transcript.x + parseFloat(getComputedStyle(document.querySelector(".agent-transcript")).paddingLeft) - composer.x), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      await page.screenshot({ path: path.join(output, `workspace-${theme}-${language}.png`) });
      assert.ok(dimensions.composerHeight <= 50, `one-line composer stays compact: ${JSON.stringify(dimensions)}`);
      assert.ok(dimensions.controlsHeight <= 86, `input and footer together stay compact: ${JSON.stringify(dimensions)}`);
      assert.ok(dimensions.sendInInputRow, "send stays beside the text input");
      assert.ok(dimensions.modelBelowInput, "model controls stay outside the input surface");
      assert.ok(dimensions.alignment <= 8, "composer aligns with message column (including scrollbar gutter)");
      assert.equal(dimensions.overflow, false);
      assert.equal(await page.locator(".sidebar-import").evaluate((e) => e.open), false, "old successful imports do not occupy the sidebar");
      const input = page.locator(".agent-composer textarea");
      await input.fill("我感觉这个 UI 还是不够精致，继续优化一下。");
      await page.screenshot({ path: path.join(output, `workspace-${theme}-${language}.png`) });
      await input.fill(Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行：保留完整的多行输入与草稿。`).join("\n"));
      assert.ok(await input.evaluate((e) => e.clientHeight) >= 180);
      await input.fill("继续优化");
      await page.waitForFunction(() => document.querySelector(".agent-composer textarea").clientHeight <= 42);
      // Long drafts wrap when resizing even without an input event.
      await input.fill("跨窗口调整时完整保留输入内容。".repeat(18));
      await page.setViewportSize({ width: 820, height: 760 });
      await page.waitForTimeout(300);
      assert.ok(await input.evaluate((e) => e.clientHeight >= 180 || e.scrollHeight <= e.clientHeight + 2));
      await input.fill("");
      await page.setViewportSize({ width, height });
      const checkPopover = async (selector) => {
        await page.locator(selector).evaluate(async (node) => {
          await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {})));
        });
        const geometry = await page.locator(selector).evaluate((node) => {
          const popup = node.getBoundingClientRect();
          const input = document.querySelector('.agent-composer').getBoundingClientRect();
          return { width: popup.width, height: popup.height, bottom: popup.bottom, inputTop: input.top, aboveInput: popup.bottom <= input.top - 6, visible: popup.x >= 0 && popup.right <= innerWidth && popup.y >= 0 };
        });
        assert.ok(geometry.aboveInput && geometry.visible, JSON.stringify(geometry));
        return geometry;
      };
      await page.locator('.agent-model-trigger').click();
      await page.locator('.agent-model-popover input[type="range"]').waitFor();
      const modelGeometry = await checkPopover('.agent-model-popover');
      assert.ok(modelGeometry.width <= 300 && modelGeometry.height <= 170, JSON.stringify(modelGeometry));
      await page.locator('.agent-model-popover input').press('End');
      assert.equal(await page.locator('.agent-model-popover input').inputValue(), '5');
      await page.screenshot({ path: path.join(output, `popover-model-${theme}-${language}-${width}.png`) });
      await page.keyboard.press('Escape');
      await page.locator('.agent-model-popover').waitFor({ state: 'detached' });
      await page.locator('.permission-trigger').press('ArrowDown');
      await page.locator('.permission-menu').waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitemradio');
      await checkPopover('.permission-menu');
      await page.keyboard.press('End');
      assert.ok(await page.getByRole('menuitemradio').last().evaluate(node => node === document.activeElement), 'End focuses last permission');
      await page.keyboard.press('Enter');
      await page.locator('.permission-trigger').click();
      assert.equal(await page.getByRole('menuitemradio').last().getAttribute('aria-checked'), 'true');
      await page.screenshot({ path: path.join(output, `popover-permission-${theme}-${language}-${width}.png`) });
      await page.keyboard.press('Escape');
      assert.ok(await page.locator('.permission-trigger').evaluate((node) => node === document.activeElement));
      await page.locator('.permission-trigger').click();
      await input.click();
      assert.equal(await page.locator('.permission-menu').count(), 0);
      await page.locator(".sidebar-import > summary").click();
      await page.locator(".sidebar-import-content > button").first().click();
      await page.waitForFunction(() => document.querySelector(".sidebar-import progress") !== null);
      await page.locator(".import-all-progress > button").click();
      assert.ok((await page.evaluate(() => window.visualCalls)).includes("history.importAll.cancel"));
      await page.locator(".sidebar-import > summary").click();
      await page.evaluate(() => window.visualImport({ phase: "failed", failed: 1, failures: [{ title: "Unavailable source", message: "Fixture read failed" }] }));
      await page.waitForFunction(() => document.querySelector(".sidebar-import").open);
      assert.ok(await page.locator(".import-all-progress details").count());
      const calls = await page.evaluate(() => window.visualCalls);
      assert.equal(calls.some((name) => ["chat.send", "chat.create", "job.add", "goal.create"].includes(name)), false);
      report.layouts.push({ theme, language, width, height, ...dimensions });
      await page.close();
    }
    report.checks = ["60 projects and long titles", "compact composer grows and shrinks", "resizing wrapped draft", "successful import collapsed", "start and cancel import", "failed import reveals details", "light/dark and three languages", "compact model panel above input", "permission keyboard selection, Escape focus and outside dismissal", "150 percent display scale"];
    assert.deepEqual(report.rendererErrors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } finally {
    fs.writeFileSync(path.join(output, "workspace-visual-report.json"), JSON.stringify(report, null, 2));
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
