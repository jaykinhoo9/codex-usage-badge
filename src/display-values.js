function quotaTone(percent) {
  return !Number.isFinite(percent) ? 'muted' : percent < 10 ? 'danger' : percent <= 50 ? 'warning' : 'normal';
}
function unavailableValue(current, title = '暂时无法读取 Codex 用量，正在自动重试') {
  return { ...current, percent: null, title, tone: 'muted', stale: true,
    rings: current?.rings?.map(ring => ({ ...ring, percent: null, tone: 'muted', title: `${ring.label}：暂不可用` })) ?? null };
}
function formatRateLimits(response) {
  const single = formatPrimaryRateLimits(response);
  single.tone = quotaTone(single.percent);
  const snapshot = pickCodexSnapshot(response);
  const windows = [snapshot?.primary, snapshot?.secondary].filter(Boolean);
  function ring(key, label, match) {
    const window = windows.find(match);
    const percent = validWindow(window) ? remainingPercent(window.usedPercent) : null;
    const reset = formatResetTime(window?.resetsAt);
    const tone = quotaTone(percent);
    return { key, label, percent, tone,
      title: `${label}：${percent === null ? '暂不可用' : `剩余 ${percent}%`}${reset ? `，${reset} 重置` : ''}` };
  }
  const rings = [
    ring('five-hour', '5h额度', w => w.windowDurationMins === 300),
    ring('weekly', '周额度', w => Number.isFinite(w.windowDurationMins) && w.windowDurationMins >= 10080 && w.windowDurationMins % 10080 === 0)
  ].filter(r => Number.isFinite(r.percent));
  if (rings.length < 2) return { ...single, mode: 'single', rings: null };
  return { ...single, mode: 'dual', rings,
    title: ['Codex 剩余额度', ...rings.map(r => r.title), ...formatResetCredits(response)].join('\n') };
}
