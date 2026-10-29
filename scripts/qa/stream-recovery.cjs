// Real daemon and renderer through a proxy that keeps broken streams open.
// Browser time advances only the recovery deadline; no external bot or model calls.
const {spawn}=require('node:child_process'),{once}=require('node:events');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'relay-stream-qa-'));
  const workspace=path.join(base,'project'),data=path.join(base,'data');await fs.mkdir(workspace);
  const child=spawn(process.execPath,['dist/server/main.cjs','--data-dir',data,'--ipc-port','0','--http-port','0','--workspace',workspace],{stdio:['ignore','pipe','pipe']});
  let browser,proxy,streams=0;
  try {
    const port=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(Error(output||'Daemon readiness timeout')),10000);
      child.stderr.on('data',d=>output+=d);child.on('exit',()=>{clearTimeout(timer);reject(Error(output));});
      child.stdout.on('data',d=>{output+=d;const found=output.match(/HTTP port: (\d+)/);if(found){clearTimeout(timer);resolve(Number(found[1]));}});
    });
    const token=await fs.readFile(path.join(data,'http-token'),'utf8');
    proxy=http.createServer((req,res)=>{
      const stream=req.url==='/api/events',number=stream?++streams:0;
      if(number===1)return; // Never sends headers, never closes the connection.
      const upstream=http.request({host:'127.0.0.1',port,path:req.url,method:req.method,headers:req.headers},result=>{
        res.writeHead(result.statusCode,result.headers);res.flushHeaders();
        if(number===2){let first=true;result.on('data',chunk=>{if(first){res.write(chunk);first=false;}});}
        else result.pipe(res);
      });
      upstream.on('error',()=>res.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
    });
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:process.env.RELAY_CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));await page.clock.install();
    await page.goto(`http://127.0.0.1:${proxy.address().port}`);
    await page.locator('.connect-card input').fill(token);await page.locator('.connect-card button').click();
    const observed=async expected=>{
      const until=Date.now()+5000;
      while(streams<expected&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(streams,expected,'Expected automatic status stream connection');
    };
    const reconnect=async()=>{
      await page.clock.fastForward(45001);
      await page.waitForFunction(()=>/重新连接|Reconnecting|再接続/.test(document.querySelector('.connection-bar')?.textContent||''));
      await page.clock.fastForward(1100);
    };
    await observed(1);await reconnect();await observed(2);
    await page.locator('.connection-bar.online').waitFor();
    const command=async(name,args)=>{
      const response=await fetch(`http://127.0.0.1:${port}/api/command`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name,args})});
      assert.equal(response.status,200);return (await response.json()).result;
    };
    await command('scheduler.dispatch',{paused:true});
    await command('job.submit',{requestId:randomUUID(),input:{title:'Visible after heartbeat recovery',prompt:'No model call',cwd:workspace,mode:'cli',model:'',effort:'',bucket:'codex',approvalPolicy:'on-request',sandbox:'workspaceWrite'}});
    assert.equal(await page.locator('.remote-task-list button').count(),0,'The stalled stream must not receive the new state');
    await reconnect();await observed(3);
    await page.locator('.remote-task-list button').filter({hasText:'Visible after heartbeat recovery'}).waitFor();
    assert.equal((await command('snapshot')).jobs.length,1,'Reconnection must not repeat task admission');
    assert.deepEqual(errors,[]);
    console.log('PASS: stalled response headers and silent open SSE bodies reconnect automatically; fresh daemon state arrives without replaying commands; zero model calls');
  } finally {
    await browser?.close();
    if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
    if(child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await stopped;clearTimeout(timer);}
    await fs.rm(base,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
