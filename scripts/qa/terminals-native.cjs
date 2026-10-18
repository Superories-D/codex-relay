// Real Electron + Codex command/exec PTYs, isolated empty profile, no model turns.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
async function until(check) {
  const deadline = Date.now() + 30000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "native terminal check timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function exists(file) {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, "terminals-native-"));
  const profile = path.join(fixture, "profile"),
    first = path.join(fixture, "first"),
    second = path.join(fixture, "日本語 second");
  for (const folder of [profile, first, second]) await fs.mkdir(folder);
  const now = Date.now();
  const jobs = [first, second].map((cwd, i) => ({
    id: randomUUID(),
    cwd,
    title: `Terminal fixture ${i + 1}`,
    prompt: "No inference",
    mode: "cli",
    model: "",
    effort: "",
    bucket: "codex",
    state: "completed",
    rotations: 0,
    createdAt: now + i,
    updatedAt: now + i,
    approvalPolicy: "on-request",
    sandbox: "workspaceWrite",
    interactive: true,
  }));
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts: [],
      jobs,
      logs: [],
      cursor: 0,
      settings: {
        cliPath: path.join(
          root,
          "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        ),
        resetWarmupEnabled: false,
      },
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: jobs.map((job) => ({
        id: randomUUID(),
        name: job.title,
        cwd: job.cwd,
        pinned: true,
      })),
      schedules: [],
      preferences: { language: "ja", theme: "dark", notifications: false },
    }),
  );
  const report = { fixture, inferenceRequests: 0, checks: [], errors: [] };
  let app,
    page,
    exited = false;
  const owners = [],
    shellPids = [];
  try {
    const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
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
    page.setDefaultTimeout(20000);
    page.on("pageerror", (e) => report.errors.push(e.message));
    const call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    await page
      .getByRole("button", { name: "新しいチャット", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: jobs[0].title, exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: "統合ターミナル", exact: true })
      .click();
    const pane = page.locator(".terminal-pane");
    await until(async () =>
      (await call("terminal.list")).some((s) => s.state === "running"),
    );
    const a = (await call("terminal.list"))[0];
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(
      "[IO.File]::WriteAllText((Join-Path $PWD 'shell.pid'), [string]$PID); Write-Output 'FIRST_ONLY'",
    );
    await page.keyboard.press("Enter");
    await until(() => exists(path.join(first, "shell.pid")));
    const b = await call("terminal.open", { cwd: second });
    await until(
      async () =>
        (await call("terminal.read", { id: b.id })).state === "running",
    );
    await call("terminal.write", {
      id: b.id,
      text: "[IO.File]::WriteAllText((Join-Path $PWD 'shell.pid'), [string]$PID); Write-Output 'SECOND_ONLY'\r",
    });
    await until(() => exists(path.join(second, "shell.pid")));
    await until(async () =>
      (await call("terminal.read", { id: b.id })).text.includes("SECOND_ONLY"),
    );
    const aOutput = await call("terminal.read", { id: a.id });
    assert.ok(aOutput.text.includes("FIRST_ONLY"));
    assert.ok(!aOutput.text.includes("SECOND_ONLY"));
    assert.ok(
      !(await call("terminal.read", { id: b.id })).text.includes("FIRST_ONLY"),
    );
    for (const s of [a, b])
      owners.push(
        JSON.parse(
          await fs.readFile(
            path.join(profile, "terminals", s.id, "relay-owner.json"),
            "utf8",
          ),
        ).pid,
      );
    for (const cwd of [first, second])
      shellPids.push(
        Number(await fs.readFile(path.join(cwd, "shell.pid"), "utf8")),
      );
    assert.notEqual(shellPids[0], shellPids[1]);
    await until(
      async () => (await pane.locator(".terminal-tabs > div").count()) === 2,
    );
    await pane
      .getByRole("button", { name: "ターミナルを非表示", exact: true })
      .click();
    await page
      .getByRole("button", { name: "統合ターミナル", exact: true })
      .click();
    await pane.locator(".xterm").waitFor();
    assert.equal((await call("terminal.list")).length, 2);
    report.checks.push(
      "Japanese UI opens real PTY; two concurrent shells retain distinct cwd/PID/input/output; hide/reopen does not spawn duplicates",
    );
    await pane
      .locator(".terminal-tabs > div")
      .nth(1)
      .locator("button")
      .first()
      .click();
    await call("terminal.resize", { id: b.id, cols: 90, rows: 15 });
    await call("terminal.write", { id: b.id, text: "exit 7\r" });
    await until(
      async () =>
        (await call("terminal.read", { id: b.id })).state === "exited",
    );
    await pane.getByRole("status").filter({ hasText: "コード 7" }).waitFor();
    assert.ok(
      (await call("terminal.read", { id: b.id })).text.includes("SECOND_ONLY"),
    );
    await until(
      async () =>
        !(await exists(
          path.join(profile, "terminals", b.id, "relay-owner.json"),
        )),
    );
    await page.screenshot({
      path: path.join(output, "terminals-native-ja.png"),
    });
    report.checks.push(
      "shell exit 7 releases app-server owner, preserves output, and displays Japanese exit status",
    );
    // Close both tabs in the same event turn to exercise independent completions.
    await pane.locator(".terminal-tabs").evaluate((tabs) => {
      for (const tab of tabs.children)
        tab.querySelector("button[aria-label]").click();
    });
    await until(async () => (await call("terminal.list")).length === 0);
    await until(
      async () => (await pane.locator(".terminal-tabs > div").count()) === 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(await pane.locator(".terminal-tabs > div").count(), 0);
    report.checks.push("simultaneous UI closes leave no resurrected tab");
    const c = await call("terminal.open", { cwd: first });
    await until(
      async () =>
        (await call("terminal.read", { id: c.id })).state === "running",
    );
    owners.push(
      JSON.parse(
        await fs.readFile(
          path.join(profile, "terminals", c.id, "relay-owner.json"),
          "utf8",
        ),
      ).pid,
    );
    await call("terminal.write", {
      id: c.id,
      text: "[IO.File]::WriteAllText((Join-Path $PWD 'shutdown.pid'), [string]$PID)\r",
    });
    await until(() => exists(path.join(first, "shutdown.pid")));
    shellPids.push(
      Number(await fs.readFile(path.join(first, "shutdown.pid"), "utf8")),
    );
    assert.equal(
      (await page.evaluate(() => window.relay.snapshot())).accounts.length,
      0,
    );
    const closed = new Promise((resolve) =>
      app.process().once("exit", resolve),
    );
    await app.evaluate(({ app }) => {
      app.quit();
      app.quit();
    });
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("native app quit timed out")),
          15000,
        );
        closed.finally(() => clearTimeout(timer));
      }),
    ]);
    exited = true;
    for (const pid of [...owners, ...shellPids])
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
      );
    assert.equal(
      await exists(path.join(profile, "terminals", c.id, "relay-owner.json")),
      false,
    );
    report.checks.push(
      "repeated app quit drains live terminal; all recorded app-server and shell PIDs are gone",
    );
    assert.deepEqual(report.errors, []);
    report.status = "passed";
  } catch (error) {
    report.failure = String(error);
    if (page && !exited)
      await page
        .screenshot({
          path: path.join(output, "terminals-native-failure.png"),
          timeout: 3000,
        })
        .catch(() => {});
    throw error;
  } finally {
    const watchdog =
      app &&
      !exited &&
      setTimeout(
        () =>
          execFile(
            "taskkill",
            ["/PID", String(app.process().pid), "/T", "/F"],
            { windowsHide: true },
          ),
        15000,
      );
    if (app && !exited) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    clearTimeout(watchdog);
    await fs.writeFile(
      path.join(output, "terminals-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
