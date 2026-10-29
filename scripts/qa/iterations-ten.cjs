// Production desktop renderer with a persistent synthetic IPC backend.
// This validates renderer behavior, not Windows native APIs or model inference.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const {fixture: workspaceFixture} = require('./windows-workspace.cjs');
const {waitForBrowser} = require('./browser-wait.cjs');
const root = path.resolve(__dirname, '../..'), output = path.join(root, 'qa-output');

function iterationBackend() {
  const original = window.relay.command, originalSnapshot = window.relay.snapshot;
  const key = 'qa.ten.backend', cwd = 'D:\\\\Projects\\\\relay';
  let listener;
  const initial = originalSnapshot().then(snapshot => {
    if (!localStorage.getItem(key)) {
      snapshot.jobs.find(job => job.id === 'paused-job').queuedMessages = [
        {id:'queue-first', text:'Review the keyboard workflow.', attachments:[], createdAt:Date.now()},
        {id:'queue-second', text:'Then validate the persisted result.', attachments:[], createdAt:Date.now()},
      ];
      snapshot.jobs.find(job => job.id === 'paused-job').queueRevision = 1;
      localStorage.setItem(key, JSON.stringify({snapshot, templates:{version:1,revision:1,items:[
        {id:'9b1786d7-24c8-4aaa-b265-1b96c36d7236',name:'Regression review',prompt:'Review keyboard behavior and add regression tests.',model:'',effort:'',planMode:true,multiAgent:true,deliveryChecks:[],updatedAt:Date.now()},
        {id:'7e8f7ef1-e0f2-4e3e-b48b-d4e01c4affb6',name:'Documentation handoff',prompt:'Write a concise handoff with validation evidence.',model:'',effort:'',planMode:false,multiAgent:false,deliveryChecks:[],updatedAt:Date.now()},
      ]},files:{'README.md':{text:'# Relay workspace\nKeyboard and persistence validation.\n',mtime:10},'src/app.ts':{text:'export const value = 1;\n',mtime:11},'src/nested/config.ts':{text:'export const enabled = true;\n',mtime:12},'.notes.md':{text:'Hidden project notes.\n',mtime:13}}}));
    }
  });
  const state = async () => {await initial; return JSON.parse(localStorage.getItem(key));};
  const save = value => {localStorage.setItem(key, JSON.stringify(value)); listener?.(structuredClone(value.snapshot));};
  const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');
  const preview = async (name,file) => ({path:name,kind:'text',content:file.text,mtime:file.mtime,size:file.text.length,workspaceRoot:cwd,canonicalPath:`${cwd}/${name}`,sha256:await digest(file.text)});
  window.tenCalls = [];
  window.tenSet = async update => {const value=await state(); update(value); save(value);};
  window.tenState = state;
  window.tenFail = {};
  window.relay.snapshot = async () => structuredClone((await state()).snapshot);
  window.relay.onSnapshot = fn => {listener=fn; return()=>{listener=undefined;};};
  window.relay.command = async(name,args) => {
    window.tenCalls.push({name,args:structuredClone(args)});
    const value = await state();
    if(name==='chat.submission.identity')return 'dc0b7c33-4946-4c61-9f68-ab11232b8cd9';
    if(name==='chat.read') return {items:[
      {id:'intro',role:'assistant',kind:'message',at:Date.now(),text:'Workspace ready for keyboard validation.'},
      {id:'cmd-ok',role:'tool',kind:'commandExecution',at:Date.now(),text:'npm run build',detail:'Build completed',status:'completed'},
      {id:'cmd-failed',role:'tool',kind:'commandExecution',at:Date.now(),text:'npm test',detail:'Keyboard regression failed',status:'failed'},
      {id:'file-edit',role:'tool',kind:'fileChange',at:Date.now(),text:'src/app.ts',detail:'Updated keyboard navigation',status:'completed'},
    ],total:4};
    if(name==='chat.search') {
      if(window.tenFail.search){window.tenFail.search=false;throw Error('Synthetic search unavailable');}
      const messages=Array.from({length:37},(_,index)=>({id:`search-${index}`,role:index%3===0?'user':index%3===1?'assistant':'tool',at:Date.now()-index*1000,excerpt:`Keyboard result ${index} includes literal [test] and validation.`,text:`Keyboard result ${index}\nA literal [test] occurrence.\nAnother keyboard validation occurrence.`,detail:index%3===2?'Command output keyboard validation.':undefined}));
      const matches=messages.filter(item=>(!args.role||item.role===args.role)&&`${item.text} ${item.detail||''}`.toLowerCase().includes(args.query.toLowerCase()));
      const offset=args.offset||0,items=matches.slice(offset,offset+30).map(({text,detail,...item})=>item);
      return {items,total:matches.length,...(offset+30<matches.length?{next:offset+30}:{})};
    }
    if(name==='chat.searchItem') {
      if(window.tenFail.detail){window.tenFail.detail=false;throw Error('Synthetic detail unavailable');}
      const index=Number(args.itemId.replace('search-',''));
      return {text:`Keyboard result ${index}\nA literal [test] occurrence.\nAnother keyboard validation occurrence.`,...(index%3===2?{detail:'Command output keyboard validation.'}:{})};
    }
    if(name==='chat.queue') {
      const job=value.snapshot.jobs.find(job=>job.id===args.id);
      if(window.tenFail.queue){window.tenFail.queue=false;job.queueRevision++;job.queuedMessages.find(m=>m.id===args.messageId).text='Changed remotely while editing.';save(value);throw Error('队列已变化，请查看最新队列后重试');}
      if(args.revision!==(job.queueRevision||0))throw Error('队列已变化，请查看最新队列后重试');
      const index=job.queuedMessages.findIndex(m=>m.id===args.messageId);
      if(index<0)throw Error('该消息已发送或移除');
      if(args.action==='edit')job.queuedMessages[index].text=args.text;
      if(args.action==='remove')job.queuedMessages.splice(index,1);
      if(args.action==='up'||args.action==='down'){const target=index+(args.action==='up'?-1:1);if(target>=0&&target<job.queuedMessages.length)[job.queuedMessages[index],job.queuedMessages[target]]=[job.queuedMessages[target],job.queuedMessages[index]];}
      job.queueRevision++;save(value);return structuredClone(job);
    }
    if(name==='templates.list')return structuredClone(value.templates);
    if(name==='templates.save'||name==='templates.remove') {
      if(window.tenFail.template){window.tenFail.template=false;value.templates.revision++;save(value);throw Error('模板列表已变化，请刷新后重试');}
      if(args.revision!==value.templates.revision)throw Error('模板列表已变化，请刷新后重试');
      if(name==='templates.remove')value.templates.items=value.templates.items.filter(item=>item.id!==args.id);
      else {const item={...args.template,id:args.id||crypto.randomUUID(),updatedAt:Date.now()};const index=value.templates.items.findIndex(item=>item.id===args.id);if(index<0)value.templates.items.push(item);else value.templates.items[index]=item;}
      value.templates.revision++;save(value);return structuredClone(value.templates);
    }
    if(name==='workspace.files') {
      const at=(args.path||'.').replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/$/,'');
      const prefix=at==='.'?'':at+'/'; const entries=new Map();
      for(const name of Object.keys(value.files)){if(!name.startsWith(prefix))continue;const rest=name.slice(prefix.length),part=rest.split('/')[0];entries.set(part,{name:part,path:prefix+part,directory:rest.includes('/')});}
      return [...entries.values()].sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name));
    }
    if(name==='chat.asset.read') {const file=value.files[args.path];if(!file)throw Error('File does not exist');return preview(args.path,file);}
    if(name==='workspace.write') {
      const file=value.files[args.path];
      if(window.tenFail.file){window.tenFail.file=false;file.text='Changed on disk, including with the same timestamp.\n';save(value);throw Error('文件已被其他程序修改，请重新读取后保存');}
      if(!file||file.mtime!==args.mtime||(args.expectedHash&&args.expectedHash!==await digest(file.text)))throw Error('文件已被其他程序修改，请重新读取后保存');
      file.text=args.text;file.mtime++;save(value);return preview(args.path,file);
    }
    if(name==='jobs.archive') {
      const results=args.entries.map(entry=>{const job=value.snapshot.jobs.find(job=>job.id===entry.id);if(!job)return {id:entry.id,ok:false,error:'Task missing'};if(window.tenFail.archive&&entry.id==='paused-job')return {id:entry.id,ok:false,error:'Synthetic archive failure'};if((job.archiveRevision||0)!==entry.expectedArchiveRevision)return {id:entry.id,ok:false,error:'Task archive state changed'};job.archived=args.archived;job.archiveRevision=(job.archiveRevision||0)+1;return {id:entry.id,ok:true,revision:job.archiveRevision};});save(value);return {archived:args.archived,results};
    }
    if(name==='chat.priority') {const job=value.snapshot.jobs.find(job=>job.id===args.id);job.priority=args.priority;save(value);return structuredClone(job);}
    if(name==='jobs.priority') {const results=args.ids.map(id=>{const job=value.snapshot.jobs.find(job=>job.id===id);job.priority=args.priority;return {id,ok:true};});save(value);return {priority:args.priority,results};}
    if(name==='jobs.control') {const results=args.ids.map(id=>{const job=value.snapshot.jobs.find(job=>job.id===id);job.state=args.action==='pause'?'paused':'queued';return{id,ok:true};});save(value);return{results};}
    if(name==='chat.update'){const job=value.snapshot.jobs.find(job=>job.id===args.id);Object.assign(job,args);save(value);return structuredClone(job);}
    return original(name,args);
  };
}

