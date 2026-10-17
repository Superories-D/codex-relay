// Real Electron + real CLI PTY, isolated profile and throwaway Git repository.
// This test never signs in or starts an inference turn.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify, stripVTControlCharacters } = require("node:util");
const { randomUUID } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const execute = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "qa-output");
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for native state");
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, "desktop-native-"));
  const cwd = path.join(fixture, "project"),
    profile = path.join(fixture, "profile");
  await fs.mkdir(cwd);
  await fs.mkdir(profile);
  const git = (...args) => execute("git", args, { cwd, windowsHide: true });
  await git("init");
  await git("config", "user.name", "Relay QA");
  await git("config", "user.email", "qa@example.invalid");
  await git("config", "core.autocrlf", "false");
  await fs.writeFile(
    path.join(cwd, "README.md"),
    "# Native workspace\n\nOriginal\n",
  );
  await git("add", ".");
  await git("commit", "-m", "fixture");
  const id = randomUUID(),
    now = Date.now();
  const job = {
    id,
    title: "原生工作空间验收",
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
    sandbox: "workspaceWrite",
    interactive: true,
  };
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      jobs: [job],
      accounts: [],
      logs: [],
      cursor: 0,
      settings: {
        cliPath: path.join(
          root,
          "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        ),
      },
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [
        { id: randomUUID(), name: "Native fixture", cwd, pinned: true },
      ],
      schedules: [],
      preferences: { theme: "dark", language: "zh-CN", notifications: false },
    }),
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, terminalId;
  let processErrors = "";
  const errors = [],
    report = { inferenceRequests: 0, fixture };
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
    const page = await app.firstWindow();
    app.process().stderr.on("data", (chunk) => {
      processErrors = (processErrors + chunk.toString()).slice(-8000);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    await page.getByRole("button", { name: "新聊天", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "原生工作空间验收", exact: true })
      .click();
    const project = await call("project.add", cwd);
    assert.equal(project.cwd.toLowerCase(), cwd.toLowerCase());
    await page.getByRole("button", { name: "项目文件", exact: true }).click();
    await page
      .locator(".file-tree")
      .getByRole("button", { name: "README.md", exact: true })
      .click();
    await page
      .locator(".file-preview")
      .getByRole("heading", { name: "Native workspace", exact: true })
      .waitFor();
    await page.getByTitle("编辑文件", { exact: true }).click();
    await page
      .getByLabel("编辑文件内容", { exact: true })
      .fill("# Native workspace\n\nEdited in Electron\n");
    await page.getByTitle("保存文件", { exact: true }).click();
    await until(async () =>
      (await fs.readFile(path.join(cwd, "README.md"), "utf8")).includes(
        "Edited in Electron",
      ),
    );
    const read = await call("workspace.read", { cwd, path: "README.md" });
    await assert.rejects(
      call("workspace.write", {
        cwd,
        path: "README.md",
        text: "stale write",
        mtime: read.mtime - 1,
      }),
      /已被其他程序修改/,
    );
    assert.match(
      await call("workspace.diff", { cwd, path: "README.md" }),
      /Edited in Electron/,
    );
    await call("workspace.git", { cwd, path: "README.md", action: "stage" });
    assert.equal(
      (await call("workspace.changes", { cwd })).files[0].index,
      "M",
    );
    await call("workspace.git", {
      cwd,
      action: "commit",
      message: "native editor fixture",
    });
    assert.equal((await call("workspace.changes", { cwd })).files.length, 0);
    const worktree = await call("workspace.worktree", { cwd });
    assert.equal(
      await fs.readFile(path.join(worktree.cwd, "README.md"), "utf8"),
      await fs.readFile(path.join(cwd, "README.md"), "utf8"),
    );
    report.editorConflictAndGitWorktree = "passed";
    await page
      .getByRole("button", { name: "关闭工作面板", exact: true })
      .click();
    await page.keyboard.press("Control+j");
    await page.getByText("PowerShell 1", { exact: true }).waitFor();
    await until(async () => {
      const sessions = await call("terminal.list");
      terminalId = sessions[0]?.id;
      return !!terminalId;
    });
    // A prompt proves the process is ready before sending interactive input.
    await until(async () =>
      stripVTControlCharacters(
        (await call("terminal.read", { id: terminalId })).text,
      ).includes(">"),
    );
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText("$relayProbe = 40 + 2");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("Write-Output $relayProbe");
    await page.keyboard.press("Enter");
    await until(async () =>
      /\r?\n42\r?\n/.test(
        stripVTControlCharacters(
          (await call("terminal.read", { id: terminalId })).text,
        ),
      ),
    );
    await call("terminal.resize", { id: terminalId, cols: 120, rows: 32 });
    await page.getByRole("button", { name: "隐藏终端" }).click();
    await page.keyboard.press("Control+j");
    assert.equal((await call("terminal.list"))[0].id, terminalId);
    await until(async () =>
      (await page.locator(".xterm-screen").innerText()).includes("42"),
    );
    await page.screenshot({
      path: path.join(output, "desktop-native-terminal.png"),
    });
    await page.getByRole("button", { name: "关闭终端 1", exact: true }).click();
    await until(async () => (await call("terminal.list")).length === 0);
    report.realPtyInputOutputResizeAndReopen = "passed";
    await call("desktop.preferences", { language: "en" });
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const original = Menu.buildFromTemplate;
      Menu.buildFromTemplate = function (template) {
        const menu = original.call(Menu, template);
        global.__relayQaMenu = menu;
        global.__relayQaMenuLabels = menu.items.map((item) => item.label);
        return menu;
      };
      const window = BrowserWindow.getAllWindows()[0],
        overlay = window.setTitleBarOverlay.bind(window);
      window.setTitleBarOverlay = function (value) {
        global.__relayQaOverlay = value;
        return overlay(value);
      };
    });
    await call("window.menu", { menu: "edit" });
    assert.deepEqual(
      (await app.evaluate(() => global.__relayQaMenuLabels)).filter(Boolean),
      ["Undo", "Redo", "Cut", "Copy", "Paste", "Select all"],
    );
    await app.evaluate(({ BrowserWindow }) =>
      global.__relayQaMenu.closePopup(BrowserWindow.getAllWindows()[0]),
    );
    await call("desktop.preferences", { theme: "light" });
    assert.equal(
      (await app.evaluate(() => global.__relayQaOverlay)).color,
      "#f2f3f2",
    );
    await call("desktop.preferences", { theme: "dark" });
    assert.equal(
      (await app.evaluate(() => global.__relayQaOverlay)).color,
      "#1f2020",
    );
    report.nativeMenusAndCaptionTheme = "passed";
    await page.reload();
    await until(
      async () => (await page.locator("html").getAttribute("lang")) === "en",
    );
    await page.getByRole("button", { name: "New chat", exact: true }).waitFor();
    assert.equal((await call("desktop.read")).preferences.language, "en");
    report.languagePersistence = "passed";
    assert.deepEqual(errors, []);
    report.rendererErrors = errors;
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error("Native QA failed:", error, processErrors);
    if (app) {
      const page = app.windows()[0];
      await page
        ?.screenshot({ path: path.join(output, "desktop-native-failure.png") })
        .catch(() => {});
    }
    throw error;
  } finally {
    if (app) await app.close();
    await fs.writeFile(
      path.join(output, "desktop-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
