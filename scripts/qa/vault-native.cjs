// Real Windows Electron + scheduler + independent files + ZIP64 pipeline.
// Isolated account-free profile; no inference, Telegram API or installed-app update.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const exec=require('node:util').promisify(require('node:child_process').execFile);
const {_electron}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'qa-output');
async function until(fn){const end=Date.now()+30000;while(!await fn()){if(Date.now()>end)throw Error('Native vault verification timed out');await new Promise(r=>setTimeout(r,150));}}
(async()=>{
  const profile=await fs.mkdtemp(path.join(output,'vault-native-')),cwd=path.join(profile,'project');await fs.mkdir(cwd);
  const artifact=path.join(cwd,'actual.txt'),nativeBytes=Buffer.concat([Buffer.from('native accepted bytes'),crypto.randomBytes(32*1024**2)]);await fs.writeFile(artifact,nativeBytes);
  const installed=JSON.parse(await fs.readFile(path.join(output,'cli-install-native-report.json'))),cli=JSON.parse(await fs.readFile(path.join(installed.fixture,'selected-cli.json'))).cli;
  const id=crypto.randomUUID(),now=Date.now();
  await fs.writeFile(path.join(profile,'state.json'),JSON.stringify({version:1,cursor:0,accounts:[],logs:[],settings:{cliPath:cli,resetWarmupEnabled:false},jobs:[{id,title:'Paused accepted task',prompt:'Preserve pause and user prompt',cwd,mode:'cli',state:'paused',stopIntent:'pause',model:'',effort:'',bucket:'codex',interactive:true,rotations:0,createdAt:now,updatedAt:now,approvalPolicy:'on-request',sandbox:'workspaceWrite',delivery:{revision:1,checks:[{kind:'file',path:'actual.txt',label:'Actual artifact',minBytes:1}],reports:[]}}]}));
  await fs.writeFile(path.join(profile,'desktop.json'),JSON.stringify({projects:[{id:'project',name:'Vault QA',cwd}],schedules:[],preferences:{theme:'light',language:'en',notifications:false,closeToTray:false}}));
  let app,page,vault;const report={profile,inferenceTurns:0,externalBotMessages:0,errors:[],checks:[],layouts:[]};
  const launch=async()=>{const env={...process.env,CODEX_RELAY_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;app=await _electron.launch({executablePath:process.env.RELAY_EXECUTABLE||path.join(root,'node_modules/electron/dist/electron.exe'),args:process.env.RELAY_EXECUTABLE?[]:[root],env,timeout:60000});app.process().stderr.on('data',data=>{report.stderr=(report.stderr||'').concat(data.toString()).slice(-8000);});page=await app.firstWindow();vault=page.locator('.delivery-vault');page.on('pageerror',e=>report.errors.push(e.message));await page.locator('.agent-shell').waitFor();};
  const state=()=>page.evaluate(()=>window.relay.command('vault.list'));
  const center=async()=>{await page.locator('.task-queue-button').click();await page.getByRole('button',{name:'Delivery center',exact:true}).click();await page.locator('.delivery-center').waitFor();};
  try {
    await launch();await page.evaluate(id=>window.relay.command('delivery.run',id),id);await center();
    await page.locator('.dc-task-list').getByLabel('Paused accepted task',{exact:true}).check();
    await page.getByRole('button',{name:'Save delivery version',exact:true}).click();await vault.locator('.vault-preview').waitFor();
    await vault.getByLabel('Delivery version name',{exact:true}).fill('Native Windows delivery');await vault.getByRole('button',{name:'Save complete version',exact:true}).click();
    await until(async()=>{const v=await state();if(v.issue)throw Error(v.issue);return !v.active&&v.entries[0]?.status==='ready';});const first=(await state()).entries[0];const folder=path.join(first.root,'versions',first.id);
    const manifest=JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8'));assert.equal(manifest.tasks[0].stateAtCapture,'paused');assert.deepEqual(await fs.readFile(path.join(folder,manifest.artifacts[0].path)),nativeBytes);
    const snap=await page.evaluate(()=>window.relay.snapshot());assert.equal(snap.jobs[0].state,'paused');assert.equal(snap.jobs[0].prompt,'Preserve pause and user prompt');assert.equal(snap.accounts.length,0);
    report.checks.push('Actual UI preview and save seal independent accepted bytes, retaining pause and user prompt');
    await fs.unlink(artifact);await until(async()=>await vault.locator(`[data-vault-id="${first.id}"]`).count()===1);let row=vault.locator(`[data-vault-id="${first.id}"]`);
    await row.getByRole('button',{name:'View version manifest',exact:true}).click();await vault.locator('.vault-detail').waitFor();assert.ok((await vault.locator('.vault-detail').textContent()).includes(first.manifestSha256));
    await row.getByRole('button',{name:'Verify complete version',exact:true}).click();await until(async()=>{const v=await state();return !v.active&&v.entries[0].verification.at>first.verification.at;});assert.equal((await state()).entries[0].verification.status,'passed');
    const destination=path.join(profile,'native-complete.zip');await app.evaluate(({dialog},destination)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:destination});},destination);
    await row.getByRole('button',{name:'Export complete delivery archive',exact:true}).click();await until(async()=>{const v=await state();return !v.active&&!!v.entries[0].lastExport;});
    const exported=(await state()).entries[0].lastExport,zip=await fs.readFile(destination);assert.equal(crypto.createHash('sha256').update(zip).digest('hex'),exported.sha256);assert.equal(exported.files,6);
    report.checks.push('Export through production native dialog command writes and fully rehashes a complete archive after source deletion');
    const secondDisk=path.join(profile,'second-storage');await fs.mkdir(secondDisk);await app.evaluate(({dialog},p)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[p]});},secondDisk);
    await vault.getByRole('button',{name:'Change location',exact:true}).click();await until(async()=> (await state()).storage!==first.root);assert.ok((await state()).roots.includes(first.root));assert.equal((await state()).entries[0].root,first.root);
    report.checks.push('Storage picker retains prior version location and full artifact bytes');
    for(const [language,theme,zoom,title] of [['zh-CN','dark',1,'交付保险库'],['zh-TW','light',1,'交付保險庫'],['en','light',1.5,'Delivery vault'],['ja','dark',1,'成果物保管庫']]) {
      await page.evaluate(p=>window.relay.command('desktop.preferences',p),{language,theme});await page.reload();await page.locator('.agent-shell').waitFor();await page.locator('.task-queue-button').click();await page.locator('.task-center > header > button').nth(1).click();await page.locator('.delivery-center > header .dc-toolbar button').first().click();await page.evaluate(z=>document.body.style.zoom=String(z),zoom);await until(async()=>await vault.locator('h2').textContent()===title);
      const metrics=await vault.evaluate(el=>{const modal=el.closest('.modal'),r=modal.getBoundingClientRect();return{right:r.right,bottom:r.bottom,left:r.left,top:r.top,w:innerWidth,h:innerHeight,overflow:el.scrollWidth>el.clientWidth+2};});
      assert.equal(metrics.overflow,false);assert.ok(metrics.left>=-2&&metrics.top>=-2&&metrics.right<=metrics.w+2&&metrics.bottom<=metrics.h+2,'Vault stays inside zoomed viewport');
      if(language==='en'||language==='ja')assert.ok(!/[\u3400-\u9fff]/.test((await vault.textContent()).replace(/Native Windows delivery|Paused accepted task|actual\.txt/g,''))||language==='ja','English vault contains no untranslated Chinese copy');
      await vault.evaluate(el=>{el.closest('.modal').scrollTop=0;});await page.screenshot({path:path.join(output,`vault-native-${language}.png`)});report.layouts.push({language,theme,zoom,bounded:true});
    }
    await page.evaluate(()=>window.relay.command('desktop.preferences',{language:'en',theme:'light'}));await page.reload();await page.locator('.agent-shell').waitFor();await center();await page.getByRole('button',{name:'Delivery vault',exact:true}).click();
    const crashDestination=path.join(profile,'interrupted-complete.zip');await app.evaluate(({dialog},p)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:p});},crashDestination);
    await vault.locator(`[data-vault-id="${first.id}"]`).getByRole('button',{name:'Export complete delivery archive',exact:true}).click();
    await until(async()=>!!(await state()).entries[0].exportAttempt?.temporary);
    const owned=app.process();assert.ok(owned.pid);await exec('taskkill.exe',['/PID',String(owned.pid),'/T','/F'],{windowsHide:true});app=undefined;
    await launch();await center();await page.getByRole('button',{name:'Delivery vault',exact:true}).click();await until(async()=>(await state()).entries[0].exportAttempt?.state==='interrupted');
    await vault.getByRole('button',{name:'Check interrupted export',exact:true}).click();await until(async()=>{const v=await state();return !v.active&&!v.entries[0].exportAttempt;});
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(destination)).digest('hex'),exported.sha256);assert.equal((await state()).entries[0].lastExport.sha256,exported.sha256);
    assert.equal((await fs.readdir(profile)).filter(n=>/^\.relay-vault-.*\.partial$|^vault-export-.*\.json$/.test(n)).length,0);
    report.checks.push('Forced crash of the owned Electron process tree leaves a durable interrupted export; native reconciliation removes only its temporary files and preserves prior ZIP');
    await fs.writeFile(path.join(folder,manifest.artifacts[0].path),'tampered stored file');row=vault.locator(`[data-vault-id="${first.id}"]`);await row.getByRole('button',{name:'Verify complete version',exact:true}).click();
    await until(async()=>{const v=await state();return !v.active&&v.entries[0].verification.status==='failed';});report.checks.push('Native verification detects stored artifact tampering without model or workspace access');
    await app.close();app=undefined;await launch();await center();await page.getByRole('button',{name:'Delivery vault',exact:true}).click();await page.locator('.delivery-vault .vault-entries article').waitFor();
    const restored=(await state()).entries[0];assert.equal(restored.verification.status,'failed');assert.equal(restored.lastExport.sha256,exported.sha256);assert.equal(restored.root,first.root);
    const restoredRow=page.locator(`[data-vault-id="${first.id}"]`);await restoredRow.getByRole('button',{name:'Delete version: Native Windows delivery',exact:true}).click();await page.getByRole('button',{name:'Confirm version deletion',exact:true}).click();await until(async()=>!(await state()).entries.length);
    assert.ok((await fs.stat(destination)).isFile());await assert.rejects(fs.stat(folder));report.checks.push('Restart preserves integrity history and export receipt; confirmed deletion removes only owned vault bytes');
    assert.deepEqual(report.errors,[]);report.status='passed';
  }catch(e){report.status='failed';report.error=e.stack;if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'vault-native-failure.png')}).catch(()=>{});throw e;}
  finally{await app?.close().catch(()=>{});await fs.writeFile(path.join(output,'vault-native-report.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
