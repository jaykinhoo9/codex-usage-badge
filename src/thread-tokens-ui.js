function installThreadTokens() {
  const VERSION = 8;
  const KEY = '__codexThreadTokens';
  const ROW = '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id]';
  const MARK = 'data-codex-thread-tokens';
  if (window[KEY]?.version === VERSION) { window[KEY].refresh(); return; }
  window[KEY]?.destroy?.();
  let snapshot = { ok: false, totals: {}, details: {}, checkedAt: null };
  let received = false;
  let disposed = false;
  let refreshTimer = null;
  let tooltipTimer = null;
  let hovered = null;
  let pointer = null;
  const badges = new Map();
  const style = document.createElement('style');
  style.id = 'codex-thread-tokens-style';
  // GPT can nest a block title inside a non-flex slot. Style only the direct
  // badge/title container, leaving outer metadata and secondary rows intact.
  style.textContent = `
    [${MARK}] { --token-0: #d6dce2; --token-1: #c4d5ec; --token-2: #90b2e1; --token-3: #5e90d0; --token-4: #2f6ebf;
      position: relative; display: inline-block; align-self: center; flex: 0 0 12px; width: 12px; height: 12px;
      box-sizing: border-box; border-radius: 3px; border: 0; background: var(--token-0);
      cursor: inherit; user-select: none; -webkit-app-region: no-drag; }
    [${MARK}]::before { content: ''; position: absolute; inset: -6px; }
    :is(${ROW}, ${ROW} *):has(> [${MARK}] + [data-thread-title]) {
      display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important;
      align-items: center; gap: 6px; min-width: 0;
    }
    ${ROW} [${MARK}] + [data-thread-title] {
      flex: 1 1 auto !important; width: auto !important; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    html.dark [${MARK}], html[data-theme="dark"] [${MARK}] {
      --token-0: #282828; --token-1: #1d293e; --token-2: #223b60; --token-3: #27528c; --token-4: #2d70ca; }
    @media (prefers-color-scheme: dark) {
      html:not(.light):not([data-theme="light"]) [${MARK}] {
        --token-0: #282828; --token-1: #1d293e; --token-2: #223b60; --token-3: #27528c; --token-4: #2d70ca;
      }
      html:not(.light):not([data-theme="light"]) #codex-thread-tokens-tooltip {
        background: var(--color-surface-elevated-secondary, #2c2e2c); color: var(--color-text-primary, #edf0ed);
      }
    }
    [${MARK}][data-level="1"] { background: var(--token-1); }
    [${MARK}][data-level="2"] { background: var(--token-2); }
    [${MARK}][data-level="3"] { background: var(--token-3); }
    [${MARK}][data-level="4"] { background: var(--token-4); }
    #codex-thread-tokens-tooltip { position: fixed; z-index: 2147483000; pointer-events: none; box-sizing: border-box;
      max-width: min(300px, calc(100vw - 16px)); padding: 9px 12px; border-radius: 9px; border: 1px solid #8883;
      box-shadow: 0 4px 18px #0002; background: var(--color-surface-elevated-secondary, #f8f8f7);
      color: var(--color-text-primary, #303630); white-space: pre-line; font: 12px/1.65 -apple-system, BlinkMacSystemFont, sans-serif; }
    html.dark #codex-thread-tokens-tooltip, html[data-theme="dark"] #codex-thread-tokens-tooltip {
      background: var(--color-surface-elevated-secondary, #2c2e2c); color: var(--color-text-primary, #edf0ed); }
    #codex-thread-tokens-tooltip[hidden] { display: none !important; }
  `;
  const tooltip = document.createElement('div'); tooltip.id = 'codex-thread-tokens-tooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true;
  function identity(row) {
    const key = row.getAttribute('data-app-action-sidebar-thread-id') ?? '';
    const host = row.getAttribute('data-app-action-sidebar-thread-host-id');
    const kind = row.getAttribute('data-app-action-sidebar-thread-kind');
    const match = /^local:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(key);
    return { key, id: match && host === 'local' && kind === 'local' ? match[1] : null };
  }
  function level(total) {
    // Fixed thresholds keep the same color when the sidebar list changes.
    if (total === 0) return 0;
    if (total < 1e6) return 1;
    if (total < 1e7) return 2;
    if (total < 1e8) return 3;
    return 4;
  }
  function formatTokens(total) {
    const units = [[1e8, '亿'], [1e7, '千万'], [1e4, '万']];
    for (let i = 0; i < units.length; i++) {
      const [divisor, suffix] = units[i];
      if (total < divisor) continue;
      const rounded = Number((total / divisor).toFixed(2));
      if (i > 0 && rounded * divisor >= units[i - 1][0]) return `1${units[i - 1][1]}`;
      return `${rounded}${suffix}`;
    }
    return total.toLocaleString('zh-CN');
  }
  function tokenReading(row) {
    const { id } = identity(row);
    if (!id) return { state: 'unknown', detail: '此会话暂无可读取的本地 Token 记录' };
    const stale = Number.isFinite(snapshot.checkedAt) && Date.now() - snapshot.checkedAt > 30000;
    if (stale) return { state: 'stale', detail: 'Token 用量数据已过期，正在等待重新连接' };
    const total = snapshot.totals[id];
    if (!received) return { state: 'unknown', detail: '正在读取会话累计 Token' };
    if (!snapshot.ok) return { state: 'unknown', detail: '暂时无法读取本地 Token 记录，正在自动重试' };
    if (!Number.isSafeInteger(total) || total < 0) return { state: 'unknown', detail: '此会话暂无可读取的本地 Token 记录' };
    return { level: level(total), state: 'ready', detail: `累计使用 ${formatTokens(total)} Token` };
  }
  function formatSessionBytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return '暂不可用';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = bytes, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${Number(value.toFixed(2))} ${units[index]}`;
  }
  function formatSessionDate(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8.64e15) return '暂不可用';
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .format(new Date(timestamp)).replaceAll('/', '-');
  }
  function reading(row) {
    const value = tokenReading(row);
    const { id } = identity(row);
    const detail = snapshot.ok ? snapshot.details[id] : null;
    return { ...value, detail: [value.detail,
      `会话文件 ${formatSessionBytes(detail?.bytes)}`,
      `创建时间 ${formatSessionDate(detail?.createdAt)}`,
      `最后对话 ${formatSessionDate(detail?.chatAt)}`].join('\n') };
  }
  function hideTooltip() { clearTimeout(tooltipTimer); tooltipTimer = null; hovered = null; tooltip.hidden = true; }
  function positionTooltip() {
    if (!hovered?.isConnected) { hideTooltip(); return; }
    const r = hovered.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - tooltip.offsetWidth - 8))}px`;
    const top = r.bottom + 8 + tooltip.offsetHeight <= innerHeight - 8 ? r.bottom + 8 : r.top - tooltip.offsetHeight - 8;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }
  function render(row, badge) {
    const value = reading(row);
    if (badge.textContent) badge.textContent = '';
    const colorLevel = String(value.level ?? 0);
    if (badge.dataset.level !== colorLevel) badge.dataset.level = colorLevel;
    if (badge.dataset.state !== value.state) badge.dataset.state = value.state;
    const label = value.detail.replaceAll('\n', '，');
    if (badge.getAttribute('aria-label') !== label) badge.setAttribute('aria-label', label);
    if (badge.dataset.tooltip !== value.detail) badge.dataset.tooltip = value.detail;
    if (hovered === badge && !tooltip.hidden) {
      if (tooltip.textContent !== value.detail) tooltip.textContent = value.detail;
      positionTooltip();
    }
  }
  function refresh() {
    if (disposed || !document.body) return;
    if (!style.isConnected) (document.head ?? document.documentElement).append(style);
    if (!tooltip.isConnected) document.body.append(tooltip);
    const owned = new Set(badges.values());
    for (const badge of document.querySelectorAll(`[${MARK}]`)) if (!owned.has(badge)) badge.remove();
    for (const [row, badge] of badges) {
      const title = row.querySelector('[data-thread-title]');
      if (!row.isConnected || !row.matches(ROW) || !title || badge.parentElement !== title.parentElement || badge.nextElementSibling !== title) {
        if (hovered === badge) hideTooltip(); badge.remove(); badges.delete(row);
      }
    }
    for (const row of document.querySelectorAll(ROW)) {
      const title = row.querySelector('[data-thread-title]');
      if (!title?.parentElement) continue;
      let badge = badges.get(row);
      if (!badge) {
        // Own a sibling of the title. Never wrap or move React-owned content.
        badge = document.createElement('span'); badge.setAttribute(MARK, ''); badge.setAttribute('role', 'img');
        badge.setAttribute('aria-describedby', tooltip.id);
        title.before(badge); badges.set(row, badge);
      }
      render(row, badge);
    }
    syncHover();
  }
  function scheduleRefresh() {
    if (disposed || refreshTimer !== null) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 80);
  }
  function badgeAtPointer() {
    if (!pointer || document.hidden) return null;
    const el = document.elementFromPoint(pointer.x, pointer.y);
    const badge = el?.closest(`[${MARK}]`);
    return badge && badges.get(badge.closest(ROW)) === badge ? badge : null;
  }
  function syncHover() {
    const badge = badgeAtPointer();
    if (badge === hovered) return;
    hideTooltip();
    if (!badge) return;
    hovered = badge;
    tooltipTimer = setTimeout(() => {
      tooltipTimer = null;
      if (badgeAtPointer() !== hovered || !hovered?.isConnected) { hideTooltip(); return; }
      tooltip.textContent = hovered.dataset.tooltip; tooltip.hidden = false; positionTooltip();
    }, 150);
  }
  function onPointer(event) {
    if (event.pointerType === 'touch') return;
    if (event.buttons) { clearHover(); return; }
    pointer = { x: event.clientX, y: event.clientY };
    syncHover();
  }
  function onOut(event) { if (!event.relatedTarget) clearHover(); }
  function clearHover() { pointer = null; hideTooltip(); }
  function onKey(event) { if (event.key === 'Escape') clearHover(); }
  function onLayout(event) {
    // Streaming replies scroll the conversation pane, not the sidebar hover target.
    if (event.type === 'scroll' && event.target instanceof Element) {
      const badge = hovered ?? badgeAtPointer();
      if (!badge || !event.target.contains(badge)) return;
    }
    hideTooltip(); scheduleRefresh();
  }
  const observer = new MutationObserver(records => {
    if (records.some(r => !r.target.closest?.(`[${MARK}]`) && r.target !== tooltip && !tooltip.contains(r.target) && r.target !== style)) scheduleRefresh();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-app-action-sidebar-thread-id', 'data-app-action-sidebar-thread-host-id', 'data-app-action-sidebar-thread-kind'] });
  const freshnessTimer = setInterval(() => { for (const [row, badge] of badges) render(row, badge); }, 1000);
  // Capture before the native sidebar can stop bubbling; movement also repairs missed enters.
  document.addEventListener('pointerover', onPointer, true);
  document.addEventListener('pointermove', onPointer, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('pointerdown', clearHover, true);
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', clearHover);
  document.addEventListener('scroll', onLayout, true);
  window.addEventListener('resize', onLayout);
  window.addEventListener('blur', clearHover);
  window[KEY] = {
    version: VERSION, refresh,
    requestedIds() { return [...new Set([...document.querySelectorAll(ROW)].map(row => identity(row).id).filter(Boolean))].slice(0, 2000); },
    update(next) {
      snapshot = { ok: next?.ok === true, checkedAt: Number.isFinite(next?.checkedAt) ? next.checkedAt : null,
        totals: next?.totals && typeof next.totals === 'object' ? next.totals : {},
        details: next?.details && typeof next.details === 'object' ? next.details : {} };
      received = true; refresh();
    },
    status() { return { version: VERSION, badges: [...badges.values()].filter(el => el.isConnected).length,
      available: [...badges.values()].filter(el => el.isConnected && el.dataset.state === 'ready').length,
      source: 'local-session-total', checkedAt: snapshot.checkedAt, ok: snapshot.ok }; },
    destroy() {
      disposed = true; observer.disconnect(); clearTimeout(refreshTimer); clearInterval(freshnessTimer); hideTooltip();
      document.removeEventListener('pointerover', onPointer, true); document.removeEventListener('pointermove', onPointer, true);
      document.removeEventListener('pointerout', onOut, true); document.removeEventListener('pointerdown', clearHover, true);
      document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', clearHover);
      document.removeEventListener('scroll', onLayout, true); window.removeEventListener('resize', onLayout);
      window.removeEventListener('blur', clearHover);
      for (const badge of badges.values()) badge.remove(); badges.clear(); style.remove(); tooltip.remove(); delete window[KEY];
    }
  };
  refresh();
}
