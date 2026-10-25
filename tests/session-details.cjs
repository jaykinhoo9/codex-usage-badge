'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ThreadTokenReader } = require('../agent.cjs');
const temporaryRoot = require('node:os').tmpdir();
const home = fs.mkdtempSync(path.join(temporaryRoot, 'last-chat-'));
const id = '10000000-0000-0000-0000-000000000001';
const userAt = '2026-08-28T03:36:46.742Z';
const assistantAt = '2026-08-28T03:39:13.540Z';
const settingsAt = '2026-10-25T08:48:44.885Z';
const message = (timestamp, role, extra = {}) => ({ timestamp, type: 'response_item', payload: { type: 'message', role, content: [], ...(role === 'user' ? { internal_chat_message_metadata_passthrough: { content_item_metadata: [{ provenance: { type: 'user' } }] } } : {}), ...extra } });
const event = (type, timestamp = settingsAt) => ({ timestamp, type: 'event_msg', payload: { type } });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }
try {
  fs.mkdirSync(path.join(home, 'sessions'));
  const file = path.join(home, 'sessions', 'history.jsonl');
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, tokens_used INTEGER, rollout_path TEXT, created_at_ms INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(id, 133072999, file, Date.parse(userAt));
  db.close();
  let revision = 0;
  function write(records) {
    fs.writeFileSync(file, records.map(x => JSON.stringify(x)).join('\n') + '\n');
    const at = Date.parse(settingsAt) / 1000 + revision++;
    fs.utimesSync(file, at, at);
  }
  const reader = new ThreadTokenReader({ home });
  write([message(userAt, 'user'), message(assistantAt, 'assistant'), event('token_count'), event('task_complete'), event('thread_settings_applied')]);
  test('regression: August conversation must not become today after settings write', () => {
    const snapshot = reader.read([id]), detail = snapshot.details[id];
    assert.equal(detail.chatAt, Date.parse(assistantAt));
    assert.equal(snapshot.totals[id], 133072999);
    assert.equal(detail.bytes, fs.statSync(file).size);
    assert.equal(detail.createdAt, Date.parse(userAt));
  });
  test('no later settings, context, reasoning, tool results or system/developer messages count', () => {
    write([message(assistantAt, 'assistant'), event('thread_settings_applied'),
      { timestamp: settingsAt, type: 'turn_context', payload: {} },
      { timestamp: settingsAt, type: 'response_item', payload: { type: 'function_call_output' } },
      { timestamp: settingsAt, type: 'response_item', payload: { type: 'reasoning' } },
      message(settingsAt, 'system'), message(settingsAt, 'developer'), message(settingsAt, 'assistant', { channel: 'analysis' })]);
    assert.equal(reader.read([id]).details[id].chatAt, Date.parse(assistantAt));
  });
  test('new user message is counted even before the assistant replies', () => {
    write([message(assistantAt, 'assistant'), message(settingsAt, 'user'), event('thread_settings_applied')]);
    assert.equal(reader.read([id]).details[id].chatAt, Date.parse(settingsAt));
  });
  test('ordinary commentary/final assistant messages count', () => {
    write([message(userAt, 'user'), message(assistantAt, 'assistant', { channel: 'commentary' }), event('thread_settings_applied')]);
    assert.equal(reader.read([id]).details[id].chatAt, Date.parse(assistantAt));
  });
  test('raw user-role context without explicit user provenance is excluded', () => {
    for (const provenance of [undefined, 'harness', 'agents_md', 'tool']) {
      write([message(assistantAt, 'assistant'), message(settingsAt, 'user', {
        content: [{ type: 'input_text', text: '<environment_context>synthetic context</environment_context>' }],
        internal_chat_message_metadata_passthrough: provenance ? { content_item_metadata: [{ provenance: { type: provenance } }] } : undefined,
      })]);
      assert.equal(reader.read([id]).details[id].chatAt, Date.parse(assistantAt));
    }
  });
  test('a human can type context-looking text when provenance identifies real input', () => {
    write([message(assistantAt, 'assistant'), message(settingsAt, 'user', { content: [{ type: 'input_text', text: '<environment_context>human typed this</environment_context>' }] })]);
    assert.equal(reader.read([id]).details[id].chatAt, Date.parse(settingsAt));
  });
  test('paginated UserMessage/AgentMessage completion events identify visible chat', () => {
    for (const type of ['UserMessage', 'AgentMessage']) {
      write([message(assistantAt, 'assistant'), { timestamp: settingsAt, type: 'event_msg', payload: { type: 'item_completed', item: { type, phase: 'final_answer' } } }, event('thread_settings_applied')]);
      assert.equal(reader.read([id]).details[id].chatAt, Date.parse(settingsAt));
    }
    write([message(assistantAt, 'assistant'), { timestamp: settingsAt, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning' } } }]);
    assert.equal(reader.read([id]).details[id].chatAt, Date.parse(assistantAt));
  });
  test('partial answers count in raw and paginated assistant messages', () => {
    for (const latest of [message(settingsAt, 'assistant', { phase: 'partial_answer' }),
      { timestamp: settingsAt, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'partial_answer' } } }]) {
      write([message(assistantAt, 'assistant'), latest]);
      assert.equal(reader.read([id]).details[id].chatAt, Date.parse(settingsAt));
    }
  });
  test('legacy visible user_message/agent_message events count', () => {
    write([event('user_message', userAt), event('agent_message', assistantAt), event('thread_settings_applied')]);
    assert.equal(reader.read([id]).details[id].chatAt, Date.parse(assistantAt));
  });
  test('only bookkeeping means unavailable, never file mtime or creation time', () => {
    write([event('thread_settings_applied')]);
    const snapshot = reader.read([id]);
    assert.equal(snapshot.details[id].chatAt, null);
    assert.equal(snapshot.totals[id], 133072999);
  });
  test('truncated trailing record is ignored; completing it refreshes the result', () => {
    write([message(assistantAt, 'assistant')]);
    fs.appendFileSync(file, '{"timestamp":"2026-10-25T08:48:44.885Z","type":"response_item","payload":');
    assert.equal(reader.read([id]).details[id].chatAt, Date.parse(assistantAt));
    fs.appendFileSync(file, '{"type":"message","role":"user","content":[],"internal_chat_message_metadata_passthrough":{"content_item_metadata":[{"provenance":{"type":"user"}}]}}}\n');
    assert.equal(reader.read([id]).details[id].chatAt, Date.parse(settingsAt));
  });
  test('whitespace and property order do not affect recognition', () => {
    fs.writeFileSync(file, JSON.stringify({ payload: { role: 'assistant', content: [], type: 'message' }, type: 'response_item', timestamp: assistantAt }) + '\n');
    assert.equal(reader.read([id]).details[id].chatAt, Date.parse(assistantAt));
  });
  test('large message content is skipped without hiding its timestamp', () => {
    write([message(assistantAt, 'assistant', { content: [{ type: 'output_text', text: 'x'.repeat(2 * 1024 * 1024) }] }), event('thread_settings_applied')]);
    let detail;
    for (let i = 0; i < 8; i++) {
      const read = fs.readSync; let bytes = 0;
      fs.readSync = (...args) => { bytes += args[3]; return read(...args); };
      try { detail = reader.read([id]).details[id]; }
      finally { fs.readSync = read; }
      assert(bytes <= 1024 * 1024, 'Each poll must respect the read budget');
      if (detail.chatAt) break;
    }
    assert.equal(detail.chatAt, Date.parse(assistantAt));
  });
  test('oversized background records are excluded without retaining their bodies', () => {
    write([message(assistantAt, 'assistant'), { timestamp: settingsAt, type: 'event_msg', payload: { type: 'thread_settings_applied', padding: 'x'.repeat(5 * 1024 * 1024) } }]);
    let detail;
    for (let i = 0; i < 9; i++) { detail = reader.read([id]).details[id]; if (detail.chatAt) break; }
    assert.equal(detail.chatAt, Date.parse(assistantAt));
  });
  test('unrecognized oversized chat shows unavailable instead of an earlier false time', () => {
    write([message(assistantAt, 'assistant'), message(settingsAt, 'user', { content: [{ type: 'input_text', text: 'x'.repeat(5 * 1024 * 1024) }] })]);
    for (let i = 0; i < 9; i++) assert.equal(reader.read([id]).details[id].chatAt, null);
  });
  test('oversized paginated chat cannot be skipped in favor of an earlier message', () => {
    write([message(assistantAt, 'assistant'), { timestamp: settingsAt, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'x'.repeat(5 * 1024 * 1024) }] } } }]);
    for (let i = 0; i < 9; i++) assert.equal(reader.read([id]).details[id].chatAt, null);
  });
  test('invalid latest-message timestamp is unavailable instead of borrowing an earlier time', () => {
    write([message(assistantAt, 'assistant'), message('not-a-date', 'user'), event('thread_settings_applied')]);
    assert.equal(reader.read([id]).details[id].chatAt, null);
  });
  test('unchanged files use the cached result; no recurring file reads', () => {
    write([message(assistantAt, 'assistant'), event('thread_settings_applied')]);
    assert.equal(reader.read([id]).details[id].chatAt, Date.parse(assistantAt));
    const read = fs.readSync;
    fs.readSync = () => { throw Error('Should use cached timestamp'); };
    try { assert.equal(reader.read([id]).details[id].chatAt, Date.parse(assistantAt)); }
    finally { fs.readSync = read; }
  });
  test('missing records and permission failures preserve totals and database creation time', () => {
    const archived = file + '.held';
    fs.renameSync(file, archived);
    try {
      const snapshot = reader.read([id]);
      assert.equal(snapshot.totals[id], 133072999);
      assert.deepEqual(snapshot.details[id], { createdAt: Date.parse(userAt), bytes: null, chatAt: null });
    } finally { fs.renameSync(archived, file); }
    const stat = fs.statSync;
    fs.statSync = () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); };
    try { assert.equal(reader.read([id]).totals[id], 133072999); }
    finally { fs.statSync = stat; }
  });
  test('archive relocation uses the recorded path and refreshes file size', () => {
    const archive = path.join(home, 'archived_sessions', 'history.jsonl');
    fs.mkdirSync(path.dirname(archive));
    const config = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    try {
      fs.renameSync(file, archive);
      config.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(archive, id);
      fs.appendFileSync(archive, JSON.stringify(event('thread_settings_applied')) + '\n');
      const snapshot = reader.read([id]);
      assert.equal(snapshot.details[id].bytes, fs.statSync(archive).size);
      assert.equal(snapshot.details[id].chatAt, Date.parse(assistantAt));
    } finally {
      fs.renameSync(archive, file);
      config.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(file, id);
      config.close();
    }
  });
  test('paths outside session storage and non-session files are rejected', () => {
    const config = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    const outside = path.join(home, 'private.jsonl');
    fs.writeFileSync(outside, JSON.stringify(message(settingsAt, 'user')) + '\n');
    try {
      for (const target of [outside, path.dirname(file)]) {
        config.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(target, id);
        const snapshot = reader.read([id]);
        assert.equal(snapshot.details[id].bytes, null);
        assert.equal(snapshot.details[id].chatAt, null);
        assert.equal(snapshot.totals[id], 133072999);
      }
    } finally {
      config.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(file, id);
      config.close();
    }
  });
  test('seconds-only creation fields and optional older schemas are supported', () => {
    const config = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    config.exec('ALTER TABLE threads ADD COLUMN created_at INTEGER');
    config.prepare('UPDATE threads SET created_at_ms=NULL,created_at=? WHERE id=?').run(Math.floor(Date.parse(userAt)/1000), id);
    config.close();
    assert.equal(reader.read([id]).details[id].createdAt, Math.floor(Date.parse(userAt)/1000)*1000);
    const newer = new DatabaseSync(path.join(home, 'state_6.sqlite'));
    newer.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,tokens_used INTEGER)');
    newer.prepare('INSERT INTO threads VALUES (?,?)').run(id, 42);
    newer.close();
    try {
      const snapshot = reader.read([id]);
      assert.equal(snapshot.ok, true);
      assert.equal(snapshot.totals[id], 42);
      assert.equal(Object.keys(snapshot.details).length, 0);
    } finally { fs.unlinkSync(path.join(home, 'state_6.sqlite')); }
  });
  test('snapshots contain no message content or file paths and reads do not change records', () => {
    write([message(assistantAt, 'assistant', { content: [{ type: 'output_text', text: 'PRIVATE_CONTENT_NOT_TO_EXPOSE' }] })]);
    const record = fs.readFileSync(file), database = fs.readFileSync(path.join(home, 'state_5.sqlite'));
    const snapshot = reader.read([id]);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_CONTENT_NOT_TO_EXPOSE|history\.jsonl/);
    assert.deepEqual(fs.readFileSync(file), record);
    assert.deepEqual(fs.readFileSync(path.join(home, 'state_5.sqlite')), database);
  });
  test('more than 256 stable files finish scanning without evicting pending work', () => {
    const cache = new reader.chatTimes.constructor({ budgetBytes: 128, blockBytes: 64, totalBudgetBytes: 4096, maxPending: 8 });
    const files = Array.from({ length: 257 }, (_, i) => {
      const filename = path.join(home, 'sessions', `many-${i}.jsonl`);
      fs.writeFileSync(filename, JSON.stringify(message(assistantAt, 'assistant')) + '\n' + JSON.stringify({ ...event('thread_settings_applied'), padding: 'x'.repeat(240) }) + '\n');
      return [filename, fs.statSync(filename)];
    });
    let complete = false;
    for (let round = 0; round < 512; round++) {
      cache.beginRead?.();
      const read = fs.readSync; let bytes = 0;
      fs.readSync = (...args) => { bytes += args[3]; return read(...args); };
      let results;
      try { results = files.map(([filename, stat]) => cache.read(filename, stat)); }
      finally { fs.readSync = read; }
      if (cache.beginRead) {
        assert(bytes <= 4096, 'All files together must respect the round budget');
        assert(cache.inFlight.size <= 8, 'Pending buffers must stay bounded');
      }
      if (results.every(time => time === Date.parse(assistantAt))) { complete = true; break; }
    }
    assert.equal(complete, true, 'Pending scans must eventually complete in a fixed-order refresh');
  });
  test('abandoned pending scans release slots for newly requested files', () => {
    const cache = new reader.chatTimes.constructor({ budgetBytes: 64, blockBytes: 64, totalBudgetBytes: 512, maxPending: 2 });
    const fixtures = Array.from({length:3},(_,i)=>{
      const filename=path.join(home,'sessions',`abandoned-${i}.jsonl`);
      fs.writeFileSync(filename,JSON.stringify(message(assistantAt,'assistant'))+'\n'+JSON.stringify({...event('thread_settings_applied'),padding:'x'.repeat(200)})+'\n');
      return [filename,fs.statSync(filename)];
    });
    cache.beginRead();
    for(const [filename,stat] of fixtures.slice(0,2)) assert.equal(cache.read(filename,stat),null);
    let result=null;
    for(let round=0;round<32;round++) {cache.beginRead();result=cache.read(...fixtures[2]);if(result)break;}
    assert.equal(result,Date.parse(assistantAt),'Disappearing rows must not pin all pending slots forever');
  });
  console.log(`PASS ${passed} last-chat cases`);
} finally { fs.rmSync(home, { recursive: true, force: true }); }
