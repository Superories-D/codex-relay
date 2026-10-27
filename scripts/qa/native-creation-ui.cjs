// Production desktop renderer, synthetic durable IPC; no native Windows or inference.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright');
const {fixture}=require('./review-ui.cjs'),{waitForBrowser}=require('./browser-wait.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'qa-output');
function creationFixture(){
 const selected=window.creationSelected,command=window.relay.command,cwd='D:\\Projects\\review';
 const existing='38694b0b-675e-45ba-9828-6e579ac8ae54',created='50c8387a-3548-4dcc-8ef9-df3798296c61';
 const base={cwd,prompt:'Original',state:'completed',mode:'cli',model:'',effort:'',sandbox:'workspaceWrite',approvalPolicy:'on-request',bucket:'codex',rotations:0,interactive:true,createdAt:Date.now(),updatedAt:Date.now()};
 const state=()=>JSON.parse(localStorage.getItem('qa.creation.backend')),save=value=>localStorage.setItem('qa.creation.backend',JSON.stringify(value));
 if(!state())save({jobs:[{...base,id:existing,title:'Existing native task'}],receipts:{},cancelled:{},inputs:[],offline:false,unavailable:false,loseNext:true});
 const original=window.relay.snapshot,snapshot=async()=>({...await original(),jobs:state().jobs});
 window.relay.snapshot=snapshot;window.relay.onSnapshot=fn=>{window.creationSnapshot=fn;return()=>{};};
 window.relay.command=async(name,args)=>{
   const value=state();
   if(name==='project.add'){
     value.projectAdds=(value.projectAdds||0)+1;save(value);
     if(window.creationHoldProject)await new Promise(resolve=>{window.creationReleaseProject=resolve;});
     return {};
   }
   if(name==='chat.creation.submit'||name==='chat.creation.cancel'){
     if(value.offline)throw Error('Synthetic lost IPC acknowledgement');
     if(value.receipts[args.requestId])return {state:'accepted',jobId:value.receipts[args.requestId]};
     if(value.cancelled[args.requestId])return {state:'rejected',code:'cancelled',error:'待确认创建已取消，草稿已保留。'};
     if(name==='chat.creation.cancel'){value.cancelled[args.requestId]=true;save(value);return {state:'rejected',code:'cancelled',error:'待确认创建已取消，草稿已保留。'};}
     if(value.unavailable)return {state:'pending',error:'Synthetic storage unavailable'};
     const id=value.inputs.length?crypto.randomUUID():created;
     value.inputs.push(structuredClone(args));value.receipts[args.requestId]=id;value.jobs.push({...base,...args.input,id,state:'queued'});
     if(value.loseNext){value.loseNext=false;value.offline=true;save(value);throw Error('Synthetic lost IPC acknowledgement');}
     save(value);window.creationSnapshot?.(await snapshot());return {state:'accepted',jobId:id};
   }
   if(name==='job.add')throw Error('Unreliable creation endpoint must not be used');
   return command(name,args);
 };
 localStorage.setItem('relay.project',cwd);if(selected)localStorage.setItem('relay.lastChat',selected);else localStorage.removeItem('relay.lastChat');
}
(async()=>{
 fs.mkdirSync(output,{recursive:true});const report={syntheticIPC:true,nativeWindows:false,inferenceTurns:0,layouts:[],errors:[]};let browser,page,stage='start';
 const server=http.createServer((req,res)=>{
   if(req.url==='/qa-font.woff2'&&process.env.RELAY_QA_FONT){res.setHeader('Content-Type','font/woff2');return fs.createReadStream(process.env.RELAY_QA_FONT).pipe(res);}
   const folder=path.join(root,'dist/renderer'),file=path.resolve(folder,'.'+(req.url==='/'?'/index.html':req.url));if(!file.startsWith(folder+path.sep))return res.writeHead(403).end();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).on('error',()=>res.end()).pipe(res);
 });
 try{
   await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({executablePath:process.env.RELAY_CHROMIUM_PATH,headless:true});
   for(const [language,width,zoom] of [['zh-CN',1280,1],['zh-TW',1100,1],['en',1600,1.5],['ja',1100,1]]){
     const context=await browser.newContext({viewport:{width:Math.round(width/zoom),height:Math.round(1000/zoom)},deviceScaleFactor:zoom});await context.addInitScript(()=>{window.creationSelected=localStorage.getItem('relay.lastChat');});await context.addInitScript(fixture,{language,theme:'dark'});await context.addInitScript(creationFixture);
     page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('.agent-shell').waitFor();
     const style=async()=>{if(process.env.RELAY_QA_FONT)await page.addStyleTag({content:"@font-face{font-family:RelayQA;src:url('/qa-font.woff2')}body,body *{font-family:RelayQA,Arial,sans-serif!important}"});await page.evaluate(()=>document.fonts.ready);};await style();
     const input=page.locator('textarea').first(),send=page.locator('.agent-send');stage=language+' lost creation reply';
     await input.fill('Original durable new task');
     await page.evaluate(()=>{window.creationHoldProject=true;const input=document.querySelector('textarea');for(let i=0;i<2;i++)input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
     await waitForBrowser(page,()=>typeof window.creationReleaseProject==='function');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('qa.creation.backend')).projectAdds),1);
     await page.evaluate(()=>{window.creationHoldProject=false;window.creationReleaseProject();});
     await page.locator('.native-creation-pending').waitFor();assert.equal(await send.isDisabled(),true);
     assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('qa.creation.backend')).inputs.length),1);
     await input.fill('New draft after lost creation');await page.screenshot({path:path.join(output,`native-creation-pending-${language}.png`)});
     stage=language+' task switch and reload';await page.locator('.agent-sidebar').getByText('Existing native task',{exact:true}).click();await input.fill('Keep existing-task draft');
     await waitForBrowser(page,()=>Object.values(JSON.parse(localStorage.getItem('relay.composer.v2')||'{}').drafts||{}).includes('Keep existing-task draft'));
     await page.evaluate(()=>{const state=JSON.parse(localStorage.getItem('qa.creation.backend'));state.offline=false;localStorage.setItem('qa.creation.backend',JSON.stringify(state));});
     await page.reload();await page.locator('.agent-shell').waitFor();await style();await waitForBrowser(page,()=>JSON.parse(localStorage.getItem('relay.native.creations.v1')||'[]').length===0);
     assert.equal(await input.inputValue(),'Keep existing-task draft');assert.equal(await page.evaluate(()=>localStorage.getItem('relay.lastChat')),'38694b0b-675e-45ba-9828-6e579ac8ae54');
     await page.locator('.agent-new').click();assert.equal(await input.inputValue(),'New draft after lost creation');await page.locator('.native-creation-result button').waitFor();
     assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('qa.creation.backend')).inputs.length),1);
     stage=language+' cancel an unaccepted creation';await page.evaluate(()=>{const state=JSON.parse(localStorage.getItem('qa.creation.backend'));state.unavailable=true;localStorage.setItem('qa.creation.backend',JSON.stringify(state));});
     await input.fill('Cancelled new-task draft');await send.click();await page.locator('.native-creation-pending').waitFor();await page.locator('.native-creation-pending button').click();await page.locator('.native-creation-pending').waitFor({state:'hidden'});assert.equal(await input.inputValue(),'Cancelled new-task draft');
     await page.evaluate(()=>{const state=JSON.parse(localStorage.getItem('qa.creation.backend'));state.unavailable=false;localStorage.setItem('qa.creation.backend',JSON.stringify(state));});
     stage=language+' immediate successful creation';await input.fill('Immediate new task');await send.click();await waitForBrowser(page,()=>JSON.parse(localStorage.getItem('qa.creation.backend')).inputs.length===2&&localStorage.getItem('relay.lastChat')!=='38694b0b-675e-45ba-9828-6e579ac8ae54');
     assert.equal(await input.inputValue(),'');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('qa.creation.backend')).jobs.length),3);
     const geometry=await page.evaluate(()=>{const send=document.querySelector('.agent-send').getBoundingClientRect();return {sendBottom:send.bottom,viewportHeight:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+2};});assert.equal(geometry.overflow,false);assert.ok(geometry.sendBottom<=geometry.viewportHeight);
     await page.screenshot({path:path.join(output,`native-creation-${language}.png`)});report.layouts.push({language,width,zoom,reloadRecovered:true,newerDraftsKept:true,selectionKept:true,cancellationPersisted:true,acceptedTasks:2,...geometry});await context.close();
   }
   assert.deepEqual(report.errors,[]);report.status='passed';fs.writeFileSync(path.join(output,'native-creation-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }catch(error){report.status='failed';report.stage=stage;report.failure=String(error);fs.writeFileSync(path.join(output,'native-creation-report.json'),JSON.stringify(report,null,2));await page?.screenshot({path:path.join(output,'native-creation-failure.png')}).catch(()=>{});throw error;}
 finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
