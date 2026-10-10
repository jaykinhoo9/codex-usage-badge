'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { installThreadTokens } = require('./ui.cjs');
const ROOT = __dirname;
const LOCK = path.join(ROOT, '.remote-token.lock');
const STOP = path.join(ROOT, '.remote-token.stop');
const STATUS = path.join(ROOT, '.remote-token.status.json');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const CDP_PORT = 39222;

function normalizeConfig(value) {
  const config = { ...value };
  if (!/^(?!-)[a-z0-9_.-]+$/i.test(config.sshHost || '') || !/^(?!-)[a-z0-9_.-]+$/i.test(config.sshUser || '')) throw Error('SSH host/user is invalid.');
  for (const key of ['sshPort', 'localPort', 'remotePort']) {
    if (!Number.isInteger(config[key]) || config[key] < (key === 'sshPort' ? 1 : 1024) || config[key] > 65535) throw Error('Invalid port configuration.');
  }
  if (config.localPort === CDP_PORT) throw Error('Token tunnel must use a different port from Codex.');
  if (!Array.isArray(config.hostIds) || !config.hostIds.length || config.hostIds.some(x => typeof x !== 'string' || !x || x === 'local')) throw Error('An explicit remote host ID is required.');
  for (const key of ['readerPath', 'codexHome']) {
    if (key === 'codexHome' && config[key] == null) continue;
    if (typeof config[key] !== 'string' || !/^(\/|~\/)/.test(config[key]) || /[\r\n\0]/.test(config[key])) throw Error('Invalid remote path.');
  }
  config.refreshMs = Math.max(3000, Math.min(10000, config.refreshMs || 5000));
  return config;
}

function resolveSshTarget(config, home = os.homedir(), inspect = spawnSync) {
  // ssh -G resolves Includes, Host aliases and ports without connecting or reading private keys.
  const candidates = [config.sshHost];
  try {
    const text = fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*Host\s+([^#]+)/i.exec(line);
      if (!match) continue;
      for (const alias of match[1].trim().split(/\s+/)) if (config.expectedHostName && /^(?!-)[a-z0-9_.-]+$/i.test(alias)) candidates.push(alias);
    }
  } catch {}
  candidates.push(config.expectedHostName);
  for (const candidate of [...new Set(candidates)].filter(Boolean)) {
    if (!/^(?!-)[a-z0-9_.-]+$/i.test(candidate)) continue;
    const result = inspect('ssh.exe', ['-G', ...(config.sshUser ? ['-l', config.sshUser] : []), candidate], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (result.status !== 0 || typeof result.stdout !== 'string') continue;
    const settings = Object.create(null);
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^(hostname|user|port)\s+(.+)$/i.exec(line);
      if (match) settings[match[1].toLowerCase()] = match[2].trim();
    }
    if (config.expectedHostName && settings.hostname !== config.expectedHostName) continue;
    if (config.sshUser && settings.user !== config.sshUser) continue;
    if (!/^(?!-)[a-z0-9_.-]+$/i.test(settings.user || '')) continue;
    const port = config.sshPort == null ? Number(settings.port) : config.sshPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    return { ...config, sshHost: candidate, sshUser: config.sshUser || settings.user, sshPort: port };
  }
  throw Error('未找到指向目标服务器的 Windows SSH 配置。请检查 .ssh/config 的 Host 别名。');
}

function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\"'\"'") + "'"; }
function batchSshOptions() {
  // Never wait invisibly for a password or a host-key confirmation.
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1'];
}

function sshProbeArguments(config) {
  return ['-T', '-p', String(config.sshPort), ...batchSshOptions(), `${config.sshUser}@${config.sshHost}`, 'exit 0'];
}

function sshArguments(config, token, background = false) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid session token.');
  // Expand ~ in Python, never through shell interpolation of a user-supplied path.
  const bootstrap = 'import os,runpy,sys;sys.argv[0]=os.path.expanduser(sys.argv.pop(1));runpy.run_path(sys.argv[0],run_name="__main__")';
  const remoteCommand = ['python3', '-u', '-c', bootstrap, config.readerPath,
    ...(config.codexHome ? ['--home', config.codexHome] : []), '--port', String(config.remotePort), '--token', token].map(shellQuote).join(' ');
  return ['-T', '-p', String(config.sshPort), ...(background ? batchSshOptions() : []), '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${config.localPort}:127.0.0.1:${config.remotePort}`, `${config.sshUser}@${config.sshHost}`, remoteCommand];
}

