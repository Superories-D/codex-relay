// Production renderer interaction preflight. Protocol is simulated here;
// questions-live.cjs separately verifies actual CLI requests and continuation.
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
      const name = path.join(
        root,
        "dist/renderer",
        req.url === "/" ? "index.html" : req.url,
      );
      res.setHeader(
        "Content-Type",
        name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      fs.createReadStream(name)
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
  });
  const report = {
    simulatedProtocol: true,
    inferenceRequests: 0,
    rendererErrors: [],
  };
  page.on("pageerror", (e) => report.rendererErrors.push(e.message));
  try {
    await page.addInitScript(() => {
      const id = "11111111-1111-4111-8111-111111111111";
      const job = {
        id,
        title: "问题交互验收",
        cwd: "D:\\QA",
        mode: "cli",
        model: "",
        effort: "",
        state: "running",
        threadId: "thread-1",
        sandbox: "readOnly",
        approvalPolicy: "never",
        rotations: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const data = {
        jobs: [job],
        accounts: [],
        approvals: [],
        logs: [],
        settings: {},
        platform: "win32",
      };
      const desktop = {
        projects: [],
        schedules: [],
        preferences: { theme: "dark", language: "zh-CN", notifications: false },
      };
      let listener;
      const chats = new Set(),
        history = [];
      window.qaQuestionCalls = [];
      const notify = () => listener?.(structuredClone(data));
      window.qaAsk = (isBlocking = true) => {
        const params = {
          threadId: job.threadId,
          turnId: "turn-1",
          isBlocking,
          questions: [
            {
              id: "direction",
              header: "Direction",
              question: "Choose a direction.",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Small", description: "A narrow change" },
                { label: "Large", description: "A broad change" },
              ],
            },
            {
              id: "private",
              header: "Private",
              question: "Enter a private test value.",
              isOther: false,
              isSecret: true,
              options: null,
            },
            {
              id: "note",
              header: "Notes",
              question: "What else should I know?",
              isOther: false,
              isSecret: false,
              options: null,
            },
          ],
        };
        const approval = {
          id: String(history.length + 1),
          jobId: id,
          historyId: `question:${history.length + 1}`,
          kind: "input",
          method: "item/tool/requestUserInput",
          params,
        };
        data.approvals = [approval];
        history.unshift({
          ...params,
          id: approval.historyId,
          requestId: approval.id,
          status: "pending",
          at: Date.now(),
        });
        notify();
      };
      window.qaFinish = (status) => {
        const pending = data.approvals[0];
        history[0].status = status;
        if (status === "answered") {
          const value = window.qaQuestionCalls.at(-1).value;
          history[0].answers = {
            direction: value.answers.direction,
            note: value.answers.note,
          };
        }
        data.approvals = [];
        notify();
        for (const fn of chats) fn({ id, page: { items: [], total: 0 } });
      };
      window.relay = {
        snapshot: async () => structuredClone(data),
        onSnapshot: (fn) => {
          listener = fn;
          return () => {};
        },
        onChat: (fn) => {
          chats.add(fn);
          return () => chats.delete(fn);
        },
        command: async (name, args) => {
          if (name === "desktop.read") return structuredClone(desktop);
          if (name === "desktop.preferences") {
            Object.assign(desktop.preferences, args);
            return structuredClone(desktop);
          }
          if (name === "chat.read") return { items: [], total: 0 };
          if (name === "chat.questions.read")
            return { items: structuredClone(history), total: history.length };
          if (name === "chat.assets.list") return { outputs: [], sources: [] };
          if (name === "workspace.files") return [];
          if (name === "chat.goal.read") return { goal: null };
          if (name === "approval.respond") {
            window.qaQuestionCalls.push(structuredClone(args));
            data.approvals[0].responsePending = true;
            notify();
            return;
          }
          if (name === "history.importAll.status")
            return {
              phase: "idle",
              total: 0,
              processed: 0,
              warnings: [],
              failures: [],
            };
          return {};
        },
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page
      .getByRole("button", { name: "问题交互验收", exact: true })
      .click();
    await page.evaluate(() => window.qaAsk());
    await page.getByRole("form", { name: "回答 Codex 的问题" }).waitFor();
    await page.getByRole("button", { name: "提交回答", exact: true }).click();
    await page
      .getByText("请填写有效的回答，每项最多 10000 个字符", { exact: true })
      .waitFor();
    assert.equal(await page.evaluate(() => window.qaQuestionCalls.length), 0);
    const fields = page.locator(".question-request fieldset");
    await fields.nth(0).getByLabel("自定义回答", { exact: true }).check();
    await fields
      .nth(0)
      .getByLabel("你的回答", { exact: true })
      .fill("Custom direction");
    await fields.nth(0).getByText("补充说明（可选）", { exact: true }).click();
    await fields
      .nth(0)
      .getByLabel("给 Direction 补充说明", { exact: true })
      .fill("Preserve this note");
    await fields
      .nth(1)
      .getByLabel("私密回答", { exact: true })
      .fill("SYNTHETIC_PRIVATE_DRAFT");
    await fields
      .nth(2)
      .getByLabel("你的回答", { exact: true })
      .fill("Keep it smooth");
    await page
      .locator(".workbench-tabs")
      .getByRole("button", { name: "文件", exact: true })
      .click();
    await page
      .locator(".workbench-tabs")
      .getByRole("button", { name: /问题/ })
      .click();
    assert.equal(
      await fields.nth(1).getByLabel("私密回答", { exact: true }).inputValue(),
      "SYNTHETIC_PRIVATE_DRAFT",
    );
    const storage = await page.evaluate(() =>
      JSON.stringify([
        Object.values(localStorage),
        Object.values(sessionStorage),
      ]),
    );
    assert(!storage.includes("SYNTHETIC_PRIVATE_DRAFT"));
    await page.screenshot({
      path: path.join(root, "qa-output/desktop-questions.png"),
    });
    await page.getByRole("button", { name: "提交回答", exact: true }).click();
    await page
      .getByText("回答已发送，正在等待服务器确认", { exact: true })
      .waitFor();
    assert.equal(await page.evaluate(() => window.qaQuestionCalls.length), 1);
    assert.deepEqual(
      await page.evaluate(() => window.qaQuestionCalls[0].value.answers),
      {
        direction: { answers: ["Custom direction", "Preserve this note"] },
        private: { answers: ["SYNTHETIC_PRIVATE_DRAFT"] },
        note: { answers: ["Keep it smooth"] },
      },
    );
    await page.evaluate(() => window.qaFinish("answered"));
    await page
      .locator(".question-history-item")
      .getByText("已回答", { exact: true })
      .waitFor();
    await page.locator(".question-history-item > summary").click();
    await page.getByText("回答已隐藏", { exact: true }).waitFor();
    await page.getByText("Keep it smooth", { exact: true }).waitFor();
    await page.evaluate(() => window.qaAsk());
    await page.getByRole("form", { name: "回答 Codex 的问题" }).waitFor();
    await page.evaluate(() => window.qaFinish("expired"));
    await page.getByText("问题已失效", { exact: true }).waitFor();
    assert.equal(await page.locator(".question-request").count(), 0);
    await page
      .locator(".workbench-tabs")
      .getByRole("button", { name: "文件", exact: true })
      .click();
    await page.evaluate(() => window.qaAsk(false));
    assert.equal(
      await page.locator(".workbench-tabs button.selected").innerText(),
      "文件",
    );
    await page
      .locator(".workbench-tabs")
      .getByRole("button", { name: /问题/ })
      .click();
    await page.getByText("可稍后回答", { exact: true }).waitFor();
    await page.setViewportSize({ width: 900, height: 760 });
    await page.screenshot({
      path: path.join(root, "qa-output/desktop-questions-narrow.png"),
    });
    assert.deepEqual(report.rendererErrors, []);
    Object.assign(report, {
      status: "passed",
      multiQuestionCustomAndNotes: true,
      memoryOnlyDrafts: true,
      nativeConfirmationRequired: true,
      expirationAndNonblocking: true,
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    await page
      .screenshot({
        path: path.join(root, "qa-output/questions-ui-failed.png"),
      })
      .catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(root, "qa-output/questions-ui-report.json"),
      JSON.stringify(report, null, 2),
    );
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
