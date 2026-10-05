const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { installThreadMetrics } = require('../agent.cjs');

const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const REMOTE = '00000000-0000-0000-0000-000000000003';
const CLOUD = '00000000-0000-0000-0000-000000000004';
const UNKNOWN = '00000000-0000-0000-0000-000000000005';
const MARK = '[data-codex-thread-metrics]';
const fields = ['rounds', 'steps', 'llmDurationMs', 'toolDurationMs', 'firstTokenAvgMs',
  'tokensPerSecond', 'cacheHitPercent', 'inputTokens', 'outputTokens'];
const metrics = { rounds: 1, steps: 52, llmDurationMs: 2274000, toolDurationMs: 25000,
  firstTokenAvgMs: 5900, tokensPerSecond: 42, cacheHitPercent: 97, inputTokens: 5000000, outputTokens: 8000 };
const row = (id, host = 'local', kind = 'local', key = `local:${id}`) => `<div data-app-action-sidebar-thread-row
  data-app-action-sidebar-thread-id="${key}" data-app-action-sidebar-thread-host-id="${host}"
  data-app-action-sidebar-thread-kind="${kind}"><span data-thread-title>测试会话</span></div>`;
const composer = (id, name, active, placement = 'thread') => `<section data-page="${name}"
  data-app-shell-active-page="${active}" style="${active ? '' : 'display:none'}">
  <div data-codex-composer-root data-composer-placement="${placement}">
    <div data-above-composer-portal data-above-composer-conversation-id="${id}"></div>
    <div class="input-shell"><div data-composer-body><div data-composer-input>
      <div contenteditable="true" role="textbox" data-codex-composer aria-label="随心输入">保留草稿</div>
    </div><footer data-composer-footer-responsive><button data-model>GPT-6</button><button data-send>发送</button></footer></div></div>
    <div data-composer-rail>原有提示文字</div>
  </div></section>`;
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>
  *{box-sizing:border-box}body{margin:0;padding:12px;font:14px/1.5 -apple-system,sans-serif;background:#f7f7f7;color:#222}
  html.dark body{background:#202121;color:#eee}aside{height:32px;display:flex;gap:12px;overflow:hidden;font-size:11px}
  main{max-width:1050px;margin:40px auto 0}section{width:100%}[data-codex-composer-root]{min-width:0}
  .input-shell{border:1px solid #8885;border-radius:18px;padding:12px;background:#fff}
  html.dark .input-shell{background:#292929}[data-codex-composer]{min-height:54px;outline:none}
  footer{display:flex;justify-content:space-between;gap:12px;margin-top:10px}button{padding:5px 12px;border:0;border-radius:8px;background:#8882;color:inherit}
  [data-composer-rail]{margin-top:5px;color:#888;font-size:11px}
</style><aside>${row(A)}${row(B)}${row(REMOTE, 'remote-machine')}${row(CLOUD, 'local', 'chatgpt')}</aside>
<main>${composer(A, 'a', true)}${composer(B, 'b', false)}${composer('', 'home', false, 'home')}</main></html>`;

async function metricValues(page) {
  return page.locator(MARK + ' [data-metric]').evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [element.dataset.metric, element.textContent])));
}
async function assertBlank(page) {
  assert.deepEqual(await metricValues(page), Object.fromEntries(fields.map(field => [field, ''])));
}
async function update(page, perThread, checkedAt = Date.now(), ok = true) {
  await page.evaluate(data => window.__codexThreadMetrics.update(data), { ok, checkedAt, perThread });
}
async function select(page, name) {
  await page.evaluate(name => {
    for (const element of document.querySelectorAll('[data-page]')) {
      const active = element.dataset.page === name;
      element.setAttribute('data-app-shell-active-page', String(active));
      element.style.display = active ? '' : 'none';
    }
  }, name);
  await page.waitForTimeout(150);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 500 }, deviceScaleFactor: 2 });
    for (const theme of ['light', 'dark']) for (const width of [1180, 760, 384, 244, 204]) {
      await page.setViewportSize({ width, height: 560 });
      await page.setContent(fixture);
      await page.evaluate(theme => {
        document.documentElement.className = theme;
        window.originalEditors = [...document.querySelectorAll('[data-codex-composer]')];
        window.originalParents = window.originalEditors.map(editor => editor.parentElement);
        window.originalChildren = [...document.querySelector('[data-page="a"] [data-codex-composer-root]').children];
        window.sendCount = 0;
        document.querySelector('[data-page="a"] [data-send]').addEventListener('click', () => window.sendCount++);
      }, theme);
      await page.evaluate(`(${installThreadMetrics.toString()})()`);
      await update(page, { [A]: metrics });
      assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.requestedIds()), [A]);
      assert.deepEqual(await metricValues(page), { rounds: '1', steps: '52', llmDurationMs: '37m54s', toolDurationMs: '25s',
        firstTokenAvgMs: '5.9s', tokensPerSecond: '42', cacheHitPercent: '97%', inputTokens: '5M', outputTokens: '8k' });
      const geometry = await page.locator(MARK).evaluate(element => {
        const root = element.parentElement;
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, rootBottom: root.getBoundingClientRect().bottom,
          nativeBottom: root.querySelector('[data-composer-rail]').getBoundingClientRect().bottom,
          overflow: element.scrollWidth > element.clientWidth,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          childOverflow: [...element.children].some(child => child.getBoundingClientRect().right > box.right + .5),
          color: getComputedStyle(element).color, editorText: root.querySelector('[data-codex-composer]').textContent };
      });
      assert.ok(geometry.top > geometry.nativeBottom, `${theme}/${width}: strip must appear below the whole input`);
      assert.ok(geometry.bottom <= geometry.rootBottom + .5);
      assert.equal(geometry.overflow, false, `${theme}/${width}: metrics must fit the input width`);
      assert.equal(geometry.childOverflow, false, `${theme}/${width}: grouped metrics must fit the input width`);
      assert.equal(geometry.pageOverflow, false, `${theme}/${width}: metrics must not widen the page`);
      assert.equal(geometry.editorText, '保留草稿');
      assert.equal(geometry.color, theme === 'dark' ? 'rgb(165, 169, 173)' : 'rgb(115, 119, 124)');
      assert.equal(await page.evaluate(() => window.originalEditors.every((editor, i) => editor.isConnected &&
        editor.parentElement === window.originalParents[i]) && window.originalChildren.every((child, i) =>
        document.querySelector('[data-page="a"] [data-codex-composer-root]').children[i] === child)), true);
      await page.locator('[data-page="a"] [data-send]').click();
      assert.equal(await page.evaluate(() => window.sendCount), 1, 'native send handler must be preserved');
      assert.equal(await page.locator('[data-page="b"] ' + MARK).count(), 0, 'hidden kept-alive pages receive no strip');
      for (let i = 0; i < 3; i++) await page.evaluate(`(${installThreadMetrics.toString()})()`);
      assert.equal(await page.locator(MARK).count(), 1);
      if (width === 760) {
        const output = path.join(__dirname, 'artifacts'); fs.mkdirSync(output, { recursive: true });
        await page.screenshot({ path: path.join(output, `thread-metrics-${theme}.png`) });
      }
      await page.evaluate(() => window.__codexThreadMetrics.destroy());
      assert.equal(await page.locator(MARK).count(), 0);
      assert.equal(await page.locator('#codex-thread-metrics-style').count(), 0);
    }

    await page.setViewportSize({ width: 760, height: 560 });
    await page.setContent(fixture);
    await page.evaluate(() => {
      const NativeObserver = window.MutationObserver;
      window.metricsObservers = 0; window.metricsRefreshSchedules = 0; window.metricsIntervals = new Set();
      window.MutationObserver = class extends NativeObserver {
        constructor(callback) { super(callback); this.active = false; }
        observe(...args) { if (!this.active) { this.active = true; window.metricsObservers++; } return super.observe(...args); }
        disconnect() { if (this.active) { this.active = false; window.metricsObservers--; } return super.disconnect(); }
      };
      const nativeTimeout = window.setTimeout, nativeInterval = window.setInterval, nativeClear = window.clearInterval;
      window.setTimeout = (callback, delay, ...args) => { if (delay === 80) window.metricsRefreshSchedules++; return nativeTimeout(callback, delay, ...args); };
      window.setInterval = (callback, delay, ...args) => { const id = nativeInterval(callback, delay, ...args); if (delay === 1000) window.metricsIntervals.add(id); return id; };
      window.clearInterval = id => { window.metricsIntervals.delete(id); return nativeClear(id); };
    });
    await page.evaluate(`(${installThreadMetrics.toString()})()`);
    await update(page, { [A]: metrics });
    for (let i = 0; i < 5; i++) await page.evaluate(`(${installThreadMetrics.toString()})()`);
    assert.deepEqual(await page.evaluate(() => [window.metricsObservers, window.metricsIntervals.size]), [1, 1]);
    await page.waitForTimeout(200);
    const schedules = await page.evaluate(() => window.metricsRefreshSchedules);
    await update(page, { [A]: { ...metrics, steps: 53 } });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.metricsRefreshSchedules), schedules, 'own metric text updates must not schedule observer refresh loops');

    await select(page, 'b');
    await assertBlank(page);
    assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.requestedIds()), [B]);
    assert.equal(await page.locator('[data-page="a"] ' + MARK).count(), 0);
    assert.equal(await page.locator('[data-page="b"] ' + MARK).count(), 1);
    await update(page, { [B]: { rounds: 9, inputTokens: 0 } });
    assert.equal((await metricValues(page)).rounds, '9');
    assert.equal((await metricValues(page)).inputTokens, '0', 'zero is shown only when supplied');
    assert.equal((await metricValues(page)).llmDurationMs, '', 'unsupported fields remain blank');
    assert.match(await page.locator(MARK).textContent(), /LLM/);
    assert.match(await page.locator(MARK).textContent(), /首 token 平均/);
    assert.match(await page.locator(MARK).textContent(), /缓存命中/);
    await update(page, { [B]: metrics }, Date.now() - 31000);
    assert.equal((await metricValues(page)).rounds, '9', 'an older response must not overwrite the latest known values');
    await update(page, { [B]: metrics }, Date.now(), false);
    assert.equal((await metricValues(page)).rounds, '9');
    assert.equal(await page.locator(MARK).getAttribute('data-state'), 'cached');
    assert.match(await page.locator(MARK).getAttribute('title'), /保留上次已知数值/);
    await update(page, { [B]: metrics });
    const lastGood = await metricValues(page);
    await update(page, {});
    assert.deepEqual(await metricValues(page), lastGood, 'missing fields must retain the previous complete snapshot');

    // Invalid values must not become zero, NaN, an invented percent or a string.
    await update(page, { [B]: { rounds: -1, steps: 1.2, llmDurationMs: '1000', toolDurationMs: -100,
      firstTokenAvgMs: 'no', tokensPerSecond: -2, cacheHitPercent: 101, inputTokens: 1.1, outputTokens: null } });
    assert.deepEqual(await metricValues(page), lastGood, 'invalid fields must retain known values without inventing replacements');
    await update(page, { [B]: { ...metrics, complete: false } });
    assert.match(await page.locator(MARK).getAttribute('title'), /本地记录不完整/);
    await update(page, { [B]: { ...metrics, timingApproximate: true } });
    assert.equal((await metricValues(page)).llmDurationMs, '≈37m54s');
    assert.equal((await metricValues(page)).tokensPerSecond, '≈42');
    assert.equal((await metricValues(page)).firstTokenAvgMs, '5.9s', 'approximate response timings must not relabel logged first-token measurements');

    for (const id of [REMOTE, CLOUD, UNKNOWN]) {
      await page.locator('[data-page="b"] [data-above-composer-conversation-id]').evaluate((el, id) =>
        el.setAttribute('data-above-composer-conversation-id', id), id);
      await update(page, { [id]: metrics, [B]: metrics });
      await assertBlank(page);
      assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.requestedIds()), id === UNKNOWN ? [UNKNOWN] : [],
        'unproven candidates may be verified by the backend; explicit remote/cloud threads cannot be requested');
    }
    // Sidebar selection does not override a conflicting composer identity.
    await page.locator('[data-page="b"] [data-above-composer-conversation-id]').evaluate((el, id) => {
      el.setAttribute('data-above-composer-conversation-id', id);
      const conflict = el.cloneNode(); conflict.setAttribute('data-above-composer-conversation-id', '00000000-0000-0000-0000-000000000001'); el.after(conflict);
    }, B);
    await update(page, { [A]: metrics, [B]: metrics });
    await assertBlank(page);
    assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.requestedIds()), []);
    await select(page, 'home');
    assert.equal(await page.locator(MARK).count(), 0, 'new-chat input must not show the previous thread metrics');
    assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.requestedIds()), []);

    // Rerenders may discard the owned strip. Repair without moving native nodes.
    await select(page, 'a');
    await update(page, { [A]: metrics });
    await page.locator('[data-page="a"] [data-codex-composer-root]').evaluate(root => root.replaceWith(root.cloneNode(true)));
    await page.waitForTimeout(180);
    assert.equal(await page.locator(MARK).count(), 1);
    assert.equal((await metricValues(page)).rounds, '1');
    await page.locator(MARK).evaluate(strip => strip.remove());
    await page.waitForTimeout(1100);
    assert.equal(await page.locator(MARK).count(), 1, 'repair externally removed strip');
    await page.evaluate(() => window.__codexThreadMetrics.destroy());
    assert.deepEqual(await page.evaluate(() => [window.metricsObservers, window.metricsIntervals.size]), [0, 0]);
    await page.evaluate(() => document.body.append(document.createElement('div')));
    await page.waitForTimeout(150);
    assert.equal(await page.locator(MARK).count(), 0, 'destroyed installer must not recreate itself');
    const actor = 'a'.repeat(64), otherActor = 'b'.repeat(64), localScope = 'c'.repeat(64), homeScope = 'd'.repeat(64), revision = 'e'.repeat(64);
    await page.route('http://metrics-fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('http://metrics-fixture.test/');
    async function actorState(scopeId, reason = 'verified', pending = false) {
      await page.evaluate(state => {
        window.accountFixture = state;
        window.__codexThreadMetricsAccount = { snapshot: () => window.accountFixture };
        window.__codexThreadMetrics?.refresh();
      }, { scopeId, reason, pending, supported: true, checkedAt: Date.now(), changeEpoch: 1 });
    }
    await actorState(actor);
    await page.evaluate(`(${installThreadMetrics.toString()})()`);
    const verified = (data = metrics, extra = {}) => ({ ...data, scopeId: localScope, localVerified: true, revision,
      rolloutSize: 100, rolloutMtimeMs: 1, complete: true, ...extra });
    async function verifiedUpdate(perThread, persistedPerThread = {}) {
      await page.evaluate(data => window.__codexThreadMetrics.update(data),
        { ok: true, checkedAt: Date.now(), scopeId: homeScope, perThread, persistedPerThread });
    }
    await verifiedUpdate({ [A]: verified(), [B]: verified({ ...metrics, rounds: 7, steps: 99 }) });
    const savedA = await metricValues(page);
    await select(page, 'b');
    assert.equal((await metricValues(page)).rounds, '7');
    await select(page, 'a');
    assert.deepEqual(await metricValues(page), savedA, 'switching back restores every collected field');
    await verifiedUpdate({ [A]: verified({ rounds: null, steps: 2 }, { complete: false, countersLowerBound: true, stepsComplete: false }) });
    assert.equal((await metricValues(page)).rounds, '1');
    assert.equal((await metricValues(page)).steps, '52', 'partial counts cannot overwrite a greater complete historical count');
    await verifiedUpdate({ [A]: verified({ rounds: 1 }, { complete: false, countersLowerBound: true, roundsComplete: true, stepsComplete: false }) });
    assert.equal((await metricValues(page)).rounds, '1', 'an indexed complete round count overrides the partial-history flag');
    await page.evaluate(() => window.__codexThreadMetrics.update({ ok: false, checkedAt: Date.now(), scopeId: 'd'.repeat(64), perThread: {} }));
    assert.deepEqual(await metricValues(page), savedA);
    assert.equal(await page.locator(MARK).getAttribute('data-state'), 'cached');
    assert.match(await page.locator(MARK + ' [data-metric="steps"]').getAttribute('title'), /保留的历史数值/);
    for (let i = 0; i < 3; i++) await page.evaluate(`(${installThreadMetrics.toString()})()`);
    assert.deepEqual(await metricValues(page), savedA, 'reinjection preserves per-thread history');
    const pending = await page.evaluate(() => window.__codexThreadMetrics.pendingSnapshots());
    assert.equal(pending.length, 2);
    assert.equal(pending.every(value => value.actorScopeId === actor && value.scopeId === localScope), true);
    await page.evaluate(records => window.__codexThreadMetrics.ackPersisted(records.map(record => ({ ...record, pendingVersion: record.pendingVersion - 1 }))), pending);
    assert.equal(await page.evaluate(() => window.__codexThreadMetrics.pendingSnapshots().length), 2, 'stale acknowledgements cannot drop dirty snapshots');
    await page.evaluate(records => window.__codexThreadMetrics.ackPersisted(records.map(record => ({ ...record, producerId: '00000000-0000-0000-0000-000000000099' }))), pending);
    assert.equal(await page.evaluate(() => window.__codexThreadMetrics.pendingSnapshots().length), 2, 'an acknowledgement from another renderer cannot drop current snapshots');
    await page.evaluate(records => window.__codexThreadMetrics.ackPersisted(records), pending);
    assert.equal(await page.evaluate(() => window.__codexThreadMetrics.pendingSnapshots().length), 0);
    await actorState(actor, 'verified', true);
    assert.deepEqual(await metricValues(page), savedA, 'periodic actor revalidation preserves last-known fields');
    assert.equal(await page.locator(MARK).getAttribute('data-state'), 'cached');
    await actorState(actor);

    const background = '00000000-0000-0000-0000-000000000090';
    await page.evaluate(({ a, b }) => {
      const since = Date.now();
      window.__codexThreadPerformance = { status: () => ({ supported: true, active: true, connected: true }),
        snapshot: id => id === a || id === b ? null : ({ llmDurationMs: 500, tokensPerSecond: 120, timingApproximate: true,
          observedSince: since, observedResponses: 2, lastSampleAt: since,
          observedRounds: 4, observedSteps: 6, countersLowerBound: true,
          countersObservedSince: since, countersUpdatedAt: since, privatePrompt: 'PRIVATE' }), reset() {} };
    }, { a: A, b: B });
    await page.evaluate(id => window.__codexThreadMetrics.captureThread(id), background);
    assert.equal((await page.evaluate(() => window.__codexThreadMetrics.pendingSnapshots())).some(value => value.threadId === background), false,
      'background samples await fresh local provenance before they can be persisted');
    await verifiedUpdate({ [background]: verified({}, { complete: false }) });
    assert.equal((await page.evaluate(() => window.__codexThreadMetrics.pendingSnapshots())).some(value => value.threadId === background), true,
      'known-local background samples are saved even before their input is visible');
    assert.equal(JSON.stringify(await page.evaluate(() => window.__codexThreadMetrics.pendingSnapshots())).includes('PRIVATE'), false);
    const observed = Array.from({ length: 12 }, (_, index) => `00000000-0000-0000-0000-${String(index + 80).padStart(12, '0')}`);
    await page.evaluate(ids => ids.forEach(id => window.__codexThreadMetrics.captureThread(id)), observed);
    const requested = new Set();
    for (let i = 0; i < 4; i++) for (const id of await page.evaluate(() => window.__codexThreadMetrics.requestedIds())) requested.add(id);
    assert.equal(observed.every(id => requested.has(id)), true, 'bounded rotating verification batches cannot starve background conversations');
    await page.evaluate(() => delete window.__codexThreadPerformance);

    // The DOM can use a client-new-thread alias or omit a collapsed sidebar row.
    // Current backend proof, rather than a persisted host flag, resolves it.
    await page.locator('[data-app-action-sidebar-thread-id]').first().evaluate(element => element.setAttribute('data-app-action-sidebar-thread-id', 'local:client-new-thread:alias'));
    await page.evaluate(() => window.__codexThreadMetrics.refresh());
    assert.equal((await metricValues(page)).rounds, '1');
    await page.reload();
    await actorState(actor);
    await page.evaluate(`(${installThreadMetrics.toString()})()`);
    await verifiedUpdate({ [A]: verified({}, { complete: false }) });
    assert.deepEqual(await metricValues(page), savedA, 'reload restores numeric history under matching actor/local provenance');
    assert.equal(await page.locator(MARK).getAttribute('data-state'), 'cached');
    assert.equal(await page.evaluate(() => window.__codexThreadMetrics.pendingSnapshots().length), 1, 'local-storage restoration remains dirty until the durable store acknowledges it');
    const restored = await page.evaluate(id => {
      const { pendingVersion, producerId, ...record } = window.__codexThreadMetrics.pendingSnapshots().find(record => record.threadId === id);
      return record;
    }, A);
    await actorState(null, 'connection-change', true);
    assert.deepEqual(await metricValues(page), savedA, 'ordinary disconnected identity checks retain renderer history');
    await actorState(null, 'account-change', true);
    await assertBlank(page);
    await actorState(otherActor);
    await verifiedUpdate({ [A]: verified({}, { complete: false }) });
    await assertBlank(page);
    assert.equal((await page.evaluate(() => window.__codexThreadMetrics.pendingSnapshots())).some(value => value.actorScopeId === actor), true,
      'old-account dirty snapshots remain independently flushable after switching account');
    await actorState(actor);
    await page.evaluate(({ actor, localScope, id }) => localStorage.removeItem(`codex-usage-badge.thread-metrics.v1:${actor}:${localScope}:${id}`), { actor, localScope, id: A });
    await verifiedUpdate({ [A]: verified({}, { complete: false }) }, { [A]: restored });
    assert.deepEqual(await metricValues(page), savedA, 'matching durable-store history restores after returning to the original actor');
    const newer = structuredClone(restored);
    newer.fields.tokensPerSecond = { value: 350, at: Date.now(), source: 'monitor', approximate: true, lowerBound: false,
      observedSince: Date.now() - 1000, observedResponses: 1 };
    newer.updatedAt = newer.fields.tokensPerSecond.at;
    await verifiedUpdate({ [A]: verified({}, { complete: false }) }, { [A]: newer });
    assert.equal((await metricValues(page)).tokensPerSecond, '≈350', 'newer canonical fields replace stale memory/local-storage values');

    // All collected conversations remain saved; there is no persistent 64-row eviction.
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, index) =>
      [`00000000-0000-0000-0000-${String(index + 100).padStart(12, '0')}`, verified({ rounds: index + 1, inputTokens: 10 })]));
    await verifiedUpdate(many);
    assert.ok(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('codex-usage-badge.thread-metrics.v1:')).length) >= 72);
    assert.ok(await page.evaluate(() => window.__codexThreadMetrics.pendingSnapshots().length) >= 70);
    await verifiedUpdate({ [A]: verified({ rounds: 2 }, { revision: 'f'.repeat(64), rolloutSize: 20, rolloutMtimeMs: 2 }) });
    assert.equal((await metricValues(page)).rounds, '2');
    assert.equal((await metricValues(page)).steps, '', 'actual rollout replacement clears values from the old revision');
    await verifiedUpdate({ [A]: verified(), [B]: verified({ ...metrics, rounds: 7 }) });
    const beforeArchive = await page.evaluate(id => window.__codexThreadMetrics.pendingSnapshots().find(record => record.threadId === id), A);
    const { producerId: oldProducer, pendingVersion: oldVersion, ...oldSaved } = beforeArchive;
    await page.evaluate(({ id, saved, actor }) => {
      localStorage.setItem(`codex-usage-badge.thread-metrics.v1:${actor}:${'9'.repeat(64)}:${id}`,
        JSON.stringify({ ...saved, actorScopeId: actor, scopeId: '9'.repeat(64) }));
      window.__codexThreadMetrics.archiveThread(id);
    }, { id: A, saved: oldSaved, actor: otherActor });
    await assertBlank(page);
    const archiveRequest = await page.evaluate(() => window.__codexThreadMetrics.pendingArchives());
    assert.equal(archiveRequest.length, 1); assert.equal(archiveRequest[0].threadId, A);
    assert.equal(await page.evaluate(id => Object.keys(localStorage).some(key => key.startsWith('codex-usage-badge.thread-metrics.v1:') && key.endsWith(':' + id)), A), false,
      'archive deletes matching metric keys across every actor/local namespace');
    assert.equal(await page.evaluate(id => window.__codexThreadMetrics.pendingSnapshots().some(record => record.threadId === id), A), false);
    await page.evaluate(({ id, acknowledgement }) => {
      window.__codexThreadMetrics.archiveThread(id); window.__codexThreadMetrics.captureThread(id);
      window.__codexThreadMetrics.ackPersisted([acknowledgement]);
    }, { id: A, acknowledgement: beforeArchive });
    assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.pendingArchives()), archiveRequest, 'duplicate archive notifications are idempotent');
    await verifiedUpdate({ [A]: verified() }, { [A]: oldSaved });
    await assertBlank(page);
    assert.ok((await page.evaluate(() => window.__codexThreadMetrics.requestedIds())).includes(A), 'blocked visible IDs remain available for authoritative archive status checks');
    await select(page, 'b');
    assert.equal((await metricValues(page)).rounds, '7', 'archiving another conversation preserves the current one');
    await page.evaluate(id => window.__codexThreadMetrics.unarchiveThread(id), A);
    assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.pendingArchives()), archiveRequest, 'rapid unarchive does not cancel deletion of old saved statistics');
    await select(page, 'a');
    await assertBlank(page);
    await verifiedUpdate({ [A]: verified({}, { archived: false }) }, { [A]: oldSaved });
    await assertBlank(page);
    await page.evaluate(records => window.__codexThreadMetrics.ackArchives(records.map(record => ({ ...record, archivedAt: record.archivedAt - 1 }))), archiveRequest);
    assert.equal(await page.evaluate(() => window.__codexThreadMetrics.pendingArchives().length), 1, 'an old archive acknowledgement cannot consume a newer deletion request');
    await page.evaluate(records => window.__codexThreadMetrics.ackArchives(records), archiveRequest);
    assert.equal(await page.evaluate(() => window.__codexThreadMetrics.pendingArchives().length), 0);
    await verifiedUpdate({ [A]: verified({ rounds: 3, tokensPerSecond: 80 }, { archived: false }) });
    assert.equal((await metricValues(page)).rounds, '3');
    assert.equal((await metricValues(page)).tokensPerSecond, '80', 'fresh verified collection resumes after unarchive');
    await page.evaluate(({ id, cutoff }) => window.__codexThreadMetrics.discardBefore(id, cutoff), { id: A, cutoff: archiveRequest[0].archivedAt });
    assert.equal((await metricValues(page)).rounds, '3', 'late purge notifications remove only pre-archive fields');
    await select(page, 'b');
    await page.evaluate(id => window.__codexThreadMetrics.archiveThread(id), A);
    assert.equal((await metricValues(page)).rounds, '7');
    const secondArchive = await page.evaluate(() => window.__codexThreadMetrics.pendingArchives());
    await page.evaluate(records => window.__codexThreadMetrics.ackArchives(records), archiveRequest);
    assert.deepEqual(await page.evaluate(() => window.__codexThreadMetrics.pendingArchives()), secondArchive, 'old deletion acknowledgements cannot drop a second archive cycle');
    await page.waitForTimeout(10);
    await verifiedUpdate({ [A]: verified({ rounds: 4 }, { archived: false }) }, { [A]: oldSaved });
    await select(page, 'a');
    assert.equal((await metricValues(page)).rounds, '4', 'fresh database status can recover from a missed native unarchive event');
    assert.equal((await metricValues(page)).steps, '', 'deleted saved fields remain absent until freshly collected');
    await page.evaluate(({ id, cutoff }) => window.__codexThreadMetrics.update({ ok: true, checkedAt: Date.now(),
      scopeId: 'd'.repeat(64), perThread: {}, archivedIds: [id], purgedBefore: { [id]: cutoff } }), { id: A, cutoff: Date.now() });
    await assertBlank(page);
    await page.evaluate(() => { localStorage.setItem('unrelated-setting', 'keep'); window.__codexThreadMetrics.destroy({ clearStorage: true }); });
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('codex-usage-badge.thread-metrics.v1:'))), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('unrelated-setting')), 'keep');
    console.log('PASS Thread metrics footer: live composer structure, both themes, narrow layout, preserved input controls, local identity, kept-alive page switching, blanks/staleness, reinjection, observer loops and cleanup');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
