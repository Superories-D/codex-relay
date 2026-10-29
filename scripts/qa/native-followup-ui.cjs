// Production desktop renderer with synthetic IPC; no native Windows process or model.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright');
const {fixture}=require('./review-ui.cjs'),{waitForBrowser}=require('./browser-wait.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'qa-output');
function followupFixture(){
 const selected=window.nativeSelectedBeforeFixture,command=window.relay.command;
 const first='38694b0b-675e-45ba-9828-6e579ac8ae54',second='50c8387a-3548-4dcc-8ef9-df3798296c61';
 const base={cwd:'D:\\Projects\\review',prompt:'Review',state:'completed',mode:'cli',model:'',effort:'',sandbox:'workspaceWrite',approvalPolicy:'on-request',bucket:'codex',rotations:0,interactive:true,createdAt:Date.now(),updatedAt:Date.now(),controlRevision:0};
 const state=()=>JSON.parse(localStorage.getItem('qa.native.backend'));
 const save=value=>localStorage.setItem('qa.native.backend',JSON.stringify(value));
 if(!state())save({jobs:[{...base,id:first,title:'First native task'},{...base,id:second,title:'Second native task'}],receipts:{},cancelled:{},inputs:[],transportOffline:false,unavailable:false,loseNext:true,identityFailures:1});
 const snapshot=async()=>({...await window.nativeBaseSnapshot(),jobs:state().jobs});
 window.nativeBaseSnapshot=window.relay.snapshot;window.relay.snapshot=snapshot;
 window.relay.onSnapshot=fn=>{window.nativeSnapshot=fn;return()=>{};};
 window.relay.command=async(name,args)=>{
  const value=state(),job=value.jobs.find(job=>job.id===args?.input?.id||job.id===args?.id);
  if(name==='chat.submission.identity'&&value.identityFailures){value.identityFailures--;save(value);throw Error('Synthetic startup IPC unavailable');}
  if(name==='chat.submit'||name==='chat.submission.cancel'){
   if(value.transportOffline)throw Error('Synthetic IPC unavailable');
   if(value.receipts[args.requestId])return {state:'accepted'};
   if(value.cancelled[args.requestId])return {state:'rejected',code:'cancelled',error:'待确认消息已取消，草稿已保留。'};
   if(job.controlRevision!==args.controlRevision)return {state:'rejected',code:'control',error:'任务控制状态已变化，原消息未投递，草稿已保留。'};
   if(name==='chat.submission.cancel'){value.cancelled[args.requestId]=true;save(value);return {state:'rejected',code:'cancelled',error:'待确认消息已取消，草稿已保留。'};}
   if(value.unavailable)return {state:'pending',error:'Synthetic ownership recovery'};
   value.receipts[args.requestId]=true;value.inputs.push(structuredClone(args));job.state='queued';
   if(value.loseNext){value.loseNext=false;value.transportOffline=true;save(value);throw Error('Synthetic lost IPC acknowledgement');}
   save(value);return {state:'accepted'};
  }
  if(name==='job.control'){job.controlRevision++;job.state=args.action==='cancel'?'cancelled':'paused';save(value);window.nativeSnapshot?.(await snapshot());return;}
  return command(name,args);
 };
 localStorage.setItem('relay.lastChat',[first,second].includes(selected)?selected:first);
}
(async()=>{
 fs.mkdirSync(output,{recursive:true});const report={syntheticIPC:true,nativeWindows:false,inferenceTurns:0,layouts:[],errors:[]};
 const server=http.createServer((req,res)=>{const folder=path.join(root,'dist/renderer'),file=path.resolve(folder,'.'+(req.url==='/'?'/index.html':req.url));if(!file.startsWith(folder+path.sep))return res.writeHead(403).end();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).on('error',()=>res.end()).pipe(res);});let browser,page,stage='start';
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({executablePath:process.env.RELAY_CHROMIUM_PATH,headless:true});
  for(const [language,width,zoom] of [['zh-CN',1280,1],['zh-TW',1100,1],['en',1600,1.5],['ja',1100,1]]){
   const context=await browser.newContext({viewport:{width,height:1000}});await context.addInitScript(()=>{window.nativeSelectedBeforeFixture=localStorage.getItem('relay.lastChat');});await context.addInitScript(fixture,{language,theme:'dark'});await context.addInitScript(followupFixture);
   page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('.agent-shell').waitFor();await page.evaluate(zoom=>{document.body.style.zoom=String(zoom);},zoom);
   const input=page.locator('textarea').first(),send=page.locator('.agent-send');await send.waitFor();stage=language+' initial submit';
   await input.fill('Original durable followup');await send.click();await page.locator('.native-followup-pending').waitFor();
   assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('qa.native.backend')).inputs.length),1);
   await input.fill('Later original draft');await page.locator('.agent-sidebar').getByText('Second native task',{exact:true}).click();await input.fill('Second-task draft');
   await waitForBrowser(page,()=>{const state=JSON.parse(localStorage.getItem('relay.composer.v2')||'null');return Object.values(state?.drafts||{}).includes('Second-task draft')&&Object.values(state?.drafts||{}).includes('Later original draft');});
   await page.evaluate(()=>{const state=JSON.parse(localStorage.getItem('qa.native.backend'));state.transportOffline=false;localStorage.setItem('qa.native.backend',JSON.stringify(state));});
   stage=language+' reload recovery';await page.reload();await page.locator('.agent-shell').waitFor();await page.evaluate(zoom=>{document.body.style.zoom=String(zoom);},zoom);
   await waitForBrowser(page,()=>JSON.parse(localStorage.getItem('relay.native.followups.v1')||'[]').length===0);assert.equal(await input.inputValue(),'Second-task draft');
   await page.locator('.agent-sidebar').getByText('First native task',{exact:true}).click();assert.equal(await input.inputValue(),'Later original draft');
   assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('qa.native.backend')).inputs.length),1);
   stage=language+' cancel unaccepted';await page.evaluate(()=>{const state=JSON.parse(localStorage.getItem('qa.native.backend'));state.unavailable=true;localStorage.setItem('qa.native.backend',JSON.stringify(state));});
   await input.fill('Cancellable draft');await send.click();await page.locator('.native-followup-pending').waitFor();
   await page.screenshot({path:path.join(output,`native-followup-pending-${language}.png`)});
   await page.locator('.native-followup-pending button').click();await page.locator('.native-followup-pending').waitFor({state:'hidden'});assert.equal(await input.inputValue(),'Cancellable draft');
   stage=language+' later stop';await input.fill('Do not override my later stop');await send.click();await page.locator('.native-followup-pending').waitFor();
   await page.evaluate(async()=>{await window.relay.command('job.control',{id:'38694b0b-675e-45ba-9828-6e579ac8ae54',action:'pause'});const state=JSON.parse(localStorage.getItem('qa.native.backend'));state.unavailable=false;localStorage.setItem('qa.native.backend',JSON.stringify(state));});
   await page.locator('.native-followup-pending').waitFor({state:'hidden'});assert.equal(await input.inputValue(),'Do not override my later stop');
   const backend=await page.evaluate(()=>JSON.parse(localStorage.getItem('qa.native.backend')));assert.equal(backend.inputs.length,1);assert.equal(backend.jobs[0].state,'paused');
   await page.screenshot({path:path.join(output,`native-followup-${language}.png`)});report.layouts.push({language,width,zoom,initializationRecovered:true,reloadRecovered:true,newerDraftsKept:true,cancellationPersisted:true,laterStopKept:true,acceptedInputs:backend.inputs.length});await context.close();
  }
  assert.deepEqual(report.errors,[]);report.status='passed';fs.writeFileSync(path.join(output,'native-followup-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }catch(error){report.status='failed';report.stage=stage;report.failure=String(error);fs.writeFileSync(path.join(output,'native-followup-report.json'),JSON.stringify(report,null,2));await page?.screenshot({path:path.join(output,'native-followup-failure.png')}).catch(()=>{});throw error;}
 finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
