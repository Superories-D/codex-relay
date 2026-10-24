// Production renderer, synthetic request protocol; actual native scheduler and
// SQLite evidence are verified separately. No accounts, model or Telegram calls.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright'),{fixture}=require('./review-ui.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'qa-output');
function requestsFixture(){
  const oldSnapshot=window.relay.snapshot,oldCall=window.relay.command,id=crypto.randomUUID(),now=Date.now();
  const job={id,title:'Review ownership task',cwd:'D:\\Review',prompt:'Private prompt',state:'running',mode:'cli',rotations:0,createdAt:now,updatedAt:now};
  const state=window.opsQA={job,approvals:[{id:'same-id',jobId:id,reviewId:crypto.randomUUID(),kind:'command',method:'command',params:{command:'echo OLD REVIEW CONTEXT'}}],calls:[],reads:0};
  window.relay.snapshot=async()=>({...await oldSnapshot(),jobs:[job],approvals:structuredClone(state.approvals)});
  window.relay.onSnapshot=fn=>{state.emit=async()=>fn(await window.relay.snapshot());return()=>{};};
  window.relay.command=async(name,args)=>{
    if(name==='operations.read'){state.reads++;return{at:Date.now(),recording:{phase:'recording',pending:0,lastAt:now},cards:[{id,title:job.title,state:job.state,at:now,dispatchable:false,familyId:id,ready:false,gates:[],approvals:state.approvals.map(({id,reviewId,kind,responsePending})=>({id,reviewId,kind,responsePending})),pausedByUser:false,cancelledByUser:false,acceptance:'none'}]};}
    if(name==='operations.history')return{events:[]};if(name==='vault.references')return{matches:[],unreadable:[]};if(name==='telegram.read')return{receipts:[]};
    if(name==='operations.request'){const found=state.approvals.find(a=>a.id===args.id&&a.reviewId===args.reviewId);if(!found)throw Error('审批请求已更新，请重新查看');return structuredClone(found);}
    if(name==='approval.respond'){
      const found=state.approvals.find(a=>a.id===args.id&&a.reviewId===args.reviewId);if(!found)throw Error('审批请求已更新，请重新查看');state.calls.push({name,args});state.approvals=state.approvals.filter(a=>a!==found);await state.emit();return true;
    }return oldCall(name,args);
  };
}
(async()=>{
  const report={syntheticProtocol:true,modelRequests:0,externalBotMessages:0,errors:[],checks:[]};let browser,page;
  const server=http.createServer((req,res)=>{const base=path.join(root,'dist/renderer'),file=path.resolve(base,'.'+(req.url==='/'?'/index.html':req.url));if(!file.startsWith(base+path.sep))return res.writeHead(403).end();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).on('error',()=>res.end()).pipe(res);});
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({executablePath:process.env.RELAY_CHROMIUM_PATH,headless:true});const context=await browser.newContext({viewport:{width:1500,height:1050}});
    await context.addInitScript(fixture,{language:'en',theme:'light'});await context.addInitScript(requestsFixture);page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('.agent-shell').waitFor();
    await page.locator('.task-queue-button').click();await page.getByRole('button',{name:'Task operations',exact:true}).click();await page.locator('.ops-task').click();await page.getByRole('button',{name:'Review current request',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Review current request',exact:true});await dialog.locator('.approval pre').waitFor();assert.ok((await dialog.textContent()).includes('OLD REVIEW CONTEXT'));
    const old=await page.evaluate(()=>window.opsQA.approvals[0].reviewId);
    await page.evaluate(async()=>{const s=window.opsQA;s.approvals=[{...s.approvals[0],reviewId:crypto.randomUUID(),params:{command:'echo NEW REVIEW CONTEXT'}}];await s.emit();});
    await dialog.locator('[role=alert]').waitFor();assert.equal(await dialog.locator('fieldset').getAttribute('disabled'),'');assert.equal(await page.evaluate(()=>window.opsQA.calls.length),0);
    report.checks.push('An open review freezes the original request; a reused protocol ID disables stale actions without sending approval');
    await page.keyboard.press('Escape');await page.locator('.ops-header').getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Review current request',exact:true}).click();dialog=page.getByRole('dialog',{name:'Review current request',exact:true});await dialog.locator('.approval pre').waitFor();assert.ok((await dialog.textContent()).includes('NEW REVIEW CONTEXT'));
    await page.evaluate(()=>document.body.style.zoom='1.5');await dialog.evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});const bounds=await dialog.locator(':scope > .modal').evaluate(el=>{const r=el.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight};});assert.ok(bounds.left>=-2&&bounds.top>=-2&&bounds.right<=bounds.w+2&&bounds.bottom<=bounds.h+2);await page.screenshot({path:path.join(output,'operations-review-zoom.png')});
    await dialog.locator('.approval .row button').nth(1).click();await dialog.waitFor({state:'hidden'});const replied=await page.evaluate(()=>window.opsQA.calls[0].args);assert.notEqual(replied.reviewId,old);assert.equal(replied.value.decision,'decline');
    report.checks.push('A fresh review sends its exact identity and selected decision; 150% zoom stays inside the viewport');
    await page.evaluate(async()=>{const s=window.opsQA;s.approvals=[{id:'input-id',jobId:s.job.id,reviewId:crypto.randomUUID(),historyId:'question:'+crypto.randomUUID(),kind:'input',method:'input',params:{isBlocking:true,questions:[{id:'secret',header:'Private value',question:'Enter a private value',isSecret:true,isOther:false,options:null}]}}];await s.emit();});
    await page.locator('.ops-header').getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Review current request',exact:true}).click();dialog=page.getByRole('dialog',{name:'Review current request',exact:true});await dialog.locator('input[type=password]').fill('SYNTHETIC_PRIVATE_INPUT');assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('SYNTHETIC_PRIVATE_INPUT')),false);
    const reference=await page.evaluate(()=>({reviewId:window.opsQA.approvals[0].reviewId,historyId:window.opsQA.approvals[0].historyId}));await dialog.locator('button[type=submit]').click();await page.waitForFunction(()=>window.opsQA.calls.length===2);
    const answer=await page.evaluate(()=>window.opsQA.calls[1].args);assert.equal(answer.reviewId,reference.reviewId);assert.equal(answer.historyId,reference.historyId);assert.equal(answer.value.answers.secret.answers[0],'SYNTHETIC_PRIVATE_INPUT');
    report.checks.push('The existing secret question form preserves review/history identities and keeps its draft out of browser storage');assert.deepEqual(report.errors,[]);report.status='passed';
  }catch(e){report.status='failed';report.error=e.stack;if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'operations-review-failure.png')}).catch(()=>{});throw e;}
  finally{await browser?.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(output,'operations-review-ui-report.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
