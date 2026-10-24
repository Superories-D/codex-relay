// Windows production UI with synthetic IPC. Native filesystem/scheduler proof is separate.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright'),{fixture}=require('./review-ui.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'qa-output');
function centerFixture(){
  const oldSnapshot=window.relay.snapshot,oldCommand=window.relay.command,now=Date.now();
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const check={kind:'file',path:'artifact.txt',label:'Artifact',minBytes:1};
  const proof=n=>({id:id(n+1000),revision:1,source:'manual',status:'passed',startedAt:now,finishedAt:now,findings:[{check,status:'passed',code:'verified',bytes:8,sha256:'a'.repeat(64),modifiedAt:now}]});
  const jobs=Array.from({length:40},(_,i)=>({id:id(i+1),title:`Delivery task ${i+1}`,prompt:'Preserve prompt',cwd:'D:\\Project',mode:'cli',model:'',effort:'',bucket:'codex',state:'completed',interactive:true,rotations:0,createdAt:now,updatedAt:now,approvalPolicy:'on-request',sandbox:'workspaceWrite',workflow:{id:id(900),title:'Fixture workflow',step:i+1,total:40,fingerprint:'qa'},delivery:{revision:1,checks:[check],reports:[proof(i+1)]}}));
  const state=window.dcQA={jobs,plans:{version:1,revision:0,items:[]},history:{version:1,revision:0,batches:[]},calls:[],failSave:true};
  window.relay.snapshot=async()=>({...await oldSnapshot(),jobs:structuredClone(jobs)});
  window.relay.onSnapshot=fn=>{window.dcSnapshot=fn;return()=>{};};
  const emit=async()=>window.dcSnapshot?.(await window.relay.snapshot());
  window.relay.command=async(name,args)=>{
    if(!name.startsWith('delivery.'))return oldCommand(name,args);
    state.calls.push({name,args});
    if(name==='delivery.plans')return structuredClone(state.plans);
    if(name==='delivery.batches')return structuredClone(state.history);
    if(name==='delivery.batch.start'){
      const b={id:id(2000+state.history.batches.length),mode:args.mode,status:'completed',createdAt:now,finishedAt:now,items:args.targets.map(target=>{
        const j=jobs.find(j=>j.id===target.id),baseline=j.delivery.reports.at(-1),report=structuredClone(baseline);report.id=id(3000+state.history.batches.length);report.findings[0].sha256='b'.repeat(64);
        if(args.mode==='inspect'){j.state='needs_attention';j.delivery.staleEvidence={reportId:baseline.id,at:now,reason:'changed'};}
        else{j.state='completed';j.delivery.reports.push(report);delete j.delivery.staleEvidence;}
        return{id:j.id,title:j.title,revision:1,status:args.mode==='inspect'?'failed':'passed',baselineId:baseline.id,comparison:{status:'changed',changedPaths:['artifact.txt']},report,workflow:j.workflow};
      })};state.history.batches.push(b);state.history.revision++;await emit();return structuredClone(b);
    }
    if(name==='delivery.batch.export')return{schemaVersion:1,batch:structuredClone(state.history.batches.find(b=>b.id===args))};
    if(name==='delivery.plan.save'){
      await new Promise(r=>setTimeout(r,100));if(state.failSave){state.failSave=false;throw Error('Synthetic plan save failure');}
      state.plans.revision++;const p={...args.plan,id:args.id||id(4000+state.plans.items.length),updatedAt:now};state.plans.items.push(p);return structuredClone(state.plans);
    }
    if(name==='delivery.plan.apply'){
      const p=state.plans.items.find(p=>p.id===args.planId);const results=args.targets.map(target=>{const j=jobs.find(j=>j.id===target.id);if(j.delivery.revision!==target.revision)return{id:j.id,applied:false,issue:'验收条件已更改，请刷新后重试。'};j.delivery.checks=structuredClone(p.checks);j.delivery.revision++;return{id:j.id,applied:true};});
      await emit();return{results};
    }
    if(name==='delivery.plan.remove'){state.plans.items=[];state.plans.revision++;return structuredClone(state.plans);}
    if(name==='delivery.read')return structuredClone(jobs.find(j=>j.id===args).delivery);
    return oldCommand(name,args);
  };
  localStorage.setItem('relay.lastChat',jobs[0].id);
}
(async()=>{
  const report={windowsOnly:true,syntheticIPC:true,inferenceTurns:0,externalBotMessages:0,layouts:[],errors:[]};let browser,debugPage;
  const server=http.createServer((req,res)=>{const dir=path.join(root,'dist/renderer'),file=path.resolve(dir,'.'+(req.url==='/'?'/index.html':req.url));if(!file.startsWith(dir+path.sep))return res.writeHead(403).end();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).on('error',()=>res.end()).pipe(res);});
  try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({executablePath:process.env.RELAY_CHROMIUM_PATH,headless:true});
    for(const [language,theme,width,zoom,title] of [['zh-CN','dark',1280,1,'交付中心'],['zh-TW','light',1100,1,'交付中心'],['en','light',1600,1.5,'Delivery center'],['ja','dark',1100,1,'成果物センター']]){
      const context=await browser.newContext({viewport:{width,height:1000}});await context.addInitScript(fixture,{language,theme});await context.addInitScript(centerFixture);const page=await context.newPage();debugPage=page;page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('.agent-shell').waitFor();await page.evaluate(z=>document.body.style.zoom=String(z),zoom);
      await page.locator('.task-queue-button').click();await page.locator('.task-center > header > button').nth(1).click();await page.locator('.delivery-center').waitFor();assert.equal(await page.locator('.delivery-center h1').textContent(),title);
      assert.equal(await page.locator('.dc-task-list article').count(),30);await page.locator('.dc-pages button').last().click();assert.equal(await page.locator('.dc-task-list article').count(),10);await page.locator('.dc-pages button').first().click();
      await page.getByLabel('Delivery task 1',{exact:true}).check();await page.locator('.delivery-center > .dc-toolbar button').nth(2).click();await page.locator('.dc-result [data-status=failed]').waitFor();
      const [download]=await Promise.all([page.waitForEvent('download'),page.locator('.dc-history .dc-toolbar > button').first().click()]);const file=path.join(output,`delivery-center-${language}-evidence.json`);await download.saveAs(file);assert.equal(JSON.parse(fs.readFileSync(file)).batch.items[0].report.findings[0].sha256,'b'.repeat(64));
      await page.locator('.delivery-center > .dc-toolbar button').nth(3).click();assert.equal(await page.locator('.dc-confirm').count(),1);await page.locator('.dc-confirm > button').first().click();await page.locator('.dc-result [data-status=passed]').waitFor();
      await page.locator('.dc-plans .dc-toolbar > button').first().click();const editor=page.locator('.dc-plan-editor');await editor.locator('input').fill('Reusable plan');await editor.locator('textarea').fill('Preserve this description');
      await editor.locator('button').first().click();await page.locator('.delivery-dialog').waitFor();await page.keyboard.press('Escape');await page.locator('.delivery-dialog').waitFor({state:'hidden'});assert.equal(await editor.locator('input').inputValue(),'Reusable plan');
      await editor.locator('button').last().click();await editor.locator('[role=alert]').waitFor();assert.equal(await editor.locator('input').inputValue(),'Reusable plan');assert.equal(await editor.locator('textarea').inputValue(),'Preserve this description');
      const modal=await page.locator('dialog[open] > .modal').evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight};});assert.ok(modal.x>=-2&&modal.y>=-2&&modal.right<=modal.w+2&&modal.bottom<=modal.h+2,'Dialog stays inside the actual zoomed viewport');
      await editor.locator('button').last().click();await editor.waitFor({state:'hidden'});assert.equal(await page.locator('.dc-plans select option').count(),2);
      await page.locator('.dc-plans .dc-toolbar > button').nth(2).click();
      const reviewedRevision=await page.evaluate(()=>window.dcQA.jobs[0].delivery.revision);
      await page.evaluate(async()=>{window.dcQA.jobs[0].delivery.revision++;window.dcSnapshot(await window.relay.snapshot());});
      await page.locator('.dc-confirm > button').first().click();await page.waitForFunction(()=>window.dcQA.calls.some(c=>c.name==='delivery.plan.apply'));
      assert.equal(await page.evaluate(()=>window.dcQA.calls.find(c=>c.name==='delivery.plan.apply').args.targets[0].revision),reviewedRevision,'Confirmation must retain the revision the user reviewed');
      assert.equal(await page.evaluate(()=>window.dcQA.jobs[0].delivery.revision),reviewedRevision+1,'A stale plan application must not overwrite the new contract');
      await page.locator('.dc-plans .dc-toolbar > button').nth(2).click();await page.locator('.dc-confirm > button').first().click();await page.waitForFunction(()=>window.dcQA.calls.filter(c=>c.name==='delivery.plan.apply').length===2);
      const bounds=await page.locator('.delivery-center').evaluate(el=>({overflow:el.scrollWidth>el.clientWidth+2}));assert.equal(bounds.overflow,false);
      await page.locator('.delivery-center h1').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`delivery-center-${language}-${theme}.png`)});
      await page.locator('.dc-plans .dc-toolbar > button').nth(3).click();await page.locator('.dc-confirm > button').first().click();await page.waitForFunction(()=>window.dcQA.plans.items.length===0);
      report.layouts.push({language,theme,width,zoom,status:'passed',pagination:true,draftRetained:true,reviewRevisionPreserved:true,download:true,bounded:!bounds.overflow});await context.close();
    }
    assert.deepEqual(report.errors,[]);report.status='passed';
  }finally{if(!report.status&&debugPage&&!debugPage.isClosed()){await debugPage.screenshot({path:path.join(output,'delivery-center-ui-failure.png')});report.modalMetrics=await debugPage.evaluate(()=>({viewport:[innerWidth,innerHeight,visualViewport?.height],elements:[...document.querySelectorAll('dialog,.modal,.dc-plan-editor,.dc-plan-editor button')].map(el=>({class:el.className,text:el.tagName==='BUTTON'?el.textContent:undefined,box:el.getBoundingClientRect().toJSON(),height:el.clientHeight,scroll:el.scrollHeight,top:el.scrollTop,zoom:getComputedStyle(el).zoom}))}));}await browser?.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(output,'delivery-center-ui-report.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
