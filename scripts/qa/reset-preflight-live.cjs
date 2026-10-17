// Real server quota observations and the production preflight. Inference is
// prohibited: a live, stable existing countdown must not spend another hi.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  { spawn } = require("node:child_process"),
  { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../.."),
  output = path.join(root, "qa-output");
(async () => {
  if (!process.env.RELAY_WARMUP_PROFILE)
    throw Error("Set RELAY_WARMUP_PROFILE to an existing owned QA profile");
  const profile = await fs.realpath(process.env.RELAY_WARMUP_PROFILE);
  if (!profile.startsWith((await fs.realpath(output)) + path.sep))
    throw Error("Only owned QA profiles are allowed");
  const helper = path.join(output, "reset-preflight-core.cjs"),
    entry = path.join(output, "reset-preflight-entry.cjs"),
    reportFile = path.join(output, "reset-preflight-live-report.json");
  buildSync({
    stdin: {
      contents:
        'export { Store } from "./src/core/store"; export { Accounts } from "./src/core/accounts"; export { AccountWarmups } from "./src/core/account-warmups"; export { WarmupRunner } from "./src/core/warmup-runner"; export { Rpc } from "./src/core/rpc"; export { redact } from "./src/core/redact";',
      loader: "ts",
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: helper,
  });
  const old = JSON.parse(
    await fs.readFile(
      path.join(output, "reset-cycle-live-report.json"),
      "utf8",
    ),
  );
  await fs.writeFile(
    entry,
    `
 const {app,safeStorage}=require('electron'),fs=require('node:fs/promises');
 const {Store,Accounts,AccountWarmups,WarmupRunner,Rpc,redact}=require(${JSON.stringify(helper)});
 app.setName('Codex Relay');app.setPath('userData',${JSON.stringify(profile)});
 if(!app.requestSingleInstanceLock())app.exit(2);else app.whenReady().then(async()=>{
 const report={inferenceRequests:0,turnStartAttempts:0,realResetCycleObserved:false,historicalBoundaryUsedOnlyAsPreflightInput:true,resetAt:${JSON.stringify(old.resetAt)}};
 let manager,runner;
 try{
  const store=new Store(${JSON.stringify(profile)});await store.load();
  if(store.data.jobs.some(j=>j.recoveryRequired||['running','preparing','queued','waiting','pausing','rotating','watching'].includes(j.state)))throw Error('QA profile is not idle');
  const selected=store.data.accounts.find(a=>a.enabled&&a.status!=='reauth');if(!selected)throw Error('No QA account');
  report.before=structuredClone(selected.quotas.codex);
  const accounts=new Accounts(store,{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)},()=>{});
  manager=new AccountWarmups(store,()=>{},()=>{throw Error('Detector preflight must not execute inference')},()=>false);
  accounts.quotaObserved=(a,b,c)=>manager.observe(a,b,c);
  const open=Rpc.open.bind(Rpc);Rpc.open=async(...args)=>{const rpc=await open(...args),call=rpc.call.bind(rpc);rpc.call=(method,...rest)=>{if(method==='turn/start'){report.turnStartAttempts++;throw Error('Live preflight forbids inference')}return call(method,...rest)};return rpc};
  runner=new WarmupRunner(store,accounts,selected,async()=>{throw Error('Stable countdown must not create a runtime')},report.resetAt);
  report.after=(await runner.done).codex;report.admitted=runner.admitted;report.tracked=selected.resetWindows?.codex;
  if(runner.admitted||report.turnStartAttempts||report.tracked?.resetAt!==report.after.primary?.resetsAt||report.tracked?.evidence!=='stable')throw Error('Existing live countdown was not recognized');
  report.status='passed';
 }catch(e){report.status='failed';report.error=redact(e instanceof Error?e.message:String(e))}
 finally{await runner?.stop().catch(()=>{});await manager?.shutdown();await fs.writeFile(${JSON.stringify(reportFile)},JSON.stringify(report,null,2));app.exit(report.status==='passed'?0:1)}
 }).catch(()=>app.exit(1));`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    path.join(root, "node_modules/electron/dist/electron.exe"),
    [entry],
    { env, windowsHide: true, stdio: "ignore" },
  );
  const code = await new Promise((r, j) => {
    child.once("error", j);
    child.once("exit", r);
  });
  const report = JSON.parse(await fs.readFile(reportFile, "utf8"));
  console.log(JSON.stringify(report));
  process.exitCode = Number(code) || (report.status === "passed" ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
