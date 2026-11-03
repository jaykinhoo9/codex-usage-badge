const assert = require('node:assert/strict');
const {formatContextSnapshot} = require('../agent.cjs');
const format = (used, capacity) => formatContextSnapshot({last_token_usage: {total_tokens: used}, model_context_window: capacity});
for (const [used, capacity, percent, tone, remaining] of [
  [0, 100, 0, 'green', 100], [49, 100, 49, 'green', 51], [50, 100, 50, 'yellow', 50],
  [89, 100, 89, 'yellow', 11], [90, 100, 90, 'red', 10], [100, 100, 100, 'red', 0],
  [150, 100, 100, 'red', 0], [180500, 475000, 38, 'green', 294500]
]) {
  const value = format(used, capacity);
  assert.equal(value.available, true); assert.equal(value.percent, percent); assert.equal(value.tone, tone);
  assert.equal(value.usedTokens, used); assert.equal(value.contextWindow, capacity); assert.equal(value.remainingTokens, remaining);
}
assert.match(format(180500, 475000).detail, /180,500 \/ 475,000 Token\n剩余 294,500 Token\n最近一次模型请求统计/);
assert.match(format(150, 100).detail, /150 \/ 100/);
for (const invalid of [null, undefined, NaN, Infinity, -1, '10', {}, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(format(invalid, 100).available, false);
  assert.equal(format(10, invalid).available, false);
}
assert.equal(format(10, 0).percent, null);
assert.equal(formatContextSnapshot(null).available, false);
assert.equal(formatContextSnapshot({last_token_usage: {total_tokens: 40, cached_input_tokens: 30}, model_context_window: 100}).percent, 40);
console.log('PASS context format: thresholds, zero, over-capacity raw detail, actual capacity, invalid fields and cached tokens');
