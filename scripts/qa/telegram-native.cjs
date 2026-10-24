// Real Windows Electron + safeStorage + production IPC/transport. All Bot API
// requests are redirected inside the isolated main process to a local emulator.
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {_electron} = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), output = path.join(root, 'qa-output');
const token = '123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF';
async function until(fn) {const deadline=Date.now()+25000; while(!await fn()) {if(Date.now()>deadline) throw Error('Telegram native check timed out'); await new Promise(r=>setTimeout(r,100));}}
(async()=>{
  await fs.mkdir(output,{recursive:true});
  const profile=await fs.mkdtemp(path.join(output,'telegram-native-')), workspace=path.join(profile,'workspace'); await fs.mkdir(workspace);
  const installed=JSON.parse(await fs.readFile(path.join(output,'cli-install-native-report.json')));
  const cliPath=JSON.parse(await fs.readFile(path.join(installed.fixture,'selected-cli.json'))).cli;
  const id=randomUUID(), now=Date.now();
  await fs.writeFile(path.join(profile,'state.json'),JSON.stringify({version:1,cursor:0,logs:[],accounts:[],settings:{cliPath,resetWarmupEnabled:false},jobs:[{
    id,title:'PRIVATE task name',prompt:'Never run: account-free QA',cwd:workspace,mode:'cli',model:'',effort:'',bucket:'codex',state:'completed',
    interactive:true,rotations:0,createdAt:now,updatedAt:now,approvalPolicy:'on-request',sandbox:'workspaceWrite',
  }]}));
  await fs.writeFile(path.join(profile,'desktop.json'),JSON.stringify({projects:[{id:'project',name:'Telegram QA',cwd:workspace}],schedules:[],preferences:{theme:'light',language:'en',notifications:false,closeToTray:false}}));
  let mode='normal'; const calls=[],sent=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}'), method=req.url.split('/').at(-1);
    calls.push({method,body});let reply;
    if(method==='getMe')reply={ok:true,result:{id:123456789,is_bot:true,username:'relay_test_bot'}};
    if(method==='getChat')reply={ok:true,result:{id:Number(body.chat_id),type:'private'}};
    if(method==='getWebhookInfo')reply={ok:true,result:{url:''}};
    if(method==='getUpdates')reply={ok:true,result:[{message:{chat:{id:123456,type:'private',first_name:'Local owner'}}}]};
    if(method==='sendMessage'){
      if(mode==='unknown'){req.socket.destroy();return;}
      sent.push(body);reply={ok:true,result:{message_id:sent.length}};
    }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(reply));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let app;const report={profile,emulatorOnly:true,externalBotMessages:0,inferenceTurns:0,errors:[],checks:[]};
  const launch=async()=>{
    const env={...process.env,CODEX_RELAY_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
    app=await _electron.launch({executablePath:process.env.RELAY_EXECUTABLE||path.join(root,'node_modules/electron/dist/electron.exe'),args:process.env.RELAY_EXECUTABLE?[]:[root],env,timeout:60000});
    // This QA-only hook never enters the shipped source or configuration.
    await app.evaluate(({net},local)=>{
      const nativeFetch=net.fetch.bind(net);
      net.fetch=(input,options)=>{
        const url=String(input);
        if(url.startsWith('https://api.telegram.org/'))return nativeFetch(local+new URL(url).pathname,options);
        return nativeFetch(input,options);
      };
    },origin);
    const page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));await page.locator('.agent-shell').waitFor();
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('.feature-nav').getByRole('button',{name:'Notifications',exact:true}).click();
    await page.locator('.telegram-fields').waitFor();return page;
  };
  try{
    let page=await launch(), panel=page.locator('.telegram-settings');
    assert.equal(calls.length,0,'No network before setup');
    await panel.getByLabel('Bot token',{exact:true}).fill(token);
    await panel.getByRole('button',{name:'Read recent chats',exact:true}).click();
    await panel.getByRole('button',{name:'Local owner · 123456',exact:true}).click();
    await panel.getByLabel('Enable automatic Telegram notifications',{exact:true}).check();
    await panel.getByRole('button',{name:'Verify and save',exact:true}).click();
    await until(async()=>await panel.getByLabel('Bot token',{exact:true}).inputValue()==='');
    let view=await page.evaluate(()=>window.relay.command('telegram.read'));
    assert.equal(view.enabled,true);assert.equal(view.revision,1);assert.ok(!JSON.stringify(view).includes(token));
    const encrypted=await fs.readFile(path.join(profile,'windows-telegram.enc'));
    assert.ok(!encrypted.includes(Buffer.from(token)));assert.ok(!encrypted.includes(Buffer.from('123456')));
    const decrypted=await app.evaluate(({safeStorage},bytes)=>{
      return JSON.parse(safeStorage.decryptString(Buffer.from(bytes))).token.length;
    },Array.from(encrypted));
    assert.equal(decrypted,token.length);report.checks.push('Windows system encryption and secret-free view');
    await panel.getByRole('button',{name:'Send test notification',exact:true}).click();
    await until(async()=> (await page.evaluate(()=>window.relay.command('telegram.read'))).receipts[0]?.status==='sent');
    assert.equal(sent.length,1);report.checks.push('Explicit test through production transport to local emulator');
    await page.evaluate(({id})=>window.relay.command('delivery.save',{id,revision:0,checks:[{kind:'file',path:'missing.zip',label:'Expected artifact',minBytes:1}]}),{id});
    await until(async()=>sent.length===2);
    assert.match(sent[1].text,/Task needs attention/);assert.ok(!sent[1].text.includes('PRIVATE'));assert.ok(!sent[1].text.includes(workspace));
    report.checks.push('Real scheduler delivery hold generates private notification');
    mode='unknown';await panel.getByRole('button',{name:'Send test notification',exact:true}).click();
    await until(async()=> (await page.evaluate(()=>window.relay.command('telegram.read'))).receipts[0]?.status==='uncertain');
    // Disable before restart: even an unusually slow test hook cannot call a real Bot API.
    view=await page.evaluate(()=>window.relay.command('telegram.read'));
    await page.evaluate(v=>window.relay.command('telegram.save',{revision:v.revision,chatId:v.chatId,enabled:false,includeTitles:false,events:v.events}),view);
    await panel.getByRole('button',{name:'Refresh configuration',exact:true}).click();
    await panel.locator('h2').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output,'telegram-native-light.png')});
    await app.close();app=undefined;
    const requests=calls.length;page=await launch();panel=page.locator('.telegram-settings');
    view=await page.evaluate(()=>window.relay.command('telegram.read'));
    assert.equal(view.enabled,false);assert.equal(view.receipts.filter(r=>r.status==='uncertain').length,1);
    await new Promise(r=>setTimeout(r,1200));assert.equal(calls.length,requests,'No blind retry after restart');
    assert.equal(await panel.getByLabel('Bot token',{exact:true}).inputValue(),'');
    assert.ok(await panel.getByLabel('Bot token',{exact:true}).getAttribute('placeholder'));
    await panel.getByRole('button',{name:'Retry notification',exact:true}).click();
    assert.equal(await panel.locator('.telegram-confirm').count(),1);assert.equal(calls.length,requests);
    mode='normal';await panel.getByRole('button',{name:'Retry anyway',exact:true}).click();
    await until(async()=> (await page.evaluate(()=>window.relay.command('telegram.read'))).receipts[0]?.status==='sent');
    assert.equal(sent.length,3);report.checks.push('Restart retains encrypted connection and requires explicit unknown-result retry');
    assert.equal(calls.filter(c=>c.method==='getUpdates').length,1);assert.deepEqual(calls.find(c=>c.method==='getUpdates').body,{timeout:0,limit:100});
    assert.deepEqual(report.errors,[]);report.status='passed';
  } finally {
    await app?.close().catch(()=>{});await new Promise(r=>server.close(r));
    await fs.writeFile(path.join(output,'telegram-native-report.json'),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
