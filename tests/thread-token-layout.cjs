const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {installThreadTokens} = require('../agent.cjs');

const rowAttribute = 'data-app-action-sidebar-thread-row';
const mark = 'data-codex-thread-tokens';
const title = '<div data-thread-title draggable="true">一个用于检查缩略、对齐和点击行为的较长会话标题</div>';
const shapes = [
  ['codex', `<div class="line" data-thread-title-trigger>${title}</div><span class="status"></span>`],
  ['gpt-project', `<div class="line" data-thread-title-trigger><span class="title-slot">${title}</span><span class="status"></span></div>`],
  ['gpt-recent', `<div class="line" data-thread-title-trigger><span class="title-slot">${title}</span><time>12:30</time></div>`],
  ['secondary', `<div class="column" data-thread-title-trigger><div class="line"><span class="title-slot">${title}</span><time>12:30</time></div><small>第二行说明保持在原处</small></div>`],
  ['direct', `${title}<span class="status"></span>`],
  ['inline', '<div class="title-slot" data-thread-title-trigger><span data-thread-title>另一条较长的会话标题，需要在有限空间内缩略显示</span></div>'],
];
const fixture = `<!doctype html><html><meta charset="UTF-8"><style>
  *{box-sizing:border-box}body{margin:0;padding:12px;font:14px/20px -apple-system,sans-serif;background:#fafafa;color:#242424}
  html.dark body{background:#202121;color:#eee}
  .row{display:flex;align-items:center;gap:8px;height:34px;padding:4px 8px;width:var(--sidebar-width);border-radius:8px}
  .row.secondary{height:56px}.row:hover{background:#8882}
  .line{display:flex;align-items:center;gap:8px;flex:1;min-width:0;width:100%}
  .title-slot{flex:1;min-width:0}.column{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
  [data-thread-title]{width:100%;flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  time,.status{flex-shrink:0}time{font-size:11px}.status{width:8px;height:8px;background:#3989fb;border-radius:50%}
  small{display:block;font-size:11px;line-height:16px;white-space:nowrap}
</style><main>${shapes.map(([shape,body],i)=>`<div class="row ${shape}" data-shape="${shape}" ${rowAttribute} data-app-action-sidebar-thread-id="local:00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}" data-app-action-sidebar-thread-kind="local" data-app-action-sidebar-thread-host-id="local">${body}</div>`).join('')}
<div class="unrelated"><div data-thread-title>插件不处理的标题</div></div></main></html>`;

async function geometry(page) {
  return page.locator(`[${rowAttribute}]`).evaluateAll(rows=>rows.map(row=>{
    const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const title=row.querySelector('[data-thread-title]');
    return {shape:row.dataset.shape,row:rect(row),title:rect(title),badge:row.querySelector('[data-codex-thread-tokens]')?rect(row.querySelector('[data-codex-thread-tokens]')):null,
      meta:[...row.querySelectorAll('time,.status,small')].map(rect),truncated:title.scrollWidth>title.clientWidth,
      ellipsis:getComputedStyle(title).textOverflow};
  }));
}

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||undefined});
  try {
    const page=await browser.newPage({viewport:{width:380,height:420},deviceScaleFactor:2});
    for(const theme of ['light','dark'])for(const width of [330,240,150]){
      await page.setContent(fixture);
      await page.evaluate(({theme,width})=>{
        document.documentElement.className=theme;
        document.documentElement.style.setProperty('--sidebar-width',width+'px');
        window.originalTitles=[...document.querySelectorAll('[data-thread-title]')];
        window.originalParents=window.originalTitles.map(t=>t.parentElement);
        window.titleClicks=0;window.titleContextMenus=0;
        window.originalTitles.forEach(t=>{t.addEventListener('click',()=>window.titleClicks++);t.addEventListener('contextmenu',e=>{e.preventDefault();window.titleContextMenus++})});
      },{theme,width});
      const before=await geometry(page);
      const unrelatedBefore=await page.locator('.unrelated').evaluate(e=>e.outerHTML);
      await page.evaluate(`(${installThreadTokens.toString()})()`);
      await page.evaluate(()=>window.__codexThreadTokens.update({ok:true,checkedAt:Date.now(),totals:{'00000000-0000-0000-0000-000000000001':18488659}}));
      for(const [i,actual]of (await geometry(page)).entries()){
        const context=`${theme}/${width}/${actual.shape}`;
        assert.deepEqual(actual.row,before[i].row,context+': row geometry changed');
        assert.deepEqual(actual.meta,before[i].meta,context+': metadata or secondary line moved');
        assert.equal(actual.badge.width,12,context);assert.equal(actual.badge.height,12,context);
        assert.ok(Math.abs(actual.badge.y+6-actual.title.y-actual.title.height/2)<0.5,context+': badge and title must share a center line');
        assert.ok(actual.title.x-actual.badge.right>=6,context+': insufficient badge/title spacing');
        assert.ok(actual.title.right<=actual.row.right-8.0+0.5,context+': title exceeds the row');
        assert.ok(actual.badge.y>=actual.row.y&&actual.badge.bottom<=actual.row.bottom,context+': badge overlaps adjacent rows');
        assert.ok(actual.truncated,context+': long title should shrink');assert.equal(actual.ellipsis,'ellipsis',context);
      }
      assert.equal(await page.evaluate(()=>window.originalTitles.every((t,i)=>t.isConnected&&t.parentElement===window.originalParents[i])),true,'native title nodes and parents must be preserved');
      assert.equal(await page.locator('.unrelated').evaluate(e=>e.outerHTML),unrelatedBefore);
      for(let i=0;i<3;i++)await page.evaluate(`(${installThreadTokens.toString()})()`);
      assert.equal(await page.locator(`[${mark}]`).count(),shapes.length);
      await page.locator('[data-shape="gpt-project"] [data-thread-title]').click();
      await page.locator('[data-shape="gpt-project"] [data-thread-title]').click({button:'right'});
      assert.deepEqual(await page.evaluate(()=>[window.titleClicks,window.titleContextMenus]),[1,1]);
      await page.locator(`[${mark}]`).first().hover();
      await page.waitForSelector('#codex-thread-tokens-tooltip:visible');
      assert.equal(await page.locator('#codex-thread-tokens-tooltip').textContent(),'累计使用 1.85千万 Token\n会话文件 暂不可用\n创建时间 暂不可用\n最后对话 暂不可用');
      await page.mouse.move(375,415);
      if(width===330){
        const output=path.join(__dirname,'artifacts');fs.mkdirSync(output,{recursive:true});
        await page.screenshot({path:path.join(output,`token-layout-${theme}.png`)});
      }
      await page.evaluate(()=>window.__codexThreadTokens.destroy());
      assert.deepEqual(await geometry(page),before,'destroy must restore native layout');
    }
    console.log('PASS Token layout: Codex/GPT title containers, narrow sidebars, both themes, metadata, secondary text, long-title truncation, native events, repeated injection and cleanup');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
