// Clicks the real UI button. By default sources are fixtures under a fake home.
// RELAY_IMPORT_REAL_SOURCES=1 opts into read-only scans of this machine's real homes.
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  { randomUUID, createHash } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const fixture = await fs.mkdtemp(path.join(output, "import-native-")),
    profile = process.env.RELAY_IMPORT_PROFILE || path.join(fixture, "profile"),
    fakeUser = path.join(fixture, "user"),
    home = path.join(fakeUser, ".codex");
  const real = process.env.RELAY_IMPORT_REAL_SOURCES === "1",
    count = real ? 0 : 180,
    project = path.join(fixture, "CLI project"),
    emptyProject = path.join(fixture, "Desktop project");
  assert.ok(path.resolve(profile).startsWith(path.resolve(output) + path.sep));
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(path.join(home, "sessions"), { recursive: true });
  await fs.mkdir(project);
  await fs.mkdir(emptyProject);
  let sourceSample, sourceHash;
  if (!real) {
    for (let n = 0; n < count; n++) {
      const id = randomUUID(),
        dir = path.join(home, n % 5 === 0 ? "archived_sessions" : "sessions");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `rollout-${id}.jsonl`),
        rows = [
          {
            type: "session_meta",
            payload: { id, cwd: project, source: n % 2 ? "vscode" : "cli" },
          },
          {
            type: "event_msg",
            payload: { type: "user_message", message: `Import fixture ${n}` },
          },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `Question ${n}` }],
            },
          },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text:
                    `Answer ${n}. ` +
                    "Preserve context and history. ".repeat(150),
                },
              ],
            },
          },
        ];
      await fs.writeFile(
        file,
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      if (n === 0) sourceSample = file;
    }
    sourceHash = createHash("sha256")
      .update(await fs.readFile(sourceSample))
      .digest("hex");
    await fs.writeFile(
      path.join(home, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {
          saved: {
            name: "Desktop imported project",
            rootPaths: [emptyProject],
          },
        },
      }),
    );
  }
  if (!process.env.RELAY_IMPORT_PROFILE)
    await fs.writeFile(
      path.join(profile, "desktop.json"),
      JSON.stringify({
        projects: [],
        schedules: [],
        preferences: { theme: "dark", language: "zh-CN", notifications: false },
      }),
    );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!real)
    Object.assign(env, {
      USERPROFILE: fakeUser,
      HOME: fakeUser,
      CODEX_HOME: home,
      APPDATA: path.join(fakeUser, "AppData/Roaming"),
      LOCALAPPDATA: path.join(fakeUser, "AppData/Local"),
    });
  const executablePath =
    process.env.RELAY_EXECUTABLE ||
    path.join(root, "node_modules/electron/dist/electron.exe");
  const app = await _electron.launch({
      executablePath,
      args: process.env.RELAY_EXECUTABLE ? [] : [root],
      env,
      timeout: 60000,
    }),
    errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    const call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    const initialCount = (await page.evaluate(() => window.relay.snapshot()))
      .jobs.length;
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const control = page.locator(".settings-main .import-all-control");
    const at = Date.now();
    await control
      .getByRole("button", { name: "一键导入全部项目和对话", exact: true })
      .click();
    const buttonReturnMs = Date.now() - at;
    assert.ok(buttonReturnMs < 2000);
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await page.getByRole("button", { name: "新聊天", exact: true }).click();
    await page.getByLabel("消息", { exact: true }).fill("");
    await page.evaluate(() => {
      window.qaInputFrames = [];
      document
        .querySelector('textarea[aria-label="消息"]')
        .addEventListener("input", () => {
          const at = performance.now();
          requestAnimationFrame(() =>
            window.qaInputFrames.push(performance.now() - at),
          );
        });
    });
    const text = "Import runs in the background while I keep typing. ".repeat(
      3,
    );
    await page
      .getByLabel("消息", { exact: true })
      .pressSequentially(text, { delay: 15 });
    assert.equal(
      await page.getByLabel("消息", { exact: true }).inputValue(),
      text,
    );
    const latencies = [],
      start = Date.now(),
      end = start + 900000;
    let progress;
    do {
      const at = Date.now();
      progress = await call("history.importAll.status");
      latencies.push(Date.now() - at);
      if (["completed", "failed", "cancelled"].includes(progress.phase)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < end);
    assert.equal(progress.phase, "completed", JSON.stringify(progress));
    assert.equal(progress.failed, 0, JSON.stringify(progress.failures));
    const snapshot = await page.evaluate(() => window.relay.snapshot()),
      desktop = await call("desktop.read");
    assert.equal(snapshot.accounts.length, 0);
    assert.equal(snapshot.jobs.length, initialCount + progress.imported);
    if (!real) {
      assert.equal(progress.imported, count);
      assert.ok(
        desktop.projects.some(
          (project) => project.name === "Desktop imported project",
        ),
      );
      assert.equal(
        createHash("sha256")
          .update(await fs.readFile(sourceSample))
          .digest("hex"),
        sourceHash,
      );
    }
    const frames = await page.evaluate(() => window.qaInputFrames);
    frames.sort((a, b) => a - b);
    latencies.sort((a, b) => a - b);
    const inputFrameP95Ms = frames[Math.floor(frames.length * 0.95)],
      statusPingP95Ms = latencies[Math.floor(latencies.length * 0.95)];
    assert.ok(inputFrameP95Ms < 150, `Input stalled: ${inputFrameP95Ms} ms`);
    assert.ok(
      statusPingP95Ms < 500,
      `Main process stalled: ${statusPingP95Ms} ms`,
    );
    assert.ok((await page.locator(".agent-thread").count()) <= 650);
    await page.screenshot({
      path: path.join(output, real ? "import-real.png" : "import-native.png"),
    });
    const imported = snapshot.jobs.length,
      total = progress.total,
      readOnly = progress.readOnly;
    await call("history.importAll.start");
    do {
      progress = await call("history.importAll.status");
      if (["completed", "failed"].includes(progress.phase)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < end);
    assert.equal(progress.phase, "completed");
    assert.equal(progress.imported, 0);
    assert.equal(progress.skipped, total);
    assert.deepEqual(errors, []);
    const report = {
      realSources: real,
      profile,
      buttonReturnMs,
      inputEvents: frames.length,
      inputFrameP95Ms,
      statusPingP95Ms,
      chats: imported,
      projects: desktop.projects.length,
      readOnly,
      deduplicate: "passed",
      rendererErrors: errors,
    };
    await fs.writeFile(
      path.join(
        output,
        real ? "import-real-report.json" : "import-native-report.json",
      ),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
