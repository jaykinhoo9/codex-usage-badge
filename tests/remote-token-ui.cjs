'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { installThreadTokens } = require('../agent.cjs');
const { installExpression, collectRows } = require('../remote-tokens/remote-addon.cjs');
const id = '00000000-0000-0000-0000-000000000001';
const host = 'remote-ssh-discovered:server.example';
const row = (name, origin, kind = 'local') => `<div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="${kind}:${id}" data-app-action-sidebar-thread-host-id="${origin}" data-app-action-sidebar-thread-kind="${kind}" style="height:34px;display:flex"><span data-thread-title>${name}</span></div>`;
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  try {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage();
      try {
        await page.setContent(`<html class="${theme}"><input id="editor"><div id="quota">29%</div>${row('local', 'local')}${row('remote', host)}${row('other', 'remote-ssh-discovered:other.example')}${row('chatgpt', 'local', 'chatgpt')}</html>`);
        await page.locator('#editor').focus();
        const titles = await page.locator('[data-thread-title]').allTextContents();
        await page.evaluate(`(${installThreadTokens.toString()})()`);
        await page.evaluate(({ id }) => window.__codexThreadTokens.update({ ok: true, checkedAt: Date.now(), totals: { [id]: 10000 } }), { id });
        const api = () => page.evaluate(`(${collectRows.toString()})(${JSON.stringify([host])})`);
        assert.equal((await api()).installed, false);
        assert.equal(await page.evaluate(installExpression([host])), true);
        await page.evaluate(({ id }) => window.__codexThreadTokens.updateRemote({ ok: true, checkedAt: Date.now(), totals: { [id]: 20000000 } }), { id });
        const badges = page.locator('[data-codex-thread-tokens]');
        assert.deepEqual(await badges.evaluateAll(nodes => nodes.map(n => n.dataset.level)), ['1', '3', '0', '0']);
        assert.deepEqual(await page.evaluate(() => window.__codexThreadTokens.requestedIds()), [id]);
        assert.deepEqual((await api()).ids, [id]);
        assert.match(await badges.nth(1).getAttribute('aria-label'), /SSH 远程会话/);
        assert.equal(await page.locator('#editor').evaluate(el => el === document.activeElement), true);
        assert.equal(await page.locator('#quota').textContent(), '29%');
        assert.deepEqual(await page.locator('[data-thread-title]').allTextContents(), titles);
        assert.deepEqual(await page.locator('[data-app-action-sidebar-thread-row]').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height)), [34, 34, 34, 34]);
        // Original agent reinjection must preserve both sources.
        await page.evaluate(`(${installThreadTokens.toString()})()`);
        await page.evaluate(({ id }) => window.__codexThreadTokens.update({ ok: true, checkedAt: Date.now(), totals: { [id]: 300000000 } }), { id });
        assert.deepEqual(await badges.evaluateAll(nodes => nodes.map(n => n.dataset.level)), ['4', '3', '0', '0']);
        await page.evaluate(({ id }) => window.__codexThreadTokens.updateRemote({ ok: true, checkedAt: Date.now(), totals: { [id]: 0 } }), { id });
        assert.equal(await badges.nth(1).getAttribute('data-state'), 'ready');
        await page.evaluate(() => window.__codexThreadTokens.updateRemote({ ok: false, checkedAt: Date.now(), totals: {} }));
        assert.equal(await badges.nth(1).getAttribute('data-state'), 'unknown');
        await page.evaluate(({ id }) => window.__codexThreadTokens.updateRemote({ ok: true, checkedAt: Date.now() - 31000, totals: { [id]: 10 } }), { id });
        assert.equal(await badges.nth(1).getAttribute('data-state'), 'stale');
        await page.evaluate(() => window.__codexThreadTokens.restoreLocal());
        assert.equal((await api()).installed, false);
        assert.equal(await badges.first().getAttribute('data-level'), '4');
        assert.equal(await badges.nth(1).getAttribute('data-state'), 'unknown');
        // A lost connector lease restores local mode without relying on its process.
        await page.evaluate(installExpression([host]));
        await page.evaluate(() => { window.savedNow = Date.now; Date.now = () => window.savedNow() + 21000; });
        await page.waitForFunction(() => window.__codexThreadTokens.remoteSupport === 0, { timeout: 3000 });
        await page.evaluate(() => { Date.now = window.savedNow; window.__codexThreadTokens.refresh(); });
        assert.equal(await badges.first().getAttribute('data-level'), '4');
        await page.evaluate(() => { window.__codexThreadTokens.version = 99; });
        assert.equal(await page.evaluate(installExpression([host])), false);
        assert.equal(await page.evaluate(() => window.__codexThreadTokens.version), 99);
      } finally { await page.close(); }
    }
    console.log('PASS remote Token UI: opt-in, same-ID isolation, reinjection, stop/lease restore, unknown/stale/zero and unchanged layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