async function verifyModalContent(page, selector, name) {
  await page.locator(selector).waitFor();
  // Wait for the actual modal opening animation before recording geometry or images.
  await page.waitForTimeout(260);
  const geometry=await page.locator(selector).evaluate(panel=>{
    const modal=panel.closest('.modal'),outer=modal.getBoundingClientRect(),box=panel.getBoundingClientRect(),style=getComputedStyle(modal);
    const left=outer.left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft),right=outer.right-parseFloat(style.borderRightWidth)-parseFloat(style.paddingRight);
    const controls=[...panel.querySelectorAll('button,input,select,textarea')].map(node=>({node,box:node.getBoundingClientRect()})).filter(item=>item.box.width&&item.box.height);
    return {modalScroll:modal.scrollWidth,modalClient:modal.clientWidth,panel:{left:box.left,right:box.right},left,right,overflow:controls.filter(item=>item.box.left<left-2||item.box.right>right+2).map(item=>({text:item.node.getAttribute('aria-label')||item.node.textContent?.slice(0,60),left:item.box.left,right:item.box.right})),outer:{x:outer.x,y:outer.y,right:outer.right,bottom:outer.bottom},viewport:{width:innerWidth,height:innerHeight}};
  });
  assert.ok(geometry.modalScroll<=geometry.modalClient+1,`${name}: modal content must not scroll horizontally (${JSON.stringify(geometry)})`);
  assert.ok(geometry.panel.left>=geometry.left-2&&geometry.panel.right<=geometry.right+2,`${name}: feature child fits modal content box (${JSON.stringify(geometry)})`);
  assert.deepEqual(geometry.overflow,[],`${name}: controls are not clipped horizontally`);
  assert.ok(geometry.outer.x>=-1&&geometry.outer.y>=-1&&geometry.outer.right<=geometry.viewport.width+1&&geometry.outer.bottom<=geometry.viewport.height+1,`${name}: modal fits viewport`);
  const buttons=page.locator(`${selector} button`),last=buttons.last();
  if(await last.count()){
    await last.scrollIntoViewIfNeeded();
    const reachable=await last.evaluate(button=>{const box=button.getBoundingClientRect(),modal=button.closest('.modal').getBoundingClientRect();return box.width>0&&box.height>0&&box.left>=modal.left-1&&box.right<=modal.right+1&&box.top>=Math.max(0,modal.top)-1&&box.bottom<=Math.min(innerHeight,modal.bottom)+1;});
    assert.equal(reachable,true,`${name}: final control can be reached within the modal viewport`);
  }
  return {modalWithinViewport:true,modalNoHorizontalClipping:true,lastControlReachable:true};
}

