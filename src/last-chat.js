function lastChatRecordTime(record) {
  const payload = record?.payload;
  const visiblePhase = value => value == null || ['commentary', 'final', 'final_answer', 'partial_answer'].includes(value);
  // Raw user-role items also contain harness/AGENTS context. Accept them only
  // when Codex explicitly attributes at least one fragment to ordinary input.
  const fragments = payload?.internal_chat_message_metadata_passthrough?.content_item_metadata;
  const actualUser = Array.isArray(fragments) && fragments.some(fragment => fragment?.provenance?.type === 'user');
  const message = record?.type === 'response_item' && payload?.type === 'message'
    && (payload.role === 'user' ? actualUser : payload.role === 'assistant')
    && visiblePhase(payload.channel) && visiblePhase(payload.phase);
  const legacy = record?.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload?.type);
  const item = payload?.item;
  const completed = record?.type === 'event_msg' && payload?.type === 'item_completed'
    && ['UserMessage', 'AgentMessage'].includes(item?.type) && visiblePhase(item.phase);
  if (!message && !legacy && !completed) return null;
  if (typeof record.timestamp !== 'string') return undefined;
  const timestamp = Date.parse(record.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

function classifyLastChatRecord(prefix, oversized) {
  if (!prefix.trim()) return null;
  if (!oversized) {
    try { return lastChatRecordTime(JSON.parse(prefix)); } catch { return null; }
  }
  // Never choose an older message when a newer oversized record might be chat.
  // Known non-chat envelopes can be excluded without retaining large content.
  const boundary = /,\s*"payload"\s*:/.exec(prefix);
  if (!boundary) return undefined;
  try {
    const envelope = JSON.parse(prefix.slice(0, boundary.index) + '}');
    if (!['response_item', 'event_msg'].includes(envelope.type)) return null;
    const payloadType = prefix.slice(boundary.index + boundary[0].length).match(/^\s*\{\s*"type"\s*:\s*"([a-z_]+)"/)?.[1];
    if (!payloadType) return undefined;
    if (envelope.type === 'response_item' && payloadType !== 'message') return null;
    if (envelope.type === 'event_msg' && !['user_message', 'agent_message', 'item_completed'].includes(payloadType)) return null;
  } catch { /* An unrecognized envelope cannot establish a reliable time. */ }
  return undefined;
}

class LastChatTimeCache {
  constructor({ budgetBytes = 1024 * 1024, blockBytes = 65536, maxRecordChars = 4 * 1024 * 1024,
    totalBudgetBytes = 8 * 1024 * 1024, maxPending = 16 } = {}) {
    Object.assign(this, { budgetBytes, blockBytes, maxRecordChars, totalBudgetBytes, maxPending });
    this.cache = new Map();
    this.inFlight = new Set();
    this.beginRead();
  }
  beginRead() {
    this.remainingBytes = this.totalBudgetBytes;
    this.round = (this.round ?? 0) + 1;
    // One grace round lets a stable request list finish its scans, while rows
    // that disappear cannot reserve all pending slots indefinitely.
    for (const file of this.inFlight) {
      const state = this.cache.get(file);
      if (!state || state.lastReadRound < this.round - 1) {
        this.inFlight.delete(file); this.cache.delete(file);
      }
    }
  }
  read(file, stat) {
    const fs = require('node:fs');
    const signature = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');
    const key = signature(stat);
    let state = this.cache.get(file);
    if (state?.key === key && state.done) return state.result;
    if (state && !state.done) state.lastReadRound = this.round;
    if (this.remainingBytes <= 0) return null;
    if (!state || state.key !== key) {
      this.inFlight.delete(file);
      if (this.inFlight.size >= this.maxPending) return null;
      state = { key, offset: stat.size, prefix: '', oversized: false, done: false, result: null, lastReadRound: this.round };
      this.cache.set(file, state);
      this.inFlight.add(file);
      // Match the reader's 2000-ID bound. Never evict unfinished scans: fixed
      // refresh order must not restart them forever when many files are listed.
      if (this.cache.size > 2000) {
        for (const [cachedFile, cached] of this.cache) {
          if (cached.done) { this.cache.delete(cachedFile); break; }
        }
      }
    }
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      if (signature(fs.fstatSync(fd)) !== key) { this.cache.delete(file); return null; }
      let budget = this.budgetBytes;
      while (state.offset > 0 && budget > 0 && this.remainingBytes > 0) {
        const length = Math.min(this.blockBytes, budget, this.remainingBytes, state.offset);
        state.offset -= length; budget -= length;
        this.remainingBytes -= length;
        const buffer = Buffer.allocUnsafe(length);
        if (fs.readSync(fd, buffer, 0, length, state.offset) !== length) { this.cache.delete(file); return null; }
        const fragments = buffer.toString('utf8').split('\n');
        for (let i = fragments.length - 1; i >= 1; i--) {
          const line = fragments[i] + state.prefix;
          const result = classifyLastChatRecord(line, state.oversized || line.length > this.maxRecordChars);
          state.prefix = ''; state.oversized = false;
          if (result === undefined || result !== null) {
            state.done = true; state.result = result ?? null;
            break;
          }
        }
        if (state.done) break;
        const prefix = fragments[0] + state.prefix;
        state.oversized ||= prefix.length > this.maxRecordChars;
        state.prefix = prefix.slice(0, state.oversized ? 4096 : this.maxRecordChars);
      }
      if (!state.done && state.offset === 0) {
        state.done = true; state.result = classifyLastChatRecord(state.prefix, state.oversized) ?? null;
      }
      if (signature(fs.fstatSync(fd)) !== key) { this.cache.delete(file); return null; }
      if (state.done) state.prefix = '';
      return state.result;
    } catch {
      this.cache.delete(file);
      return null;
    } finally {
      if (state.done || this.cache.get(file) !== state) this.inFlight.delete(file);
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
