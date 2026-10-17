// Real Electron renderer, simulated disabled accounts. Tests timer uncertainty
// labels and layout; no credentials, network probes, or model requests.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const profile = await fs.mkdtemp(path.join(output, "reset-state-ui-")),
    now = Date.now(),
    next = now + 17000000;
  const account = (label, status, known = false) => ({
    id: randomUUID(),
    identity: label,
    label,
    email: label + "@example.invalid",
    plan: "plus",
    enabled: false,
    status: "ready",
    blockedUntil: null,
    failureCount: 0,
    quotas: {
      codex: {
        limitId: "codex",
        observedAt: now,
        reached: false,
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: next },
        secondary: null,
      },
    },
    ...(known
      ? {
          resetWindows: {
            codex: { resetAt: next, observedAt: now, evidence: "stable" },
          },
        }
      : {}),
    ...(status
      ? {
          warmups: {
            codex: {
              resetAt: now - 10000,
              queuedAt: now - 5000,
              status,
              ...(["confirmed"].includes(status) ? { nextResetAt: next } : {}),
            },
          },
        }
      : {}),
  });
  const accounts = [
    account("Unconfirmed"),
    account("Sent", "sent"),
    account("Confirmed", "confirmed", true),
    account("Handoff", "covered"),
    account("Legacy", "confirmed"),
  ];
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts,
      jobs: [],
      logs: [],
      cursor: 0,
      settings: { resetWarmupEnabled: false },
    }),
  );
  await fs.writeFile(
    path.join(profile, "desktop.json"),
    JSON.stringify({
      projects: [],
      schedules: [],
      preferences: { language: "zh-CN", theme: "dark", notifications: false },
    }),
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.RELAY_EXECUTABLE;
  let app, page;
  const report = {
    simulatedQuota: true,
    inferenceRequests: 0,
    languages: [],
    rendererErrors: [],
  };
  try {
    app = await _electron.launch({
      executablePath:
        executable ||
        path.join(root, "node_modules/electron/dist/electron.exe"),
      args: executable ? [] : [root],
      env,
      timeout: 60000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => report.rendererErrors.push(e.message));
    await page.waitForLoadState("load");
    await page.getByRole("button", { name: "账户轮换", exact: true }).waitFor();
    const call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    for (const [
      language,
      nav,
      confirmed,
      sent,
      handoff,
      legacy,
      unconfirmed,
    ] of [
      [
        "zh-CN",
        "账户轮换",
        "已确认下一次重置时间",
        "已发送 hi，等待计时确认",
        "由当前任务接手开窗",
        "等待重新核实计时状态",
        "计时待确认",
      ],
      [
        "en",
        "Account rotation",
        "Next reset time confirmed",
        "Hi sent, waiting for timer confirmation",
        "The current task will start the timer",
        "Waiting to verify the timer",
        "Timer not confirmed",
      ],
      [
        "zh-TW",
        "帳戶輪換",
        "已確認下一次重置時間",
        "已傳送 hi，等待計時確認",
        "由當前任務接手開窗",
        "等待重新核實計時狀態",
        "計時待確認",
      ],
    ]) {
      await call("desktop.preferences", {
        language,
        theme: language === "en" ? "light" : "dark",
      });
      await page.reload();
      await page.getByRole("button", { name: nav, exact: true }).click();
      const card = (label) =>
        page.locator(".account-settings-list > section").filter({
          has: page
            .locator(".account-setting-heading h3")
            .filter({ hasText: new RegExp("^" + label + "$") }),
        });
      await card("Confirmed").getByText(new RegExp(confirmed)).waitFor();
      await card("Sent").getByText(sent, { exact: true }).waitFor();
      await card("Handoff").getByText(handoff, { exact: true }).waitFor();
      await card("Legacy").getByText(new RegExp(legacy)).waitFor();
      await card("Unconfirmed").getByText(new RegExp(unconfirmed)).waitFor();
      for (const width of [1440, 900]) {
        await page.setViewportSize({ width, height: 1000 });
        await card("Confirmed").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(
            output,
            `desktop-reset-state-${language}-${width}.png`,
          ),
        });
      }
      assert((await call("snapshot")).accounts.every((a) => !a.enabled));
      report.languages.push(language);
    }
    assert.deepEqual(report.rendererErrors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } catch (e) {
    report.status = "failed";
    report.error = e.message;
    if (page)
      await page
        .screenshot({
          path: path.join(output, "reset-state-native-failed.png"),
        })
        .catch(() => {});
    throw e;
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    await fs.writeFile(
      path.join(output, "reset-state-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
