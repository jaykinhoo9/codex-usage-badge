var AGENT_VERSION = '0.9.4';
async function refreshThreadMetrics(injector, reader, store = null) {
  const sessions = [...injector.sessions.values()];
  if (!sessions.length) return;
  const requests = await Promise.all(sessions.map(async session => {
    try {
      const result = await session.evaluate('(() => { const api = window.__codexThreadMetrics; return { ids: api?.requestedIds() ?? [], actorScopeId: api?.persistenceContext?.().actorScopeId ?? null, pending: api?.pendingSnapshots?.() ?? [], archives: api?.pendingArchives?.() ?? [] }; })()');
      const raw = result?.result?.value;
      const context = Array.isArray(raw) ? { ids: raw } : raw;
      const ids = Array.isArray(context?.ids) ? context.ids.filter(id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)).slice(0, 32) : [];
      const actorScopeId = typeof context?.actorScopeId === 'string' && /^[a-f0-9]{64}$/i.test(context.actorScopeId) ? context.actorScopeId : null;
      const pending = Array.isArray(context?.pending) ? context.pending.slice(0, 256) : [];
      const archives = Array.isArray(context?.archives) ? context.archives.filter(record =>
        typeof record?.threadId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(record.threadId) &&
        Number.isSafeInteger(record.archivedAt) && record.archivedAt > 0 && record.archivedAt <= Date.now() + 1000) : [];
      return { session, ids, actorScopeId, pending, archives };
    } catch { return { session, ids: [], actorScopeId: null, pending: [], archives: [] }; }
  }));
  const archiveCandidates = () => [...new Set([
    ...requests.flatMap(request => [...request.ids, ...request.pending.map(record => record?.threadId), ...request.archives.map(record => record.threadId)]),
    ...(store?.threadIds?.() ?? [])
  ].filter(id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)))];
  const checkArchives = async () => {
    try { return typeof reader.archivedIds === 'function' ? await reader.archivedIds(archiveCandidates()) : { ok: true, ids: [] }; }
    catch { return { ok: false, ids: [] }; }
  };
  const before = await checkArchives();
  const confirmedBefore = new Set(before.ok ? before.ids : []);
  const nativeArchives = requests.flatMap(request => request.archives);
  const deletionIds = [...new Set([...confirmedBefore, ...nativeArchives.map(record => record.threadId)])];
  if (store && deletionIds.length && typeof store.removeThreads === 'function') {
    try {
      const removed = new Set();
      const priorCutoffs = store.purgeCutoffs?.(deletionIds) ?? {};
      for (const id of deletionIds) {
        const intents = nativeArchives.filter(record => record.threadId === id);
        // A late duplicate broadcast must not erase a currently active thread's
        // fresh post-Undo data. A current DB archive always remains authoritative.
        if (!confirmedBefore.has(id) && priorCutoffs[id] !== undefined) { removed.add(id); continue; }
        const options = intents.length ? { cutoffAt: Math.min(...intents.map(record => record.archivedAt)) } : {};
        for (const cleared of await store.removeThreads([id], options)) removed.add(cleared);
      }
      // Archive notifications can be followed by Undo before the next poll.
      // Their deletion still commits; a durable cutoff rejects old in-flight
      // fields without preventing later, genuinely new observations.
      await Promise.all(requests.map(async request => {
        const acknowledged = request.archives.filter(record => removed.has(record.threadId));
        if (acknowledged.length) try { await request.session.evaluate(`window.__codexThreadMetrics?.ackArchives(${JSON.stringify(acknowledged)})`); } catch {}
      }));
    } catch {}
  }
  if (store && before.ok) for (const { session, pending } of requests) {
    if (!pending.length) continue;
    try {
      // Acknowledge only committed versions. Newer observations remain queued
      // if they arrive while the previous snapshot is being saved.
      const accepted = await store.write(pending.filter(record => !confirmedBefore.has(record?.threadId)));
      if (accepted.length) await session.evaluate(`window.__codexThreadMetrics?.ackPersisted(${JSON.stringify(accepted)})`);
    } catch { /* Keep the renderer's pending values for a later retry. */ }
  }
  // Interleave requests so another window's active conversation is not starved
  // by a first window's background candidates when the reader bounds its batch.
  const requested = [];
  for (let index = 0; index < Math.max(0, ...requests.map(request => request.ids.length)); index++) {
    for (const request of requests) if (request.ids[index]) requested.push(request.ids[index]);
  }
  const snapshot = await reader.read([...new Set(requested)]);
  const after = await checkArchives();
  const archivedIds = after.ok ? after.ids : snapshot.archivedIds ?? [];
  if (store && archivedIds.length && typeof store.removeThreads === 'function') {
    try { await store.removeThreads(archivedIds); } catch {}
  }
  const archived = new Set(archivedIds);
  const purgedBefore = store?.purgeCutoffs?.(archiveCandidates()) ?? {};
  await Promise.all(requests.map(async ({ session, ids, actorScopeId }) => {
    // Send aggregate numbers only, and only to the window that requested this thread.
    const perThread = Object.fromEntries(ids.filter(id => Object.hasOwn(snapshot.perThread, id)).map(id => [id, snapshot.perThread[id]]));
    const persistedPerThread = Object.create(null);
    if (store && actorScopeId) for (const id of ids) {
      const metric = perThread[id];
      if (archived.has(id) || metric?.archived === true || metric?.localVerified !== true || typeof metric.scopeId !== 'string' || !/^[a-f0-9]{64}$/i.test(metric.scopeId)) continue;
      try {
        const saved = await store.read({ actorScopeId, scopeId: metric.scopeId, threadId: id,
          ...(typeof metric.revision === 'string' && /^[a-f0-9]{64}$/i.test(metric.revision) ? { revision: metric.revision } : {}) });
        if (saved) persistedPerThread[id] = saved;
      } catch {}
    }
    const payload = store ? { ...snapshot, perThread, persistedPerThread, archivedIds, purgedBefore } : { ...snapshot, perThread, ...(archivedIds.length ? { archivedIds } : {}) };
    try { await session.evaluate(`window.__codexThreadMetrics?.update(${JSON.stringify(payload)})`); } catch {}
  }));
  return snapshot;
}
function parseArgs(argv) {
  const options = {
    port: Number(process.env.CODEX_BADGE_PORT) || 39222,
    appPath: process.env.CODEX_BADGE_APP || (process.platform === 'win32' ? '' : '/Applications/ChatGPT.app'),
    codexBin: process.env.CODEX_BADGE_BIN || 'codex',
    pollMs: Number(process.env.CODEX_BADGE_POLL_MS) || 60000,
    debug: process.env.CODEX_BADGE_DEBUG === '1'
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--debug') options.debug = true;
    else if (argv[i] === '--port') options.port = Number(argv[++i]);
    else if (argv[i] === '--app') options.appPath = argv[++i];
    else if (argv[i] === '--codex-bin') options.codexBin = argv[++i];
    else if (argv[i] === '--poll-ms') options.pollMs = Math.max(1000, Number(argv[++i]));
  }
  return options;
}
function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`);
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.codexBin = resolveCodexBin(options.codexBin, options.appPath);
  log(`codex-usage-badge v${AGENT_VERSION} 启动：仅连接本机端口 ${options.port}，不启动、不退出、不激活客户端。`);
  const injector = new RendererInjector({ port: options.port, debug: options.debug, scanIntervalMs: 5000 });
  const tokenReader = new ThreadTokenReader();
  const metricsReader = new ThreadMetricsReader();
  const metricsStore = new ThreadMetricsStore();
  const projectSizeScanner = new ProjectSizeScanner();
  let stopped = false;
  let client = null;
  let pending = false;
  let nextRead = 0;
  let failures = 0;
  let connected = false;
  let refreshingProjectSizes = false;
  let refreshingMetrics = false;
  let nextMetricsRead = 0;
  injector.currentValue = { percent: null, title: '正在读取 Codex 剩余用量', tone: 'muted', windowLabel: '' };
  // A missing port is an idle state, never a reason to restart or focus the app.
  const scan = async () => {
    if (stopped) return;
    try {
      await injector.scan();
      if (!connected && injector.sessions.size > 0) log('主窗口连接正常，进度条已注入。');
      connected = injector.sessions.size > 0;
    } catch {
      if (connected) log('主窗口暂不可连接，静默等待。');
      connected = false;
      // Drop sessions from a previous app instance without launching anything.
      for (const session of injector.sessions.values()) session.close();
      injector.sessions.clear();
    }
    if (injector.sessions.size === 0) {
      const old = client; client = null; old?.stop();
      nextRead = 0;
      injector.currentValue = unavailableValue(injector.currentValue);
    }
  };
  async function readUsage() {
    if (stopped || pending || Date.now() < nextRead || injector.sessions.size === 0) return;
    pending = true;
    try {
      if (!client) {
        options.codexBin = resolveCodexBin(options.codexBin, options.appPath);
        const current = new AppServerClient({ command: options.codexBin, debug: false });
        client = current;
        current.on('rate-limits', data => {
          if (client !== current || stopped) return;
          try {
            injector.update({ ...formatRateLimits(data), updatedAt: Date.now(), stale: false }).catch(() => {});
          } catch {
            injector.update(unavailableValue(injector.currentValue)).catch(() => {});
          }
        });
        current.on('server-exit', () => {
          if (client === current) {
            client = null; nextRead = Date.now() + 10000;
            injector.update(unavailableValue(injector.currentValue)).catch(() => {});
          }
        });
        await current.start();
        if (stopped) current.stop();
      } else {
        await client.refresh();
      }
      failures = 0;
      if (client) nextRead = Date.now() + options.pollMs;
    } catch (error) {
      const old = client;
      client = null;
      old?.stop();
      failures++;
      nextRead = Date.now() + Math.min(60000, 10000 * failures);
      if (failures === 1 || failures % 10 === 0) log(`用量暂不可用：${error.message}`);
      await injector.update(unavailableValue(injector.currentValue));
    } finally { pending = false; }
  }
  const updateProjectSizes = async () => {
    if (stopped || refreshingProjectSizes || injector.sessions.size === 0) return;
    refreshingProjectSizes = true;
    try { await refreshProjectSizes(injector, projectSizeScanner); }
    finally { refreshingProjectSizes = false; }
  };
  projectSizeScanner.onChange = () => { updateProjectSizes().catch(() => {}); };
  const updateMetrics = async () => {
    if (stopped || refreshingMetrics || injector.sessions.size === 0 || Date.now() < nextMetricsRead) return;
    refreshingMetrics = true;
    try {
      const result = await refreshThreadMetrics(injector, metricsReader, metricsStore);
      // Continue bounded local backfill promptly; an idle/complete reader keeps
      // the normal five-second cadence. Window scans and quota reads stay separate.
      nextMetricsRead = Date.now() + (result?.backfilling === true ? 200 : 5000);
    } catch {
      nextMetricsRead = Date.now() + 5000;
    } finally { refreshingMetrics = false; }
  };
  const tick = async () => {
    await scan();
    // Quota requests can wait on the network; pending prevents overlap without delaying local reads.
    readUsage().catch(error => { if (!stopped) log(`额度刷新暂不可用：${error.message}`); });
    await refreshThreadTokens(injector, tokenReader);
    await updateMetrics();
    await updateProjectSizes();
  };
  let ticking = false;
  const guardedTick = async () => {
    if (ticking || stopped) return;
    ticking = true;
    try { await tick(); } catch (error) { log(`连接暂不可用：${error.message}`); }
    finally { ticking = false; }
  };
  const timer = setInterval(guardedTick, 5000);
  const metricsTimer = setInterval(() => { updateMetrics().catch(() => {}); }, 200);
  let stopTimer = null;
  const shutdown = () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(metricsTimer);
    if (stopTimer) clearInterval(stopTimer);
    const old = client; client = null; old?.stop();
    projectSizeScanner.stop();
    metricsReader.stop?.();
    metricsStore.stop?.();
    injector.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // The Windows supervisor requests a graceful stop without killing unrelated node.exe processes.
  if (process.platform === 'win32' && process.env.CODEX_BADGE_STOP_FILE) {
    stopTimer = setInterval(() => {
      if (require('node:fs').existsSync(process.env.CODEX_BADGE_STOP_FILE)) shutdown();
    }, 500);
  }
  await guardedTick();
}
module.exports = { installUsageBadge, installProjectColors, installProjectSizes, installThreadTokens, ThreadTokenReader, refreshThreadTokens,
  installThreadMetrics, ThreadMetricsReader, refreshThreadMetrics,
  createThreadPerformanceTracker, installThreadPerformanceMonitor,
  installThreadMetricsAccountScope,
  ThreadMetricsStore,
  ProjectSizeScanner, measureDirectory, measureDirectoryPortable, measureProjectRoots, refreshProjectSizes,
  buildBootstrapScript, formatRateLimits, mergeRateLimitsResponse, isMainWindow, resolveCodexBin, AppServerClient, main };
if (require.main === module) main().catch(error => { log(`agent 启动失败：${error.message}`); process.exitCode = 1; });