function launchSsh(config, token, background = false, launch = spawn) {
  const child = launch('ssh.exe', sshArguments(config, token, background), {
    stdio: background ? ['pipe', 'ignore', 'pipe'] : 'inherit', windowsHide: background
  });
  if (background) {
    // Keep stdin open: the remote reader shuts down on EOF. Drain stderr without
    // saving it, since diagnostics from external programs can contain arguments.
    child.stdin?.on('error', () => {});
    child.stderr?.resume();
  }
  return child;
}

function writeStatus(state, running, file = STATUS) {
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, running, state, updatedAt: Date.now() }));
    fs.renameSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch {} }
}

function readStatus(root = ROOT, alive = pid => process.kill(pid, 0)) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, '.remote-token.lock'), 'utf8'));
    if (!Number.isSafeInteger(lock.pid) || lock.pid < 1) return { running: false, state: 'stopped' };
    alive(lock.pid);
    let state = 'starting';
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(root, '.remote-token.status.json'), 'utf8'));
      if (saved.pid === lock.pid && typeof saved.state === 'string') state = saved.state;
    } catch {}
    return { running: true, state };
  } catch { return { running: false, state: 'stopped' }; }
}

function collectRows(hostIds) {
  const allowed = new Set(hostIds), remoteIds = new Set(), localIds = new Set(), remoteHosts = new Set();
  const api = window.__codexThreadTokens;
  for (const row of document.querySelectorAll('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id]')) {
    const key = row.getAttribute('data-app-action-sidebar-thread-id') || '';
    const host = row.getAttribute('data-app-action-sidebar-thread-host-id');
    const kind = row.getAttribute('data-app-action-sidebar-thread-kind');
    const match = /^local:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(key);
    if (!match || kind !== 'local') continue;
    if (host === 'local') localIds.add(match[1]);
    else { remoteHosts.add(host); if (allowed.has(host)) remoteIds.add(match[1]); }
  }
  return { baseVersion: api?.version ?? null, installed: api?.remoteSupport === 1,
    ids: [...remoteIds].slice(0, 2000), localIds: [...localIds].slice(0, 2000), remoteHosts: [...remoteHosts] };
}

function installExpression(hostIds) {
  return `(() => {
    const api = window.__codexThreadTokens;
    if (!api || api.version !== 8 || typeof api.localSnapshot !== 'function') return false;
    if (api.remoteSupport !== 1)
      (${installThreadTokens.toString()})({remoteHosts: ${JSON.stringify(hostIds)}, initialLocal: api.localSnapshot()});
    window.__codexThreadTokens.keepAlive();
    return true;
  })()`;
}

function safeEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== String(CDP_PORT)) throw Error('Refusing a nonlocal Codex debugging endpoint.');
  return url.href;
}

class Session {
  constructor(endpoint) { this.endpoint = safeEndpoint(endpoint); this.pending = new Map(); this.serial = 0; this.socket = null; }
  async connect() {
    const socket = this.socket = new WebSocket(this.endpoint);
    socket.addEventListener('message', event => {
      let value; try { value = JSON.parse(event.data); } catch { return; }
      const request = this.pending.get(value.id); if (!request) return;
      this.pending.delete(value.id); clearTimeout(request.timer);
      if (value.error || value.result?.exceptionDetails) request.reject(Error('Codex UI request failed.'));
      else request.resolve(value.result?.result?.value);
    });
    const lost = () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Codex window disconnected.')); } this.pending.clear(); };
    socket.addEventListener('close', lost); socket.addEventListener('error', lost);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(Error('Codex connection timed out.')); }, 3000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(Error('Codex connection unavailable.')); }, { once: true });
    });
  }
  evaluate(expression) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(Error('Codex window disconnected.'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Codex UI timed out.')); }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() { this.socket?.close(); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Connection closed.')); } this.pending.clear(); }
}


