// Actual Electron + Codex app-server + local MCP/OAuth. No accounts or model turns.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { buildSync } = require("esbuild");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "qa-output");
const until = async (fn) => {
  const deadline = Date.now() + 20000;
  while (!(await fn())) {
    assert.ok(Date.now() < deadline, "native extension check timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
(async () => {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, "extensions-native-"));
  const commonHome = path.join(profile, "cli-profile");
  const skill = path.join(commonHome, "skills", "relay-fixture", "SKILL.md");
  await fs.mkdir(path.dirname(skill), { recursive: true });
  await fs.writeFile(
    skill,
    "---\nname: relay-fixture\ndescription: Local QA skill\n---\nOnly a fixture.\n",
  );
  const cli = path.join(
    root,
    "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  );
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts: [],
      jobs: [],
      logs: [],
      cursor: 0,
      settings: { cliPath: cli, resetWarmupEnabled: false },
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [],
      schedules: [],
      preferences: { language: "ja", theme: "dark", notifications: false },
    }),
  );
  const oauth = await require("../../tests/fixtures/mcp-oauth.cjs").start();
  const report = { profile, inferenceRequests: 0, errors: [], checks: [] };
  let app, page;
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
    const operation = (method, params = {}) =>
      call("catalog.operation", { method, params });
    await page
      .getByRole("button", { name: "プラグインと Skills", exact: true })
      .click();
    await page
      .locator(".feature-nav")
      .getByRole("button", { name: "Skills", exact: true })
      .click();
    await page
      .locator(".extension-card")
      .filter({ hasText: "relay-fixture" })
      .click();
    await page
      .getByRole("button", { name: "スキルを無効化", exact: true })
      .click();
    await page
      .locator(".extension-card")
      .filter({ hasText: "relay-fixture" })
      .click();
    await page
      .getByRole("button", { name: "スキルを有効化", exact: true })
      .click();
    report.checks.push(
      "real CLI local Skills discovery and disable/enable without an account",
    );
    await page
      .locator(".feature-nav")
      .getByRole("button", { name: "MCP サーバー", exact: true })
      .click();
    const add = async (name, type, value) => {
      await page
        .getByRole("button", { name: "サーバーを追加", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("名前", { exact: true }).fill(name);
      await dialog.getByLabel("接続方法").selectOption(type);
      if (type === "stdio") {
        await dialog
          .getByLabel("実行ファイル", { exact: true })
          .fill(process.execPath);
        await dialog
          .getByLabel("引数（1 行に 1 つ）", { exact: true })
          .fill(value || path.join(root, "tests/fixtures/mcp-server.cjs"));
      } else await dialog.locator('input[type="url"]').fill(value);
      await dialog
        .getByRole("button", { name: "サーバーを保存", exact: true })
        .click();
    };
    const card = (name) =>
      page.locator(".extension-card").filter({ hasText: name });
    const closeDetail = () => page.locator(".detail-close").click();
    await add("relay_fixture", "stdio");
    await card("relay_fixture").click();
    await page.getByRole("dialog").getByText("echo", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /認証/ })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "サーバーを無効化", exact: true })
      .click();
    await card("relay_fixture").getByText("無効", { exact: false }).waitFor();
    await card("relay_fixture").click();
    await page
      .getByRole("button", { name: "サーバーを有効化", exact: true })
      .click();
    await until(
      async () =>
        (await operation("mcpServerStatus/list", { limit: 100 })).data.find(
          (entry) => entry.name === "relay_fixture",
        )?.tools.echo,
    );
    await add("relay_fixture", "stdio");
    await page
      .getByRole("dialog")
      .getByRole("alert")
      .filter({ hasText: "同じ名前" })
      .waitFor();
    await closeDetail();
    report.checks.push(
      "Japanese UI creates stdio MCP, discovers tools, disables/enables and refuses name collisions",
    );
    const resource = await operation("mcpServer/resource/read", {
      server: "relay_fixture",
      uri: "fixture://note",
    });
    assert.ok(JSON.stringify(resource).includes("Local MCP resource"));
    // A separate account-free thread proves configured tools execute through the
    // actual CLI. No turn/start is sent. The production catalog rejects tool/call
    // without a managed conversation; this QA-only RPC uses an isolated home.
    const taskHome = path.join(profile, "tool-probe");
    await fs.mkdir(taskHome);
    await fs.copyFile(
      path.join(commonHome, "config.toml"),
      path.join(taskHome, "config.toml"),
    );
    buildSync({
      entryPoints: [path.join(root, "src/core/rpc.ts")],
      outfile: path.join(output, "extensions-rpc.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
    });
    const { Rpc } = require(path.join(output, "extensions-rpc.cjs"));
    const rpc = await Rpc.open(cli, taskHome);
    try {
      const result = await rpc.call("thread/start", {
        cwd: taskHome,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
      });
      report.cliVersion = result.thread.cliVersion;
      const tool = await rpc.call("mcpServer/tool/call", {
        threadId: result.thread.id,
        server: "relay_fixture",
        tool: "echo",
        arguments: { value: "native-echo-pass" },
      });
      assert.equal(tool.content[0].text, "native-echo-pass");
    } finally {
      await rpc.close();
    }
    report.checks.push(
      "actual CLI resource read and MCP tool execution using copied configuration; no model turn",
    );
    await add("oauth_fixture", "http", oauth.origin + "/mcp");
    await card("oauth_fixture").click();
    await app.evaluate(({ shell }) => {
      globalThis.__qaOpenExternal = shell.openExternal;
      shell.openExternal = async (url) => {
        globalThis.__qaAuthorizationUrl = url;
      };
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /ログイン|認証/ })
      .click();
    await until(() => app.evaluate(() => !!globalThis.__qaAuthorizationUrl));
    const authorizationUrl = await app.evaluate(
      () => globalThis.__qaAuthorizationUrl,
    );
    assert.equal(new URL(authorizationUrl).origin, oauth.origin);
    const authorized = await fetch(authorizationUrl);
    assert.ok(authorized.ok);
    await page
      .getByRole("status")
      .filter({ hasText: "認証が完了しました" })
      .waitFor();
    await closeDetail();
    await until(
      async () =>
        (await operation("mcpServerStatus/list", { limit: 100 })).data.find(
          (entry) => entry.name === "oauth_fixture",
        )?.tools.authorized_echo,
    );
    assert.ok(
      oauth.counters.registration > 0 &&
        oauth.counters.authorization > 0 &&
        oauth.counters.token > 0,
    );
    await card("oauth_fixture").click();
    await page
      .getByRole("dialog")
      .getByText("authorized_echo", { exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(output, "extensions-native-ja.png"),
    });
    await closeDetail();
    report.checks.push(
      "actual CLI loopback OAuth browser callback, token exchange, preload completion notification and authenticated MCP discovery",
    );
    await fs.copyFile(
      path.join(commonHome, "config.toml"),
      path.join(taskHome, "config.toml"),
    );
    const inherited = await Rpc.open(cli, taskHome);
    try {
      const status = await inherited.call("mcpServerStatus/list", {
        serverName: "oauth_fixture",
        limit: 100,
      });
      const server = status.data.find(
        (entry) => entry.name === "oauth_fixture",
      );
      report.oauthInSeparateHome = {
        authorized: !!server?.tools.authorized_echo,
        authStatus: server?.authStatus,
      };
      assert.equal(report.oauthInSeparateHome.authorized, true);
    } finally {
      await inherited.close();
    }
    await add(
      "broken_fixture",
      "stdio",
      path.join(profile, "missing-server.cjs"),
    );
    await card("broken_fixture")
      .getByText("接続失敗", { exact: true })
      .waitFor();
    await card("broken_fixture").click();
    await page.getByRole("dialog").getByRole("alert").waitFor();
    await page
      .getByRole("button", { name: "サーバーを削除", exact: true })
      .click();
    report.checks.push(
      "failed MCP discovery is visible on the card and in details, and can be removed",
    );
    await page.reload();
    await page
      .getByRole("button", { name: "プラグインと Skills", exact: true })
      .click();
    await page
      .locator(".feature-nav")
      .getByRole("button", { name: "MCP サーバー", exact: true })
      .click();
    await card("relay_fixture").click();
    await page
      .getByRole("button", { name: "サーバーを削除", exact: true })
      .click();
    await until(
      async () =>
        !(await operation("mcpServerStatus/list", { limit: 100 })).data.some(
          (entry) => entry.name === "relay_fixture",
        ),
    );
    await card("oauth_fixture").click();
    await page
      .getByRole("button", { name: "サーバーを削除", exact: true })
      .click();
    await until(
      async () =>
        (await operation("mcpServerStatus/list", { limit: 100 })).data
          .length === 0,
    );
    report.checks.push(
      "renderer reload preserves configuration; UI removals persist through actual CLI",
    );
    const snapshot = await page.evaluate(() => window.relay.snapshot());
    assert.equal(snapshot.accounts.length, 0);
    assert.equal(snapshot.jobs.length, 0);
    assert.deepEqual(report.errors, []);
    report.oauth = oauth.counters;
    report.status = "passed";
  } catch (error) {
    report.failure = String(error);
    if (page)
      await page
        .screenshot({
          path: path.join(output, "extensions-native-failure.png"),
          timeout: 3000,
        })
        .catch(() => {});
    throw error;
  } finally {
    const watchdog =
      app &&
      setTimeout(
        () =>
          execFile(
            "taskkill",
            ["/PID", String(app.process().pid), "/T", "/F"],
            { windowsHide: true },
          ),
        15000,
      );
    if (app)
      await app
        .evaluate(({ shell, app }) => {
          if (globalThis.__qaOpenExternal)
            shell.openExternal = globalThis.__qaOpenExternal;
          app.quit();
          app.quit(); // Repeated quit must not bypass asynchronous process cleanup.
        })
        .catch(() => {});
    if (app) await app.close().catch(() => {});
    clearTimeout(watchdog);
    await oauth.close();
    if (report.status === "passed") {
      try {
        await assert.rejects(
          fs.access(path.join(commonHome, "relay-owner.json")),
          { code: "ENOENT" },
        );
        report.checks.push(
          "repeated app quit drains and removes the catalog CLI ownership record",
        );
      } catch (error) {
        report.status = "failed";
        report.failure = String(error);
        process.exitCode = 1;
      }
    }
    await fs.writeFile(
      path.join(output, "extensions-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
