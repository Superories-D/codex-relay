// Actual Windows Electron, scheduler, plan library, complete-file evidence,
// download and restart. Isolated profile, no accounts, model inference or Bot API.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'qa-output');
async function until(fn){const end=Date.now()+25000;while(!await fn()){if(Date.now()>end)throw Error('Delivery center native check timed out');await new Promise(r=>setTimeout(r,100));}}
(async()=>{
  const profile=await fs.mkdtemp(path.join(output,'delivery-center-native-')),cwd=path.join(profile,'project');await fs.mkdir(cwd);
  const artifact=path.join(cwd,'artifact.txt');await fs.writeFile(artifact,'original');
  const installed=JSON.parse(await fs.readFile(path.join(output,'cli-install-native-report.json'))),cli=JSON.parse(await fs.readFile(path.join(installed.fixture,'selected-cli.json'))).cli;
  const parent=crypto.randomUUID(),child=crypto.randomUUID(),workflow=crypto.randomUUID(),now=Date.now();
  const job=(id,title,state,step)=>({id,title,prompt:'Preserve this user prompt',cwd,mode:'cli',state,model:'',effort:'',bucket:'codex',interactive:true,rotations:0,createdAt:now,updatedAt:now,approvalPolicy:'on-request',sandbox:'workspaceWrite',workflow:{id:workflow,title:'Native delivery workflow',step,total:2,fingerprint:'qa'}});
  await fs.writeFile(path.join(profile,'state.json'),JSON.stringify({version:1,cursor:0,accounts:[],logs:[],settings:{cliPath:cli,resetWarmupEnabled:false},jobs:[
    {...job(parent,'Verified parent','completed',1),delivery:{revision:1,checks:[{kind:'file',path:'artifact.txt',label:'Artifact',minBytes:1}],reports:[]}},
    {...job(child,'Paused dependent','paused',2),stopIntent:'pause',dependsOn:[parent]},
  ]}));
  await fs.writeFile(path.join(profile,'desktop.json'),JSON.stringify({projects:[{id:'project',name:'Delivery center QA',cwd}],schedules:[],preferences:{theme:'light',language:'en',notifications:false,closeToTray:false}}));
  let app;const report={profile,inferenceTurns:0,externalBotMessages:0,errors:[],checks:[]};
  const launch=async()=>{
    const env={...process.env,CODEX_RELAY_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
    app=await _electron.launch({executablePath:process.env.RELAY_EXECUTABLE||path.join(root,'node_modules/electron/dist/electron.exe'),args:process.env.RELAY_EXECUTABLE?[]:[root],env,timeout:60000});
    const page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));await page.locator('.agent-shell').waitFor();return page;
  };
  const center=async page=>{await page.locator('.task-queue-button').click();await page.getByRole('button',{name:'Delivery center',exact:true}).click();await page.locator('.dc-plans select option').first().waitFor({state:'attached'});};
  const batches=page=>page.evaluate(()=>window.relay.command('delivery.batches'));
  try{
    let page=await launch();await page.evaluate(id=>window.relay.command('delivery.run',id),parent);
    let d=await page.evaluate(id=>window.relay.command('delivery.read',id),parent);assert.equal(d.reports[0].status,'passed');const baseline=d.reports[0].id;
    await center(page);await page.locator('.dc-task-list').getByLabel('Verified parent',{exact:true}).check();
    await fs.writeFile(artifact,'modified');await page.getByRole('button',{name:'Inspect delivery evidence',exact:true}).click();
    await until(async()=> (await batches(page)).batches.at(-1)?.status==='completed');
    d=await page.evaluate(id=>window.relay.command('delivery.read',id),parent);
    assert.equal(d.staleEvidence.reportId,baseline);assert.equal(d.reports.length,1);assert.equal(d.reports[0].status,'passed');
    let state=await page.evaluate(()=>window.relay.snapshot());assert.equal(state.jobs.find(j=>j.id===parent).state,'needs_attention');assert.equal(state.jobs.find(j=>j.id===child).state,'paused');
    await page.evaluate(id=>window.relay.command('job.control',{id,action:'resume'}),child);
    await page.waitForTimeout(1200);state=await page.evaluate(()=>window.relay.snapshot());assert.equal(state.jobs.find(j=>j.id===child).state,'queued');
    const first=(await batches(page)).batches[0];assert.equal(first.items[0].status,'failed');assert.equal(first.items[0].report.status,'passed');assert.equal(first.items[0].comparison.status,'changed');
    assert.equal(first.items[0].workflow.id,workflow);report.checks.push('Actual complete-file hash invalidates a still-passing size rule and holds dependency admission');
    await page.locator('.dc-history').getByRole('button',{name:'Export batch evidence',exact:true}).waitFor();
    const exported=path.join(profile,'batch-evidence.json');
    await app.evaluate(({session},destination)=>{session.defaultSession.once('will-download',(_event,item)=>item.setSavePath(destination));},exported);
    await page.getByRole('button',{name:'Export batch evidence',exact:true}).click();
    await until(async()=>{try{JSON.parse(await fs.readFile(exported,'utf8'));return true;}catch{return false;}});
    const evidence=JSON.parse(await fs.readFile(exported,'utf8'));
    assert.equal(evidence.batch.items[0].report.findings[0].sha256,crypto.createHash('sha256').update('modified').digest('hex'));
    report.checks.push('Real downloaded evidence contains full fingerprint and workflow identity');
    await page.getByRole('button',{name:'Reverify selected tasks',exact:true}).click();
    await page.getByRole('dialog',{name:'Confirm delivery action',exact:true}).getByRole('button',{name:'Confirm action',exact:true}).click();
    await until(async()=>{const h=await batches(page);return h.batches.length===2&&h.batches.at(-1).status==='completed';});
    d=await page.evaluate(id=>window.relay.command('delivery.read',id),parent);assert.equal(d.staleEvidence,undefined);assert.equal(d.reports.length,2);
    await until(async()=> (await page.evaluate(()=>window.relay.snapshot())).jobs.find(j=>j.id===child).state==='waiting');
    await page.evaluate(id=>window.relay.command('job.control',{id,action:'pause'}),child);
    state=await page.evaluate(()=>window.relay.snapshot());assert.equal(state.jobs.find(j=>j.id===parent).state,'completed');assert.equal(state.accounts.length,0);
    report.checks.push('Explicit reacceptance creates new evidence and releases its own hold');
    await page.getByRole('button',{name:'New acceptance plan',exact:true}).click();
    const editor=page.getByRole('dialog',{name:'Edit acceptance plan',exact:true});await editor.getByLabel('Plan name',{exact:true}).fill('Artifact plan');await editor.getByLabel('Plan description',{exact:true}).fill('Reuse actual checks');
    await editor.getByRole('button',{name:'Save acceptance plan',exact:true}).click();await editor.waitFor({state:'hidden'});
    const plans=await page.evaluate(()=>window.relay.command('delivery.plans'));assert.equal(plans.items.length,1);assert.equal(plans.items[0].checks[0].path,'artifact.txt');
    await page.getByRole('button',{name:'Clear selection',exact:true}).click();await page.locator('.dc-task-list').getByLabel('Paused dependent',{exact:true}).check();
    await page.getByRole('button',{name:'Apply to selected tasks',exact:true}).click();
    await page.getByRole('dialog',{name:'Confirm delivery action',exact:true}).getByRole('button',{name:'Confirm action',exact:true}).click();
    await until(async()=> (await page.evaluate(id=>window.relay.command('delivery.read',id),child)).revision===1);
    state=await page.evaluate(()=>window.relay.snapshot());assert.equal(state.jobs.find(j=>j.id===child).prompt,'Preserve this user prompt');assert.equal(state.jobs.find(j=>j.id===child).state,'paused');
    await until(async()=>await page.locator('.dc-task-list').getByRole('button',{name:'Paused dependent',exact:true}).locator('..').locator('..').textContent().then(v=>v.includes('Checks: 1')));
    report.checks.push('Persisted plan applies checks without replacing prompt or pause intent');
    await page.locator('.delivery-center h1').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'delivery-center-native-light.png')});
    await app.close();app=undefined;page=await launch();await center(page);
    assert.equal((await page.evaluate(()=>window.relay.command('delivery.plans'))).items[0].name,'Artifact plan');
    const restored=await batches(page);assert.equal(restored.batches.length,2);assert.equal(restored.batches[0].items[0].comparison.status,'changed');assert.equal(restored.batches[1].items[0].status,'passed');
    report.checks.push('Restart preserves plan library, failed old evidence and accepted new evidence');
    assert.deepEqual(report.errors,[]);report.status='passed';
  }finally{await app?.close().catch(()=>{});await fs.writeFile(path.join(output,'delivery-center-native-report.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
