// Production Windows renderer, synthetic IPC. No external Bot API or inference.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright');
const {fixture}=require('./review-ui.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'qa-output');
function telegramFixture(){
  const command=window.relay.command;
  window.tgQA={revision:0,configured:false,enabled:false,includeTitles:false,events:['completed','attention','approval'],chatId:'',receipts:[]};
  window.tgFail=true;window.tgCalls=[];window.tgReadActive=0;window.tgReadMax=0;
  window.relay.onSnapshot=fn=>{window.tgSnapshot=fn;return()=>{};};
  window.relay.command=async(name,args)=>{
    if(!name.startsWith('telegram.'))return command(name,args);
    window.tgCalls.push({name,args});const s=window.tgQA;
    if(name==='telegram.read'){
      const copy=structuredClone(s);window.tgReadActive++;window.tgReadMax=Math.max(window.tgReadMax,window.tgReadActive);
      try{if(window.tgHoldRead)await new Promise(resolve=>{window.tgReleaseRead=()=>{window.tgHoldRead=false;resolve();};});return copy;}finally{window.tgReadActive--;}
    }
    if(name==='telegram.discover')return[{id:'123456',name:'Local owner'}];
    if(name==='telegram.save'){
      await new Promise(r=>setTimeout(r,100));
      if(window.tgFail){window.tgFail=false;throw Error('Synthetic connection failure');}
      Object.assign(s,{revision:s.revision+1,configured:true,enabled:args.enabled,includeTitles:args.includeTitles,chatId:args.chatId,events:args.events,bot:{id:123456789,username:'relay_test_bot'}});
      return structuredClone(s);
    }
    if(name==='telegram.test')s.receipts.unshift({id:'test-1',event:'test',text:'Codex Relay\nTest',status:'uncertain',createdAt:Date.now(),updatedAt:Date.now(),dueAt:Date.now(),attempts:1,issue:'发送结果未知，请先查看 Telegram，再决定是否重试。'});
    if(name==='telegram.receipt'){s.receipts[0].status=args.action==='retry'?'sent':'cancelled';}
    if(name==='telegram.forget'){Object.assign(s,{revision:s.revision+1,configured:false,enabled:false,chatId:'',bot:undefined,receipts:[]});}
    return structuredClone(s);
  };
}
(async()=>{
  fs.mkdirSync(output,{recursive:true});const report={windowsOnly:true,syntheticIPC:true,externalBotMessages:0,inferenceTurns:0,layouts:[],errors:[]};
  const server=http.createServer((req,res)=>{
    const folder=path.join(root,'dist/renderer'),file=path.resolve(folder,'.'+(req.url==='/'?'/index.html':req.url));
    if(!file.startsWith(folder+path.sep))return res.writeHead(403).end();
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
    fs.createReadStream(file).on('error',()=>res.end()).pipe(res);
  });let browser;
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({executablePath:process.env.RELAY_CHROMIUM_PATH,headless:true});
    for(const [language,theme,width,zoom] of [['zh-CN','dark',1280,1],['zh-TW','light',1100,1],['en','light',1600,1.5],['ja','dark',1100,1]]){
      const context=await browser.newContext({viewport:{width,height:1000}});await context.addInitScript(fixture,{language,theme});await context.addInitScript(telegramFixture);
      const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('.agent-shell').waitFor();
      await page.evaluate(z=>{document.body.style.zoom=String(z);},zoom);
      await page.locator('.agent-brand > div > button').first().click();
      const p=page.locator('.telegram-settings');await p.locator('.telegram-fields').waitFor();
      const secret='123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF',inputs=p.locator('input:not([type=checkbox])');
      assert.equal(await inputs.first().getAttribute('type'),'password');await inputs.first().fill(secret);
      await p.locator('.telegram-connect-actions button').first().click();await p.getByRole('button',{name:'Local owner · 123456',exact:true}).click();
      assert.equal(await inputs.nth(1).inputValue(),'123456');await p.locator('.telegram-fields > .telegram-check').first().locator('input').check();
      await page.evaluate(async()=>window.tgSnapshot(await window.relay.snapshot()));
      await page.waitForTimeout(2200);assert.equal(await inputs.first().inputValue(),secret,'Refresh/parent render must preserve unsaved token');
      await p.locator('.telegram-actions > button').first().click();await p.locator('[role=alert]').waitFor();
      assert.equal(await inputs.first().inputValue(),secret,'Failed verification must preserve token');
      await p.locator('.telegram-actions > button').first().click();await page.waitForFunction(()=>window.tgQA.revision===1);
      await page.waitForFunction(()=>document.querySelector('.telegram-fields input')?.value==='');
      assert.equal(await p.locator('.telegram-actions > button').nth(1).isEnabled(),true);
      if(language==='en'){
        await page.evaluate(()=>{window.tgHoldRead=true;});await page.waitForFunction(()=>!!window.tgReleaseRead);
        await page.waitForTimeout(4200);assert.equal(await page.evaluate(()=>window.tgReadMax),1,'Slow polling must not overlap reads');
      }
      await p.locator('.telegram-actions > button').nth(1).click();await p.locator('.telegram-receipt.is-uncertain').waitFor();
      if(language==='en'){
        await page.evaluate(async()=>{window.tgReleaseRead();await new Promise(resolve=>setTimeout(resolve,40));});
        assert.equal(await p.locator('.telegram-receipt.is-uncertain').count(),1,'A stale poll must not erase a newly queued receipt');
      }

      await p.locator('.telegram-receipt > button').first().click();assert.equal(await p.locator('.telegram-confirm').count(),1);
      assert.equal(await page.evaluate(()=>window.tgCalls.filter(c=>c.name==='telegram.receipt').length),0,'Unknown result requires explicit confirmation');
      await p.locator('.telegram-confirm > button').last().click();
      const bounds=await p.evaluate(el=>({overflow:el.scrollWidth>el.clientWidth+2,width:el.clientWidth}));assert.equal(bounds.overflow,false);
      await p.locator('h2').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output,`telegram-${language}-${theme}.png`)});
      await p.locator('.telegram-receipt > button').first().click();await p.locator('.telegram-confirm > button').first().click();
      await p.locator('.telegram-receipt.is-sent').waitFor();
      if(language==='en'){
        await page.evaluate(()=>{window.tgQA.receipts=Array.from({length:85},(_,i)=>({id:'history-'+i,event:'test',text:i===84?'Archived searchable notification':'Notification '+i,status:i===84?'uncertain':'sent',createdAt:Date.now()-i*1000,updatedAt:Date.now(),dueAt:Date.now(),attempts:1}));});
        await p.locator('.telegram-actions > button').nth(2).click();await page.waitForFunction(()=>document.querySelectorAll('.telegram-receipt').length===20);
        await p.locator('.telegram-history-tools input').fill('Archived searchable');assert.equal(await p.locator('.telegram-receipt').count(),1);
        await p.locator('.telegram-history-tools input').fill('');await p.locator('.telegram-history-tools select').selectOption('unresolved');assert.equal(await p.locator('.telegram-receipt.is-uncertain').count(),1);
        await p.locator('.telegram-history-tools select').selectOption('all');await p.locator('.telegram-history-pages button').last().click();
        assert.match(await p.locator('.telegram-receipt pre').first().textContent(),/Notification 20/);assert.equal(await p.locator('.telegram-receipt').count(),20);
      }

      await p.locator('.telegram-remove').click();await p.locator('.telegram-confirm > button').first().click();
      await page.waitForFunction(()=>!window.tgQA.configured);assert.equal(await inputs.first().inputValue(),'');
      report.layouts.push({language,theme,width,zoom,status:'passed',bounded:!bounds.overflow,draftPreserved:true,unknownRetryConfirmed:true});await context.close();
    }
    assert.deepEqual(report.errors,[]);report.status='passed';
  }finally{await browser?.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(output,'telegram-ui-report.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
