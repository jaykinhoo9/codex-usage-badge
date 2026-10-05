const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {resolveCodexBin,AppServerClient} = require('../agent.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'badge-win-中文 空格-'));
const local = process.env.LOCALAPPDATA;
function executable(file) { fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture',{mode:0o755}); }
try {
  process.env.LOCALAPPDATA=path.join(temp,'Local AppData');
  const gui=path.join(temp,'Programs/Codex/Codex.exe');
  const bundled=path.join(path.dirname(gui),'resources/codex.exe');
  const managed=path.join(process.env.LOCALAPPDATA,'OpenAI/Codex/bin');
  assert.throws(()=>resolveCodexBin(null,gui,'win32'));
  executable(bundled);
  assert.equal(resolveCodexBin(null,gui,'win32'),bundled);
  const old=path.join(managed,'old/codex.exe'),fresh=path.join(managed,'new/codex.exe');
  executable(old);executable(fresh);fs.utimesSync(old,1,1);fs.utimesSync(fresh,2,2);
  assert.equal(resolveCodexBin('stale.exe',gui,'win32'),fresh);
  executable(path.join(managed,'codex.exe'));
  assert.equal(resolveCodexBin(null,gui,'win32'),path.join(managed,'codex.exe'));
  assert.equal(resolveCodexBin(bundled,gui,'win32'),bundled);
  console.log('PASS Windows CLI lookup: bundled resources, Store managed cache, versioned paths, explicit override, spaces and Unicode');
} finally { if(local===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=local;fs.rmSync(temp,{recursive:true,force:true}); }

(async()=>{
  const timers=[],cleared=[],hooks={},noop=()=>{};let stopped=0,exited=null,exists=false;
  const sandbox={
    process:{platform:'win32',env:{CODEX_BADGE_STOP_FILE:'C:/Local AppData/stop.request'},argv:[],stdout:{write:noop},once:(k,v)=>hooks[k]=v,exit:code=>exited=code},
    module:{exports:{}},require:Object.assign(name=>{assert.equal(name,'node:fs');return {existsSync:file=>{assert.equal(file,'C:/Local AppData/stop.request');return exists;}};},{main:{}}),
    Date,setInterval:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearInterval:id=>cleared.push(id),
    RendererInjector:class {constructor(){this.sessions=new Map();}async scan(){} stop(){stopped++;}},
    AppServerClient:class{},ThreadTokenReader:class{},refreshThreadTokens:async()=>{},resolveCodexBin:()=> 'fixture',
    ThreadMetricsReader:class{},installThreadMetrics:noop,
    createThreadPerformanceTracker:noop,installThreadPerformanceMonitor:noop,
    installThreadMetricsAccountScope:noop,
    ThreadMetricsStore:class{stop(){}},
    unavailableValue:v=>v,installUsageBadge:noop,installProjectColors:noop,installThreadTokens:noop,installProjectSizes:noop,ProjectSizeScanner:class{stop(){}},refreshProjectSizes:noop,measureDirectory:noop,measureDirectoryPortable:noop,measureProjectRoots:noop,
    buildBootstrapScript:noop,formatRateLimits:noop,mergeRateLimitsResponse:noop,isMainWindow:noop
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/agent-main.js'),'utf8'),sandbox);
  await sandbox.module.exports.main();
  assert.deepEqual(timers.map(t=>t.ms),[5000,200,500]);
  timers[2].fn();assert.equal(stopped,0);assert.equal(exited,null);
  exists=true;timers[2].fn();assert.equal(stopped,1);assert.equal(exited,0);assert.deepEqual(cleared,[1,2,3]);
  assert.match(AppServerClient.toString(),/windowsHide: true/);
  console.log('PASS Windows graceful stop file closes injector and clears timers; CLI spawn hides console');
})().catch(error=>{console.error(error);process.exitCode=1;});
