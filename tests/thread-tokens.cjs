const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {chromium}=require('playwright');
const {installThreadTokens,ThreadTokenReader,refreshThreadTokens}=require('../agent.cjs');
const tooltip = text => `${text}\n会话文件 暂不可用\n创建时间 暂不可用\n最后对话 暂不可用`;
const ariaLabel = text => tooltip(text).replaceAll('\n', '，');
const ids=['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003'];
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'badge-tokens-'));
const file=path.join(temp,'state_5.sqlite');
const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY,tokens_used INTEGER, title TEXT);');
const put=db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?, ?)');
put.run(ids[0],12345678,'PRIVATE TITLE NOT TO BE READ');put.run(ids[1],0,'PRIVATE TITLE NOT TO BE READ');put.run(ids[2],-1,'PRIVATE TITLE NOT TO BE READ');
const reader=new ThreadTokenReader({home:temp});
const initial=reader.read([...ids,ids[0],"');DROP TABLE threads;--"]);
assert.equal(initial.ok,true);assert.equal(initial.totals[ids[0]],12345678);assert.equal(initial.totals[ids[1]],0);assert.equal(initial.totals[ids[2]],undefined);
assert.equal(Object.keys(initial.totals).length,2);
assert.doesNotMatch(JSON.stringify(initial),/PRIVATE TITLE/);
assert.equal(db.prepare('SELECT count(*) AS count FROM threads').get().count,3);
const before=fs.readFileSync(file);reader.read(ids);assert.deepEqual(fs.readFileSync(file),before,'reader must not mutate the database');
const emptyReader=new ThreadTokenReader({home:path.join(temp,'missing')});assert.equal(emptyReader.read(ids).ok,false);
const future=new DatabaseSync(path.join(temp,'state_6.sqlite'));future.exec('CREATE TABLE other(id TEXT)');future.close();
assert.equal(reader.read(ids).ok,false,'unknown newer schemas must not silently reuse older values');
fs.unlinkSync(path.join(temp,'state_6.sqlite'));
assert.equal(reader.read(ids).ok,true);
const makeRow=(key,host='local',kind='local',title='示例会话 B')=>`<div class="row" data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="${key}" data-app-action-sidebar-thread-kind="${kind}" data-app-action-sidebar-thread-host-id="${host}" role="button" tabindex="0"><div data-thread-title-trigger><span data-thread-title draggable="true">${title}</span></div><button class="actions" aria-label="会话操作">···</button></div>`;
const fixture=`<!doctype html><html class="dark"><meta charset="UTF-8"><style>
*{box-sizing:border-box}body{margin:0;background:#1e2021;color:#e5e7e8;font:14px -apple-system,sans-serif}.rail{width:52px;background:#282e31;height:480px;position:absolute}.sidebar{margin-left:52px;padding:15px 8px;width:330px}h2{font:500 13px -apple-system;color:#a4a7aa;margin:5px 6px 14px}.row{height:34px;display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:8px;cursor:pointer}.row:hover{background:#323435}.row:first-of-type{background:#303233}[data-thread-title-trigger]{display:flex;align-items:center;gap:8px;flex:1;min-width:0}[data-thread-title]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.actions{border:0;background:none;color:inherit}input{background:#333;border:1px solid #555;border-radius:6px;color:inherit;margin:12px;padding:6px}
</style><div class="rail"></div><div class="sidebar"><h2>文件夹</h2>${makeRow('local:'+ids[0],'local','local','示例会话 A')}${makeRow('local:'+ids[1])}${makeRow('local:'+ids[2],'local','local','示例会话 C')}${makeRow('local:'+ids[0],'remote-host','local','远程会话')}${makeRow('chatgpt:'+ids[0],'local','chatgpt','ChatGPT 会话')}<input id="editor" value="继续编辑"></div><script>window.rowClicks=0;window.contextMenus=0;document.querySelectorAll('.row').forEach(row=>{row.addEventListener('click',()=>window.rowClicks++);row.addEventListener('contextmenu',e=>{e.preventDefault();window.contextMenus++})})</script></html>`;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined});
 try{
  const page=await browser.newPage({viewport:{width:420,height:420},deviceScaleFactor:2,timezoneId:'Asia/Shanghai'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent(fixture);await page.locator('#editor').focus();
  const heights=await page.locator('.row').evaluateAll(rows=>rows.map(r=>r.getBoundingClientRect().height));
  await page.evaluate(`(${installThreadTokens.toString()})()`);
  assert.equal(await page.locator('#editor').evaluate(el=>el===document.activeElement),true);
  assert.deepEqual(await page.evaluate(()=>window.__codexThreadTokens.requestedIds()),ids);
  const session={evaluate:async expression=>({result:{value:await page.evaluate(expression)}})};
  const injector={sessions:new Map([['test',session]])};
  await refreshThreadTokens(injector,reader);
  const squares=page.locator('[data-codex-thread-tokens]');
  assert.deepEqual(await squares.allTextContents(),['','','','',''],'totals must only appear on hover');
  assert.deepEqual(await squares.evaluateAll(nodes=>nodes.map(n=>n.dataset.level)),['3','0','0','0','0']);
  assert.deepEqual(await squares.first().evaluate(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})),{width:12,height:12});
  assert.deepEqual(await page.locator('.row').evaluateAll(rows=>rows.map(r=>r.getBoundingClientRect().height)),heights);
  assert.equal(await page.locator('[data-thread-title]').first().textContent(),'示例会话 A');
  const unchangedWrites=await page.evaluate(()=>{
    const observer=new MutationObserver(()=>{});
    for(const badge of document.querySelectorAll('[data-codex-thread-tokens]'))observer.observe(badge,{attributes:true,childList:true});
    for(let i=0;i<100;i++)window.__codexThreadTokens.refresh();
    const count=observer.takeRecords().length;observer.disconnect();return count;
  });
  assert.equal(unchangedWrites,0,'unchanged Token values should not continuously rewrite the DOM');
  const second=await browser.newPage();
  try {
    await second.setContent(makeRow('local:'+ids[1]));
    await second.evaluate(`(${installThreadTokens.toString()})()`);
    await second.evaluate(()=>{
      const api=window.__codexThreadTokens,update=api.update;
      api.update=next=>{window.receivedIds=Object.keys(next.totals);update(next)};
    });
    const secondSession={evaluate:async expression=>({result:{value:await second.evaluate(expression)}})};
    const offlineSession={evaluate:async()=>{throw new Error('window disconnected')}};
    await refreshThreadTokens({sessions:new Map([['first',session],['second',secondSession],['offline',offlineSession]])},reader);
    assert.deepEqual(await second.evaluate(()=>window.receivedIds),[ids[1]],'each window receives only its own requested totals');
    assert.equal(await second.locator('[data-codex-thread-tokens]').getAttribute('aria-label'),ariaLabel('累计使用 0 Token'));
    assert.equal(await squares.first().getAttribute('aria-label'),ariaLabel('累计使用 1.23千万 Token'));
  } finally {await second.close();}
  await page.locator('[data-thread-title-trigger]').first().evaluate(el=>{
    for(const type of ['mouseover','pointerover','pointermove'])el.addEventListener(type,e=>e.stopPropagation());
  });
  await page.locator('[data-codex-thread-tokens]').first().hover();await page.waitForSelector('#codex-thread-tokens-tooltip:visible');
  assert.equal(await page.locator('#codex-thread-tokens-tooltip').textContent(),tooltip('累计使用 1.23千万 Token'));
  await page.screenshot({path:path.join(__dirname,'preview-thread-tokens.png')});
  const bounds=await squares.first().boundingBox();
  for(const [x,y] of [[bounds.x-4,bounds.y+6],[bounds.x+16,bounds.y+6],[bounds.x+6,bounds.y-4],[bounds.x+6,bounds.y+16]]) {
    await page.mouse.move(410,410);await page.mouse.move(x,y);
    await page.waitForSelector('#codex-thread-tokens-tooltip:visible',{timeout:1000});
    assert.equal(await page.locator('#codex-thread-tokens-tooltip').textContent(),tooltip('累计使用 1.23千万 Token'));
  }
  await page.locator('[data-thread-title]').first().hover();
  assert.equal(await page.locator('#codex-thread-tokens-tooltip').isVisible(),false,'moving onto the title must dismiss the token tooltip');
  await squares.first().hover();await page.waitForSelector('#codex-thread-tokens-tooltip:visible');
  const uninterrupted=await page.evaluate(async()=>{
    const pane=document.createElement('div');document.body.append(pane);const shown=[];
    for(let i=0;i<8;i++) {
      pane.dispatchEvent(new Event('scroll'));
      await new Promise(resolve=>setTimeout(resolve,40));
      shown.push(!document.getElementById('codex-thread-tokens-tooltip').hidden);
    }
    pane.remove();return shown;
  });
  assert.equal(uninterrupted.every(Boolean),true,'conversation auto-scroll must not dismiss the sidebar tooltip');
  await page.evaluate(()=>document.dispatchEvent(new Event('scroll')));
  await page.waitForSelector('#codex-thread-tokens-tooltip:visible',{timeout:1000});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#codex-thread-tokens-tooltip').isVisible(),false);
  await page.mouse.move(bounds.x+7,bounds.y+6);
  await page.waitForSelector('#codex-thread-tokens-tooltip:visible',{timeout:1000});
  assert.equal(await page.locator('#editor').evaluate(el=>el===document.activeElement),true);
  await page.locator('[data-codex-thread-tokens]').first().click();assert.equal(await page.evaluate(()=>window.rowClicks),1);
  await page.locator('[data-codex-thread-tokens]').first().click({button:'right'});assert.equal(await page.evaluate(()=>window.contextMenus),1);
  await page.mouse.move(410,410);assert.equal(await page.locator('#codex-thread-tokens-tooltip').isVisible(),false);
  const palette=new Map();
  for(const [total,level,label] of [[0,0,'0'],[1,1,'1'],[9999,1,'9,999'],[10000,1,'1万'],[123456,1,'12.35万'],[999999,1,'100万'],[1000000,2,'100万'],[9999999,2,'1千万'],[10000000,3,'1千万'],[18488659,3,'1.85千万'],[99999999,3,'1亿'],[100000000,4,'1亿'],[450000000,4,'4.5亿']]) {
    put.run(ids[0],total,'PRIVATE TITLE');await refreshThreadTokens(injector,reader);
    assert.equal(await squares.first().getAttribute('data-level'),String(level));
    assert.equal(await squares.first().getAttribute('aria-label'),ariaLabel(`累计使用 ${label} Token`));
    palette.set(level,await squares.first().evaluate(n=>getComputedStyle(n).backgroundColor));
  }
  assert.equal(new Set(palette.values()).size,5,'each tier must have a distinct visible color');
  put.run(ids[0],450000000,'PRIVATE TITLE');await refreshThreadTokens(injector,reader);
  assert.equal(await squares.first().getAttribute('data-level'),'4');
  await page.locator('.row').first().evaluate(el=>el.setAttribute('data-app-action-sidebar-thread-id','local:00000000-0000-0000-0000-000000000002'));
  await page.waitForFunction(()=>document.querySelector('[data-codex-thread-tokens]').dataset.level==='0');
  await squares.first().hover();await page.waitForSelector('#codex-thread-tokens-tooltip:visible');
  await page.locator('.row').first().evaluate(el=>el.replaceWith(el.cloneNode(true)));
  await page.waitForFunction(()=>window.__codexThreadTokens.status().badges===5);
  await page.waitForTimeout(150);assert.equal(await page.locator('[data-codex-thread-tokens]').count(),5,'cloned rows must not duplicate badges');
  await page.waitForSelector('#codex-thread-tokens-tooltip:visible',{timeout:1000});
  assert.equal(await page.locator('#codex-thread-tokens-tooltip').textContent(),tooltip('累计使用 0 Token'),'stationary pointer must recover after a row remount');
  await page.evaluate(()=>window.__codexThreadTokens.update({ok:true,totals:{},checkedAt:Date.now()-31000}));
  assert.deepEqual(await squares.evaluateAll(nodes=>nodes.map(n=>n.dataset.level)),['0','0','0','0','0']);
  await refreshThreadTokens(injector,emptyReader);assert.equal(await page.evaluate(()=>window.__codexThreadTokens.status().available),0);
  await refreshThreadTokens(injector,reader);assert.equal(await squares.first().getAttribute('aria-label'),ariaLabel('累计使用 0 Token'));
  // All four lines use real metadata, with UTC timestamps rendered in the client timezone.
  const detail={bytes:2048,createdAt:Date.UTC(2026,0,1,8,0,0),chatAt:Date.UTC(2026,0,2,3,39,13)};
  await page.evaluate(({id,detail})=>window.__codexThreadTokens.update({ok:true,checkedAt:Date.now(),totals:{[id]:450000000},details:{[id]:detail}}),{id:ids[1],detail});
  assert.equal(await squares.first().getAttribute('data-level'),'4','metadata must not change Token tiers');
  await squares.first().hover();await page.waitForSelector('#codex-thread-tokens-tooltip:visible');
  assert.equal(await page.locator('#codex-thread-tokens-tooltip').textContent(),'累计使用 4.5亿 Token\n会话文件 2 KB\n创建时间 2026-01-01 16:00:00\n最后对话 2026-01-02 11:39:13');
  const tooltipBounds=await page.locator('#codex-thread-tokens-tooltip').boundingBox();
  assert(tooltipBounds.x>=0&&tooltipBounds.y>=0&&tooltipBounds.x+tooltipBounds.width<=420&&tooltipBounds.y+tooltipBounds.height<=420);
  await refreshThreadTokens(injector,reader);
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  assert.notEqual(await squares.first().evaluate(n=>getComputedStyle(n).backgroundColor),palette.get(0));
  await page.setViewportSize({width:240,height:270});
  for(let i=0;i<3;i++)await page.evaluate(`(${installThreadTokens.toString()})()`);
  assert.equal(await page.locator('[data-codex-thread-tokens]').count(),5);
  assert.equal(await page.locator('#codex-thread-tokens-style').count(),1);
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>window.__codexThreadTokens.destroy());
  assert.equal(await page.locator('[data-codex-thread-tokens],#codex-thread-tokens-style,#codex-thread-tokens-tooltip').count(),0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM threads').get().count,3);
  console.log('PASS local read-only token totals, WAL updates, zero/missing/invalid data, schema failure, SQL parameterization, fixed color tiers, Chinese units and rounding, expanded hit area, stopped bubbling, scroll/move/remount hover recovery, input focus, clicks/context menu, identity isolation, freshness/recovery and cleanup');
 }finally{await browser.close();db.close();fs.rmSync(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
