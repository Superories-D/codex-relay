// Offline replay of the two real server snapshots retained by the previous
// bounded monitor. A process-local clock is replayed; no server or model calls.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process"),
  { build: compile } = require("esbuild");
const assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
async function replay(input, baseline) {
  const fixture = await fs.mkdtemp(
    path.join(output, baseline ? "reset-replay-old-" : "reset-replay-fixed-"),
  );
  const build = await compile({
    stdin: {
      contents:
        'export {AccountWarmups} from "./src/core/account-warmups"; export {Store} from "./src/core/store";',
      loader: "ts",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: baseline
      ? [
          {
            name: "baseline-warmups",
            setup(build) {
              build.onLoad({ filter: /[\\/]account-warmups\.ts$/ }, (args) => ({
                contents: execFileSync(
                  "git",
                  ["show", "e019f90:src/core/account-warmups.ts"],
                  { cwd: root, encoding: "utf8" },
                ),
                loader: "ts",
                resolveDir: path.dirname(args.path),
              }));
            },
          },
        ]
      : [],
  });
  const mod = { exports: {} };
  new Function("require", "module", "exports", build.outputFiles[0].text)(
    require,
    mod,
    mod.exports,
  );
  const { AccountWarmups, Store } = mod.exports,
    store = new Store(fixture);
  const account = {
    id: "replay",
    identity: "replay",
    email: "qa@example.invalid",
    label: "Replay",
    plan: "plus",
    enabled: true,
    status: "ready",
    blockedUntil: null,
    failureCount: 0,
    quotas: { codex: input.latest },
  };
  store.data.accounts = [account];
  let inferenceRequests = 0;
  const manager = new AccountWarmups(
    store,
    () => {},
    () => {
      inferenceRequests++;
      throw Error("Replay forbids inference");
    },
    () => false,
  );
  const clock = Date.now;
  Date.now = () => input.latest.observedAt;
  try {
    manager.observe(account, { codex: input.before }, { codex: input.latest });
    await manager.shutdown();
    return {
      status: account.warmups?.codex?.status,
      window: account.resetWindows?.codex,
      inferenceRequests,
      sourceSHA256: createHash("sha256")
        .update(build.outputFiles[0].text)
        .digest("hex"),
    };
  } finally {
    Date.now = clock;
  }
}
(async () => {
  const input = JSON.parse(
    await fs.readFile(
      path.join(output, "reset-cycle-live-report.json"),
      "utf8",
    ),
  );
  assert(
    input.before.primary.usedPercent > 0 &&
      input.latest.primary.usedPercent === 0,
  );
  const old = await replay(input, true),
    fixed = await replay(input, false);
  assert.equal(old.status, "covered");
  assert.equal(fixed.status, "queued");
  assert.equal(fixed.inferenceRequests, 0);
  const report = {
    status: "passed",
    simulatedClock: true,
    serverRequests: 0,
    inferenceRequests: 0,
    source: "reset-cycle-live-report.json",
    snapshotTimes: [input.before.observedAt, input.latest.observedAt],
    baseline: old,
    fixed,
  };
  await fs.writeFile(
    path.join(output, "reset-window-replay-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
