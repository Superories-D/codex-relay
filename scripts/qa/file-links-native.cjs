// Real Electron file-link navigation. Isolated profile; no login or model calls.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const baseline = process.env.RELAY_EXPECT_FILE_LINK_FAILURE === "1";
  const fixture = await fs.mkdtemp(path.join(output, "file-links-native-"));
  const profile = path.join(fixture, "profile");
  const cwd =
    process.env.RELAY_FILE_LINK_PROJECT || path.join(fixture, "project");
  const target =
    process.env.RELAY_FILE_LINK_TARGET ||
    path.join(cwd, "docs/story-editor.md");
  if (!process.env.RELAY_FILE_LINK_TARGET) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      "# File link verification\n\nFILE_LINK_CONTENT_42\n",
    );
    await fs.writeFile(
      path.join(cwd, "docs/100%完成 #1.md"),
      "# Encoded filename\n\nENCODED_LINK_CONTENT_42\n",
    );
  }
  const content = await fs.readFile(target, "utf8"),
    id = randomUUID(),
    now = Date.now();
  const slash = target.replaceAll("\\", "/");
  const cases = [
    { label: "打开报告中的文档", href: `/${slash}`, file: target },
  ];
  if (!baseline)
    cases.push(
      { label: "Windows 绝对路径", href: `${slash}:2:1`, file: target },
      { label: "带行号的盘符链接", href: `/${slash}#L2`, file: target },
      { label: "文件 URL", href: pathToFileURL(target).href, file: target },
      {
        label: "相对文件链接",
        href: path.relative(cwd, target).replaceAll("\\", "/"),
        file: target,
      },
    );
  if (!baseline && !process.env.RELAY_FILE_LINK_TARGET) {
    const encoded = path.join(cwd, "docs/100%完成 #1.md");
    cases.push({
      label: "中文空格百分号文件",
      href: pathToFileURL(encoded).href + "#L2",
      file: encoded,
    });
  }
  await fs.mkdir(path.join(profile, "chats"), { recursive: true });
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts: [],
      logs: [],
      cursor: 0,
      settings: { resetWarmupEnabled: false },
      jobs: [
        {
          id,
          title: "文件链接真实验收",
          prompt: "",
          cwd,
          mode: "cli",
          model: "",
          effort: "",
          bucket: "codex",
          state: "completed",
          interactive: true,
          rotations: 0,
          createdAt: now,
          updatedAt: now,
          sandbox: "readOnly",
          approvalPolicy: "never",
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [{ id: randomUUID(), cwd, name: "File links" }],
      schedules: [],
      preferences: { theme: "dark", language: "zh-CN", notifications: false },
    }),
  );
  const missing = path.join(cwd, "docs/temporarily-missing.md");
  await fs.writeFile(
    path.join(profile, "chats", `${id}.jsonl`),
    JSON.stringify({
      id: randomUUID(),
      role: "assistant",
      kind: "message",
      text:
        cases.map((c) => `[${c.label}](<${c.href}>)`).join("\n\n") +
        (!baseline && !process.env.RELAY_FILE_LINK_TARGET
          ? `\n\n[缺失文件](</${missing.replaceAll("\\", "/")}>)`
          : ""),
      at: now,
    }) + "\n",
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const report = {
    fixture,
    baseline,
    inferenceRequests: 0,
    cases: [],
    rendererErrors: [],
  };
  let app, page;
  try {
    app = await _electron.launch({
      executablePath:
        process.env.RELAY_EXECUTABLE ||
        path.join(root, "node_modules/electron/dist/electron.exe"),
      args: process.env.RELAY_EXECUTABLE ? [] : [root],
      env,
      timeout: 60000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => report.rendererErrors.push(e.message));
    await page
      .getByRole("button", { name: "文件链接真实验收", exact: true })
      .click();
    for (const test of cases) {
      await page
        .locator(".rich-markdown")
        .getByRole("button", { name: test.label, exact: true })
        .click();
      if (baseline) {
        await page.locator(".file-preview .panel-error").waitFor();
        const error = await page
          .locator(".file-preview .panel-error")
          .innerText();
        assert.match(
          error,
          /[A-Z]:\\[A-Z]:\\/i,
          "The old build must reproduce the doubled drive",
        );
        report.cases.push({ href: test.href, doubledDriveReproduced: true });
        report.status = "reproduced";
      } else {
        await page
          .locator(".file-preview .rich-markdown")
          .waitFor({ timeout: 10000 });
        assert.equal(
          await page.locator(".file-preview .panel-error").count(),
          0,
        );
        const read = await page.evaluate(
          async ({ id, file }) =>
            window.relay.command("chat.asset.read", { id, path: file }),
          { id, file: test.file },
        );
        assert.equal(
          read.content,
          test.file === target ? content : await fs.readFile(test.file, "utf8"),
        );
        report.cases.push({ href: test.href, opened: true });
      }
      await page.screenshot({
        path: path.join(
          output,
          baseline ? "file-links-baseline.png" : "file-links-fixed.png",
        ),
      });
      await page.getByLabel("返回文件列表", { exact: true }).click();
    }
    if (!baseline && !process.env.RELAY_FILE_LINK_TARGET) {
      await page
        .locator(".rich-markdown")
        .getByRole("button", { name: "缺失文件", exact: true })
        .click();
      await page.locator(".file-preview .panel-error").waitFor();
      assert.equal(
        await page.locator(".agent-error").count(),
        0,
        "A preview failure must not also show a global error banner",
      );
      assert.doesNotMatch(
        await page.locator(".file-preview .panel-error").innerText(),
        /Error invoking remote method/,
      );
      await fs.writeFile(missing, "# Retry works\n\nFILE_RETRY_OK\n");
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await page
        .locator(".file-preview .rich-markdown")
        .getByText("FILE_RETRY_OK", { exact: true })
        .waitFor();
      report.retryWithoutDuplicateError = true;
      const outside = path.join(fixture, "outside.md");
      await fs.writeFile(outside, "UNAUTHORIZED_FILE");
      const denied = await page.evaluate(
        async ({ id, outside }) => {
          try {
            await window.relay.command("chat.asset.read", {
              id,
              path: `/${outside.replaceAll("\\", "/")}`,
            });
            return false;
          } catch {
            return true;
          }
        },
        { id, outside },
      );
      assert.equal(denied, true);
      report.projectBoundaryPreserved = true;
    }
    assert.deepEqual(report.rendererErrors, []);
    if (!baseline) report.status = "passed";
    console.log(JSON.stringify(report));
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    await page
      ?.screenshot({ path: path.join(output, "file-links-failed.png") })
      .catch(() => {});
    throw error;
  } finally {
    await app?.close();
    await fs.writeFile(
      path.join(
        output,
        `file-links-native-${baseline ? "baseline" : process.env.RELAY_FILE_LINK_TARGET ? "actual-project" : "fixed"}-report.json`,
      ),
      JSON.stringify(report, null, 2),
    );
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
