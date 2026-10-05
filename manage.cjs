// Installation/explicit launch operations are deliberately separate from agent.cjs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { resolveCodexBin, isMainWindow } = require('./agent.cjs');
const {cleanupLegacyLauncher}=require('./macos/shortcuts.cjs');
const {acquireLock,readJson,compareVersions}=require('./updater/core.cjs');
const VERSION='0.9.4';
const home = os.homedir();
const app = process.env.CODEX_BADGE_APP || ['/Applications/Codex.app','/Applications/ChatGPT.app',path.join(home,'Applications/Codex.app'),path.join(home,'Applications/ChatGPT.app')].find(candidate => { try { resolveCodexBin(undefined,candidate); return true; } catch { return false; } }) || '/Applications/Codex.app';
const node = process.execPath;
const installDir = path.join(home, 'Library/Application Support/CodexUsageBadge');
const logs = path.join(home, 'Library/Logs');
const label = 'com.codexusagebadge.agent';
const activationLabel = 'com.codexusagebadge.activate-once';
const startupLabel='com.codexusagebadge.startup';
const updaterLabel='com.codexusagebadge.updater';
const gui = `gui/${process.getuid()}`;
const plistPath = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
const startupPlist=path.join(home,'Library/LaunchAgents',startupLabel+'.plist');
const updaterPlist=path.join(home,'Library/LaunchAgents',updaterLabel+'.plist');
const startupDir=path.join(installDir,'startup-helper');
const packagedBridge=path.join(__dirname,'macos/startup/bridge');
const bridgeSource=fs.existsSync(packagedBridge)?packagedBridge:path.join(__dirname,'.devtools/macos-startup-bridge');
const runtimeFiles={'agent.cjs':path.join(__dirname,'agent.cjs'),'manage.cjs':path.join(__dirname,'manage.cjs'),'macos/shortcuts.cjs':path.join(__dirname,'macos/shortcuts.cjs'),'startup-helper/bridge':bridgeSource,'startup-helper/controller.cjs':path.join(__dirname,'macos/startup/controller.cjs'),'startup-helper/watch.cjs':path.join(__dirname,'macos/startup/watch.cjs'),'updater/core.cjs':path.join(__dirname,'updater/core.cjs'),'updater/worker.cjs':path.join(__dirname,'updater/worker.cjs'),'updater/run.sh':path.join(__dirname,'updater/run.sh')};
const launcher = path.join(home, 'Applications/Codex 用量条.app');
const desktopLauncher = path.join(home, 'Desktop/Codex 用量条.app');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(bin, args, options = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
function xml(value) {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`;
  if (value && typeof value === 'object') return `<dict>${Object.entries(value).map(([k,v]) => `<key>${escapeXml(k)}</key>${xml(v)}`).join('')}</dict>`;
  return `<string>${escapeXml(value)}</string>`;
}
function escapeXml(value) { return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
function writePlist(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(value)}</plist>\n`, {mode:0o644});
  command('/usr/bin/plutil', ['-lint', file]);
}
function loaded(job) { try { return command('/bin/launchctl',['print',`${gui}/${job}`]); } catch { return null; } }
async function stop(job) {
  if (!loaded(job)) return;
  command('/bin/launchctl', ['bootout', `${gui}/${job}`]);
  for(let i=0;i<30;i++) { if(!loaded(job)) return; await pause(100); }
  throw new Error(`后台任务未能停止：${job}`);
}
function quoteShell(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function agentConfig() {
  return {
    Label: label, ProgramArguments: [node, path.join(installDir,'agent.cjs')],
    EnvironmentVariables: { ...(process.env.CODEX_HOME ? {CODEX_HOME:process.env.CODEX_HOME} : {}), CODEX_BADGE_APP:app, CODEX_BADGE_BIN:resolveCodexBin(undefined,app), CODEX_BADGE_PORT:'39222', CODEX_BADGE_DEBUG:'0' },
    RunAtLoad:true, KeepAlive:{SuccessfulExit:false}, ThrottleInterval:10, ProcessType:'Background',
    StandardOutPath:path.join(logs,'CodexUsageBadge.out.log'), StandardErrorPath:path.join(logs,'CodexUsageBadge.err.log')
  };
}
function activationConfig({waitForExit=false}={}) {
  return {
    Label:activationLabel, ProgramArguments:[node,path.join(installDir,'manage.cjs'),...(waitForExit?['activate-after-exit']:['activate'])],
    RunAtLoad:true, KeepAlive:false, ProcessType:'Background',
    StandardOutPath:path.join(logs,'CodexUsageBadge.activate.log'), StandardErrorPath:path.join(logs,'CodexUsageBadge.activate.err.log')
  };
}
function statOrNull(file) { try { return fs.lstatSync(file); } catch (error) { if(error.code==='ENOENT')return null; throw error; } }
function ownedLauncher() {
  const stat=statOrNull(launcher);
  if(!stat)return false;
  if(stat.isSymbolicLink()||!stat.isDirectory())return false;
  try { return command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',path.join(launcher,'Contents/Info.plist')]).trim()==='local.codexusagebadge.launcher'; }
  catch { return false; }
}
function ownedShortcut() {
  const stat=statOrNull(desktopLauncher);
  return !!stat?.isSymbolicLink()&&fs.readlinkSync(desktopLauncher)===launcher;
}
function startupConfig() {
  return {Label:startupLabel,ProgramArguments:[node,path.join(startupDir,'watch.cjs')],RunAtLoad:true,
    KeepAlive:{SuccessfulExit:false},ThrottleInterval:10,ProcessType:'Background',
    StandardOutPath:path.join(logs,'CodexUsageBadge.startup.out.log'),StandardErrorPath:path.join(logs,'CodexUsageBadge.startup.err.log')};
}
function updaterConfig(){
  return {Label:updaterLabel,ProgramArguments:['/bin/bash',path.join(installDir,'updater/run.sh'),'run'],
    EnvironmentVariables:{CODEX_BADGE_APP:app,CODEX_BADGE_NODE:node},RunAtLoad:true,StartInterval:21600,ProcessType:'Background',
    StandardOutPath:path.join(logs,'CodexUsageBadge.updater.out.log'),StandardErrorPath:path.join(logs,'CodexUsageBadge.updater.err.log')};
}
async function operation(fn){
  const unlock=acquireLock(path.join(home,'Library/Caches/CodexUsageBadge-manage.lock'));
  if(!unlock)throw Error('另一个安装、更新或卸载操作正在进行，请稍后重试');
  try{return await fn();}finally{unlock();}
}
function preflight() {
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('需要 Node.js 24 或更高版本');
  if(!fs.existsSync(bridgeSource))throw new Error('缺少 macOS 启动助手，请下载完整安装包；源码构建需运行 scripts/build_native.py');
  for(const source of Object.values(runtimeFiles)) {
    if(!fs.existsSync(source))throw new Error('安装包不完整：'+path.basename(source));
    if(source.endsWith('.cjs'))command(node,['--check',source]);
  }
  const config=path.join(startupDir,'settings.json');
  if(fs.existsSync(config)&&JSON.parse(fs.readFileSync(config,'utf8')).owner!=='codex-usage-badge-startup-v1')throw new Error('启动助手目录已被其他程序占用');
  const updateSettings=path.join(installDir,'update-settings.json');
  if(fs.existsSync(updateSettings)&&JSON.parse(fs.readFileSync(updateSettings,'utf8')).owner!=='codex-usage-badge-updater-v1')throw Error('自动更新配置已被其他程序占用');
  command(resolveCodexBin(undefined,app),['--version']);
  command(bridgeSource,['snapshot',app]);
}
function saveInstallFiles() {
  const files=[plistPath,startupPlist,updaterPlist,...Object.keys(runtimeFiles).map(file=>path.join(installDir,file)),
    ...['状态.json','installed-version.json','update-settings.json'].map(file=>path.join(installDir,file)),...['settings.json','state.json'].map(file=>path.join(startupDir,file))];
  const directories=new Set();
  for(const file of files) {
    for(let dir=path.dirname(file);dir.startsWith(installDir);dir=path.dirname(dir))if(!statOrNull(dir))directories.add(dir);
  }
  const entries=files.map(file=>{const s=statOrNull(file);if(s?.isSymbolicLink())throw new Error('安装文件不能是符号链接：'+file);return {file,mode:s?.mode,data:s?fs.readFileSync(file):null};});
  return () => {
    for(const {file,mode,data} of entries) {
      if(statOrNull(file))fs.unlinkSync(file);
      if(data!==null){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data,{mode});}
    }
    for(const dir of [...directories].sort((a,b)=>b.length-a.length)) {
      try { fs.rmdirSync(dir); } catch(error) {if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
    }
  };
}
async function install(){return operation(installUnlocked);}
async function installUnlocked() {
  if(process.argv.includes('--from-update')){
    const current=readJson(path.join(installDir,'installed-version.json'));
    if(current&&compareVersions(current.version,VERSION)>=0){console.log('已安装相同或更新版本，跳过重复更新。');return;}
    if(readJson(path.join(installDir,'update-settings.json'))?.enabled===false){console.log('自动更新已关闭，跳过更新。');return;}
  }
  preflight();
  const fromUpdate=process.argv.includes('--from-update');
  const previousJobs=[[label,plistPath],[startupLabel,startupPlist],...(!fromUpdate?[[updaterLabel,updaterPlist]]:[])].filter(([job])=>loaded(job));
  const existingUpdater=fromUpdate&&!!loaded(updaterLabel);let startedUpdater=false;
  let restore=()=>{};
  try {
    if(!fromUpdate)await stop(updaterLabel);
    for(const old of [startupLabel,'com.codexusagebadge.install-once',activationLabel,label])await stop(old);
    restore=saveInstallFiles();
    fs.mkdirSync(startupDir,{recursive:true,mode:0o700});fs.mkdirSync(logs,{recursive:true});
    for(const [name,source] of Object.entries(runtimeFiles)) {
      const target=path.join(installDir,name);fs.mkdirSync(path.dirname(target),{recursive:true});
      if(source!==target)fs.copyFileSync(source,target);
      fs.chmodSync(target,name.endsWith('/bridge')?0o700:0o600);
    }
    fs.writeFileSync(path.join(startupDir,'settings.json'),JSON.stringify({owner:'codex-usage-badge-startup-v1',app:fs.realpathSync(app)})+'\n',{mode:0o600});
    writePlist(plistPath,agentConfig());writePlist(startupPlist,startupConfig());writePlist(updaterPlist,updaterConfig());
    command('/bin/launchctl',['bootstrap',gui,plistPath]);
    const startedAt=Date.now();
    command('/bin/launchctl',['bootstrap',gui,startupPlist]);
    let ready=false;
    for(let i=0;i<40;i++) {
      await pause(200);
      try {
        const state=JSON.parse(fs.readFileSync(path.join(startupDir,'state.json'),'utf8'));
        ready=state.event==='watching'&&state.updatedAt>=startedAt&&/state = running/.test(loaded(startupLabel)||'')&&/state = running/.test(loaded(label)||'');
      } catch {}
      if(ready)break;
    }
    if(!ready)throw new Error('启动助手未能就绪');
    const settingsFile=path.join(installDir,'update-settings.json');
    if(!fs.existsSync(settingsFile))fs.writeFileSync(settingsFile,JSON.stringify({owner:'codex-usage-badge-updater-v1',enabled:true,allowPrerelease:true})+'\n',{mode:0o600});
    fs.writeFileSync(path.join(installDir,'installed-version.json'),JSON.stringify({schema:1,platform:'macOS',repository:'jaykinhoo9/codex-usage-badge',version:VERSION,app:fs.realpathSync(app),codexHome:process.env.CODEX_HOME||''})+'\n',{mode:0o600});
    // Keep an already loaded updater alive: it may be waiting for this child installer.
    if(!existingUpdater){command('/bin/launchctl',['bootstrap',gui,updaterPlist]);startedUpdater=true;}
    record({state:'installed',message:'自动加载已启用，下次从原客户端图标启动即可'});
  } catch(error) {
    let rollbackError;
    try {
      if(startedUpdater)await stop(updaterLabel);
      await stop(startupLabel);await stop(label);restore();
      for(const [,file] of previousJobs)if(fs.existsSync(file))command('/bin/launchctl',['bootstrap',gui,file]);
    }catch(failure){rollbackError=failure;}
    throw new Error(`安装失败：${error.message}。${rollbackError?`恢复旧版失败：${rollbackError.message}`:'已恢复安装前的程序文件'}`);
  }
  try {await cleanupLegacyLauncher({home,app,installDir,bridge:path.join(startupDir,'bridge'),command,ownedLauncher,ownedShortcut});}
  catch(error){console.warn('自动加载已安装；旧快捷方式需手动移除：'+error.message);}
  console.log(`已安装 v${VERSION}，默认开启自动更新。完全退出客户端后，从原来的 Codex 图标打开，等待 5–10 秒。`);
}
async function targets() {
  const response=await fetch('http://127.0.0.1:39222/json/list',{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error('本机端口暂不可连接');
  return (await response.json()).filter(t=>t.type==='page'&&isMainWindow(t)&&t.webSocketDebuggerUrl);
}
async function cdp(target,method,params) {
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  try {
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('窗口检查超时')),5000);
      ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method,params})));
      ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('窗口连接失败'));});
      ws.addEventListener('message',event=>{
        const m=JSON.parse(event.data);if(m.id!==1)return;clearTimeout(timer);
        if(m.error||m.result?.exceptionDetails)reject(new Error('窗口检查失败'));else resolve(m.result);
      });
    });
  } finally { ws.close(); }
}
async function evaluate(target,expression) {
  return (await cdp(target,'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.value;
}
function appRunning() {
  let executable=path.basename(app,'.app');
  try { executable=command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleExecutable',path.join(app,'Contents/Info.plist')]).trim(); } catch {}
  return command('/bin/ps',['-Ao','comm=']).split('\n').some(s=>s.trim()===path.join(app,'Contents/MacOS',executable));
}
function record(value) {
  fs.writeFileSync(path.join(installDir,'状态.json'),JSON.stringify({time:new Date().toISOString(),version:VERSION,...value},null,2)+'\n');
}
async function waitForExit({isRunning=appRunning,sleep=pause,now=Date.now,timeoutMs=300000}={}) {
  const deadline=now()+timeoutMs;
  for(;;) {
    if(now()>=deadline)throw new Error('等待退出已结束。稍后完全退出 Codex 后，从原应用图标打开即可。');
    if(!isRunning()) {
      await sleep(500);
      if(!isRunning())return;
    }
    await sleep(250);
  }
}
async function activateAfterExit() {
  try { if((await targets()).length) { await activate(); return; } } catch {}
  record({state:'waiting_for_exit',message:'等待完全退出 Codex；退出后将自动带正确参数打开一次',expiresAt:new Date(Date.now()+300000).toISOString()});
  console.log('等待用户完全退出客户端；不主动关闭窗口，不反复唤起。');
  await waitForExit();
  await activate();
}
async function activate({allowRestart=false,foreground=false}={}) {
  let ready=false;
  try { ready=(await targets()).length>0; } catch {}
  if(!ready&&appRunning()) {
    if(!allowRestart) {
      command('/usr/bin/osascript',['-e','display notification "请先完全退出 Codex，再从原应用图标打开。后台不会自动重启你的工作窗口。" with title "Codex 用量条"']);
      return;
    }
    record({state:'activating',message:'正在执行本次授权的一次重启'});
    command('/usr/bin/osascript',['-e','tell application id "com.openai.codex" to quit']);
    await waitForExit({timeoutMs:120000});
  }
  if(!ready) {
    const args=foreground?['-a',app]:['-g','-a',app];
    command('/usr/bin/open',[...args,'--args','--remote-debugging-address=127.0.0.1','--remote-debugging-port=39222']);
  } else if(foreground) {
    command('/usr/bin/open',['-a',app]); // Only a user's explicit launcher click may focus the app.
  }
  let uiWasShown=false;
  for(let attempt=0;attempt<45;attempt++) {
    try {
      const pages=await targets();
      const results=await Promise.all(pages.map(async t=>({target:t,status:await evaluate(t,'window.__codexUsageBadge?.status() ?? null'),colors:await evaluate(t,'window.__codexProjectColors?.status() ?? null'),tokens:await evaluate(t,'window.__codexThreadTokens?.status() ?? null'),sizes:await evaluate(t,'window.__codexProjectSizes?.status() ?? null')})));
      const shown=results.filter(r=>r.status?.placed&&r.status.badgeCount===1&&r.status.version===46&&!r.status.stale&&Number.isFinite(r.status.updatedAt)&&Date.now()-r.status.updatedAt<150000&&r.colors?.version===2&&r.tokens?.version===7&&r.sizes?.version===2);
      if(shown.length&&/state = running/.test(loaded(label)||'')) {
        uiWasShown=true;
        const target=shown[0].target;
        const current=await evaluate(target,'window.__codexUsageBadge.status()');
        const readings=current.mode==='dual' ? current.rings ?? [] : [{label:current.windowLabel,percent:current.percent}];
        if(!readings.some(r=>Number.isFinite(r.percent))) {
          record({state:'ui_ready_waiting_for_usage',message:'侧栏已显示，正在等待实际额度读数'});
          await pause(2000);
          continue;
        }
        const {version:uiVersion,...uiStatus}=current;
        record({state:'ready',message:'侧栏额度、文件夹颜色、容量和会话 Token 显示已启用',windows:shown.length,uiVersion,...uiStatus,projectColors:shown[0].colors,threadTokens:shown[0].tokens,projectSizes:shown[0].sizes});
        console.log(`安装成功：侧栏进度条已显示，${readings.map(r=>`${r.label} ${Number.isFinite(r.percent)?`剩余 ${r.percent}%`:'暂不可用'}`).join('，')}。`);
        return;
      }
    } catch {}
    await pause(2000);
  }
  throw new Error(uiWasShown?'侧栏已显示，但暂时无法读取额度，请运行诊断.command 查看读取错误':'客户端已启动，但暂未确认侧栏进度条显示，请运行诊断.command');
}
async function scheduleActivation(options={}) {
  await stop('com.codexusagebadge.install-once');
  await stop(activationLabel);
  const file=path.join(installDir,'activate-once.plist');
  writePlist(file,activationConfig(options));
  command('/bin/launchctl',['bootstrap',gui,file]);
  console.log('单次启用任务已提交，KeepAlive=false；退出后不会重复运行。');
}
async function cleanupUi() {
  let pages=[];try{pages=await targets();}catch{return;}
  const results=await Promise.allSettled(pages.map(page=>evaluate(page,'(() => {window.__codexUsageBadge?.destroy?.();window.__codexProjectColors?.destroy?.({clearStorage:true});window.__codexThreadTokens?.destroy?.();window.__codexProjectSizes?.destroy?.();window.__codexThreadMetrics?.destroy?.({clearStorage:true});window.__codexThreadPerformance?.destroy?.();window.__codexThreadMetricsAccount?.destroy?.();return !document.getElementById("codex-usage-badge")&&!document.getElementById("codex-project-colors-style")&&!document.getElementById("codex-thread-tokens-style")&&!document.getElementById("codex-project-sizes-style")&&!window.__codexThreadMetrics&&!window.__codexThreadPerformance&&!window.__codexThreadMetricsAccount;})()')));
  if(results.some(r=>r.status==='rejected'||r.value!==true))console.warn('部分窗口暂不可连接；后台仍会卸载，残留界面将在下次打开客户端时消失。');
}
async function uninstall(){return operation(uninstallUnlocked);}
async function uninstallUnlocked() {
  for(const job of [updaterLabel,startupLabel,'com.codexusagebadge.install-once',activationLabel,label])await stop(job);
  await cleanupUi();
  const trash=path.join(home,'.Trash',`CodexUsageBadge-${Date.now()}`);fs.mkdirSync(trash,{recursive:true});
  const paths=[updaterPlist,startupPlist,plistPath,...(ownedShortcut()?[desktopLauncher]:[]),...(ownedLauncher()?[launcher]:[]),installDir,...['out.log','err.log','activate.log','activate.err.log','startup.out.log','startup.err.log','updater.out.log','updater.err.log'].map(s=>path.join(logs,`CodexUsageBadge.${s}`))];
  for(const file of paths) {
    try{fs.lstatSync(file);}catch{continue;}
    let dest=path.join(trash,path.basename(file));if(statOrNull(dest))dest+='-shortcut';
    fs.renameSync(file,dest);
  }
  console.log('已卸载并清除界面，无需重启。文件已移入废纸篓。');
}
async function status() {
  console.log('版本：'+VERSION);
  console.log('自动加载：'+(/state = running/.test(loaded(startupLabel)||'')?'运行中':'未运行'));
  console.log('后台：'+(/state = running/.test(loaded(label)||'')?'运行中':'未运行'));
  console.log('自动更新任务：'+(loaded(updaterLabel)?'已注册':'未注册'));
  try{console.log(command(node,[path.join(installDir,'updater/worker.cjs'),'status']));}catch{}
  let pages=[];try{pages=await targets();}catch{}
  console.log('主窗口连接数：'+pages.length);
  for(let i=0;i<pages.length;i++)console.log('窗口 '+(i+1),await evaluate(pages[i],'({usage:window.__codexUsageBadge?.status()??null,projectColors:window.__codexProjectColors?.status()??null,threadTokens:window.__codexThreadTokens?.status()??null,projectSizes:window.__codexProjectSizes?.status()??null})'));
  const receipt=path.join(installDir,'状态.json');if(fs.existsSync(receipt))console.log('上次安装验证记录（历史数据，以以上实时读数为准）：\n'+fs.readFileSync(receipt,'utf8'));
}
module.exports={startupConfig,updaterConfig,agentConfig,activationConfig,waitForExit,xml,install,uninstall,preflight};
if(require.main===module)(async()=>{
  const action=process.argv[2];
  if(action==='install')await install();
  else if(action==='schedule-activation')await scheduleActivation({waitForExit:process.argv.includes('--wait-for-exit')});
  else if(action==='activate'){await pause(3000);await activate({allowRestart:process.argv.includes('--allow-restart')});}
  else if(action==='activate-after-exit')await activateAfterExit();
  else if(action==='launch')await activate({foreground:true});
  else if(action==='uninstall')await uninstall();
  else if(action==='status')await status();
  else if(action==='update-check')console.log(command(node,[path.join(installDir,'updater/worker.cjs'),'check'],{timeout:30000}));
  else if(action==='update-disable')console.log(command(node,[path.join(installDir,'updater/worker.cjs'),'disable']));
  else if(action==='update-enable')console.log(command(node,[path.join(installDir,'updater/worker.cjs'),'enable']));
  else throw new Error('未知操作：'+action);
})().catch(error=>{
  console.error(error.message);
  if(process.argv[2]?.startsWith('activate')&&fs.existsSync(installDir))record({state:'error',message:error.message});
  process.exitCode=1;
});
