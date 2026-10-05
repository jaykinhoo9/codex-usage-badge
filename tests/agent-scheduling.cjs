const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const startup = deferred(), refresh = deferred();
let now = 0, tokenReads = 0, metricsReads = 0, sizeReads = 0, scans = 0, starts = 0, refreshes = 0, interval, metricsInterval, injector, metricsBackfill = false;
const hooks = {};
class FakeInjector {
  constructor() { injector = this; this.sessions = new Map([['local', {}]]); }
  async scan() { scans++; }
  async update(value) { this.currentValue = value; }
  stop() { this.sessions.clear(); }
}
class FakeClient extends EventEmitter {
  start() { starts++; return startup.promise; }
  refresh() { refreshes++; return refresh.promise; }
  stop() {}
}
const noop = () => {};
const sandbox = {
  process: { env: {}, argv: [], once: (name, fn) => hooks[name] = fn, stdout: { write: noop }, exit: noop },
  module: { exports: {} }, require: Object.assign(noop, { main: {} }),
  Date: { now: () => now },
  setInterval: (fn, ms) => { if (ms === 5000) interval = fn; if (ms === 200) metricsInterval = fn; return ms; }, clearInterval: noop,
  RendererInjector: FakeInjector, AppServerClient: FakeClient, ThreadTokenReader: class {},
  ThreadMetricsReader: class { async read() { metricsReads++; return { ok: true, perThread: {}, checkedAt: now, backfilling: metricsBackfill }; } },
  ThreadMetricsStore: class { write() { return []; } read() { return null; } stop() {} },
  ProjectSizeScanner: class { stop() {} }, refreshProjectSizes: async () => {sizeReads++;},
  measureDirectory: noop, measureDirectoryPortable: noop, measureProjectRoots: noop,
  refreshThreadTokens: async () => { tokenReads++; }, resolveCodexBin: () => 'fake',
  unavailableValue: current => ({ ...current, stale: true }),
  installUsageBadge: noop, installProjectColors: noop, installProjectSizes: noop, installThreadTokens: noop,
  installThreadMetrics: noop,
  createThreadPerformanceTracker: noop, installThreadPerformanceMonitor: noop,
  installThreadMetricsAccountScope: noop,
  buildBootstrapScript: noop, formatRateLimits: noop, mergeRateLimitsResponse: noop, isMainWindow: noop
};
// log() constructs Date; expose both a real constructor and the controlled now().
sandbox.Date = class extends Date { static now() { return now; } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/agent-main.js'), 'utf8'), sandbox);
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const running = sandbox.module.exports.main();
  try {
    await flush();
    assert.equal(tokenReads, 1);
    now = 5000; await interval(); await flush();
    assert.equal(tokenReads, 2, 'slow quota initialization must not block the next local Token refresh');
    assert.equal(starts, 1, 'quota requests must not overlap');
    startup.resolve(); await flush();
    now = 65000; await interval(); await flush();
    assert.equal(refreshes, 1);
    now = 70000; await interval(); await flush();
    assert.equal(tokenReads, 4, 'slow quota refresh must not block subsequent local reads');
    assert.equal(metricsReads, 4, 'slow quota refresh must not block current thread metric reads');
    assert.equal(refreshes, 1);
    assert.equal(scans, 4);
    assert.equal(sizeReads, 4, 'slow quota refresh must not block folder size updates');
    now = 70100; metricsInterval(); await flush();
    assert.equal(metricsReads, 4, 'idle metrics must keep five-second cadence');
    metricsBackfill = true;
    now = 75000; metricsInterval(); await flush();
    assert.equal(metricsReads, 5);
    now = 75100; metricsInterval(); await flush();
    assert.equal(metricsReads, 5, 'bounded backfill must not run sooner than 200ms');
    now = 75200; metricsInterval(); await flush();
    assert.equal(metricsReads, 6, 'large history backfills without waiting for the five-second scan');
    assert.equal(scans, 4, 'backfill must not trigger additional window scans');
    metricsBackfill = false;
    now = 75400; metricsInterval(); await flush();
    assert.equal(metricsReads, 7);
    now = 75600; metricsInterval(); await flush();
    assert.equal(metricsReads, 7, 'complete history returns to the idle cadence');
    refresh.resolve(); await flush();
    injector.sessions.clear(); now = 80500; await interval();
    assert.equal(injector.currentValue.stale, true);
    console.log('PASS slow quota requests stay independent of local reads; bounded 200ms history backfill returns to idle cadence without repeated window scans; disconnect clears usage');
  } finally { startup.resolve(); refresh.resolve(); await flush(); hooks.SIGTERM?.(); await running; }
})().catch(error => { console.error(error); process.exitCode = 1; });
