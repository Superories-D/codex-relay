// Production Windows renderer in Chromium, with explicit synthetic IPC only.
// No account files, model requests, destructive Git operations or native claims.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.RELAY_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'qa-output');

function fixture({theme = 'dark', language = 'en'} = {}) {
  const now = Date.now(), cwd = 'D:\\Projects\\relay';
  const job = (id, title, state, priority = 'normal', updatedAt = now) => ({
    id, title, state, priority, updatedAt, createdAt: updatedAt - 1000, cwd,
    prompt: 'Synthetic renderer validation', mode: 'cli', model: '', effort: '',
    sandbox: 'workspaceWrite', approvalPolicy: 'on-request', bucket: 'codex', rotations: 0, interactive: true,
  });
  const data = {
    version: 1, platform: 'win32', cursor: 0, logs: [],
    approvals: [{id: 'approval-1', jobId: 'approval-job', kind: 'command', method: 'item/commandExecution/requestApproval', params: {command: 'npm test'}}],
    accounts: [], settings: {cliPath: 'codex', desktop: {}, resetWarmupEnabled: false},
    jobs: [
      job('review-job', 'Review navigation and rendering', 'completed', 'normal', now - 100),
      job('approval-job', 'Waiting for command approval', 'running', 'normal', now - 300),
      job('paused-job', 'Paused workspace upgrade', 'paused', 'normal', now - 200),
      job('high-job', 'Priority release checks', 'queued', 'high', now - 400),
      job('low-job', 'Background documentation', 'queued', 'low', now - 50),
      {...job('archived-job', 'Archived task must stay hidden', 'completed'), archived: true},
    ],
  };
  const desktop = {projects: [{id: 'project', cwd, name: 'Relay workspace'}, {id: 'tools', cwd: 'D:\\Projects\\tools', name: 'Tools workspace'}], schedules: [], preferences: {theme, language, notifications: false}};
  let listener, version = Number(sessionStorage.getItem('qa.reviewVersion')) || 1;
  let contentVersion = Number(sessionStorage.getItem('qa.contentVersion')) || version;
  const emit = () => listener?.(structuredClone(data));
  window.workspaceCalls = [];
  window.workspaceAdvance = () => { version++; contentVersion++; sessionStorage.setItem('qa.reviewVersion', String(version)); sessionStorage.setItem('qa.contentVersion', String(contentVersion)); };
  window.workspaceContentAdvance = () => {contentVersion++; sessionStorage.setItem('qa.contentVersion', String(contentVersion));};
  window.workspaceFail = false;
  window.relay = {
    snapshot: async () => structuredClone(data), onSnapshot: fn => {listener = fn; return () => {};}, onChat: () => () => {},
    command: async (name, args) => {
      window.workspaceCalls.push({name, args});
      if (name === 'desktop.read') return structuredClone(desktop);
      if (name === 'desktop.preferences') {Object.assign(desktop.preferences, args); return structuredClone(desktop);}
      if (name === 'chat.read') return {items: [], total: 0};
      if (name === 'account.models') return [];
      if (name === 'history.importAll.status') return {};
      if (name === 'chat.assets.list') return {outputs: [], sources: []};
      if (name === 'chat.assets') return {files: [], images: [], sources: []};
      if (name === 'desktop.branch') return 'feature/workspace';
      if (name === 'workspace.changes') return {root: cwd, branch: 'feature/workspace', revision: String(version), files: [
        {path: 'src/review.ts', index: ' ', worktree: 'M'}, {path: 'docs/guide.md', index: ' ', worktree: 'M'},
      ]};
      if (name === 'workspace.diff') return `diff --git a/${args.path} b/${args.path}\nindex 1234567..abcdef0 100644\n--- a/${args.path}\n+++ b/${args.path}\n@@ -1 +1 @@\n-old content\n+${args.path === 'src/review.ts' ? `revision ${contentVersion}` : 'documentation update'}\n`;
      if (name === 'chat.priority') {const j = data.jobs.find(j => j.id === args.id); j.priority = args.priority; emit(); return j;}
      if (name === 'jobs.priority') {
        const results = args.ids.map(id => {
          if (window.workspaceFail && id === 'high-job') return {id, ok: false, error: 'Synthetic priority failure', code: 'storage'};
          data.jobs.find(j => j.id === id).priority = args.priority; return {id, ok: true};
        }); emit(); return {priority: args.priority, results};
      }
      if (name === 'jobs.control') {
        const results = args.ids.map(id => {
          if (window.workspaceFail && id === 'high-job') return {id, ok: false, error: 'Synthetic control failure'};
          const j = data.jobs.find(j => j.id === id); j.state = args.action === 'pause' ? 'paused' : 'queued'; return {id, ok: true};
        }); emit(); return {results};
      }
      if (name === 'job.pause' || name === 'job.resume') {
        const j = data.jobs.find(j => j.id === (typeof args === 'string' ? args : args.id));
        if (j) j.state = name === 'job.pause' ? 'paused' : 'queued'; emit(); return j;
      }
      if (name === 'chat.update') {const j = data.jobs.find(j => j.id === args.id); Object.assign(j, args); emit(); return j;}
      return undefined;
    },
  };
  if (!sessionStorage.getItem('qa.initialized')) {
    localStorage.setItem('relay.lastChat', 'review-job');
    localStorage.setItem('relay.project', cwd);
    localStorage.setItem('relay.inspector', 'false');
    sessionStorage.setItem('qa.initialized', '1');
  }
}

