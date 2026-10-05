'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../src/thread-metrics-account-scope.js'), 'utf8');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = (account, user) => crypto.createHash('sha256').update(JSON.stringify([account, user])).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
class Events {
  constructor() { this.listeners = new Map(); this.events = []; }
  addEventListener(type, callback) { let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatchEvent(event) { this.events.push(event); for (const callback of this.listeners.get(event.type) ?? []) callback(event); return true; }
  emit(data, source = null, origin = '') { this.dispatchEvent({ type: 'message', data, source, origin }); }
  count(type) { return this.listeners.get(type)?.size ?? 0; }
}
function fixture({ subtle = crypto.webcrypto.subtle, bridgeFailure = false, supported = true, timeoutMs = 100, minRefreshMs = 1, fixedNow = null } = {}) {
  const window = new Events(), requests = [], intervals = new Map(); let serial = 0;
  window.codexWindowType = supported ? 'electron' : 'browser';
  window.crypto = { subtle, randomUUID: crypto.randomUUID };
  window.electronBridge = { windowType: 'electron', sendMessageFromView(request) {
    requests.push(request); return bridgeFailure ? Promise.reject(Error('PRIVATE BRIDGE ERROR')) : Promise.resolve();
  } };
  const context = { window, TextEncoder, Uint8Array, Date: fixedNow === null ? Date : { now: () => fixedNow }, setTimeout, clearTimeout,
    setInterval(callback) { const id = ++serial; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } };
  const install = vm.runInNewContext(source + '\ninstallThreadMetricsAccountScope', context);
  const options = { requestTimeoutMs: timeoutMs, pollIntervalMs: 300000, minRefreshMs };
  install(options);
  const api = window.__codexThreadMetricsAccount;
  const reply = (request, accountId = 'account-a', userId = 'user-a', extra = {}) => window.emit({
    type: 'fetch-response', requestId: request.requestId, responseType: 'success', status: 200,
    bodyJsonString: JSON.stringify({ accountId, userId, email: 'PRIVATE EMAIL', plan: 'fixture', private: 'PRIVATE CONTENT' }), ...extra,
  });
  return { window, requests, intervals, install, options, api, reply, destroy: () => api.destroy() };
}
(async () => {
  {
    const f = fixture();
    try {
      assert.equal(f.requests.length, 1);
      assert.deepEqual(Object.keys(f.requests[0]).sort(), ['method', 'requestId', 'type', 'url']);
      assert.equal(f.requests[0].method, 'GET'); assert.equal(f.requests[0].url, 'vscode://codex/account-info');
      assert.equal(f.requests[0].type, 'fetch');
      assert.equal(f.api.snapshot().pending, true);
      const initial = f.api.refresh();
      f.reply({ requestId: 'unrelated' });
      f.window.emit({ type: 'fetch-response', requestId: f.requests[0].requestId, responseType: 'success', status: 200,
        body: { accountId: 'wrong-frame', userId: 'wrong-frame' } }, f.window, 'app://-');
      assert.equal(f.api.snapshot().scopeId, null, 'unrelated requests and non-native frames cannot establish an account');
      f.reply(f.requests[0]);
      const first = plain(await initial);
      assert.equal(first.scopeId, hash('account-a', 'user-a')); assert.equal(first.pending, false);
      assert.equal(first.supported, true); assert.equal(first.reason, 'verified'); assert(Number.isSafeInteger(first.checkedAt));
      const safeEvents = f.window.events.filter(event => event.type === 'codex-thread-metrics-account-scope-changed').map(event => event.detail);
      assert.doesNotMatch(JSON.stringify([first, f.api.status(), safeEvents]), /account-a|user-a|PRIVATE|email|authToken|accessToken|bodyJsonString/);
      f.install(f.options);
      assert.equal(f.window.__codexThreadMetricsAccount, f.api); assert.equal(f.window.count('message'), 1);
      assert.equal(f.intervals.size, 1); assert.equal(f.requests.length, 1, 'reinjection reuses the singleton');
      await f.api.refresh(); assert.equal(f.requests.length, 1, 'fresh verified metadata is cached');
      await pause(2); const one = f.api.refresh(true), two = f.api.refresh(true);
      assert.equal(one, two, 'concurrent refresh callers share one request');
      f.reply(f.requests[1]); await one; assert.equal(f.requests.length, 2);
      const before = plain(f.api.snapshot());
      f.window.emit({ type: 'mcp-notification', hostId: 'remote', method: 'account/updated' });
      f.window.emit({ type: 'mcp-notification', hostId: 'local', method: 'account/updated' }, f.window, 'app://-');
      assert.deepEqual(plain(f.api.snapshot()), before, 'remote hosts and normal postMessage frames cannot invalidate local identity');
      f.window.emit({ type: 'codex-app-server-connection-changed', hostId: 'local', state: 'error' });
      assert.equal(f.api.snapshot().scopeId, null); assert.equal(f.api.snapshot().reason, 'connection-change');
      assert.equal(f.api.snapshot().pending, false);
      const count = f.requests.length; await f.api.refresh(true); assert.equal(f.requests.length, count, 'offline states do not issue metadata requests');
      f.window.emit({ type: 'codex-app-server-connection-changed', hostId: 'local', state: 'connected' });
      assert.equal(f.api.snapshot().scopeId, null, 'connection recovery must reverify identity');
      await pause(3); const connected = f.api.refresh(); f.reply(f.requests.at(-1)); await connected;
      assert.equal(f.api.snapshot().scopeId, hash('account-a', 'user-a'));
      const sameStateRequests = f.requests.length;
      f.window.emit({ type: 'codex-app-server-connection-changed', hostId: 'local', state: 'connected' });
      assert.equal(f.requests.length, sameStateRequests, 'duplicate connection states do not refetch');
      f.window.emit({ type: 'mcp-notification', hostId: 'local', method: 'account/login/completed', params: { success: true } });
      assert.equal(f.api.snapshot().scopeId, null); assert.equal(f.api.snapshot().reason, 'account-change');
      await pause(3); const changed = f.api.refresh(); f.reply(f.requests.at(-1), 'account-b', 'user-b'); await changed;
      assert.equal(f.api.snapshot().scopeId, hash('account-b', 'user-b'));
      assert(f.window.events.some(event => event.type === 'codex-thread-metrics-account-scope-changed' && event.detail.reason === 'account-change' && event.detail.scopeId === null));
    } finally { f.destroy(); }
    assert.equal(f.window.count('message'), 0); assert.equal(f.intervals.size, 0);
  }
  {
    const f = fixture({ minRefreshMs: 30, fixedNow: 1000 });
    try {
      const initial = f.api.refresh(); f.reply(f.requests[0]); await initial;
      const first = f.api.refresh(true), second = f.api.refresh(true);
      assert.equal(first, second); assert.equal(f.requests.length, 1, 'forced refreshes still obey the request rate bound');
      assert.equal(f.api.status().scheduledRefresh, true);
      f.destroy(); await first; await pause(35);
      assert.equal(f.requests.length, 1, 'destroy cancels a scheduled refresh without touching the client');
    } finally { f.destroy(); }
  }
  {
    const deferred = [], f = fixture({ subtle: { digest(algorithm, bytes) {
      assert.equal(algorithm, 'SHA-256'); const copied = Buffer.from(bytes);
      return new Promise(resolve => deferred.push(() => resolve(Uint8Array.from(crypto.createHash('sha256').update(copied).digest()).buffer)));
    } } });
    try {
      const old = f.api.refresh(); f.reply(f.requests[0], 'old-account', 'old-user');
      assert.equal(deferred.length, 1);
      f.window.emit({ type: 'mcp-notification', hostId: 'local', method: 'account/updated', params: { authMode: 'chatgpt' } });
      assert.equal(f.api.snapshot().scopeId, null); assert.equal(f.api.snapshot().reason, 'account-change');
      await old; await pause(3); const latest = f.api.refresh(); f.reply(f.requests.at(-1), 'new-account', 'new-user');
      assert.equal(deferred.length, 2); deferred[0](); await pause(0);
      assert.equal(f.api.snapshot().scopeId, null, 'an old asynchronous digest cannot restore the previous account');
      deferred[1](); await latest;
      assert.equal(f.api.snapshot().scopeId, hash('new-account', 'new-user'));
    } finally { f.destroy(); }
  }
  for (const mode of ['timeout', 'bridge-failure', 'bad-json', 'failed-response', 'signed-out', 'missing-id']) {
    const f = fixture({ bridgeFailure: mode === 'bridge-failure', timeoutMs: 15 });
    try {
      const promise = f.api.refresh();
      if (mode === 'bad-json') f.reply(f.requests[0], 'a', 'u', { bodyJsonString: '{ invalid private payload' });
      if (mode === 'failed-response') f.reply(f.requests[0], 'a', 'u', { responseType: 'error', error: 'PRIVATE ERROR' });
      if (mode === 'signed-out') f.reply(f.requests[0], null, null);
      if (mode === 'missing-id') f.reply(f.requests[0], 'a', null);
      const result = plain(await promise);
      assert.equal(result.scopeId, null, mode); assert.equal(result.pending, false, mode);
      assert.equal(result.reason, mode === 'signed-out' ? 'signed-out' : 'read-failed', mode);
      f.reply(f.requests[0], 'late-account', 'late-user'); await pause(0);
      assert.equal(f.api.snapshot().scopeId, null, 'late responses after failure cannot restore identity');
      assert.doesNotMatch(JSON.stringify(f.api.status()), /PRIVATE|late-account|late-user/);
    } finally { f.destroy(); }
  }
  {
    const f = fixture(); const external = () => {};
    f.window.addEventListener('message', external);
    const pending = f.api.refresh(); f.destroy(); await pending;
    assert.equal(f.window.count('message'), 1, 'destroy preserves unrelated listeners'); assert.equal(f.intervals.size, 0);
    assert.equal(f.window.__codexThreadMetricsAccount, undefined);
    f.reply(f.requests[0]); f.window.emit({ type: 'mcp-notification', hostId: 'local', method: 'account/updated' });
    await pause(0); assert.equal(f.requests.length, 1); assert.equal(f.api.snapshot().scopeId, null);
    f.window.removeEventListener('message', external);
  }
  {
    const f = fixture({ supported: false });
    try { assert.equal(f.api.snapshot().supported, false); assert.equal(f.requests.length, 0);
      assert.equal(f.window.count('message'), 0); assert.equal(f.intervals.size, 0); await f.api.refresh(true); assert.equal(f.requests.length, 0);
    } finally { f.destroy(); }
  }
  console.log('PASS native read-only account scope, opaque identity hashing, no credentials, request/frame isolation, singleton caching, concurrent refresh, account/hash races, connection quarantine, errors/timeouts and cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
