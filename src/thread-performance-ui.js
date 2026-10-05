function installThreadPerformanceMonitor(createTracker) {
  const VERSION = 5;
  const KEY = '__codexThreadPerformance';
  if (window[KEY]?.version === VERSION) return;
  window[KEY]?.destroy?.();
  if (typeof createTracker !== 'function') return;
  const tracker = createTracker();
  const supported = window.codexWindowType === 'electron' && window.electronBridge?.windowType === 'electron';
  const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const METHODS = new Set(['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated', 'thread/compacted']);
  const ITEM_TYPES = new Set(['reasoning', 'agentMessage', 'plan', 'commandExecution', 'fileChange',
    'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity',
    'webSearch', 'imageView', 'imageGeneration', 'sleep', 'hookPrompt', 'contextCompaction']);
  const TURN_STATUSES = new Set(['inProgress', 'completed', 'interrupted', 'failed']);
  const CONNECTION_STATES = new Set(['connected', 'disconnected', 'connecting', 'restarting', 'error']);
  const TOKEN_FIELDS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
  let disposed = false;
  let connected = supported;
  let paused = document.hidden;
  let notifications = 0;
  let failures = 0;
  let lastNotificationAt = null;
  const trackedIds = new Set();
  const archivedIds = new Set();
  function captureThread(id) {
    try { window.__codexThreadMetrics?.captureThread?.(id); } catch {}
  }
  function captureAll() { for (const id of trackedIds) captureThread(id); }
  function clearMeasurements() { tracker.reset(); trackedIds.clear(); }
  const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const identifier = value => typeof value === 'string' && value.length <= 256 && /^[a-z0-9_.:-]+$/i.test(value);
  function tokenCounts(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const counts = {};
    for (const field of TOKEN_FIELDS) {
      if (Number.isSafeInteger(source[field]) && source[field] >= 0) counts[field] = source[field];
    }
    return counts;
  }
  function project(message) {
    if (!METHODS.has(message.method)) return null;
    const source = message.params;
    if (!source || typeof source !== 'object' || typeof source.threadId !== 'string' || !UUID.test(source.threadId)) return null;
    // Select individual scalar fields. Never copy a native params object: it
    // may contain the prompt, reasoning text, commands or tool output.
    const params = { threadId: source.threadId };
    if (identifier(source.turnId)) params.turnId = source.turnId;
    if (message.method.startsWith('turn/')) {
      if (!identifier(source.turn?.id) || !TURN_STATUSES.has(source.turn?.status)) return null;
      params.turn = { id: source.turn.id, status: source.turn.status };
    } else if (message.method.startsWith('item/')) {
      if (!identifier(source.item?.id) || !ITEM_TYPES.has(source.item?.type)) return null;
      params.item = { id: source.item.id, type: source.item.type };
      for (const field of ['startedAtMs', 'completedAtMs']) if (timestamp(source[field])) params[field] = source[field];
    } else if (message.method === 'thread/tokenUsage/updated') {
      const total = tokenCounts(source.tokenUsage?.total);
      const last = tokenCounts(source.tokenUsage?.last);
      if (!total || !last) return null;
      params.tokenUsage = { total, last };
    }
    return { method: message.method, params };
  }
  function onMessage(event) {
    if (disposed || !supported || event.source !== null || event.origin !== '') return;
    const message = event.data;
    if (!message || typeof message !== 'object' || message.hostId !== 'local' ||
      message.marker === 'codex-host-chunked-message-v1') return;
    try {
      if (message.type === 'mcp-notification' &&
        (message.isSnapshot === true || message.isReplay === true || message.replay === true)) {
        const id = message.params?.threadId;
        if (typeof id === 'string' && UUID.test(id)) captureThread(id); else captureAll();
        tracker.reset(typeof id === 'string' && UUID.test(id) ? id : undefined);
        window.__codexThreadMetrics?.refresh?.();
        return;
      }
      if (message.type === 'codex-app-server-connection-changed') {
        // These are verified native connection-state values. Other
        // native status messages do not establish a new measurement window.
        if (CONNECTION_STATES.has(message.state)) {
          const next = message.state === 'connected';
          if (next !== connected) { captureAll(); clearMeasurements(); }
          connected = next;
          window.__codexThreadMetrics?.refresh?.();
        }
        return;
      }
      if (message.type === 'mcp-notification' && ['thread/archived', 'thread/unarchived'].includes(message.method)) {
        const id = message.params?.threadId;
        if (typeof id !== 'string' || !UUID.test(id)) return;
        if (message.method === 'thread/archived') {
          archivedIds.add(id); tracker.forget?.(id); trackedIds.delete(id);
          window.__codexThreadMetrics?.archiveThread?.(id);
        } else {
          if (archivedIds.delete(id)) { tracker.reset(id); trackedIds.delete(id); }
          window.__codexThreadMetrics?.unarchiveThread?.(id);
        }
        return;
      }
      if (!connected || paused || message.type !== 'mcp-notification') return;
      const record = project(message);
      if (!record) return;
      const id = record.params.threadId;
      if (archivedIds.has(id)) return;
      // Persist a thread's last known values before an epoch reset or LRU
      // eviction, including conversations whose composer is not in view.
      if (!trackedIds.has(id) && trackedIds.size >= 16) {
        const oldest = trackedIds.values().next().value;
        captureThread(oldest); trackedIds.delete(oldest);
      }
      trackedIds.delete(id); trackedIds.add(id);
      captureThread(id);
      const receivedAt = Date.now();
      tracker.record(record, receivedAt);
      lastNotificationAt = receivedAt; notifications++;
      captureThread(id);
    } catch {
      // An unsupported native payload must not interrupt the app's own
      // notification listeners or log any sensitive message contents.
      failures++;
    }
  }
  function onVisibility() {
    const next = document.hidden;
    if (paused !== next) { captureAll(); clearMeasurements(); paused = next; window.__codexThreadMetrics?.refresh?.(); }
  }
  if (supported) {
    window.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
  }
  window[KEY] = {
    version: VERSION,
    snapshot(id) { return !disposed && supported && connected && !paused && !archivedIds.has(id) && typeof id === 'string' && UUID.test(id) ? tracker.snapshot(id) : null; },
    archiveThread(id) { if (typeof id === 'string' && UUID.test(id)) { archivedIds.add(id); tracker.forget?.(id); trackedIds.delete(id); } },
    unarchiveThread(id) { if (typeof id === 'string' && UUID.test(id) && archivedIds.delete(id)) { tracker.reset(id); trackedIds.delete(id); } },
    reset(id) {
      if (typeof id === 'string' && UUID.test(id)) { tracker.reset(id); trackedIds.delete(id); }
      else clearMeasurements();
    },
    status() { return { version: VERSION, supported, active: !disposed && supported && !paused, connected, paused,
      source: 'native-local-notifications', notifications, failures, lastNotificationAt, tracker: tracker.status() }; },
    destroy() {
      disposed = true; window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('focus', onVisibility);
      trackedIds.clear(); archivedIds.clear(); tracker.stop();
      if (window[KEY] === this) delete window[KEY];
    }
  };
}