async function draftHistoryScenario(page, report) {
  await page.getByRole('button',{name:'New chat',exact:true}).click();
  assert.equal(await page.getByTestId('draft-history').count(),1,'one history trigger per composer');
  const input=page.locator('.agent-composer textarea');
  await input.fill('First draft before an accidental replacement.');
  await page.getByTestId('draft-history').click();
  await page.locator('.draft-history').waitFor();
  await page.keyboard.press('Escape');
  await input.fill('Second draft with details worth preserving.');
  await page.getByTestId('draft-history').click();
  await page.locator('.draft-history-list button').filter({hasText:'First draft before an accidental replacement.'}).click();
  assert.equal(await page.locator('.draft-history-preview textarea').inputValue(),'First draft before an accidental replacement.');
  await page.getByTestId('draft-restore').click();
  assert.equal(await input.inputValue(),'First draft before an accidental replacement.');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('relay.composer.history.v1')).entries.some(v=>v.text==='Second draft with details worth preserving.')),true);
  await page.reload();
  assert.equal(await input.inputValue(),'First draft before an accidental replacement.');
  assert.equal(await page.evaluate(()=>window.tenCalls.some(call=>call.name==='chat.creation.submit'||call.name==='chat.send')),false);
  await input.fill('Quick scope exit must capture this final revision.');
  await page.locator('.agent-thread').filter({hasText:'Paused workspace upgrade'}).click();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('relay.composer.history.v1')).entries.some(v=>v.text==='Quick scope exit must capture this final revision.')),true);
  await page.getByRole('button',{name:'New chat',exact:true}).click();
  await page.getByTestId('draft-history').click();
  await page.getByRole('button',{name:'Clear history for this composer',exact:true}).click();
  await page.waitForTimeout(1700);
  assert.equal(await page.locator('.draft-history-list button').count(),0,'clear cancels pending autosave');
  await page.keyboard.press('Escape');
  report.checks.push('R1 draft restore keeps displaced versions, quick scope exit flushes the latest edit, explicit clear stays cleared and no task is sent');
}

