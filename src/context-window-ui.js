// Compatibility adapter for the observed desktop composer. Private React props
// are read only; an unknown shape is never replaced with a guessed local host.
function resolveComposerBinding(root) {
  function visible(element) {
    return !!element?.isConnected && element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0 &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  function props(element) {
    for (let depth = 0; element && depth < 16; depth++, element = element.parentElement) {
      const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
      if (!key) continue;
      let fiber = element[key];
      const top = node => { let n = 0; while (node?.return && n++ < 160) node = node.return; return node; };
      const tree = top(fiber);
      if (tree?.stateNode?.current && tree.stateNode.current !== tree) {
        fiber = fiber?.alternate;
        const alternateTree = top(fiber);
        if (!fiber || alternateTree?.stateNode?.current !== alternateTree) return [];
      }
      const result = [], seen = new Set();
      for (; fiber && result.length < 160 && !seen.has(fiber); fiber = fiber.return) {
        seen.add(fiber);
        if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object') result.push(fiber.memoizedProps);
      }
      return result;
    }
    return [];
  }
  if (!root?.matches('[data-codex-composer-root]') || !visible(root)) return { ok: false, reason: 'composer-hidden' };
  const inputs = [...root.querySelectorAll('[data-codex-composer]')].filter(visible);
  const buttons = [...root.querySelectorAll('[data-composer-navigation-target="reasoning"]')].filter(visible);
  if (inputs.length !== 1 || buttons.length !== 1 || buttons[0].tagName !== 'BUTTON') return { ok: false, reason: 'anchor-unavailable' };
  const ids = [...new Set([...root.querySelectorAll('[data-above-composer-conversation-id]')]
    .map(node => node.getAttribute('data-above-composer-conversation-id')).filter(Boolean))];
  if (ids.length !== 1) return { ok: false, reason: 'thread-unavailable' };
  const threadId = ids[0];
  const hosts = new Set(props(inputs[0]).filter(p => p.conversationId === threadId && typeof p.hostId === 'string').map(p => p.hostId));
  const modelProps = props(buttons[0]);
  const model = modelProps.find(p => typeof p.model === 'string')?.model;
  if (hosts.size !== 1 || !model) return { ok: false, reason: 'identity-unavailable' };
  const host = [...hosts][0];
  // If the toolbar exposes an execution target, it must agree with the thread.
  const executionHosts = new Set(modelProps.filter(p => typeof p.executionTargetHostId === 'string').map(p => p.executionTargetHostId));
  if (executionHosts.size > 1 || (executionHosts.size === 1 && !executionHosts.has(host))) return { ok: false, reason: 'host-conflict' };
  return { ok: true, host, threadId, model };
}

function installContextWindowIndicator(bindingResolver) {
  const KEY = '__codexContextWindow', VERSION = 4, MARK = 'data-codex-context-window';
  if (window[KEY]?.version === VERSION) { window[KEY].refresh(); return; }
  window[KEY]?.destroy();
  const entries = new Map();
  const retiredGenerations = new Map();
  const instance = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let serial = 0, disposed = false, scheduled = null, hoverTimer = null, active = null;
  const unknown = { available: false, percent: null, tone: 'muted', label: '上下文用量未知', detail: '暂无可确认的本地请求统计' };
  const style = document.createElement('style');
  style.id = 'codex-context-window-style';
  style.textContent = `
    [${MARK}] { --context-green:#218652; --context-yellow:#ac790b; --context-red:#cf4141; --context-muted:#929898; --context-hover:#0000000a;
      display:inline-flex;align-items:center;justify-content:center;align-self:center;flex:0 0 28px;
      width:28px;height:28px;margin:0 6px 0 0;padding:0;box-sizing:border-box;vertical-align:middle;
      border:0;border-radius:999px;background:transparent;color:var(--context-muted);cursor:default;-webkit-app-region:no-drag; }
    [${MARK}][hidden] {display:none!important}
    [${MARK}]:hover,[${MARK}]:focus-visible {background:var(--context-hover)}
    [${MARK}]:focus-visible {outline:2px solid currentColor;outline-offset:1px}
    [${MARK}] svg {width:14px;height:14px;display:block;overflow:visible;flex:none}
    [${MARK}] circle {fill:none;stroke-width:2}
    [${MARK}] .context-track {stroke:currentColor;opacity:.2}
    [${MARK}] .context-progress {stroke:currentColor;transition:stroke-dashoffset 180ms ease,stroke 180ms ease}
    [${MARK}][data-tone="green"] {color:var(--context-green)}
    [${MARK}][data-tone="yellow"] {color:var(--context-yellow)}
    [${MARK}][data-tone="red"] {color:var(--context-red)}
    [${MARK}][data-tone="muted"] .context-track {opacity:.65}
    html.dark [${MARK}],html[data-theme="dark"] [${MARK}] {--context-green:#54c58c;--context-yellow:#e5b54c;--context-red:#ef7777;--context-muted:#8a9393;--context-hover:#ffffff14}
    #codex-context-window-tooltip {position:fixed;z-index:2147483647;max-width:calc(100vw - 16px);padding:6px 12px;
      box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 5%,transparent);border-radius:14px;
      background:var(--color-surface-tooltip,#fff);color:var(--color-text-tooltip,var(--color-text-primary,#242424));
      box-shadow:0 4px 16px #0002;font:12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      white-space:normal;overflow-wrap:anywhere;pointer-events:none;-webkit-app-region:no-drag}
    #codex-context-window-tooltip .context-tooltip-label {display:block;font-size:14px;line-height:20px;font-weight:600}
    #codex-context-window-tooltip .context-tooltip-detail {display:block;margin-top:2px;opacity:.8;white-space:pre-line}
    #codex-context-window-tooltip[hidden] {display:none}
    html.dark #codex-context-window-tooltip,html[data-theme="dark"] #codex-context-window-tooltip {background:var(--color-surface-tooltip,#262626);color:var(--color-text-tooltip,#f5f5f5)}
    @media(prefers-color-scheme:dark) {html:not(.light):not([data-theme="light"]) [${MARK}] {--context-green:#54c58c;--context-yellow:#e5b54c;--context-red:#ef7777;--context-muted:#8a9393;--context-hover:#ffffff14}
      html:not(.light):not([data-theme="light"]) #codex-context-window-tooltip {background:var(--color-surface-tooltip,#262626);color:var(--color-text-tooltip,#f5f5f5)}}
    @media(prefers-reduced-motion:reduce) {[${MARK}] .context-progress {transition:none}}
  `;
  document.head.append(style);
  const tooltip = document.createElement('div');
  tooltip.id = 'codex-context-window-tooltip'; tooltip.role = 'tooltip'; tooltip.hidden = true;
  const tooltipLabel = document.createElement('span'), tooltipDetail = document.createElement('span');
  tooltipLabel.className = 'context-tooltip-label'; tooltipDetail.className = 'context-tooltip-detail';
  tooltip.append(tooltipLabel, document.createTextNode('\n'), tooltipDetail);
  document.body.append(tooltip);
  function visible(node) {
    return node?.isConnected && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 &&
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  function hideTooltip() { clearTimeout(hoverTimer); hoverTimer = null; active = null; tooltip.hidden = true; }
  function showTooltip(entry) {
    if (disposed || entry.node.hidden || !visible(entry.node)) return;
    active = entry;
    tooltipLabel.textContent = entry.value.label;
    tooltipDetail.textContent = entry.value.detail;
    tooltip.hidden = false;
    const rect = entry.node.getBoundingClientRect(), bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(innerWidth - bounds.width - 8, rect.x + rect.width / 2 - bounds.width / 2))}px`;
    tooltip.style.top = `${Math.max(8, rect.y - bounds.height - 8)}px`;
  }
  function paint(entry, value) {
    entry.value = value;
    const node = entry.node;
    node.dataset.tone = value.tone;
    node.setAttribute('aria-label', value.label);
    node.setAttribute('aria-valuetext', `${value.label}；${value.detail.replaceAll('\n', '；')}`);
    if (value.available) node.setAttribute('aria-valuenow', String(value.percent));
    else node.removeAttribute('aria-valuenow');
    node.querySelector('.context-progress').style.strokeDashoffset = String(100 - (value.percent ?? 0));
    if (active === entry) showTooltip(entry);
  }
  function makeEntry(root) {
    // A DOM clone can copy our marker without its listeners or binding state.
    for (const orphan of root.querySelectorAll(`[${MARK}]`)) orphan.remove();
    const node = document.createElement('span');
    node.setAttribute(MARK, ''); node.tabIndex = 0; node.role = 'meter';
    node.setAttribute('aria-valuemin', '0'); node.setAttribute('aria-valuemax', '100');
    node.setAttribute('aria-describedby', tooltip.id);
    node.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle class="context-track" cx="7" cy="7" r="6"/><circle class="context-progress" cx="7" cy="7" r="6" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" transform="rotate(-90 7 7)"/></svg>';
    const entry = { root, node, id: `${instance}:${++serial}`, version: 0, identity: null, binding: null,
      modelGenerations: new Map(), value: unknown, received: 0 };
    node.addEventListener('pointerenter', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => showTooltip(entry), 300); });
    node.addEventListener('pointerleave', hideTooltip);
    node.addEventListener('focus', () => showTooltip(entry));
    node.addEventListener('blur', hideTooltip);
    for (const type of ['click', 'dblclick', 'pointerdown']) node.addEventListener(type, event => event.stopPropagation());
    node.addEventListener('keydown', event => {
      if (event.key === 'Escape') { hideTooltip(); event.stopPropagation(); }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); }
    });
    entries.set(root, entry); paint(entry, unknown); return entry;
  }
  function refresh() {
    if (disposed) return;
    // Keep only identity metadata across a React remount. A new DOM node must
    // not erase a previously observed A/B/A model-switch baseline.
    for (const [root, entry] of entries) if (!root.isConnected) {
      if (active === entry) hideTooltip();
      for (const [key, generation] of entry.modelGenerations) {
        const previous = retiredGenerations.get(key);
        if (!previous || generation.changedAt >= previous.changedAt) retiredGenerations.set(key, generation);
      }
      while (retiredGenerations.size > 128) retiredGenerations.delete(retiredGenerations.keys().next().value);
      entry.node.remove(); entries.delete(root);
    }
    for (const root of document.querySelectorAll('[data-codex-composer-root]')) {
      let entry = entries.get(root);
      if (!visible(root)) {
        if (entry) { entry.node.remove(); entry.binding = null; entry.identity = null; if (active === entry) hideTooltip(); }
        continue;
      }
      const buttons = [...root.querySelectorAll('[data-composer-navigation-target="reasoning"]')].filter(visible);
      const button = buttons.length === 1 && buttons[0].tagName === 'BUTTON' ? buttons[0] : null;
      if (!button || !visible(root.querySelector('[data-codex-composer]'))) {
        if (entry) { entry.node.remove(); entry.binding = null; entry.identity = null; if (active === entry) hideTooltip(); }
        continue;
      }
      // The observed model button has a non-flex tooltip wrapper. Inserting
      // inside that wrapper creates a second line; use its first row-flex parent.
      let anchor = button;
      for (let depth = 0; depth < 4 && anchor.parentElement !== root; depth++) {
        const parent = anchor.parentElement;
        const layout = getComputedStyle(parent);
        if (['flex', 'inline-flex'].includes(layout.display) && layout.flexDirection === 'row') break;
        if (parent.children.length !== 1 && !parent.querySelector(`[${MARK}]`)) { anchor = null; break; }
        anchor = parent;
      }
      if (!anchor || !['flex', 'inline-flex'].includes(getComputedStyle(anchor.parentElement).display)) {
        if (entry) { entry.node.remove(); entry.binding = null; entry.identity = null; }
        continue;
      }
      entry ||= makeEntry(root);
      const binding = bindingResolver(root);
      const identity = binding.ok ? JSON.stringify([binding.host, binding.threadId, binding.model]) : `unknown:${binding.reason}`;
      if (identity !== entry.identity) {
        entry.identity = identity; entry.version++; entry.received = 0;
        let generation;
        if (binding.ok) {
          const key = JSON.stringify([binding.host, binding.threadId]);
          generation = entry.modelGenerations.get(key) || retiredGenerations.get(key);
          if (!generation || generation.model !== binding.model) {
            generation = { model: binding.model, changedAt: Math.max(Date.now(), (generation?.changedAt ?? -1) + 1), requireFresh: !!generation };
          }
          entry.modelGenerations.set(key, generation);
        }
        entry.binding = binding.ok ? { id: entry.id, host: binding.host, threadId: binding.threadId,
          model: binding.model, bindingVersion: entry.version, changedAt: generation.changedAt, requireFresh: generation.requireFresh } : null;
        paint(entry, { ...unknown, detail: binding.ok ? '等待当前模型请求的统计' : '暂时无法获取当前聊天的用量数据' });
      }
      // Native component: a localized, labelled context-usage image with a ring.
      // Only a visible component inside this composer suppresses our indicator.
      const native = [...root.querySelectorAll('[role="img"][aria-label]')].some(node =>
        visible(node) && /context.*(?:usage|window)|上下文/i.test(node.getAttribute('aria-label')) && node.querySelector('circle'));
      const parentStyle = getComputedStyle(anchor.parentElement);
      const gap = parseFloat(parentStyle.columnGap) || 0;
      // The existing flex gap contributes to the specified six pixel separation.
      const margin = `${6 - gap}px`;
      if (entry.node.style.marginRight !== margin) entry.node.style.marginRight = margin;
      if (entry.node.nextSibling !== anchor) anchor.before(entry.node);
      if (entry.node.hidden !== native) entry.node.hidden = native;
      if (native && active === entry) hideTooltip();
      if (entry.received && Date.now() - entry.received > 16000 && entry.value.available) {
        paint(entry, { ...unknown, detail: '统计采集暂时失联，等待恢复' });
      }
    }
  }
  function schedule(records) {
    // Ignore writes to our own nodes, otherwise an observer can schedule itself forever.
    if (records && records.every(record => record.target === tooltip || tooltip.contains(record.target) ||
      record.target.closest?.(`[${MARK}]`))) return;
    if (scheduled === null) scheduled = setTimeout(() => { scheduled = null; refresh(); }, 0);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  // React props can change without a DOM attribute mutation. Recheck committed
  // identity before every delivery as well as on DOM changes and this watchdog.
  const timer = setInterval(refresh, 250);
  const escape = event => { if (event.key === 'Escape') hideTooltip(); };
  const reposition = () => { if (active) showTooltip(active); schedule(); };
  document.addEventListener('keydown', escape, true);
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);
  window[KEY] = { version: VERSION, refresh,
    bindings() { refresh(); return [...entries.values()].filter(entry => entry.binding && entry.node.isConnected && !entry.node.hidden).map(entry => ({ ...entry.binding })); },
    update(updates) {
      refresh();
      if (!Array.isArray(updates)) return;
      for (const update of updates) {
        const entry = [...entries.values()].find(entry => entry.id === update.id);
        const b = entry?.binding;
        if (!b || update.bindingVersion !== b.bindingVersion || update.host !== b.host ||
          update.threadId !== b.threadId || update.model !== b.model) continue;
        entry.received = Date.now(); paint(entry, update.value || unknown);
      }
    },
    destroy() {
      disposed = true; observer.disconnect(); clearTimeout(scheduled); clearInterval(timer); hideTooltip();
      document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
      for (const entry of entries.values()) entry.node.remove();
      entries.clear(); retiredGenerations.clear(); style.remove(); tooltip.remove(); delete window[KEY];
    }
  };
  refresh();
}
