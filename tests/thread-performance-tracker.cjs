const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/thread-performance-tracker.js'), 'utf8');
// This mirrors injection: no require/module/DOM helpers exist in the sandbox.
const create = vm.runInNewContext(source + '\ncreateThreadPerformanceTracker', Object.create(null));
const thread = '00000000-0000-0000-0000-000000000001';
const secondThread = '00000000-0000-0000-0000-000000000002';
let clock = 1000;
const make = options => create({ now: () => clock, ...options });
const send = (tracker, method, params, at) => { clock = at; return tracker.record({ method, params }, at); };
const startTurn = (tracker, turnId = 'turn-a', at = clock, id = thread) => send(tracker, 'turn/started', { threadId: id, turn: { id: turnId, status: 'inProgress' } }, at);
const item = (tracker, method, id, type, timestamp, received = timestamp, turnId = 'turn-a', threadId = thread) => send(tracker, method, {
  threadId, turnId, item: { id, type, text: 'PRIVATE TEXT', arguments: 'PRIVATE ARGUMENTS' },
  [method === 'item/started' ? 'startedAtMs' : 'completedAtMs']: timestamp,
  content: 'PRIVATE CONTENT', command: 'PRIVATE COMMAND',
}, received);
const counts = (inputTokens, outputTokens, reasoningOutputTokens = 0) => ({ inputTokens, outputTokens, reasoningOutputTokens,
  cachedInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: inputTokens + outputTokens, private: 'PRIVATE USAGE' });
const tokens = (tracker, input, output, lastOutput, at, turnId = 'turn-a', threadId = thread, reasoning = 0) => send(tracker, 'thread/tokenUsage/updated', {
  threadId, turnId, tokenUsage: { total: counts(input, output, reasoning), last: counts(100, lastOutput, reasoning) }, prompt: 'PRIVATE PROMPT',
}, at);
const beginModel = (tracker, id, at, type = 'reasoning', turnId = 'turn-a') => item(tracker, 'item/started', id, type, at, at, turnId);
const finishModel = (tracker, id, at, type = 'reasoning', turnId = 'turn-a') => item(tracker, 'item/completed', id, type, at, at, turnId);

{
  clock = 1000;
  const tracker = make();
  assert.equal(tracker.snapshot(thread).tokensPerSecond, null);
  startTurn(tracker);
  beginModel(tracker, 'reasoning-a', 1100);
  finishModel(tracker, 'reasoning-a', 2000);
  beginModel(tracker, 'message-a', 2000, 'agentMessage');
  finishModel(tracker, 'message-a', 2100, 'agentMessage');
  assert.equal(tokens(tracker, 100, 220, 220, 2200, 'turn-a', thread, 80), true);
  const snapshot = tracker.snapshot(thread);
  assert.equal(snapshot.llmDurationMs, 1100, 'one response uses earliest model start through usage arrival, not a sum of item timers');
  assert.equal(snapshot.tokensPerSecond, 200, 'real total output includes reasoning and arguments rather than character estimates');
  assert.equal(snapshot.observedResponses, 1);
  assert.equal(snapshot.observedRounds, 1);
  assert.equal(snapshot.observedSteps, 1);
  assert.equal(snapshot.countersLowerBound, true);
  assert.equal(snapshot.timingApproximate, true);
  assert.equal(snapshot.observedSince, 1000);
  assert.equal(snapshot.lastSampleAt, 2200);
  assert.doesNotMatch(JSON.stringify(snapshot) + JSON.stringify(tracker.status()), /PRIVATE|command|argument|reasoning-a|prompt/);
  assert.equal(tokens(tracker, 100, 220, 220, 2300, 'turn-a', thread, 80), false);
  assert.equal(tracker.snapshot(thread).observedResponses, 1, 'mirrored usage notifications must not recount the response');
  assert.equal(item(tracker, 'item/started', 'reasoning-a', 'reasoning', 1100, 2300), false, 'replayed historical starts cannot become new windows');
  assert.equal(tracker.snapshot(thread).llmDurationMs, 1100);
}

