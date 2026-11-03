class ContextWindowReader {
  constructor({ home = process.env.CODEX_HOME || require('node:path').join(require('node:os').homedir(), '.codex'),
    maxReadBytes = 4 * 1024 * 1024, maxLineBytes = 256 * 1024 } = {}) {
    this.home = home;
    this.maxReadBytes = maxReadBytes;
    this.maxLineBytes = maxLineBytes;
    this.files = new Map();
  }
  // Reads bytes containing conversation content, but retains only statistics and
  // request identity metadata. Never return paths, raw lines or parse errors.
  readContextSnapshot(binding) {
    if (binding?.host !== 'local') return { reason: '远程会话暂无本地上下文统计' };
    if (typeof binding.threadId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.threadId)) {
      return { reason: '尚未确认会话身份' };
    }
    const fs = require('node:fs'), path = require('node:path');
    let db, fd;
    try {
      const file = fs.readdirSync(this.home).filter(name => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
      if (!file) return { reason: '本地统计数据库不可用' };
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(path.join(this.home, file), { readOnly: true, timeout: 200 });
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(binding.threadId);
      db.close(); db = null;
      if (!row?.rollout_path) return { reason: '会话日志不可用' };
      const cacheKey = path.join(this.home, file) + '\0' + row.rollout_path;
      fd = fs.openSync(row.rollout_path, 'r');
      const stat = fs.fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let state = this.files.get(cacheKey);
      let reset = !state || state.identity !== identity || stat.size < state.offset;
      if (!reset && state.guard.length) {
        const guard = Buffer.alloc(state.guard.length);
        fs.readSync(fd, guard, 0, guard.length, state.offset - guard.length);
        reset = !guard.equals(state.guard) || (stat.size === state.offset && stat.mtimeMs !== state.mtimeMs);
      }
      if (reset) {
        const previous = state;
        const offset = Math.max(0, stat.size - this.maxReadBytes);
        state = { identity, offset, pending: Buffer.alloc(0), dropping: offset > 0 ? 'initial' : false,
          guard: Buffer.alloc(0), contexts: new Map(), responses: previous?.responses || new Set(), signatures: previous?.signatures || new Set(),
          resetAfter: previous ? Date.now() : null,
          ordinal: -1, candidate: null, snapshot: null };
        this.files.set(cacheKey, state);
      }
      // A burst larger than the bound invalidates provenance; resume from a bounded tail.
      if (stat.size - state.offset > this.maxReadBytes) {
        state.offset = Math.max(0, stat.size - this.maxReadBytes);
        state.guard = Buffer.alloc(0); state.pending = Buffer.alloc(0); state.dropping = 'initial';
        state.contexts.clear(); state.candidate = null; state.snapshot = null; state.resetAfter = Date.now();
        return { reason: '日志增长超出安全读取范围，等待下一次统计' };
      }
      const buffer = Buffer.alloc(stat.size - state.offset);
      let read = 0;
      while (read < buffer.length) {
        const n = fs.readSync(fd, buffer, read, buffer.length - read, state.offset + read);
        if (!n) throw new Error('short read');
        read += n;
      }
      this.consume(state, buffer, binding.threadId);
      state.offset += read;
      state.mtimeMs = stat.mtimeMs;
      state.guard = Buffer.alloc(Math.min(128, state.offset));
      fs.readSync(fd, state.guard, 0, state.guard.length, state.offset - state.guard.length);
      // Bound memory across many historical threads, while sharing the same file
      // cursor among all windows/composers that request it.
      this.files.delete(cacheKey); this.files.set(cacheKey, state);
      while (this.files.size > 128) this.files.delete(this.files.keys().next().value);
      const snapshot = state.snapshot;
      if (!snapshot || snapshot.model !== binding.model ||
          (binding.requireFresh && !(snapshot.startedAt >= binding.changedAt))) {
        return { reason: '等待当前模型请求的统计' };
      }
      return { last_token_usage: snapshot.last_token_usage, model_context_window: snapshot.model_context_window };
    } catch {
      // A failed read must never leave a previously valid sample available.
      this.files.clear();
      return { reason: '本地统计读取失败，稍后自动重试' };
    } finally {
      try { if (fd !== undefined) fs.closeSync(fd); } catch {}
      try { db?.close(); } catch {}
    }
  }
  consume(state, bytes, threadId) {
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      const part = bytes.subarray(start, end); start = end + 1;
      if (state.dropping) {
        state.pending = Buffer.alloc(0); state.dropping = false;
        continue;
      }
      if (state.pending.length + part.length > this.maxLineBytes) {
        this.skipLongRecord(state, state.pending.length ? state.pending : part);
        state.pending = Buffer.alloc(0); state.dropping = false;
        continue;
      }
      const line = state.pending.length ? Buffer.concat([state.pending, part]) : part;
      state.pending = Buffer.alloc(0);
      if (!line.length) continue;
      let record;
      try { record = JSON.parse(line.toString('utf8')); }
      catch { state.snapshot = null; state.candidate = null; state.contexts.clear(); continue; }
      this.acceptRecord(state, record, threadId);
    }
    const rest = bytes.subarray(start);
    if (state.pending.length + rest.length > this.maxLineBytes) {
      if (!state.dropping) this.skipLongRecord(state, state.pending.length ? state.pending : rest);
      state.pending = Buffer.alloc(0); state.dropping = 'oversize';
    } else if (!state.dropping) state.pending = Buffer.concat([state.pending, rest]);
  }
  skipLongRecord(state, prefix) {
    // Known opaque body records can exceed the line bound (e.g. tool output).
    // Inspect only the writer's small envelope, never parse or keep that body.
    const envelope = /^\{"timestamp":"[^"\\]*","ordinal":(\d+),"type":"(response_item|world_state)","payload":/.exec(prefix.subarray(0, 256).toString('utf8'));
    if (envelope && Number.isSafeInteger(Number(envelope[1])) && Number(envelope[1]) > state.ordinal) {
      state.ordinal = Number(envelope[1]); return;
    }
    state.snapshot = null; state.candidate = null; state.contexts.clear();
  }
  acceptRecord(state, record, threadId) {
    // Ordinals provide an explicit source ordering; timestamps alone are not provenance.
    if (!Number.isSafeInteger(record.ordinal) || record.ordinal <= state.ordinal) {
      state.snapshot = null; state.candidate = null; state.contexts.clear(); return;
    }
    state.ordinal = record.ordinal;
    const p = record.payload;
    if (!p || typeof p !== 'object') return;
    if (record.type === 'turn_context') {
      state.candidate = null;
      if (typeof p.turn_id !== 'string' || typeof p.model !== 'string' || state.contexts.has(p.turn_id)) {
        state.contexts.clear(); state.snapshot = null; return;
      }
      state.contexts.set(p.turn_id, { model: p.model, startedAt: Date.parse(record.timestamp), rootTurnId: p.root_turn_id });
      while (state.contexts.size > 128) state.contexts.delete(state.contexts.keys().next().value);
    } else if (record.type === 'token_usage_record') {
      const context = state.contexts.get(p.turn_id);
      const signature = this.usageSignature(p.usage, p.thread_token_usage);
      // Explicit thread/turn/response identities bind the usage to its request.
      // Duplicate responses or identical usage fingerprints are ambiguous replays.
      const valid = context && (!state.resetAfter || context.startedAt >= state.resetAfter) &&
        p.root_turn_id === context.rootTurnId && p.thread_id === threadId && typeof p.response_id === 'string' && p.response_id &&
        !state.responses.has(p.response_id) && signature && !state.signatures.has(signature);
      state.ambiguous = state.ambiguous || !!state.candidate;
      state.candidate = valid && !state.ambiguous ? { ...context, signature } : null;
      if (!valid || state.ambiguous) state.snapshot = null;
      if (p.response_id) state.responses.add(p.response_id);
      if (signature) state.signatures.add(signature);
      if (state.responses.size > 4096 || state.signatures.size > 4096) {
        state.responses.clear(); state.signatures.clear(); state.contexts.clear();
        state.candidate = null; state.snapshot = null;
      }
    } else if (record.type === 'event_msg' && p.type === 'token_count') {
      const signature = this.usageSignature(p.info?.last_token_usage, p.info?.total_token_usage);
      const candidate = state.candidate;
      state.candidate = null; state.ambiguous = false;
      state.snapshot = candidate && signature && candidate.signature === signature && formatContextSnapshot(p.info).available
        ? { model: candidate.model, startedAt: candidate.startedAt,
          last_token_usage: { total_tokens: p.info.last_token_usage.total_tokens },
          model_context_window: p.info.model_context_window } : null;
    }
  }
  usageSignature(last, total) {
    const keys = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
      'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
    const values = [last, total].flatMap(usage => keys.map(key => usage?.[key]));
    return values.every(value => Number.isSafeInteger(value) && value >= 0) ? values.join(':') : null;
  }
}
async function refreshContextWindows(injector, reader) {
  await Promise.all([...injector.sessions.values()].map(async session => {
    try {
      const response = await session.evaluate('window.__codexContextWindow?.bindings() ?? []');
      const bindings = response?.result?.value;
      if (!Array.isArray(bindings)) return;
      const updates = bindings.slice(0, 32).map(binding => ({ ...binding,
        value: formatContextSnapshot(reader.readContextSnapshot(binding)) }));
      await session.evaluate(`window.__codexContextWindow?.update(${JSON.stringify(updates)})`);
    } catch { /* A disconnected window cannot receive or broadcast another window's data. */ }
  }));
}
