// Native renderer, local fonts and OS clipboard. No credentials or inference.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
const code = 'const greeting = "你好 → ≥ & <";\n  console.log(greeting);\n';
const formula = String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`;
const text = `### 可阅读，也可准确复制\n\n**正文**包含行内代码 \`value >= 0\`、→ × ≤ ≥ ∞ 和公式 \\(\\alpha + \\beta \\ge 1\\)。\n\n> 保留原文、缩进和符号。\n\n"""javascript\n${code}\n"""\n\n\\[\n${formula}\n\\]\n\n| 内容 | 状态 |\n|---|---|\n| 代码与公式 | ✓ |\n| 多语言 | 中文 / English |\n\n- [x] 复制代码\n- [ ] 下一步\n\n注释在当前回答内定位[^note]。\n\n[^note]: 保留完整来源。`;
(async () => {
  const fixture = await fs.mkdtemp(path.join(output, "message-format-")),
    profile = path.join(fixture, "profile"),
    cwd = path.join(fixture, "project"),
    id = randomUUID(),
    now = Date.now();
  await fs.mkdir(path.join(profile, "chats"), { recursive: true });
  await fs.mkdir(cwd);
  const sourceFile = path.join(cwd, "100%fixture.ts");
  await fs.writeFile(
    sourceFile,
    "// local file preview\nexport const clipboardVerified = true;\n",
  );
  const answer =
    text + `\n\n[打开源文件](<${sourceFile.replaceAll("\\", "/")}:2>)`;
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts: [],
      jobs: [
        {
          id,
          title: "消息格式验收",
          prompt: "No inference",
          cwd,
          mode: "cli",
          model: "",
          effort: "",
          bucket: "codex",
          state: "completed",
          rotations: 0,
          createdAt: now,
          updatedAt: now,
          approvalPolicy: "on-request",
          sandbox: "readOnly",
          interactive: true,
        },
      ],
      logs: [],
      cursor: 0,
      settings: { resetWarmupEnabled: false },
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [{ id: randomUUID(), name: "格式验收", cwd }],
      schedules: [],
      preferences: { theme: "dark", language: "zh-CN", notifications: false },
    }),
  );
  await fs.writeFile(
    path.join(profile, "chats", `${id}.jsonl`),
    [
      {
        id: "answer1",
        role: "assistant",
        kind: "message",
        text: answer,
        at: now,
      },
      {
        id: "answer2",
        role: "assistant",
        kind: "message",
        text: "第二条回答[^note]。\n\n[^note]: 独立的注释。",
        at: now + 1,
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const errors = [],
    report = { fixture, inferenceRequests: 0 };
  let app, page, originalClipboard;
  try {
    app = await _electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/electron.exe",
      ),
      args: [root],
      env,
      timeout: 60000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: "消息格式验收", exact: true })
      .click();
    await page.locator(".code-block").waitFor();
    // Retain the existing clipboard privately, just as the composer native QA does.
    originalClipboard = await app.evaluate(
      async ({ clipboard, ClipboardItem }) => {
        globalThis.__relayFormatClipboard = await Promise.all(
          (await clipboard.read()).map(async (item) => {
            const entries = await Promise.all(
              item.types.map(async (type) => [
                type,
                Buffer.from(await (await item.getType(type)).arrayBuffer()),
              ]),
            );
            return new ClipboardItem(
              Object.fromEntries(
                entries.map(([type, bytes]) => [
                  type,
                  new Blob([bytes], { type }),
                ]),
              ),
            );
          }),
        );
        return true;
      },
    );
    const clipboardText = () =>
      app.evaluate(async ({ clipboard }) => clipboard.readText());
    await page.getByRole("button", { name: "复制代码", exact: true }).click();
    await page.getByRole("button", { name: "已复制", exact: true }).waitFor();
    assert.equal(await clipboardText(), code);
    await page.locator(".math-block").hover();
    await page.getByRole("button", { name: "复制公式", exact: true }).click();
    assert.equal(await clipboardText(), formula);
    await page
      .locator(".message-actions")
      .first()
      .getByRole("button", { name: "复制回答", exact: true })
      .click();
    assert.equal(await clipboardText(), answer);
    assert.equal(await page.locator(".rich-markdown table").count(), 1);
    assert.equal(
      await page.locator(".rich-markdown .task-list-item").count(),
      2,
    );
    assert(
      await page
        .locator(".task-list-item input")
        .first()
        .evaluate((node) => node.getBoundingClientRect().width <= 20),
      "Task checkboxes must stay inline",
    );
    assert.equal(await page.locator(".katex-display").count(), 1);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const fonts = await page.evaluate(
      () =>
        [...document.fonts].filter(
          (f) => f.family.startsWith("KaTeX") && f.status === "loaded",
        ).length,
    );
    assert(fonts > 0, "Bundled KaTeX fonts must load under the real app CSP");
    const references = await page
      .locator("a[data-footnote-ref]")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({ id: n.id, href: n.getAttribute("href") })),
      );
    assert.equal(references.length, 2);
    assert.notEqual(references[0].href, references[1].href);
    await page.locator("a[data-footnote-ref]").first().click();
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      references[0].href.slice(1),
    );
    await page.locator("[data-footnote-backref]").first().click();
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      references[0].id,
    );
    await page.evaluate(() => {
      document.querySelector(".agent-scroll").scrollTop = 0;
    });
    await page.screenshot({
      path: path.join(output, "desktop-message-format.png"),
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page
      .getByRole("button", { name: "复制主题设置", exact: true })
      .click();
    assert.equal(JSON.parse(await clipboardText()).theme, "dark");
    await page.getByRole("button", { name: "浅色", exact: true }).click();
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await page.locator('.desktop-shell[data-color-scheme="light"]').waitFor();
    await page.locator(".math-block").waitFor();
    await page.screenshot({
      path: path.join(output, "desktop-message-format-light.png"),
    });
    await page.getByRole("button", { name: "打开源文件", exact: true }).click();
    await page
      .getByText("export const clipboardVerified = true;", { exact: false })
      .waitFor();
    await page.setViewportSize({ width: 900, height: 900 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
    Object.assign(report, {
      exactCodeCopy: true,
      latexCopy: true,
      originalAnswerCopy: true,
      localMathFonts: fonts,
      isolatedFootnoteNavigation: true,
      narrowWindow: true,
      rendererErrors: errors,
      status: "passed",
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    report.status = "failed";
    report.error = error.stack || String(error);
    await page
      ?.screenshot({ path: path.join(output, "message-format-failed.png") })
      .catch(() => {});
    throw error;
  } finally {
    if (originalClipboard)
      await app
        .evaluate(async ({ clipboard }) => {
          await clipboard.write(globalThis.__relayFormatClipboard);
          delete globalThis.__relayFormatClipboard;
        })
        .catch(() => {});
    await app?.close();
    await fs.writeFile(
      path.join(output, "message-format-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
