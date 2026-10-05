const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { installThreadPerformanceMonitor, createThreadPerformanceTracker, installThreadMetrics } = require('../agent.cjs');

const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const TURN = '00000000-0000-0000-0000-000000000003';
const PRIVATE = 'PRIVATE_PROMPT_REASONING_COMMAND_AND_TOOL_OUTPUT';
const tokens = outputTokens => ({ totalTokens: 1000 + outputTokens, inputTokens: 1000,
  cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens, reasoningOutputTokens: 20 });
const fixture = `<!doctype html><html><meta charset="UTF-8"><style>
  body{font:14px sans-serif;margin:16px;background:#202121;color:#eee}
  [data-codex-composer-root]{max-width:720px;margin-top:40px}[data-codex-composer]{padding:12px;min-height:50px;border:1px solid #777;border-radius:12px}
</style><div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:${A}" data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-kind="local"></div>
<div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:${B}" data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-kind="local"></div>
<div data-app-shell-active-page="true"><div data-codex-composer-root data-composer-placement="thread">
<div data-above-composer-conversation-id="${A}"></div><div data-codex-composer contenteditable="true">保留输入</div><button>发送</button></div></div></html>`;

async function emit(page, method, params, options = {}) {
  await page.evaluate(({ method, params, options }) => {
    const data = { type: 'mcp-notification', hostId: 'local', method, params, ...(options.data || {}) };
    const source = options.source === 'window' ? window : options.source === 'frame' ? document.querySelector('iframe').contentWindow : null;
    window.dispatchEvent(new MessageEvent('message', { data, source, origin: options.origin || '' }));
  }, { method, params, options });
}
async function install(page, factory = createThreadPerformanceTracker) {
  await page.evaluate(`(${installThreadPerformanceMonitor.toString()})(${factory.toString()})`);
}
async function scalarValues(page) {
  return page.locator('[data-codex-thread-metrics] [data-metric]').evaluateAll(elements =>
    Object.fromEntries(elements.map(element => [element.dataset.metric, element.textContent])));
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.setContent(fixture);
    await install(page);
    assert.equal(await page.evaluate(() => window.__codexThreadPerformance.status().supported), false);
    assert.equal(await page.evaluate(id => window.__codexThreadPerformance.snapshot(id), A), null);
    await page.evaluate(() => window.__codexThreadPerformance.destroy());

    await page.evaluate(() => {
      window.codexWindowType = 'electron'; window.electronBridge = { windowType: 'electron' };
      window.factoryCount = 0; window.recorded = []; window.resetCount = 0; window.stopCount = 0; window.nativeCount = 0;
      window.addEventListener('message', () => window.nativeCount++);
      document.body.append(document.createElement('iframe'));
    });
    function spyFactory() {
      window.factoryCount++;
      return { record(message, receivedAt) { window.recorded.push({ message, receivedAt }); },
        snapshot() { return { llmDurationMs: 1000, tokensPerSecond: 100, timingApproximate: true,
          observedSince: 0, observedResponses: 1, lastSampleAt: Date.now() }; },
        reset() { window.resetCount++; }, stop() { window.stopCount++; }, status() { return { stopped: false }; } };
    }
    await install(page, spyFactory);
    for (let i = 0; i < 4; i++) await install(page, spyFactory);
    assert.equal(await page.evaluate(() => window.factoryCount), 1, 'reinjecting must preserve one listener and its measurements');
    const start = { threadId: A, turnId: TURN, startedAtMs: 1000, input: PRIVATE, delta: PRIVATE,
      item: { id: 'rs_fixture', type: 'reasoning', content: PRIVATE, summary: PRIVATE, command: PRIVATE } };
    await emit(page, 'item/started', start);
    assert.deepEqual(await page.evaluate(() => window.recorded[0].message), {
      method: 'item/started', params: { threadId: A, turnId: TURN, item: { id: 'rs_fixture', type: 'reasoning' }, startedAtMs: 1000 } });
    await emit(page, 'turn/started', { threadId: A, turn: { id: TURN, status: 'inProgress', items: [PRIVATE], error: PRIVATE }, prompt: PRIVATE });
    await emit(page, 'thread/tokenUsage/updated', { threadId: A, turnId: TURN,
      tokenUsage: { total: { ...tokens(100), prompt: PRIVATE }, last: { ...tokens(100), output: PRIVATE } } });
    assert.equal(await page.evaluate(() => JSON.stringify(window.recorded).includes('PRIVATE')), false, 'projected events must contain no prompts, text or tool outputs');
    const before = await page.evaluate(() => window.recorded.length);
    const ignored = [
      { source: 'window' }, { source: 'frame' }, { origin: 'https://example.test' },
      { data: { hostId: 'remote-machine' } }, { data: { type: 'fetch-response' } },
      { data: { marker: 'codex-host-chunked-message-v1' } }, { data: { isSnapshot: true } }, { data: { isReplay: true } },
    ];
    for (const options of ignored) await emit(page, 'item/started', start, options);
    await emit(page, 'item/reasoning/textDelta', { threadId: A, turnId: TURN, delta: PRIVATE });
    await emit(page, 'item/agentMessage/delta', { threadId: A, turnId: TURN, delta: PRIVATE });
    await emit(page, 'item/started', { ...start, item: { id: 'x', type: PRIVATE } });
    await emit(page, 'item/started', { ...start, threadId: PRIVATE });
    assert.equal(await page.evaluate(() => window.recorded.length), before, 'external, remote, replay, chunks, text deltas and unknown schemas must be ignored');
    assert.equal(await page.evaluate(() => window.resetCount), 2, 'trusted local replay/snapshot markers must invalidate continuity without ingesting historical events');
    assert.equal(await page.evaluate(() => window.nativeCount), before + ignored.length + 4, 'native listeners must still receive all messages');
    for (const state of ['error', 'connecting', 'restarting', 'disconnected']) {
      await emit(page, '', {}, { data: { type: 'codex-app-server-connection-changed', state } });
      assert.equal(await page.evaluate(id => window.__codexThreadPerformance.snapshot(id), A), null);
      await emit(page, 'item/started', start);
    }
    assert.equal(await page.evaluate(() => window.recorded.length), before);
    await emit(page, '', {}, { data: { type: 'codex-app-server-connection-changed', state: 'connected' } });
    await emit(page, 'item/started', start);
    assert.equal(await page.evaluate(() => window.recorded.length), before + 1);
    await page.evaluate(() => {
      window.hiddenFixture = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.hiddenFixture });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.evaluate(id => window.__codexThreadPerformance.snapshot(id), A), null);
    await emit(page, 'item/started', start);
    assert.equal(await page.evaluate(() => window.recorded.length), before + 1);
    await page.evaluate(() => { window.hiddenFixture = false; window.dispatchEvent(new Event('focus')); });
    assert.equal(await page.evaluate(() => window.__codexThreadPerformance.status().paused), false);
    assert.ok(await page.evaluate(() => window.resetCount) >= 4, 'connection and visibility transitions must discard interrupted measurements');
    await page.evaluate(() => { delete document.hidden; window.__codexThreadPerformance.destroy(); });
    await emit(page, 'item/started', start);
    assert.equal(await page.evaluate(() => window.stopCount), 1);
    assert.equal(await page.evaluate(() => window.recorded.length), before + 1, 'destroy must remove only our listener');

    // Exercise the real tracker through the real native-message projection and
    // footer, including independent data when the file reader is unavailable.
    await page.setContent(fixture);
    await page.evaluate(() => {
      window.codexWindowType = 'electron'; window.electronBridge = { windowType: 'electron' };
      window.fixtureClock = Date.now(); window.realDateNow = Date.now; Date.now = () => window.fixtureClock;
    });
    const base = await page.evaluate(() => Date.now());
    await install(page);
    await page.evaluate(`(${installThreadMetrics.toString()})()`);
    await page.evaluate(id => window.__codexThreadMetrics.update({ ok: true, checkedAt: Date.now(),
      perThread: { [id]: { rounds: 1, firstTokenAvgMs: 5900, inputTokens: 1000, outputTokens: 100 } } }), A);
    async function at(offset, method, params) {
      await page.evaluate(value => { window.fixtureClock = value; }, base + offset);
      await emit(page, method, params);
    }
    await at(100, 'turn/started', { threadId: A, turn: { id: TURN, status: 'inProgress', items: [PRIVATE] } });
    await at(202, 'item/started', { threadId: A, turnId: TURN, item: { id: 'rs_live', type: 'reasoning', content: PRIVATE }, startedAtMs: base + 200 });
    await at(401, 'item/completed', { threadId: A, turnId: TURN, item: { id: 'rs_live', type: 'reasoning', summary: PRIVATE }, completedAtMs: base + 400 });
    await at(451, 'item/started', { threadId: A, turnId: TURN, item: { id: 'exec_live', type: 'commandExecution', command: PRIVATE }, startedAtMs: base + 450 });
    await at(551, 'item/completed', { threadId: A, turnId: TURN, item: { id: 'exec_live', type: 'commandExecution', aggregatedOutput: PRIVATE }, completedAtMs: base + 550 });
    await at(700, 'thread/tokenUsage/updated', { threadId: A, turnId: TURN, tokenUsage: { total: tokens(100), last: tokens(100) } });
    await page.evaluate(() => window.__codexThreadMetrics.refresh());
    const measured = await page.evaluate(id => window.__codexThreadPerformance.snapshot(id), A);
    assert.equal(measured.llmDurationMs, 400); assert.equal(measured.tokensPerSecond, 250);
    assert.equal(measured.observedResponses, 1);
    assert.equal(JSON.stringify(measured).includes('PRIVATE'), false);
    let actual = await scalarValues(page);
    assert.equal(actual.llmDurationMs, '≈0.4s'); assert.equal(actual.tokensPerSecond, '≈250');
    assert.equal(actual.firstTokenAvgMs, '5.9s', 'observed model lifecycle must not invent or override logged TTFT');
    assert.match(await page.locator('[data-codex-thread-metrics]').getAttribute('title'), /最近5次有效完整观测，非严格服务端生成速度/);
    await page.evaluate(() => window.__codexThreadMetrics.update({ ok: false, checkedAt: Date.now(), perThread: {} }));
    actual = await scalarValues(page);
    assert.equal(actual.llmDurationMs, '≈0.4s'); assert.equal(actual.tokensPerSecond, '≈250');
    assert.equal(actual.rounds, '1'); assert.equal(actual.firstTokenAvgMs, '5.9s', 'idle reader failure retains logged values as history');
    assert.equal(await page.locator('[data-codex-thread-metrics]').getAttribute('data-state'), 'cached');
    await page.evaluate(value => { window.fixtureClock = value; window.__codexThreadMetrics.refresh(); }, base + 100000);
    assert.equal((await scalarValues(page)).tokensPerSecond, '≈250', 'completed sample remains valid while native monitor stays connected during idle');
    await page.locator('[data-above-composer-conversation-id]').evaluate((element, id) => element.setAttribute('data-above-composer-conversation-id', id), B);
    await page.evaluate(() => window.__codexThreadMetrics.refresh());
    assert.equal((await scalarValues(page)).tokensPerSecond, '', 'switching threads must not reuse another thread measurement');
    await page.locator('[data-above-composer-conversation-id]').evaluate((element, id) => element.setAttribute('data-above-composer-conversation-id', id), A);
    await page.locator('[data-app-action-sidebar-thread-row]').first().evaluate(element => element.setAttribute('data-app-action-sidebar-thread-host-id', 'remote'));
    await page.evaluate(() => window.__codexThreadMetrics.refresh());
    assert.equal((await scalarValues(page)).llmDurationMs, '', 'unverified local identity must hide even real monitor data');
    await page.locator('[data-app-action-sidebar-thread-row]').first().evaluate(element => element.setAttribute('data-app-action-sidebar-thread-host-id', 'local'));
    await page.evaluate(() => window.__codexThreadMetrics.refresh());
    const lastKnown = await scalarValues(page);
    await emit(page, 'thread/closed', { threadId: A });
    await emit(page, 'thread/archived', { threadId: A }, { source: 'window' });
    await emit(page, 'thread/archived', { threadId: A }, { data: { hostId: 'remote-machine' } });
    assert.deepEqual(await scalarValues(page), lastKnown, 'closing a thread and external/remote archive-shaped messages do not purge metrics');
    await page.evaluate(() => {
      window.archiveHidden = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.archiveHidden });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await emit(page, 'thread/archived', { threadId: A });
    assert.equal(Object.values(await scalarValues(page)).every(value => value === ''), true, 'trusted archive purges even while monitoring is paused');
    assert.equal(await page.evaluate(() => window.__codexThreadMetrics.pendingArchives().length), 1);
    await page.evaluate(value => { window.fixtureClock = value; }, base + 100010);
    await emit(page, 'thread/unarchived', { threadId: A });
    assert.equal(Object.values(await scalarValues(page)).every(value => value === ''), true, 'unarchive waits for fresh backend proof');
    await page.evaluate(({ id, value }) => {
      window.archiveHidden = false; delete document.hidden;
      window.fixtureClock = value; document.dispatchEvent(new Event('visibilitychange'));
      window.__codexThreadMetrics.update({ ok: true, checkedAt: value,
        perThread: { [id]: { localVerified: true, archived: false, complete: true } } });
    }, { id: A, value: base + 100020 });
    await page.evaluate(({ id, value }) => {
      window.fixtureClock = value;
      window.__codexThreadMetrics.discardBefore(id, value);
    }, { id: A, value: base + 100030 });
    const nextTurn = '00000000-0000-0000-0000-000000000099';
    await at(100100, 'turn/started', { threadId: A, turn: { id: nextTurn, status: 'inProgress' } });
    await at(100202, 'item/started', { threadId: A, turnId: nextTurn, item: { id: 'rs_after_purge', type: 'reasoning' }, startedAtMs: base + 100200 });
    await at(100401, 'item/completed', { threadId: A, turnId: nextTurn, item: { id: 'rs_after_purge', type: 'reasoning' }, completedAtMs: base + 100400 });
    await at(100700, 'thread/tokenUsage/updated', { threadId: A, turnId: nextTurn, tokenUsage: { total: tokens(200), last: tokens(100) } });
    await page.evaluate(() => window.__codexThreadMetrics.refresh());
    assert.equal((await scalarValues(page)).tokensPerSecond, '≈200', 'a late purge establishes a new eligible monitoring epoch instead of permanently disabling fresh samples');
    await emit(page, 'thread/archived', { threadId: A });
    await emit(page, 'thread/unarchived', { threadId: A });
    await page.evaluate(({ id, value }) => {
      window.fixtureClock = value;
      window.__codexThreadMetrics.update({ ok: true, checkedAt: value,
        perThread: { [id]: { localVerified: true, archived: false, complete: true } } });
    }, { id: A, value: base + 100800 });
    const batchedTurn = '00000000-0000-0000-0000-000000000098';
    await at(101100, 'turn/started', { threadId: A, turn: { id: batchedTurn, status: 'inProgress' } });
    await at(101202, 'item/started', { threadId: A, turnId: batchedTurn, item: { id: 'rs_after_batched_unarchive', type: 'reasoning' }, startedAtMs: base + 101200 });
    await at(101401, 'item/completed', { threadId: A, turnId: batchedTurn, item: { id: 'rs_after_batched_unarchive', type: 'reasoning' }, completedAtMs: base + 101400 });
    await at(101700, 'thread/tokenUsage/updated', { threadId: A, turnId: batchedTurn, tokenUsage: { total: tokens(300), last: tokens(100) } });
    await page.evaluate(() => window.__codexThreadMetrics.refresh());
    assert.equal((await scalarValues(page)).tokensPerSecond, '≈200', 'same-millisecond archive/unarchive keeps fresh monitoring eligible');
    await page.evaluate(() => {
      window.__codexThreadPerformance.destroy(); window.__codexThreadMetrics.destroy(); Date.now = window.realDateNow;
    });
    console.log('PASS Passive performance monitor: native envelope guards, numeric projection privacy, exact token counts and tool time, approximate labels, local identity, independent freshness, singleton, interruption reset and teardown');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
