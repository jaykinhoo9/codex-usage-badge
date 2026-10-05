const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

// Test this source independently of agent.cjs's generated build and desktop UI.
const filename = path.join(__dirname, '../src/thread-metrics-reader.js');
const sourceModule = new Module(filename, module);
sourceModule.filename = filename;
sourceModule.paths = module.paths;
sourceModule._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { ThreadMetricsReader, createThreadMetricsReader };', filename);
const { ThreadMetricsReader, createThreadMetricsReader } = sourceModule.exports;
const ids = [1, 2, 3, 4, 5, 6].map(number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-metrics-'));
const sessions = path.join(temp, 'sessions');
fs.mkdirSync(sessions);
const dbFile = path.join(temp, 'state_5.sqlite');
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, first_user_message TEXT);');
const insert = db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?, ?, ?)');
const metadata = id => ({ type: 'session_meta', payload: { id, base_instructions: 'PRIVATE INSTRUCTIONS MUST NOT LEAVE THE READER' } });
const event = (type, payload = {}) => ({ type: 'event_msg', payload: { type, ...payload } });
const total = (input, output, cached) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached, total_tokens: input + output });
const legacy = usage => event('token_count', { info: { total_token_usage: usage, last_token_usage: usage }, rate_limits: { private: 'PRIVATE RATE DATA' } });
const usage = (id, responseId, tokens) => ({ type: 'token_usage_record', payload: { thread_id: id, response_id: responseId, usage: tokens, thread_token_usage: tokens } });
const tool = (type, callId, time, extra = {}) => ({ timestamp: new Date(time).toISOString(), type: 'response_item', payload: { type, call_id: callId, ...extra } });
const encode = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
function fixture(id, records, directory = sessions) {
  const file = path.join(directory, `rollout-${id}.jsonl`);
  fs.writeFileSync(file, encode(records));
  insert.run(id, file, 'PRIVATE TITLE', 'PRIVATE USER PROMPT');
  return file;
}
const records = [
  metadata(ids[0]), event('task_started', { turn_id: 'turn-a' }),
  legacy(total(100, 10, 80)), usage(ids[0], 'response-a', total(100, 10, 80)),
  usage(ids[0], 'response-a', total(100, 10, 80)), legacy(total(100, 10, 80)),
  tool('function_call', 'call-a', 1000, { arguments: 'PRIVATE ARGUMENTS' }),
  tool('custom_tool_call', 'call-b', 2000, { input: 'PRIVATE INPUT' }),
  tool('function_call_output', 'call-a', 4000, { output: '私人输出 🌷 PRIVATE OUTPUT' }),
  tool('custom_tool_call_output', 'call-b', 5000, { output: 'PRIVATE OUTPUT' }),
  tool('custom_tool_call_output', 'call-b', 5000),
  event('task_complete', { turn_id: 'turn-a', duration_ms: 100000, time_to_first_token_ms: 1000, last_agent_message: 'PRIVATE RESPONSE' }),
  event('task_started', { turn_id: 'turn-b' }), event('task_started', { turn_id: 'turn-b' }),
  usage(ids[0], 'response-b', total(300, 30, 250)), legacy(total(250, 25, 200)),
  tool('function_call', 'call-c', 9000), tool('function_call_output', 'call-c', 10000),
  event('task_complete', { turn_id: 'turn-b', duration_ms: 200000, time_to_first_token_ms: 3000 }),
  event('task_complete', { turn_id: 'turn-b', duration_ms: 200000, time_to_first_token_ms: 3000 }),
  usage(ids[1], 'foreign-response', total(9000, 9000, 9000)),
  event('item_completed', { thread_id: ids[0], turn_id: 'turn-b', started_at_ms: 1, completed_at_ms: 900000, item: { type: 'AgentMessage', content: 'PRIVATE RESPONSE' } }),
];

