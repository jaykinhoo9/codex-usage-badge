const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {installContextWindowIndicator, resolveComposerBinding, formatContextSnapshot, refreshContextWindows, ContextWindowReader} = require('../agent.cjs');
const ids = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];
const bootstrap = `(${installContextWindowIndicator.toString()})(${resolveComposerBinding.toString()})`;
const mark = '[data-codex-context-window]';
const fixture = `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;padding:20px;font:14px/20px system-ui}html.dark{background:#181818;color:#eee}
  [data-codex-composer-root]{width:var(--composer-width,450px);margin-top:100px;border:1px solid #888;border-radius:12px;padding:8px}
  [contenteditable]{min-height:40px;white-space:pre-wrap}.toolbar{display:flex;align-items:center;gap:4px;height:28px}
  .models{display:flex;align-items:center;gap:4px;min-width:0;flex:1}.model-wrap{display:block;min-width:0}
  button{height:28px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}
</style>${[...ids, ids[0]].map((id, i) => `<section data-codex-composer-root id="composer-${i}" ${i === 2 ? 'style="display:none"' : ''}>
  <div data-above-composer-conversation-id="${id}"></div><div contenteditable data-codex-composer></div>
  <div class="toolbar"><button data-add>+</button><div class="models"><span class="model-wrap"><button data-composer-navigation-target="reasoning">模型名称较长的一个合成选项 / High</button></span></div><button data-send>发送</button></div>
