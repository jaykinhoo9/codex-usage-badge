const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {chromium}=require('playwright');
const api=require('../agent.cjs');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,args:['--remote-debugging-port=39444']});
  try {
    const context=await browser.newContext();
    await context.route('http://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:'<html><body><input id="editor"></body></html>'}));
    const pages=await Promise.all([context.newPage(),context.newPage()]);
    for(const [i,page]of pages.entries()){
      await page.goto(`http://fixture.test/window-${i}`);
      await page.evaluate(api.buildBootstrapScript());
      await page.evaluate(()=>{localStorage.setItem('codex-usage-badge.project-color.v1:project:test','red');localStorage.setItem('unrelated-setting','keep');document.querySelector('#editor').focus();});
    }
    const targets=(await(await fetch('http://127.0.0.1:39444/json/list')).json()).filter(t=>t.type==='page').map(t=>({...t,url:'app://-/index.html',webSocketDebuggerUrl:t.webSocketDebuggerUrl.replace(':39444',':39222')}));
    const output=[];
    const sandbox={module:{exports:{}},require:Object.assign(()=>api,{main:{}}),URL,AbortSignal,setTimeout,clearTimeout,
      console:{log:s=>output.push(JSON.parse(s))},
      fetch:async url=>{assert.equal(url,'http://127.0.0.1:39222/json/list');return {ok:true,json:async()=>[...targets,{url:'https://unrelated.test'},{url:'app://-/index.html?overlay=1'}]};},
      WebSocket:class{constructor(url){return new WebSocket(String(url).replace(':39222',':39444'));}}
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../windows/bridge.cjs'),'utf8'),sandbox);
    const {main,evaluate}=sandbox.module.exports;
    for(const ws of ['ws://example.com:39222/test','ws://127.0.0.1:9999/test','wss://127.0.0.1:39222/test'])await assert.rejects(evaluate({webSocketDebuggerUrl:ws},'1'),/非本机/);
    await main('status');
    assert.equal(output[0].windows.length,2);
    for(const item of output[0].windows)assert.deepEqual(JSON.parse(item),{quota:true,folderColors:true,threadTokens:true});
    await main('cleanup');
    assert.deepEqual(output[1].windows,[true,true]);
    for(const page of pages){
      assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('codex-usage-badge.'))),false);
      assert.equal(await page.evaluate(()=>localStorage.getItem('unrelated-setting')),'keep');
      assert.equal(await page.locator('#editor').evaluate(el=>el===document.activeElement),true);
      assert.equal(await page.evaluate(()=>!!window.__codexThreadMetrics||!!window.__codexThreadPerformance||!!window.__codexThreadMetricsAccount),false,'cleanup must remove the metrics UI and its passive native listeners');
    }
    await main('cleanup'); // repeated cleanup is safe
    await assert.rejects(main('invalid-action'),/用法/);
    console.log('PASS Windows bridge over real isolated Chromium CDP: multiwindow status/cleanup, preserve unrelated storage/focus, repeated cleanup, reject external endpoints and overlays');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
