import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {Rpc} from "../../src/core/rpc";
import {Store} from "../../src/core/store";
import {captureWindowsDomain} from "../../src/core/recovery-domains";
import {windowsDomainHost} from "../../src/core/windows-domain";
import type {Job,Account} from "../../src/shared/types";
const {_electron}=require(process.env.RELAY_PLAYWRIGHT_MODULE||"playwright");
const repo=process.cwd(),output=path.join(repo,"qa-output");
async function until(fn:()=>Promise<boolean>){const end=Date.now()+30000;while(!await fn()){if(Date.now()>end)throw Error("Recovery native check timed out");await new Promise(r=>setTimeout(r,100));}}
async function main(){
  const parent="D:/cooperate/codex-relay-qa",profile=await fs.mkdtemp(path.join(parent,"recovery-ui-")),project=path.join(profile,"Project A");await fs.mkdir(project);
  const data=new Store(profile),now=Date.now();let retained:Rpc|undefined,app:any,page:any;
  const report:{status:string;modelRequests:number;externalMessages:number;checks:string[];layouts:unknown[];errors:string[];error?:string}={status:"running",modelRequests:0,externalMessages:0,checks:[],layouts:[],errors:[]};
  try{
    if(process.env.RELAY_EXECUTABLE)assert.equal(await windowsDomainHost(),await fs.realpath(path.join(path.dirname(process.env.RELAY_EXECUTABLE),"resources/windows/RelayJobHost.exe")));
    const installed=JSON.parse(await fs.readFile(path.join(output,"cli-install-native-report.json"),"utf8")),cli=JSON.parse(await fs.readFile(path.join(installed.fixture,"selected-cli.json"),"utf8")).cli;
    data.data.settings={...data.data.settings,cliPath:cli,resetWarmupEnabled:false};data.data.dispatch={paused:true,projects:[],updatedAt:now};
    data.data.accounts=[{id:randomUUID(),label:"Recovery fixture account",identity:"fixture",plan:"plus",email:"fixture@invalid.local",enabled:false,status:"ready",quotas:{},failureCount:0,blockedUntil:null} as Account];
    const held:Job={id:randomUUID(),title:"Held native runtime",cwd:project,prompt:"PRIVATE RECOVERY PROMPT",mode:"cli",model:"",effort:"",bucket:"codex",state:"needs_attention",accountId:data.data.accounts[0].id,stopIntent:"pause",recoveryRequired:true,autoRecovery:{reason:"process",attempt:1,nextAttemptAt:now+3600000},rotations:0,createdAt:now,updatedAt:now,approvalPolicy:"on-request",sandbox:"workspaceWrite"};
    const related={...held,id:randomUUID(),title:"Shared project queue",state:"queued",accountId:undefined,stopIntent:undefined,recoveryRequired:false,autoRecovery:undefined} as Job;data.data.jobs=[held,related];
    const shim=path.join(profile,"fixture.cmd"),entry=path.join(profile,"node_modules/@openai/codex/bin/codex.js");await fs.mkdir(path.dirname(entry),{recursive:true});await fs.writeFile(shim,"");
    await fs.writeFile(entry,`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.params||{}})+'\\n');});`);
    await fs.mkdir(data.jobHome(held.id),{recursive:true});retained=await Rpc.open(shim,data.jobHome(held.id));const owner=(retained.child as any).relayDomain.owner;await captureWindowsDomain(data,held,owner);
    await fs.writeFile(path.join(profile,"desktop.json"),JSON.stringify({projects:[{id:"project",name:"Recovery native",cwd:project}],schedules:[],preferences:{language:"en",theme:"light",notifications:false,closeToTray:false}}));
    const env={...process.env,CODEX_RELAY_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
    app=await _electron.launch({executablePath:process.env.RELAY_EXECUTABLE||path.join(repo,"node_modules/electron/dist/electron.exe"),args:process.env.RELAY_EXECUTABLE?[]:[repo],env,timeout:60000});page=await app.firstWindow();page.on("pageerror",(e:Error)=>report.errors.push(e.message));await page.locator(".agent-shell").waitFor();
    const call=(name:string,args?:unknown)=>page.evaluate(({name,args}:any)=>window.relay.command(name,args),{name,args});
    await until(async()=> (await call("recovery.plan")).entries[0]?.status==="scoped");
    const open=async(label:string)=>{await page.locator(".task-queue-button").click();await page.locator(".task-center > header > button").nth(2).click();await page.getByRole("button",{name:label,exact:true}).click();await page.locator(".recovery-entry[data-scope=scoped]").waitFor();};
    await open("View recovery plan");let panel=page.locator(".recovery-plan");const original=await call("recovery.plan"),receiptPath=path.join(data.jobHome(held.id),`relay-domain-${owner.nonce}.json`),receipt=await fs.readFile(receiptPath,"utf8");
    await fs.writeFile(receiptPath,JSON.stringify({...JSON.parse(receipt),nonce:randomUUID()}));const changed=await call("recovery.inspect",{id:original.id});assert.equal(changed.entries[0].status,"global");
    await panel.getByRole("button",{name:"Recheck ownership",exact:true}).click();await panel.locator("[role=alert]").waitFor();await panel.locator(".recovery-entry[data-scope=global]").waitFor();assert.ok((await panel.locator("[role=alert]").textContent()).includes("Recovery plan changed"));
    assert.deepEqual(await retained.call("fixture.ping",{retained:true}),{retained:true});await fs.writeFile(receiptPath,receipt);
    await panel.getByRole("button",{name:"Recheck ownership",exact:true}).click();await panel.locator(".recovery-entry[data-scope=scoped]").waitFor();
    assert.equal((await call("snapshot")).jobs.find((j:Job)=>j.id===held.id).stopIntent,"pause");assert.equal((await call("snapshot")).jobs.find((j:Job)=>j.id===related.id).state,"queued");
    report.checks.push("Actual Electron renders scoped ownership; receipt corruption restores global waiting, stale UI rechecks refresh the plan, and a repaired receipt restores scoped evidence without stopping the retained runtime");
    await page.keyboard.press("Escape");
    for(const [language,theme,zoom,label,title] of [["zh-CN","dark",1,"查看恢复计划","Windows 恢复计划"],["zh-TW","light",1,"檢視恢復計劃","Windows 恢復計劃"],["en","light",1.5,"View recovery plan","Windows recovery plan"],["ja","dark",1,"復旧計画を表示","Windows 復旧計画"]] as const){
      await call("desktop.preferences",{language,theme});await page.reload();await page.locator(".agent-shell").waitFor();await page.evaluate((value:number)=>document.body.style.zoom=String(value),zoom);await open(label);panel=page.locator(".recovery-plan");assert.equal(await panel.locator("h2").textContent(),title);
      if(language==="en")assert.equal(/[\u3400-\u9fff]/.test(await panel.textContent()),false);
      const metrics=await panel.evaluate((el:HTMLElement)=>({overflow:el.scrollWidth>el.clientWidth+2}));assert.equal(metrics.overflow,false);
      await panel.evaluate(async(el:HTMLElement)=>{const dialog=el.closest("dialog")!;await Promise.all(dialog.getAnimations({subtree:true}).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
      const surface=await panel.evaluate((el:HTMLElement)=>{const modal=el.closest(".modal")!;return{background:getComputedStyle(modal).backgroundColor,opacity:getComputedStyle(modal).opacity};});assert.equal(surface.opacity,"1");assert.ok(!surface.background.endsWith(", 0)"));
      assert.equal(await panel.evaluate((el:HTMLElement)=>{const a=el.querySelector("header button")!.getBoundingClientRect(),b=el.closest(".modal")!.querySelector(".modal-close")!.getBoundingClientRect();return a.right>b.left&&a.left<b.right&&a.bottom>b.top&&a.top<b.bottom;}),false,"Recheck and Close must not overlap");
      await page.screenshot({path:path.join(output,`recovery-native-${language}.png`)});
      report.layouts.push({language,theme,zoom,title,bounded:true});await page.keyboard.press("Escape");
    }
    const history=await call("operations.history",{taskId:held.id});assert.ok(history.events.some((e:any)=>e.current?.recovery.scope?.status==="scoped"));assert.ok(!JSON.stringify(history).includes("PRIVATE RECOVERY PROMPT"));assert.ok(!JSON.stringify(history).includes(profile));
    report.checks.push("Four native locales and 150% English zoom remain bounded; actual durable history records scope changes without prompts or private resource paths");
    assert.deepEqual(report.errors,[]);report.status="passed";
  }catch(error){report.status="failed";report.error=error instanceof Error?error.stack:String(error);if(page&&!page.isClosed())await page.screenshot({path:path.join(output,"recovery-native-failure.png")}).catch(()=>{});throw error;}
  finally{
    await app?.close().catch(()=>{});await retained?.close().catch(()=>{});await fs.writeFile(path.join(output,"recovery-native-report.json"),JSON.stringify(report,null,2));
    const actual=await fs.realpath(profile),expected=await fs.realpath(parent);if(path.dirname(actual)!==expected||!path.basename(actual).startsWith("recovery-ui-"))throw Error("Unsafe recovery UI fixture cleanup");await fs.rm(actual,{recursive:true,force:true});
  }
  console.log(JSON.stringify(report));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
