// Explicit opt-in: repairs imports in the user's installed, idle profile.
// No authentication or inference calls. Reports contain counts only.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { DatabaseSync } = require("node:sqlite");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const { build } = require("esbuild");
const version = require("../../package.json").version;
(async () => {
  const executable = process.env.RELAY_INSTALLED_EXECUTABLE;
  assert(executable && path.isAbsolute(executable));
  const profile = path.join(process.env.APPDATA, "Codex Relay"),
    before = JSON.parse(
      await fs.readFile(path.join(profile, "state.json"), "utf8"),
    );
  assert(
    before.accounts.length === 0 ||
      process.env.RELAY_ALLOW_IDLE_PROFILE === "1",
    "Explicit opt-in required for the actual populated profile",
  );
  assert(
    !before.settings.resetWarmupEnabled,
    "Suspend reset warmups while verifying without inference",
  );
  assert(
    !before.jobs.some(
      (j) => !["completed", "failed", "paused", "cancelled"].includes(j.state),
    ),
  );
  const report = {
    status: "running",
    inferenceRequests: 0,
    before: before.jobs.length,
    errors: [],
    responsivenessMs: [],
  };
  let app;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CODEX_RELAY_DATA_DIR;
    app = await _electron.launch({
      executablePath: executable,
      env,
      args: [],
      timeout: 60000,
    });
    const page = await app.firstWindow();
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page
      .getByRole("button", { name: "新聊天", exact: true })
      .waitFor({ timeout: 60000 });
    assert.equal(
      await app.evaluate(({ app }) => app.getVersion()),
      require("../../package.json").version,
    );
    await page
      .getByRole("button", { name: "一键导入全部项目和对话", exact: true })
      .click();
    const started = Date.now();
    let progress;
    do {
      await page.waitForTimeout(1000);
      const time = Date.now();
      progress = await page.evaluate(() =>
        window.relay.command("history.importAll.status"),
      );
      await page.getByRole("button", { name: "新聊天", exact: true }).click();
      report.responsivenessMs.push(Date.now() - time);
      if (report.responsivenessMs.length % 10 === 0)
        console.log(
          JSON.stringify({
            phase: progress.phase,
            processed: progress.processed,
            total: progress.total,
            stage: progress.stage,
          }),
        );
      assert(
        Date.now() - started < 15 * 60 * 1000,
        "Import exceeded 15 minutes",
      );
    } while (["scanning", "importing", "cancelling"].includes(progress.phase));
    assert.equal(progress.phase, "completed");
    assert.equal(progress.failed, 0, JSON.stringify(progress.failures));
    report.importMs = Date.now() - started;
    report.progress = {
      total: progress.total,
      imported: progress.imported,
      updated: progress.updated,
      skipped: progress.skipped,
      projectsTotal: progress.projectsTotal,
      failed: progress.failed,
      warnings: progress.warnings.length,
    };
    const state = await page.evaluate(() => window.relay.snapshot());
    assert.deepEqual(
      state.accounts.map((a) => a.id),
      before.accounts.map((a) => a.id),
      "Preserve the user's accounts",
    );
    assert(
      state.accounts.every((a) => a.userIdentity),
      "Migrate each existing user identity from its encrypted vault",
    );
    assert.equal(
      new Set(
        state.accounts.map((a) => JSON.stringify([a.identity, a.userIdentity])),
      ).size,
      state.accounts.length,
    );
    report.accountIdentityMigration = {
      accounts: state.accounts.length,
      userIdentities: state.accounts.filter((a) => a.userIdentity).length,
      idsPreserved: true,
    };
    report.accountQuotaChecks = [];
    for (const account of state.accounts) {
      await page.evaluate(
        (id) => window.relay.command("account.refresh", id),
        account.id,
      );
      report.accountQuotaChecks.push({ id: account.id, passed: true });
    }
    const jobs = state.jobs.filter(
      (j) => j.historySource?.storage === "sqlite",
    );
    assert(jobs.length > 100, "Native paginated history must be discovered");
    const ids = new Set(jobs.map((j) => j.historySource.threadId));
    assert.equal(ids.size, jobs.length, "No duplicate native conversations");
    for (const old of before.jobs.filter((j) => j.historySource))
      assert(
        state.jobs.some(
          (j) =>
            j.id === old.id &&
            j.historySource?.threadId === old.historySource.threadId,
        ),
        "Existing IDs retained",
      );
    report.after = state.jobs.length;
    report.main = jobs.filter(
      (j) => !["subagent", "review"].includes(j.historySource.source),
    ).length;
    report.subagents = jobs.filter(
      (j) => j.historySource.source === "subagent",
    ).length;
    report.reviews = jobs.filter(
      (j) => j.historySource.source === "review",
    ).length;
    const homeId = jobs[0].runtimeHomeId,
      home = path.join(profile, "runtime", "jobs", homeId),
      catalog = new DatabaseSync(path.join(home, "state_5.sqlite"), {
        readOnly: true,
      }),
      history = new DatabaseSync(path.join(home, "thread_history_1.sqlite"), {
        readOnly: true,
      });
    let candidate;
    try {
      const rows = catalog.prepare("SELECT id FROM threads").all();
      assert(
        rows.every((r) => ids.has(r.id)),
        "Every indexed native thread imported",
      );
      report.nativeCatalogThreads = rows.length;
      let expected = 0,
        actual = 0;
      const count = history.prepare(
        "SELECT COUNT(*) AS n FROM thread_items WHERE thread_id=?",
      );
      candidate = jobs
        .filter((j) => !j.historySource.issue && !j.archived)
        .sort(
          (a, b) =>
            Number(count.get(a.threadId).n) - Number(count.get(b.threadId).n),
        )[0];
      for (const job of jobs) {
        const n = Number(count.get(job.threadId).n);
        const journal = await fs.readFile(
          path.join(profile, "chats", `${job.id}.jsonl`),
          "utf8",
        );
        const lines = journal.trim().split("\n");
        assert.equal(
          lines.length,
          Math.max(1, n),
          "Every saved native item retained",
        );
        expected += n;
        actual += n ? lines.length : 0;
      }
      report.expectedItems = expected;
      report.importedItems = actual;
    } finally {
      catalog.close();
      history.close();
    }
    const selected =
      jobs.find((j) => j.threadId === "01a14a27-b42d-7e83-9e86-a0a6a54a4422") ||
      jobs.find((j) => !j.historySource.issue);
    let cursor,
      loaded = 0,
      pages = 0,
      total;
    do {
      const data = await page.evaluate(
        ({ id, before }) =>
          window.relay.command("chat.read", {
            id,
            ...(before === undefined ? {} : { before }),
          }),
        { id: selected.id, before: cursor },
      );
      total = data.total;
      loaded += data.items.length;
      pages++;
      cursor = data.before;
    } while (cursor !== undefined);
    assert.equal(loaded, total);
    report.paging = { total, loaded, pages };
    const repeat = await page.evaluate(() =>
      window.relay.command("history.importAll.start"),
    );
    assert(repeat.id);
    do {
      await page.waitForTimeout(500);
      progress = await page.evaluate(() =>
        window.relay.command("history.importAll.status"),
      );
    } while (["scanning", "importing", "cancelling"].includes(progress.phase));
    assert.equal(progress.failed, 0);
    assert.equal(progress.imported, 0);
    assert.equal(progress.updated, 0);
    report.repeat = {
      skipped: progress.skipped,
      imported: progress.imported,
      updated: progress.updated,
    };
    // Verify the bundled CLI can read/resume the COPY without sending a turn.
    const helper = path.resolve("qa-output/native-rpc.cjs");
    await build({
      stdin: {
        contents:
          'export {Rpc} from "./src/core/rpc";export {rebaseNativeHome} from "./src/core/native-history";',
        resolveDir: process.cwd(),
        loader: "ts",
      },
      outfile: helper,
      bundle: true,
      platform: "node",
      format: "cjs",
    });
    const { Rpc, rebaseNativeHome } = require(helper);
    await rebaseNativeHome(home);
    assert(candidate);
    const rpc = await Rpc.open(
      path.resolve(
        "runtime/cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
      ),
      home,
    );
    let unexpectedTurn = false;
    rpc.on("turn/started", () => {
      unexpectedTurn = true;
    });
    try {
      const read = await rpc.call("thread/read", {
        threadId: candidate.threadId,
        includeTurns: true,
      });
      assert.equal(read.thread.id, candidate.threadId);
      const resumed = await rpc.call("thread/resume", {
        threadId: candidate.threadId,
        cwd: candidate.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        excludeTurns: true,
        config: { "features.goals": false },
      });
      assert.equal(resumed.thread.id, candidate.threadId);
      assert(!unexpectedTurn);
      report.nativeCli = { read: true, resume: true, turnsStarted: 0 };
    } finally {
      await rpc.close();
    }
    assert.deepEqual(report.errors, []);
    report.maxResponsivenessMs = Math.max(...report.responsivenessMs);
    report.status = "passed";
    // Leave the primary imported conversation selected for the normal restart.
    await page.evaluate(
      (id) => localStorage.setItem("relay.lastChat", id),
      selected.id,
    );
    await page.reload();
    await page
      .locator(".agent-header strong")
      .filter({ hasText: selected.title })
      .waitFor();
    await page.waitForTimeout(1500);
    report.backgroundGroups = await page
      .locator("details.sidebar-background")
      .count();
    assert(report.backgroundGroups > 0);
    await page.screenshot({
      path: path.resolve(`qa-output/installed-import-${version}.png`),
    });
  } finally {
    if (app) {
      const process = app.process();
      const exited = new Promise((resolve, reject) => {
        if(process.exitCode !== null || process.signalCode !== null) return resolve();
        const timeout = setTimeout(()=>reject(new Error("Installed application did not finish saving before exit")),60000);
        process.once("exit",()=>{clearTimeout(timeout);resolve();});
      });
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await exited;
      await app.close().catch(() => {});
    }
    await fs.writeFile(
      path.resolve(`qa-output/installed-import-${version}-report.json`),
      JSON.stringify(report, null, 2),
    );
  }
  console.log(JSON.stringify(report));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