{
  clock = 1000;
  const tracker = make();
  assert.equal(tracker.snapshot(thread).observedRounds, null);
  assert.equal(tracker.snapshot(thread).observedSteps, null, 'missing source events cannot invent a zero count');
  tokens(tracker, 0, 0, 0, 1050);
  tokens(tracker, 0, 0, 0, 1060);
  assert.equal(tracker.snapshot(thread).observedSteps, null, 'zero initialization snapshots are not completed model responses');
  assert.equal(tokens(tracker, 100, 100, 100, 1100), false);
  assert.equal(tokens(tracker, 100, 100, 100, 1200), false);
  assert.equal(tokens(tracker, 200, 200, 100, 1300), false);
  assert.equal(tracker.snapshot(thread).observedSteps, 2, 'live model completion counts do not depend on valid timing windows');
  assert.equal(tracker.snapshot(thread).observedResponses, 0);
  assert.equal(tracker.snapshot(thread).observedRounds, null);
  startTurn(tracker, 'turn-a', 1400);
  startTurn(tracker, 'turn-a', 1450);
  send(tracker, 'turn/completed', { threadId: thread, turn: { id: 'turn-a', status: 'completed' } }, 1500);
  assert.equal(tracker.snapshot(thread).observedRounds, 1, 'started/completed notifications identify one unique round');
  startTurn(tracker, 'turn-b', 1600);
  tokens(tracker, 300, 300, 100, 1700, 'turn-b');
  assert.equal(tracker.snapshot(thread).observedRounds, 2);
  assert.equal(tracker.snapshot(thread).observedSteps, 3);
  send(tracker, 'turn/completed', { threadId: thread, turn: { id: 'turn-b', status: 'failed' } }, 1800);
  assert.equal(tracker.snapshot(thread).observedRounds, 2, 'timing failure resets cannot erase observed native lifecycle counts');
  assert.equal(tracker.snapshot(thread).observedSteps, 3);
  assert.equal(tracker.snapshot(thread).countersObservedSince, 1000);
  assert.equal(tracker.snapshot(thread).countersScope, 'since-monitor-start');
  tracker.reset(thread);
  assert.equal(tracker.snapshot(thread).observedRounds, null, 'explicit disconnect/reset begins a new count epoch');
  assert.equal(tracker.snapshot(thread).observedSteps, null);
}

{
  clock = 1000;
  const tracker = make({ maxCounterEvents: 2 });
  tokens(tracker, 100, 100, 100, 1100);
  tokens(tracker, 200, 200, 100, 1200);
  tokens(tracker, 300, 300, 100, 1300);
  assert.equal(tracker.snapshot(thread).observedSteps, 2, 'bounded deduplication storage leaves an explicit lower bound at its limit');
  assert.equal(tracker.snapshot(thread).countersLowerBound, true);
}

{
  clock = 1000;
  const tracker = make();
  beginModel(tracker, 'partially-observed', 900, 'reasoning');
  finishModel(tracker, 'partially-observed', 2000, 'reasoning');
  assert.equal(tokens(tracker, 1000, 500, 100, 2100), false);
  assert.equal(tracker.snapshot(thread).tokensPerSecond, null, 'first usage after mid-turn attach is only a baseline');
  beginModel(tracker, 'complete-response', 2200);
  finishModel(tracker, 'complete-response', 3200);
  assert.equal(tokens(tracker, 1100, 600, 100, 3200), true);
  assert.equal(tracker.snapshot(thread).tokensPerSecond, 100, 'a fully observed response can qualify without waiting for a new user turn');
  beginModel(tracker, 'next-response', 3300);
  assert.equal(tokens(tracker, 1100, 600, 100, 3400), false, 'duplicate old usage must not consume the new model window');
  finishModel(tracker, 'next-response', 4300);
  assert.equal(tokens(tracker, 1200, 700, 100, 4300), true);
  assert.equal(tracker.snapshot(thread).observedResponses, 2);
}

{
  clock = 1000;
  const tracker = make();
  startTurn(tracker);
  let at = 1100, totalOutput = 0;
  const samples = [[1000, 100], [2000, 400], [1000, 100], [4000, 200], [1000, 150], [2000, 300]];
  samples.forEach(([duration, output], index) => {
    beginModel(tracker, `weighted-${index}`, at);
    finishModel(tracker, `weighted-${index}`, at + duration);
    totalOutput += output;
    assert.equal(tokens(tracker, 100 * (index + 1), totalOutput, output, at + duration), true);
    at += duration + 100;
  });
  assert.equal(tracker.snapshot(thread).llmDurationMs, 11000);
  assert.equal(tracker.snapshot(thread).observedResponses, 6);
  assert.equal(tracker.snapshot(thread).tokensPerSecond, 115, 'recent five samples use sum(tokens)/sum(duration), not a mean of five ratios');
}

