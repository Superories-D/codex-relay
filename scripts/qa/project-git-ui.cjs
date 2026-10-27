// Production renderer + real Git + authenticated daemon; no model or Bot calls.
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {chromium}=require(process.env.RELAY_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'relay-project-ui-')),workspace=path.join(base,'project'),data=path.join(base,'data');await fs.mkdir(workspace);
  const git=(...args)=>execFileSync('git',['-C',workspace,...args],{stdio:'ignore'});
  git('init','-b','main');git('config','user.name','QA');git('config','user.email','qa@invalid.local');git('config','core.autocrlf','false');
  const file=path.join(workspace,'review 日本語.txt');await fs.writeFile(file,'base\n');git('add','-A');git('commit','-m','Base');await fs.writeFile(file,'staged\n');git('add','-A');
  await fs.writeFile(file,Array.from({length:6000},(_,index)=>`working ${index} 🙂 日本語\n`).join(''));await Promise.all(Array.from({length:25},(_,index)=>fs.writeFile(path.join(workspace,`new-${index}.txt`),'New file')));
  const indexBefore=await fs.readFile(path.join(workspace,'.git/index'));
  let browser,proxy,backendPort,publicUrl,child;
  try {
    if(process.env.RELAY_QA_HTTPS){
      const key=path.join(base,'proxy.key'),cert=path.join(base,'proxy.crt');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
      proxy=require('node:https').createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(req,res)=>{
        const upstream=require('node:http').request({host:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:req.headers},result=>{res.writeHead(result.statusCode,result.headers);result.pipe(res);});
        upstream.on('error',()=>res.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
      });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));publicUrl=`https://127.0.0.1:${proxy.address().port}`;
    }
    child=spawn(process.execPath,['dist/server/main.cjs','--data-dir',data,'--workspace',workspace,'--ipc-port','0','--http-port','0',...(publicUrl?['--http-origin',publicUrl]:[])],{stdio:['ignore','pipe','pipe']});
    backendPort=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(output||'Daemon startup timed out')),10000);child.stderr.on('data',bytes=>output+=bytes);child.once('exit',()=>{clearTimeout(timer);reject(Error(output));});child.stdout.on('data',bytes=>{output+=bytes;const found=output.match(/HTTP port: (\d+)/);if(found){clearTimeout(timer);resolve(Number(found[1]));}});});
    const token=await fs.readFile(path.join(data,'http-token'),'utf8'),url=publicUrl||`http://127.0.0.1:${backendPort}`;
    const command=async(name,args)=>{const response=await fetch(`http://127.0.0.1:${backendPort}/api/command`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name,args})});assert.equal(response.status,200);return(await response.json()).result;};
    const expected=await command('project.diff',{cwd:workspace,path:path.basename(file),staged:false});
    browser=await chromium.launch({executablePath:process.env.RELAY_CHROMIUM_PATH,headless:true,args:['--no-sandbox','--disable-gpu']});const errors=[];
    for(const [language,width,zoom] of [['en',1600,1.5],['zh-CN',390,1],['ja',900,1]]) {
      const context=await browser.newContext({viewport:{width,height:1000},ignoreHTTPSErrors:!!publicUrl,permissions:['clipboard-read','clipboard-write']}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
      if(process.env.RELAY_QA_FONT){
        await page.route('**/__qa_font.woff2',route=>route.fulfill({contentType:'font/woff2',body:require('node:fs').readFileSync(process.env.RELAY_QA_FONT)}));
        await page.route('**/app.css',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\n@font-face{font-family:RelayQA;src:url(/__qa_font.woff2)}body,input,button,select,textarea{font-family:RelayQA,sans-serif}pre,code{font-family:monospace,RelayQA}'});});
      }
      await page.addInitScript(language=>sessionStorage.setItem('relay.remote.language',language),language);await page.goto(url);
      await page.locator('.connect-card input').fill(token);await page.locator('.connect-card button').click();await page.locator('.connection-bar.online').waitFor();
      if(zoom!==1)await page.evaluate(zoom=>document.body.style.zoom=String(zoom),zoom);
      const panel=page.locator('.remote-repository');await panel.locator('summary').click();await panel.locator('form button').click();await page.waitForFunction(()=>document.querySelectorAll('.remote-git-files li').length===20);
      await panel.locator(':scope > .row button').last().click();assert.equal(await panel.locator('li').count(),6);await panel.locator(':scope > input').fill('review 日本語');
      const row=panel.locator('li');assert.equal(await row.count(),1);await row.locator('button').first().click();await page.locator('.remote-git-diff pre').waitFor();assert.match(await page.locator('.remote-git-diff pre').textContent(),/\+staged/);await page.locator('dialog[open] .modal-close').click();
      await row.locator('button').last().click();await page.locator('.remote-git-diff pre').waitFor();const chunks=[];
      for(let index=0;index<100;index++){const text=await page.locator('.remote-git-diff pre').textContent();assert.ok(text.length<=20000);chunks.push(text);const next=page.locator('.remote-git-pages button').last();if(await next.isDisabled())break;await next.click();}
      assert.equal(chunks.join(''),expected.text,'Paging must preserve every character and surrogate pair');await page.locator('.remote-git-diff .copy-button').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),expected.text,'Copy must retain the complete diff');
      const bounds=await page.locator('dialog[open] .modal').boundingBox();assert.ok(bounds.x>=-1&&bounds.y>=-1&&bounds.x+bounds.width<=width+1&&bounds.y+bounds.height<=1001,'Diff modal must fit its viewport and zoom');const refresh=await page.locator('.remote-git-diff > button').last().boundingBox();assert.ok(refresh.y>=bounds.y&&refresh.y+refresh.height<=bounds.y+bounds.height,'The refresh control must remain visible without scrolling the modal');
      await fs.mkdir('qa-output',{recursive:true});await page.screenshot({path:`qa-output/project-git-${language}-${width}.png`,animations:'disabled'});await page.locator('dialog[open] .modal-close').click();
      if(language==='en') {
        let release,ready,delivered;const held=new Promise(resolve=>release=resolve),started=new Promise(resolve=>ready=resolve),done=new Promise(resolve=>delivered=resolve);let hold=true;
        const slow=async route=>{const body=route.request().postDataJSON();if(hold&&body?.name==='project.changes'){hold=false;const response=await route.fetch();ready();await held;try{await route.fulfill({response});}catch{}delivered();}else await route.fallback();};await page.route('**/api/command',slow);
        await panel.locator('form button').click();await started;await panel.locator('form input').fill(data);release();await done;await page.waitForTimeout(100);assert.equal(await panel.locator('li').count(),0,'A late list response must not repopulate another directory');await page.unroute('**/api/command',slow);
        await panel.locator('form button').click();await panel.locator('[role=alert]').waitFor();assert.equal(await panel.locator('form input').inputValue(),data,'Rejected paths must remain editable');await panel.locator('form input').fill(workspace);await panel.locator('form button').click();await page.waitForFunction(()=>document.querySelectorAll('.remote-git-files li').length===20);await panel.locator(':scope > input').fill('review 日本語');
        let releaseDiff,readyDiff,deliveredDiff;const heldDiff=new Promise(resolve=>releaseDiff=resolve),startedDiff=new Promise(resolve=>readyDiff=resolve),doneDiff=new Promise(resolve=>deliveredDiff=resolve);let holdDiff=true;
        const slowDiff=async route=>{const body=route.request().postDataJSON();if(holdDiff&&body?.name==='project.diff'){holdDiff=false;const response=await route.fetch();readyDiff();await heldDiff;try{await route.fulfill({response});}catch{}deliveredDiff();}else await route.fallback();};await page.route('**/api/command',slowDiff);
        await panel.locator('li button').last().click();await startedDiff;await page.locator('dialog[open] .modal-close').click();releaseDiff();await doneDiff;await page.waitForTimeout(100);assert.equal(await page.locator('dialog[open]').count(),0,'Closing a pending read must prevent late modal reopening');await page.unroute('**/api/command',slowDiff);
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'No horizontal viewport overflow');await context.close();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(await fs.readFile(path.join(workspace,'.git/index')),indexBefore);await browser.close();browser=undefined;const exited=once(child,'exit');child.kill('SIGTERM');assert.equal((await exited)[0],0);
    console.log('PASS: real Git browser inspection in three languages, 390/900/1600px and 150% zoom; complete paged/copy diff, stale directory response and closed-dialog isolation; zero model/Bot calls');
  }finally{
    if(browser)await browser.close();if(child&&child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGKILL');await stopped.catch(()=>{});}if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}await fs.rm(base,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
