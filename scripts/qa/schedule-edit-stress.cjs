const {waitForBrowser}=require('./browser-wait.cjs');
// Repeated real-browser edits with delayed acknowledgments and a second client.
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomUUID}=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'relay-schedule-stress-')),workspace=path.join(base,'project'),data=path.join(base,'data');await fs.mkdir(workspace);
  const child=spawn(process.execPath,['dist/server/main.cjs','--data-dir',data,'--workspace',workspace,'--ipc-port','0','--http-port','0'],{stdio:['ignore','pipe','pipe']});
  let browser;const trace=[];
  try {
    const port=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(output||'Daemon startup timeout')),10000);child.stderr.on('data',bytes=>output+=bytes);child.once('exit',()=>{clearTimeout(timer);reject(Error(output));});child.stdout.on('data',bytes=>{output+=bytes;const found=output.match(/HTTP port: (\d+)/);if(found){clearTimeout(timer);resolve(Number(found[1]));}});});
    const token=await fs.readFile(path.join(data,'http-token'),'utf8'),url=`http://127.0.0.1:${port}`;
    const call=async(name,args)=>{const response=await fetch(url+'/api/command',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name,args})});const body=await response.json();assert.equal(response.status,200,body.error);return body.result;};
    browser=await chromium.launch({executablePath:process.env.RELAY_CHROMIUM_PATH,headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(()=>sessionStorage.setItem('relay.remote.language','en'));
    let delayed=0;
    await page.route('**/api/command',async route=>{
      const body=route.request().postDataJSON();if(body?.name!=='schedule.save')return route.continue();
      const entry={id:body.args.id,requestId:body.args.requestId,revision:body.args.input.revision};trace.push(entry);
      const response=await route.fetch(),result=await response.json();Object.assign(entry,{state:result.result?.state,error:result.result?.error,resultRevision:result.result?.result?.revision});
      await new Promise(resolve=>setTimeout(resolve,++delayed%3*20));await route.fulfill({response});
    });
    await page.goto(url);await page.locator('.connect-card input').fill(token);await page.locator('.connect-card button').click();await page.locator('.connection-bar.online').waitFor();const panel=page.locator('.remote-schedules');await panel.locator('summary').click();
    const trials=Math.max(1,Math.min(60,Number(process.env.RELAY_QA_TRIALS)||20));
    for(let trial=0;trial<trials;trial++) {
      const id=randomUUID(),title=`Stress plan ${trial}`;
      const created=await call('schedule.create',{requestId:randomUUID(),id,input:{title,prompt:'Repeated edits without inference',cwd:workspace,enabled:false,cadence:'interval',minutes:60,hour:0,minute:0,weekday:0,worktree:false,deliveryChecks:[]}});assert.equal(created.state,'succeeded',created.error);
      await panel.getByRole('button',{name:'Refresh',exact:true}).click();const article=panel.locator('article').filter({hasText:title});await article.getByRole('button',{name:'Edit',exact:true}).click();
      for(const revision of [2,3]) {
        await panel.getByRole('button',{name:'Save changes',exact:true}).click();
        await waitForBrowser(page,async({id,revision})=>{const response=await fetch('/api/command',{method:'POST',headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},body:JSON.stringify({name:'schedule.list'})});const data=await response.json();return data.result.tasks.find(task=>task.id===id)?.revision===revision&&!sessionStorage.getItem('relay.remote.action.schedules.schedules');},{id,revision});
      }
      const task=(await call('schedule.list')).tasks.find(task=>task.id===id),fields=['title','prompt','cwd','enabled','cadence','minutes','hour','minute','weekday','worktree','deliveryChecks','revision'],input=Object.fromEntries(fields.map(key=>[key,task[key]]));
      trace.push({external:true,id,observedRevision:task.revision});
      const external=await call('schedule.save',{requestId:randomUUID(),id,input:{...input,prompt:'Another client edit'}});
      if(external.state!=='succeeded'){
        const current=(await call('schedule.list')).tasks.find(task=>task.id===id),pending=await page.evaluate(()=>sessionStorage.getItem('relay.remote.action.schedules.schedules'));
        trace.push({conflict:true,id,inputRevision:input.revision,currentRevision:current?.revision,pending:pending&&JSON.parse(pending)});
      }
      assert.equal(external.state,'succeeded',JSON.stringify({trial,error:external.error,trace:trace.slice(-12)}));assert.equal(external.result.revision,4);
      const removed=await call('schedule.remove',{requestId:randomUUID(),id});assert.equal(removed.state,'succeeded',removed.error);
    }
    assert.deepEqual(errors,[]);assert.equal((await call('snapshot')).jobs.length,0);await fs.mkdir('qa-output',{recursive:true});await fs.writeFile('qa-output/schedule-edit-stress.json',JSON.stringify({status:'passed',trials,requests:trace},null,2));console.log(`PASS: ${trials} plans, ${trials*2} rapid browser saves with delayed acknowledgments and ${trials} second-client edits; no inference`);
    await browser.close();browser=undefined;const exited=once(child,'exit');child.kill('SIGTERM');assert.equal((await exited)[0],0);
  }catch(error){await fs.mkdir('qa-output',{recursive:true});await fs.writeFile('qa-output/schedule-edit-stress.json',JSON.stringify({status:'failed',requests:trace},null,2));throw error;}
  finally{if(browser)await browser.close();if(child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGKILL');await stopped.catch(()=>{});}await fs.rm(base,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