async function archiveScenario(page, report) {
  await page.getByRole('textbox',{name:'Search tasks',exact:true}).fill('');
  await page.getByTestId('task-filter-all').click();
  await page.getByTestId('task-card-review-job').getByRole('checkbox').check();
  await page.getByTestId('task-card-paused-job').getByRole('checkbox').check();
  await page.evaluate(()=>{window.tenFail.archive=true;});
  await page.getByTestId('task-archive-apply').click();
  await page.getByTestId('task-card-review-job').waitFor({state:'detached'});
  assert.equal(await page.getByTestId('task-card-paused-job').getByRole('checkbox').isChecked(),true);
  await page.getByTestId('task-archive-undo').click();
  await page.getByTestId('task-card-review-job').waitFor();
  assert.equal(await page.evaluate(async()=>{const data=await window.tenState();return !!data.snapshot.jobs.find(j=>j.id==='review-job').archived;}),false);
  await page.evaluate(()=>{window.tenFail.archive=false;});
  await page.getByTestId('task-card-paused-job').getByRole('checkbox').uncheck();
  await page.getByTestId('task-card-review-job').getByRole('checkbox').check();
  await page.getByTestId('task-archive-apply').click();
  await page.evaluate(()=>window.tenSet(value=>{value.snapshot.jobs.find(j=>j.id==='review-job').archiveRevision++;}));
  await page.getByTestId('task-archive-undo').click();
  assert.equal(await page.evaluate(async()=>{const data=await window.tenState();return !!data.snapshot.jobs.find(j=>j.id==='review-job').archived;}),true,'stale undo cannot override a newer archive action');
  await page.getByTestId('task-show-archived').click();
  await page.getByTestId('task-card-review-job').waitFor();
  await page.reload();await page.locator('.task-queue-button').click();
  await page.getByTestId('task-show-archived').click();
  await page.getByTestId('task-card-review-job').waitFor();
  await page.getByTestId('task-card-review-job').getByRole('checkbox').check();
  await page.getByTestId('task-archive-apply').click();
  await page.getByTestId('task-show-current').click();
  await page.getByTestId('task-card-review-job').waitFor();
  report.checks.push('R4 archive partial failures preserve selection, undo restores exact successful task revisions while stale undo is rejected and archived work is recoverable across reload');
}

async function inboxScenario(page, report) {
  await page.getByTestId('inbox-trigger').click();
  const inbox=page.locator('.attention-inbox'),request=inbox.locator('[data-inbox-id="request:approval-1"]');
  await request.waitFor();
  await verifyModalContent(page,'.attention-inbox','inbox1440');
  await page.screenshot({path:path.join(output,'iterations-ten-inbox.png')});
  await request.locator('.inbox-item-actions button').first().click();
  await request.waitFor({state:'detached'});
  await inbox.locator('[data-inbox-filter=snoozed]').click();await request.waitFor();
  await page.keyboard.press('Escape');await page.reload();
  await page.getByTestId('inbox-trigger').click();
  assert.equal(await request.count(),0,'snoozed approval stays hidden after reload');
  await page.evaluate(()=>window.tenSet(value=>{value.snapshot.approvals[0].historyId='updated-request-version';}));
  await request.waitFor();
  assert.equal(await page.evaluate(()=>window.tenCalls.some(call=>call.name==='approval.respond'||call.name==='job.control')),false,'snooze never approves or resumes work');
  await inbox.locator('[data-inbox-filter=complete]').click();
  const complete=inbox.locator('[data-inbox-id="complete:review-job"]');await complete.waitFor();
  await complete.locator('.inbox-item-actions button').last().click();
  await complete.waitFor({state:'detached'});
  await page.evaluate(()=>window.tenSet(value=>{value.snapshot.jobs.find(j=>j.id==='review-job').updatedAt++;}));
  await complete.waitFor();
  await inbox.locator('[data-inbox-filter=action]').click();
  await request.locator('.inbox-open').click();
  assert.equal(await page.evaluate(()=>localStorage.getItem('relay.lastChat')),'approval-job');
  report.checks.push('R2 inbox snooze persists without controlling tasks, changed request/completion versions reappear and attention opens the actual task');
}

