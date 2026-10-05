// Only numeric telemetry leaves this reader. Incomplete JSONL lines use bounded
// in-memory buffers; no conversation text is persisted or sent to the UI.
class ThreadMetricsReader {
  constructor({
    home = process.env.CODEX_HOME || require('node:path').join(require('node:os').homedir(), '.codex'),
    now = Date.now,
    openDatabase = (file, options) => new (require('node:sqlite').DatabaseSync)(file, options),
    maxScanBytes = 16 * 1024 * 1024,
    maxScanMs = 50,
    chunkBytes = 128 * 1024,
    tailBytes = 256 * 1024,
    maxLineBytes = 8 * 1024 * 1024,
    maxCachedThreads = 8,
    maxTrackedEvents = 200000,
  } = {}) {
    this.home = home;
    this.now = now;
    this.openDatabase = openDatabase;
    this.maxScanBytes = Math.max(1, maxScanBytes);
    this.maxScanMs = Math.max(1, maxScanMs);
    this.chunkBytes = Math.max(1, Math.min(chunkBytes, this.maxScanBytes));
    this.tailBytes = Math.max(1, tailBytes);
    this.maxLineBytes = Math.max(1024, maxLineBytes);
    this.maxCachedThreads = Math.max(1, maxCachedThreads);
    this.maxTrackedEvents = Math.max(1, maxTrackedEvents);
    this.cache = new Map();
    this.pending = new Map();
    this.scopeId = null;
    this.scopeEpoch = 0;
    this.provenance = new Map();
    this.stopped = false;
  }

