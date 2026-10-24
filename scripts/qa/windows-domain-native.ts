import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import path from "node:path";
import {spawn,type ChildProcess} from "node:child_process";
import {Rpc} from "../../src/core/rpc";
import {inspectWindowsDomain,spawnWindowsDomain,releaseWindowsDomain,windowsDomainHost} from "../../src/core/windows-domain";
import {terminateTree} from "../../src/core/process";
import {Store} from "../../src/core/store";
import {Scheduler} from "../../src/core/scheduler";
import {RecoveryDomains,captureWindowsDomain} from "../../src/core/recovery-domains";
import {EventEmitter} from "node:events";
import {randomUUID} from "node:crypto";
import type {Job,Account} from "../../src/shared/types";

async function until(fn:()=>Promise<boolean>|boolean){const end=Date.now()+20000;while(!await fn()){if(Date.now()>end)throw Error("Native domain check timed out");await new Promise(r=>setTimeout(r,40));}}
async function exited(proc:ChildProcess){await until(()=>proc.exitCode!==null||proc.signalCode!==null);}
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return false;throw error;}};
async function main(){
  const repo=process.cwd(),parent="D:/cooperate/codex-relay-qa",root=await fs.mkdtemp(path.join(parent,"domain-native-"));
  const report:{status:string;modelRequests:number;checks:string[];error?:string}={status:"running",modelRequests:0,checks:[]};
  const live:Rpc[]=[];let outside:ChildProcess|undefined;
  try{
    if(process.env.RELAY_EXECUTABLE)assert.equal(await windowsDomainHost(),await fs.realpath(path.join(path.dirname(process.env.RELAY_EXECUTABLE),"resources/windows/RelayJobHost.exe")));
    const fixture=path.join(root,"fixture.cjs"),marker=path.join(root,"descendant.json");
    await fs.writeFile(fixture,`const fs=require('node:fs'),cp=require('node:child_process'),readline=require('node:readline');
if(process.argv[2]==='child'){fs.writeFileSync(process.argv[3],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);}else{
readline.createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);let result=m.params||{};
if(m.method==='initialize')result={};
if(m.method==='fixture.spawn'){const child=cp.spawn(process.execPath,[__filename,'child',m.params.marker],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();while(!fs.existsSync(m.params.marker))await new Promise(r=>setTimeout(r,10));result={pid:child.pid};}
if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
if(m.method==='fixture.exit')setTimeout(()=>process.exit(0),50);
});}
`);
    const shim=path.join(root,"cli.cmd"),entry=path.join(root,"node_modules/@openai/codex/bin/codex.js");await fs.mkdir(path.dirname(entry),{recursive:true});await fs.copyFile(fixture,entry);await fs.writeFile(shim,"");
    const longHome=path.join(root,"nested-"+"x".repeat(185));assert.ok(longHome.length<250);assert.ok(path.join(longHome,"relay-domain-00000000-0000-4000-8000-000000000000.json").length>260);await fs.mkdir(longHome,{recursive:true});const longRpc=await Rpc.open(shim,longHome);live.push(longRpc);assert.deepEqual(await longRpc.call("fixture.echo",{longPath:true}),{longPath:true});assert.ok((await inspectWindowsDomain(longHome)).active>0);await longRpc.close();report.checks.push("A native runtime writes receipts beyond MAX_PATH, exchanges RPC, inspects and releases with long-path-aware I/O while retaining a Windows-supported process cwd");
    outside=spawn(process.execPath,[fixture,"child",path.join(root,"outside.json")],{windowsHide:true,stdio:"ignore"});await until(()=>fs.access(path.join(root,"outside.json")).then(()=>true,()=>false));
    const home=path.join(root,"home");await fs.mkdir(home);
    const rpc=await Rpc.open(shim,home);live.push(rpc);
    const value={text:'原生管道 "quoted" \\ trailing\\',nested:[1,true,"日本語"]};assert.deepEqual(await rpc.call("fixture.echo",value),value);
    const running=await inspectWindowsDomain(home);assert.equal(running.attested,true);assert.ok(running.active>=1);
    const spawned=await rpc.call("fixture.spawn",{marker});assert.equal(alive(spawned.pid),true);assert.ok((await inspectWindowsDomain(home)).active>=2);
    report.checks.push("Actual RPC initializes and round-trips Unicode, quotes and backslashes over inherited native pipes; detached descendant is in the job");
    const receiptPath=path.join(home,`relay-domain-${(rpc.child as any).relayDomain.owner.nonce}.json`),receipt=await fs.readFile(receiptPath,"utf8");
    await fs.writeFile(receiptPath,JSON.stringify({...JSON.parse(receipt),nonce:"00000000-0000-4000-8000-000000000000"}));
    await assert.rejects(inspectWindowsDomain(home));assert.equal(alive(spawned.pid),true);await fs.writeFile(receiptPath,receipt);
    report.checks.push("A mismatched receipt rejects inspection without stopping the current domain");
    await rpc.call("fixture.exit");await exited(rpc.child);await until(()=>!alive(spawned.pid));
    assert.equal((await inspectWindowsDomain(home)).active,0);await rpc.close();
    assert.equal(outside.exitCode,null);assert.equal(outside.signalCode,null);
    report.checks.push("Root exit closes its job and stops detached descendants while an outside control stays alive");
    const rpc2=await Rpc.open(shim,home);live.push(rpc2);await fs.rm(marker);const child2=await rpc2.call("fixture.spawn",{marker});
    rpc2.child.kill();await exited(rpc2.child);await until(()=>!alive(child2.pid));assert.equal((await inspectWindowsDomain(home)).active,0);await rpc2.close();
    report.checks.push("An abrupt host-only kill leaves a receipt that independently confirms no live job members; the runtime home can be reused");
    const rpc3=await Rpc.open(shim,home);live.push(rpc3);await rpc3.close();
    report.checks.push("Explicit RPC close verifies the whole owned job rather than accepting parent PID exit alone");
    const replacement=await Rpc.open(shim,home);live.push(replacement);
    await terminateTree(rpc3.child);await releaseWindowsDomain(home,(rpc3.child as any).relayDomain.owner.nonce);
    assert.deepEqual(await replacement.call('fixture.echo',{replacement:true}),{replacement:true});assert.ok((await inspectWindowsDomain(home)).active>0);await replacement.close();
    report.checks.push("A delayed old stop/release cannot stop the replacement host, overwrite its receipt or remove its owner marker");
    const alias=path.join(root,'home-alias');await fs.symlink(home,alias,'junction');const aliasRpc=await Rpc.open(shim,alias);live.push(aliasRpc);assert.ok((await inspectWindowsDomain(alias)).active>0);await assert.rejects(Rpc.assertHomeIdle(alias));await aliasRpc.close();
    report.checks.push("A runtime home accessed through a Windows junction uses the same canonical owner and native mutex");
    const conflictHome=path.join(root,"conflict");await fs.mkdir(conflictHome);
    const races=await Promise.allSettled([1,2].map(()=>spawnWindowsDomain(process.execPath,[fixture],conflictHome,{...process.env})));
    const winners=races.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof spawnWindowsDomain>>>=>r.status==="fulfilled");assert.equal(winners.length,1);
    await terminateTree(winners[0].value);await exited(winners[0].value);await Rpc.assertHomeIdle(conflictHome);
    report.checks.push("Two concurrent launches into the same home produce one exclusive durable owner and one refusal");
    const installed=JSON.parse(await fs.readFile(path.join(repo,"qa-output/cli-install-native-report.json"),"utf8"));
    const cli=JSON.parse(await fs.readFile(path.join(installed.fixture,"selected-cli.json"),"utf8")).cli;
    const officialHome=path.join(root,"official");await fs.mkdir(officialHome);const official=await Rpc.open(cli,officialHome);live.push(official);
    const signedOut=await official.call("account/read",{refreshToken:false});assert.equal(signedOut.account,null);await official.close();
    report.checks.push("Installed official CLI initializes and reads the signed-out account through the new native host without inference");
    const data=new Store(path.join(root,"scheduler")),projectA=path.join(root,"project-a"),projectB=path.join(root,"project-b");
    await fs.mkdir(projectA);await fs.mkdir(projectB);const now=Date.now();
    const account=(id:string)=>({id,label:id,identity:id,email:'qa@invalid.local',plan:'plus',enabled:true,status:'ready',quotas:{codex:{limitId:'codex',primary:{usedPercent:1,windowDurationMins:300,resetsAt:now/1000+300},secondary:null,observedAt:now,reached:false}},blockedUntil:null,failureCount:0} as unknown as Account);
    data.data.accounts=[account('held-account'),account('independent-account')];data.data.settings.resetWarmupEnabled=false;
    const task=(title:string,cwd:string)=>({id:randomUUID(),title,cwd,prompt:'private fixture only',mode:'cli',model:'',effort:'',bucket:'codex',state:'queued',interactive:true,rotations:0,createdAt:now,updatedAt:now,approvalPolicy:'on-request',sandbox:'workspaceWrite'} as Job);
    const held=task('Retained owned runtime',projectA);held.state='needs_attention';held.recoveryRequired=true;held.accountId='held-account';held.stopIntent='pause';
    const same=task('Shared project waits',projectA),independent=task('Other project continues',projectB),family=task('Shared family waits',projectB);family.runtimeHomeId=held.id;
    data.data.jobs=[held,same,independent,family];const heldHome=data.jobHome(held.id);await fs.mkdir(heldHome,{recursive:true});
    const retained=await Rpc.open(shim,heldHome);live.push(retained);await captureWindowsDomain(data,held,(retained.child as any).relayDomain.owner);
    const started:string[]=[];
    class AccountFreeWorker extends EventEmitter {done:Promise<any>;finish!:(v:any)=>void;constructor(private id:string){super();this.done=new Promise(resolve=>this.finish=resolve);}async start(){started.push(this.id);}async stop(){this.finish({kind:'interrupted'});}async close(){this.finish({kind:'interrupted'});}async quota(){return {};}respond(){}}
    const accounts={busy:new Set(),cancelLogin:async()=>{},inspect:async(id:string)=>({auth:{tokens:{access_token:'fixture-only'}},quotas:data.data.accounts.find(a=>a.id===id)!.quotas})} as any;
    const scheduler=new Scheduler(data,accounts,{cli:ctx=>new AccountFreeWorker(ctx.job.id),desktop:ctx=>new AccountFreeWorker(ctx.job.id)},async()=>{throw Error('Native retained owner remains live');},undefined,new RecoveryDomains(data));let firstClosed=false;
    try{
      await (scheduler as any).tick();await until(()=>started.includes(independent.id));
      assert.deepEqual(started,[independent.id]);assert.equal(independent.accountId,'independent-account');assert.equal(alive(retained.child.pid!),true);
      const cards=scheduler.operations().cards;assert.equal(cards.find(c=>c.id===same.id)!.gates.some(g=>g.code==='ownership'),true);assert.equal(cards.find(c=>c.id===family.id)!.gates.some(g=>g.code==='ownership'),true);
      const plan=scheduler.recoveryPlan();assert.equal(plan.entries[0].status,'scoped');assert.ok(plan.entries[0].affected.includes(same.id));assert.equal(held.stopIntent,'pause');
      const disk=new Store(data.root);await disk.load();assert.equal(disk.data.jobs.find(j=>j.id===held.id)!.recoveryDomainObservation!.status,'scoped');
      assert.equal(started.length,1);await scheduler.inspectRecovery(plan.id);assert.equal(started.length,1);
      const probe=path.join(heldHome,'quota-probe');await fs.mkdir(probe);await fs.writeFile(path.join(probe,'relay-owner.json'),JSON.stringify({pid:process.pid,nonce:'legacy-owner'}));
      await scheduler.inspectRecovery();assert.equal(scheduler.recoveryPlan().entries[0].status,'global');await fs.rm(path.join(probe,'relay-owner.json'));await scheduler.inspectRecovery();
      report.checks.push("A legacy quota-probe owner cannot be treated as a scoped native domain");
      const knownDomain=held.runtimeDomain;held.runtimeDomain=undefined;await assert.rejects(scheduler.inspectRecovery(plan.id),/已变化/);
      await scheduler.inspectRecovery();assert.equal(scheduler.recoveryPlan().entries[0].status,'global');
      const newcomer=task('Unknown proof cannot bypass',path.join(root,'third-project'));await fs.mkdir(newcomer.cwd);data.data.jobs.push(newcomer);await (scheduler as any).tick();assert.equal(started.includes(newcomer.id),false);
      report.checks.push("Actual scheduler admits an independent project on another account alongside a live contained owner, while shared project/family wait; scope evidence is durable and pause remains");
      report.checks.push("Read-only reinspection does not start work; stale plan IDs reject and lost scope proof restores the global gate");
      held.runtimeDomain=knownDomain;await scheduler.shutdown();firstClosed=true;
      const restored=new Store(data.root);await restored.load();
      const afterRestart=task('Independent work after restart',projectB);restored.data.jobs.push(afterRestart);
      const restoredDomains=new RecoveryDomains(restored),restoredScheduler=new Scheduler(restored,accounts,{cli:ctx=>new AccountFreeWorker(ctx.job.id),desktop:ctx=>new AccountFreeWorker(ctx.job.id)},async()=>{throw Error('Retained native owner is still alive');},undefined,restoredDomains);
      try{
        assert.equal(restoredDomains.global([]).length,1,'Persisted scope observations must not authorize admission before fresh checks');
        await (restoredScheduler as any).tick();await until(()=>started.includes(afterRestart.id));
        assert.equal(afterRestart.accountId,'independent-account');assert.equal(restored.data.jobs.find(j=>j.id===held.id)!.stopIntent,'pause');
        const pending=task('Cannot start before evidence save',projectB);restored.data.jobs.push(pending);
        restored.data.jobs.find(j=>j.id===held.id)!.recoveryDomainObservation=undefined;
        const originalSave=restored.save.bind(restored);restored.save=async()=>{throw Error('Native fixture denied evidence persistence');};
        try{await (restoredScheduler as any).tick();assert.equal(started.includes(pending.id),false);assert.equal(restoredScheduler.recoveryPlan().entries[0].reason,'storage');}
        finally{restored.save=originalSave;}
        await restoredScheduler.inspectRecovery();assert.equal(restoredScheduler.recoveryPlan().entries[0].status,'scoped');
        await assert.rejects(restoredScheduler.control(held.id,'cancel'),/still alive/);
        const intent=JSON.parse(await fs.readFile(path.join(restored.root,'state.json'),'utf8')).jobs.find((j:Job)=>j.id===held.id);assert.equal(intent.stopIntent,'cancel');
        report.checks.push("Restart revalidates the live native domain rather than trusting saved observations; denied evidence persistence prevents independent admission until a durable retry");
        report.checks.push("Cancel is durably remembered even when cleanup of the retained domain still refuses to complete");
      }finally{await restoredScheduler.shutdown();}
    }finally{await retained.close();if(!firstClosed)await scheduler.shutdown();}
    report.status="passed";
  }catch(error){report.status="failed";report.error=error instanceof Error?error.stack:String(error);throw error;}
  finally{
    for(const rpc of live)await rpc.close().catch(()=>{});
    if(outside){outside.kill();await exited(outside);}
    await fs.writeFile(path.join(repo,"qa-output/windows-domain-native-report.json"),JSON.stringify(report,null,2));
    const actual=await fs.realpath(root),expected=await fs.realpath(parent);if(path.dirname(actual)!==expected||!path.basename(actual).startsWith("domain-native-"))throw Error("Unsafe native domain fixture cleanup");
    await fs.rm(actual,{recursive:true,force:true});
  }
  console.log(JSON.stringify(report));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
