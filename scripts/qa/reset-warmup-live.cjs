// One real, bounded hi using an existing owned QA profile. This does not
// simulate a server reset or claim to observe a complete five-hour cycle.
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  if (!process.env.RELAY_WARMUP_PROFILE)
    throw Error("Set RELAY_WARMUP_PROFILE to an existing owned QA profile");
  const profile = await fs.realpath(process.env.RELAY_WARMUP_PROFILE);
  if (!profile.startsWith((await fs.realpath(output)) + path.sep))
    throw Error("Only qa-output profiles are allowed");
  const helper = path.join(output, "warmup-live-core.cjs"),
    entry = path.join(output, "warmup-live-entry.cjs"),
    reportFile = path.join(output, "reset-warmup-live-report.json");
  buildSync({
    stdin: {
      contents:
        'export { Store } from "./src/core/store"; export { Accounts } from "./src/core/accounts"; export { WarmupRunner } from "./src/core/warmup-runner"; export { Rpc } from "./src/core/rpc"; export { redact } from "./src/core/redact";',
      loader: "ts",
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: helper,
  });
  await fs.writeFile(
    entry,
    `
const { app, safeStorage } = require("electron");
const fs = require("node:fs/promises");
const { Store, Accounts, WarmupRunner, Rpc, redact } = require(${JSON.stringify(helper)});
app.setName("Codex Relay");
app.setPath("userData", ${JSON.stringify(profile)});
if (!app.requestSingleInstanceLock()) app.exit(2);
else app.whenReady().then(async () => {
 const report = { inferenceRequests: 0, completedTurns: 0, tools: 0, realResetCycleObserved: false };
 let runner;
 try {
  if (!safeStorage.isEncryptionAvailable()) throw Error("Encrypted storage unavailable");
  const store = new Store(${JSON.stringify(profile)}); await store.load();
  if (store.data.jobs.some(j => j.recoveryRequired || ["preparing","running","pausing","rotating","queued","waiting","watching"].includes(j.state))) throw Error("QA profile has active or pending work");
  const accounts = new Accounts(store, { encrypt: v => safeStorage.encryptString(v), decrypt: v => safeStorage.decryptString(v) }, () => {});
  const pool = store.data.accounts.filter(a => a.enabled && a.status !== "reauth" && (!a.expiresAt || a.expiresAt > Date.now())).sort((a,b) => (a.quotas.codex?.primary?.usedPercent ?? 100) - (b.quotas.codex?.primary?.usedPercent ?? 100));
  let selected;
  for (const a of pool) {
   const check = await accounts.inspect(a.id, true);
   const q = check.quotas.codex;
   if (q?.primary && q.primary.usedPercent <= 95 && (!q.secondary || q.secondary.usedPercent <= 95) && !q.reached) { selected = a; break; }
  }
  if (!selected) throw Error("No account with at least 5% remaining in every reported window for a single hi");
  report.before = structuredClone(selected.quotas.codex);
  const open = Rpc.open.bind(Rpc);
  Rpc.open = async (...args) => {
   const rpc = await open(...args), call = rpc.call.bind(rpc);
   rpc.call = (method, params, timeout) => { if (method === "turn/start") report.inferenceRequests++; return call(method, params, timeout); };
   rpc.on("notification", m => { if (m.method === "turn/completed" && m.params.turn.status === "completed") report.completedTurns++; if (m.method === "item/started" && /commandExecution|fileChange|mcpToolCall|imageGeneration|webSearch/.test(m.params.item.type)) report.tools++; });
   return rpc;
  };
  runner = new WarmupRunner(store, accounts, selected, async home => { report.home = home; });
  const quotas = await runner.done;
  report.after = quotas.codex;
  if (report.inferenceRequests !== 1 || report.completedTurns !== 1 || report.tools !== 0 || accounts.busy.has(selected.id)) throw Error("Real warmup assertions failed");
  report.status = "passed";
 } catch (error) { report.status = "failed"; report.error = redact(error instanceof Error ? error.message : String(error)); }
 finally {
  await runner?.stop().catch(() => {});
  await fs.writeFile(${JSON.stringify(reportFile)}, JSON.stringify(report, null, 2));
  app.exit(report.status === "passed" ? 0 : 1);
 }
}).catch(() => app.exit(1));
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    path.join(root, "node_modules/electron/dist/electron.exe"),
    [entry],
    { env, windowsHide: true, stdio: "ignore" },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const report = JSON.parse(await fs.readFile(reportFile, "utf8"));
  console.log(JSON.stringify(report));
  process.exitCode = Number(code) || (report.status === "passed" ? 0 : 1);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