module.exports = {fixture};

if (require.main === module) (async () => {
  fs.mkdirSync(output, {recursive: true});
  const report = {syntheticIPC: true, modelRequests: 0, checks: [], layouts: [], errors: []};
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, 'dist/renderer', '.' + (req.url === '/' ? '/index.html' : req.url));
    if (!file.startsWith(path.join(root, 'dist/renderer') + path.sep)) return res.writeHead(403).end();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html');
    fs.createReadStream(file).on('error', () => res.writeHead(404).end()).pipe(res);
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({executablePath: process.env.RELAY_CHROMIUM_PATH || '/usr/bin/chromium', headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 960}, deviceScaleFactor: 1.25});
    page.on('pageerror', e => report.errors.push(e.message));
    await page.addInitScript(fixture, {theme: 'dark', language: 'en'});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', {name: 'New chat', exact: true}).click();
    await page.locator('.workspace-home').waitFor();
    assert.equal(await page.locator('.workspace-projects button').filter({hasText: 'Relay workspace'}).count(), 1, 'custom project name is preserved');
    await page.screenshot({path: path.join(output, 'windows-workspace-home-initial.png')});
    const draft = page.locator('.agent-composer textarea');
    await draft.fill('Keep my draft intact.');
    await page.locator('.workspace-starters button').first().click();
    assert.match(await draft.inputValue(), /Keep my draft intact\./);
    assert.ok((await draft.inputValue()).length > 'Keep my draft intact.'.length, 'starter appends a suggestion to the existing draft');
    await page.locator('.workspace-projects button').filter({hasText: 'Tools workspace'}).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('relay.project')), 'D:\\Projects\\tools');
    assert.equal(await draft.inputValue(), '', 'each project has a separate draft');
    await page.getByRole('button', {name: 'Go back', exact: true}).click();
    await page.waitForFunction(() => localStorage.getItem('relay.project') === 'D:\\Projects\\relay');
    assert.match(await draft.inputValue(), /Keep my draft intact\./);
    await page.getByRole('button', {name: 'Go forward', exact: true}).click();
    await page.waitForFunction(() => localStorage.getItem('relay.project') === 'D:\\Projects\\tools');
    assert.equal(await draft.inputValue(), '');
    await page.getByRole('button', {name: 'Go back', exact: true}).click();
    await page.waitForFunction(() => localStorage.getItem('relay.project') === 'D:\\Projects\\relay');
    assert.match(await draft.inputValue(), /Keep my draft intact\./);
    report.checks.push('home starters append to draft; project-specific draft restores; project selection persists');
    await page.locator('.agent-transcript').evaluate(node => {node.scrollTop = 0;});
    await page.screenshot({path: path.join(output, 'windows-workspace-home.png')});
    await page.locator('.workspace-attention button').filter({hasText: 'Waiting for command approval'}).click();
    await page.waitForFunction(() => localStorage.getItem('relay.lastChat') === 'approval-job');
    assert.equal(await page.getByRole('button', {name: 'Go forward', exact: true}).isDisabled(), true, 'new navigation truncates forward history');
    await page.keyboard.press('Control+k');
    const palette = page.locator('.workspace-command-palette');
    assert.equal(await page.locator('dialog:modal').count(), 1);
    await palette.getByRole('combobox').fill('Review navigation');
    await palette.getByRole('combobox').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true, isComposing: true})));
    assert.equal(await page.locator('dialog:modal').count(), 1, 'IME confirmation does not execute a palette result');
    assert.equal(await page.evaluate(() => localStorage.getItem('relay.lastChat')), 'approval-job');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => localStorage.getItem('relay.lastChat') === 'review-job');
    await palette.waitFor({state: 'detached'});
    await page.locator('.agent-composer textarea').focus();
    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('>');
    assert.equal(await palette.locator('[role=option]').filter({hasText: 'Review navigation'}).count(), 0);
    await page.keyboard.press('Escape');
    await palette.waitFor({state: 'detached'});
    assert.equal(await page.locator('.agent-composer textarea').evaluate(node => node === document.activeElement), true, 'Escape restores focus to the composer');
    await page.keyboard.press('Control+Shift+f');
    await page.locator('.workspace-focus').waitFor();
    await page.keyboard.press('Control+Shift+f');
    await page.locator('.workspace-focus').waitFor({state: 'detached'});
    report.checks.push('home attention opens real task; command palette keyboard navigation and focus mode work');
    await page.locator('.task-queue-button').click();
    await page.getByRole('button', {name: 'Go back', exact: true}).click();
    await page.locator('.agent-composer textarea').waitFor();
    await page.getByRole('button', {name: 'Go forward', exact: true}).click();
    await page.getByTestId('task-layout-board').waitFor();
    report.checks.push('back/forward restores project draft and task screen; new navigation branches history; IME Enter does not execute');
    await page.getByTestId('task-layout-board').click();
    await page.getByTestId('task-filter-attention').click();
    await page.getByTestId('task-card-approval-job').waitFor();
    assert.equal(await page.getByTestId('task-card-low-job').count(), 0);
    assert.equal(await page.getByTestId('task-card-archived-job').count(), 0);
    report.checks.push('pending approvals appear in attention; other tasks and archived tasks excluded');
    await page.getByTestId('task-sort').selectOption('recent');
    await page.reload();
    await page.locator('.task-queue-button').click();
    assert.equal(await page.getByTestId('task-layout-board').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('task-sort').inputValue(), 'recent');
    report.checks.push('board layout and sorting survive reload');
    await page.getByTestId('task-filter-all').click();
    await page.getByTestId('task-layout-list').click();
    const cards = page.locator('.tw-list > article');
    assert.equal(await cards.first().getAttribute('data-testid'), 'task-card-low-job');
    await page.getByTestId('task-sort').selectOption('priority');
    assert.equal(await cards.first().getAttribute('data-testid'), 'task-card-high-job');
    await page.getByTestId('task-priority-low-job').selectOption('high');
    await page.waitForFunction(() => window.workspaceCalls.some(c => c.name === 'chat.priority' && c.args.id === 'low-job' && c.args.priority === 'high'));
    await page.getByTestId('task-resume-paused-job').click();
    await page.getByTestId('task-pause-paused-job').waitFor();
    await page.getByTestId('task-pause-paused-job').click();
    await page.getByTestId('task-resume-paused-job').waitFor();
    await page.getByTestId('task-card-high-job').getByRole('checkbox').check();
    await page.getByTestId('task-card-low-job').getByRole('checkbox').check();
    await page.evaluate(() => {window.workspaceFail = true;});
    await page.locator('.tw-selection button').filter({hasText: /Pause selected/}).click();
    await page.locator('.task-report').filter({hasText: 'Synthetic control failure'}).waitFor();
    assert.equal(await page.getByTestId('task-card-high-job').getByRole('checkbox').isChecked(), true);
    assert.equal(await page.getByTestId('task-card-low-job').getByRole('checkbox').isChecked(), false);
    report.checks.push('recent and priority ordering; immediate priority updates; pause/resume; partial failure preserves only failed selections');
    await page.getByTestId('task-card-low-job').getByRole('checkbox').check();
    await page.getByTestId('task-bulk-priority').selectOption('low');
    await page.getByTestId('task-bulk-priority-apply').click();
    await page.locator('.task-report').filter({hasText: 'Synthetic priority failure'}).waitFor();
    assert.equal(await page.getByTestId('task-card-high-job').getByRole('checkbox').isChecked(), true);
    assert.equal(await page.getByTestId('task-card-low-job').getByRole('checkbox').isChecked(), false);
    assert.equal(await page.getByTestId('task-priority-low-job').inputValue(), 'low');
    assert.deepEqual(await page.evaluate(() => window.workspaceCalls.find(c => c.name === 'jobs.priority').args), {ids: ['high-job', 'low-job'], priority: 'low'});
    report.checks.push('bulk priority sends captured eligible IDs; successful changes update cards; failed rows remain selected');
    await page.screenshot({path: path.join(output, 'windows-workspace-list.png')});
    await page.getByTestId('task-layout-board').click();
    for (const width of [1440, 1100, 900]) {
      await page.setViewportSize({width, height: 960});
      await page.screenshot({path: path.join(output, `windows-workspace-board-${width}.png`)});
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `board page overflow at ${width}`);
      report.layouts.push({view: 'board', width, overflow});
    }
    await page.setViewportSize({width: 1440, height: 960});
    await page.getByTestId('task-card-review-job').locator('.tw-card-title').click();
    await page.getByRole('button', {name: 'Git changes', exact: true}).click();
    const panel = page.locator('.changes-pane');
    const file = name => panel.locator('.changed-files button').filter({hasText: name});
    await file('src/review.ts').click();
    await panel.locator('[data-review-mark=toggle]').click();
    await page.waitForFunction(() => document.querySelector('.review-session-summary progress')?.value === 1);
    await panel.locator('.review-note-draft summary').click();
    await panel.locator('.review-note-draft textarea').fill('Confirm keyboard and reload behavior.');
    const chatDraft = page.locator('.agent-composer textarea');
    await chatDraft.fill('Existing review draft.');
    await panel.locator('.review-note-draft button').click();
    assert.match(await chatDraft.inputValue(), /^Existing review draft\./);
    assert.match(await chatDraft.inputValue(), /Confirm keyboard and reload behavior\./);
    await panel.locator('[data-review-nav=unreviewed]').click();
    await page.waitForFunction(() => document.querySelector('.review-file-navigation span')?.textContent === 'docs/guide.md');
    await panel.locator('[data-review-mark=toggle]').click();
    await page.waitForFunction(() => document.querySelector('.review-session-summary progress')?.value === 2);
    await page.reload();
    await page.getByRole('button', {name: 'Git changes', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('.review-session-summary progress')?.value === 2);
    await file('src/review.ts').click();
    await panel.locator('.review-note-draft summary').click();
    assert.equal(await panel.locator('.review-note-draft textarea').inputValue(), 'Confirm keyboard and reload behavior.');
    await page.evaluate(() => window.workspaceContentAdvance());
    await page.waitForFunction(() => document.querySelector('.review-session-summary progress')?.value === 1);
    assert.equal(await panel.locator('[data-review-mark=toggle]').getAttribute('aria-pressed'), 'false');
    await panel.locator('[data-review-filter=unreviewed]').click();
    assert.equal(await panel.locator('.changed-files button').count(), 1);
    assert.match(await panel.locator('.changed-files').innerText(), /src\/review.ts/);
    const downloading = page.waitForEvent('download');
    await panel.locator('[data-review-export]').click();
    const download = await downloading;
    const reportPath = path.join(output, 'windows-review-export.md');
    await download.saveAs(reportPath);
    const markdown = fs.readFileSync(reportPath, 'utf8');
    assert.match(markdown, /Code review report/);
    assert.match(markdown, /SHA-256/);
    assert.match(markdown, /Confirm keyboard and reload behavior\./);
    assert.match(markdown, /docs\/guide\.md/);
    report.checks.push('review report downloads current verified evidence and persisted notes');
    report.checks.push('review progress and notes survive reload; next unreviewed navigation; same Git status revision with changed bytes invalidates marks; notes append to draft');
    await page.screenshot({path: path.join(output, 'windows-workspace-review.png')});
    for (const [theme, language, width] of [['light', 'zh-CN', 1280], ['dark', 'ja', 900]]) {
      const translated = await browser.newPage({viewport: {width, height: 960}, deviceScaleFactor: 1.25});
      translated.on('pageerror', e => report.errors.push(e.message));
      await translated.addInitScript(fixture, {theme, language});
      await translated.goto(`http://127.0.0.1:${server.address().port}`);
      await translated.locator('.agent-rail .agent-logo').click();
      await translated.locator('.workspace-home').waitFor();
      await translated.locator('.agent-transcript').evaluate(node => {node.scrollTop = 0;});
      assert.equal(await translated.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await translated.screenshot({path: path.join(output, `windows-home-${theme}-${language}-${width}.png`)});
      await translated.locator('.task-queue-button').click();
      await translated.getByTestId('task-layout-board').click();
      assert.equal(await translated.locator('.tw-lane.lane-attention [data-testid=task-card-approval-job]').count(), 1);
      assert.equal(await translated.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await translated.screenshot({path: path.join(output, `windows-board-${theme}-${language}-${width}.png`)});
      report.layouts.push({view: 'home + board', theme, language, width, overflow: false});
      await translated.close();
    }
    assert.deepEqual(report.errors, []);
    report.status = 'passed';
  } catch (error) {report.status = 'failed'; report.failure = error.stack; process.exitCode = 1;}
  finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'windows-workspace-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
})();
