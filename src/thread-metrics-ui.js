function installThreadMetrics() {
  const VERSION = 5;
  const KEY = '__codexThreadMetrics';
  const MARK = 'data-codex-thread-metrics';
  const ROOT = '[data-codex-composer-root][data-composer-placement="thread"]';
  const ROW = '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id]';
  const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const SCOPE = /^[a-f0-9]{64}$/i;
  const STORAGE_PREFIX = 'codex-usage-badge.thread-metrics.v1:';
  if (window[KEY]?.version === VERSION) { window[KEY].refresh(); return; }
  let carried = null;
  try { carried = window[KEY]?.retainedState?.() ?? null; } catch {}
  function newProducerId() {
    try { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); } catch {}
    const bytes = new Uint8Array(16);
    try { window.crypto.getRandomValues(bytes); } catch { for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256); }
    bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const producerId = typeof carried?.producerId === 'string' && UUID.test(carried.producerId) ? carried.producerId : newProducerId();
  window[KEY]?.destroy?.();
  let disposed = false;
  let refreshTimer = null;
  let composer = null;
  let threadId = null;
  let scopeId = null;
  let actorScopeId = null;
  let actorVerified = false;
  let actorEpochAt = 0;
  let scopeCheckedAt = 0;
  let accountChangedAt = 0;
  let accountBlocked = false;
  const history = new Map();
  const dirty = new Map();
  const queuedSerialized = new Map();
  const acknowledged = new Map();
  const localProofs = new Set();
  const nativeProofs = new Set();
  const observedIds = new Set();
  const archivedIds = new Set();
  const archiveTimes = new Map();
  const unarchiveTimes = new Map();
  const monitorEpochs = new Map();
  const awaitingUnarchiveProof = new Set();
  const pendingArchiveIds = new Map();
  const loaded = new Set();
  const threadScopes = new Map();
  let lastSerialized = new Map();
  let pendingVersion = 0;
  let storageFailures = 0;
  let requestCursor = 0;
  let snapshot = { ok: false, checkedAt: null, perThread: {} };
  const strip = document.createElement('div');
  strip.setAttribute(MARK, '');
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', '当前会话运行指标');
  strip.hidden = true;
  const style = document.createElement('style');
  style.id = 'codex-thread-metrics-style';
  style.textContent = `
    [${MARK}] {
      --thread-metrics-text: #73777c; --thread-metrics-divider: #73777c66;
      box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center;
      flex: 0 0 auto; gap: 3px 9px; width: 100%; min-width: 0; max-width: 100%;
      margin: 7px 0 0; padding: 0 2px 2px; color: var(--color-text-secondary, var(--thread-metrics-text));
      font-family: inherit; font-size: 11px; font-weight: 400; line-height: 1.6;
      font-variant-numeric: tabular-nums; -webkit-app-region: no-drag;
    }
    [${MARK}][hidden] { display: none !important; }
    [${MARK}] .thread-metrics-group { display: block; flex: 0 1 auto;
      min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
    [${MARK}] .thread-metrics-group:not(:last-child)::after {
      content: '|'; margin-left: 9px; color: var(--thread-metrics-divider);
    }
    [${MARK}] .thread-metrics-value { display: inline-block; min-width: .35em; white-space: nowrap; }
    html.dark [${MARK}], html[data-theme="dark"] [${MARK}] {
      --thread-metrics-text: #a5a9ad; --thread-metrics-divider: #a5a9ad88;
    }
    @media (prefers-color-scheme: dark) {
      html:not(.light):not([data-theme="light"]) [${MARK}] {
        --thread-metrics-text: #a5a9ad; --thread-metrics-divider: #a5a9ad88;
      }
    }
  `;
  const values = new Map();
  function group(parts) {
    const element = document.createElement('span');
    element.className = 'thread-metrics-group';
    for (const part of parts) {
      if (typeof part === 'string') element.append(document.createTextNode(part));
      else {
        const span = document.createElement('span');
        span.className = 'thread-metrics-value';
        span.dataset.metric = part.field;
        values.set(part.field, span); element.append(span);
      }
    }
    strip.append(element);
  }
  group([{ field: 'rounds' }, ' 轮 · ', { field: 'steps' }, ' 步']);
  group(['LLM ', { field: 'llmDurationMs' }, ' · 工具调用 ', { field: 'toolDurationMs' }]);
  group(['首 token 平均 ', { field: 'firstTokenAvgMs' }, ' · ', { field: 'tokensPerSecond' }, ' tok/s']);
  group(['缓存命中 ', { field: 'cacheHitPercent' }]);
  group(['输入 ', { field: 'inputTokens' }, ' tok · 输出 ', { field: 'outputTokens' }, ' tok']);
  const visible = el => {
    if (!el?.isConnected || el.closest('[hidden], [inert], [aria-hidden="true"], [data-app-shell-active-page="false"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  function discover() {
    const roots = [...document.querySelectorAll(ROOT)].filter(root => visible(root) && visible(root.querySelector('[data-codex-composer]')));
    // Multiple visible composers can belong to a modal or another pane. Do not
    // attach a different thread's data to an ambiguous input.
    if (roots.length !== 1) return { root: null, id: null, candidate: null };
    const root = roots[0];
    const ids = [...new Set([...root.querySelectorAll('[data-above-composer-conversation-id]')]
      .map(el => el.getAttribute('data-above-composer-conversation-id')).filter(Boolean))];
    if (ids.length !== 1 || !UUID.test(ids[0])) return { root, id: null, candidate: null };
    const id = ids[0];
    const matchingRows = [...document.querySelectorAll(ROW)]
      .filter(row => row.getAttribute('data-app-action-sidebar-thread-id')?.split(':').at(-1) === id);
    const contradicts = matchingRows.some(row => row.getAttribute('data-app-action-sidebar-thread-id') !== `local:${id}` ||
      row.getAttribute('data-app-action-sidebar-thread-host-id') !== 'local' ||
      row.getAttribute('data-app-action-sidebar-thread-kind') !== 'local');
    // A current sidebar row or same-account renderer-epoch backend proof can
    // establish locality. Stored numeric history never establishes host proof.
    const local = !contradicts && matchingRows.length > 0 && matchingRows.every(row =>
      row.getAttribute('data-app-action-sidebar-thread-host-id') === 'local' &&
      row.getAttribute('data-app-action-sidebar-thread-kind') === 'local');
    if (contradicts || accountBlocked) return { root, id: null, candidate: null };
    if (archivedIds.has(id) || awaitingUnarchiveProof.has(id)) return { root, id: null, candidate: id };
    return { root, id: local || localProofs.has(id) || nativeProofs.has(id) ? id : null, candidate: id };
  }
  const nonnegative = number => typeof number === 'number' && Number.isFinite(number) && number >= 0;
  const count = number => Number.isSafeInteger(number) && number >= 0 ? number.toLocaleString('zh-CN') : '';
  const decimal = number => String(Number(number.toFixed(1)));
  function duration(number) {
    if (!nonnegative(number)) return '';
    if (number < 60000) return `${decimal(number / 1000)}s`;
    const total = Math.floor(number / 1000);
    const hours = Math.floor(total / 3600);
    return `${hours ? `${hours}h` : ''}${Math.floor(total % 3600 / 60)}m${total % 60}s`;
  }
  function tokens(number) {
    if (!Number.isSafeInteger(number) || number < 0) return '';
    for (const [divisor, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']])
      if (number >= divisor) return `${decimal(number / divisor)}${suffix}`;
    return String(number);
  }
  const formatters = {
    rounds: count, steps: count, llmDurationMs: duration, toolDurationMs: duration,
    firstTokenAvgMs: duration,
    tokensPerSecond: number => nonnegative(number) ? decimal(number) : '',
    cacheHitPercent: number => nonnegative(number) && number <= 100 ? `${decimal(number)}%` : '',
    inputTokens: tokens, outputTokens: tokens,
  };
  const labels = { rounds: '轮数', steps: '步数', llmDurationMs: 'LLM 耗时', toolDurationMs: '工具调用耗时',
    firstTokenAvgMs: '首 token 平均', tokensPerSecond: '响应阶段均速', cacheHitPercent: '缓存命中', inputTokens: '输入 Token', outputTokens: '输出 Token' };
  const validAt = value => Number.isSafeInteger(value) && value > 0 && value <= Date.now() + 1000;
  const validField = (field, value) => Object.hasOwn(formatters, field) && nonnegative(value) &&
    value <= Number.MAX_SAFE_INTEGER && formatters[field](value) !== '';
  function cleanRecord(value, id, localScope = threadScopes.get(id) ?? scopeId, desktopScope = actorScopeId) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.threadId !== id ||
      value.scopeId !== localScope || value.actorScopeId !== desktopScope || !validAt(value.updatedAt) || !value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields) ||
      Object.keys(value).some(key => !['version', 'scopeId', 'actorScopeId', 'threadId', 'updatedAt', 'revision', 'rolloutSize', 'rolloutMtimeMs', 'fields'].includes(key))) return null;
    const fields = {};
    for (const [field, entry] of Object.entries(value.fields)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !validField(field, entry.value) || !validAt(entry.at) ||
        !['file', 'monitor'].includes(entry.source) || typeof entry.approximate !== 'boolean' || typeof entry.lowerBound !== 'boolean' ||
        Object.keys(entry).some(key => !['value', 'at', 'source', 'approximate', 'lowerBound', 'observedSince', 'observedResponses'].includes(key))) return null;
      if (entry.at <= (archiveTimes.get(id) ?? 0)) continue;
      const clean = { value: entry.value, at: entry.at, source: entry.source, approximate: entry.approximate, lowerBound: entry.lowerBound };
      if (validAt(entry.observedSince)) clean.observedSince = entry.observedSince;
      if (Number.isSafeInteger(entry.observedResponses) && entry.observedResponses >= 0) clean.observedResponses = entry.observedResponses;
      fields[field] = clean;
    }
    if (!Object.keys(fields).length) return null;
    return { version: 1, scopeId: localScope, actorScopeId: desktopScope, threadId: id, updatedAt: value.updatedAt,
      revision: typeof value.revision === 'string' && SCOPE.test(value.revision) ? value.revision : null,
      rolloutSize: Number.isSafeInteger(value.rolloutSize) && value.rolloutSize >= 0 ? value.rolloutSize : null,
      rolloutMtimeMs: nonnegative(value.rolloutMtimeMs) && value.rolloutMtimeMs <= Date.now() + 1000 ? value.rolloutMtimeMs : null, fields };
  }
  function touch(id, record) {
    history.delete(id); history.set(id, record);
  }
  function storageKey(id) { return `${STORAGE_PREFIX}${actorScopeId}:${threadScopes.get(id) ?? scopeId}:${id}`; }
  function loadHistory(id) {
    if (archivedIds.has(id) || awaitingUnarchiveProof.has(id)) return;
    if (!actorVerified || !actorScopeId || !threadScopes.has(id) || loaded.has(id)) return;
    loaded.add(id);
    try {
      const key = storageKey(id), serialized = localStorage.getItem(key);
      if (!serialized) return;
      const record = serialized.length <= 8192 ? cleanRecord(JSON.parse(serialized), id) : null;
      if (!record) { localStorage.removeItem(key); return; }
      const current = history.get(id);
      if (!current) touch(id, record);
      else {
        for (const [field, entry] of Object.entries(record.fields)) {
          const prior = current.fields[field];
          if (!prior || prior.at < entry.at || ['rounds', 'steps'].includes(field) && prior.lowerBound && entry.value > prior.value) current.fields[field] = entry;
        }
        if (!current.revision) current.revision = record.revision;
        if (current.rolloutSize === null) current.rolloutSize = record.rolloutSize;
        if (current.rolloutMtimeMs === null) current.rolloutMtimeMs = record.rolloutMtimeMs;
        current.updatedAt = Math.max(current.updatedAt, record.updatedAt);
      }
      lastSerialized.set(id, serialized);
    } catch { /* Blocked storage leaves the bounded in-memory history usable. */ }
  }
  function persist(id, record) {
    if (archivedIds.has(id) || awaitingUnarchiveProof.has(id)) return;
    const localScope = threadScopes.get(id);
    if (!actorVerified || !actorScopeId || !localScope || accountBlocked || !localProofs.has(id) || !Object.keys(record.fields).length) return;
    record.actorScopeId = actorScopeId; record.scopeId = localScope;
    const serialized = JSON.stringify(record);
    const key = storageKey(id);
    if (queuedSerialized.get(key) !== serialized || !dirty.has(key) && acknowledged.get(key) !== serialized) {
      dirty.set(key, { ...JSON.parse(serialized), pendingVersion: ++pendingVersion, producerId });
      queuedSerialized.set(key, serialized);
    }
    if (lastSerialized.get(id) === serialized) return;
    try {
      localStorage.setItem(key, serialized); lastSerialized.set(id, serialized);
    } catch { storageFailures++; }
  }
  function remember(id, field, value, metadata) {
    if (archivedIds.has(id) || awaitingUnarchiveProof.has(id) || metadata.at <= (archiveTimes.get(id) ?? 0)) return false;
    if (!validField(field, value) || !validAt(metadata.at)) return false;
    let record = history.get(id);
    if (!record) record = { version: 1, scopeId: threadScopes.get(id) ?? scopeId, actorScopeId,
      threadId: id, updatedAt: metadata.at, revision: null, rolloutSize: null, rolloutMtimeMs: null, fields: {} };
    const prior = record.fields[field];
    // A partial scan or since-monitor-start count is a lower bound. It must
    // never replace a greater known historical count or be added to that count.
    if (['rounds', 'steps'].includes(field) && metadata.lowerBound && prior &&
      (prior.value > value || prior.value === value && !prior.lowerBound)) return false;
    if (prior && metadata.at < prior.at) return false;
    record.fields[field] = { value, ...metadata };
    record.updatedAt = Math.max(record.updatedAt, metadata.at);
    touch(id, record); return true;
  }
  function acceptScope(next) {
    const declared = typeof next?.scopeId === 'string' && SCOPE.test(next.scopeId) ? next.scopeId.toLowerCase() : scopeId;
    const at = validAt(next?.checkedAt) ? next.checkedAt : 0;
    if (at < scopeCheckedAt || at < accountChangedAt) return false;
    if (declared !== scopeId) {
      // Unscoped observations are renderer-only. An account/home scope change
      // invalidates host proof and history before any new thread is rendered.
      if (scopeId !== null) { history.clear(); localProofs.clear(); nativeProofs.clear(); threadScopes.clear(); }
      loaded.clear(); lastSerialized.clear();
      if (scopeId !== null) window.__codexThreadPerformance?.reset?.();
      scopeId = declared;
    }
    scopeCheckedAt = at;
    return true;
  }
  function syncActor() {
    const wasVerified = actorVerified;
    let account = null;
    try { account = window.__codexThreadMetricsAccount?.snapshot?.() ?? null; } catch {}
    const declared = account?.supported === true && typeof account.scopeId === 'string' && SCOPE.test(account.scopeId)
      ? account.scopeId.toLowerCase() : null;
    actorVerified = declared !== null && account?.pending !== true;
    if (!declared) {
      if (account?.reason === 'account-change' || account?.reason === 'signed-out') {
        if (!accountBlocked) {
          accountChangedAt = Date.now(); localProofs.clear(); nativeProofs.clear();
          window.__codexThreadPerformance?.reset?.();
        }
        accountBlocked = true;
      } else if (actorScopeId && !['connection-change', 'read-failed'].includes(account?.reason)) {
        accountBlocked = true;
      }
      return;
    }
    if (declared !== actorScopeId) {
      if (actorScopeId !== null || accountChangedAt > 0) {
        history.clear(); localProofs.clear(); nativeProofs.clear(); threadScopes.clear(); observedIds.clear();
        actorEpochAt = validAt(account.checkedAt) ? account.checkedAt : Date.now();
        window.__codexThreadPerformance?.reset?.();
      }
      loaded.clear(); lastSerialized.clear(); actorScopeId = declared;
      for (const record of history.values()) record.actorScopeId = declared;
    }
    accountBlocked = false;
    if (actorVerified && !wasVerified) for (const [id, record] of history) persist(id, record);
  }
  if (carried?.version === 1 && (carried.scopeId === null || typeof carried.scopeId === 'string' && SCOPE.test(carried.scopeId))) {
    scopeId = carried.scopeId;
    actorScopeId = typeof carried.actorScopeId === 'string' && SCOPE.test(carried.actorScopeId) ? carried.actorScopeId : null;
    actorEpochAt = validAt(carried.actorEpochAt) ? carried.actorEpochAt : 0;
    scopeCheckedAt = validAt(carried.scopeCheckedAt) ? carried.scopeCheckedAt : 0;
    accountChangedAt = validAt(carried.accountChangedAt) ? carried.accountChangedAt : 0;
    accountBlocked = carried.accountBlocked === true;
    for (const id of Array.isArray(carried.archivedIds) ? carried.archivedIds : []) if (typeof id === 'string' && UUID.test(id)) archivedIds.add(id);
    for (const [id, at] of Array.isArray(carried.archiveTimes) ? carried.archiveTimes : []) if (typeof id === 'string' && UUID.test(id) && validAt(at)) archiveTimes.set(id, at);
    for (const [id, at] of Array.isArray(carried.unarchiveTimes) ? carried.unarchiveTimes : []) if (typeof id === 'string' && UUID.test(id) && validAt(at)) unarchiveTimes.set(id, at);
    for (const [id, at] of Array.isArray(carried.monitorEpochs) ? carried.monitorEpochs : []) if (typeof id === 'string' && UUID.test(id) && validAt(at)) monitorEpochs.set(id, at);
    for (const id of Array.isArray(carried.awaitingUnarchiveProof) ? carried.awaitingUnarchiveProof : []) if (typeof id === 'string' && UUID.test(id)) awaitingUnarchiveProof.add(id);
    for (const [id, at] of Array.isArray(carried.pendingArchiveIds) ? carried.pendingArchiveIds : []) if (typeof id === 'string' && UUID.test(id) && validAt(at)) pendingArchiveIds.set(id, at);
    for (const value of Array.isArray(carried.records) ? carried.records : []) {
      if (typeof value?.threadId !== 'string' || !UUID.test(value.threadId)) continue;
      if (archivedIds.has(value.threadId) || awaitingUnarchiveProof.has(value.threadId)) continue;
      if (typeof value.scopeId === 'string' && SCOPE.test(value.scopeId)) threadScopes.set(value.threadId, value.scopeId);
      const record = cleanRecord(value, value.threadId);
      if (record) touch(value.threadId, record);
    }
    for (const id of Array.isArray(carried.proofIds) ? carried.proofIds : []) if (typeof id === 'string' && UUID.test(id) && !archivedIds.has(id) && !awaitingUnarchiveProof.has(id)) localProofs.add(id);
    for (const id of Array.isArray(carried.nativeProofIds) ? carried.nativeProofIds : []) if (typeof id === 'string' && UUID.test(id) && !archivedIds.has(id) && !awaitingUnarchiveProof.has(id)) nativeProofs.add(id);
    for (const id of Array.isArray(carried.observedIds) ? carried.observedIds : []) if (typeof id === 'string' && UUID.test(id) && !archivedIds.has(id)) observedIds.add(id);
    for (const value of Array.isArray(carried.pending) ? carried.pending : []) {
      if (Number.isSafeInteger(value?.pendingVersion) && value.pendingVersion > 0 && typeof value.actorScopeId === 'string' && SCOPE.test(value.actorScopeId) &&
        typeof value.scopeId === 'string' && SCOPE.test(value.scopeId) && typeof value.threadId === 'string' && UUID.test(value.threadId)) {
        const { pendingVersion: version, producerId: producer, ...body } = value;
        if (typeof producer !== 'string' || !UUID.test(producer)) continue;
        const record = cleanRecord(body, value.threadId, value.scopeId, value.actorScopeId);
        if (!record || archivedIds.has(value.threadId) || awaitingUnarchiveProof.has(value.threadId)) continue;
        const key = `${STORAGE_PREFIX}${value.actorScopeId}:${value.scopeId}:${value.threadId}`;
        dirty.set(key, { ...record, pendingVersion: version, producerId: producer }); queuedSerialized.set(key, JSON.stringify(record));
        pendingVersion = Math.max(pendingVersion, value.pendingVersion);
      }
    }
  }
  function collect(id) {
    const stale = Number.isFinite(snapshot.checkedAt) && Date.now() - snapshot.checkedAt > 30000;
    const metric = id && !archivedIds.has(id) && !awaitingUnarchiveProof.has(id) && snapshot.checkedAt > (archiveTimes.get(id) ?? 0) &&
      snapshot.ok && !accountBlocked && snapshot.checkedAt >= actorEpochAt && Object.hasOwn(snapshot.perThread, id)
      ? snapshot.perThread[id] : null;
    const freshFields = new Set();
    if (!id || accountBlocked || archivedIds.has(id) || awaitingUnarchiveProof.has(id)) return { metric, freshFields, stale };
    loadHistory(id);
    if (metric) {
      let record = history.get(id);
      const revision = typeof metric.revision === 'string' && SCOPE.test(metric.revision) ? metric.revision : null;
      const size = Number.isSafeInteger(metric.rolloutSize) && metric.rolloutSize >= 0 ? metric.rolloutSize : null;
      const mtime = nonnegative(metric.rolloutMtimeMs) ? metric.rolloutMtimeMs : null;
      const replaced = record && (metric.countersReset === true && (!revision || record.revision !== revision) || record.revision && revision && record.revision !== revision ||
        record.rolloutSize !== null && size !== null && size < record.rolloutSize ||
        record.rolloutSize !== null && size === record.rolloutSize && record.rolloutMtimeMs !== null && mtime !== null && mtime !== record.rolloutMtimeMs);
      if (replaced) {
        history.delete(id); lastSerialized.delete(id);
        window.__codexThreadPerformance?.reset?.(id);
        if (actorVerified && actorScopeId && scopeId) try { localStorage.removeItem(storageKey(id)); } catch {}
        record = null;
      }
      if (!record) record = { version: 1, scopeId: threadScopes.get(id) ?? scopeId, actorScopeId,
        threadId: id, updatedAt: snapshot.checkedAt, revision: null, rolloutSize: null, rolloutMtimeMs: null, fields: {} };
      if (revision) record.revision = revision;
      if (size !== null) record.rolloutSize = size;
      if (mtime !== null) record.rolloutMtimeMs = mtime;
      touch(id, record);
      for (const field of Object.keys(formatters)) {
        const isCounter = ['rounds', 'steps'].includes(field);
        const fieldComplete = field === 'rounds' ? metric.roundsComplete : metric.stepsComplete;
        const lowerBound = isCounter && fieldComplete !== true && (fieldComplete === false || metric.countersLowerBound === true);
        const historicalCounter = isCounter && fieldComplete !== true && metric.counterScope === 'last-complete-snapshot';
        const at = historicalCounter && validAt(metric.countersUpdatedAt) ? metric.countersUpdatedAt : snapshot.checkedAt;
        if (remember(id, field, metric[field], { at, source: 'file', lowerBound,
          approximate: metric.timingApproximate === true && ['llmDurationMs', 'tokensPerSecond'].includes(field) }) && !stale && !historicalCounter) freshFields.add(field);
      }
    }
    let measured = null;
    let counters = null;
    if (id) try {
      const monitor = window.__codexThreadPerformance;
      const health = monitor?.status?.();
      const candidate = health?.supported === true && health.active === true && health.connected === true ? monitor.snapshot(id) : null;
      if (candidate?.timingApproximate === true && Number.isSafeInteger(candidate.observedResponses) && candidate.observedResponses > 0 &&
        validAt(candidate.observedSince) && validAt(candidate.lastSampleAt) && candidate.lastSampleAt >= candidate.observedSince &&
        candidate.observedSince >= Math.max(accountChangedAt, monitorEpochs.get(id) ?? archiveTimes.get(id) ?? 0)) measured = candidate;
      if (candidate?.countersLowerBound === true && validAt(candidate.countersUpdatedAt) &&
        validAt(candidate.countersObservedSince) && candidate.countersObservedSince >= Math.max(accountChangedAt, monitorEpochs.get(id) ?? archiveTimes.get(id) ?? 0)) counters = candidate;
    } catch { /* A missing or replaced monitor leaves only the file-backed values. */ }
    if (measured) for (const field of ['llmDurationMs', 'tokensPerSecond']) {
      if (remember(id, field, measured[field], { at: measured.lastSampleAt, source: 'monitor', approximate: true, lowerBound: false,
        observedSince: measured.observedSince, observedResponses: measured.observedResponses })) freshFields.add(field);
    }
    if (counters) for (const [field, observed] of [['rounds', 'observedRounds'], ['steps', 'observedSteps']]) {
      if (remember(id, field, counters[observed], { at: counters.countersUpdatedAt, source: 'monitor', approximate: false, lowerBound: true,
        observedSince: counters.countersObservedSince })) freshFields.add(field);
    }
    const retained = history.get(id);
    if (retained && Object.keys(retained.fields).length) persist(id, retained);
    return { metric, freshFields, stale, measured };
  }
  function render() {
    const { metric, freshFields, stale, measured } = collect(threadId);
    const retained = threadId && !accountBlocked ? history.get(threadId) : null;
    let available = 0;
    let cached = 0;
    for (const [field, span] of values) {
      const entry = retained?.fields[field];
      const formatted = formatters[field](entry?.value);
      const text = formatted ? `${entry.lowerBound ? '≥' : entry.approximate ? '≈' : ''}${formatted}` : '';
      if (span.textContent !== text) span.textContent = text;
      if (text) {
        available++; if (!freshFields.has(field)) cached++;
        const title = `${labels[field]}：${freshFields.has(field) ? '本次读取或观测' : '保留的历史数值'}；${new Date(entry.at).toLocaleString('zh-CN')}。${entry.lowerBound ? '仅表示已确认的下限，不能当作完整会话总数。' : ''}`;
        if (span.title !== title) span.title = title;
      } else if (span.title) span.removeAttribute('title');
    }
    const state = available ? cached > 0 || actorScopeId && !actorVerified ? 'cached' : 'ready' : stale ? 'stale' : 'unknown';
    if (strip.dataset.state !== state) strip.dataset.state = state;
    const id = threadId ?? '';
    if (strip.dataset.threadId !== id) strip.dataset.threadId = id;
    const reason = actorScopeId && !actorVerified && available ? '账户身份正在重新核对；保留本窗口已收集的历史数值。' :
      cached > 0 ? '保留上次已知数值；历史数值不会因会话空闲、监测暂停或暂时读取失败而清空。各项读取或观测时间见对应指标。' :
      measured && !metric ? '当前会话的实时观测独立更新；本地累计记录暂不可读取。' :
      stale ? '数据已过期，等待重新连接。' : !metric ? '此会话暂无可读取的本地指标。' :
      metric.complete === false ? '本地记录不完整；无法确认的指标留空。' : '来自当前会话的本地会话记录；无法读取的指标留空。';
    const timing = '\nLLM：本次有效监测时段完整观测响应阶段的累计耗时，不回算历史。\n≈tok/s：客户端实测响应阶段均速，含推理/工具参数和通知延迟，扣除可观测的工具执行间隔；最近5次有效完整观测，非严格服务端生成速度。';
    const timingEntry = retained?.fields.tokensPerSecond ?? retained?.fields.llmDurationMs;
    const sample = timingEntry?.source === 'monitor' ? `\n监测时段开始 ${new Date(timingEntry.observedSince).toLocaleString('zh-CN')}；已完整观测 ${timingEntry.observedResponses ?? 0} 次响应。\n最近样本 ${new Date(timingEntry.at).toLocaleString('zh-CN')}。` : '';
    const localRead = retained ? `\n最近成功读取或观测 ${new Date(retained.updatedAt).toLocaleString('zh-CN')}。` : '';
    const incomplete = metric?.complete === false ? '\n本地记录仍在回填；轮数、步数带 ≥ 时表示已确认的下限。' : '';
    const description = `${reason}${incomplete}${localRead}\n轮数：开始的会话轮次。步数：已完成的模型响应数；≥ 表示仅有部分历史或本次监测范围，不能与历史总数相加。\n工具调用：已配对工具调用的时间戳间隔（包括等待），并行区间合并。\n首 token：已完成轮次显式记录的首 token 延迟均值。缓存命中：缓存输入 Token / 输入 Token。${timing}${sample}`;
    if (strip.title !== description) strip.title = description;
  }
  function refresh() {
    if (disposed || !document.body) return;
    syncActor();
    if (!style.isConnected) (document.head ?? document.documentElement).append(style);
    for (const duplicate of document.querySelectorAll(`[${MARK}]`)) if (duplicate !== strip) duplicate.remove();
    const next = discover();
    if (composer !== next.root) {
      if (composer) resizeObserver.unobserve(composer);
      composer = next.root;
      if (composer) resizeObserver.observe(composer);
    }
    threadId = next.id;
    render();
    strip.hidden = !composer;
    if (!composer) { strip.remove(); return; }
    // Append an owned child below the whole composer, without wrapping or
    // reparenting React's editor, controls, rail, or input decorations.
    if (strip.parentElement !== composer || strip !== composer.lastElementChild) composer.append(strip);
  }
  function scheduleRefresh() {
    if (disposed || refreshTimer !== null) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 80);
  }
  const owned = node => node === style || node === strip || strip.contains(node);
  const observer = new MutationObserver(records => {
    if (records.some(record => !owned(record.target) &&
      (record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(node => !owned(node))))) scheduleRefresh();
  });
  const resizeObserver = new ResizeObserver(scheduleRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-above-composer-conversation-id', 'data-composer-placement',
      'data-app-shell-active-page', 'data-app-action-sidebar-thread-id',
      'data-app-action-sidebar-thread-host-id', 'data-app-action-sidebar-thread-kind',
      'class', 'style', 'hidden', 'inert', 'aria-hidden'] });
  // Also repairs a strip removed by a native rerender, without observing our
  // own text updates and creating a mutation/placement loop.
  const freshnessTimer = setInterval(refresh, 1000);
  window.addEventListener('resize', scheduleRefresh);
  window.addEventListener('popstate', scheduleRefresh);
  window.addEventListener('hashchange', scheduleRefresh);
  window.addEventListener('codex-thread-metrics-account-scope-changed', refresh);
  document.addEventListener('visibilitychange', scheduleRefresh);
  function requestedIds() {
    syncActor();
    if (accountBlocked) return [];
    const primary = discover().candidate;
    const pending = [...observedIds].filter(id => id !== primary);
    const rotated = pending.length ? pending.slice(requestCursor % pending.length).concat(pending.slice(0, requestCursor % pending.length)) : [];
    const batch = rotated.slice(0, primary ? 7 : 8);
    requestCursor += batch.length;
    return primary ? [primary, ...batch] : batch;
  }
  function captureThread(id) {
    if (disposed || typeof id !== 'string' || !UUID.test(id)) return;
    if (archivedIds.has(id)) return;
    if (awaitingUnarchiveProof.has(id)) { observedIds.add(id); return; }
    syncActor();
    if (accountBlocked) return;
    nativeProofs.add(id); observedIds.add(id); collect(id);
  }
  function projectMetrics(source) {
    const projected = {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return projected;
    for (const [id, metric] of Object.entries(source)) {
      if (!UUID.test(id) || !metric || typeof metric !== 'object' || Array.isArray(metric)) continue;
      const clean = {};
      for (const field of Object.keys(formatters)) clean[field] = validField(field, metric[field]) ? metric[field] : null;
      for (const field of ['localVerified', 'archived', 'complete', 'roundsComplete', 'stepsComplete', 'countersLowerBound', 'countersReset', 'timingApproximate', 'backfilling'])
        if (typeof metric[field] === 'boolean') clean[field] = metric[field];
      for (const field of ['scopeId', 'revision']) if (typeof metric[field] === 'string' && SCOPE.test(metric[field])) clean[field] = metric[field].toLowerCase();
      if (Number.isSafeInteger(metric.rolloutSize) && metric.rolloutSize >= 0) clean.rolloutSize = metric.rolloutSize;
      if (nonnegative(metric.rolloutMtimeMs) && metric.rolloutMtimeMs <= Date.now() + 1000) clean.rolloutMtimeMs = metric.rolloutMtimeMs;
      if (validAt(metric.countersUpdatedAt)) clean.countersUpdatedAt = metric.countersUpdatedAt;
      if (['full-history', 'history-lower-bound', 'last-complete-snapshot'].includes(metric.counterScope)) clean.counterScope = metric.counterScope;
      projected[id] = clean;
    }
    return projected;
  }
  function purgeArchivedBefore(id, cutoff) {
    if (disposed || typeof id !== 'string' || !UUID.test(id) || !validAt(cutoff)) return;
    const priorCutoff = archiveTimes.get(id) ?? 0;
    archiveTimes.set(id, Math.max(archiveTimes.get(id) ?? 0, cutoff));
    if (cutoff > priorCutoff) {
      let since = null;
      try { since = window.__codexThreadPerformance?.snapshot?.(id)?.observedSince ?? null; } catch {}
      if (!validAt(since) || since < cutoff) {
        const epoch = Date.now(); window.__codexThreadPerformance?.reset?.(id); monitorEpochs.set(id, epoch);
      }
    }
    const record = history.get(id);
    if (record) {
      const clean = cleanRecord(record, id, record.scopeId, record.actorScopeId);
      if (clean) touch(id, clean); else history.delete(id);
    }
    for (const [key, pending] of dirty) if (pending.threadId === id) {
      const { pendingVersion: version, producerId: producer, ...body } = pending;
      const clean = cleanRecord(body, id, body.scopeId, body.actorScopeId);
      if (!clean) { dirty.delete(key); queuedSerialized.delete(key); }
      else if (Object.keys(clean.fields).length !== Object.keys(body.fields).length) {
        const serialized = JSON.stringify(clean);
        dirty.set(key, { ...clean, pendingVersion: ++pendingVersion, producerId });
        queuedSerialized.set(key, serialized);
      }
      acknowledged.delete(key);
    }
    lastSerialized.delete(id); loaded.delete(id);
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(STORAGE_PREFIX) && key.endsWith(`:${id}`)) keys.push(key);
      }
      for (const key of keys) {
        let clean = null;
        try {
          const value = JSON.parse(localStorage.getItem(key));
          clean = cleanRecord(value, id, value.scopeId, value.actorScopeId);
        } catch {}
        if (clean) localStorage.setItem(key, JSON.stringify(clean)); else localStorage.removeItem(key);
        acknowledged.delete(key);
      }
    } catch { storageFailures++; }
    refresh();
  }
  function archiveThread(id, { queue = true, checkedAt = null } = {}) {
    if (disposed || typeof id !== 'string' || !UUID.test(id)) return;
    if (archivedIds.has(id)) return;
    const at = validAt(checkedAt) ? checkedAt : Math.max(Date.now(), (unarchiveTimes.get(id) ?? 0) + 1);
    if (at < (unarchiveTimes.get(id) ?? 0)) return;
    archiveTimes.set(id, Math.max(archiveTimes.get(id) ?? 0, at));
    archivedIds.add(id); awaitingUnarchiveProof.delete(id);
    if (queue) pendingArchiveIds.set(id, Math.max(pendingArchiveIds.get(id) ?? 0, at));
    history.delete(id); lastSerialized.delete(id); loaded.delete(id);
    threadScopes.delete(id); localProofs.delete(id); nativeProofs.delete(id); observedIds.delete(id);
    delete snapshot.perThread[id];
    for (const map of [dirty, queuedSerialized, acknowledged]) for (const key of map.keys()) if (key.endsWith(`:${id}`)) map.delete(key);
    if (typeof window.__codexThreadPerformance?.archiveThread === 'function') window.__codexThreadPerformance.archiveThread(id);
    else window.__codexThreadPerformance?.reset?.(id);
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(STORAGE_PREFIX) && key.endsWith(`:${id}`)) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    } catch { storageFailures++; }
    refresh();
  }
  function unarchiveThread(id, { checkedAt = null } = {}) {
    if (disposed || typeof id !== 'string' || !UUID.test(id)) return;
    if (!archivedIds.has(id) && (awaitingUnarchiveProof.has(id) || unarchiveTimes.has(id))) return;
    const at = validAt(checkedAt) ? checkedAt : Math.max(Date.now(), (archiveTimes.get(id) ?? 0) + 1);
    if (at <= (archiveTimes.get(id) ?? 0) || at < (unarchiveTimes.get(id) ?? 0)) return;
    unarchiveTimes.set(id, at); archivedIds.delete(id); awaitingUnarchiveProof.add(id);
    localProofs.delete(id); nativeProofs.delete(id); threadScopes.delete(id); loaded.delete(id); lastSerialized.delete(id);
    delete snapshot.perThread[id]; observedIds.add(id);
    if (typeof window.__codexThreadPerformance?.unarchiveThread === 'function') window.__codexThreadPerformance.unarchiveThread(id);
    const epoch = Date.now(); window.__codexThreadPerformance?.reset?.(id); monitorEpochs.set(id, epoch);
    refresh();
  }
  window[KEY] = {
    version: VERSION, refresh,
    requestedIds,
    persistenceContext() { syncActor(); return { actorScopeId: actorVerified && !accountBlocked ? actorScopeId : null }; },
    requestedContext() { return { ...this.persistenceContext(), threadIds: requestedIds() }; },
    captureThread, observe: captureThread,
    archiveThread, unarchiveThread, purgeArchivedBefore, discardBefore: purgeArchivedBefore,
    pendingArchives() { return [...pendingArchiveIds].map(([threadId, archivedAt]) => ({ threadId, archivedAt })); },
    ackArchives(records) {
      for (const record of Array.isArray(records) ? records : []) {
        if (typeof record?.threadId === 'string' && pendingArchiveIds.get(record.threadId) === record.archivedAt) pendingArchiveIds.delete(record.threadId);
      }
    },
    update(next) {
      syncActor();
      if (!acceptScope(next)) { refresh(); return; }
      for (const id of Array.isArray(next?.archivedIds) ? next.archivedIds : []) archiveThread(id, { queue: false, checkedAt: next.checkedAt });
      for (const removal of Array.isArray(next?.removedMetrics) ? next.removedMetrics : []) purgeArchivedBefore(removal?.threadId, removal?.archivedAt);
      for (const [id, cutoff] of Object.entries(next?.purgedBefore && typeof next.purgedBefore === 'object' ? next.purgedBefore : {})) purgeArchivedBefore(id, cutoff);
      snapshot = { ok: next?.ok === true, checkedAt: validAt(next?.checkedAt) ? next.checkedAt : null,
        perThread: projectMetrics(next?.perThread) };
      for (const [id, metric] of Object.entries(snapshot.perThread)) {
        if (!UUID.test(id) || !metric || typeof metric !== 'object') continue;
        if (metric.archived === true) { archiveThread(id, { queue: false, checkedAt: snapshot.checkedAt }); delete snapshot.perThread[id]; continue; }
        if (archivedIds.has(id) && metric.archived === false && metric.localVerified === true && snapshot.checkedAt > (archiveTimes.get(id) ?? 0)) {
          unarchiveThread(id, { checkedAt: snapshot.checkedAt }); snapshot.perThread[id] = metric;
        }
        if (archivedIds.has(id) || snapshot.checkedAt <= (archiveTimes.get(id) ?? 0) || snapshot.checkedAt < (unarchiveTimes.get(id) ?? 0)) { delete snapshot.perThread[id]; continue; }
        if (awaitingUnarchiveProof.has(id)) {
          if (metric.localVerified !== true) { delete snapshot.perThread[id]; continue; }
          awaitingUnarchiveProof.delete(id);
        }
        if (snapshot.ok && snapshot.checkedAt >= actorEpochAt && metric.localVerified === true && !accountBlocked) {
          const localScope = typeof metric.scopeId === 'string' && SCOPE.test(metric.scopeId) ? metric.scopeId : scopeId;
          const priorScope = threadScopes.get(id);
          if (priorScope && localScope && priorScope !== localScope) {
            history.delete(id); loaded.delete(id); lastSerialized.delete(id);
          }
          if (localScope) threadScopes.set(id, localScope);
          localProofs.add(id);
          const prior = history.get(id);
          if (prior && !priorScope) { prior.scopeId = localScope; prior.actorScopeId = actorScopeId; }
          if (metric.complete === true) observedIds.delete(id); else observedIds.add(id);
          const saved = next?.persistedPerThread?.[id];
          if (saved && actorVerified && localScope) {
            const mismatched = typeof metric.revision === 'string' && metric.revision !== saved.revision ||
              Number.isSafeInteger(metric.rolloutSize) && Number.isSafeInteger(saved.rolloutSize) && metric.rolloutSize < saved.rolloutSize ||
              metric.rolloutSize === saved.rolloutSize && nonnegative(metric.rolloutMtimeMs) && nonnegative(saved.rolloutMtimeMs) && metric.rolloutMtimeMs !== saved.rolloutMtimeMs;
            const record = mismatched ? null : cleanRecord(saved, id, localScope);
            if (record) {
              const prior = history.get(id);
              if (!prior) touch(id, record);
              else {
                for (const [field, entry] of Object.entries(record.fields)) {
                  const existing = prior.fields[field];
                  if (!existing || existing.at < entry.at || ['rounds', 'steps'].includes(field) && existing.lowerBound && entry.value > existing.value) prior.fields[field] = entry;
                }
                if (!prior.revision) prior.revision = record.revision;
                if (prior.rolloutSize === null) prior.rolloutSize = record.rolloutSize;
                if (prior.rolloutMtimeMs === null) prior.rolloutMtimeMs = record.rolloutMtimeMs;
                prior.updatedAt = Math.max(prior.updatedAt, record.updatedAt);
              }
            }
          }
        }
        if (!accountBlocked && (localProofs.has(id) || nativeProofs.has(id) || discover().id === id)) collect(id);
      }
      refresh();
    },
    pendingSnapshots() { return [...dirty.values()].map(record => JSON.parse(JSON.stringify(record))); },
    ackPersisted(records) {
      for (const record of Array.isArray(records) ? records : []) {
        if (typeof record?.actorScopeId !== 'string' || typeof record.scopeId !== 'string' || typeof record.threadId !== 'string') continue;
        const key = `${STORAGE_PREFIX}${record.actorScopeId}:${record.scopeId}:${record.threadId}`;
        if (dirty.get(key)?.pendingVersion === record.pendingVersion && dirty.get(key)?.producerId === record.producerId) {
          dirty.delete(key); acknowledged.set(key, queuedSerialized.get(key));
        }
      }
    },
    retainedState() { return { version: 1, producerId, scopeId, actorScopeId, actorEpochAt, scopeCheckedAt, accountChangedAt, accountBlocked,
      records: [...history.values()], proofIds: [...localProofs], nativeProofIds: [...nativeProofs], observedIds: [...observedIds], pending: this.pendingSnapshots(),
      archivedIds: [...archivedIds], archiveTimes: [...archiveTimes], unarchiveTimes: [...unarchiveTimes],
      monitorEpochs: [...monitorEpochs], awaitingUnarchiveProof: [...awaitingUnarchiveProof], pendingArchiveIds: [...pendingArchiveIds] }; },
    status() { return { version: VERSION, placed: strip.isConnected && !strip.hidden && visible(strip),
      threadId, state: strip.dataset.state, available: [...values.values()].filter(el => el.textContent !== '').length,
      checkedAt: snapshot.checkedAt, ok: snapshot.ok, cachedThreads: history.size, pendingSnapshots: dirty.size,
      actorVerified, accountBlocked, storageFailures, archivedThreads: archivedIds.size, pendingArchives: pendingArchiveIds.size,
      stripCount: document.querySelectorAll(`[${MARK}]`).length }; },
    destroy({ clearStorage = false } = {}) {
      disposed = true; observer.disconnect(); resizeObserver.disconnect();
      clearTimeout(refreshTimer); clearInterval(freshnessTimer);
      window.removeEventListener('resize', scheduleRefresh);
      window.removeEventListener('popstate', scheduleRefresh); window.removeEventListener('hashchange', scheduleRefresh);
      window.removeEventListener('codex-thread-metrics-account-scope-changed', refresh);
      document.removeEventListener('visibilitychange', scheduleRefresh);
      if (clearStorage) try {
        const keys = [];
        for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key?.startsWith(STORAGE_PREFIX)) keys.push(key); }
        for (const key of keys) localStorage.removeItem(key);
      } catch {}
      strip.remove(); style.remove(); delete window[KEY];
    }
  };
  refresh();
}