(async () => {
  try {
    const file = fixture(ids[0], records);
    const originalFile = fs.readFileSync(file), originalDB = fs.readFileSync(dbFile);
    const reader = createThreadMetricsReader({ home: temp, now: () => 123, maxScanMs: 1000 });
    assert(reader instanceof ThreadMetricsReader);
    const initial = await reader.read([ids[0], ids[0], "');DROP TABLE threads;--", null]);
    assert.equal(initial.ok, true);
    assert.equal(initial.checkedAt, 123);
    assert.match(initial.scopeId, /^[a-f0-9]{64}$/);
    assert.equal(initial.perThread[ids[0]].localVerified, true);
    assert.equal(Object.keys(initial.perThread).length, 1);
    const values = initial.perThread[ids[0]];
    const metricKeys = ['rounds', 'steps', 'llmDurationMs', 'toolDurationMs', 'firstTokenAvgMs', 'tokensPerSecond', 'cacheHitPercent', 'inputTokens', 'outputTokens', 'complete'];
    assert.deepEqual(Object.fromEntries(metricKeys.map(key => [key, values[key]])), { rounds: 2, steps: 2, llmDurationMs: null, toolDurationMs: 5000,
      firstTokenAvgMs: 2000, tokensPerSecond: null, cacheHitPercent: 250 / 300 * 100,
      inputTokens: 300, outputTokens: 30, complete: true });
    assert.doesNotMatch(JSON.stringify(initial), /PRIVATE|私人|arguments|prompt|rollout_path|response-a|call-a/);
    assert.equal(JSON.stringify(initial).includes(temp), false);
    assert.deepEqual(fs.readFileSync(file), originalFile, 'rollout reads must be read-only');
    assert.deepEqual(fs.readFileSync(dbFile), originalDB, 'database reads must be read-only');
    assert.equal(db.prepare('SELECT count(*) AS count FROM threads').get().count, 1);
    assert.deepEqual((await reader.read([ids[0]])).perThread[ids[0]], values, 'unchanged reads must not recount responses or turns');

    fs.appendFileSync(file, encode([event('task_started', { turn_id: 'turn-c' })]));
    const third = JSON.stringify(usage(ids[0], 'response-c', total(400, 40, 300)));
    fs.appendFileSync(file, third.slice(0, 50));
    const partial = (await reader.read([ids[0]])).perThread[ids[0]];
    assert.equal(partial.complete, false);
    assert.equal(partial.rounds, 3, 'completed lifecycle records can expose explicitly marked historical lower bounds');
    assert.equal(partial.steps, 2);
    assert.equal(partial.countersLowerBound, true);
    assert.equal(partial.roundsComplete, false);
    assert.equal(partial.backfilling, false, 'a partial line at EOF must not trigger an endless accelerated backfill timer');
    assert.equal(partial.toolDurationMs, null);
    assert.equal(partial.inputTokens, 300, 'the last completed cumulative usage record remains available');
    fs.appendFileSync(file, third.slice(50) + '\n');
    const appended = (await reader.read([ids[0]])).perThread[ids[0]];
    assert.equal(appended.complete, true);
    assert.equal(appended.rounds, 3);
    assert.equal(appended.steps, 3);
    assert.equal(appended.inputTokens, 400);
    assert.equal(appended.outputTokens, 40);
    assert.equal(appended.revision, values.revision, 'append-only updates must preserve the rollout revision');

    fs.writeFileSync(file, encode([metadata(ids[0]), event('task_started', { turn_id: 'replacement' })]));
    const truncated = (await reader.read([ids[0]])).perThread[ids[0]];
    assert.equal(truncated.rounds, 1);
    assert.equal(truncated.steps, 0);
    assert.equal(truncated.countersReset, true);
    assert.notEqual(truncated.revision, values.revision);
    assert.equal(truncated.inputTokens, null, 'file truncation clears previous usage');
    const replacement = file + '.new';
    fs.writeFileSync(replacement, encode([metadata(ids[0]), usage(ids[0], 'new-inode', total(1, 1, 0))]));
    fs.renameSync(replacement, file);
    assert.equal((await reader.read([ids[0]])).perThread[ids[0]].inputTokens, 1, 'atomic replacement resets cached offsets');

    fixture(ids[1], [metadata(ids[1]), event('task_started', { turn_id: 'old-turn' }),
      legacy(total(100, 10, 50)), legacy(total(100, 10, 50)), event('token_count', { info: null }),
      legacy(total(200, 20, 100))]);
    const old = (await reader.read([ids[1]])).perThread[ids[1]];
    assert.equal(old.steps, 2);
    assert.equal(old.inputTokens, 200);
    assert.equal(old.cacheHitPercent, 50);
    assert.equal(old.firstTokenAvgMs, null);

    const forkFile = fixture(ids[2], [metadata(ids[1]), event('task_started', { turn_id: 'inherited' }),
      usage(ids[1], 'inherited-response', total(500, 50, 300)),
      tool('function_call', 'parent-call', 1), tool('function_call_output', 'parent-call', 90000),
      metadata(ids[2]), event('task_started', { turn_id: 'own' }), usage(ids[2], 'own-response', total(10, 5, 0))]);
    const fork = (await reader.read([ids[2]])).perThread[ids[2]];
    assert.equal(fork.rounds, 1, 'copied fork history is excluded before the matching session metadata');
    assert.equal(fork.steps, 1);
    assert.equal(fork.toolDurationMs, 0);
    assert.equal(fork.inputTokens, 10);

    const bounded = new ThreadMetricsReader({ home: temp, maxScanBytes: 29, chunkBytes: 7, maxScanMs: 1000 });
    let snapshot = (await bounded.read([ids[2]])).perThread[ids[2]];
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.rounds, null);
    assert.equal(snapshot.inputTokens, 10, 'bounded tail metadata yields tokens during backfill');
    assert(bounded.cache.get(ids[2]).offset <= 29, 'each scan respects its byte budget');
    let reads = 1;
    while (!snapshot.complete && reads++ < 1000) snapshot = (await bounded.read([ids[2]])).perThread[ids[2]];
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.steps, 1);
    assert(reads > 1, 'large rollouts are backfilled across refreshes');
    assert.deepEqual(fs.readFileSync(forkFile), Buffer.from(encode([metadata(ids[1]), event('task_started', { turn_id: 'inherited' }),
      usage(ids[1], 'inherited-response', total(500, 50, 300)), tool('function_call', 'parent-call', 1), tool('function_call_output', 'parent-call', 90000),
      metadata(ids[2]), event('task_started', { turn_id: 'own' }), usage(ids[2], 'own-response', total(10, 5, 0))])));
    const explicitOwnUsage = usage(ids[2], 'own-after-parent-meta', total(10, 5, 0));
    explicitOwnUsage.payload.turn_id = 'own-turn-after-inherited-meta';
    fixture(ids[2], [metadata(ids[2]), metadata(ids[1]), explicitOwnUsage]);
    const appendedParentMeta = (await reader.read([ids[2]])).perThread[ids[2]];
    assert.equal(appendedParentMeta.steps, 1, 'explicit modern thread ownership survives appended inherited session metadata');
    assert.equal(appendedParentMeta.rounds, 1, 'the modern usage turn ID reliably recovers its own round');

    // The tail can contain only a huge unrelated tool output. A scanned prefix
    // must then remain blank, even though its historical usage was valid.
    const prefixFile = fixture(ids[4], [metadata(ids[4]), usage(ids[4], 'prefix-old', total(100, 10, 50)),
      usage(ids[4], 'prefix-new', total(200, 20, 150)),
      { type: 'world_state', payload: { state: 'x'.repeat(4000) } }]);
    const noTail = new ThreadMetricsReader({ home: temp, tailBytes: 128, maxScanBytes: 600, chunkBytes: 100, maxScanMs: 1000 });
    let withoutTail = (await noTail.read([ids[4]])).perThread[ids[4]];
    assert.equal(withoutTail.complete, false);
    assert.equal(withoutTail.inputTokens, null, 'an old parsed prefix must not masquerade as latest tokens during backfill');
    assert.equal(withoutTail.outputTokens, null);
    while (!withoutTail.complete) withoutTail = (await noTail.read([ids[4]])).perThread[ids[4]];
    assert.equal(withoutTail.inputTokens, 200);
    fs.appendFileSync(prefixFile, encode([usage(ids[4], 'invalid-newest', { input_tokens: -1, output_tokens: 'bad', cached_input_tokens: 3 })]));
    assert.equal((await noTail.read([ids[4]])).perThread[ids[4]].inputTokens, null, 'invalid newest metadata clears older current-looking totals');
    const invalidTail = new ThreadMetricsReader({ home: temp, maxScanMs: 1000 });
    assert.equal((await invalidTail.read([ids[4]])).perThread[ids[4]].outputTokens, null, 'tail reads must not skip an invalid newest record and reuse its predecessor');

    fixture(ids[4], [event('task_started', { turn_id: 'untagged-turn' }), legacy(total(999, 999, 500))]);
    const untagged = (await reader.read([ids[4]])).perThread[ids[4]];
    assert.equal(untagged.rounds, null, 'untagged history needs matching session metadata');
    assert.equal(untagged.inputTokens, null);

    fixture(ids[4], [metadata(ids[4]), event('task_started', { turn_id: 'unicode' }),
      tool('custom_tool_call', 'unicode-call', 1000),
      tool('custom_tool_call_output', 'unicode-call', 4000, { output: '私人输出 🌷 PRIVATE OUTPUT' })]);
    const unicodeReader = new ThreadMetricsReader({ home: temp, chunkBytes: 1, maxScanMs: 1000 });
    let unicode = (await unicodeReader.read([ids[4]])).perThread[ids[4]];
    while (!unicode.complete) unicode = (await unicodeReader.read([ids[4]])).perThread[ids[4]];
    assert.equal(unicode.toolDurationMs, 3000, 'UTF-8 code points split across chunks must not corrupt JSON or interval matching');
    assert.doesNotMatch(JSON.stringify(unicode), /私人|PRIVATE/);

    const hugeFile = fixture(ids[3], [metadata(ids[3]), event('task_started', { turn_id: 'huge-turn' }),
      { type: 'world_state', payload: { state: 'PRIVATE ' + 'x'.repeat(12000) } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'PRIVATE ' + 'x'.repeat(12000) } },
      usage(ids[3], 'huge-response', total(200, 10, 150))]);
    const smallLines = new ThreadMetricsReader({ home: temp, maxLineBytes: 1024, chunkBytes: 31, maxScanMs: 1000 });
    const ignored = (await smallLines.read([ids[3]])).perThread[ids[3]];
    assert.equal(ignored.complete, true);
    assert.equal(ignored.rounds, 1, 'oversized unneeded message/world-state data is safely skipped');
    assert.equal(ignored.steps, 1);
    assert.equal(smallLines.cache.get(ids[3]).carry.length, 0);
    fs.appendFileSync(hugeFile, encode([tool('function_call', 'huge-tool', 1, { arguments: 'x'.repeat(12000) }), tool('function_call_output', 'huge-tool', 1000)]));
    const dropped = (await smallLines.read([ids[3]])).perThread[ids[3]];
    assert.equal(dropped.rounds, 1);
    assert.equal(dropped.steps, 1);
    assert.equal(dropped.toolDurationMs, null, 'an omitted tool interval must never appear as zero or a guessed value');
    fs.appendFileSync(hugeFile, '{"type":"event_msg","payload":{"type":"token_count", BAD JSON}\n');
    const malformed = (await smallLines.read([ids[3]])).perThread[ids[3]];
    assert.equal(malformed.rounds, 1, 'idle last-good counter snapshots survive unavailable new observations');
    assert.equal(malformed.steps, 1);
    assert.equal(malformed.countersLowerBound, true);
    assert.equal(malformed.inputTokens, 200, 'known cumulative metadata survives a damaged event');

    const outside = path.join(temp, 'outside.jsonl');
    fs.writeFileSync(outside, encode([metadata(ids[4]), usage(ids[4], 'outside', total(999, 999, 999))]));
    insert.run(ids[4], outside, 'PRIVATE TITLE', 'PRIVATE PROMPT');
    assert.equal((await reader.read([ids[4]])).perThread[ids[4]].inputTokens, null, 'arbitrary database paths must not be read');
    const symlink = path.join(sessions, 'escape.jsonl');
    fs.symlinkSync(outside, symlink);
    insert.run(ids[4], symlink, 'PRIVATE TITLE', 'PRIVATE PROMPT');
    assert.equal((await reader.read([ids[4]])).perThread[ids[4]].inputTokens, null, 'symlinks cannot escape the session directory');
    const archived = path.join(temp, 'archived_sessions');
    fs.mkdirSync(archived);
    fixture(ids[4], [metadata(ids[4]), usage(ids[4], 'archive', total(10, 1, 11))], archived);
    const archive = (await reader.read([ids[4]])).perThread[ids[4]];
    assert.equal(archive.inputTokens, 10);
    assert.equal(archive.cacheHitPercent, null, 'invalid cache counters must not produce a percentage over 100%');

    const pendingFile = fixture(ids[5], [metadata(ids[5]), event('task_started', { turn_id: 'pending' }), tool('function_call', 'pending-call', 1000)]);
    assert.equal((await reader.read([ids[5]])).perThread[ids[5]].toolDurationMs, null, 'an unfinished call has no measured duration yet');
    fs.appendFileSync(pendingFile, encode([tool('function_call_output', 'pending-call', 4000)]));
    const simultaneous = await Promise.all([reader.read([ids[5]]), reader.read([ids[5]])]);
    assert.equal(simultaneous[0].perThread[ids[5]].toolDurationMs, 3000);
    assert.deepEqual(simultaneous[0].perThread[ids[5]], simultaneous[1].perThread[ids[5]], 'concurrent readers share one scan per thread');

    const capped = new ThreadMetricsReader({ home: temp, maxTrackedEvents: 1, maxScanMs: 1000 });
    const limited = (await capped.read([ids[2]])).perThread[ids[2]];
    assert.equal(limited.rounds, null, 'the memory cap blanks exact counters rather than undercounting');
    assert.equal(limited.toolDurationMs, null);
    assert.equal(limited.inputTokens, 10);

    fixture(ids[0], [metadata(ids[0]), event('task_started', { turn_id: 'indexed-a' }),
      usage(ids[0], 'indexed-response-a', total(10, 1, 0)), event('task_started', { turn_id: 'indexed-b' }),
      usage(ids[0], 'indexed-response-b', total(20, 2, 0))]);
    const historyFile = path.join(temp, 'thread_history_1.sqlite');
    const history = new DatabaseSync(historyFile);
    history.exec('CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_byte_offset INTEGER); CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,error_json TEXT);');
    history.prepare('INSERT INTO thread_history_projection_state VALUES (?,?)').run(ids[0], fs.statSync(file).size);
    history.prepare('INSERT INTO thread_turns VALUES (?,?,?)').run(ids[0], 'indexed-a', 'PRIVATE ERROR BODY');
    history.prepare('INSERT INTO thread_turns VALUES (?,?,?)').run(ids[0], 'indexed-b', 'PRIVATE ERROR BODY');
    history.prepare('INSERT INTO thread_turns VALUES (?,?,?)').run(ids[1], 'foreign-inherited-turn', 'PRIVATE ERROR BODY');
    const historyBefore = fs.readFileSync(historyFile);
    const indexedReader = new ThreadMetricsReader({ home: temp, maxScanBytes: 1, maxScanMs: 1000 });
    const indexed = (await indexedReader.read([ids[0]])).perThread[ids[0]];
    assert.equal(indexed.complete, false);
    assert.equal(indexed.backfilling, true);
    assert.equal(indexed.rounds, 2, 'the complete lifecycle index supplies immediate rounds while huge rollouts backfill');
    assert.equal(indexed.roundsComplete, true);
    assert.equal(indexed.steps, null);
    assert.equal(indexed.stepsComplete, false);
    assert.deepEqual(fs.readFileSync(historyFile), historyBefore, 'the lifecycle index is read-only');
    assert.doesNotMatch(JSON.stringify(indexed), /PRIVATE/);
    history.prepare('UPDATE thread_history_projection_state SET next_rollout_byte_offset = next_rollout_byte_offset - 1').run();
    const lagged = (await indexedReader.read([ids[0]])).perThread[ids[0]];
    assert.equal(lagged.rounds, 2);
    assert.equal(lagged.roundsComplete, false, 'an index watermark behind the rollout is an explicit lower bound');
    const futureHistoryFile = path.join(temp, 'thread_history_2.sqlite');
    const futureHistory = new DatabaseSync(futureHistoryFile); futureHistory.exec('CREATE TABLE unknown(id TEXT)'); futureHistory.close();
    const unknownHistory = (await new ThreadMetricsReader({ home: temp, maxScanBytes: 1 }).read([ids[0]])).perThread[ids[0]];
    assert.equal(unknownHistory.rounds, null, 'a newer unknown lifecycle index cannot silently reuse an older version');
    fs.unlinkSync(futureHistoryFile); history.close();

    db.exec('ALTER TABLE threads ADD COLUMN creator_account_id TEXT');
    db.prepare('UPDATE threads SET creator_account_id=? WHERE id=?').run('PRIVATE ACCOUNT A', ids[0]);
    const accountA = await reader.read([ids[0]]);
    db.prepare('UPDATE threads SET creator_account_id=? WHERE id=?').run('PRIVATE ACCOUNT B', ids[0]);
    const accountB = await reader.read([ids[0]]);
    assert.equal(accountA.scopeId, accountB.scopeId, 'global storage scope stays stable across account owner metadata updates');
    assert.notEqual(accountA.perThread[ids[0]].scopeId, accountB.perThread[ids[0]].scopeId, 'thread owner scopes must invalidate retained account data');
    assert.doesNotMatch(JSON.stringify(accountA) + JSON.stringify(accountB), /PRIVATE ACCOUNT/);

    // Pause old-scope file resolution while another refresh discovers a newer
    // state database for the same UUID. The old promise must never get the new
    // scope's ownership proof or overwrite its cache/provenance.
    const racing = new ThreadMetricsReader({ home: temp, maxScanMs: 1000 });
    const safePath = racing.safePath.bind(racing);
    let entered, release;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const releasedPromise = new Promise(resolve => { release = resolve; });
    let pause = true;
    racing.safePath = async value => {
      if (pause) { pause = false; entered(); await releasedPromise; }
      return safePath(value);
    };
    const oldScopeRead = racing.read([ids[0]]);
    await enteredPromise;
    const raceFile = path.join(sessions, 'rollout-race-new-scope.jsonl');
    const raceUsage = usage(ids[0], 'race-new', total(900, 90, 800)); raceUsage.payload.turn_id = 'race-new-turn';
    fs.writeFileSync(raceFile, encode([metadata(ids[0]), raceUsage]));
    const newDatabase = new DatabaseSync(path.join(temp, 'state_7.sqlite'));
    newDatabase.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)');
    newDatabase.prepare('INSERT INTO threads VALUES(?,?)').run(ids[0], raceFile); newDatabase.close();
    const newScopeRead = await racing.read([ids[0]]);
    assert.equal(newScopeRead.perThread[ids[0]].inputTokens, 900);
    release();
    const discarded = await oldScopeRead;
    assert.equal(discarded.ok, false);
    assert.equal(Object.keys(discarded.perThread).length, 0, 'obsolete pending data cannot be relabeled with a new verified scope');
    assert.equal(racing.cache.get(ids[0]).file, fs.realpathSync(raceFile), 'an old deferred scan cannot overwrite current-scope cache data');
    assert.equal(racing.provenance.get(ids[0]).file, fs.realpathSync(raceFile));
    racing.stop(); fs.unlinkSync(path.join(temp, 'state_7.sqlite'));
    db.exec('ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0; ALTER TABLE threads ADD COLUMN archived_at INTEGER');
    db.prepare('UPDATE threads SET archived=1,archived_at=? WHERE id=?').run(123, ids[0]);
    const originals = new Map([file, forkFile].map(name => [name, fs.readFileSync(name)]));
    const archiveQuery = reader.archivedIds([ids[0], ids[1], ids[0], 'invalid', '10000000-0000-0000-0000-000000000001']);
    assert.equal(archiveQuery.ok, true);
    assert.deepEqual(archiveQuery.ids, [ids[0]], 'only existing, positively archived UUIDs authorize plugin metric deletion');
    const hundreds = Array.from({ length: 450 }, (_, n) => `10000000-0000-0000-0000-${String(n + 1).padStart(12, '0')}`);
    assert.deepEqual(reader.archivedIds([...hundreds, ids[0]]).ids, [ids[0]], 'archive reconciliation is not capped to cached or visible conversations');
    const archivedSnapshot = await reader.read([ids[0], ids[1]]);
    assert.deepEqual(archivedSnapshot.archivedIds, [ids[0]]);
    assert.equal(archivedSnapshot.perThread[ids[0]].archived, true);
    assert.equal(archivedSnapshot.perThread[ids[0]].localVerified, true);
    assert.equal(archivedSnapshot.perThread[ids[0]].rounds, undefined);
    assert.equal(archivedSnapshot.perThread[ids[0]].inputTokens, undefined, 'archived conversations cannot export remembered or rescanned metric fields');
    assert.equal(reader.cache.has(ids[0]), false);
    db.prepare('UPDATE threads SET archived=0,archived_at=NULL WHERE id=?').run(ids[0]);
    const unarchived = await reader.read([ids[0]]);
    assert.equal(unarchived.perThread[ids[0]].archived, undefined);
    assert.equal(unarchived.perThread[ids[0]].inputTokens, 20, 'unarchive can collect fresh values from the original untouched rollout');
    for (const [name, content] of originals) assert.deepEqual(fs.readFileSync(name), content, 'plugin archival cleanup never changes an original conversation file');

    const archiveRace = new ThreadMetricsReader({ home: temp, maxScanMs: 1000 });
    const archiveSafePath = archiveRace.safePath.bind(archiveRace);
    let archiveEntered, archiveRelease;
    const archiveEnteredPromise = new Promise(resolve => { archiveEntered = resolve; });
    const archiveReleasedPromise = new Promise(resolve => { archiveRelease = resolve; });
    archiveRace.safePath = async value => { archiveEntered(); await archiveReleasedPromise; return archiveSafePath(value); };
    const beforeArchiveRead = archiveRace.read([ids[0]]);
    await archiveEnteredPromise;
    db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(ids[0]);
    archiveRelease();
    const lateArchiveResult = await beforeArchiveRead;
    assert.equal(lateArchiveResult.perThread[ids[0]].archived, true, 'archive during pending I/O suppresses its previously captured metrics');
    assert.equal(lateArchiveResult.perThread[ids[0]].inputTokens, undefined);
    assert.equal(archiveRace.cache.has(ids[0]), false);
    archiveRace.stop(); db.prepare('UPDATE threads SET archived=0 WHERE id=?').run(ids[0]);
    const future = new DatabaseSync(path.join(temp, 'state_6.sqlite'));
    future.exec('CREATE TABLE other(id TEXT)'); future.close();
    const unknownState = await reader.read([ids[0]]);
    assert.equal(unknownState.ok, false, 'unknown newest state schema must not silently reuse an older account snapshot');
    assert.equal(reader.archivedIds(ids).ok, false, 'unknown latest archive schemas never authorize deleting old or missing threads');
    assert.deepEqual(reader.archivedIds(ids).ids, []);
    assert.match(unknownState.scopeId, /^[a-f0-9]{64}$/);
    assert.notEqual(unknownState.scopeId, initial.scopeId, 'a known changed database scope must quarantine the older cache even if its schema is unsupported');
    fs.unlinkSync(path.join(temp, 'state_6.sqlite'));
    assert.equal((await reader.read([ids[0]])).ok, true);
    assert.equal((await new ThreadMetricsReader({ home: path.join(temp, 'missing') }).read([ids[0]])).ok, false);
    assert.equal((await reader.read([])).ok, true);
    reader.stop();
    assert.equal(reader.cache.size, 0);
    assert.equal((await reader.read([ids[0]])).ok, false);
    console.log('PASS read-only numeric thread metrics, response/turn deduplication, fork isolation, overlapping tool intervals, explicit turn TTFT, unavailable model timings, incremental byte budgets, tails, partial UTF-8 lines, truncation/replacement, size/memory caps, path confinement, schema failure and stop');
  } finally { db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
