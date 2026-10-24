// Actual Windows Electron, scheduler, SQLite worker and vault. Empty accounts,
// globally paused dispatch; no inference and no external Telegram requests.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'qa-output');
async function until(fn){const end=Date.now()+30000;while(!await fn()){if(Date.now()>end)throw Error('Native operations check timed out');await new Promise(r=>setTimeout(r,100));}}
(async()=>{
  const profile=await fs.mkdtemp(path.join(output,'operations-native-')),cwd=path.join(profile,'project');await fs.mkdir(cwd);await fs.writeFile(path.join(cwd,'actual.txt'),'accepted native bytes');
  const fixture=JSON.parse(await fs.readFile(path.join(output,'cli-install-native-report.json'))),cli=JSON.parse(await fs.readFile(path.join(fixture.fixture,'selected-cli.json'))).cli;
  const parent=crypto.randomUUID(),child=crypto.randomUUID(),paused=crypto.randomUUID(),workflow=crypto.randomUUID(),now=Date.now();
  const task=(id,title,state)=>({id,title,cwd,prompt:'DO NOT EXPORT THIS PROMPT',mode:'cli',model:'',effort:'',bucket:'codex',state,interactive:true,rotations:0,createdAt:now,updatedAt:now,approvalPolicy:'on-request',sandbox:'workspaceWrite'});
  const jobs=[{...task(parent,'Accepted predecessor','completed'),workflow:{id:workflow,title:'Native evidence workflow',step:1,total:2,fingerprint:'qa'},delivery:{revision:1,checks:[{kind:'file',path:'actual.txt',label:'Actual artifact',minBytes:1}],reports:[]}},
    {...task(child,'Held dependent','queued'),workflow:{id:workflow,title:'Native evidence workflow',step:2,total:2,fingerprint:'qa'},dependsOn:[parent]}, {...task(paused,'User paused task','paused'),stopIntent:'pause'},
    ...Array.from({length:32},(_,i)=>({...task(crypto.randomUUID(),`Native task ${i+1}`,'paused'),stopIntent:'pause'}))];
  await fs.writeFile(path.join(profile,'state.json'),JSON.stringify({version:1,cursor:0,logs:[],accounts:[],settings:{cliPath:cli,resetWarmupEnabled:false},dispatch:{paused:true,projects:[],updatedAt:now},jobs}));
  await fs.writeFile(path.join(profile,'desktop.json'),JSON.stringify({projects:[{id:'project',name:'Operations QA',cwd}],schedules:[],preferences:{language:'en',theme:'light',notifications:false,closeToTray:false}}));
  let app,page;const report={profile,modelRequests:0,externalBotMessages:0,checks:[],layouts:[],errors:[]};
  const launch=async()=>{const env={...process.env,CODEX_RELAY_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;app=await _electron.launch({executablePath:process.env.RELAY_EXECUTABLE||path.join(root,'node_modules/electron/dist/electron.exe'),args:process.env.RELAY_EXECUTABLE?[]:[root],env,timeout:60000});page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));await page.locator('.agent-shell').waitFor();};
  const call=(name,args)=>page.evaluate(({name,args})=>window.relay.command(name,args),{name,args});
  const cockpit=async()=>{await page.locator('.task-queue-button').click();await page.locator('.task-center > header > button').nth(2).click();await page.locator('.operations-center').waitFor();};
  try {
    await launch();assert.equal((await call('operations.read')).recording.phase,'recording');await call('delivery.run',parent);
    const preview=await call('vault.preview',[parent]);await call('vault.capture',{previewId:preview.id,title:'Stored native predecessor'});await until(async()=>!(await call('vault.list')).active);
    const saved=(await call('vault.list')).entries[0];assert.equal(saved.status,'ready');
    await fs.writeFile(path.join(cwd,'actual.txt'),'changed native bytes');await call('delivery.batch.start',{mode:'inspect',targets:[{id:parent,revision:1}]});await until(async()=> (await call('delivery.batches')).batches.at(-1).status==='completed');
    const cards=(await call('operations.read')).cards,dependent=cards.find(c=>c.id===child);assert.equal(dependent.ready,false);assert.ok(dependent.gates.some(g=>g.code==='dependencies'&&g.related.includes(parent)));assert.ok(dependent.gates.some(g=>g.code==='globalDispatch'));assert.ok(dependent.gates.some(g=>g.code==='accounts'));
    report.checks.push('Actual scheduler explains simultaneous dispatch, account and changed-prerequisite evidence holds');
    await cockpit();const center=page.locator('.operations-center');assert.equal(await center.locator('.ops-task').count(),30);await center.locator('.ops-queue .ops-pages button').last().click();assert.equal(await center.locator('.ops-task').count(),5);await center.locator('.ops-queue .ops-pages button').first().click();
    await center.locator(`[data-task-id="${child}"]`).click();await center.getByText('Prerequisites have not released admission',{exact:true}).waitFor();await center.locator('.ops-related').getByRole('button',{name:'Accepted predecessor',exact:false}).click();
    await center.getByRole('button',{name:'Workflow handoff report',exact:true}).click();await page.locator('.workflow-report strong').waitFor();assert.ok((await page.locator('.workflow-report strong').textContent()).includes('Native evidence workflow'));await page.keyboard.press('Escape');
    await center.locator('.ops-saved-reference button').waitFor();assert.equal(await center.locator('.ops-saved-reference code').textContent(),preview.tasks[0].report.id);
    await center.locator('.ops-saved-reference button').click();await page.locator('.delivery-vault .vault-detail').waitFor();assert.ok((await page.locator('.delivery-vault .vault-detail').textContent()).includes(saved.manifestSha256));await page.keyboard.press('Escape');
    report.checks.push('Native navigation opens exact saved manifest/report provenance despite later source changes');
    for(let i=0;i<13;i++){await call('job.control',{id:paused,action:'resume'});await call('job.control',{id:paused,action:'pause'});}
    await center.locator(`[data-task-id="${paused}"]`).click();await center.locator('.ops-history').getByRole('button',{name:'Refresh history',exact:true}).click();await until(async()=>await center.locator('.ops-timeline .ops-event').count()===40);
    const originalTop=await center.locator('.ops-timeline .ops-event').first().locator('small').last().textContent();await center.getByRole('button',{name:'Older records',exact:true}).click();await until(async()=>await center.locator('.ops-history .ops-pages span').textContent()==='2');
    await call('job.control',{id:paused,action:'resume'});await call('job.control',{id:paused,action:'pause'});await center.getByRole('button',{name:'Newer records',exact:true}).click();await until(async()=>await center.locator('.ops-history .ops-pages span').textContent()==='1');
    assert.equal(await center.locator('.ops-timeline .ops-event').first().locator('small').last().textContent(),originalTop);assert.equal((await call('snapshot')).accounts.length,0);
    report.checks.push('Durable native history paginates without cursor movement when new observations arrive');
    const database=path.join(profile,'operations.sqlite');
    await app.evaluate((_electron,file)=>{const {DatabaseSync}=process.getBuiltinModule('node:sqlite');const db=new DatabaseSync(file);try{db.exec("CREATE TRIGGER native_recording_failure BEFORE INSERT ON events WHEN NEW.kind='changed' BEGIN SELECT RAISE(ABORT,'native simulated storage failure'); END;");}finally{db.close();}},database);
    await call('job.control',{id:paused,action:'resume'});await call('job.control',{id:paused,action:'pause'});await until(async()=>(await call('operations.read')).recording.phase==='failed');await center.getByRole('button',{name:'Re-enable recording',exact:true}).waitFor();
    assert.equal((await call('snapshot')).jobs.find(j=>j.id===paused).stopIntent,'pause');
    await app.evaluate((_electron,file)=>{const {DatabaseSync}=process.getBuiltinModule('node:sqlite');const db=new DatabaseSync(file);try{db.exec('DROP TRIGGER native_recording_failure');}finally{db.close();}},database);
    await center.getByRole('button',{name:'Re-enable recording',exact:true}).click();await until(async()=>(await call('operations.read')).recording.phase==='recording');
    const recovered=await call('operations.history',{taskId:paused});assert.equal(recovered.events[0].kind,'baseline');assert.equal(recovered.events[0].current.state,'paused');
    report.checks.push('A real worker transaction failure pauses recording visibly without changing task intent; explicit UI retry creates a fresh durable baseline');
    for(const [language,theme,zoom,title] of [['zh-CN','dark',1,'任务运行台'],['zh-TW','light',1,'任務運行臺'],['en','light',1.5,'Task operations'],['ja','dark',1,'タスク運用']]){
      await call('desktop.preferences',{language,theme});await page.reload();await page.locator('.agent-shell').waitFor();await cockpit();await page.evaluate(z=>document.body.style.zoom=String(z),zoom);await center.locator(`[data-task-id="${child}"]`).click();
      const heading=await center.locator('h1').textContent();assert.equal(heading,title);
      if(language==='en')assert.equal(/[\u3400-\u9fff]/.test(await center.textContent()),false,'English operations UI must have no untranslated Chinese copy');
      const metrics=await center.evaluate(el=>({overflow:el.scrollWidth>el.clientWidth+2}));assert.equal(metrics.overflow,false);await center.locator(zoom>1?'.ops-detail':'h1').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`operations-native-${language}.png`)});report.layouts.push({language,theme,zoom,heading,bounded:true});
    }
    await call('desktop.preferences',{language:'en',theme:'light'});const before=(await call('operations.history',{taskId:paused})).ceiling;await app.close();app=undefined;await launch();await cockpit();await page.locator(`[data-task-id="${paused}"]`).click();
    const after=await call('operations.history',{taskId:paused});assert.ok(BigInt(after.ceiling)>BigInt(before));assert.equal(after.events[0].kind,'baseline');assert.equal(after.events[0].current.state,'paused');assert.equal((await call('snapshot')).jobs.find(j=>j.id===paused).stopIntent,'pause');
    assert.ok(!JSON.stringify(after).includes('DO NOT EXPORT THIS PROMPT'));report.checks.push('Restart preserves real history and user pause while recording a startup baseline rather than a fabricated completion');
    assert.deepEqual(report.errors,[]);report.status='passed';
  }catch(e){report.status='failed';report.error=e.stack;if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'operations-native-failure.png')}).catch(()=>{});throw e;}
  finally{await app?.close().catch(()=>{});await fs.writeFile(path.join(output,'operations-native-report.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
