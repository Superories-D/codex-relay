const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  const fixture = await fs.mkdtemp(path.join(output, "accounts-policy-")),
    profile = path.join(fixture, "profile");
  await fs.mkdir(profile);
  const id = randomUUID(),
    now = Date.now();
  await fs.writeFile(
    path.join(profile, "state.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id,
          identity: "qa-fixture",
          label: "账户策略验收",
          email: "qa@example.invalid",
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
              primary: {
                usedPercent: 20,
                windowDurationMins: 300,
                resetsAt: now + 18000000,
              },
              secondary: {
                usedPercent: 20,
                windowDurationMins: 10080,
                resetsAt: now + 604800000,
              },
            },
          },
        },
      ],
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
  let app, page;
  const errors = [],
    report = { fixture, inferenceRequests: 0 };
  const launch = async () => {
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
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("button", { name: "账户轮换", exact: true }).click();
    await page
      .getByRole("heading", { name: "账户与接力", exact: true })
      .waitFor();
  };
  const current = () => page.evaluate(() => window.relay.snapshot());
  try {
    await launch();
    const selection = page.getByLabel("账户选择方式", { exact: true });
    assert.equal(await selection.inputValue(), "smart");
    const warmup = page.getByRole("checkbox", {
      name: "额度重置后自动开始计时",
      exact: true,
    });
    assert.equal(await warmup.isChecked(), false);
    await warmup.check();
    assert.equal((await current()).settings.resetWarmupEnabled, true);
    await selection.selectOption("roundRobin");
    await page.waitForFunction(
      () =>
        document.querySelector('select[aria-label="账户选择方式"]').value ===
        "roundRobin",
    );
    await page
      .getByRole("button", { name: "账户使用策略", exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "账户使用策略",
      exact: true,
    });
    await dialog
      .getByLabel("套餐到期时间（手动）", { exact: true })
      .fill("2027-01-02T12:30");
    await dialog
      .getByLabel("额度窗口类型", { exact: true })
      .selectOption("weeklyOnly");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    let snapshot = await current();
    assert.equal(snapshot.accounts[0].limitMode, "weeklyOnly");
    assert.equal(
      snapshot.accounts[0].expiresAt,
      new Date("2027-01-02T12:30").getTime(),
    );
    assert.equal(snapshot.settings.accountSelection, "roundRobin");
    assert.equal(snapshot.settings.resetWarmupEnabled, true);
    await page
      .getByRole("checkbox", { name: "额度重置后自动开始计时", exact: true })
      .uncheck();
    assert.equal((await current()).settings.resetWarmupEnabled, false);
    await page.screenshot({
      path: path.join(output, "desktop-account-value.png"),
    });
    await app.close();
    app = undefined;
    await launch();
    snapshot = await current();
    assert.equal(snapshot.accounts[0].limitMode, "weeklyOnly");
    assert.equal(snapshot.settings.accountSelection, "roundRobin");
    await page
      .getByLabel("账户选择方式", { exact: true })
      .selectOption("smart");
    await page
      .getByRole("button", { name: "账户使用策略", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "账户使用策略", exact: true });
    await dialog.getByLabel("套餐到期时间（手动）", { exact: true }).fill("");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.notEqual((await current()).accounts[0].expiresAt, null);
    assert.deepEqual(errors, []);
    Object.assign(report, {
      metadataPersistence: true,
      smartAndOrderedPolicy: true,
      expiryAndWindowSettings: true,
      rendererErrors: errors,
      status: "passed",
    });
    console.log(JSON.stringify(report));
  } catch (e) {
    report.status = "failed";
    report.error = e.stack || String(e);
    if (page)
      await page
        .screenshot({ path: path.join(output, "accounts-policy-failed.png") })
        .catch(() => {});
    throw e;
  } finally {
    await app?.close();
    await fs.writeFile(
      path.join(output, "accounts-policy-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
})().catch((e) => {
  console.error(e.stack || e);
  process.exitCode = 1;
});
