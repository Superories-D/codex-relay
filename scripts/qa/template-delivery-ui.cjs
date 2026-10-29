// Production Windows renderer with synthetic IPC; no native execution or inference.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright'),{fixture}=require('./review-ui.cjs');
const root=path.resolve(__dirname,'../..');
function templatesFixture(){
  const command=window.relay.command,snapshot=window.relay.snapshot;
  window.templateQA={version:1,revision:0,items:[]};window.templateWrites=[];window.templateSubmissions=[];window.templateCalls=[];window.templateJobs=[];
  window.relay.snapshot=async()=>{const data=await snapshot();data.jobs.push(...structuredClone(window.templateJobs));return data;};
  window.relay.onSnapshot=fn=>{window.templateSnapshot=fn;return()=>{};};
  window.relay.command=async(name,args)=>{
    window.templateCalls.push({name,args});
    if(name==='cli.status')return {phase:'ready'};
    if(name==='templates.list')return structuredClone(window.templateQA);
    if(name==='templates.save'){
      window.templateWrites.push(structuredClone(args));window.templateQA.revision++;
      window.templateQA.items=[{...structuredClone(args.template),id:'fixture-template',updatedAt:Date.now()}];return structuredClone(window.templateQA);
    }
    if(name==='choose.directory')return 'D:\\Projects\\review';
    if(name==='job.add'){
      window.templateSubmissions.push(structuredClone(args));
      const {deliveryChecks,...input}=args,job={...input,id:'created-template-task',state:'queued',rotations:0,createdAt:Date.now(),updatedAt:Date.now(),delivery:{revision:1,checks:deliveryChecks,reports:[]}};
      window.templateJobs.push(job);window.templateSnapshot?.(await window.relay.snapshot());return job;
    }
    return command(name,args);
  };
}
(async()=>{
  const server=http.createServer((req,res)=>{
    const folder=path.join(root,'dist/renderer'),file=path.resolve(folder,'.'+(req.url==='/'?'/index.html':req.url));
    if(!file.startsWith(folder+path.sep))return res.writeHead(403).end();
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).on('error',()=>res.end()).pipe(res);
  });let browser;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({executablePath:process.env.RELAY_CHROMIUM_PATH,headless:true});
    const errors=[];
    for(const [language,width,zoom,label] of [['en',1600,1.5,'Delivery acceptance'],['zh-CN',1100,1,'交付验收'],['ja',1000,1,'成果物の検証']]){
      const context=await browser.newContext({viewport:{width,height:1000}});await context.addInitScript(fixture,{language,theme:'dark'});await context.addInitScript(templatesFixture);
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('.agent-shell').waitFor();await page.evaluate(value=>document.body.style.zoom=String(value),zoom);
      await page.locator('.template-trigger').click();const panel=page.locator('.task-templates');
      await panel.locator('form input').fill('Verified output');await panel.locator('form textarea').fill('Produce verified output');
      await panel.locator('form > button[type=button]').first().click();
      await page.locator('.delivery-dialog .delivery-actions > button').first().click();await page.locator('.delivery-check input').nth(1).fill('report.txt');await page.locator('.delivery-dialog .delivery-actions > button').last().click();
      await panel.locator('form button[type=submit]').click();await panel.locator('.template-list article').waitFor();
      assert.equal(await page.evaluate(()=>window.templateWrites[0].template.deliveryChecks[0].path),'report.txt');
      await panel.locator('.queue-actions button').first().click();await panel.waitFor({state:'detached'});
      assert.equal(await page.evaluate(()=>window.templateCalls.filter(call=>call.name==='delivery.save').length),0,'Applying a template to an existing chat must not edit its contract');
      await page.locator('.agent-new').click();await page.locator('.template-trigger').click();await panel.locator('.template-list article').waitFor();await panel.locator('.queue-actions button').first().click();await panel.waitFor({state:'detached'});
      await page.locator('.composer-attach-control > button').first().click();await page.getByRole('menuitem',{name:label,exact:true}).click();
      await page.locator('.delivery-check').waitFor();assert.equal(await page.locator('.delivery-check input').nth(1).inputValue(),'report.txt');await page.keyboard.press('Escape');await page.locator('.delivery-dialog').waitFor({state:'detached'});
      await page.locator('.agent-send').click();await page.waitForFunction(()=>window.templateSubmissions.length===1);
      assert.equal(await page.evaluate(()=>window.templateSubmissions[0].deliveryChecks[0].path),'report.txt');
      await context.close();
    }
    assert.deepEqual(errors,[]);console.log('PASS: native renderer template checks save/apply/submit, existing-chat isolation, three languages and 150% zoom; synthetic IPC; zero model calls');
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
