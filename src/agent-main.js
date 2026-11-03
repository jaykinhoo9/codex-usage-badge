var AGENT_VERSION = '0.9.4';
function parseArgs(argv) {
  const options = {
    port: Number(process.env.CODEX_BADGE_PORT) || 39222,
    appPath: process.env.CODEX_BADGE_APP || (process.platform === 'win32' ? '' : '/Applications/ChatGPT.app'),
    codexBin: process.env.CODEX_BADGE_BIN || 'codex',
    pollMs: Number(process.env.CODEX_BADGE_POLL_MS) || 60000,
    debug: process.env.CODEX_BADGE_DEBUG === '1'
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--debug') options.debug = true;
    else if (argv[i] === '--port') options.port = Number(argv[++i]);
    else if (argv[i] === '--app') options.appPath = argv[++i];
    else if (argv[i] === '--codex-bin') options.codexBin = argv[++i];
    else if (argv[i] === '--poll-ms') options.pollMs = Math.max(1000, Number(argv[++i]));
  }
  return options;
}
function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`);
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.codexBin = resolveCodexBin(options.codexBin, options.appPath);
  log(`codex-usage-badge v${AGENT_VERSION} 启动：仅连接本机端口 ${options.port}，不启动、不退出、不激活客户端。`);
  const injector = new RendererInjector({ port: options.port, debug: options.debug, scanIntervalMs: 5000 });
  const tokenReader = new ThreadTokenReader();
  const contextReader = new ContextWindowReader();
  const projectSizeScanner = new ProjectSizeScanner();
  let stopped = false;
  let client = null;
  let pending = false;
  let nextRead = 0;
  let failures = 0;
  let connected = false;
  let refreshingProjectSizes = false;
  injector.currentValue = { percent: null, title: '正在读取 Codex 剩余用量', tone: 'muted', windowLabel: '' };
  // A missing port is an idle state, never a reason to restart or focus the app.
  const scan = async () => {
    if (stopped) return;
    try {
      await injector.scan();
      if (!connected && injector.sessions.size > 0) log('主窗口连接正常，进度条已注入。');
      connected = injector.sessions.size > 0;
    } catch {
      if (connected) log('主窗口暂不可连接，静默等待。');
      connected = false;
      // Drop sessions from a previous app instance without launching anything.
      for (const session of injector.sessions.values()) session.close();
      injector.sessions.clear();
    }
    if (injector.sessions.size === 0) {
      const old = client; client = null; old?.stop();
      nextRead = 0;
      injector.currentValue = unavailableValue(injector.currentValue);
    }
  };
  async function readUsage() {
    if (stopped || pending || Date.now() < nextRead || injector.sessions.size === 0) return;
    pending = true;
    try {
      if (!client) {
        options.codexBin = resolveCodexBin(options.codexBin, options.appPath);
        const current = new AppServerClient({ command: options.codexBin, debug: false });
        client = current;
        current.on('rate-limits', data => {
          if (client !== current || stopped) return;
          try {
            injector.update({ ...formatRateLimits(data), updatedAt: Date.now(), stale: false }).catch(() => {});
          } catch {
            injector.update(unavailableValue(injector.currentValue)).catch(() => {});
          }
        });
        current.on('server-exit', () => {
          if (client === current) {
            client = null; nextRead = Date.now() + 10000;
            injector.update(unavailableValue(injector.currentValue)).catch(() => {});
          }
        });
        await current.start();
        if (stopped) current.stop();
      } else {
        await client.refresh();
      }
      failures = 0;
      if (client) nextRead = Date.now() + options.pollMs;
    } catch (error) {
      const old = client;
      client = null;
      old?.stop();
      failures++;
      nextRead = Date.now() + Math.min(60000, 10000 * failures);
      if (failures === 1 || failures % 10 === 0) log(`用量暂不可用：${error.message}`);
      await injector.update(unavailableValue(injector.currentValue));
    } finally { pending = false; }
  }
  const updateProjectSizes = async () => {
    if (stopped || refreshingProjectSizes || injector.sessions.size === 0) return;
    refreshingProjectSizes = true;
    try { await refreshProjectSizes(injector, projectSizeScanner); }
    finally { refreshingProjectSizes = false; }
  };
  projectSizeScanner.onChange = () => { updateProjectSizes().catch(() => {}); };
  const tick = async () => {
    await scan();
    // Quota requests can wait on the network; pending prevents overlap without delaying local reads.
    readUsage().catch(error => { if (!stopped) log(`额度刷新暂不可用：${error.message}`); });
    await Promise.all([refreshThreadTokens(injector, tokenReader), refreshContextWindows(injector, contextReader)]);
    await updateProjectSizes();
  };
  let ticking = false;
  const guardedTick = async () => {
    if (ticking || stopped) return;
    ticking = true;
    try { await tick(); } catch (error) { log(`连接暂不可用：${error.message}`); }
    finally { ticking = false; }
  };
  const timer = setInterval(guardedTick, 5000);
  let stopTimer = null;
  const shutdown = () => {
    stopped = true;
    clearInterval(timer);
    if (stopTimer) clearInterval(stopTimer);
    const old = client; client = null; old?.stop();
    projectSizeScanner.stop();
    injector.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // The Windows supervisor requests a graceful stop without killing unrelated node.exe processes.
  if (process.platform === 'win32' && process.env.CODEX_BADGE_STOP_FILE) {
    stopTimer = setInterval(() => {
      if (require('node:fs').existsSync(process.env.CODEX_BADGE_STOP_FILE)) shutdown();
    }, 500);
  }
  await guardedTick();
}
module.exports = { installUsageBadge, installProjectColors, installProjectSizes, installThreadTokens, ThreadTokenReader, refreshThreadTokens,
  installContextWindowIndicator, resolveComposerBinding, formatContextSnapshot, ContextWindowReader, refreshContextWindows,
  ProjectSizeScanner, measureDirectory, measureDirectoryPortable, measureProjectRoots, refreshProjectSizes,
  buildBootstrapScript, formatRateLimits, mergeRateLimitsResponse, isMainWindow, resolveCodexBin, AppServerClient, main };
if (require.main === module) main().catch(error => { log(`agent 启动失败：${error.message}`); process.exitCode = 1; });