async function editorScenario(page, report) {
  const preview=page.locator('.editable-file-preview');await preview.waitFor();
  await preview.getByRole('button',{name:'Edit file',exact:true}).click();
  const edit=preview.locator('textarea.file-editor');
  const content='# Local edit retained through navigation and same-timestamp disk conflict.\n';
  await edit.fill(content);
  await preview.locator('header button').first().click();
  await page.locator('.file-browser [data-file-entry][title="README.md"]').click();
  await preview.locator('[data-editor-recover]').click();
  assert.equal(await edit.inputValue(),content);
  assert.equal(await page.evaluate(async()=>(await window.tenState()).files['README.md'].text),'# Relay workspace\nKeyboard and persistence validation.\n');
  await page.reload();
  await page.getByRole('button',{name:'Project files',exact:true}).click();
  await page.locator('.file-browser [data-file-entry][title="README.md"]').click();
  await preview.locator('[data-editor-recover]').click();
  assert.equal(await edit.inputValue(),content);
  await page.evaluate(()=>{window.tenFail.file=true;});
  await preview.getByRole('button',{name:'Save file',exact:true}).click();
  await preview.locator('[data-editor-inspect]').waitFor();
  assert.equal(await edit.inputValue(),content,'save failure keeps editable text');
  await preview.locator('[data-editor-inspect]').click();
  await preview.locator('.editor-disk-comparison').waitFor();
  assert.match(await preview.locator('.editor-disk-comparison').innerText(),/Changed on disk/);
  assert.equal(await preview.getByRole('button',{name:'Save file',exact:true}).isDisabled(),true);
  await page.screenshot({path:path.join(output,'iterations-ten-editor-conflict.png')});
  await preview.locator('[data-editor-ack]').click();
  await preview.getByRole('button',{name:'Save file',exact:true}).click();
  await waitForBrowser(page,async()=>(await window.tenState()).files['README.md'].text.startsWith('# Local edit retained'));
  assert.match(await page.evaluate(()=>window.tenCalls.filter(c=>c.name==='workspace.write').at(-1).args.expectedHash),/^[a-f0-9]{64}$/);
  report.checks.push('R6 file drafts survive navigation/reload without disk writes; same-mtime save conflict retains editor and requires fresh disk comparison before guarded save');
}

async function templatesScenario(page, report) {
  const id='9b1786d7-24c8-4aaa-b265-1b96c36d7236';
  await page.getByRole('button',{name:'New chat',exact:true}).click();
  const input=page.locator('.agent-composer textarea');await input.fill('Keep the existing project draft.');
  await page.locator('.template-trigger').click();
  const panel=page.locator('.template-workspace'),item=panel.locator(`[data-template-id="${id}"]`);
  await panel.locator('[data-template-search]').fill('Regression');assert.equal(await panel.locator('[data-template-id]').count(),1);
  await item.getByRole('button',{name:'Favorite templates',exact:true}).click();
  await item.locator('.template-preview-trigger').click();
  assert.equal(await input.inputValue(),'Keep the existing project draft.','preview does not mutate composer');
  await page.evaluate(()=>window.tenSet(value=>{value.templates.items[0].prompt='Updated template requires second confirmation.';value.templates.items[0].updatedAt++;value.templates.revision++;}));
  await panel.locator('[data-template-insert]').click();
  assert.equal(await input.inputValue(),'Keep the existing project draft.');
  assert.match(await panel.locator('[data-template-preview]').innerText(),/Updated template requires second confirmation/);
  await panel.locator('[data-template-insert]').click();
  await panel.waitFor({state:'detached'});
  assert.equal(await input.inputValue(),'Keep the existing project draft.\n\nUpdated template requires second confirmation.');
  await page.locator('.template-trigger').click();
  await panel.locator(`[data-template-clone="${id}"]`).click();
  await panel.locator('[data-template-name]').fill('Regression review independent copy');
  await panel.locator('[data-template-prompt]').fill('Independent instructions and original contract settings.');
  await panel.locator('form button[type=submit]').click();
  await waitForBrowser(page,async()=>(await window.tenState()).templates.items.length===3);
  await item.getByRole('button',{name:'Edit',exact:true}).click();
  await panel.locator('[data-template-prompt]').fill('Do not discard my stale template edit.');
  await page.evaluate(()=>{window.tenFail.template=true;});
  await panel.locator('form button[type=submit]').click();
  await panel.locator('.template-edit-conflict').waitFor();
  assert.equal(await panel.locator('[data-template-prompt]').inputValue(),'Do not discard my stale template edit.');
  assert.equal(await panel.locator('form button[type=submit]').isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.tenCalls.some(c=>c.name==='chat.creation.submit'||c.name==='chat.send')),false);
  await page.keyboard.press('Escape');
  await panel.getByRole('button',{name:'Continue editing',exact:true}).click();
  assert.equal(await panel.locator('[data-template-prompt]').inputValue(),'Do not discard my stale template edit.');
  await page.keyboard.press('Escape');
  await panel.getByRole('button',{name:'Discard edits and continue',exact:true}).click();
  await panel.waitFor({state:'detached'});
  report.checks.push('R8 templates search/favorite, refreshed previews need reconfirmation, clone stays independent and stale/unsaved forms require explicit resolution');
}

