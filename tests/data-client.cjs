const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {formatRateLimits,mergeRateLimitsResponse,AppServerClient}=require('../agent.cjs');
const snapshot={limitId:'codex',planType:'plus',primary:{usedPercent:4,windowDurationMins:300},secondary:{usedPercent:16,windowDurationMins:10080}};
const old={accountId:'test-old',rateLimits:snapshot,rateLimitsByLimitId:{codex:snapshot}};
const readings=value=>{const formatted=formatRateLimits(value);return formatted.rings?.map(r=>r.percent) ?? [formatted.percent];};
assert.equal(formatRateLimits(mergeRateLimitsResponse(old,{rateLimits:null})).percent,null);
assert.equal(formatRateLimits(mergeRateLimitsResponse(old,{rateLimitsByLimitId:{codex:null}})).percent,null);
assert.equal(formatRateLimits(mergeRateLimitsResponse(old,{rateLimitsByLimitId:null})).percent,null);
assert.deepEqual(readings({rateLimits:snapshot,rateLimitsByLimitId:{codex:{...snapshot,primary:{...snapshot.primary,usedPercent:80}}}}),[20,84]);
assert.deepEqual(readings(mergeRateLimitsResponse(old,{rateLimits:{primary:{usedPercent:80}}})),[20,84]);
assert.deepEqual(readings(mergeRateLimitsResponse(old,{rateLimitsByLimitId:{codex:{primary:{usedPercent:70}}}})),[30,84]);
assert.deepEqual(readings(mergeRateLimitsResponse(old,{rateLimits:{limitId:'reserve',primary:{usedPercent:100}}})),[96,84]);
assert.deepEqual(readings(mergeRateLimitsResponse(old,{accountId:'test-new',rateLimits:{planType:'plus',primary:{usedPercent:20,windowDurationMins:300}}})),[80]);
assert.equal(formatRateLimits(mergeRateLimitsResponse(old,{rateLimits:{planType:'pro',primary:{usedPercent:20,windowDurationMins:300}}})).percent,80);
const businessWeekly={rateLimits:{limitId:'codex',planType:'self_serve_business_prolite',primary:{usedPercent:74,windowDurationMins:10080},secondary:null},rateLimitResetCredits:{availableCount:1}};
const businessValue=formatRateLimits(businessWeekly);
assert.equal(businessValue.percent,26);
assert.equal(businessValue.windowLabel,'周');
assert.equal(businessValue.tone,'warning');
assert.equal(businessValue.mode,'single');
assert.equal(businessValue.rings,null);
assert.match(businessValue.title,/当前显示：1周额度，剩余26%/);
assert.match(businessValue.title,/重置卡：1 张可用/);
assert.doesNotMatch(businessValue.title,/暂时无法读取/);
assert.equal(formatRateLimits({rateLimits:{...businessWeekly.rateLimits,primary:{usedPercent:20,windowDurationMins:300}}}).percent,80);
assert.equal(formatRateLimits({rateLimits:{...businessWeekly.rateLimits,primary:{windowDurationMins:10080}}}).percent,null);
assert.equal(formatRateLimits({rateLimitsByLimitId:{codex:businessWeekly.rateLimits}}).percent,26);
assert.deepEqual(readings({rateLimits:{...snapshot,planType:'self_serve_business_prolite'}}),[96,84]);
for(const planType of ['plus','pro','prolite','self_serve_business_prolite','unknown',undefined]) {
  for(const [primary,secondary,expected,label] of [
    [snapshot.primary,snapshot.secondary,[96,84],''],
    [snapshot.secondary,snapshot.primary,[96,84],''],
    [snapshot.primary,null,[96],''],
    [null,snapshot.primary,[96],''],
    [snapshot.secondary,null,[84],'周'],
    [null,snapshot.secondary,[84],'周'],
    [null,null,[null],''],
    [{...snapshot.primary,usedPercent:NaN},snapshot.secondary,[84],'周']
  ]) {
    const data={rateLimits:{limitId:'codex',planType,primary,secondary}};
    const value=formatRateLimits(data);
    assert.deepEqual(readings(data),expected);
    assert.equal(value.mode,expected.length===2?'dual':'single');
    assert.equal(value.windowLabel,label);
    if(expected.length===1)assert.equal(value.rings,null);
    if(expected[0]!==null)assert.doesNotMatch(value.title,/暂时无法读取/);
  }
}
for(const resetsAt of [null,undefined,-1,0,NaN,Infinity,1e100])assert.doesNotThrow(()=>formatRateLimits({rateLimits:{...snapshot,primary:{...snapshot.primary,resetsAt}}}));
for(const [remaining,tone] of [[100,'normal'],[51,'normal'],[50,'warning'],[10,'warning'],[9,'danger'],[0,'danger']]) {
  for(const planType of ['plus','pro','prolite','self_serve_business_prolite']) {
    const value=formatRateLimits({rateLimits:{...snapshot,planType,primary:{...snapshot.primary,usedPercent:100-remaining},secondary:{...snapshot.secondary,usedPercent:100-remaining}}});
    assert.equal(value.tone,tone);
    if(value.rings)assert.deepEqual(value.rings.map(r=>r.tone),[tone,tone]);
  }
}
console.log('PASS null clearing, keyed precedence, delta updates, account/plan changes, reset validation and color boundaries');

(async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'badge-client-'));
  const fake=path.join(temp,'fake.cjs');
  // Every refresh deliberately omits fields; a later snapshot must never inherit them.
  fs.writeFileSync(fake,`const rl=require('node:readline').createInterface({input:process.stdin});let reads=0;rl.on('line',l=>{const m=JSON.parse(l);if(m.id==null)return;process.stdout.write('null\\ninvalid-json\\n');let result={};if(m.method==='account/rateLimits/read'){result=++reads===1?${JSON.stringify(old)}:reads===2?{rateLimits:{planType:'plus',primary:{usedPercent:25,windowDurationMins:300}}}:null;}process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`);
  const client=new AppServerClient({command:process.execPath,args:[fake],requestTimeoutMs:1000});
  try {
    await client.start();
    assert.deepEqual(readings(client.rateLimits),[96,84]);
    await client.refresh();
    assert.deepEqual(readings(client.rateLimits),[75]);
    await client.refresh();
    assert.equal(formatRateLimits(client.rateLimits).percent,null);
    client.child.kill('SIGKILL');
    await new Promise(resolve=>client.once('server-exit',resolve));
    await assert.rejects(client.refresh());
    console.log('PASS real child process protocol: complete refresh replaces stale fields, malformed lines ignored, server exit handled');
  } finally {client.stop();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
