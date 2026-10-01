const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { buildBootstrapScript, formatRateLimits, isMainWindow } = require('../agent.cjs');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(),'badge-regression-'));
const macManager = process.platform === 'darwin' ? require('../manage.cjs') : null;
const fixture = `<!doctype html><html class="dark" data-theme="dark"><meta charset="UTF-8"><style>
*{box-sizing:border-box}body{margin:0;background:#222;color:#ececec;font:14px -apple-system,sans-serif;display:flex;height:100vh}
nav{width:52px;flex:0 0 52px;display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px;background:#292a2a}
.items{flex:1;min-height:0;overflow:auto;width:36px;display:flex;flex-direction:column;gap:10px;align-items:center}
button{width:32px;height:32px;flex:0 0 32px;background:transparent;color:inherit;border:0;border-radius:8px;cursor:pointer}
.footer{width:36px;flex-shrink:0;display:flex;align-items:center;flex-direction:column;gap:8px}.help{font-size:20px;color:#a0a0a0}
.avatar{background:#e9871d;border-radius:50%;font-size:11px;width:26px;height:26px;flex-basis:26px;margin:3px}
aside{flex:1;padding:16px 10px;background:#202121;border:1px solid #ffffff12;border-radius:0 0 12px 12px}
h2{font-size:13px;opacity:.45;font-weight:500;margin:0 0 20px}p{margin:0 0 10px;padding:8px;border-radius:10px;font-weight:600}p.selected{background:#343535}
input{width:180px;margin:12px;border:1px solid #555;border-radius:6px;background:transparent;color:inherit}
</style><nav data-app-navigation-rail="true"><div class="items"><button aria-label="Tasks">▤</button><button aria-label="Plugins">◇</button></div><div class="footer"><button class="help" aria-label="Help menu">ⓘ</button><button class="avatar" aria-label="Open profile menu">AB</button></div></nav><aside><h2>项目</h2><p>示例任务一</p><p>示例任务二</p><p class="selected">用量进度条</p><input id="typing" aria-label="Editor" value="继续编辑"></aside></html>`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const weekly = { rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 6, windowDurationMins: 300 }, secondary: { usedPercent: 27, windowDurationMins: 10080 } } };
const plus = {rateLimits:{...weekly.rateLimits,planType:'plus'}};
const plusMissing = {rateLimits:{...plus.rateLimits,primary:null}};
const businessWeekly = {rateLimits:{limitId:'codex',planType:'self_serve_business_prolite',primary:{usedPercent:74,windowDurationMins:10080},secondary:null}};

