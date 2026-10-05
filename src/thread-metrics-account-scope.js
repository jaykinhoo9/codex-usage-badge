// Serialized into the renderer. Only an opaque identity digest is exposed;
// no credential, email or account metadata is retained or persisted.
function installThreadMetricsAccountScope({ requestTimeoutMs = 7000, pollIntervalMs = 300000, minRefreshMs = 1000 } = {}) {
  const VERSION = 1;
  const KEY = '__codexThreadMetricsAccount';
  const EVENT = 'codex-thread-metrics-account-scope-changed';
  if (window[KEY]?.version === VERSION) return;
  window[KEY]?.destroy?.();
  const bridge = window.electronBridge;
  const supported = window.codexWindowType === 'electron' && bridge?.windowType === 'electron' &&
    typeof bridge.sendMessageFromView === 'function' && typeof window.crypto?.subtle?.digest === 'function' &&
    typeof window.crypto?.randomUUID === 'function' && typeof TextEncoder === 'function';
  const CONNECTION_STATES = new Set(['connected', 'disconnected', 'connecting', 'restarting', 'error']);
  const timeoutMs = Math.max(1, Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 7000);
  const pollMs = Math.max(1, Number.isFinite(pollIntervalMs) ? pollIntervalMs : 300000);
  const minimumMs = Math.max(1, Number.isFinite(minRefreshMs) ? minRefreshMs : 1000);
  let disposed = false, scopeId = null, checkedAt = null, pending = false;
  let reason = 'initial', changeEpoch = 0, generation = 0;
  let connectionState = supported ? 'unknown' : 'unsupported';
  let active = null, scheduled = null, pollTimer = null;
  let lastAttemptAt = -Infinity, requests = 0, failures = 0;

  function snapshot() {
    return { scopeId, checkedAt, pending, supported, reason, changeEpoch };
  }
  function notify() {
    if (disposed) return;
    try { window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot() })); } catch {}
    try { window.__codexThreadMetrics?.refresh?.(); } catch {}
  }
  function cancelActive() {
    if (!active) return;
    const previous = active; active = null;
    clearTimeout(previous.timer); previous.resolve(snapshot());
  }
  function cancelScheduled() {
    if (!scheduled) return;
    const previous = scheduled; scheduled = null;
    clearTimeout(previous.timer); previous.resolve(snapshot());
  }
  function invalidate(nextReason, willRefresh) {
    generation++; changeEpoch++;
    scopeId = null; checkedAt = null; reason = nextReason; pending = Boolean(willRefresh);
    cancelActive(); cancelScheduled(); notify();
  }
  function finish(request, digest, nextReason) {
    if (disposed || active !== request || request.generation !== generation) return;
    active = null; clearTimeout(request.timer);
    scopeId = digest; checkedAt = Date.now(); pending = false; reason = nextReason;
    if (!digest && nextReason === 'read-failed') failures++;
    request.resolve(snapshot()); notify();
  }
  function identityBytes(message) {
    // This synchronous projection discards the whole response before hashing.
    // The account-info endpoint is verified to return identity metadata only.
    if (message.responseType !== 'success' || message.status !== 200) return { kind: 'failed' };
    let body;
    try { body = Object.hasOwn(message, 'body') ? message.body : JSON.parse(message.bodyJsonString); } catch { return { kind: 'failed' }; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'failed' };
    const account = body.accountId, user = body.userId;
    if (account === null && user === null) return { kind: 'signed-out' };
    if (typeof account !== 'string' || !account || account.length > 256 ||
      typeof user !== 'string' || !user || user.length > 256) return { kind: 'failed' };
    return { kind: 'identity', bytes: new TextEncoder().encode(JSON.stringify([account, user])) };
  }
  function onMessage(event) {
    if (disposed || !supported || event.source !== null || event.origin !== '') return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'fetch-response' && active && message.requestId === active.id && !active.received) {
      const request = active; request.received = true;
      const projected = identityBytes(message);
      if (projected.kind !== 'identity') { finish(request, null, projected.kind === 'signed-out' ? 'signed-out' : 'read-failed'); return; }
      try {
        window.crypto.subtle.digest('SHA-256', projected.bytes).then(bytes => {
          const digest = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
          finish(request, /^[a-f0-9]{64}$/.test(digest) ? digest : null, /^[a-f0-9]{64}$/.test(digest) ? 'verified' : 'read-failed');
        }, () => finish(request, null, 'read-failed'));
      } catch { finish(request, null, 'read-failed'); }
      return;
    }
    if (message.hostId !== 'local') return;
    if (message.type === 'mcp-notification' &&
      (message.method === 'account/updated' || message.method === 'account/login/completed')) {
      const canRead = connectionState === 'unknown' || connectionState === 'connected';
      invalidate('account-change', canRead);
      if (canRead) refresh(true);
    } else if (message.type === 'codex-app-server-connection-changed' && CONNECTION_STATES.has(message.state)) {
      if (message.state === connectionState) return;
      connectionState = message.state;
      const canRead = connectionState === 'connected';
      invalidate('connection-change', canRead);
      if (canRead) refresh(true);
    }
  }
  function startRead() {
    const request = { id: window.crypto.randomUUID(), generation, received: false, resolve: null, timer: null, promise: null };
    request.promise = new Promise(resolve => { request.resolve = resolve; });
    active = request; lastAttemptAt = Date.now(); requests++; pending = true;
    request.timer = setTimeout(() => finish(request, null, 'read-failed'), timeoutMs);
    notify();
    try {
      // Read-only desktop-native fetch: no auth headers, tokens or user content.
      Promise.resolve(bridge.sendMessageFromView({ type: 'fetch', requestId: request.id,
        method: 'GET', url: 'vscode://codex/account-info' })).catch(() => finish(request, null, 'read-failed'));
    } catch { finish(request, null, 'read-failed'); }
    return request.promise;
  }
  function refresh(force = false) {
    if (disposed || !supported || !['unknown', 'connected'].includes(connectionState)) return Promise.resolve(snapshot());
    if (active) return active.promise;
    if (scheduled) return scheduled.promise;
    if (!force && scopeId && Number.isFinite(checkedAt) && Date.now() - checkedAt < pollMs) return Promise.resolve(snapshot());
    if (Date.now() < lastAttemptAt) lastAttemptAt = -Infinity;
    const delay = minimumMs - (Date.now() - lastAttemptAt);
    if (delay > 0) {
      const queued = { timer: null, resolve: null, promise: null, generation };
      queued.promise = new Promise(resolve => { queued.resolve = resolve; }); scheduled = queued; pending = true; notify();
      queued.timer = setTimeout(() => {
        if (scheduled !== queued) return;
        scheduled = null;
        if (disposed || queued.generation !== generation) { queued.resolve(snapshot()); return; }
        refresh(true).then(queued.resolve);
      }, delay);
      return queued.promise;
    }
    return startRead();
  }
  if (supported) {
    window.addEventListener('message', onMessage);
    pollTimer = setInterval(() => { refresh(); }, pollMs);
  }
  window[KEY] = {
    version: VERSION, snapshot, refresh,
    status() { return { version: VERSION, ...snapshot(), connectionState, requests, failures,
      activeRequest: Boolean(active), scheduledRefresh: Boolean(scheduled), source: 'native-account-info-digest' }; },
    destroy() {
      if (disposed) return;
      disposed = true; generation++; scopeId = null; pending = false;
      window.removeEventListener('message', onMessage); clearInterval(pollTimer);
      cancelActive(); cancelScheduled();
      if (window[KEY] === this) delete window[KEY];
    }
  };
  if (supported) refresh();
}