async function readRemote(config, token, ids, fetcher = fetch) {
  const requested = [...new Set(ids)].filter(x => typeof x === 'string' && UUID.test(x)).slice(0, 2000);
  const response = await fetcher(`http://127.0.0.1:${config.localPort}/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ ids: requested }), signal: AbortSignal.timeout(3000), redirect: 'error'
  });
  if (!response.ok) throw Error('Remote Token reader unavailable.');
  const text = await response.text(); if (text.length > 250000) throw Error('Remote Token response too large.');
  const value = JSON.parse(text), totals = Object.create(null);
  if (!value || typeof value !== 'object' || !value.totals || typeof value.totals !== 'object') throw Error('Invalid remote Token response.');
  for (const id of requested) if (Object.hasOwn(value.totals, id) && Number.isSafeInteger(value.totals[id]) && value.totals[id] >= 0) totals[id] = value.totals[id];
  return { ok: value.ok === true, totals, checkedAt: Date.now() };
}

async function discoverHosts() {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  if (!response.ok) throw Error('请先打开 Codex 和原版插件。');
  const hosts = new Set();
  for (const target of await response.json()) {
    try {
      const url = new URL(target.url);
      if (target.type !== 'page' || url.protocol !== 'app:' || url.hostname !== '-' || url.pathname !== '/index.html' || /overlay/i.test(url.search + url.hash)) continue;
    } catch { continue; }
    const session = new Session(target.webSocketDebuggerUrl);
    try {
      await session.connect();
      const values = await session.evaluate(`(() => [...new Set([...document.querySelectorAll('[data-app-action-sidebar-thread-host-id]')]
        .map(row => row.getAttribute('data-app-action-sidebar-thread-host-id')).filter(host => host && host !== 'local'))])()`);
      if (Array.isArray(values)) for (const host of values) if (typeof host === 'string') hosts.add(host);
    } finally { session.close(); }
  }
  return [...hosts];
}

async function main(background = false) {
  if (process.platform !== 'win32') throw Error('This launcher is for Windows. The Linux reader is remote_reader.py.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24+ is required.');
  const config = normalizeConfig(resolveSshTarget(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))));
  try {
    if (fs.existsSync(LOCK)) {
      const old = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      try { process.kill(old.pid, 0); throw Error('ALREADY_RUNNING'); }
      catch (error) { if (error.message === 'ALREADY_RUNNING' || error.code !== 'ESRCH') throw Error('An extension instance is already running. Use Stop.cmd first.'); }
      fs.unlinkSync(LOCK);
    }
    const handle = fs.openSync(LOCK, 'wx', 0o600);
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid })); fs.closeSync(handle);
  } catch (error) { throw error; }
  fs.rmSync(STOP, { force: true });
  let stopped = false, active = false, ssh = null, timer = null, stopTimer = null;
  const sessions = new Map();
  let lastState = '';
  const report = (text, state) => { if (text !== lastState) { console.log(text); lastState = text; } if (state) writeStatus(state, true); };
  writeStatus('starting', true);
  const shutdown = async code => {
    if (stopped) return; stopped = true;
    clearInterval(timer); clearInterval(stopTimer);
    writeStatus('stopping', true);
    // Terminate only the SSH child created by this extension, never Codex or other SSH sessions.
    ssh?.kill();
    await Promise.allSettled([...sessions.values()].map(s => s.evaluate('window.__codexThreadTokens?.restoreLocal?.()')));
    for (const s of sessions.values()) s.close();
    try { fs.unlinkSync(LOCK); } catch {}
    fs.rmSync(STOP, { force: true });
    console.log('远程扩展已停止；原版额度圆环和本地统计继续运行。');
    writeStatus(code === 0 ? 'stopped' : 'ssh_ended', false);
    process.exitCode = code;
  };
  process.once('SIGINT', () => shutdown(0)); process.once('SIGTERM', () => shutdown(0));
  process.once('SIGHUP', () => shutdown(0));
  const token = crypto.randomBytes(32).toString('hex');
  console.log('远程 Token 扩展：仅查询会话 ID 和累计数值。');
  console.log(`沿用 SSH 配置：${config.sshHost}，端口 ${config.sshPort}。`);
  console.log(background ? '远程扩展在后台运行；Status.cmd 查看状态，Stop.cmd 停止。' : '如 SSH 提示密码/密钥密码，请在此窗口输入。窗口可最小化；Stop.cmd 可关闭扩展。');
  ssh = launchSsh(config, token, background);
  ssh.once('error', () => { report('未能启动 Windows SSH。请确认 ssh 命令可用。'); shutdown(1); });
  ssh.once('exit', code => { if (!stopped) { report('SSH 连接已结束。可重新运行 Start.cmd。'); shutdown(code === 0 ? 0 : 1); } });
  async function tick() {
    if (active || stopped) return; active = true;
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (!response.ok) throw Error('Codex debug endpoint unavailable.');
      const targets = (await response.json()).filter(t => {
        try { const u = new URL(t.url); return t.type === 'page' && u.protocol === 'app:' && u.hostname === '-' && u.pathname === '/index.html' && !/overlay/i.test(decodeURIComponent(u.search + u.hash)); } catch { return false; }
      });
      const live = new Set(targets.map(t => t.id));
      for (const [id, session] of sessions) if (!live.has(id)) { session.close(); sessions.delete(id); }
      const views = await Promise.all(targets.map(async target => {
        let session = sessions.get(target.id);
        try {
          if (!session) { session = new Session(target.webSocketDebuggerUrl); await session.connect(); sessions.set(target.id, session); }
          const rows = await session.evaluate(`(${collectRows.toString()})(${JSON.stringify(config.hostIds)})`);
          if (rows?.baseVersion !== 8) { report('等待原版 Token 组件加载（需要包含 SSH 支持的组件版本 8）。', 'waiting_plugin'); return null; }
          if (!rows.ids.length && !rows.installed) {
            if (rows.remoteHosts.length) report('发现未匹配的远程主机。请将 config.json 的 hostIds 与此处对应：' + rows.remoteHosts.join(', '), 'host_mismatch');
            else report('等待远程会话出现在侧边栏。', 'waiting_threads');
            return null;
          }
          if (!rows.installed) await session.evaluate(installExpression(config.hostIds));
          else await session.evaluate('window.__codexThreadTokens.keepAlive?.()');
          return { session, ids: rows.ids };
        } catch { session?.close(); sessions.delete(target.id); return null; }
      }));
      if (stopped) return;
      const ready = views.filter(Boolean), ids = [...new Set(ready.flatMap(v => v.ids))].slice(0, 2000);
      if (!ready.length) return;
      let snapshot;
      try {
        snapshot = await readRemote(config, token, ids);
        report(snapshot.ok ? `已连接：远程 Token 每 5 秒刷新。${background ? '扩展正在后台运行。' : '窗口可最小化。'}` : '远程数据库暂不可读取；保持原版插件运行并重试。', snapshot.ok ? 'connected' : 'database_unavailable');
      }
      catch { snapshot = { ok: false, totals: {}, checkedAt: Date.now() }; report('等待 SSH 登录或远程连接恢复。', 'waiting_ssh'); }
      await Promise.allSettled(ready.map(({ session, ids: requested }) => {
        const totals = Object.fromEntries(requested.filter(id => Object.hasOwn(snapshot.totals, id)).map(id => [id, snapshot.totals[id]]));
        return session.evaluate(`window.__codexThreadTokens.updateRemote?.(${JSON.stringify({ ...snapshot, totals })})`);
      }));
    } catch { if (!stopped) report('等待 Codex 和原版插件的本机连接（无需关闭现有聊天）。', 'waiting_cdp'); }
    finally { active = false; }
  }
  timer = setInterval(tick, config.refreshMs);
  stopTimer = setInterval(() => { if (fs.existsSync(STOP)) shutdown(0); }, 500);
  await tick();
}

module.exports = { normalizeConfig, resolveSshTarget, shellQuote, sshArguments, sshProbeArguments, launchSsh, writeStatus, readStatus, collectRows, installExpression, safeEndpoint, readRemote, Session };
if (require.main === module) {
  if (process.argv.includes('--hosts')) {
    discoverHosts().then(hosts => console.log(JSON.stringify(hosts))).catch(() => { console.error('请先打开 Codex、连接服务器并启动原版插件。'); process.exitCode = 1; });
  } else if (process.argv.includes('--check-ssh')) {
    try {
      const config = normalizeConfig(resolveSshTarget(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))));
      const result = spawnSync('ssh.exe', sshProbeArguments(config), { stdio: 'ignore', timeout: 15000, windowsHide: true });
      process.exitCode = result.status === 0 ? 0 : 1;
    } catch { process.exitCode = 1; }
  } else if (process.argv.includes('--status')) {
    console.log(JSON.stringify(readStatus()));
  } else if (process.argv.includes('--stop')) {
    if (fs.existsSync(LOCK)) { fs.writeFileSync(STOP, 'stop\n', { mode: 0o600 }); console.log('已请求停止独立扩展。'); }
    else console.log('扩展未运行。');
  } else main(process.argv.includes('--background')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