async function run() {
  if (macManager) {
    assert.equal(macManager.activationConfig().KeepAlive,false);
    assert.equal(macManager.activationConfig().RunAtLoad,true);
    assert.equal(macManager.activationConfig().StartInterval,undefined);
    assert.ok(!macManager.agentConfig().ProgramArguments.some(s=>s.includes('manage.cjs')));
  }
  assert.equal(formatRateLimits(weekly).percent, 73);
  assert.equal(formatRateLimits(weekly).windowLabel, '周');
  assert.equal(formatRateLimits(weekly).mode, 'single');
  assert.equal(formatRateLimits(weekly).rings, null);
  assert.equal(formatRateLimits(plus).mode, 'dual');
  assert.deepEqual(formatRateLimits(plus).rings.map(r=>r.percent),[94,73]);
  assert.deepEqual(formatRateLimits({rateLimits:{...plus.rateLimits,primary:plus.rateLimits.secondary,secondary:plus.rateLimits.primary}}).rings.map(r=>r.percent),[94,73]);
  assert.deepEqual(formatRateLimits(plusMissing).rings.map(r=>r.percent),[null,73]);
  assert.deepEqual(formatRateLimits({rateLimits:{...plus.rateLimits,primary:null,secondary:null}}).rings.map(r=>r.percent),[null,null]);
  assert.equal(formatRateLimits({rateLimits:{...weekly.rateLimits,secondary:null}}).percent, null);
  assert.equal(isMainWindow({url:'app://-/index.html'}), true);
  for (const url of ['https://example.com/index.html','app://-/overlay/index.html','app://-/index.html?overlay=1','devtools://devtools/index.html']) assert.equal(isMainWindow({url}),false);
  const code=fs.readFileSync(path.join(root,'agent.cjs'),'utf8');
  assert.doesNotMatch(code, /\/usr\/bin\/(?:open|osascript)|quitApp|launchHidden|ensureAppWithDebugPort|window\.focus\(/);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'src/agent-main.js'),'utf8'),/\.focus\(/);
  console.log('PASS quota selection and no background app activation paths');

  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,args:['--remote-debugging-port=39442']});
  let child;
  let server;
  let controls;
  try {
    const page=await browser.newPage({viewport:{width:320,height:510},deviceScaleFactor:2});
    await page.setContent(fixture);
    const before=await page.locator('.help').boundingBox();
    await page.locator('#typing').focus();
    await page.evaluate(buildBootstrapScript());
    await page.evaluate(v=>window.__codexUsageBadge.update(v),formatRateLimits(weekly));
    await sleep(300);
    assert.equal(await page.locator('#typing').evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('#codex-usage-badge .usage-primary .usage-number').textContent(),'73%');
    assert.equal(await page.locator('#codex-usage-badge .usage-primary .usage-window').textContent(),'周额度');
    const after=await page.locator('.help').boundingBox();
    assert.equal(before.y,after.y,'help button must keep its original position');
    const box=await page.locator('#codex-usage-badge').boundingBox();
    assert.ok(box.x>=0 && box.x+box.width<=52 && box.y+box.height<=after.y,'badge must fit above help inside rail');
    await page.screenshot({path:path.join(root,'tests/preview-dark.png')});
    await page.locator('#codex-usage-badge').hover();
    await page.waitForSelector('#codex-usage-tooltip:visible');
    assert.match(await page.locator('#codex-usage-tooltip').textContent(),/剩余73%/);
    await page.screenshot({path:path.join(root,'tests/preview-tooltip.png')});
    await page.evaluate(v=>window.__codexUsageBadge.update(v),formatRateLimits(businessWeekly));
    assert.equal(await page.locator('#codex-usage-badge .usage-number:visible').textContent(),'26%');
    assert.equal(await page.locator('#codex-usage-badge .usage-window:visible').textContent(),'周额度');
    assert.equal(await page.locator('#codex-usage-badge .usage-ring:visible').count(),1);
    assert.equal(await page.locator('#codex-usage-badge').getAttribute('data-tone'),'warning');
    assert.equal(await page.locator('#codex-usage-badge').getAttribute('aria-valuenow'),'26');
    assert.match(await page.locator('#codex-usage-tooltip').textContent(),/当前显示：1周额度，剩余26%/);
    assert.doesNotMatch(await page.locator('#codex-usage-tooltip').textContent(),/暂时无法读取/);
    await page.evaluate(v=>window.__codexUsageBadge.update(v),formatRateLimits(weekly));
    await page.evaluate(()=>document.documentElement.classList.remove('dark'));
    await page.evaluate(()=>{document.documentElement.dataset.theme='light';document.body.style.color='#272c29';document.querySelector('nav').style.background='#f2f2f1';document.querySelector('aside').style.background='#fff';});
    await page.mouse.move(310,10);
    await page.screenshot({path:path.join(root,'tests/preview-light.png')});
    const badgeInk=()=>page.locator('#codex-usage-badge').evaluate(el=>getComputedStyle(el).color);
    assert.equal(await badgeInk(),'rgb(37, 49, 58)','light theme needs dark readable text');
    await page.emulateMedia({colorScheme:'dark'});
    assert.equal(await badgeInk(),'rgb(37, 49, 58)','explicit app light theme overrides system dark');
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    assert.equal(await badgeInk(),'rgb(245, 247, 245)','theme switches without reinjection');
    await page.evaluate(()=>document.documentElement.removeAttribute('data-theme'));
    assert.equal(await badgeInk(),'rgb(245, 247, 245)','system dark fallback');
    await page.emulateMedia({colorScheme:'light'});
    assert.equal(await badgeInk(),'rgb(37, 49, 58)','system light fallback');
    await page.evaluate(()=>document.documentElement.dataset.theme='light');
    await page.setViewportSize({width:320,height:270});
    await sleep(300);
    const small=await page.locator('#codex-usage-badge').boundingBox();
    const helpSmall=await page.locator('.help').boundingBox();
    assert.ok(small.y>=0&&small.y+small.height<=helpSmall.y);
    await page.evaluate(()=>{const old=document.querySelector('nav');const copy=old.cloneNode(true);copy.querySelector('#codex-usage-badge').remove();old.replaceWith(copy);});
    await sleep(400);
    assert.equal(await page.locator('#codex-usage-badge').count(),1);
    assert.equal(await page.evaluate(()=>window.__codexUsageBadge.status().placed),true);
    for(let i=0;i<5;i++)await page.evaluate(buildBootstrapScript());
    assert.equal(await page.locator('#codex-usage-badge').count(),1);
    await page.evaluate(()=>window.__codexUsageBadge.update({percent:null,title:'暂不可用',tone:'muted',windowLabel:''}));
    assert.equal(await page.locator('#codex-usage-badge .usage-primary .usage-number').textContent(),'—');
    assert.equal(await page.locator('#codex-usage-badge').getAttribute('aria-valuenow'),null);
    await page.evaluate(()=>window.__codexUsageBadge.destroy());
    assert.equal(await page.locator('[id^="codex-usage-"]').count(),0);
    console.log('PASS layout, themes, hover, small window, DOM remount, unknown quota, repeated injection, cleanup and input focus');

    await page.setViewportSize({width:320,height:510});
    await page.setContent(fixture);
    await page.evaluate(buildBootstrapScript());
    await page.evaluate(v=>window.__codexUsageBadge.update(v),formatRateLimits(plus));
    await sleep(300);
    const badge=page.locator('#codex-usage-badge');
    const rings=badge.locator('.usage-ring:visible');
    assert.equal(await rings.count(),2);
    assert.deepEqual(await badge.locator('.usage-number').allTextContents(),['94%','73%']);
    assert.deepEqual(await badge.locator('.usage-window').allTextContents(),['5h额度','周额度']);
    assert.equal(await badge.getAttribute('role'),'group');
    assert.deepEqual(await badge.locator('[role="meter"]').evaluateAll(els=>els.map(el=>el.getAttribute('aria-valuenow'))),['94','73']);
    const dualBox=await badge.boundingBox();
    assert.equal(dualBox.width,34);
    assert.equal(dualBox.height,144);
    assert.equal((await page.locator('.help').boundingBox()).y,before.y);
    const circleBoxes=await rings.all();
    for(const ring of circleBoxes){const r=await ring.boundingBox();assert.equal(r.x+r.width/2,dualBox.x+dualBox.width/2);}
    const primaryLabel=await badge.locator('.usage-primary .usage-window').boundingBox();
    const secondRing=await rings.nth(1).boundingBox();
    assert.ok(primaryLabel.y+primaryLabel.height<secondRing.y,'second ring must not overlap the first label');
    await page.screenshot({path:path.join(root,'tests/preview-plus.png')});
    await page.screenshot({path:path.join(root,'tests/preview-plus-badge.png'),clip:{x:dualBox.x-8,y:dualBox.y-8,width:dualBox.width+16,height:dualBox.height+16}});
    await badge.hover();
    await page.waitForSelector('#codex-usage-tooltip:visible');
    assert.match(await page.locator('#codex-usage-tooltip').textContent(),/5h额度：剩余 94%\n周额度：剩余 73%/);
    for(const [primaryUsed,secondaryUsed,tones] of [[6,83,['normal','warning']],[100,0,['danger','normal']]]) {
      await page.evaluate(v=>window.__codexUsageBadge.update(v),formatRateLimits({rateLimits:{...plus.rateLimits,primary:{...plus.rateLimits.primary,usedPercent:primaryUsed},secondary:{...plus.rateLimits.secondary,usedPercent:secondaryUsed}}}));
      assert.deepEqual(await badge.locator('[role="meter"]').evaluateAll(els=>els.map(el=>el.dataset.tone)),tones);
      const colors=await badge.locator('.usage-gradient-end').evaluateAll(els=>els.map(el=>getComputedStyle(el).stopColor));
      assert.notEqual(colors[0],colors[1],'each ring must have an independent color');
    }
    assert.deepEqual(await badge.locator('.usage-number').allTextContents(),['0%','100%']);
    await page.evaluate(v=>window.__codexUsageBadge.update(v),formatRateLimits(plusMissing));
    assert.deepEqual(await badge.locator('.usage-number').allTextContents(),['—','73%']);
    await page.evaluate(v=>window.__codexUsageBadge.update({...v,updatedAt:Date.now()-150001,stale:false}),formatRateLimits(plus));
    assert.equal(await page.evaluate(()=>window.__codexUsageBadge.status().stale),true);
    assert.deepEqual(await badge.locator('.usage-number').allTextContents(),['—','—']);
    await page.evaluate(v=>window.__codexUsageBadge.update({...v,updatedAt:Date.now(),stale:false}),formatRateLimits(plus));
    assert.deepEqual(await badge.locator('.usage-number').allTextContents(),['94%','73%']);
    await page.setViewportSize({width:320,height:270});
    await sleep(300);
    const dualSmall=await badge.boundingBox();
    assert.ok(dualSmall.y>=0&&dualSmall.y+dualSmall.height<=(await page.locator('.help').boundingBox()).y);
    await page.evaluate(v=>window.__codexUsageBadge.update(v),formatRateLimits(weekly));
    assert.equal(await rings.count(),1);
    assert.equal((await badge.boundingBox()).height,84);
    assert.equal(await badge.getAttribute('role'),'meter');
    assert.equal(await badge.getAttribute('aria-valuenow'),'73');
    await page.evaluate(()=>window.__codexUsageBadge.destroy());
    console.log('PASS Plus dual rings, independent colors, missing and reversed windows, 0/100%, compact layout and switch back to Pro');

    if(process.argv.includes('--ui-only'))return;

    await page.setContent(fixture);
    await page.locator('#typing').focus();
    let online=true;
    server=http.createServer(async(req,res)=>{
      if(!online){res.writeHead(503).end();return;}
      const targets=await(await fetch('http://127.0.0.1:39442/json/list')).json();
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(targets.filter(t=>t.type==='page').map(t=>({...t,url:'app://-/index.html'}))));
    });
    await new Promise(resolve=>server.listen(39443,'127.0.0.1',resolve));
    const fake=path.join(temp,'fake-codex.cjs');
    controls=path.join(temp,'fake-codex-state.json');
    fs.writeFileSync(controls,'{}');
    fs.writeFileSync(fake,`#!${process.execPath}\nconst fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;const state=JSON.parse(fs.readFileSync(${JSON.stringify(controls)},'utf8'));if(m.method==='account/rateLimits/read'&&state.fail){process.stdout.write(JSON.stringify({id:m.id,error:{message:'simulated quota outage'}})+'\\n');return;}if(m.method==='account/rateLimits/read'&&state.exit)process.exit(1);const result=m.method==='account/rateLimits/read'?${JSON.stringify(plus)}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});\n`);
    fs.chmodSync(fake,0o700);
    child=spawn(process.execPath,[path.join(root,'agent.cjs'),'--port','39443','--codex-bin',fake,'--poll-ms','1000'],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    await page.waitForFunction(()=>window.__codexUsageBadge?.status().rings?.[1].percent===73,{},{timeout:15000});
    online=false;
    await sleep(11000);
    assert.equal(child.exitCode,null,'missing debugger should stay idle');
    assert.equal(await page.locator('#typing').evaluate(el=>el===document.activeElement),true);
    online=true;
    await sleep(6000);
    assert.equal(await page.locator('#codex-usage-badge').count(),1);
    assert.deepEqual(await page.evaluate(()=>window.__codexUsageBadge.status().rings.map(r=>r.percent)),[94,73]);
    assert.doesNotMatch(output,/正在.*(?:启动|重启).*ChatGPT/);
    console.log('PASS real agent reconnects after missing CDP without app activation or duplicate badges');
    for(const failure of [{fail:true},{exit:true}]) {
      fs.writeFileSync(controls,JSON.stringify(failure));
      await page.waitForFunction(()=>window.__codexUsageBadge?.status().stale,{},{timeout:15000});
      assert.deepEqual(await page.evaluate(()=>window.__codexUsageBadge.status().rings.map(r=>r.percent)),[null,null]);
      fs.writeFileSync(controls,'{}');
      await page.waitForFunction(()=>window.__codexUsageBadge?.status().rings?.[1].percent===73,{},{timeout:25000});
      assert.equal(child.exitCode,null);
      assert.equal(await page.locator('#typing').evaluate(el=>el===document.activeElement),true);
    }
    console.log('PASS quota request failure and App Server crash clear both readings and recover without stealing input focus');
  } finally {
    if(child&&!child.killed){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
    if(server)await new Promise(resolve=>server.close(resolve));
    if(controls)fs.rmSync(controls,{force:true});
    await browser.close();
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
