// Built web UI -> authenticated HTTP -> real daemon. No accounts/model calls.
const { spawn,execFileSync } = require("node:child_process"),
  { once } = require("node:events");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { chromium } = require(
  process.env.RELAY_PLAYWRIGHT_MODULE || "playwright",
);
(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "relay-remote-ui-")),
    data = path.join(base, "data"),
    workspace = path.join(base, "project");
  await fs.mkdir(workspace);
  let proxy,publicUrl,backendPort;
  if(process.env.RELAY_QA_HTTPS){
    const key=path.join(base,"proxy.key"),cert=path.join(base,"proxy.crt");
    execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=localhost"],{stdio:"ignore"});
    proxy=require("node:https").createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(req,res)=>{
      if(!backendPort){res.writeHead(503).end();return;}
      const upstream=require("node:http").request({host:"127.0.0.1",port:backendPort,path:req.url,method:req.method,headers:req.headers},result=>{res.writeHead(result.statusCode,result.headers);result.pipe(res);});
      upstream.on("error",()=>res.destroy());res.on("close",()=>upstream.destroy());req.pipe(upstream);
    });
    await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve));publicUrl=`https://127.0.0.1:${proxy.address().port}`;
  }
  const child = spawn(
    process.execPath,
    [
      "dist/server/main.cjs",
      "--data-dir",
      data,
      "--ipc-port",
      "0",
      "--http-port",
      "0",
      "--workspace",
      workspace,
      ...(publicUrl?["--http-origin",publicUrl]:[]),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(Error(output || "start timeout")),
        10000,
      );
      child.stderr.on("data", (d) => (output += d));
      child.on("exit", () => {
        clearTimeout(timer);
        reject(Error(output));
      });
      child.stdout.on("data", (d) => {
        output += d;
        const m = output.match(/HTTP port: (\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
    });
    backendPort=port;
    const token = await fs.readFile(path.join(data, "http-token"), "utf8");
    browser = await chromium.launch({
      executablePath: process.env.RELAY_CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    await fs.mkdir("qa-output", { recursive: true });
    const errors = [];
    for (const [language, width] of [
      ["en", 1280],
      ["zh-CN", 390],
      ["ja", 900],
    ]) {
      const context = await browser.newContext({
          viewport: { width, height: 900 },
          ignoreHTTPSErrors:!!publicUrl,
        }),
        page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      if (language === "en") {
        let droppedUpload=false;
        await page.route("**/api/uploads/**",async route=>{if(!droppedUpload && route.request().method()==="POST"){droppedUpload=true;await route.fetch();await route.abort();}else await route.continue();});
        let droppedStream = false,
          droppedSubmit = false,
          droppedMessage = false, droppedWorkflow = false, droppedSchedule=false, droppedRetry=false, droppedDeliverySave=false, droppedDeliveryRun=false;
        await page.route("**/api/events", async (route) => {
          if (!droppedStream) {
            droppedStream = true;
            await route.abort();
          } else await route.continue();
        });
        await page.route("**/api/command", async (route) => {
          if(!droppedDeliverySave && route.request().postDataJSON()?.name === "delivery.save") {droppedDeliverySave=true;await route.fetch();await route.abort();return;}
          if(!droppedDeliveryRun && route.request().postDataJSON()?.name === "delivery.run") {droppedDeliveryRun=true;await route.fetch();await route.abort();return;}
          if(!droppedRetry && route.request().postDataJSON()?.name === "workflow.retry") {droppedRetry=true;await route.fetch();await route.abort();return;}

          if(!droppedSchedule && route.request().postDataJSON()?.name === "schedule.create") {droppedSchedule=true;await route.fetch();await route.abort();return;}

          if (!droppedWorkflow && route.request().postDataJSON()?.name === "workflow.add") {
            droppedWorkflow=true;await route.fetch();await route.abort();return;
          }
          if (
            !droppedMessage &&
            route.request().postDataJSON()?.name === "chat.submit"
          ) {
            droppedMessage = true;
            await route.fetch();
            await route.abort();
            return;
          }
          if (
            !droppedSubmit &&
            route.request().postDataJSON()?.name === "job.submit"
          ) {
            droppedSubmit = true;
            await route.fetch();
            await route.abort();
          } else await route.continue();
        });
      }
      await page.addInitScript(
        (lang) => sessionStorage.setItem("relay.remote.language", lang),
        language,
      );
      if (process.env.RELAY_QA_FONT) {
        await page.route("**/__qa_font.woff2", async (route) =>
          route.fulfill({
            contentType: "font/woff2",
            body: await fs.readFile(process.env.RELAY_QA_FONT),
          }),
        );
        await page.route("**/app.css", async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            body:
              (await response.text()) +
              "\n@font-face{font-family:RelayQA;src:url(/__qa_font.woff2)}body{font-family:RelayQA,system-ui,sans-serif}",
          });
        });
      }
      await page.goto(publicUrl||`http://127.0.0.1:${port}`);
      await page.locator(".connect-card input").fill(token);
      await page.locator(".connect-card button").click();
      await page.locator(".connection-bar.online").waitFor();
      await page.locator(".new-task textarea").fill(`Remote QA ${language}`);
      if (language === "en") {
        await page.locator('.new-task').getByRole('button',{name:'Task templates',exact:true}).click();
        const templates=page.locator('.task-templates');
        await templates.locator('form input').fill('Verified output template');
        await templates.locator('form textarea').fill('Template verification instructions');
        await templates.getByRole('button',{name:/^Delivery acceptance/}).click();
        await page.locator('.delivery-dialog .delivery-actions > button').first().click();
        await page.locator('.delivery-check input').nth(1).fill('template-output.txt');
        await page.locator('.delivery-dialog .delivery-actions > button').last().click();
        await templates.getByRole('button',{name:'Save template',exact:true}).click();
        await templates.locator('.template-list article').getByRole('button',{name:'Insert into draft',exact:true}).click();
        await page.locator('.new-task').getByRole('button',{name:'Delivery acceptance · 1',exact:true}).waitFor();
        await page.locator('.new-task input[type=file]').setInputFiles({name:"evidence.txt",mimeType:"text/plain",buffer:Buffer.from("Evidence document")});
        await page.locator('.new-task .remote-attachments span').filter({hasText:"upload-evidence.txt"}).waitFor();
        await page.reload();await page.locator(".connection-bar.online").waitFor();
        await page.locator('.new-task').getByRole('button',{name:'Delivery acceptance · 1',exact:true}).waitFor();
        await page.locator('.new-task .remote-attachments span').filter({hasText:"upload-evidence.txt"}).waitFor();
        await page.evaluate(() => {
          window.__qaSetItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key === "relay.remote.pending")
              throw new DOMException("QA storage full", "QuotaExceededError");
            return window.__qaSetItem.call(this, key, value);
          };
        });
        await page.locator(".new-task button[type=submit]").click();
        await page
          .getByText("QA storage full", { exact: false })
          .first()
          .waitFor();
        const count = await page.evaluate(async () => {
          const r = await fetch("/api/snapshot", {
            headers: {
              Authorization: `Bearer ${sessionStorage.getItem("relay.remote.token")}`,
            },
          });
          return (await r.json()).jobs.length;
        });
        assert.equal(count, 0, "storage failure must prevent task submission");
        await page.evaluate(() => {
          Storage.prototype.setItem = window.__qaSetItem;
        });
      }
      await page.locator(".new-task button[type=submit]").click();
      await page.waitForFunction(
        (text) =>
          document.querySelector(".conversation-header h1")?.textContent ===
          text,
        `Remote QA ${language}`,
      );
      await page.locator(".remote-messages article").waitFor();
      if(language === "en") {
        const checks=await page.evaluate(async()=>{const r=await fetch('/api/snapshot',{headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`}});return(await r.json()).jobs.find(j=>j.title==='Remote QA en').delivery.checks;});assert.equal(checks[0].path,'template-output.txt');
        await page.locator('.new-task').getByRole('button',{name:'Delivery acceptance · 0',exact:true}).waitFor();
        await page.locator(".remote-artifacts summary").click();
        await page.locator(".remote-artifacts").getByText("upload-evidence.txt",{exact:false}).waitFor();
        await page.locator(".remote-artifacts").getByRole("button",{name:"Preview",exact:true}).click();
        await page.locator(".remote-artifacts pre").getByText("Evidence document",{exact:true}).waitFor();
        const artifactDownload=page.waitForEvent("download");await page.locator(".remote-artifacts").getByRole("button",{name:"Download",exact:true}).click();assert.equal((await artifactDownload).suggestedFilename(),"upload-evidence.txt");
      }

      if(language === "en") {
        await page.locator(".remote-schedules summary").click();
        const panel=page.locator(".remote-schedules");
        let releaseList,readyList,heldList=true,listCalls=0;
        const holdList=new Promise(resolve=>releaseList=resolve),listReady=new Promise(resolve=>readyList=resolve);
        const slowList=async route=>{
          if(route.request().postDataJSON()?.name==='schedule.list'){
            listCalls++;
            if(heldList){heldList=false;const response=await route.fetch();readyList();await holdList;await route.fulfill({response});return;}
          }
          await route.fallback();
        };
        await page.route('**/api/command',slowList);await panel.getByRole('button',{name:'Refresh',exact:true}).click();await listReady;
        await panel.getByRole('button',{name:'Refresh',exact:true}).click();await panel.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForTimeout(100);assert.equal(listCalls,1,'Slow schedule refreshes must coalesce');
        await panel.locator('form input').first().fill("Remote scheduled QA");
        await panel.locator('form select').first().selectOption(workspace);
        await panel.locator('form textarea').fill("Scheduled QA without model calls");
        await panel.locator('form input[type=checkbox]').first().uncheck();
        await panel.getByRole("button",{name:/^Delivery checks for each run/}).click();
        await page.locator(".delivery-dialog").getByRole("button",{name:"Add check",exact:true}).click();
        await page.locator(".delivery-check input").nth(1).fill("report.txt");
        await page.locator(".delivery-dialog").getByRole("button",{name:"Save acceptance checks",exact:true}).click();
        await panel.getByRole("button",{name:"Create schedule",exact:true}).click();
        await panel.getByText('Operation acknowledged',{exact:true}).waitFor();releaseList();
        await panel.getByRole("heading",{name:"Remote scheduled QA",exact:true}).waitFor();
        await page.unroute('**/api/command',slowList);
        await page.reload();await page.locator(".connection-bar.online").waitFor();
        await page.locator(".remote-schedules summary").click();
        await panel.getByRole("heading",{name:"Remote scheduled QA",exact:true}).waitFor();
        assert.equal(await panel.locator("article").count(),1,"lost schedule acknowledgment must not duplicate schedules");
        const contract=await page.evaluate(async()=>{const r=await fetch('/api/command',{method:'POST',headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},body:JSON.stringify({name:'schedule.list'})});return(await r.json()).result.tasks[0].deliveryChecks;});assert.equal(contract[0].path,'report.txt');
        await panel.locator('article').getByRole('button',{name:'Edit',exact:true}).click();
        for(const revision of [2,3]){
          await panel.getByRole('button',{name:'Save changes',exact:true}).click();
          await page.waitForFunction(async revision=>{
            const r=await fetch('/api/command',{method:'POST',headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},body:JSON.stringify({name:'schedule.list'})});
            return(await r.json()).result.tasks[0].revision===revision&&!sessionStorage.getItem('relay.remote.action.schedules.schedules');
          },revision);
        }
        const external=await page.evaluate(async()=>{
          const command=async(name,args)=>{const r=await fetch('/api/command',{method:'POST',headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},body:JSON.stringify({name,args})});return(await r.json()).result;};
          const task=(await command('schedule.list')).tasks[0],fields=['title','prompt','cwd','enabled','cadence','minutes','hour','minute','weekday','worktree','deliveryChecks','revision'];
          const input=Object.fromEntries(fields.map(key=>[key,task[key]]));input.prompt='Changed by another client';input.deliveryChecks=[{kind:'file',path:'changed-plan.txt',label:'New contract',minBytes:1}];
          return command('schedule.save',{requestId:crypto.randomUUID(),id:task.id,input});
        });assert.equal(external.state,'succeeded',external.error||JSON.stringify(external));assert.equal(external.result.revision,4);
        await panel.getByRole('button',{name:'Save changes',exact:true}).click();
        await panel.getByText('This schedule changed. Reopen it before saving.',{exact:true}).waitFor();
        const retained=await page.evaluate(async()=>{const r=await fetch('/api/command',{method:'POST',headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},body:JSON.stringify({name:'schedule.list'})});return(await r.json()).result.tasks[0];});assert.equal(retained.revision,4);assert.equal(retained.prompt,'Changed by another client');assert.equal(retained.deliveryChecks[0].path,'changed-plan.txt');
        await page.evaluate(async()=>{
          const command=async(name,args)=>{const r=await fetch('/api/command',{method:'POST',headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},body:JSON.stringify({name,args})});return(await r.json()).result;};
          const task=(await command('schedule.list')).tasks[0],fields=['title','prompt','cwd','enabled','cadence','minutes','hour','minute','weekday','worktree','deliveryChecks','revision'];
          const input=Object.fromEntries(fields.map(key=>[key,task[key]]));input.worktree=true;
          const saved=await command('schedule.save',{requestId:crypto.randomUUID(),id:task.id,input});if(saved.state!=='succeeded')throw Error('Could not prepare invalid Git fixture');
        });
        await panel.locator('article').getByRole('button',{name:'Run now',exact:true}).click();
        await panel.locator('.schedule-pending > button').waitFor();await panel.locator('.schedule-pending > button').click();
        const pendingRun=await page.evaluate(async()=>{const r=await fetch('/api/command',{method:'POST',headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},body:JSON.stringify({name:'schedule.list'})});return(await r.json()).result.tasks[0].pendingRun;});
        assert.equal(pendingRun.input.prompt,'Changed by another client');
        await page.setViewportSize({width:390,height:900});const pendingBounds=await page.locator('dialog[open]').boundingBox();assert.ok(pendingBounds.x>=0&&pendingBounds.x+pendingBounds.width<=391,'Pending-run preview fits a phone viewport');await page.screenshot({path:'qa-output/schedule-pending-remote-390.png',animations:'disabled'});await page.setViewportSize({width:1280,height:900});
        const preserved=path.join(data,'worktrees',pendingRun.id,'operator-note.txt');await fs.mkdir(path.dirname(preserved),{recursive:true});await fs.writeFile(preserved,'Preserve prepared files');
        await page.getByRole('button',{name:'Abandon pending admission',exact:true}).click();
        assert.equal(await page.getByRole('button',{name:'Confirm abandonment',exact:true}).count(),1);
        await page.getByRole('button',{name:'Confirm abandonment',exact:true}).click();
        await panel.getByText('Pending admission abandoned; the schedule continues as configured.',{exact:true}).waitFor();
        await panel.locator('.schedule-pending').waitFor({state:'detached'});assert.equal(await fs.readFile(preserved,'utf8'),'Preserve prepared files');
        await page.locator(".remote-task-list button").filter({hasText:"Remote QA en"}).click();
        await page.locator(".remote-schedules summary").click();
      }

      let controlAttempts=[],controlDropped,lostControl,controlJobId;
      if(language==='en') {
        lostControl=new Promise(resolve=>controlDropped=resolve);
        await page.route('**/api/command',async route=>{
          const body=route.request().postDataJSON();
          if(body?.name!=='task.control')return route.fallback();
          controlJobId=body.args.id;controlAttempts.push(body.args.requestId);const response=await route.fetch();
          if(controlAttempts.length===1){await route.fulfill({status:503,json:{error:'Acknowledgment lost after accepted control'}});controlDropped();}
          else await route.fulfill({response});
        });
      }
      await page.locator(".remote-task-management").getByRole("button",{name:/^(Pause|暂停|一時停止)$/}).click();
      await page.waitForFunction(async (title) => {
        const response = await fetch("/api/snapshot", {
          headers: {
            Authorization: `Bearer ${sessionStorage.getItem("relay.remote.token")}`,
          },
        });
        const snap = await response.json();
        return snap.jobs.find((j) => j.title === title)?.state === "paused";
      }, `Remote QA ${language}`);
      if(language==='en') {
        await lostControl;
        const other=await page.evaluate(async workspace=>{
          const headers={Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'};
          const response=await fetch('/api/command',{method:'POST',headers,body:JSON.stringify({name:'job.submit',args:{requestId:crypto.randomUUID(),input:{title:'Background receipt task',prompt:'No model call',cwd:workspace,mode:'cli',model:'',effort:'',bucket:'codex',approvalPolicy:'on-request',sandbox:'workspaceWrite',interactive:true}}})});const body=await response.json();if(!response.ok)throw Error(body.error);
          const paused=await fetch('/api/command',{method:'POST',headers,body:JSON.stringify({name:'job.control',args:{id:body.result.id,action:'pause'}})});if(!paused.ok)throw Error(await paused.text());return body.result.id;
        },workspace);
        assert.match(other,/^[a-f0-9-]{36}$/);
        await page.locator('.remote-task-list button').filter({hasText:'Background receipt task'}).click();
        await page.reload();await page.locator('.connection-bar.online').waitFor();
        await page.waitForFunction(id=>!sessionStorage.getItem(`relay.remote.action.management.${id}`),controlJobId);
        assert.equal(await page.locator('.conversation-header h1').innerText(),'Background receipt task','The original action must recover while a different task remains selected');
        await page.locator('.remote-task-list button').filter({hasText:'Remote QA en'}).click();
        await page.locator('.remote-task-management').getByText('Operation acknowledged',{exact:true}).waitFor();
        assert.ok(controlAttempts.length>=2);assert.equal(new Set(controlAttempts).size,1,'Reload must recover the original control request');
        const revision=await page.evaluate(async()=>{const r=await fetch('/api/snapshot',{headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`}});return(await r.json()).jobs.find(job=>job.title==='Remote QA en').controlRevision;});
        assert.equal(revision,1,'An acknowledged pause must execute only once');
        await page.evaluate(async id=>{const response=await fetch('/api/command',{method:'POST',headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},body:JSON.stringify({name:'job.metadata',args:{id,archived:true}})});if(!response.ok)throw Error(await response.text());},other);
        await page.waitForFunction(async id=>{const response=await fetch('/api/snapshot',{headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`}});return(await response.json()).jobs.find(job=>job.id===id)?.archived===true;},other);
      }
      await page.waitForFunction(
        () =>
          !document.querySelector(".conversation-header .row button")?.disabled,
      );
      await page.waitForFunction(() =>
        /Paused|已暂停|一時停止/.test(
          document.querySelector(".state-pill")?.textContent || "",
        ),
      );
      {
        const delivery=page.locator('.remote-delivery'),file=`accept-${language}.txt`;
        const revision=language==='en'?2:1;
        const waitDelivery=(revision,count,status)=>page.waitForFunction(async({title,revision,count,status})=>{
          const snap=await(await fetch('/api/snapshot',{headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`}})).json();
          const job=snap.jobs.find(j=>j.title===title),d=job?.delivery;
          return d?.revision===revision && d.reports.length===count && (!status||d.reports.at(-1)?.status===status) && !sessionStorage.getItem(`relay.remote.action.delivery.${job.id}`);
        },{title:`Remote QA ${language}`,revision,count,status});
        await delivery.locator('summary').click();
        await delivery.locator('.delivery-actions > button').nth(0).click();
        while(await page.locator('.delivery-dialog .delivery-check').count())await page.locator('.delivery-dialog .delivery-remove').first().click();
        await page.locator('.delivery-dialog .delivery-actions > button').first().click();
        await page.locator('.delivery-check input').nth(1).fill(file);
        if(language==='en'){
          await page.evaluate(()=>{window.deliverySetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('relay.remote.action.delivery.'))throw Error('simulated receipt storage full');return window.deliverySetItem.call(this,key,value);};});
          await page.locator('.delivery-dialog .delivery-actions > button').last().click();
          await page.locator('.delivery-dialog [role=alert]').waitFor();
          assert.equal(await page.locator('.delivery-check input').nth(1).inputValue(),file,'storage failure must retain check editor');
          await page.evaluate(()=>Storage.prototype.setItem=window.deliverySetItem);
        }
        await page.locator('.delivery-dialog .delivery-actions > button').last().click();
        if(language==='en'){
          await page.waitForFunction(()=>Object.keys(sessionStorage).some(k=>k.startsWith('relay.remote.action.delivery.')));
          await page.reload();await page.locator('.connection-bar.online').waitFor();
          await page.locator('.remote-task-list button').filter({hasText:`Remote QA ${language}`}).click();
          await delivery.locator('summary').click();
        }
        await waitDelivery(revision,0);
        await delivery.locator('.delivery-actions > button').nth(1).click();
        if(language==='en'){
          await page.waitForFunction(()=>Object.keys(sessionStorage).some(k=>k.startsWith('relay.remote.action.delivery.')));
          await page.reload();await page.locator('.connection-bar.online').waitFor();
          await page.locator('.remote-task-list button').filter({hasText:`Remote QA ${language}`}).click();
          await delivery.locator('summary').click();
        }
        await waitDelivery(revision,1,'failed');
        await delivery.locator('.delivery-actions > button').nth(2).click();
        await page.waitForFunction(()=>document.querySelector('.remote-followup textarea')?.value.includes('客户端直接检查文件'));
        assert.equal(await page.locator('.remote-messages article').count(),1,'preparing a repair must not submit a message');
        await fs.writeFile(path.join(workspace,file),'accepted output');
        await delivery.locator('.delivery-actions > button').nth(1).click();
        await waitDelivery(revision,2,'passed');
        await delivery.locator('.delivery-results code').filter({hasText:'SHA256'}).waitFor();
      }
      if(language==='en'){
        const other=await page.evaluate(async workspace=>{
          const command=async(name,args)=>{const r=await fetch('/api/command',{method:'POST',headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},body:JSON.stringify({name,args})});return(await r.json()).result;};
          const job=await command('job.submit',{requestId:crypto.randomUUID(),input:{title:'Attachment isolation target',prompt:'No model call',cwd:workspace,mode:'cli',model:'',effort:'',bucket:'codex',approvalPolicy:'on-request',sandbox:'workspaceWrite'}});
          await command('job.control',{id:job.id,action:'pause'});return job.id;
        },workspace);
        let release,accepted,delivered;
        const held=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>accepted=resolve),done=new Promise(resolve=>delivered=resolve);
        await page.route('**/api/uploads/**',async route=>{
          if(route.request().method()==='POST'&&new URL(route.request().url()).searchParams.get('name')==='selection-race.txt'){
            const response=await route.fetch();accepted();await held;await route.fulfill({response});delivered();
          } else await route.fallback();
        });
        await page.locator('.remote-followup input[type=file]').setInputFiles({name:'selection-race.txt',mimeType:'text/plain',buffer:Buffer.from('Private to the first task')});
        await ready;
        await page.locator('.remote-task-list button').filter({hasText:'Attachment isolation target'}).click();
        await page.waitForFunction(()=>!document.querySelector('.remote-followup input[type=file]')?.disabled);
        assert.equal(await page.locator('.remote-followup input[type=file]').isEnabled(),true,'Switching tasks must release the old upload UI lock');
        release();await done;
        await page.waitForTimeout(100);
        assert.equal(await page.locator('.remote-followup .remote-attachments span').filter({hasText:'selection-race.txt'}).count(),0,'A late upload must not attach to the newly selected task');
        assert.deepEqual(await page.evaluate(id=>JSON.parse(sessionStorage.getItem(`relay.remote.attachments.${id}`)||'[]'),other),[]);
        await page.locator('.remote-task-list button').filter({hasText:'Remote QA en'}).click();
        await page.locator('.remote-followup .remote-attachments span').filter({hasText:'selection-race.txt'}).waitFor();
        assert.equal(await page.locator('.remote-followup .remote-attachments > div').count(),1,'Returning to the original task must recover exactly one accepted file');
        await page.locator('.remote-followup .remote-attachments > div > button').click();
        await page.evaluate(async id=>fetch('/api/command',{method:'POST',headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},body:JSON.stringify({name:'job.metadata',args:{id,archived:true}})}),other);
      }
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `qa-output/remote-${language}-${width}.png`,
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${language} horizontal overflow`,
      );
      if (language === "en") {
        await page
          .locator(".remote-followup textarea")
          .fill("Exactly one remote follow-up");
        await page.locator(".remote-followup > button").click();
        await page.waitForFunction(
          () =>
            document.querySelector(".remote-followup textarea")?.value === "",
        );
        await page.waitForFunction(async () => {
          const response = await fetch("/api/snapshot", {
            headers: {
              Authorization: `Bearer ${sessionStorage.getItem("relay.remote.token")}`,
            },
          });
          const snap = await response.json();
          return (
            snap.jobs.find((j) => j.title === "Remote QA en")?.messageReceipts
              ?.length === 1
          );
        });
        let heldFollowup=true;
        await page.route("**/api/command",async route=>{const b=route.request().postDataJSON();if(heldFollowup&&b?.name==="chat.submit"&&b.args.input.text==="Recover follow-up after reload"){heldFollowup=false;await route.abort();}else await route.fallback();});
        await page.locator(".remote-followup textarea").fill("Recover follow-up after reload");
        await page.locator(".remote-followup > button").click();
        await page.waitForFunction(()=>!!sessionStorage.getItem("relay.remote.message"));
        await page.reload();await page.locator(".connection-bar.online").waitFor();
        await page.waitForFunction(()=>!sessionStorage.getItem("relay.remote.message"));
        await page.locator(".remote-task-list button").filter({hasText:"Remote QA en"}).click();
        const followupReceipts=await page.evaluate(async()=>{const r=await fetch("/api/snapshot",{headers:{Authorization:`Bearer ${sessionStorage.getItem("relay.remote.token")}`}});return (await r.json()).jobs.find(j=>j.title==="Remote QA en").messageReceipts.length;});
        assert.equal(followupReceipts,2,"followup must automatically resume once without selecting its task");
        await page.evaluate(async()=>{
          const headers={Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`,'Content-Type':'application/json'},snapshot=await(await fetch('/api/snapshot',{headers})).json(),job=snapshot.jobs.find(job=>job.title==='Remote QA en');
          const response=await fetch('/api/command',{method:'POST',headers,body:JSON.stringify({name:'chat.submit',args:{requestId:crypto.randomUUID(),input:{id:job.id,text:'Additional queued management fixture',action:'queue',attachments:[]}}})});
          if(!response.ok)throw Error(await response.text());
        });
        await page.waitForFunction(()=>document.querySelectorAll('.remote-task-management .message-queue li').length===2);
        const queueBefore=await page.evaluate(async()=>{const r=await fetch('/api/snapshot',{headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`}});const job=(await r.json()).jobs.find(job=>job.title==='Remote QA en');return {revision:job.queueRevision,texts:job.queuedMessages.map(message=>message.text)};});
        let queueAttempts=[],queueDropped;const lostQueue=new Promise(resolve=>queueDropped=resolve);
        await page.route('**/api/command',async route=>{
          const body=route.request().postDataJSON();if(body?.name!=='task.queue')return route.fallback();
          queueAttempts.push(body.args.requestId);const response=await route.fetch();
          if(queueAttempts.length===1){await route.fulfill({status:503,json:{error:'Acknowledgment lost after queue mutation'}});queueDropped();}
          else await route.fulfill({response});
        });
        await page.locator('.remote-task-management .message-queue li').first().getByRole('button',{name:'Move down',exact:true}).click();
        await lostQueue;await page.reload();await page.locator('.connection-bar.online').waitFor();
        await page.locator('.remote-task-management').getByText('Operation acknowledged',{exact:true}).waitFor();
        assert.ok(queueAttempts.length>=2);assert.equal(new Set(queueAttempts).size,1,'Queue retry must retain the original request ID');
        const queueAfter=await page.evaluate(async()=>{const r=await fetch('/api/snapshot',{headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`}});const job=(await r.json()).jobs.find(job=>job.title==='Remote QA en');return {revision:job.queueRevision,texts:job.queuedMessages.map(message=>message.text)};});
        assert.equal(queueAfter.revision,queueBefore.revision+1);assert.deepEqual(queueAfter.texts,[...queueBefore.texts].reverse());
        await page.locator(".remote-workflow").click();
        await page
          .locator(".workflow-builder input")
          .first()
          .fill("Remote pipeline");
        await page
          .locator(".workflow-builder textarea")
          .nth(0)
          .fill("Prepare artifact.md");
        await page
          .locator(".workflow-builder textarea")
          .nth(1)
          .fill("Verify artifact.md");
        await page.reload();
        await page.locator(".connection-bar.online").waitFor();
        await page.locator(".remote-workflow").click();
        assert.equal(await page.locator(".workflow-builder input").first().inputValue(),"Remote pipeline");
        assert.equal(await page.locator(".workflow-builder textarea").nth(1).inputValue(),"Verify artifact.md");
        await page.locator(".workflow-builder button[type=submit]").click();
        await page.locator(".workflow-builder").waitFor({ state: "detached" });
        await page.waitForFunction(
          () =>
            document.querySelectorAll(".remote-task-list button").length === 3,
        );
        await page.reload();
        await page.locator(".connection-bar.online").waitFor();
        assert.equal(await page.locator(".remote-task-list button").count(), 3);
        await page.locator(".remote-task-list button").filter({hasText:"Remote pipeline · 1"}).click();
        await page.locator(".remote-workflow-operations > summary").click();
        const operations=page.locator(".remote-workflow-operations");
        await operations.getByRole("button",{name:"Pause unfinished stages",exact:true}).click();
        await operations.getByText("Operation acknowledged",{exact:true}).waitFor();
        await operations.getByRole("button",{name:"Preview retry",exact:true}).click();
        await operations.getByRole("button",{name:"Create paused retry branch",exact:true}).click();
        await operations.getByRole("button",{name:"Open retry branch",exact:true}).click();
        await page.waitForFunction(()=>document.querySelectorAll(".remote-task-list button").length===5);
        const fork=await page.evaluate(async()=>{const r=await fetch("/api/snapshot",{headers:{Authorization:`Bearer ${sessionStorage.getItem("relay.remote.token")}`}});return (await r.json()).jobs.filter(j=>j.workflow?.source);});
        assert.equal(fork.length,2);assert.ok(fork.every(j=>j.state==="paused"),"retry branch must await an explicit start");
        await page.reload();await page.locator(".connection-bar.online").waitFor();
        assert.equal(await page.locator(".remote-task-list button").count(),5);
        await page.locator(".operation-history > summary").click();
        const history=page.locator(".operation-history");await history.locator("article").first().waitFor();
        await history.getByRole("button",{name:"View receipt",exact:true}).first().click();await history.locator("pre").waitFor();
        assert.match(await history.locator("pre").textContent(),/"state": "succeeded"/);
        await page.setViewportSize({width:390,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),"operation history mobile overflow");
        await page.screenshot({path:"qa-output/remote-operations-390.png",fullPage:true});await page.setViewportSize({width:1280,height:900});
        await history.getByRole("button",{name:"Close",exact:true}).click();await page.locator(".operation-history > summary").click();
        await page.locator(".remote-header").getByRole("button",{name:"Task center",exact:true}).click();
        await page.locator(".task-center").waitFor();
        await page.locator(".task-filters select").selectOption(workspace);
        await page.locator(".project-limit select").selectOption("1");
        await page.waitForFunction(async()=>{const r=await fetch("/api/snapshot",{headers:{Authorization:`Bearer ${sessionStorage.getItem("relay.remote.token")}`}});return (await r.json()).projectLimits?.[0]?.limit===1;});
        await page.waitForFunction(()=>document.querySelector(".project-limit select")?.value==="1");
        await page.screenshot({path:"qa-output/remote-center-en-1280.png",fullPage:true});
        await page.locator(".task-center").getByRole("button",{name:"Back to chat",exact:true}).click();
        await page.locator(".remote-header").getByRole("button",{name:"Settings",exact:true}).click();
        await page.locator(".runtime-settings").waitFor();
        await page.locator(".runtime-settings").getByRole("button",{name:"Details",exact:true}).click();
        await page.locator(".runtime-settings pre").waitFor();
        assert.match(await page.locator(".runtime-settings pre").innerText(),/queuedMessages/);
        await page.locator(".modal-close").click();
        await page.locator(".remote-task-list button").filter({hasText:"Remote QA en"}).click();
        await page.locator(".conversation-header").getByRole("button",{name:"Search conversation",exact:true}).click();
        await page.locator(".chat-search input").fill("Remote QA");
        await page.locator(".search-results button").first().waitFor();
        await page.locator(".modal-close").click();
        const download=page.waitForEvent("download");
        await page.locator(".conversation-header").getByRole("button",{name:"Export Markdown",exact:true}).click();
        assert.match((await download).suggestedFilename(),/^conversation-.*\.md$/);
        let holdNewSubmission=true;
        await page.route("**/api/command",async route=>{
          const body=route.request().postDataJSON();
          if(holdNewSubmission&&body?.name==="job.submit"&&body.args.input.prompt==="Keep pending on disconnect")await route.abort();
          else await route.fallback();
        });
        await page.locator(".new-task textarea").fill("Keep pending on disconnect");
        await page.locator(".new-task button[type=submit]").click();
        await page.waitForFunction(()=>!!sessionStorage.getItem("relay.remote.pending"));
        const pendingBefore=await page.evaluate(()=>sessionStorage.getItem("relay.remote.pending"));
        await page.locator(".remote-header").getByRole("button",{name:"Disconnect",exact:true}).click();
        assert.equal(await page.evaluate(()=>sessionStorage.getItem("relay.remote.pending")),pendingBefore);
        await page.reload();await page.locator(".connect-card input").fill(token);await page.locator(".connect-card button").click();
        await page.locator(".connection-bar.online").waitFor();
        assert.equal(await page.evaluate(()=>sessionStorage.getItem("relay.remote.pending")),pendingBefore);
        holdNewSubmission=false;
        await page.waitForFunction(()=>!sessionStorage.getItem("relay.remote.pending"));
        await page.waitForFunction(()=>document.querySelector(".conversation-header h1")?.textContent==="Keep pending on disconnect");
        holdNewSubmission=true;
        await page.locator(".new-task textarea").fill("Keep pending on disconnect");await page.locator(".new-task button[type=submit]").click();
        await page.waitForFunction(()=>!!sessionStorage.getItem("relay.remote.pending"));
        const pendingForOtherServer=await page.evaluate(()=>sessionStorage.getItem("relay.remote.pending"));
        await page.route("**/api/meta",async route=>{const r=await route.fetch();await route.fulfill({response:r,json:{...(await r.json()),serverId:"00000000-0000-4000-8000-000000000001"}});});
        await page.reload();await page.getByText("The server installation changed. Connect in a new tab; pending requests for the original server remain here.",{exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>sessionStorage.getItem("relay.remote.pending")),pendingForOtherServer);
        assert.equal(await page.locator(".connection-bar.online").count(),0);


      }
      await context.close();
    }
    assert.deepEqual(errors, []);
    await browser.close();
    browser = undefined;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0);
    console.log(
      "PASS: real HTTP login, attachment upload/preview/download, task/followup/workflow/schedule lost ACK recovery, paused workflow retry branches, task center budgets, settings, search/export and 390/900/1280px layouts; zero model calls",
    );
  } catch(error) {
    if(browser)for(const context of browser.contexts())for(const page of context.pages())try{
      console.error('QA browser state',await page.evaluate(async()=>{
        const response=await fetch('/api/snapshot',{headers:{Authorization:`Bearer ${sessionStorage.getItem('relay.remote.token')}`},signal:AbortSignal.timeout(2000)}),snapshot=await response.json();
        return {jobs:snapshot.jobs.map(job=>({title:job.title,state:job.state,archived:job.archived})),visible:[...document.querySelectorAll('.remote-task-list strong')].map(node=>node.textContent),selected:document.querySelector('.conversation-header h1')?.textContent,pendingKeys:Object.keys(sessionStorage).filter(key=>key.startsWith('relay.remote.action.'))};
      }));await page.screenshot({path:'qa-output/remote-failure.png',animations:'disabled'});
    }catch{}
    throw error;
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGKILL");
      await stopped.catch(() => {});
    }
    if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
    await fs.rm(base, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
