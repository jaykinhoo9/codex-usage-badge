// Self-contained: this function is also serialized into the renderer. It never
// examines text deltas or estimates tokens from characters.
function createThreadPerformanceTracker({
  now = () => Date.now(), maxThreads = 16, maxItems = 500,
  recentResponses = 5, maxGapMs = 300000, maxWindowMs = 1800000,
  clockToleranceMs = 2000, maxCounterEvents = 10000,
} = {}) {
  const threads = new Map();
  let observedSince = now(), stopped = false;
  const modelTypes = new Set(['reasoning', 'agentMessage', 'plan']);
  const toolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
    'collabAgentToolCall', 'collabToolCall', 'webSearch', 'imageView', 'extension', 'subAgentActivity',
    'imageGeneration', 'sleep', 'hookPrompt']);
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const newState = (at, turnId = null) => ({ observedSince: at, turnId, closed: false, capturedTurn: false,
    baseline: null, pending: null, items: new Map(), duration: 0, responses: 0, samples: [],
    lastSampleAt: null, lastEventAt: at, lastBoundary: null, lastModelEnd: null,
    lastBatchIds: new Set(), invalidWindow: false, counterRoundIds: new Set(), counterStepKeys: new Set(), countersUpdatedAt: null, countersObservedSince: at });
  const empty = at => ({ llmDurationMs: null, tokensPerSecond: null, timingApproximate: true,
    observedSince: at, observedResponses: 0, lastSampleAt: null,
    observedRounds: null, observedSteps: null, countersScope: 'since-monitor-start', countersLowerBound: true, countersUpdatedAt: null, countersObservedSince: at });

  function clearWindow(state, clearRate = true) {
    state.pending = null; state.items.clear(); state.baseline = null;
    state.capturedTurn = false; state.lastBoundary = null;
    state.lastModelEnd = null; state.lastBatchIds.clear(); state.invalidWindow = false;
    if (clearRate) state.samples = [];
  }
  function get(threadId, at) {
    let state = threads.get(threadId);
    if (!state) state = newState(observedSince);
    threads.delete(threadId); threads.set(threadId, state);
    while (threads.size > Math.max(1, maxThreads)) threads.delete(threads.keys().next().value);
    return state;
  }
  function restart(threadId, at, turnId = null, preserveCounters = true) {
    const previous = threads.get(threadId);
    const state = newState(at, turnId);
    if (previous && preserveCounters) {
      state.counterRoundIds = previous.counterRoundIds; state.counterStepKeys = previous.counterStepKeys;
      state.countersUpdatedAt = previous.countersUpdatedAt; state.countersObservedSince = previous.countersObservedSince;
    }
    threads.delete(threadId); threads.set(threadId, state);
    return state;
  }
  function unionDuration(intervals) {
    intervals.sort((a, b) => a[0] - b[0]);
    let start = null, end = null, sum = 0;
    for (const interval of intervals) {
      if (start === null) [start, end] = interval;
      else if (interval[0] <= end) end = Math.max(end, interval[1]);
      else { sum += end - start; [start, end] = interval; }
    }
    return start === null ? 0 : sum + end - start;
  }
  function usage(value) {
    if (!value || typeof value !== 'object') return null;
    const total = value.total, last = value.last;
    if (!total || !last || !integer(total.inputTokens) || !integer(total.outputTokens) || !integer(last.outputTokens)
      || !integer(last.reasoningOutputTokens) || last.reasoningOutputTokens > last.outputTokens) return null;
    const fields = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
    // Retain numeric projections only, even if a caller accidentally passes raw
    // protocol params or private string properties.
    const project = input => Object.fromEntries(fields.map(key => [key, integer(input[key]) ? input[key] : null]));
    const cleanTotal = project(total), cleanLast = project(last);
    return { total: cleanTotal, last: cleanLast,
      fingerprint: fields.map(key => cleanTotal[key]).join(':'),
      lastFingerprint: fields.map(key => cleanLast[key]).join(':') };
  }

  function record(message, receivedAt = now()) {
    if (stopped || !integer(receivedAt) || !message || typeof message !== 'object') return false;
    const method = message.method;
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated', 'thread/compacted'].includes(method)) return false;
    const params = message.params;
    if (!params || typeof params !== 'object' || !uuid(params.threadId)) return false;
    const threadId = params.threadId;
    const turnId = method.startsWith('turn/') ? params.turn?.id : params.turnId;
    if (!identity(turnId) && method !== 'thread/compacted') return false;
    let state = get(threadId, receivedAt);
    // A captured response can legitimately think for several minutes without
    // visible deltas. Its eventual item timestamps still must be delivered
    // promptly; idle gaps restart observation instead.
    if (receivedAt < state.lastEventAt || !state.pending && receivedAt - state.lastEventAt > maxGapMs) state = restart(threadId, receivedAt, turnId);
    state.lastEventAt = receivedAt;
    if (method === 'thread/compacted' || params.item?.type === 'contextCompaction') {
      restart(threadId, receivedAt, turnId); return false;
    }
    if (state.turnId !== turnId) {
      // Ordinary turn changes preserve the sum of validated observed windows.
      clearWindow(state); state.turnId = turnId; state.closed = false;
    }
    // Counters describe observed native lifecycle events, independently of
    // whether response timing was complete enough to accept a speed sample.
    if ((method === 'turn/started' || method === 'turn/completed') && !state.counterRoundIds.has(turnId)
      && state.counterRoundIds.size < Math.max(1, maxCounterEvents)) {
      state.counterRoundIds.add(turnId); state.countersUpdatedAt = receivedAt;
    }
    if (method === 'thread/tokenUsage/updated') {
      const total = params.tokenUsage?.total;
      if (total && integer(total.inputTokens) && integer(total.outputTokens) && (total.inputTokens > 0 || total.outputTokens > 0)) {
        // Cache/reasoning detail can be absent on an otherwise mirrored event.
        // Cumulative input/output are sufficient to identify progress and avoid
        // recounting one completion when optional metadata changes shape.
        const key = `${total.inputTokens}:${total.outputTokens}`;
        if (!state.counterStepKeys.has(key) && state.counterStepKeys.size < Math.max(1, maxCounterEvents)) {
          state.counterStepKeys.add(key); state.countersUpdatedAt = receivedAt;
        }
      }
    }
    if (method === 'turn/started') {
      if (!state.capturedTurn) {
        clearWindow(state); state.capturedTurn = true; state.closed = false;
      }
      return true;
    }
    if (method === 'turn/completed') {
      if (params.turn.status === 'failed' || params.turn.status === 'interrupted') restart(threadId, receivedAt);
      else { state.pending = null; state.items.clear(); state.baseline = null; state.closed = true; }
      return true;
    }
    if (state.closed) return false;

    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (!item || !modelTypes.has(item.type) && !toolTypes.has(item.type)) return false;
      if (!identity(item.id)) { state.invalidWindow = true; if (state.pending) state.pending.invalid = true; return false; }
      const kind = modelTypes.has(item.type) ? 'model' : 'tool';
      const started = method === 'item/started';
      const timestamp = started ? params.startedAtMs : params.completedAtMs;
      if (!integer(timestamp) || timestamp < state.observedSince || timestamp > receivedAt + clockToleranceMs
        || receivedAt - timestamp > clockToleranceMs) {
        state.invalidWindow = true;
        if (state.pending) state.pending.invalid = true;
        return false;
      }
      let entry = state.items.get(item.id);
      if (started) {
        if (entry) {
          if (entry.start !== timestamp || entry.kind !== kind) { state.invalidWindow = true; if (state.pending) state.pending.invalid = true; }
          return false;
        }
        // Historical starts and overlapping response windows cannot be assigned
        // to a new completion without upstream response IDs.
        const previousEnd = state.lastModelEnd ?? state.lastBoundary;
        if (state.lastBatchIds.has(item.id) || previousEnd !== null && timestamp < previousEnd) {
          state.invalidWindow = true;
          if (state.pending) state.pending.invalid = true;
          return false;
        }
        if (state.items.size >= Math.max(1, maxItems)) { restart(threadId, receivedAt, turnId); return false; }
        entry = { kind, type: item.type, start: timestamp, end: null };
        state.items.set(item.id, entry);
        if (kind === 'model') {
          if (!state.pending) state.pending = { start: timestamp, modelIds: new Set(), invalid: state.invalidWindow };
          state.pending.start = Math.min(state.pending.start, timestamp);
          state.pending.modelIds.add(item.id);
        }
      } else {
        if (!entry) { state.invalidWindow = true; if (state.pending) state.pending.invalid = true; return false; }
        if (entry.kind !== kind || timestamp < entry.start) { state.invalidWindow = true; if (state.pending) state.pending.invalid = true; return false; }
        if (entry.end !== null) {
          if (entry.end !== timestamp && state.pending) state.pending.invalid = true;
          return false;
        }
        entry.end = timestamp;
      }
      return true;
    }

    const current = usage(params.tokenUsage);
    if (!current) { clearWindow(state); return false; }
    const previous = state.baseline;
    if (previous && current.fingerprint === previous.fingerprint) {
      if (current.lastFingerprint !== previous.lastFingerprint) clearWindow(state);
      return false; // A repeated notification does not consume the next window.
    }
    if (previous && (current.total.inputTokens < previous.total.inputTokens || current.total.outputTokens < previous.total.outputTokens)) {
      restart(threadId, receivedAt, turnId); return false;
    }
    const pending = state.pending;
    let valid = pending && !pending.invalid && !state.invalidWindow && (previous || state.capturedTurn)
      && receivedAt > pending.start && receivedAt - pending.start <= maxWindowMs;
    if (valid && previous && current.total.outputTokens - previous.total.outputTokens !== current.last.outputTokens) valid = false;
    const intervals = [], modelIntervals = [];
    let modelEnd = null, sawReasoning = false;
    if (valid) {
      for (const id of pending.modelIds) {
        const item = state.items.get(id);
        if (!item || item.end === null || item.end > receivedAt) { valid = false; break; }
        modelIntervals.push([item.start, item.end]);
        modelEnd = Math.max(modelEnd ?? 0, item.end);
        if (item.type === 'reasoning') sawReasoning = true;
      }
      if (current.last.reasoningOutputTokens > 0 && !sawReasoning) valid = false;
      for (const item of state.items.values()) {
        if (item.kind !== 'tool' || item.start >= receivedAt || item.end !== null && item.end <= pending.start) continue;
        if (item.end === null || item.end > receivedAt) { valid = false; break; }
        const interval = [Math.max(item.start, pending.start), Math.min(item.end, receivedAt)];
        // Concurrent model generation and tool execution cannot be separated by
        // subtraction; discard that ambiguous sample instead of inflating TPS.
        if (modelIntervals.some(model => Math.min(model[1], interval[1]) > Math.max(model[0], interval[0]))) { valid = false; break; }
        intervals.push(interval);
      }
    }
    if (valid) {
      const duration = receivedAt - pending.start - unionDuration(intervals);
      if (duration > 0 && Number.isSafeInteger(state.duration + duration)) {
        state.duration += duration; state.responses++;
        state.samples.push({ outputTokens: current.last.outputTokens, duration });
        while (state.samples.length > Math.max(1, recentResponses)) state.samples.shift();
        state.lastSampleAt = receivedAt;
      } else valid = false;
    }
    state.pending = null; state.capturedTurn = false;
    // Completed items have served their purpose. Preserve unfinished tools so
    // their overlap with the next observed model response is detected.
    for (const [id, item] of state.items) if (item.end !== null || item.kind === 'model') state.items.delete(id);
    state.baseline = current; state.lastBoundary = receivedAt;
    state.lastModelEnd = modelEnd;
    state.lastBatchIds = pending ? new Set(pending.modelIds) : new Set();
    state.invalidWindow = false;
    return Boolean(valid);
  }

  function snapshot(threadId) {
    const state = uuid(threadId) ? threads.get(threadId) : null;
    if (!state || stopped) return empty(observedSince);
    const durations = state.samples.reduce((sum, sample) => sum + sample.duration, 0);
    const tokens = state.samples.reduce((sum, sample) => sum + sample.outputTokens, 0);
    return { llmDurationMs: state.responses ? state.duration : null,
      tokensPerSecond: durations > 0 ? tokens / durations * 1000 : null,
      timingApproximate: true, observedSince: state.observedSince,
      observedResponses: state.responses, lastSampleAt: state.lastSampleAt,
      observedRounds: state.counterRoundIds.size || null, observedSteps: state.counterStepKeys.size || null,
      countersScope: 'since-monitor-start', countersLowerBound: true, countersUpdatedAt: state.countersUpdatedAt,
      countersObservedSince: state.countersObservedSince };
  }
  function reset(threadId) {
    if (stopped) return;
    const at = now();
    if (threadId === undefined) { threads.clear(); observedSince = at; }
    else if (uuid(threadId)) restart(threadId, at, null, false);
  }
  function stop() { stopped = true; threads.clear(); }
  function forget(threadId) { if (uuid(threadId)) threads.delete(threadId); }
  function status() {
    return { stopped, threads: threads.size,
      pending: [...threads.values()].filter(state => state.pending).length,
      observedResponses: [...threads.values()].reduce((sum, state) => sum + state.responses, 0) };
  }
  return { record, snapshot, reset, forget, stop, status };
}