async function savedViewsScenario(page, report) {
  await page.locator('.task-queue-button').click();
  await page.getByTestId('task-layout-board').click();
  await page.getByTestId('task-filter-paused').click();
  await page.getByRole('textbox', {name:'Search tasks', exact:true}).fill('workspace');
  await page.getByTestId('task-sort').selectOption('oldest');
  await page.getByTestId('task-view-name').fill('Paused project work');
  await page.getByTestId('task-view-save').click();
  const views=page.getByTestId('task-saved-view');
  const id=await views.inputValue();assert.ok(id,'saved view selected');
  await page.getByRole('textbox', {name:'Search tasks', exact:true}).fill('');
  await page.getByTestId('task-filter-all').click();
  await page.getByTestId('task-layout-list').click();
  await views.selectOption(id);
  assert.equal(await page.getByRole('textbox', {name:'Search tasks', exact:true}).inputValue(),'workspace');
  assert.equal(await page.getByTestId('task-sort').inputValue(),'oldest');
  assert.equal(await page.getByTestId('task-layout-board').getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByTestId('task-filter-paused').getAttribute('aria-pressed'),'true');
  await page.reload();await page.locator('.task-queue-button').click();
  await page.getByTestId('task-saved-view').selectOption(id);
  assert.equal(await page.getByRole('textbox', {name:'Search tasks', exact:true}).inputValue(),'workspace');
  await page.getByTestId('task-view-name').fill('Paused focus renamed');
  await page.getByTestId('task-view-update').click();
  assert.match(await page.getByTestId('task-saved-view').innerText(),/Paused focus renamed/);
  report.checks.push('R3 named task views restore full search/status/sort/layout across reload and can be renamed');
}

async function queueScenario(page, report) {
  await page.locator('.agent-thread').filter({hasText:'Paused workspace upgrade'}).click();
  const row=page.locator('[data-queue-id="queue-first"]');
  await row.getByRole('button',{name:'Edit',exact:true}).click();
  const editor=row.locator('[data-queue-editor]');
  await editor.fill('My local queue edit survives reload and conflict.');
  await row.getByRole('button',{name:'Close and keep edit',exact:true}).click();
  await page.reload();
  await page.locator('[data-queue-id="queue-first"]').getByRole('button',{name:'Continue editing',exact:true}).click();
  assert.equal(await editor.inputValue(),'My local queue edit survives reload and conflict.');
  await page.evaluate(()=>{window.tenFail.queue=true;});
  await row.locator('[data-queue-save]').click();
  await row.locator('.queue-conflict').waitFor();
  assert.equal(await editor.inputValue(),'My local queue edit survives reload and conflict.');
  assert.equal(await row.locator('[data-queue-save]').isDisabled(),true);
  await row.getByRole('button',{name:'Keep my edit and review again',exact:true}).click();
  await row.locator('[data-queue-save]').click();
  await editor.waitFor({state:'detached'});
  assert.equal(await page.evaluate(async()=>{const value=await window.tenState();return value.snapshot.jobs.find(j=>j.id==='paused-job').queuedMessages[0].text;}),'My local queue edit survives reload and conflict.');
  const second=page.locator('[data-queue-id="queue-second"]');
  await second.getByRole('button',{name:'Edit',exact:true}).click();
  await second.locator('[data-queue-editor]').fill('Do not lose this unsent alternative.');
  await second.getByRole('button',{name:'Close and keep edit',exact:true}).click();
  await second.getByRole('button',{name:'Remove',exact:true}).click();
  await second.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.evaluate(async()=>{const value=await window.tenState();return value.snapshot.jobs.find(j=>j.id==='paused-job').queuedMessages.length;}),2);
  await second.getByRole('button',{name:'Remove',exact:true}).click();
  await second.getByRole('button',{name:'Confirm removal',exact:true}).click();
  await second.waitFor({state:'detached'});
  assert.match(await page.locator('.queue-recovered').innerText(),/Do not lose this unsent alternative/);
  assert.equal(await page.evaluate(async()=>{const value=await window.tenState();return value.snapshot.jobs.find(j=>j.id==='paused-job').queuedMessages.length;}),1);
  report.checks.push('R7 queue edits survive reload, conflict requires explicit resolution, removal requires confirmation and orphaned edits remain copy-only');
}

async function filesScenario(page, report) {
  await page.locator('.agent-thread').filter({hasText:'Review navigation and rendering'}).click();
  await page.getByRole('button',{name:'Project files',exact:true}).click();
  const browser=page.locator('.file-browser');await browser.waitFor();
  await browser.locator('[data-file-entry][title="src"]').focus();
  await page.keyboard.press('ArrowRight');
  await browser.locator('.file-browser-crumbs button[aria-current=location]').filter({hasText:'src'}).waitFor();
  await browser.locator('[data-file-entry][title="src/app.ts"]').focus();
  await page.keyboard.press('Backspace');
  await browser.locator('[data-file-entry][title="README.md"]').waitFor();
  assert.equal(await browser.locator('[data-file-entry][title=".notes.md"]').count(),0);
  await browser.locator('.file-browser-tools button[aria-pressed]').click();
  await browser.locator('[data-file-entry][title=".notes.md"]').waitFor();
  await browser.locator('.file-browser-tools input').fill('config');
  await browser.locator('[data-file-entry][title="src/nested/config.ts"]').waitFor();
  assert.equal(await browser.locator('[data-file-entry]').count(),1);
  await browser.locator('.file-browser-tools input').fill('');
  await browser.locator('[data-file-entry][title="README.md"]').click();
  await page.locator('.file-preview').waitFor();
  report.checks.push('R5 scoped recursive file search, hidden files and keyboard directory navigation open the expected workspace file');
}

