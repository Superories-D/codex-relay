// Real Electron UI and throwaway Git repositories; no account or model calls.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { _electron } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
const execute = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "qa-output");
async function until(check) {
  const end = Date.now() + 20000;
  while (!(await check())) {
    assert.ok(Date.now() < end, "native Git check timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, "git-native-"));
  const profile = path.join(fixture, "profile"),
    first = path.join(fixture, "first"),
    second = path.join(fixture, "second");
  const git = async (cwd, ...args) =>
    (await execute("git", ["-C", cwd, ...args], { windowsHide: true })).stdout;
  for (const cwd of [first, second]) {
    await fs.mkdir(path.join(cwd, "nested"), { recursive: true });
    await git(cwd, "init", "-b", "main");
    await git(cwd, "config", "user.name", "Relay QA");
    await git(cwd, "config", "user.email", "qa@example.invalid");
    await git(cwd, "config", "core.autocrlf", "false");
    await fs.writeFile(path.join(cwd, "mixed.txt"), "base\n");
    await fs.writeFile(path.join(cwd, "old name.txt"), "rename content\n");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-m", "initial");
  }
  await git(first, "mv", "old name.txt", "新しい name.txt");
  await fs.writeFile(path.join(first, "mixed.txt"), "staged first\n");
  await git(first, "add", "mixed.txt");
  await fs.writeFile(path.join(first, "mixed.txt"), "working first\n");
  await fs.writeFile(
    path.join(first, "nested", "日本語 note.txt"),
    "nested preview from repository root\n",
  );
  await fs.writeFile(path.join(second, "mixed.txt"), "second repository\n");
  const bare = path.join(fixture, "remote.git");
  await git(fixture, "init", "--bare", bare);
  await git(second, "remote", "add", "origin", bare);
  await git(second, "push", "--set-upstream", "origin", "main");
  await fs.mkdir(profile);
  const now = Date.now();
  const jobs = [first, second].map((cwd, i) => ({
    id: randomUUID(),
    title: `Git fixture ${i + 1}`,
    prompt: "No inference",
    cwd: i === 0 ? path.join(cwd, "nested") : cwd,
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
      settings: { resetWarmupEnabled: false },
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
  const report = { fixture, inferenceRequests: 0, errors: [], checks: [] };
  let app, page;
  try {
    const env = { ...process.env, CODEX_RELAY_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath:
        process.env.RELAY_EXECUTABLE ||
        path.join(root, "node_modules/electron/dist/electron.exe"),
      args: process.env.RELAY_EXECUTABLE ? [] : [root],
      env,
      timeout: 60000,
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page
      .getByRole("button", { name: "新しいチャット", exact: true })
      .waitFor();
    // Use the conversation button, not the same-named project folder.
    const openJob = async (title) =>
      page.getByRole("button", { name: title, exact: true }).last().click();
    await openJob("Git fixture 1");
    await page.getByRole("button", { name: "Git の変更", exact: true }).click();
    const panel = page.locator(".changes-pane");
    const file = (name) =>
      panel.locator(".changed-files button").filter({ hasText: name });
    const staged = panel.getByRole("checkbox", {
      name: "ステージ済み",
      exact: true,
    });
    await file("新しい name.txt").click();
    await until(async () =>
      (await panel.locator(".diff-lines").innerText()).includes(
        "rename from old name.txt",
      ),
    );
    assert.equal(await staged.isChecked(), true);
    assert.equal(await staged.isEnabled(), false);
    await panel
      .getByRole("button", { name: "ファイルをアンステージ", exact: true })
      .click();
    await until(
      async () =>
        !(await git(first, "diff", "--cached", "--name-only")).includes(
          "name.txt",
        ),
    );
    assert.equal(
      await fs.readFile(path.join(first, "新しい name.txt"), "utf8"),
      "rename content\n",
    );
    report.checks.push(
      "staged rename opens nonempty diff; UI unstage removes both index endpoints without deleting worktree file",
    );
    await file("mixed.txt").click();
    await until(async () =>
      (await panel.locator(".diff-lines").innerText()).includes(
        "+working first",
      ),
    );
    assert.equal(await staged.isChecked(), false);
    await staged.check();
    await until(async () =>
      (await panel.locator(".diff-lines").innerText()).includes(
        "+staged first",
      ),
    );
    await staged.uncheck();
    await until(async () =>
      (await panel.locator(".diff-lines").innerText()).includes(
        "+working first",
      ),
    );
    await page.evaluate(() => {
      const diff = document.querySelector(".diff-lines");
      window.__gitQaBlank = false;
      window.__gitQaObserver = new MutationObserver(() => {
        if (!diff.textContent.trim()) window.__gitQaBlank = true;
      });
      window.__gitQaObserver.observe(diff, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await fs.writeFile(path.join(first, "mixed.txt"), "external update\n");
    await until(async () =>
      (await panel.locator(".diff-lines").innerText()).includes(
        "+external update",
      ),
    );
    assert.equal(await page.evaluate(() => window.__gitQaBlank), false);
    await page.evaluate(() => window.__gitQaObserver.disconnect());
    report.checks.push(
      "periodic refresh picks up external edits without blanking the visible diff",
    );
    await panel
      .getByRole("button", { name: "ファイルを元に戻す", exact: true })
      .click();
    await file("nested/日本語 note.txt").click();
    assert.equal(await panel.locator(".restore-confirm").count(), 0);
    assert.equal(
      await panel
        .getByRole("button", { name: "ファイルを元に戻す", exact: true })
        .isEnabled(),
      false,
    );
    await panel.getByTitle("ファイルを開く", { exact: true }).click();
    await page
      .locator(".file-preview")
      .getByText("nested preview from repository root", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "ファイル一覧に戻る", exact: true })
      .click();
    await file("mixed.txt").click();
    await panel
      .getByRole("button", { name: "ファイルを元に戻す", exact: true })
      .click();
    await panel
      .locator(".restore-confirm")
      .getByRole("button", { name: "このファイルの復元を確認", exact: true })
      .click();
    await until(
      async () =>
        (await fs.readFile(path.join(first, "mixed.txt"), "utf8")) ===
        "staged first\n",
    );
    assert.match(
      await git(first, "diff", "--cached", "--", "mixed.txt"),
      /\+staged first/,
    );
    report.checks.push(
      "mixed index/worktree views, restore confirmation clears on selection, untracked restore disabled, repository-relative nested preview",
    );
    await panel
      .getByRole("button", { name: "変更をコミット", exact: true })
      .click();
    await panel
      .getByRole("textbox", { name: "コミットメッセージ", exact: true })
      .fill("must not leak across projects");
    await openJob("Git fixture 2");
    await file("mixed.txt").waitFor();
    assert.equal(await panel.locator(".diff-toolbar").count(), 0);
    assert.equal(await panel.locator(".commit-form").count(), 0);
    await file("mixed.txt").click();
    await until(async () =>
      (await panel.locator(".diff-lines").innerText()).includes(
        "+second repository",
      ),
    );
    await panel
      .getByRole("button", { name: "ファイルをステージ", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "ファイルをアンステージ", exact: true })
      .waitFor();
    await panel
      .getByRole("button", { name: "変更をコミット", exact: true })
      .click();
    await panel
      .getByRole("textbox", { name: "コミットメッセージ", exact: true })
      .fill("native second repository");
    await panel
      .getByRole("button", {
        name: "ステージ済みの変更をコミット",
        exact: true,
      })
      .click();
    await until(
      async () =>
        (await git(second, "log", "-1", "--format=%s")).trim() ===
        "native second repository",
    );
    await panel
      .getByRole("button", { name: "変更をコミット", exact: true })
      .click();
    await panel.getByRole("button", { name: "プッシュ", exact: true }).click();
    await until(
      async () =>
        (await git(bare, "rev-parse", "refs/heads/main")).trim() ===
        (await git(second, "rev-parse", "HEAD")).trim(),
    );
    assert.equal(
      (await git(first, "log", "-1", "--format=%s")).trim(),
      "initial",
    );
    await page.screenshot({ path: path.join(output, "git-native-ja.png") });
    report.checks.push(
      "project switch clears selected file and commit draft; actual UI stage/commit/push changes only second repository and local bare remote",
    );
    const picker = panel.locator(".git-branch-picker");
    const openBranches = async () => {
      await panel
        .getByTitle("ブランチの切り替え・作成", { exact: true })
        .click();
      await picker.getByRole("button", { name: "main", exact: true }).waitFor();
    };
    await openBranches();
    await picker
      .getByRole("button", {
        name: "現在のリビジョンからブランチを作成",
        exact: true,
      })
      .click();
    await picker
      .getByLabel("新しいブランチ名", { exact: true })
      .fill("bad..name");
    await picker
      .getByRole("button", { name: "作成して切り替え", exact: true })
      .click();
    await panel
      .getByRole("alert")
      .filter({ hasText: "新しいブランチ名が無効です" })
      .waitFor();
    assert.equal(
      (await git(second, "branch", "--show-current")).trim(),
      "main",
    );
    await picker
      .getByLabel("新しいブランチ名", { exact: true })
      .fill("機能/UI検証");
    await picker
      .getByRole("button", { name: "作成して切り替え", exact: true })
      .click();
    await picker.waitFor({ state: "detached" });
    assert.equal(
      (await git(second, "branch", "--show-current")).trim(),
      "機能/UI検証",
    );
    await openBranches();
    await picker.getByRole("button", { name: "main", exact: true }).click();
    await picker
      .getByRole("button", { name: "ブランチを切り替え", exact: true })
      .click();
    await picker.waitFor({ state: "detached" });
    assert.equal(
      (await git(second, "branch", "--show-current")).trim(),
      "main",
    );
    await openBranches();
    await picker
      .locator(".branch-picker-list button")
      .filter({ hasText: /^origin\/main/ })
      .click();
    await picker
      .getByLabel("新しいブランチ名", { exact: true })
      .fill("tracking-ui");
    await picker
      .getByRole("button", { name: "作成して切り替え", exact: true })
      .click();
    await picker.waitFor({ state: "detached" });
    assert.equal(
      (await git(second, "rev-parse", "--abbrev-ref", "@{upstream}")).trim(),
      "origin/main",
    );
    await git(second, "worktree", "add", path.join(fixture, "held"), "main");
    await panel.getByTitle("ブランチの切り替え・作成", { exact: true }).click();
    const held = picker
      .locator(".branch-picker-list button")
      .filter({ hasText: /^main/ });
    await held.waitFor();
    assert.equal(await held.isDisabled(), true);
    await picker.getByLabel("ブランチを検索", { exact: true }).fill("機能");
    assert.equal(await picker.locator(".branch-picker-list button").count(), 2);
    const checkbox = await picker
      .locator(".branch-create-toggle input")
      .boundingBox();
    assert.ok(
      checkbox.width <= 20,
      "checkbox stays compact instead of stretching its label",
    );
    assert.equal(await panel.getByRole("alert").count(), 0);
    await page.screenshot({
      path: path.join(output, "git-branches-native-ja.png"),
    });
    await picker
      .getByRole("button", { name: "キャンセル", exact: true })
      .click();
    report.checks.push(
      "Japanese branch UI validates and preserves drafts after errors, creates Unicode branches, switches local branches, tracks remote refs, and disables branches held in another worktree",
    );
    const snapshot = await page.evaluate(() => window.relay.snapshot());
    assert.equal(snapshot.accounts.length, 0);
    assert.equal(snapshot.jobs.length, 2);
    assert.deepEqual(report.errors, []);
    report.status = "passed";
  } catch (error) {
    report.failure = String(error);
    if (page)
      await page
        .screenshot({
          path: path.join(output, "git-native-failure.png"),
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
    if (app) await app.evaluate(({ app }) => app.quit()).catch(() => {});
    if (app) await app.close().catch(() => {});
    clearTimeout(watchdog);
    await fs.writeFile(
      path.join(output, "git-native-report.json"),
      JSON.stringify(report, null, 2),
    );
  }
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
