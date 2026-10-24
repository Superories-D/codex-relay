// Real Electron, filesystem evidence and restart durability; no accounts or inference.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
async function until(fn) {
  const deadline = Date.now() + 20000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw Error("Delivery native check timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, "delivery-native-")),
    workspace = path.join(profile, "project");
  await fs.mkdir(workspace);
  const artifact = path.join(workspace, "result.txt"),
    json = path.join(workspace, "report.json");
  await fs.writeFile(artifact, "Verified deliverable\n");
  await fs.writeFile(json, JSON.stringify({ status: "accepted" }));
  const sha256 = crypto
    .createHash("sha256")
    .update("Verified deliverable\n")
    .digest("hex");
  const installed = JSON.parse(
      await fs.readFile(
        path.join(output, "cli-install-native-report.json"),
        "utf8",
      ),
    ),
    cli = JSON.parse(
      await fs.readFile(
        path.join(installed.fixture, "selected-cli.json"),
        "utf8",
      ),
    ).cli;
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
      projects: [{ id: "project", name: "Delivery QA", cwd: workspace }],
      schedules: [],
      preferences: {
        theme: "light",
        language: "en",
        notifications: false,
        closeToTray: false,
      },
    }),
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const report = {
    profile,
    inferenceTurns: 0,
    accounts: 0,
    errors: [],
    launches: [],
  };
  const launch = async () => {
    app = await _electron.launch({
      executablePath:
        process.env.RELAY_EXECUTABLE ||
        path.join(root, "node_modules/electron/dist/electron.exe"),
      args: process.env.RELAY_EXECUTABLE ? [] : [root],
      env,
      timeout: 60000,
    });
    const page = await app.firstWindow();
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page.locator(".agent-shell").waitFor();
    return page;
  };
  try {
    let page = await launch();
    await until(
      async () =>
        (await page.evaluate(() => window.relay.command("cli.status")))
          .phase === "ready",
    );
    const checks = [
      {
        kind: "file",
        label: "Nonempty artifact",
        path: "result.txt",
        minBytes: 1,
      },
      {
        kind: "contains",
        label: "Expected content",
        path: "result.txt",
        text: "Verified deliverable",
      },
      { kind: "sha256", label: "Exact bytes", path: "result.txt", sha256 },
      {
        kind: "json",
        label: "Typed status",
        path: "report.json",
        pointer: "/status",
        equals: "accepted",
      },
    ];
    const job = await page.evaluate(
      async ({ cwd, checks }) => {
        const result = await window.relay.command("job.add", {
          title: "Verifiable delivery QA",
          prompt: "Do not execute: account-free QA",
          cwd,
          mode: "cli",
          model: "",
          effort: "",
          bucket: "codex",
          approvalPolicy: "on-request",
          sandbox: "workspaceWrite",
          interactive: true,
          deliveryChecks: checks,
        });
        await window.relay.command("job.control", {
          id: result.id,
          action: "pause",
        });
        localStorage.setItem("relay.lastChat", result.id);
        return result;
      },
      { cwd: workspace, checks },
    );
    await page.reload();
    await page.locator(".delivery-summary").waitFor();
    await page.locator(".delivery-summary").click();
    const dialog = page.getByRole("dialog", {
      name: "Delivery acceptance",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Verify again", exact: true })
      .click();
    await dialog.locator('h3[data-status="passed"]').waitFor();
    assert.equal(
      await dialog
        .locator('.delivery-results article[data-status="passed"]')
        .count(),
      4,
    );
    const state = await page.evaluate(
      (id) => window.relay.command("delivery.read", id),
      job.id,
    );
    assert.equal(state.reports.at(-1).findings[2].sha256, sha256);
    assert.equal(state.reports.at(-1).findings[0].bytes, 21);
    const destination = path.join(profile, "evidence.json");
    await app.evaluate(({ session }, destination) => {
      session.defaultSession.once("will-download", (_event, item) =>
        item.setSavePath(destination),
      );
    }, destination);
    await dialog
      .getByRole("button", { name: "Export acceptance evidence", exact: true })
      .click();
    await until(async () => {
      try {
        JSON.parse(await fs.readFile(destination, "utf8"));
        return true;
      } catch {
        return false;
      }
    });
    const document = JSON.parse(await fs.readFile(destination, "utf8"));
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.delivery.reports.at(-1).findings.length, 4);
    await fs.unlink(artifact);
    await dialog
      .getByRole("button", { name: "Verify again", exact: true })
      .click();
    await dialog.locator('h3[data-status="failed"]').waitFor();
    assert.equal(
      await dialog
        .locator('.delivery-results article[data-status="failed"]')
        .count(),
      3,
    );
    await page.screenshot({
      path: path.join(output, "delivery-native-failed.png"),
    });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.locator(".agent-composer textarea").fill("Preserve this draft.");
    await page.locator(".delivery-summary").click();
    await dialog
      .getByRole("button", {
        name: "Add repair instructions to draft",
        exact: true,
      })
      .click();
    await dialog.waitFor({ state: "detached" });
    assert.match(
      await page.locator(".agent-composer textarea").inputValue(),
      /^Preserve this draft\./,
    );
    assert.match(
      await page.locator(".agent-composer textarea").inputValue(),
      /result\.txt/,
    );
    await new Promise((r) => setTimeout(r, 600));
    report.launches.push({
      phase: "files-checked",
      findings: 4,
      failed: 3,
      export: true,
      repairDraft: true,
    });
    await app.evaluate(({ app }) => app.quit());
    await app.close();
    app = undefined;
    page = await launch();
    await page.locator(".delivery-summary").click();
    await page
      .getByRole("dialog", { name: "Delivery acceptance", exact: true })
      .locator('h3[data-status="failed"]')
      .waitFor();
    assert.match(
      await page.locator(".agent-composer textarea").inputValue(),
      /^Preserve this draft\./,
    );
    const snapshot = await page.evaluate(() => window.relay.snapshot());
    assert.equal(snapshot.accounts.length, 0);
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.jobs[0].state, "paused");
    assert.equal(snapshot.jobs[0].delivery.reports.length, 2);
    assert.equal(snapshot.jobs[0].delivery.checks.length, 4);
    report.launches.push({
      phase: "restart",
      history: 2,
      state: "paused",
      draftRestored: true,
    });
    assert.deepEqual(report.errors, []);
    report.status = "passed";
    console.log(JSON.stringify(report));
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    await fs.writeFile(
      path.join(output, "delivery-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