async function searchScenario(page, report) {
  await page.locator('.agent-thread').filter({hasText:'Review navigation and rendering'}).click();
  await page.getByRole('button',{name:'Chat menu',exact:true}).click();
  await page.getByRole('menuitem',{name:'Search conversation',exact:true}).click();
  const panel=page.locator('.chat-search-workspace');
  await panel.locator('[data-search-query]').fill('keyboard');
  await waitForBrowser(page,()=>document.querySelectorAll('[data-search-result]').length===30);
  const first=panel.locator('[data-search-result]').first();await first.click();
  await panel.locator('[data-search-detail] pre').waitFor();
  assert.match(await panel.locator('[data-search-detail]').innerText(),/Keyboard result 0/);
  await panel.locator('[data-search-next-match]').click();
  assert.notEqual(await panel.locator('[data-search-result]').first().getAttribute('aria-selected'),'true');
  await panel.getByRole('button',{name:'Next page',exact:true}).click();
  await waitForBrowser(page,()=>document.querySelectorAll('[data-search-result]').length===7);
  await panel.getByRole('button',{name:'Previous page',exact:true}).click();
  await waitForBrowser(page,()=>document.querySelectorAll('[data-search-result]').length===30);
  await panel.locator('[data-search-role]').selectOption('tool');
  await waitForBrowser(page,()=>document.querySelectorAll('[data-search-result]').length===12);
  await page.evaluate(()=>{window.tenFail.detail=true;});
  await panel.locator('[data-search-result]').nth(1).click();
  await panel.getByRole('button',{name:'Retry message',exact:true}).waitFor();
  assert.equal(await panel.locator('[data-search-detail] pre').count(),0,'failed detail does not expose the previous message');
  await panel.getByRole('button',{name:'Retry message',exact:true}).click();
  await panel.locator('[data-search-detail] pre').waitFor();
  await page.evaluate(()=>{window.tenFail.search=true;});
  await panel.locator('[data-search-query]').fill('Keyboard');
  await panel.getByRole('button',{name:'Retry search',exact:true}).waitFor();
  assert.equal(await panel.locator('[data-search-result]').count(),0,'failed search does not keep an old page as current');
  await panel.getByRole('button',{name:'Retry search',exact:true}).click();
  await waitForBrowser(page,()=>document.querySelectorAll('[data-search-result]').length===12);
  await panel.locator('[data-search-query]').fill('[test]');
  await panel.locator('[data-search-result]').first().click();
  await panel.locator('[data-search-detail] pre').waitFor();
  assert.match(await panel.locator('[data-search-detail]').innerText(),/literal \[test\]/);
  report.checks.push('R9 conversation search pages both directions, filters roles, renders literal text and retries failed search/detail without stale content');
  await page.keyboard.press('Escape');
}

async function activityScenario(page, report) {
  const toolbar=page.locator('.activity-workspace-toolbar');
  await toolbar.waitFor();
  await toolbar.locator('[data-activity-filter=failed]').click();
  await waitForBrowser(page,()=>document.querySelectorAll('.activity-work-entry[data-activity-id]').length===1);
  await waitForBrowser(page,()=>document.querySelector('.activity-work-entry[data-activity-id]')?.innerText.includes('npm test'));
  assert.match(await page.locator('.activity-work-entry[data-activity-id]').innerText(),/npm test/);
  assert.match(await page.locator('.agent-transcript').innerText(),/Workspace ready/);
  await toolbar.locator('[data-activity-filter=all]').click();
  await toolbar.locator('[data-activity-next-failure]').click();
  const failure=page.locator('.activity-work-entry[data-activity-id="cmd-failed"]');
  await failure.waitFor();
  await waitForBrowser(page,()=>document.querySelector('[data-activity-id="cmd-failed"]')?.innerText.includes('Keyboard regression failed'));
  assert.match(await failure.innerText(),/Keyboard regression failed/);
  report.checks.push('R10 failure filter preserves narration and next-failure navigation reveals the actual failed tool output');
}

module.exports={iterationBackend};