{
  clock = 1000;
  const tracker = make();
  startTurn(tracker);
  beginModel(tracker, 'tool-boundary-model', 1100);
  finishModel(tracker, 'tool-boundary-model', 2100);
  item(tracker, 'item/started', 'tool-a', 'commandExecution', 2200);
  item(tracker, 'item/started', 'tool-b', 'sleep', 2300);
  item(tracker, 'item/completed', 'tool-a', 'commandExecution', 2600);
  item(tracker, 'item/completed', 'tool-b', 'sleep', 2700);
  assert.equal(tokens(tracker, 100, 120, 120, 2800), true);
  assert.equal(tracker.snapshot(thread).llmDurationMs, 1200, 'overlapping tools subtract their interval union exactly once');
  assert.equal(tracker.snapshot(thread).tokensPerSecond, 100);

  beginModel(tracker, 'overlap-model', 2900);
  item(tracker, 'item/started', 'overlap-tool', 'dynamicToolCall', 3000);
  finishModel(tracker, 'overlap-model', 3400);
  item(tracker, 'item/completed', 'overlap-tool', 'dynamicToolCall', 3500);
  assert.equal(tokens(tracker, 200, 240, 120, 3600), false);
  assert.equal(tracker.snapshot(thread).tokensPerSecond, 100, 'an ambiguous new window is excluded while prior valid recent samples remain');
  assert.equal(tracker.snapshot(thread).lastSampleAt, 2800);
  assert.equal(tracker.snapshot(thread).observedResponses, 1);
  assert.equal(tracker.snapshot(thread).llmDurationMs, 1200, 'rejected windows cannot inflate observed LLM time');
}

for (const missingReasoning of ['missing-time', 'old-time', 'both-events-missing']) {
  clock = 1000;
  const tracker = make();
  startTurn(tracker);
  if (missingReasoning !== 'both-events-missing') {
    send(tracker, 'item/started', { threadId: thread, turnId: 'turn-a', item: { id: 'hidden-reasoning', type: 'reasoning' },
      ...(missingReasoning === 'old-time' ? { startedAtMs: 900 } : {}) }, 1100);
    finishModel(tracker, 'hidden-reasoning', 1200);
  }
  beginModel(tracker, 'visible-only', 1210, 'agentMessage');
  finishModel(tracker, 'visible-only', 1220, 'agentMessage');
  assert.equal(tokens(tracker, 100, 1000, 1000, 1300, 'turn-a', thread, 990), false,
    'missing hidden reasoning cannot be divided by a short visible message interval');
  assert.equal(tracker.snapshot(thread).tokensPerSecond, null);
}

{
  clock = 1000;
  const tracker = make();
  startTurn(tracker);
  beginModel(tracker, 'backlogged', 1100, 'reasoning');
  // Model start delivered far after its producer timestamp is replay/backlog,
  // even when it is newer than the monitoring epoch.
  const late = make();
  startTurn(late, 'turn-a', 1100);
  item(late, 'item/started', 'backlogged', 'reasoning', 1200, 100000);
  item(late, 'item/completed', 'backlogged', 'reasoning', 1300, 100010);
  assert.equal(tokens(late, 100, 100, 100, 100100), false);
  assert.equal(late.snapshot(thread).tokensPerSecond, null);

  clock = 1000;
  const long = make({ maxGapMs: 1000 });
  startTurn(long);
  beginModel(long, 'long-reasoning', 1100);
  finishModel(long, 'long-reasoning', 601100);
  assert.equal(tokens(long, 100, 1000, 1000, 601100, 'turn-a', thread, 1000), true,
    'a fully captured timely completion validates a long silent reasoning interval');
  assert.equal(long.snapshot(thread).llmDurationMs, 600000);
  assert.equal(long.snapshot(thread).tokensPerSecond, 1000 / 600);
}

{
  clock = 1000;
  const tracker = make();
  startTurn(tracker);
  beginModel(tracker, 'fast-before', 1100);
  finishModel(tracker, 'fast-before', 2000);
  assert.equal(tokens(tracker, 100, 100, 100, 2100), true);
  item(tracker, 'item/started', 'fast-next', 'reasoning', 2050, 2120);
  finishModel(tracker, 'fast-next', 3050);
  assert.equal(tokens(tracker, 200, 200, 100, 3060), true,
    'ordered native delivery with nonoverlapping model source intervals tolerates a next start before the previous usage arrival');
  assert.equal(tracker.snapshot(thread).observedResponses, 2);
  assert.equal(tracker.snapshot(thread).llmDurationMs, 2010);
}

for (const missing of ['model-completion', 'tool-completion', 'tool-start', 'model-start']) {
  clock = 1000;
  const tracker = make();
  startTurn(tracker);
  beginModel(tracker, 'missing-model', 1100);
  if (missing !== 'model-completion') finishModel(tracker, 'missing-model', 1200);
  if (missing === 'model-start') finishModel(tracker, 'uncaptured-model', 1250, 'agentMessage');
  if (missing === 'tool-completion') item(tracker, 'item/started', 'missing-tool', 'webSearch', 1300);
  if (missing === 'tool-start') item(tracker, 'item/completed', 'missing-tool', 'webSearch', 1400);
  assert.equal(tokens(tracker, 100, 100, 100, 1500), false, missing + ' must invalidate a response sample');
  assert.equal(tracker.snapshot(thread).llmDurationMs, null);
}

