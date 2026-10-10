'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { normalizeConfig, sshArguments, sshProbeArguments, launchSsh, readRemote, writeStatus, readStatus } = require('../remote-tokens/remote-addon.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-token-background-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = (promise, ms) => Promise.race([promise, sleep(ms).then(() => { throw Error('test timeout'); })]);

(async () => {
  const config = normalizeConfig({ ...{ ...require('../remote-tokens/config.example.json'), sshHost: '203.0.113.10', expectedHostName: '203.0.113.10', sshUser: 'badge-test' }, sshPort: 2222 });
  const token = 'b'.repeat(64);
  assert.ok(sshProbeArguments(config).includes('BatchMode=yes'));
  assert.ok(sshProbeArguments(config).includes('StrictHostKeyChecking=yes'));
  assert.ok(!sshProbeArguments(config).some(arg => arg.includes('--token')));
  assert.ok(sshArguments(config, token, true).includes('BatchMode=yes'));
  assert.ok(!sshArguments(config, token, false).includes('BatchMode=yes'));

  const status = path.join(root, '.remote-token.status.json');
  writeStatus('connected', true, status);
  fs.writeFileSync(path.join(root, '.remote-token.lock'), JSON.stringify({ pid: process.pid }));
  assert.deepEqual(readStatus(root), { running: true, state: 'connected' });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(status))), ['pid', 'running', 'state', 'updatedAt']);
  assert.deepEqual(readStatus(root, () => { throw Error('process gone'); }), { running: false, state: 'stopped' });
  fs.writeFileSync(status, JSON.stringify({ pid: process.pid + 1, state: 'connected' }));
  assert.equal(readStatus(root).state, 'starting'); // A reused/stale status must not claim a connection.

  const allocator = net.createServer();
  await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port;
  await new Promise(resolve => allocator.close(resolve));
  let child;
  try {
    child = launchSsh(config, token, true, (exe, args, options) => {
      assert.equal(exe, 'ssh.exe');
      assert.ok(args.includes('BatchMode=yes'));
      assert.equal(options.windowsHide, true);
      return spawn(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-u', path.join(__dirname, '../remote-tokens/remote_reader.py'), '--home', root, '--port', String(port), '--token', token], options);
    });
    const closed = once(child, 'close');
    let connected = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { assert.equal((await readRemote({ localPort: port }, token, [])).ok, true); connected = true; break; }
      catch { await sleep(50); }
    }
    assert.ok(connected, 'background reader did not start');
    await sleep(250);
    assert.equal(child.exitCode, null);
    assert.equal((await readRemote({ localPort: port }, token, [])).ok, true);
    child.stdin.end();
    const [code] = await deadline(closed, 3000);
    assert.equal(code, 0);
    await assert.rejects(readRemote({ localPort: port }, token, []));
  } finally { if (child && child.exitCode === null) child.kill(); }
  console.log('PASS: background reader remains alive with piped stdin, exits on EOF, noninteractive SSH, and stale-process status.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
