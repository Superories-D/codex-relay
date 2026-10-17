// Observe the next real server reset using an existing, owned encrypted QA
// profile. No clock/quota substitution, at most one inference, graceful stop.
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  if (!process.env.RELAY_WARMUP_PROFILE)
    throw Error("Set RELAY_WARMUP_PROFILE to an existing owned QA profile");
  const profile = await fs.realpath(process.env.RELAY_WARMUP_PROFILE);
  if (!profile.startsWith((await fs.realpath(output)) + path.sep))
    throw Error("Only owned qa-output profiles are allowed");
  const run = "reset-observe-" + randomUUID(),
    helper = path.join(output, run + "-core.cjs"),
    entry = path.join(output, run + "-entry.cjs"),
    reportFile = path.join(output, run + "-report.json"),
    traceFile = path.join(output, run + "-trace.jsonl"),
    stopFile = path.join(output, run + ".stop");
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
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceSha256 = createHash("sha256")
      .update(await fs.readFile(helper))
      .digest("hex");
  await fs.writeFile(
    entry,
    `
const { app, safeStorage } = require("electron"), fs = require("node:fs/promises");
const { Store, Accounts, Scheduler, Rpc, redact } = require(${JSON.stringify(helper)});
const reportFile = ${JSON.stringify(reportFile)}, traceFile = ${JSON.stringify(traceFile)}, stopFile = ${JSON.stringify(stopFile)};
app.setName("Codex Relay"); app.setPath("userData", ${JSON.stringify(profile)});
if (!app.requestSingleInstanceLock()) app.exit(2);
else app.whenReady().then(async () => {
 const report = { status: "starting", startedAt: Date.now(), profile: ${JSON.stringify(profile)}, pid: process.pid,
  sourceCommit: ${JSON.stringify(sourceCommit)}, sourceSha256: ${JSON.stringify(sourceSha256)},
  inferenceRequests: 0, completedTurns: 0, realResetCycleObserved: false, traceFile, stopFile, timeoutMinutes: 360 };
 let scheduler, store, selected, original, timer, watchdog, done = false, ticking = false, completionAt = 0, lastSavedAt = 0;
 let writes = Promise.resolve();
 const trace = value => { writes = writes.then(() => fs.appendFile(traceFile, JSON.stringify({ at: Date.now(), ...value }) + "\\n")); void writes.catch(() => {}); };
 const save = async () => { await writes; await fs.writeFile(reportFile, JSON.stringify(report, null, 2)); };
 async function finish(error, cancelled = false) {
  if (done) return; done = true; clearInterval(timer); clearTimeout(watchdog);
  try { await scheduler?.shutdown(); } catch (e) { error ||= e; }
  if (store && original) {
   Object.assign(store.data.settings, original.settings);
   for (const a of store.data.accounts) a.enabled = original.enabled[a.id];
   await store.save().catch(e => { error ||= e; });
  }
  report.status = cancelled ? "cancelled" : error ? "failed" : "passed";
  report.finishedAt = Date.now();
  if (error) report.error = redact(error instanceof Error ? error.message : String(error));
  trace({ type: "finish", status: report.status });
  await save(); app.exit(error ? 1 : 0);
 }
 try {
  if (!safeStorage.isEncryptionAvailable()) throw Error("Encrypted storage unavailable");
  store = new Store(${JSON.stringify(profile)}); await store.load();
  if (store.data.jobs.some(j => j.recoveryRequired || ["preparing","running","pausing","rotating","queued","waiting","watching"].includes(j.state))) throw Error("QA profile has active or pending work");
  selected = store.data.accounts.find(a => a.enabled && a.status === "ready" && a.resetWindows?.codex?.resetAt > Date.now() && a.quotas.codex?.primary?.windowDurationMins === 300);
  if (!selected || selected.resetWindows.codex.resetAt - Date.now() > 5 * 3600000) throw Error("No proven upcoming five-hour boundary");
  if (Object.values(selected.warmups || {}).some(w => ["queued","running"].includes(w.status) || w.processSafe === false)) throw Error("QA account already has pending warmup work");
  report.resetAt = selected.resetWindows.codex.resetAt;
  report.before = structuredClone(selected.quotas.codex);
  original = { settings: { resetWarmupEnabled: store.data.settings.resetWarmupEnabled, pollSeconds: store.data.settings.pollSeconds }, enabled: Object.fromEntries(store.data.accounts.map(a => [a.id, a.enabled])) };
  const open = Rpc.open.bind(Rpc);
  Rpc.open = async (...args) => {
   const rpc = await open(...args), call = rpc.call.bind(rpc);
   rpc.call = (method, params, timeout) => {
    if (method === "turn/start") {
     const q = selected.quotas.codex, windows = [q?.primary,q?.secondary].filter(Boolean);
     if (report.inferenceRequests >= 1 || !q || Date.now() - q.observedAt > 120000 || q.reached || !windows.length || windows.some(w => w.usedPercent > 95)) return Promise.reject(Error("QA permits one hi only with fresh quota above 5%"));
     report.inferenceRequests++; trace({ type: "inference-admitted", quota: q });
    }
    return call(method, params, timeout);
   };
   rpc.on("notification", m => {
    if (m.method === "turn/completed" && m.params.turn.status === "completed") { report.completedTurns++; trace({ type: "turn-completed" }); }
   });
   return rpc;
  };
  const accounts = new Accounts(store, { encrypt: v => safeStorage.encryptString(v), decrypt: v => safeStorage.decryptString(v) }, () => {});
  const factory = () => { throw Error("No foreground tasks allowed in this monitor"); };
  scheduler = new Scheduler(store, accounts, { cli: factory, desktop: factory });
  const observe = accounts.quotaObserved;
  accounts.quotaObserved = (a, previous, fresh) => {
   if (a === selected) trace({ type: "quota", previous: previous.codex, current: fresh.codex });
   observe?.(a, previous, fresh);
  };
  for (const a of store.data.accounts) a.enabled = a === selected;
  store.data.settings.resetWarmupEnabled = true; store.data.settings.pollSeconds = 60;
  await store.save(); report.status = "observing";
  trace({ type: "baseline", quota: selected.quotas.codex, anchor: selected.resetWindows.codex });
  await save(); scheduler.start();
  timer = setInterval(() => {
   if (done || ticking) return; ticking = true;
   void (async () => {
    const stopped = await fs.stat(stopFile).then(() => true, e => { if(e.code === "ENOENT") return false; throw e; });
    if (stopped) return finish(undefined, true);
    report.latest = structuredClone(selected.quotas.codex);
    const record = selected.warmups?.codex;
    if (record && record.queuedAt >= report.startedAt) {
     report.warmup = structuredClone(record);
     if (record.resetAt !== report.resetAt) return finish(Error("Detected a different cycle; requires review"));
     if (["failed","uncertain","yielded"].includes(record.status)) return finish(Error("Warmup ended without a confirmed timer"));
     const verified = ["confirmed","covered"].includes(record.status) && record.nextResetAt > Date.now() && selected.resetWindows?.codex?.resetAt === record.nextResetAt;
     if (verified) {
      report.realResetCycleObserved = true; completionAt ||= Date.now();
      if (Date.now() - completionAt > 125000) {
       if (report.completedTurns !== report.inferenceRequests) return finish(Error("Unexpected inference completion count"));
       return finish();
      }
     }
    }
    if (Date.now() - lastSavedAt > 15000) { lastSavedAt = Date.now(); await save(); }
   })().catch(finish).finally(() => { ticking = false; });
  }, 2000);
  watchdog = setTimeout(() => void finish(Error("No complete real reset observation within six hours")), 360 * 60000);
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
  const handle = {
    pid: child.pid,
    profile,
    reportFile,
    traceFile,
    stopFile,
    sourceCommit,
    sourceSha256,
    maximumHi: 1,
    timeoutMinutes: 360,
  };
  await fs.writeFile(
    path.join(output, "reset-observe-latest.json"),
    JSON.stringify(handle, null, 2),
  );
  console.log(JSON.stringify({ status: "launched", ...handle }));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const report = JSON.parse(await fs.readFile(reportFile, "utf8"));
  console.log(JSON.stringify(report));
  process.exitCode =
    Number(code) || (["passed", "cancelled"].includes(report.status) ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