{
  clock = 1000;
  const tracker = make();
  startTurn(tracker);
  item(tracker, 'item/started', 'pure-tool', 'commandExecution', 1100);
  item(tracker, 'item/completed', 'pure-tool', 'commandExecution', 1200);
  assert.equal(tokens(tracker, 100, 100, 100, 1300), false);
  assert.equal(tracker.snapshot(thread).tokensPerSecond, null, 'pure tool-only output has no observed model generation start');
  beginModel(tracker, 'after-tool', 1400);
  finishModel(tracker, 'after-tool', 2400);
  assert.equal(tokens(tracker, 200, 300, 100, 2400), false, 'cumulative progression showing a missed response must not be assigned to one window');
  beginModel(tracker, 'new-baseline-model', 2500);
  finishModel(tracker, 'new-baseline-model', 3500);
  assert.equal(tokens(tracker, 300, 400, 100, 3500), true);
  assert.equal(tracker.snapshot(thread).observedResponses, 1);
  startTurn(tracker, 'turn-b', 3600);
  assert.equal(tracker.snapshot(thread).tokensPerSecond, null, 'a new turn clears pending observations and old recent speeds');
  beginModel(tracker, 'new-turn-model', 3700, 'reasoning', 'turn-b');
  finishModel(tracker, 'new-turn-model', 4700, 'reasoning', 'turn-b');
  assert.equal(tokens(tracker, 400, 500, 100, 4700, 'turn-b'), true);
  assert.equal(tracker.snapshot(thread).llmDurationMs, 2000, 'ordinary turn changes retain validated observed time over the monitoring epoch');
}

for (const invalidation of ['counter-reset', 'malformed', 'compaction', 'failure', 'interruption', 'clock-rollback', 'long-gap', 'reset']) {
  clock = 1000;
  const tracker = make({ maxGapMs: 1000 });
  startTurn(tracker);
  beginModel(tracker, 'valid', 1100);
  finishModel(tracker, 'valid', 1500);
  assert.equal(tokens(tracker, 100, 100, 100, 1600), true);
  if (invalidation !== 'long-gap') beginModel(tracker, 'pending-invalid', 1700);
  if (invalidation === 'counter-reset') tokens(tracker, 1, 1, 1, 1800);
  if (invalidation === 'malformed') send(tracker, 'thread/tokenUsage/updated', { threadId: thread, turnId: 'turn-a', tokenUsage: { total: counts(200, 200), last: { outputTokens: -1 } } }, 1800);
  if (invalidation === 'compaction') item(tracker, 'item/started', 'compact', 'contextCompaction', 1800);
  if (invalidation === 'failure' || invalidation === 'interruption') send(tracker, 'turn/completed', { threadId: thread, turn: { id: 'turn-a', status: invalidation === 'failure' ? 'failed' : 'interrupted' } }, 1800);
  if (invalidation === 'clock-rollback') tokens(tracker, 200, 200, 100, 1650);
  if (invalidation === 'long-gap') tokens(tracker, 200, 200, 100, 3000);
  if (invalidation === 'reset') { clock = 1800; tracker.reset(thread); }
  assert.equal(tracker.snapshot(thread).tokensPerSecond, null, invalidation + ' clears prior current-looking speeds');
  assert.equal(tracker.status().pending, 0, invalidation + ' clears the pending window');
}

{
  clock = 1000;
  const tracker = make({ maxItems: 2, maxThreads: 1 });
  startTurn(tracker);
  beginModel(tracker, 'item-1', 1100);
  beginModel(tracker, 'item-2', 1200);
  beginModel(tracker, 'item-3', 1300);
  assert.equal(tracker.status().pending, 0, 'the item cap clears exact timing rather than growing without bound');
  startTurn(tracker, 'other', 1400, secondThread);
  assert.equal(tracker.status().threads, 1, 'thread identities are held in a bounded LRU');
  assert.equal(tracker.snapshot(thread).llmDurationMs, null);
  assert.equal(send(tracker, 'item/started', { threadId: "');DROP TABLE threads;--", turnId: 't', item: { id: 'i', type: 'reasoning' }, startedAtMs: 1400 }, 1400), false);
  assert.equal(send(tracker, 'item/agentMessage/delta', { threadId: secondThread, turnId: 'other', delta: 'PRIVATE TEXT' }, 1400), false, 'text deltas are deliberately irrelevant to real token counts');
  tracker.reset();
  assert.equal(tracker.status().threads, 0);
  tracker.stop();
  assert.equal(tracker.status().stopped, true);
  assert.equal(startTurn(tracker, 'stopped', 1500), false);
  assert.equal(tracker.snapshot(secondThread).tokensPerSecond, null);
}

console.log('PASS injectable numeric performance tracker, exact token numerator, response batching, mid-turn baseline, weighted five-response rates, overlap/tool union, missing/replayed/duplicate events, turn lifecycle, malformed/reset counters, clocks/gaps, privacy and bounded cleanup');
