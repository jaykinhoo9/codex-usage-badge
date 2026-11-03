// Context usage is a request snapshot, independent of cumulative thread tokens.
function formatContextSnapshot(snapshot) {
  const used = snapshot?.last_token_usage?.total_tokens;
  const capacity = snapshot?.model_context_window;
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(capacity) || capacity <= 0) {
    return { available: false, percent: null, tone: 'muted', label: '上下文用量未知',
      detail: snapshot?.reason || '暂无可确认的本地请求统计' };
  }
  const percent = Math.min(100, Math.max(0, used / capacity * 100));
  const number = value => value.toLocaleString('en-US');
  return { available: true, percent, usedTokens: used, contextWindow: capacity,
    remainingTokens: Math.max(0, capacity - used),
    tone: percent < 50 ? 'green' : percent < 90 ? 'yellow' : 'red',
    label: `上下文已用 ${Number(percent.toFixed(1))}%`,
    detail: `${number(used)} / ${number(capacity)} Token\n剩余 ${number(Math.max(0, capacity - used))} Token\n最近一次模型请求统计` };
}
