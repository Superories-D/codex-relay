// Bounded real reset observation. One existing owned QA profile, one selected
// account, at most one hi, no synthetic quota or timer changes. Up to 90 minutes.
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
  const helper = path.join(output, "reset-cycle-core.cjs"),
    entry = path.join(output, "reset-cycle-entry.cjs"),
    reportFile = path.join(output, "reset-cycle-live-report.json");
  buildSync({
    stdin: {
      contents:
        'export { Store } from "./src/core/store"; export { Accounts } from "./src/core/accounts"; export { Scheduler } from "./src/core/scheduler"; export { Rpc } from "./src/core/rpc"; export { redact } from "./src/core/redact";',
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
const { Store, Accounts, Scheduler, Rpc, redact } = require(${JSON.stringify(helper)});
app.setName("Codex Relay"); app.setPath("userData", ${JSON.stringify(profile)});
if (!app.requestSingleInstanceLock()) app.exit(2);
else app.whenReady().then(async () => {
 const report = { status: "starting", startedAt: Date.now(), inferenceRequests: 0, completedTurns: 0, realResetCycleObserved: false };
 let scheduler, store, original, timer, watchdog, done = false, changedAt = 0, completionAt = 0;
 const save = () => fs.writeFile(${JSON.stringify(reportFile)}, JSON.stringify(report, null, 2));
 async function finish(error) {
  if (done) return; done = true; clearInterval(timer); clearTimeout(watchdog);
  try { await scheduler?.shutdown(); } catch (e) { error ||= e; }
  if (original && store) { Object.assign(store.data.settings, original.settings); for (const a of store.data.accounts) a.enabled = original.enabled[a.id]; await store.save(); }
  report.status = error ? "failed" : "passed"; report.finishedAt = Date.now();
  if (error) report.error = redact(error instanceof Error ? error.message : String(error));
  await save(); app.exit(error ? 1 : 0);
 }
 try {
  if (!safeStorage.isEncryptionAvailable()) throw Error("Encrypted storage unavailable");
  store = new Store(${JSON.stringify(profile)}); await store.load();
  if (store.data.jobs.some(j => j.recoveryRequired || ["preparing","running","pausing","rotating","queued","waiting","watching"].includes(j.state))) throw Error("QA profile has active or pending work");
  const pool = store.data.accounts.filter(a => a.enabled && a.status !== "reauth" && (!a.expiresAt || a.expiresAt > Date.now()) && a.quotas.codex?.primary?.windowDurationMins === 300 && a.quotas.codex.primary.resetsAt > Date.now()).sort((a,b) => a.quotas.codex.primary.resetsAt - b.quotas.codex.primary.resetsAt);
  const selected = pool[0]; if (!selected) throw Error("No known upcoming five-hour reset");
  if (selected.quotas.codex.primary.resetsAt - Date.now() > 80 * 60000) throw Error("Next reset is outside this bounded observation");
  original = { settings: { resetWarmupEnabled: store.data.settings.resetWarmupEnabled, pollSeconds: store.data.settings.pollSeconds }, enabled: Object.fromEntries(store.data.accounts.map(a => [a.id, a.enabled])) };
  report.resetAt = selected.quotas.codex.primary.resetsAt;
  report.before = structuredClone(selected.quotas.codex);
  for (const a of store.data.accounts) a.enabled = a === selected;
  store.data.settings.resetWarmupEnabled = true; store.data.settings.pollSeconds = 60; await store.save();
  const open = Rpc.open.bind(Rpc);
  Rpc.open = async (...args) => {
   const rpc = await open(...args), call = rpc.call.bind(rpc);
   rpc.call = (method, params, timeout) => {
    if (method === "turn/start") { if (report.inferenceRequests >= 1) return Promise.reject(Error("QA permits at most one hi")); report.inferenceRequests++; }
    return call(method, params, timeout);
   };
   rpc.on("notification", m => { if (m.method === "turn/completed" && m.params.turn.status === "completed") report.completedTurns++; });
   return rpc;
  };
  const accounts = new Accounts(store, { encrypt: v => safeStorage.encryptString(v), decrypt: v => safeStorage.decryptString(v) }, () => {});
  const factory = () => { throw Error("No foreground tasks are allowed in this QA monitor"); };
  scheduler = new Scheduler(store, accounts, { cli: factory, desktop: factory });
  report.status = "observing"; await save(); scheduler.start();
  timer = setInterval(() => void (async () => {
   if (done) return;
   report.latest = selected.quotas.codex;
   const record = selected.warmups?.codex;
   if (record && record.queuedAt >= report.startedAt && record.resetAt === report.resetAt) {
    report.warmup = structuredClone(record);
    if (["failed","uncertain","yielded"].includes(record.status)) return finish(Error("Reset warmup ended without a confirmed timer"));
    if (["confirmed","covered"].includes(record.status) && record.nextResetAt > Date.now()) {
     report.realResetCycleObserved = true;
     completionAt ||= Date.now();
     // Keep probing for two more cycles to detect accidental duplicate sends.
     if (Date.now() - completionAt > 125000) {
      if (report.inferenceRequests > 1 || report.completedTurns !== report.inferenceRequests) return finish(Error("Unexpected inference count"));
      return finish();
     }
    }
   }
   if (Date.now() - changedAt > 15000) { changedAt = Date.now(); await save(); }
  })().catch(finish), 2000);
  watchdog = setTimeout(() => void finish(Error("No complete real reset observation within 90 minutes")), 90 * 60000);
 } catch (error) { await finish(error); }
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
  console.log(
    JSON.stringify({
      status: "launched",
      pid: child.pid,
      reportFile,
      maximumHi: 1,
      timeoutMinutes: 90,
    }),
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
