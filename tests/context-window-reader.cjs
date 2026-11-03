const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {ContextWindowReader, formatContextSnapshot} = require('../agent.cjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-context-'));
const threadId = '00000000-0000-0000-0000-000000000001';
const file = path.join(home, 'synthetic.jsonl');
const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
db.prepare('INSERT INTO threads VALUES (?, ?)').run(threadId, file);
let ordinal = 0, response = 0;
const timestamp = '2020-11-01T06:00:00.000Z';
const line = (type, payload, time = timestamp) => JSON.stringify({timestamp: time, ordinal: ++ordinal, type, payload}) + '\n';
const context = (turn, model = 'A', time) => line('turn_context', {turn_id: turn, root_turn_id: turn, model}, time);
const usage = (used, total = used) => ({input_tokens: used, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total});
const info = (used, total = used, capacity = 100) => ({last_token_usage: usage(used), total_token_usage: usage(total), model_context_window: capacity});
const provenance = (turn, used, total = used, extra = {}) => line('token_usage_record', {
  thread_id: threadId, turn_id: turn, root_turn_id: turn, response_id: `response-${++response}`,
  usage: usage(used), thread_token_usage: usage(total), ...extra
});
const count = (used, total = used, capacity = 100) => line('event_msg', {type: 'token_count', info: info(used, total, capacity)});
const pair = (turn, used, total = used, capacity = 100) => provenance(turn, used, total) + count(used, total, capacity);
const binding = {host: 'local', threadId, model: 'A', bindingVersion: 1, requireFresh: false};
const reader = new ContextWindowReader({home});
const read = (patch = {}) => formatContextSnapshot(reader.readContextSnapshot({...binding, ...patch}));
const append = text => fs.appendFileSync(file, text);
try {
  fs.writeFileSync(file, context('a1') + pair('a1', 40));
  assert.equal(read().percent, 40);
  assert.equal(read().percent, 40, 'idle and shared readers retain the last complete snapshot');
  append(pair('a1', 10, 50)); assert.equal(read().percent, 10, 'compaction can decrease usage');
  append(provenance('a1', 0, 60) + count(0, 60)); assert.equal(read().percent, 0);
  assert.equal(read({host: 'remote'}).available, false);
  assert.equal(read({threadId: "' OR 1=1 --"}).available, false);
  append(context('b1', 'B') + pair('b1', 50, 110));
  assert.equal(read().available, false);
  assert.equal(read({model: 'B', requireFresh: true, changedAt: Date.parse(timestamp) + 1}).available, false);
  assert.equal(read({model: 'B', requireFresh: true, changedAt: Date.parse(timestamp)}).percent, 50);
  append(pair('a1', 20, 130));
  assert.equal(read({model: 'A', requireFresh: true, changedAt: Date.parse(timestamp) + 1}).available, false, 'late same-model A after A/B/A is rejected');
  append(context('a2', 'A', '2020-11-01T06:00:01Z') + pair('a2', 30, 160));
  assert.equal(read({requireFresh: true, changedAt: Date.parse(timestamp) + 1}).percent, 30);
  append(provenance('b1', 31, 191) + count(32, 192)); assert.equal(read().available, false, 'unmatched untagged count is unknown');
  append(pair('a2', 33, 225)); assert.equal(read().percent, 33);
  append(count(34, 259)); assert.equal(read().available, false, 'file append without provenance is insufficient');
  append(pair('a2', 35, 294, 0)); assert.equal(read().available, false, 'latest invalid capacity cannot reuse an older valid value');
  append(pair('a2', 36, 330)); assert.equal(read().percent, 36);
  // Interleaved usage sources must not be assigned by the last writer alone.
  append(provenance('a2', 37, 367) + provenance('b1', 38, 405) + count(38, 405));
  assert.equal(read({model: 'B'}).available, false, 'overlapping request statistics remain unknown');
  append(pair('a2', 39, 444)); assert.equal(read().percent, 39, 'next unambiguous source recovers');
  const partial = provenance('a2', 40, 484) + count(40, 484);
  append(partial.slice(0, -8)); assert.equal(read().percent, 39, 'unfinished JSON keeps the previous complete snapshot');
  append(partial.slice(-8)); assert.equal(read().percent, 40);
  const utf8 = Buffer.from(line('response_item', {type: 'message', content: '合成正文，不保存用户日志'}));
  const split = utf8.indexOf(Buffer.from('合')) + 1;
  append(utf8.subarray(0, split)); assert.equal(read().percent, 40);
  append(utf8.subarray(split)); assert.equal(read().percent, 40, 'split UTF-8 codepoint is not decoded before the whole line');
  const originalRead = fs.readSync; let bytesRead = 0;
  fs.readSync = (...args) => { const size = originalRead(...args); bytesRead += size; return size; };
  try { read(); read(); } finally { fs.readSync = originalRead; }
  assert.ok(bytesRead <= 512, 'two idle windows share the file cursor; only small identity guards are reread');
  append(line('response_item', {type: 'message', content: 'x'.repeat(300000)}));
  assert.equal(read().percent, 40, 'oversized opaque body does not erase known request identity');
  append(pair('a2', 41, 525)); assert.equal(read().percent, 41);
  append(line('event_msg', {type: 'token_count', info: info(-1, 526)}));
  assert.equal(read().available, false, 'negative latest count does not silently reuse the last good sample');
  append(pair('a2', 42, 568)); assert.equal(read().percent, 42);
  const replay = provenance('a2', 43, 611);
  append(replay + count(43, 611)); assert.equal(read().percent, 43);
  append(replay + count(43, 611)); assert.equal(read().available, false, 'replayed ordinal and response are rejected');
  append(context('a3') + pair('a3', 44, 655)); assert.equal(read().percent, 44);
  append(provenance('a3', 45, 700, {thread_id: 'another-thread'}) + count(45, 700));
  assert.equal(read().available, false, 'explicit source thread must match the requested local thread');
  append(pair('a3', 46, 746)); assert.equal(read().percent, 46);
  fs.writeFileSync(file, context('replayed-old-turn') + pair('replayed-old-turn', 47, 793));
  assert.equal(read().available, false, 'truncation must not replay historical source generations');
  const future = new Date(Date.now() + 1000).toISOString();
  append(context('after-truncate', 'A', future) + pair('after-truncate', 48, 841)); assert.equal(read().percent, 48);
  const oldFile = path.join(home, 'old-synthetic.jsonl');
  fs.renameSync(file, oldFile);
  fs.writeFileSync(file, context('replacement-old') + pair('replacement-old', 49, 890));
  assert.equal(read().available, false, 'replacement file cannot inherit an old valid sample');
  append(context('after-replace', 'A', future) + pair('after-replace', 50, 940)); assert.equal(read().percent, 50);
  fs.unlinkSync(file); assert.equal(read().available, false, 'missing log degrades immediately');
  fs.writeFileSync(file, context('recovered') + pair('recovered', 51, 991)); assert.equal(read().percent, 51);
  const newer = new DatabaseSync(path.join(home, 'state_6.sqlite'));
  try {
    newer.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)');
    assert.equal(read().available, false, 'newest broken database never falls back to a prior account snapshot');
    newer.exec('ALTER TABLE threads ADD COLUMN rollout_path TEXT');
    newer.prepare('INSERT INTO threads VALUES (?, ?)').run(threadId, file);
    assert.equal(read().percent, 51, 'schema recovery is automatic');
  } finally { newer.close(); }
  const bounded = new ContextWindowReader({home, maxReadBytes: 4096});
  fs.writeFileSync(file, context('outside-tail') + line('response_item', {content: 'x'.repeat(16000)}) + pair('outside-tail', 52, 1043));
  let boundedBytes = 0; fs.readSync = (...args) => { const size = originalRead(...args); boundedBytes += size; return size; };
  try {
    assert.equal(formatContextSnapshot(bounded.readContextSnapshot(binding)).available, false, 'missing context beyond bounded tail is unknown');
    assert.ok(boundedBytes <= 4224, 'first scan is bounded');
    const before = boundedBytes;
    bounded.readContextSnapshot(binding);
    assert.ok(boundedBytes - before <= 256, 'unknown data does not cause a whole-file rescan');
  } finally { fs.readSync = originalRead; }
  append(context('inside-tail') + pair('inside-tail', 53, 1096));
  assert.equal(formatContextSnapshot(bounded.readContextSnapshot(binding)).percent, 53);
  append(line('event_msg', {type: 'token_count', info: 'x'.repeat(300000)}));
  assert.equal(formatContextSnapshot(bounded.readContextSnapshot(binding)).available, false, 'oversized relevant records invalidate provenance safely');
  console.log('PASS context reader: local mapping, provenance, compaction, zero, model generations, malformed/latest statistics and interleaving');
} finally { db.close(); fs.rmSync(home, {recursive: true, force: true}); }