  normalize(ids) {
    return [...new Set(Array.isArray(ids) ? ids : [])].filter(id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)).slice(0, this.maxCachedThreads);
  }

  empty() {
    return { rounds: null, steps: null, llmDurationMs: null, toolDurationMs: null, firstTokenAvgMs: null,
      tokensPerSecond: null, cacheHitPercent: null, inputTokens: null, outputTokens: null, complete: false };
  }

  // Uses the newest schema only, following ThreadTokenReader's account isolation.
  openState() {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = fs.readdirSync(this.home).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
    if (!file) throw new Error('No state database');
    const dbFile = path.join(this.home, file), stat = fs.statSync(dbFile);
    const scopeId = require('node:crypto').createHash('sha256').update(`${fs.realpathSync(this.home)}\0${fs.realpathSync(dbFile)}\0${stat.dev}:${stat.ino}`).digest('hex');
    if (this.scopeId !== scopeId) { this.cache.clear(); this.provenance.clear(); this.scopeId = scopeId; this.scopeEpoch++; }
    return this.openDatabase(dbFile, { readOnly: true, timeout: 200 });
  }

  paths(ids) {
    let db;
    try {
      db = this.openState();
      const scopeId = this.scopeId;
      const columns = db.prepare('PRAGMA table_info(threads)').all();
      const owner = columns.some(column => column.name === 'creator_account_id');
      const archive = columns.some(column => column.name === 'archived');
      const rows = db.prepare(`SELECT id, rollout_path${owner ? ', creator_account_id' : ''}${archive ? ', archived' : ''} FROM threads WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      return rows.map(row => ({ id: row.id, rollout_path: row.rollout_path, archived: archive && row.archived === 1, scopeId: owner && typeof row.creator_account_id === 'string'
        ? require('node:crypto').createHash('sha256').update(`${scopeId}\0${row.creator_account_id}`).digest('hex') : scopeId }));
    } finally { try { db?.close(); } catch {} }
  }

  archivedIds(ids) {
    const requested = [...new Set(Array.isArray(ids) ? ids : [])].filter(id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id));
    if (this.stopped) return { ok: false, scopeId: this.scopeId, ids: [] };
    let db;
    try {
      db = this.openState();
      const columns = db.prepare('PRAGMA table_info(threads)').all();
      if (!columns.some(column => column.name === 'id') || !columns.some(column => column.name === 'archived')) throw new Error('Unknown archive schema');
      const archived = [];
      for (let offset = 0; offset < requested.length; offset += 200) {
        const chunk = requested.slice(offset, offset + 200);
        const rows = db.prepare(`SELECT id FROM threads WHERE archived=1 AND id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
        archived.push(...rows.map(row => row.id));
      }
      return { ok: true, scopeId: this.scopeId, ids: archived };
    } catch { return { ok: false, scopeId: this.scopeId, ids: [] }; }
    finally { try { db?.close(); } catch {} }
  }

  indexedRounds(ids) {
    const fs = require('node:fs'), path = require('node:path');
    let db;
    try {
      const file = fs.readdirSync(this.home).filter(name => /^thread_history_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
      if (!file) return new Map();
      db = this.openDatabase(path.join(this.home, file), { readOnly: true, timeout: 200 });
      // Read only lifecycle identifiers/counts and projection watermarks; never
      // item_json, error_json, messages or other conversation bodies.
      const rows = db.prepare(`SELECT p.thread_id AS id, p.next_rollout_byte_offset AS offset, COUNT(DISTINCT t.turn_id) AS rounds
        FROM thread_history_projection_state p LEFT JOIN thread_turns t ON t.thread_id = p.thread_id
        WHERE p.thread_id IN (${ids.map(() => '?').join(',')}) GROUP BY p.thread_id, p.next_rollout_byte_offset`).all(...ids);
      return new Map(rows.filter(row => Number.isSafeInteger(row.offset) && row.offset >= 0 && Number.isSafeInteger(row.rounds) && row.rounds >= 0).map(row => [row.id, row]));
    } catch { return new Map(); }
    finally { try { db?.close(); } catch {} }
  }

  async read(ids) {
    const checkedAt = this.now();
    const perThread = Object.create(null);
    const requested = this.normalize(ids);
    if (this.stopped) return { ok: false, perThread, checkedAt };
    if (!requested.length) return { ok: true, perThread, checkedAt };
    let rows;
    try { rows = this.paths(requested); } catch {
      // Declare a known new storage scope even when its schema is unsupported;
      // the renderer must not attach an old database's cached values to it.
      return { ok: false, perThread, checkedAt, scopeId: this.scopeId, backfilling: false };
    }
    const scopeEpoch = this.scopeEpoch, storageScopeId = this.scopeId;
    const rounds = this.indexedRounds(requested);
    let backfilling = false;
    const archivedIds = [];
    // Sequential scans bound the total CPU and I/O budget for a refresh. Usually
    // only the current conversation is requested by each desktop window.
    for (const row of rows) {
      if (!requested.includes(row.id) || this.stopped) continue;
      if (row.archived) {
        archivedIds.push(row.id); this.cache.delete(row.id); this.provenance.delete(row.id);
        perThread[row.id] = { archived: true, localVerified: true, scopeId: row.scopeId };
        continue;
      }
      const pendingKey = `${storageScopeId}:${row.scopeId}:${row.id}:${row.rollout_path}`;
      let pending = this.pending.get(pendingKey);
      if (!pending) {
        pending = this.readThread(row.id, row.rollout_path, rounds.get(row.id), scopeEpoch, storageScopeId).catch(() => this.empty());
        this.pending.set(pendingKey, pending);
      }
      try {
        const result = await pending;
        if (scopeEpoch !== this.scopeEpoch) return { ok: false, perThread: Object.create(null), checkedAt, scopeId: this.scopeId, backfilling: false };
        perThread[row.id] = { ...result, localVerified: true, scopeId: row.scopeId };
        if (perThread[row.id].backfilling) backfilling = true;
      } finally {
        if (this.pending.get(pendingKey) === pending) this.pending.delete(pendingKey);
      }
    }
    // Archive can change while an asynchronous rollout scan is awaiting I/O.
    // Recheck the authoritative status before returning any collected values.
    const archiveStatus = this.archivedIds(requested);
    if (scopeEpoch !== this.scopeEpoch) return { ok: false, perThread: Object.create(null), checkedAt, scopeId: this.scopeId, backfilling: false, archivedIds: [] };
    if (archiveStatus.ok) for (const id of archiveStatus.ids) {
      if (!archivedIds.includes(id)) archivedIds.push(id);
      this.cache.delete(id); this.provenance.delete(id);
      if (perThread[id]) perThread[id] = { archived: true, localVerified: true, scopeId: perThread[id].scopeId };
    }
    backfilling = Object.values(perThread).some(metric => metric.backfilling === true);
    while (this.cache.size > this.maxCachedThreads) this.cache.delete(this.cache.keys().next().value);
    return { ok: !this.stopped, perThread, checkedAt, scopeId: this.scopeId, backfilling, archivedIds };
  }

  async safePath(file) {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.jsonl')) throw new Error('Invalid rollout path');
    const real = await fs.realpath(file);
    // A corrupt database cannot redirect the reader into auth or arbitrary files.
    for (const directory of ['sessions', 'archived_sessions']) {
      try {
        const root = await fs.realpath(path.join(this.home, directory));
        const relative = path.relative(root, real);
        if (relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) return real;
      } catch {}
    }
    throw new Error('Rollout outside session directories');
  }

  state(file, identity) {
    return {
      file, identity, offset: 0, mtimeMs: null, carry: [], carryBytes: 0, head: Buffer.alloc(0), skipping: false,
      ownSession: false, recognized: false, damagedCounters: false, damagedTools: false,
      roundIds: new Set(), responseIds: new Set(), legacySnapshots: new Set(), steps: 0,
      modern: false, totals: null, modernTotals: null, tailResult: null, tailSize: -1,
      firstTokens: new Map(), calls: new Map(), completedCalls: new Set(), intervals: [],
      toolEvents: false, lastGoodCounters: null, indexInvalidated: false,
    };
  }

  numeric(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  tokenTotals(value) {
    if (!value || typeof value !== 'object') return null;
    const inputTokens = this.numeric(value.input_tokens);
    const outputTokens = this.numeric(value.output_tokens);
    const cached = this.numeric(value.cached_input_tokens);
    if (inputTokens === null && outputTokens === null) return null;
    return { inputTokens, outputTokens,
      cacheHitPercent: inputTokens > 0 && cached !== null && cached <= inputTokens ? cached / inputTokens * 100 : null };
  }
  usageKey(value) {
    if (!value || typeof value !== 'object') return null;
    const input = this.numeric(value.input_tokens), output = this.numeric(value.output_tokens);
    return input !== null && output !== null ? `${input}:${output}:${this.numeric(value.cached_input_tokens)}` : null;
  }
  timestamp(value) {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }

  relevant(line) {
    // Gate JSON parsing before touching large prompt, output or world-state lines.
    const prefix = line.slice(0, 1024);
    return /"type"\s*:\s*"(?:session_meta|token_usage_record)"/.test(prefix)
      || /"type"\s*:\s*"event_msg"/.test(prefix) && /"type"\s*:\s*"(?:task_started|task_complete|token_count)"/.test(prefix)
      || /"type"\s*:\s*"response_item"/.test(prefix) && /"type"\s*:\s*"(?:function_call|custom_tool_call|function_call_output|custom_tool_call_output)"/.test(prefix);
  }

  parseLine(state, line, id) {
    const text = line.toString('utf8');
    if (!this.relevant(text)) return;
    let record;
    try { record = JSON.parse(text); } catch { state.damagedCounters = state.damagedTools = true; return; }
    const payload = record?.payload;
    if (!payload || typeof payload !== 'object') return;
    if (record.type === 'session_meta') {
      state.ownSession = payload.id === id;
      if (state.ownSession) state.recognized = true;
      return;
    }
    // Modern records carry explicit ownership even when a fork later appends
    // inherited session metadata. Untagged legacy records still need metadata.
    const ownUsage = record.type === 'token_usage_record' && payload.thread_id === id;
    if (!ownUsage && (!state.ownSession || payload.thread_id && payload.thread_id !== id)) return;
    if (state.roundIds.size + state.responseIds.size + state.legacySnapshots.size + state.firstTokens.size
      + state.calls.size + state.completedCalls.size >= this.maxTrackedEvents) {
      // Exact event deduplication is necessary for totals. A pathological log
      // must not exhaust the agent's memory; keep only cumulative token totals.
      state.damagedCounters = state.damagedTools = true;
      if (record.type === 'token_usage_record' && payload.thread_id === id) state.modernTotals = this.tokenTotals(payload.thread_token_usage);
      return;
    }
    if (record.type === 'token_usage_record') {
      if (payload.thread_id !== id || typeof payload.response_id !== 'string' || !payload.response_id) return;
      state.recognized = true;
      if (typeof payload.turn_id === 'string' && payload.turn_id) state.roundIds.add(payload.turn_id);
      const key = this.usageKey(payload.thread_token_usage);
      if (!state.responseIds.has(payload.response_id)) {
        // The first modern record can mirror the last legacy cumulative event.
        if (state.modern || !key || !state.legacySnapshots.has(key)) state.steps++;
        state.responseIds.add(payload.response_id);
      }
      state.modern = true;
      state.modernTotals = this.tokenTotals(payload.thread_token_usage);
      return;
    }
    if (record.type === 'event_msg') {
      if (payload.type === 'task_started' || payload.type === 'task_complete') {
        state.recognized = true;
        if (typeof payload.turn_id === 'string' && payload.turn_id) state.roundIds.add(payload.turn_id);
        else state.damagedCounters = true;
        if (payload.type === 'task_complete') {
          const value = this.numeric(payload.time_to_first_token_ms);
          if (value !== null && typeof payload.turn_id === 'string') state.firstTokens.set(payload.turn_id, value);
        }
      } else if (payload.type === 'token_count' && payload.info) {
        state.recognized = true;
        // Once response IDs exist they are authoritative; their mirrored legacy
        // totals can diverge from the new cumulative totals after compaction.
        if (!state.modern) {
          const total = payload.info.total_token_usage;
          const key = this.usageKey(total);
          if (key && !state.legacySnapshots.has(key) && (this.numeric(total.input_tokens) || 0) + (this.numeric(total.output_tokens) || 0) > 0) {
            state.legacySnapshots.add(key);
            state.steps++;
          }
          state.totals = this.tokenTotals(total);
        }
      }
      return;
    }
    if (record.type !== 'response_item') return;
    const call = payload.type === 'function_call' || payload.type === 'custom_tool_call';
    const output = payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output';
    if (!call && !output) return;
    const callId = payload.call_id;
    const timestamp = this.timestamp(record.timestamp);
    state.recognized = state.toolEvents = true;
    if (typeof callId !== 'string' || !callId || timestamp === null) { state.damagedTools = true; return; }
    if (state.completedCalls.has(callId)) return;
    if (call) {
      if (!state.calls.has(callId)) state.calls.set(callId, timestamp);
    } else {
      const startedAt = state.calls.get(callId);
      if (startedAt === undefined || timestamp < startedAt) { state.damagedTools = true; return; }
      state.calls.delete(callId);
      state.completedCalls.add(callId);
      this.mergeInterval(state.intervals, startedAt, timestamp);
    }
  }

  mergeInterval(intervals, start, end) {
    // Completion order need not match invocation order for parallel tools.
    let low = 0, high = intervals.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (intervals[mid][1] < start) low = mid + 1; else high = mid;
    }
    const from = low;
    while (low < intervals.length && intervals[low][0] <= end) {
      start = Math.min(start, intervals[low][0]); end = Math.max(end, intervals[low][1]); low++;
    }
    intervals.splice(from, low - from, [start, end]);
  }

  consume(state, chunk, id) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (!state.skipping) {
        if (state.carryBytes + part.length > this.maxLineBytes) {
          const prefix = (state.head.length ? state.head : part).subarray(0, 1024).toString('utf8');
          if (this.relevant(prefix)) {
            if (/"type"\s*:\s*"response_item"/.test(prefix)) state.damagedTools = true;
            else state.damagedCounters = true;
          }
          state.carry = []; state.carryBytes = 0; state.head = Buffer.alloc(0); state.skipping = true;
        } else {
          // Keep segments instead of repeatedly copying a growing multi-MiB line.
          if (part.length) state.carry.push(Buffer.from(part));
          state.carryBytes += part.length;
          if (state.head.length < 1024) state.head = Buffer.concat([state.head, part.subarray(0, 1024 - state.head.length)]);
        }
      }
      if (newline < 0) return;
      if (!state.skipping && state.carryBytes) this.parseLine(state, Buffer.concat(state.carry, state.carryBytes), id);
      state.carry = []; state.carryBytes = 0; state.head = Buffer.alloc(0); state.skipping = false;
      start = newline + 1;
    }
  }

  async tail(handle, size, id) {
    const start = Math.max(0, size - this.tailBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    lines.pop(); // A writer may not have finished the last JSONL record yet.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!/"type"\s*:\s*"token_usage_record"/.test(lines[i].slice(0, 1024))) continue;
      try {
        const record = JSON.parse(lines[i]);
        if (record.type === 'token_usage_record' && record.payload?.thread_id === id) {
          // An invalid newest record cannot silently relabel an older total.
          return { found: true, totals: this.tokenTotals(record.payload.thread_token_usage) };
        }
      } catch {}
    }
    return { found: false, totals: null };
  }

  async readThread(id, originalFile, indexed, scopeEpoch = this.scopeEpoch, storageScopeId = this.scopeId) {
    const fs = require('node:fs/promises');
    const file = await this.safePath(originalFile);
    if (scopeEpoch !== this.scopeEpoch) throw new Error('Storage scope changed');
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      if (scopeEpoch !== this.scopeEpoch) throw new Error('Storage scope changed');
      if (!stat.isFile() || !Number.isSafeInteger(stat.size)) return this.empty();
      const identity = `${stat.dev}:${stat.ino}`;
      const previous = this.provenance.get(id);
      const replaced = previous && (previous.file !== file || previous.identity !== identity || stat.size < previous.size
        || stat.size === previous.size && stat.mtimeMs !== previous.mtimeMs);
      const generation = previous ? previous.generation + (replaced ? 1 : 0) : 0;
      const revision = require('node:crypto').createHash('sha256').update(`${storageScopeId}\0${file}\0${identity}\0${generation}`).digest('hex');
      this.provenance.delete(id); this.provenance.set(id, { file, identity, size: stat.size, mtimeMs: stat.mtimeMs, generation });
      while (this.provenance.size > this.maxCachedThreads) this.provenance.delete(this.provenance.keys().next().value);
      let state = this.cache.get(id);
      if (!state || state.file !== file || state.identity !== identity || stat.size < state.offset
        || stat.size === state.offset && state.mtimeMs !== null && stat.mtimeMs !== state.mtimeMs) state = this.state(file, identity);
      if (replaced) state.indexInvalidated = true;
      this.cache.delete(id); this.cache.set(id, state);
      if (state.tailSize !== stat.size || state.mtimeMs !== stat.mtimeMs) {
        state.tailResult = await this.tail(handle, stat.size, id);
        if (scopeEpoch !== this.scopeEpoch) throw new Error('Storage scope changed');
        state.tailSize = stat.size;
      }
      const began = Date.now();
      let scanned = 0;
      while (!this.stopped && state.offset < stat.size && scanned < this.maxScanBytes && Date.now() - began < this.maxScanMs) {
        const buffer = Buffer.alloc(Math.min(this.chunkBytes, stat.size - state.offset, this.maxScanBytes - scanned));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
        if (scopeEpoch !== this.scopeEpoch) throw new Error('Storage scope changed');
        if (!bytesRead) break;
        this.consume(state, buffer.subarray(0, bytesRead), id);
        state.offset += bytesRead; scanned += bytesRead;
      }
      state.mtimeMs = stat.mtimeMs;
      if (state.roundIds.size + state.responseIds.size + state.legacySnapshots.size + state.firstTokens.size
        + state.calls.size + state.completedCalls.size > this.maxTrackedEvents) state.damagedCounters = state.damagedTools = true;
      const complete = state.offset === stat.size && !state.carryBytes && !state.skipping;
      // Prefix totals describe historical usage, not current cumulative usage.
      // Only a matching tail record may supply tokens while backfill is pending.
      const totals = state.tailResult?.found ? state.tailResult.totals : complete ? state.modern ? state.modernTotals : state.totals : null;
      const result = { ...this.empty(), ...(totals || {}), complete };
      if (complete && state.recognized && !state.damagedCounters) {
        result.rounds = state.roundIds.size;
        result.steps = state.steps;
        if (state.firstTokens.size) result.firstTokenAvgMs = [...state.firstTokens.values()].reduce((sum, value) => sum + value, 0) / state.firstTokens.size;
      }
      if (complete && state.recognized && !state.damagedTools && !state.calls.size) {
        result.toolDurationMs = state.intervals.reduce((sum, [start, end]) => sum + end - start, 0);
      }
      let counterScope = complete && !state.damagedCounters ? 'full-history' : 'history-lower-bound';
      if (result.rounds !== null && result.steps !== null) state.lastGoodCounters = { rounds: result.rounds, steps: result.steps };
      else if (state.lastGoodCounters) {
        result.rounds = state.lastGoodCounters.rounds; result.steps = state.lastGoodCounters.steps;
        counterScope = 'last-complete-snapshot';
      }
      if (!complete && !state.damagedCounters && state.recognized) {
        if (state.roundIds.size) result.rounds = Math.max(result.rounds ?? 0, state.roundIds.size);
        if (state.steps) result.steps = Math.max(result.steps ?? 0, state.steps);
      }
      // A replaced/truncated rollout invalidates the old projection watermark,
      // even when a new file happens to have the same byte length.
      const usableIndex = !state.indexInvalidated && indexed && indexed.offset <= stat.size;
      const indexedComplete = Boolean(usableIndex && indexed.offset === stat.size);
      if (usableIndex) result.rounds = indexedComplete ? indexed.rounds : Math.max(result.rounds ?? 0, indexed.rounds);
      Object.assign(result, {
        backfilling: state.offset < stat.size,
        counterScope, countersLowerBound: !complete || state.damagedCounters,
        roundsComplete: indexedComplete || complete && !state.damagedCounters && result.rounds !== null,
        stepsComplete: complete && !state.damagedCounters && result.steps !== null,
        revision, rolloutSize: stat.size, rolloutMtimeMs: stat.mtimeMs,
        countersReset: Boolean(replaced),
      });
      // task_complete.duration_ms includes tools, approvals and other waiting;
      // item durations omit model prefill. Neither is a valid model-request or
      // generation duration, so LLM time and token speed deliberately stay null.
      return result;
    } finally { try { await handle?.close(); } catch {} }
  }

  stop() { this.stopped = true; this.cache.clear(); }
}

function createThreadMetricsReader(options) { return new ThreadMetricsReader(options); }
