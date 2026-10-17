const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { chromium } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../..");
(async () => {
  const server = http
    .createServer((req, res) => {
      const file = path.join(
        root,
        "dist/renderer",
        req.url === "/" ? "index.html" : req.url,
      );
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
    })
    .listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROMIUM_PATH,
    headless: true,
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.addInitScript(() => {
      const now = Date.now();
      const job = {
        id: "11111111-1111-4111-8111-111111111111",
        title: "构建一个更好的 Agent 工作台",
        prompt: "升级客户端",
        cwd: "D:\\Projects\\codex-relay",
        mode: "cli",
        model: "gpt-6.1-sol",
        effort: "low",
        bucket: "codex",
        state: "completed",
        rotations: 1,
        createdAt: now,
        updatedAt: now,
        approvalPolicy: "on-request",
        sandbox: "workspaceWrite",
        threadId: "test-thread",
        interactive: true,
        agents: [
          {
            threadId: "44444444-4444-4444-8444-444444444444",
            name: "Explorer",
            role: "explorer",
            status: "completed",
            updatedAt: now,
          },
        ],
      };
      const data = {
        version: 1,
        platform: "win32",
        accounts: [
          {
            id: "account",
            label: "工作账户",
            enabled: true,
            status: "ready",
            quotas: {},
            plan: "plus",
          },
        ],
        jobs: [
          job,
          {
            ...job,
            id: "22222222-2222-4222-8222-222222222222",
            title: "完善文件导入与检索",
            cwd: "D:\\Projects\\notes",
            updatedAt: now - 1000,
          },
        ],
        logs: [],
        settings: {
          cliPath: "codex",
          desktopPath: "",
          pollSeconds: 30,
          retrySeconds: 60,
          resumePrompt: "继续",
          desktop: {},
        },
        cursor: 0,
        approvals: [],
      };
      const items = [
        {
          id: "u",
          role: "user",
          kind: "message",
          text: "把这个项目升级成 Agent 客户端，支持多轮对话、工具执行和自动账户接力。",
          at: now,
        },
        {
          id: "a",
          role: "assistant",
          kind: "message",
          text: "我会先检查现有执行器，再把会话界面和 CLI 协议连接起来。\n\n目前已经完成以下工作：\n- 项目与会话分组，支持搜索和归档\n- 连续追问、排队发送和运行中补充要求\n- 自动保存完整对话与工具执行记录",
          at: now,
        },
        {
          id: "t",
          role: "tool",
          kind: "commandExecution",
          text: "npm run check",
          detail:
            "Test Files  20 passed\nTests       157 passed\nBuild complete.",
          status: "completed",
          at: now,
        },
        {
          id: "d",
          role: "tool",
          kind: "diff",
          text: "编辑了 4 个文件",
          detail:
            "src/renderer/AgentApp.tsx   +310\nsrc/core/chat.ts            +145\nsrc/core/history.ts         +140\nsrc/core/scheduler.ts       +92",
          at: now,
        },
        {
          id: "a2",
          role: "assistant",
          kind: "message",
          text: "实现和验证已完成。\n\n**你可以直接继续提问**。额度不足时，后台会保存会话并选择可用账户，任务继续使用原来的上下文。",
          at: now,
        },
      ];
      let listener;
      const chatListeners = new Set();
      const desktopData = {
        projects: [],
        schedules: [],
        preferences: { theme: "dark", notifications: true },
      };
      window.qaCalls = [];
      window.qaPushChat = (id, value) => {
        for (const fn of chatListeners)
          fn({ id, page: structuredClone(value) });
      };
      window.qaStartStream = () => {
        const content = Array.from(
          { length: 20 },
          (_, n) =>
            `- Verified case ${n}: keep the established context and review the result.`,
        ).join("\n");
        items.splice(
          0,
          items.length,
          ...Array.from({ length: 80 }, (_, n) => ({
            id: `perf-${n}`,
            role: "assistant",
            kind: "message",
            text:
              n === 79
                ? "STREAM_UPDATE_0"
                : `### Result ${n}\n\n${content}\n\n\`\`\`ts\nconst result = 40 + 2;\n\`\`\``,
            at: now,
          })),
        );
        window.qaPushChat(job.id, { items, total: items.length });
      };
      window.qaRunStream = () => {
        let count = 0;
        const timer = setInterval(() => {
          items[79] = {
            ...items[79],
            text:
              `STREAM_UPDATE_${++count}\n\n` +
              "Progress remains visible. ".repeat(count),
          };
          window.qaPushChat(job.id, { items, total: items.length });
          if (count === 40) clearInterval(timer);
        }, 50);
      };
      window.relay = {
        snapshot: async () => structuredClone(data),
        onSnapshot: (fn) => {
          listener = fn;
          return () => {};
        },
        onChat: (fn) => {
          chatListeners.add(fn);
          return () => chatListeners.delete(fn);
        },
        command: async (name, args) => {
          window.qaCalls.push({ name, args });
          if (name === "history.importAll.status")
            return {
              id: "",
              phase: "idle",
              scanned: 0,
              total: 0,
              processed: 0,
              imported: 0,
              skipped: 0,
              failed: 0,
              projects: 0,
              missingProjects: 0,
              readOnly: 0,
              current: "",
              roots: [],
              warnings: [],
              failures: [],
            };
          if (name === "desktop.read") return structuredClone(desktopData);
          if (name === "desktop.preferences") {
            Object.assign(desktopData.preferences, args);
            return structuredClone(desktopData);
          }
          if (name === "workspace.files")
            return [
              { name: "README.md", path: "README.md", directory: false },
              { name: "src", path: "src", directory: true },
            ];
          if (name === "workspace.read" || name === "chat.asset.read")
            return {
              path: args.path,
              kind: "text",
              content: "# Codex Relay\n\n真正可用的 Agent 工作空间。",
              mtime: now,
              size: 64,
            };
          if (name === "workspace.changes")
            return { root: job.cwd, branch: "main", files: [], error: "" };
          if (name === "catalog.operation") {
            if (args.method === "plugin/list")
              return {
                marketplaces: [
                  {
                    name: "official",
                    plugins: [
                      {
                        id: "docs",
                        name: "documents",
                        interface: {
                          displayName: "Documents",
                          shortDescription: "创建、编辑和检查文档",
                        },
                        installed: true,
                      },
                    ],
                  },
                ],
                marketplaceLoadErrors: [],
              };
            if (args.method === "skills/list")
              return {
                data: [
                  {
                    cwd: job.cwd,
                    skills: [
                      {
                        name: "project-review",
                        description: "检查项目并审查代码",
                        path: "D:/Projects/skills/review/SKILL.md",
                        enabled: true,
                      },
                    ],
                  },
                ],
              };
            if (args.method === "mcpServerStatus/list")
              return {
                data: [
                  {
                    name: "project-tools",
                    tools: { inspect: { description: "读取项目状态" } },
                    authStatus: "notLoggedIn",
                  },
                ],
              };
            return {};
          }
          if (name === "terminal.list") return [];
          if (name === "terminal.open")
            return {
              id: "33333333-3333-4333-8333-333333333333",
              cwd: job.cwd,
              name: "PowerShell",
              state: "running",
            };
          if (name === "terminal.read")
            return {
              text: args.cursor ? "" : "PS D:\\Projects\\codex-relay> ",
              cursor: 30,
              state: "running",
            };
          if (name === "chat.read") return { items, total: items.length };
          if (name === "chat.agent.read")
            return {
              items: [
                {
                  id: "child-answer",
                  role: "assistant",
                  kind: "message",
                  text: "CHILD_INITIAL",
                  at: now,
                },
              ],
              total: 1,
            };
          if (name === "chat.send") {
            items.push({
              id: String(items.length),
              role: "user",
              kind: "message",
              text: args.text,
              at: now,
            });
            job.state = "running";
            listener?.(structuredClone(data));
            return;
          }
          if (name === "chat.update") {
            Object.assign(job, args);
            listener?.(structuredClone(data));
            return;
          }
          if (name === "job.control") {
            job.state = "paused";
            listener?.(structuredClone(data));
            return;
          }
          if (name === "chat.attachments")
            return [
              {
                type: "mention",
                path: "D:\\Projects\\README.md",
                name: "README.md",
              },
            ];
          if (name === "account.models")
            return [
              {
                id: "gpt-6.1-sol",
                model: "gpt-6.1-sol",
                displayName: "GPT-6.1 Sol",
                isDefault: true,
                description: "通用编码模型",
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: ["low", "medium", "high"].map(
                  (reasoningEffort) => ({
                    reasoningEffort,
                    description: reasoningEffort,
                  }),
                ),
              },
              {
                id: "gpt-6-astra",
                model: "gpt-6-astra",
                displayName: "GPT-6 Astra",
                description: "复杂任务",
                defaultReasoningEffort: "high",
                supportedReasoningEfforts: [
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                  "ultra",
                ].map((reasoningEffort) => ({
                  reasoningEffort,
                  description: reasoningEffort,
                })),
              },
            ];
          if (name === "history.scan")
            return {
              entries: [
                {
                  id: "abc",
                  title: "从 Desktop 导入的对话",
                  cwd: "D:\\Projects\\codex-relay",
                  source: "vscode",
                  updatedAt: now,
                },
              ],
              roots: ["C:\\Users\\demo\\.codex"],
              warnings: [],
            };
          if (name === "history.import")
            return { imported: [], skipped: ["already"], errors: [] };
          if (name === "agent.operation")
            return { data: [{ name: "project-skill" }] };
          if (name === "choose.directory") return "D:\\Projects\\codex-relay";
          return {};
        },
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page
      .getByRole("button", { name: "构建一个更好的 Agent 工作台" })
      .click();
    await page.getByText("实现和验证已完成。", { exact: false }).waitFor();
    for (const width of [1440, 1920, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: path.join(root, `qa-output/agent-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "选择模型和思考强度" }).click();
    const picker = page.getByRole("dialog", { name: "模型和思考强度" });
    await picker.getByRole("button", { name: "GPT-6.1 Sol" }).click();
    await picker.getByRole("button", { name: "GPT-6 Astra" }).click();
    const slider = picker.getByRole("slider", { name: "思考强度" });
    await slider.focus();
    await page.keyboard.press("End");
    assert.equal(await slider.getAttribute("aria-valuetext"), "最高");
    await picker.getByRole("button", { name: "重置思考强度" }).click();
    assert.equal(await slider.getAttribute("aria-valuetext"), "高");
    await page.screenshot({
      path: path.join(root, "qa-output/agent-model-picker.png"),
    });
    await picker.getByRole("button", { name: "GPT-6 Astra" }).click();
    await picker.getByRole("button", { name: "GPT-6.1 Sol" }).click();
    assert.equal(await slider.getAttribute("max"), "2");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "添加附件", exact: true }).click();
    await page.getByRole("menuitem", { name: "文件和图片" }).click();
    await page.getByLabel("消息", { exact: true }).fill("继续检查边界情况");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("button", { name: "停止本轮", exact: true }).waitFor();
    await page.getByLabel("消息", { exact: true }).fill("加入中文路径测试");
    await page
      .getByRole("button", { name: "立即补充到当前轮次", exact: false })
      .click();
    await page.getByLabel("消息", { exact: true }).fill("完成后总结结果");
    await page.getByRole("button", { name: "排队发送", exact: true }).click();
    await page.getByRole("button", { name: "停止本轮", exact: true }).click();
    await page
      .getByRole("button", { name: "导入历史对话", exact: true })
      .click();
    await page.getByText("从 Desktop 导入的对话", { exact: true }).waitFor();
    await page.getByRole("button", { name: "导入全部", exact: true }).click();
    await page.getByRole("status").waitFor();
    await page.screenshot({
      path: path.join(root, "qa-output/agent-import.png"),
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "重命名会话", exact: true }).click();
    await page.getByLabel("会话名称").fill("重命名验证");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "账户轮换", exact: true }).click();
    await page
      .getByRole("heading", { name: "账户与接力", exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(root, "qa-output/desktop-accounts.png"),
    });
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByRole("button", { name: "浅色", exact: true }).click();
    await page.locator('.desktop-shell[data-color-scheme="light"]').waitFor();
    await page.screenshot({
      path: path.join(root, "qa-output/desktop-light.png"),
    });
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await page.evaluate(() => window.qaStartStream());
    await page.getByText("STREAM_UPDATE_0", { exact: true }).waitFor();
    await page.evaluate(() => {
      const scroll = document.querySelector(".agent-scroll");
      scroll.scrollTop = 120;
      scroll.dispatchEvent(new Event("scroll"));
      window.qaInputFrames = [];
      window.qaLongTasks = [];
      const observer = new PerformanceObserver((list) =>
        window.qaLongTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        ),
      );
      observer.observe({ type: "longtask" });
      window.qaObserver = observer;
      document
        .querySelector('textarea[aria-label="消息"]')
        .addEventListener("input", () => {
          const at = performance.now();
          requestAnimationFrame(() =>
            window.qaInputFrames.push(performance.now() - at),
          );
        });
      window.qaRunStream();
    });
    const draftProbe =
      "typing stays responsive during streaming output ".repeat(3);
    await page
      .getByLabel("消息", { exact: true })
      .pressSequentially(draftProbe, { delay: 12 });
    await page.getByText(/STREAM_UPDATE_40/).waitFor();
    assert.equal(
      await page.getByLabel("消息", { exact: true }).inputValue(),
      draftProbe,
    );
    const smoothness = await page.evaluate(() => {
      window.qaObserver.disconnect();
      const frames = window.qaInputFrames.sort((a, b) => a - b);
      return {
        renderedMessages: document.querySelectorAll(".agent-message").length,
        streamUpdates: 40,
        inputEvents: frames.length,
        inputFrameP95Ms: frames[Math.floor(frames.length * 0.95)],
        maxLongTaskMs: Math.max(0, ...window.qaLongTasks),
        scrollTop: document.querySelector(".agent-scroll").scrollTop,
      };
    });
    assert.ok(smoothness.inputFrameP95Ms < 100, JSON.stringify(smoothness));
    assert.ok(smoothness.maxLongTaskMs < 250, JSON.stringify(smoothness));
    assert.ok(
      Math.abs(smoothness.scrollTop - 120) < 5,
      "Streaming pulled the reader away from their scroll position",
    );
    await page
      .getByRole("button", { name: "完善文件导入与检索", exact: true })
      .click();
    await page.getByLabel("消息", { exact: true }).fill("Second chat draft");
    await page.getByRole("button", { name: "重命名验证", exact: true }).click();
    assert.equal(
      await page.getByLabel("消息", { exact: true }).inputValue(),
      draftProbe,
    );
    assert.ok(
      Math.abs(
        (await page.locator(".agent-scroll").evaluate((el) => el.scrollTop)) -
          120,
      ) < 5,
    );
    await page
      .getByRole("button", { name: "插件与 Skills", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Documents", exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(root, "qa-output/desktop-plugins.png"),
    });
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await page
      .getByRole("heading", { name: "project-review", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "MCP 服务器", exact: true }).click();
    await page
      .getByRole("heading", { name: "project-tools", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await page.getByRole("button", { name: "项目文件", exact: true }).click();
    await page
      .locator(".file-tree")
      .getByRole("button", { name: "README.md", exact: true })
      .click();
    await page
      .locator(".file-preview")
      .getByRole("heading", { name: "Codex Relay", exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(root, "qa-output/desktop-file-preview.png"),
    });
    await page
      .getByRole("button", { name: "关闭工作面板", exact: true })
      .click();
    await page.keyboard.press("Control+k");
    await page
      .getByRole("textbox", { name: "查找聊天或项目" })
      .fill("重命名验证");
    await page.keyboard.press("Enter");
    await page
      .getByRole("dialog", { name: "搜索全部聊天" })
      .waitFor({ state: "hidden" });
    await page.keyboard.press("Control+j");
    await page.getByText("PowerShell 1", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(root, "qa-output/desktop-terminal.png"),
    });
    await page.getByRole("button", { name: "隐藏终端" }).click();
    await page.getByRole("button", { name: "账户轮换", exact: true }).click();
    await page.getByRole("button", { name: "常规", exact: true }).click();
    await page
      .getByRole("combobox", { name: "语言", exact: true })
      .selectOption("en");
    await page.getByRole("heading", { name: "General", exact: true }).waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("heading", { name: "Appearance", exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(root, "qa-output/desktop-english.png"),
    });
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-TW");
    await page
      .getByRole("button", { name: "帳戶與接力", exact: true })
      .waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-TW");
    await page.screenshot({
      path: path.join(root, "qa-output/desktop-traditional.png"),
    });
    await page
      .getByRole("combobox", { name: "語言", exact: true })
      .selectOption("zh-CN");
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    const calls = await page.evaluate(() => window.qaCalls);
    await page.getByRole("button", { name: "会话信息", exact: true }).click();
    await page
      .locator(".workbench-tabs")
      .getByRole("button", { name: /代理/ })
      .click();
    await page.locator(".agent-tree button").first().click();
    await page
      .locator(".child-conversation")
      .getByText("CHILD_INITIAL", { exact: true })
      .waitFor();
    await page.evaluate(() =>
      window.qaPushChat("44444444-4444-4444-8444-444444444444", {
        items: [
          {
            id: "child-answer",
            role: "assistant",
            kind: "message",
            text: "CHILD_PUSHED_LIVE",
            at: 1,
          },
        ],
        total: 1,
      }),
    );
    await page
      .locator(".child-conversation")
      .getByText("CHILD_PUSHED_LIVE", { exact: true })
      .waitFor({ timeout: 2000 });
    assert.equal(
      await page
        .locator(".agent-transcript")
        .getByText("CHILD_PUSHED_LIVE", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.getByLabel("给子代理发送消息", { exact: true }).isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "关闭工作面板", exact: true })
      .click();
    assert.deepEqual(
      calls.filter((c) => c.name === "chat.send").map((c) => c.args.action),
      ["send", "steer", "queue"],
    );
    assert.equal(
      calls.find((c) => c.name === "chat.send").args.attachments[0].name,
      "README.md",
    );
    assert.deepEqual(errors, []);
    assert.equal(
      calls.find((c) => c.name === "chat.send").args.model,
      "gpt-6.1-sol",
    );
    assert.equal(calls.find((c) => c.name === "chat.send").args.effort, "high");
    fs.writeFileSync(
      path.join(root, "qa-output/agent-ui-report.json"),
      JSON.stringify(
        {
          viewports: [1440, 1920, 900],
          send: true,
          steer: true,
          queue: true,
          stop: true,
          attachments: true,
          import: true,
          rename: true,
          modelPicker: true,
          effortSliderAndReset: true,
          settingsAndAccounts: true,
          lightAndDarkTheme: true,
          pluginsSkillsMcpPages: true,
          filePreview: true,
          keyboardSearchAndTerminal: true,
          liveLanguageSwitch: ["en", "zh-TW", "zh-CN"],
          smoothness,
          childLiveUpdatesAndReadOnlyHistory: true,
          rendererErrors: errors,
        },
        null,
        2,
      ),
    );
    console.log("Agent UI checks passed");
  } catch (error) {
    await page
      .screenshot({ path: path.join(root, "qa-output/agent-ui-failure.png") })
      .catch(() => {});
    console.log(
      await page
        .locator(".motion-region, .terminal-pane, .agent-main")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            class: node.className,
            rect: node.getBoundingClientRect().toJSON(),
            style: getComputedStyle(node).gridTemplateRows,
          })),
        )
        .catch(() => []),
    );
    throw error;
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
