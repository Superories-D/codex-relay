// Requires an owned, already authenticated QA profile and previous real child
// history. Reuses one root and one child: one root turn, two child turns, one steer.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(150);
  }
  throw Error("Timed out waiting for live child control");
}
(async () => {
  if (!process.env.RELAY_SUBAGENT_PROFILE)
    throw Error("Set RELAY_SUBAGENT_PROFILE to an existing owned QA profile");
  const profile = await fs.realpath(process.env.RELAY_SUBAGENT_PROFILE);
  assert(
    profile.startsWith((await fs.realpath(output)) + path.sep),
    "Only an owned qa-output profile is allowed",
  );
  const seed = JSON.parse(
    await fs.readFile(
      path.join(output, "desktop-subagents-report.json"),
      "utf8",
    ),
  );
  const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const report = { rootTurns: 0, childTurns: 0, steers: 0, checks: [] },
    errors = [];
  const save = () =>
    fs.writeFile(
      path.join(output, "subagent-control-live-report.json"),
      JSON.stringify(report, null, 2),
    );
  let app, page, call, original, gate, id;
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
    call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    const snapshot = await call("snapshot");
    assert(
      !snapshot.jobs.some((job) =>
        ["running", "preparing", "pausing", "rotating"].includes(job.state),
      ),
    );
    original = snapshot.jobs.find((job) => job.id === seed.jobId);
    assert(["completed", "paused"].includes(original?.state));
    const pool = snapshot.accounts
      .filter(
        (account) =>
          account.enabled &&
          account.status === "ready" &&
          (account.quotas.codex?.primary?.usedPercent ?? 100) < 80,
      )
      .sort(
        (a, b) =>
          a.quotas.codex.primary.usedPercent -
          b.quotas.codex.primary.usedPercent,
      );
    assert(
      pool.length,
      "No QA account with at least 20% remaining; do not spend a nearly exhausted account",
    );
    const enabled = snapshot.accounts.map((account) => ({
      id: account.id,
      enabled: account.enabled,
    }));
    report.originalEnabled = enabled;
    for (const account of snapshot.accounts)
      if (account.enabled && account.id !== pool[0].id)
        await call("account.update", { id: account.id, enabled: false });
    id = original.id;
    const marker = path.join(
      original.cwd,
      `control-${randomUUID().slice(0, 8)}`,
    );
    gate = {
      parentReady: marker + ".parent-ready",
      parentGo: marker + ".parent-go",
      childReady: marker + ".child-ready",
      childGo: marker + ".child-go",
    };
    report.gates = gate;
    report.rootThreadId = original.threadId;
    await save();
    await call("chat.update", {
      id,
      sandbox: "workspaceWrite",
      approvalPolicy: "never",
    });
    const waitCommand = (ready, go, label) =>
      `Set-Content -LiteralPath '${ready}' -Value '${label}'; $controlDeadline=(Get-Date).AddSeconds(120); while (!(Test-Path -LiteralPath '${go}') -and (Get-Date) -lt $controlDeadline) { Start-Sleep -Milliseconds 250 }; Write-Output '${label}_RELEASED'`;
    await call("chat.send", {
      id,
      action: "send",
      attachments: [],
      effort: "low",
      text: `This is one bounded UI-control integration test. Do not start, resume, message, wait for, or close any subagents; the UI controller will control an existing child. Run exactly this PowerShell command, waiting for its process with write_stdin if needed: ${waitCommand(gate.parentReady, gate.parentGo, "PARENT_READY")}. After it returns, reply only PARENT_CONTROL_OK. Do not use other tools or edit other files.`,
    });
    report.rootTurns++;
    await save();
    await until(
      async () => !!(await fs.stat(gate.parentReady).catch(() => false)),
      60000,
    );
    await page
      .getByRole("button", { name: original.title, exact: true })
      .click();
    if (!(await page.locator(".workbench-tabs").count()))
      await page.getByRole("button", { name: "会话信息", exact: true }).click();
    await page
      .locator(".workbench-tabs")
      .getByRole("button", { name: /代理/ })
      .click();
    const state = await call("snapshot"),
      live = state.jobs.find((job) => job.id === id);
    const child = live.agents.find(
      (agent) => agent.threadId === seed.children[0].threadId,
    );
    assert(child);
    report.childThreadId = child.threadId;
    const index = live.agents.findIndex(
      (agent) => agent.threadId === child.threadId,
    );
    await page.locator(".agent-tree > button").nth(index).click();
    const input = page.getByLabel("给子代理发送消息", { exact: true }),
      send = page.getByTitle("发送给子代理", { exact: true });
    assert.equal(
      await input.isEnabled(),
      true,
      "restored completed child can continue",
    );
    const token = "STEER_" + randomUUID().slice(0, 8);
    await input.fill(
      `This is a bounded child UI-control test. Run exactly this PowerShell command: ${waitCommand(gate.childReady, gate.childGo, "CHILD_READY")}. Use write_stdin only if needed. Do not use any other tools or spawn agents. After it returns, reply CHILD_FIRST=42. The controller may add a steering message.`,
    );
    await send.click();
    report.childTurns++;
    await save();
    await until(
      async () => !!(await fs.stat(gate.childReady).catch(() => false)),
      60000,
    );
    const active = (await call("snapshot")).jobs
      .find((job) => job.id === id)
      .agents.find((agent) => agent.threadId === child.threadId);
    assert.equal(active.status, "running");
    report.interruptedTurnId = active.turnId;
    await input.fill(
      `Human steering update: remember ${token}. The final numeric value is now 44. Preserve this update even if interrupted.`,
    );
    await send.click();
    report.steers++;
    await save();
    await until(async () =>
      (
        await call("chat.agent.read", { id, threadId: child.threadId })
      ).items.some((item) => item.role === "user" && item.text.includes(token)),
    );
    const stop = page.getByTitle("停止子代理", { exact: true });
    await until(() => stop.isEnabled());
    await stop.click();
    await until(async () =>
      ["interrupted", "errored", "failed"].includes(
        (await call("snapshot")).jobs
          .find((job) => job.id === id)
          .agents.find((agent) => agent.threadId === child.threadId).status,
      ),
    );
    assert.equal(
      (await call("snapshot")).jobs.find((job) => job.id === id).state,
      "running",
    );
    report.checks.push(
      "restored existing child starts on same ID",
      "running child accepts steer",
      "UI interrupt confirms terminal state while parent remains active",
    );
    await save();
    await input.fill(
      "Do not call any tools. Reply only CHILD_RESUMED=<the numeric value from the human steering update> STEER=<the remembered steering token>.",
    );
    await send.click();
    report.childTurns++;
    await save();
    await until(async () => {
      const current = (await call("snapshot")).jobs
        .find((job) => job.id === id)
        .agents.find((agent) => agent.threadId === child.threadId);
      return current.status === "completed" && current.turnId !== active.turnId;
    }, 60000);
    const transcript = await call("chat.agent.read", {
      id,
      threadId: child.threadId,
    });
    assert(
      transcript.items.some(
        (item) =>
          item.role === "assistant" &&
          item.text.includes("CHILD_RESUMED=44") &&
          item.text.includes(token),
      ),
      "resumed child retains interrupted-turn steering context",
    );
    await fs.writeFile(gate.parentGo, "go");
    await until(async () => {
      const current = (await call("snapshot")).jobs.find(
        (job) => job.id === id,
      );
      if (["needs_attention", "paused", "cancelled"].includes(current.state))
        throw Error(current.lastError || current.state);
      return current.state === "completed";
    }, 60000);
    const final = (await call("snapshot")).jobs.find((job) => job.id === id);
    assert.equal(final.threadId, original.threadId);
    assert.equal(final.agents.length, original.agents.length);
    const parent = await call("chat.read", { id });
    assert(
      parent.items.some(
        (item) =>
          item.role === "assistant" && item.text.includes("PARENT_CONTROL_OK"),
      ),
    );
    assert(
      !parent.items.some(
        (item) =>
          item.role === "assistant" && item.text.includes("CHILD_RESUMED=44"),
      ),
    );
    report.checks.push(
      "same child resumes after UI stop with steering context",
      "parent and child journals remain separate",
      "parent completes on its original thread",
    );
    report.status = "passed";
    report.rendererErrors = errors;
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: path.join(output, "subagent-control-live.png"),
    });
    await save();
    console.log(
      JSON.stringify(
        { ...report, originalEnabled: undefined, gates: undefined },
        null,
        2,
      ),
    );
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    if (page)
      await page
        .screenshot({
          path: path.join(output, "subagent-control-live-failure.png"),
        })
        .catch(() => {});
    await save();
    throw error;
  } finally {
    if (gate) {
      await fs.writeFile(gate.parentGo, "stop").catch(() => {});
      await fs.writeFile(gate.childGo, "stop").catch(() => {});
    }
    if (call && id) {
      const state = await call("snapshot").catch(() => undefined),
        current = state?.jobs.find((job) => job.id === id);
      if (
        current &&
        ["running", "preparing", "rotating", "waiting"].includes(current.state)
      )
        await call("job.control", { id, action: "pause" }).catch(() => {});
    }
    if (call && report.originalEnabled)
      for (const account of report.originalEnabled)
        await call("account.update", account).catch(() => {});
    if (call && id && original)
      await call("chat.update", {
        id,
        sandbox: original.sandbox,
        approvalPolicy: original.approvalPolicy,
      }).catch(() => {});
    if (app) await app.evaluate(({ app }) => app.quit()).catch(() => {});
    if (app) await app.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
