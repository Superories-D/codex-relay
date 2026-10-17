// Real parent -> child -> independent stop/restart/resume workflow. Reuses an
// owned access-token-only QA profile; no copied or refreshed credentials.
// At most one spawned child and two independent follow-up turns are requested.
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path");
const { randomUUID } = require("node:crypto");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw Error("Independent agent live verification timed out");
}
(async () => {
  assert(
    process.env.RELAY_AGENT_PROFILE,
    "Set RELAY_AGENT_PROFILE to an existing owned QA profile",
  );
  const profile = await fs.realpath(process.env.RELAY_AGENT_PROFILE);
  assert(profile.startsWith((await fs.realpath(output)) + path.sep));
  const env = {
    ...process.env,
    CODEX_RELAY_DATA_DIR: profile,
    CODEX_RELAY_DISABLE_RESET_WARMUP: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const report = {
    status: "running",
    profile,
    rootTurns: 0,
    spawnedChildren: 0,
    independentTurns: 0,
    checks: [],
    rendererErrors: [],
  };
  const save = () =>
    fs.writeFile(
      path.join(output, "agent-independent-live-report.json"),
      JSON.stringify(report, null, 2),
    );
  let app, page, call, parentId, childId, gate, originalEnabled;
  async function launch() {
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
    page.on("pageerror", (e) => report.rendererErrors.push(e.message));
    await page.waitForLoadState("load");
    call = (name, args) =>
      page.evaluate(({ name, args }) => window.relay.command(name, args), {
        name,
        args,
      });
    await page.getByRole("button", { name: "新聊天", exact: true }).waitFor();
  }
  async function close() {
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
      app = undefined;
    }
  }
  const current = async (id) =>
    (await call("snapshot")).jobs.find((j) => j.id === id);
  try {
    await launch();
    const snapshot = await call("snapshot");
    assert(
      !snapshot.jobs.some(
        (j) =>
          j.recoveryRequired ||
          [
            "running",
            "preparing",
            "pausing",
            "queued",
            "waiting",
            "rotating",
            "watching",
          ].includes(j.state),
      ),
      "QA profile must be idle",
    );
    originalEnabled = snapshot.accounts.map((a) => ({
      id: a.id,
      enabled: a.enabled,
    }));
    const pool = snapshot.accounts.filter(
      (a) => a.enabled && a.status !== "reauth",
    );
    assert(pool.length);
    const chosen = pool[0];
    report.before = (await call("account.refresh", chosen.id)).codex;
    assert(report.before);
    for (const window of [
      report.before.primary,
      report.before.secondary,
    ].filter(Boolean))
      assert(
        window.usedPercent <= 95,
        "Need 5% remaining in every reported bucket",
      );
    for (const a of pool)
      if (a.id !== chosen.id)
        await call("account.update", { id: a.id, enabled: false });
    const models = await call("account.models", chosen.id),
      model =
        models.find((m) => !m.hidden && /luna|mini/i.test(m.model)) ||
        models.find((m) => m.isDefault);
    assert(model);
    report.model = model.model;
    report.effort = ["minimal", "low", model.defaultReasoningEffort].find((e) =>
      model.supportedReasoningEfforts.some((s) => s.reasoningEffort === e),
    );
    const cwd = await fs.mkdtemp(
        path.join(output, "independent-agent-project-"),
      ),
      nonce = randomUUID().slice(0, 8);
    gate = {
      ready: path.join(cwd, "child-ready"),
      go: path.join(cwd, "child-go"),
    };
    const parent = await call("job.add", {
      title: "独立子代理真实验收 " + nonce,
      prompt: `This is one bounded client integration test. Spawn exactly ONE child agent. Its message: Remember SEED_${nonce}=41; reply only CHILD_SEED_READY=41. Do not use tools or spawn other agents. Use the same inexpensive model ${model.model} with low effort if the tool supports it. Wait for that single child to finish, then reply only PARENT_FINISHED. Do not write files, run shell commands, browse, or create further agents.`,
      cwd,
      mode: "cli",
      interactive: true,
      model: model.model,
      effort: report.effort,
      bucket: "codex",
      sandbox: "workspaceWrite",
      approvalPolicy: "never",
      multiAgent: true,
    });
    parentId = parent.id;
    report.parentId = parentId;
    report.rootTurns++;
    await save();
    await page.getByRole("button", { name: parent.title, exact: true }).click();
    const finished = await until(async () => {
      const job = await current(parentId);
      if (job.state === "needs_attention") throw Error(job.lastError);
      return job.state === "completed" && job.agents?.length ? job : false;
    });
    assert.equal(finished.agents.length, 1);
    report.spawnedChildren = 1;
    childId = finished.agents[0].threadId;
    report.childId = childId;
    report.parentThreadId = finished.threadId;
    if (!(await page.locator(".workbench-tabs").count()))
      await page.getByRole("button", { name: "会话信息", exact: true }).click();
    await page
      .locator(".workbench-tabs")
      .getByRole("button", { name: /代理/ })
      .click();
    await page.locator(".agent-tree > button").first().click();
    const beforeAdoptParentTurns = (await call("chat.turns", { id: parentId }))
      .data.length;
    await page
      .getByRole("button", { name: "打开子代理聊天", exact: true })
      .click();
    await until(async () => !!(await current(childId)));
    const adopted = await current(childId);
    assert.equal(adopted.id, childId);
    assert.equal(adopted.threadId, childId);
    assert.equal(adopted.runtimeHomeId, parentId);
    assert(adopted.preserveNativePermissions);
    assert.equal(adopted.agentOrigin.jobId, parentId);
    assert.equal(adopted.state, "completed");
    assert.equal(
      (await call("chat.turns", { id: parentId })).data.length,
      beforeAdoptParentTurns,
    );
    report.seedTurns = (await call("chat.turns", { id: childId })).data.length;
    assert(report.seedTurns >= 1);
    await page
      .getByRole("button", { name: "返回主会话", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("执行权限", { exact: true }).inputValue(),
      "native",
    );
    const history = await call("chat.read", { id: childId });
    assert(history.items.some((i) => i.text.includes("CHILD_SEED_READY=41")));
    report.checks.push(
      "finished parent opens original child without a new turn or fork",
      "native permissions and model metadata preserved",
      "initial child task and answer visible in full chat",
    );
    await save();
    const command = `Set-Content -LiteralPath '${gate.ready}' -Value 'ready'; $agentDeadline=(Get-Date).AddSeconds(100); while (!(Test-Path -LiteralPath '${gate.go}') -and (Get-Date) -lt $agentDeadline) { Start-Sleep -Milliseconds 200 }; Write-Output 'CHILD_GATE_FINISHED'`;
    const input = page.getByLabel("消息", { exact: true });
    await input.fill(
      `Independent continuation test. Remember FOLLOWUP_${nonce}=42. Run exactly this PowerShell command once: ${command}. Wait for it with write_stdin if needed. Do not change other files or spawn agents. After it returns reply CHILD_GATE_DONE. The controller will interrupt while it waits.`,
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    report.independentTurns++;
    await save();
    await until(async () => !!(await fs.stat(gate.ready).catch(() => false)));
    const running = await current(childId);
    assert.equal(running.state, "running");
    assert.equal(running.threadId, childId);
    report.interruptedTurnId = running.turnId;
    assert.equal((await current(parentId)).state, "completed");
    assert.equal(
      (await current(parentId)).agents.find((a) => a.threadId === childId)
        .status,
      "running",
    );
    await page.getByRole("button", { name: "停止本轮", exact: true }).click();
    await until(async () => (await current(childId)).state === "paused");
    assert.equal(
      (await current(parentId)).agents.find((a) => a.threadId === childId)
        .status,
      "interrupted",
    );
    await close();
    await launch();
    const restored = await current(childId);
    assert.equal(restored.threadId, childId);
    assert.equal(restored.state, "paused");
    await page
      .getByRole("button", { name: restored.title, exact: true })
      .click();
    await page
      .getByLabel("消息", { exact: true })
      .fill(
        `No tools or agents. Reply only CHILD_INDEPENDENT_OK SEED=<the number stored as SEED_${nonce}> FOLLOWUP=<the number stored as FOLLOWUP_${nonce}>.`,
      );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    report.independentTurns++;
    await save();
    await until(async () => {
      const j = await current(childId);
      if (j.state === "needs_attention") throw Error(j.lastError);
      return j.state === "completed";
    });
    const final = await call("chat.read", { id: childId });
    assert(
      final.items.some(
        (i) =>
          i.role === "assistant" &&
          i.text.includes("CHILD_INDEPENDENT_OK") &&
          /SEED\s*=\s*41/.test(i.text) &&
          /FOLLOWUP\s*=\s*42/.test(i.text),
      ),
      "Original and interrupted-turn memory must both survive",
    );
    assert.equal((await current(childId)).threadId, childId);
    assert.notEqual((await current(childId)).turnId, report.interruptedTurnId);
    assert.equal((await current(parentId)).state, "completed");
    assert.equal(
      (await current(parentId)).agents.find((a) => a.threadId === childId)
        .status,
      "completed",
    );
    assert(
      !(await call("chat.read", { id: parentId })).items.some((i) =>
        i.text.includes("CHILD_INDEPENDENT_OK"),
      ),
      "Independent child messages must not pollute parent chat",
    );
    report.checks.push(
      "independent child uses global account scheduler on the same thread",
      "stop confirms native exit and updates parent tree",
      "cold restart resumes child with seed and interrupted-turn memory",
      "parent remains completed and its transcript stays separate",
    );
    report.finalTurns = (await call("chat.turns", { id: childId })).data.length;
    assert.equal(report.finalTurns, report.seedTurns + 2);
    report.after = (await call("account.refresh", chosen.id)).codex;
    assert.deepEqual(report.rendererErrors, []);
    report.status = "passed";
    await page.screenshot({
      path: path.join(output, "desktop-agent-independent-live.png"),
    });
    await save();
    console.log(JSON.stringify(report));
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    await save();
    if (page)
      await page
        .screenshot({
          path: path.join(output, "agent-independent-live-failed.png"),
        })
        .catch(() => {});
    throw error;
  } finally {
    if (gate) await fs.writeFile(gate.go, "release").catch(() => {});
    if (app && call)
      for (const id of [childId, parentId].filter(Boolean)) {
        const j = await current(id).catch(() => undefined);
        if (
          j &&
          [
            "running",
            "queued",
            "preparing",
            "waiting",
            "rotating",
            "pausing",
          ].includes(j.state)
        )
          await call("job.control", { id, action: "pause" }).catch(() => {});
      }
    if (app && call && originalEnabled)
      for (const a of originalEnabled)
        await call("account.update", a).catch(() => {});
    await close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