if(require.main===module)(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const report={syntheticIPC:true,nativeWindows:false,modelRequests:0,checks:[],layouts:[],errors:[]};
  const server=http.createServer((req,res)=>{const folder=path.join(root,'dist/renderer'),file=path.resolve(folder,'.'+(req.url==='/'?'/index.html':req.url));if(!file.startsWith(folder+path.sep))return res.writeHead(403).end();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).on('error',()=>res.writeHead(404).end()).pipe(res);});
  let browser,page,stage='initializing';
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:process.env.RELAY_CHROMIUM_PATH||'/usr/bin/chromium',headless:true});
    const init=options=>`(${workspaceFixture.toString()})(${JSON.stringify(options)});(${iterationBackend.toString()})();`;
    const context=await browser.newContext({viewport:{width:1440,height:960},deviceScaleFactor:1.25});
    await context.addInitScript({content:init({theme:'dark',language:'en'})});
    page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&/same key|two children/i.test(message.text()))report.errors.push(message.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.agent-shell').waitFor();
    stage='draft history';await draftHistoryScenario(page,report);
    stage='attention inbox';await inboxScenario(page,report);
    stage='saved task views';await savedViewsScenario(page,report);
    stage='archive and undo';await archiveScenario(page,report);
    stage='queued followups';await queueScenario(page,report);
    stage='file explorer';await filesScenario(page,report);
    stage='file editing recovery';await editorScenario(page,report);
    stage='template library';await templatesScenario(page,report);
    stage='conversation search';await searchScenario(page,report);
    stage='activity diagnostics';await activityScenario(page,report);
    await page.screenshot({path:path.join(output,'iterations-ten-activity.png')});
    stage='responsive layouts';
    for(const [theme,language,width] of [['dark','en',1440],['light','zh-CN',1280],['dark','ja',900]]){
      const translated=await browser.newContext({viewport:{width,height:960},deviceScaleFactor:1.25});
      await translated.addInitScript({content:init({theme,language})});
      const layout=await translated.newPage();layout.on('pageerror',error=>report.errors.push(error.message));layout.on('console',message=>{if(message.type()==='error'&&/same key|two children/i.test(message.text()))report.errors.push(message.text());});
      await layout.goto(`http://127.0.0.1:${server.address().port}`);
      await layout.locator('.agent-new').click();await layout.locator('.workspace-home').waitFor();
      assert.equal(await layout.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await layout.screenshot({path:path.join(output,`iterations-ten-home-${theme}-${language}.png`)});
      await layout.locator('.task-queue-button').click();await layout.getByTestId('task-layout-board').click();
      assert.equal(await layout.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await layout.screenshot({path:path.join(output,`iterations-ten-board-${theme}-${language}.png`)});
      report.layouts.push({theme,language,width,overflow:false});
      if(width===900||theme==='light'){
        async function modalBounds(name,selector){
          await layout.locator(selector).waitFor();
          const contentGeometry=await verifyModalContent(layout,selector,name);
          assert.equal(await layout.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
          if(theme==='light'){
            const background=await layout.locator('dialog:modal > .modal').evaluate(node=>getComputedStyle(node).backgroundColor);
            const rgb=background.match(/[\d.]+/g)?.slice(0,3).map(Number)||[];
            assert.ok(rgb.length===3&&rgb.reduce((a,b)=>a+b,0)/3>150,`${name}: light theme modal surface is actually light (${background})`);
          }
          await layout.screenshot({path:path.join(output,`iterations-ten-modal-${name}-${theme==='light'?'light1280':'ja900'}.png`)});
          report.layouts.push({view:name,theme,language,width,...contentGeometry,overflow:false});
          await layout.keyboard.press('Escape');
          await layout.locator('dialog:modal').waitFor({state:'detached'});
        }
        await layout.getByTestId('inbox-trigger').click();await modalBounds('inbox','.attention-inbox');
        await layout.locator('.agent-new').click();await layout.locator('.template-trigger').click();await modalBounds('templates','.template-workspace');
        await layout.getByTestId('draft-history').click();await modalBounds('draft-history','.draft-history');
        await layout.locator('.agent-thread').filter({hasText:'Review navigation and rendering'}).click();
        await layout.locator('.agent-header button:has(svg.lucide-ellipsis)').click();
        await layout.locator('.thread-menu button:has(svg.lucide-search)').click();await modalBounds('conversation-search','.chat-search-workspace');
        await layout.keyboard.press('Control+k');await modalBounds('commands','.workspace-command-palette');
      }
      await translated.close();
    }
    assert.equal(report.checks.length,10);assert.deepEqual(report.errors,[]);
    report.status='passed';
    fs.writeFileSync(path.join(output,'iterations-ten-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  }catch(error){report.status='failed';report.stage=stage;report.failure=String(error);fs.writeFileSync(path.join(output,'iterations-ten-report.json'),JSON.stringify(report,null,2));await page?.screenshot({path:path.join(output,'iterations-ten-failure.png')}).catch(()=>{});throw error;}
  finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