</section>`).join('')}`;
async function installProps(page) {
  await page.evaluate(() => {
    window.setBinding = (index, {host = 'local', model = 'model-A', threadId, conflict = false} = {}) => {
      const root = document.getElementById(`composer-${index}`), input = root.querySelector('[data-codex-composer]');
      threadId ||= root.querySelector('[data-above-composer-conversation-id]').getAttribute('data-above-composer-conversation-id');
      root.querySelectorAll('[data-above-composer-conversation-id]').forEach(node => node.setAttribute('data-above-composer-conversation-id', threadId));
      const outer = {memoizedProps: {conversationId: threadId, hostId: host}, return: null};
      input.__reactFiber$fixture = {memoizedProps: {conversationId: threadId, permissionsHostId: 'ignored-permissions-host'}, return: outer};
      if (conflict) outer.return = {memoizedProps: {conversationId: threadId, hostId: 'conflicting-host'}, return: null};
      const button = root.querySelector('[data-composer-navigation-target="reasoning"]');
      button.__reactFiber$fixture = {memoizedProps: {model}, return: {memoizedProps: {executionTargetHostId: host}, return: null}};
    };
    for (let i = 0; i < 3; i++) window.setBinding(i);
    window.nativeClicks = 0; window.nativeKeys = 0;
    document.querySelectorAll('.toolbar').forEach(node => {
      node.addEventListener('click', () => window.nativeClicks++);
      node.addEventListener('keydown', e => { if (e.key === 'Enter') window.nativeKeys++; });
    });
  });
}
const data = used => formatContextSnapshot({last_token_usage: {total_tokens: used}, model_context_window: 100});
async function bindings(page) { return page.evaluate(() => window.__codexContextWindow.bindings()); }
async function update(page, requested, values = [38, 90]) {
  await page.evaluate(updates => window.__codexContextWindow.update(updates), requested.map((b, i) => ({...b, value: data(values[i] ?? values[0])})));
}
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined});
  const errors = [];
  try {
    const page = await browser.newPage({viewport: {width: 700, height: 650}});
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent(fixture); await installProps(page);
    const before = await page.locator('[data-codex-composer-root]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    await page.locator('[contenteditable]').first().focus();
    await page.evaluate(bootstrap);
    assert.equal(await page.locator(mark).count(), 2, 'hidden composers are ignored');
    let requested = await bindings(page);
    assert.deepEqual(requested.map(b => [b.host, b.threadId, b.model]), ids.map(id => ['local', id, 'model-A']));
    assert.equal(await page.locator(mark).first().getAttribute('aria-valuenow'), null);
    await update(page, requested);
    assert.deepEqual(await page.locator(mark).evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-valuenow'))), ['38', '90']);
    assert.equal(await page.locator('[contenteditable]').first().evaluate(node => document.activeElement === node), true, 'injection preserves input focus');
    for (const theme of ['light', 'dark']) for (const width of [450, 240]) {
      await page.evaluate(({theme, width}) => { document.documentElement.className = theme; document.documentElement.style.setProperty('--composer-width', `${width}px`); }, {theme, width});
      await page.evaluate(() => window.__codexContextWindow.refresh());
      assert.deepEqual(await page.locator('[data-codex-composer-root]').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height)), before);
      const geometry = await page.locator(mark).evaluateAll(nodes => nodes.map(n => {
        const r = n.getBoundingClientRect(), b = n.nextElementSibling.querySelector('button').getBoundingClientRect(), svg = n.querySelector('svg').getBoundingClientRect();
        const root = n.closest('[data-codex-composer-root]').getBoundingClientRect();
        return {width: r.width, height: r.height, svgWidth: svg.width, svgHeight: svg.height, gap: b.left - r.right,
          aligned: Math.abs(b.y + b.height / 2 - r.y - r.height / 2) < .5, contained: r.x >= root.x && b.right < root.right};
      }));
      for (const g of geometry) assert.deepEqual(g, {width: 28, height: 28, svgWidth: 14, svgHeight: 14, gap: 6, aligned: true, contained: true});
    }
    const ring = page.locator(mark).first(), tooltip = page.locator('#codex-context-window-tooltip');
    await ring.hover(); await page.waitForTimeout(100); assert.equal(await tooltip.isVisible(), false);
    await tooltip.waitFor({state: 'visible'});
    assert.match(await tooltip.textContent(), /上下文已用 38%\n38 \/ 100 Token\n剩余 62 Token\n最近一次模型请求统计/);
    await page.keyboard.press('Escape'); assert.equal(await tooltip.isVisible(), false);
    await page.mouse.move(650, 600); await ring.focus(); assert.equal(await tooltip.isVisible(), true);
    await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => window.nativeKeys), 0);
    await page.locator('[contenteditable]').first().focus(); assert.equal(await tooltip.isVisible(), false);
    await ring.click(); assert.equal(await page.evaluate(() => window.nativeClicks), 0);
    await page.locator('[data-send]').first().click(); assert.equal(await page.evaluate(() => window.nativeClicks), 1);
    await page.emulateMedia({reducedMotion: 'reduce'});
    assert.equal(await ring.locator('.context-progress').evaluate(n => getComputedStyle(n).transitionDuration), '0s');
    await page.emulateMedia({reducedMotion: 'no-preference'});
    assert.equal(await ring.locator('.context-progress').evaluate(n => getComputedStyle(n).transitionDuration), '0.18s, 0.18s');
    // The delivery boundary rechecks identity before applying asynchronous data.
    const old = requested[0];
    await page.evaluate(now => { window.realContextNow = Date.now; Date.now = () => now; window.setBinding(0, {model: 'model-B'}); }, old.changedAt);
    await update(page, [old]);
    assert.equal(await ring.getAttribute('aria-valuenow'), null);
    let next = (await bindings(page))[0]; assert.equal(next.requireFresh, true); assert.ok(next.bindingVersion > old.bindingVersion);
    const modelBTime = next.changedAt;
    await page.evaluate(() => window.setBinding(0, {model: 'model-A'}));
    next = (await bindings(page))[0]; assert.ok(next.bindingVersion > old.bindingVersion + 1);
    assert.ok(next.changedAt > modelBTime && modelBTime > old.changedAt, 'rapid switches within one clock millisecond advance the source baseline');
    await page.evaluate(() => { Date.now = window.realContextNow; delete window.realContextNow; });
    await update(page, [old]); assert.equal(await ring.getAttribute('aria-valuenow'), null, 'A/B/A cannot reuse the first A delivery');
    await update(page, [next], [25]); assert.equal(await ring.getAttribute('aria-valuenow'), '25');
    assert.equal(await page.locator(mark).nth(1).getAttribute('aria-valuenow'), '90', 'other composer remains isolated');
    // Duplicate portal values are accepted, but conflicting identities are unknown.
    await page.evaluate(() => {
      const root = document.querySelector('[data-codex-composer-root]');
      root.append(root.querySelector('[data-above-composer-conversation-id]').cloneNode());
    });
    assert.equal((await bindings(page)).length, 2);
    await page.evaluate(() => document.querySelector('[data-codex-composer-root]').lastElementChild.setAttribute('data-above-composer-conversation-id', 'conflicting-thread'));
    assert.equal((await bindings(page)).length, 1); assert.equal(await ring.getAttribute('aria-valuenow'), null);
    await page.evaluate(() => document.querySelector('[data-codex-composer-root]').lastElementChild.remove());
    await page.evaluate(() => window.setBinding(0, {conflict: true})); assert.equal((await bindings(page)).length, 1);
    await page.evaluate(() => window.setBinding(0, {host: 'remote-machine'}));
    assert.equal((await bindings(page))[0].host, 'remote-machine', 'remote execution host is never replaced by local permissions');
    await page.evaluate(() => window.setBinding(0));
    await page.evaluate(() => {
      const native = document.createElement('span'); native.id = 'native-context'; native.role = 'img'; native.setAttribute('aria-label', '上下文窗口用量');
      native.innerHTML = '<svg width="14" height="14"><circle r="6" cx="7" cy="7"/></svg>';
      document.querySelector('[data-codex-composer-root] .toolbar').append(native);
    });
    await page.waitForFunction(() => document.querySelector('[data-codex-context-window]').hidden);
    assert.equal((await bindings(page)).length, 1, 'visible native ring suppresses only its own composer');
    await page.evaluate(() => document.getElementById('native-context').hidden = true);
    await page.waitForFunction(() => !document.querySelector('[data-codex-context-window]').hidden);
    for (let i = 0; i < 3; i++) await page.evaluate(bootstrap);
    assert.equal(await page.locator(mark).count(), 2); assert.equal(await page.locator('#codex-context-window-style').count(), 1);
    // Backend requests and responses stay scoped to each window, including an offline peer.
    const second = await browser.newPage();
    await second.setContent(fixture); await installProps(second); await second.evaluate(bootstrap);
    await second.evaluate(() => document.getElementById('composer-0').remove());
    const session = target => ({evaluate: async expression => ({result: {value: await target.evaluate(expression)}})});
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-context-ui-'));
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
      for (const [i, threadId] of ids.entries()) {
        const log = path.join(home, `synthetic-${i}.jsonl`), used = i ? 75 : 5;
        const usage = {input_tokens: used, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: used};
        const records = [
          ['turn_context', {turn_id: 'turn', root_turn_id: 'turn', model: 'model-A'}],
          ['token_usage_record', {thread_id: threadId, turn_id: 'turn', root_turn_id: 'turn', response_id: 'response', usage, thread_token_usage: usage}],
          ['event_msg', {type: 'token_count', info: {last_token_usage: usage, total_token_usage: usage, model_context_window: 100}}]
        ];
        fs.writeFileSync(log, records.map(([type, payload], index) => JSON.stringify({type, payload, ordinal: index + 1, timestamp: new Date(Date.now() + 1000).toISOString()}) + '\n').join(''));
        db.prepare('INSERT INTO threads VALUES (?, ?)').run(threadId, log);
      }
      await refreshContextWindows({sessions: new Map([['first', session(page)], ['second', session(second)], ['offline', {evaluate: async () => {throw Error('offline');}}]])}, new ContextWindowReader({home}));
    } finally { db.close(); fs.rmSync(home, {recursive: true, force: true}); }
    assert.equal(await second.locator(mark).getAttribute('aria-valuenow'), '75');
    assert.deepEqual(await page.locator(mark).evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-valuenow'))), ['5', '75']);
    await second.close();
    await page.evaluate(() => {
      const originalNow = Date.now, now = Date.now();
      Date.now = () => now + 17001;
      try { window.__codexContextWindow.refresh(); } finally { Date.now = originalNow; }
    });
    assert.equal(await ring.getAttribute('aria-valuenow'), null, 'lost backend heartbeat clears the visible meter');
    requested = await bindings(page); await update(page, requested, [5, 75]);
    assert.equal(await ring.getAttribute('aria-valuenow'), '5', 'heartbeat recovery restores the snapshot');
    const beforeRemount = requested[0];
    assert.equal(beforeRemount.requireFresh, true, 'the current binding has a model-switch baseline before remount');
    await page.evaluate(() => {
      const root = document.getElementById('composer-0'); root.replaceWith(root.cloneNode(true)); window.setBinding(0);
    });
    requested = await bindings(page);
    const afterRemount = requested.find(binding => binding.threadId === ids[0]);
    assert.notEqual(afterRemount.id, beforeRemount.id);
    assert.equal(afterRemount.requireFresh, true, 'a remount retains the observed model-switch baseline');
    assert.equal(afterRemount.changedAt, beforeRemount.changedAt);
    assert.equal(await page.locator(mark).count(), 2, 'a remounted composer has exactly one indicator');
    await update(page, [beforeRemount]); assert.equal(await page.locator(mark).first().getAttribute('aria-valuenow'), null);
    await page.evaluate(() => { window.__codexContextWindow.destroy(); });
    assert.equal(await page.locator(`${mark},#codex-context-window-style,#codex-context-window-tooltip`).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS context UI: real-shape anchors, themes, narrow width, hover/focus/Escape, reduced motion, native deduplication, A/B/A races, identity conflicts, window isolation and cleanup');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
