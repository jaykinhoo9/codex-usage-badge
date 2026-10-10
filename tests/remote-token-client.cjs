'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeConfig, resolveSshTarget, shellQuote, sshArguments, safeEndpoint, readRemote } = require('../remote-tokens/remote-addon.cjs');
const rawConfig = { ...require('../remote-tokens/config.example.json'), sshHost: '203.0.113.10', expectedHostName: '203.0.113.10', sshUser: 'badge-test' };
const config = normalizeConfig({ ...rawConfig, sshPort: 2222 });
const id = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
assert.throws(() => normalizeConfig({ ...config, hostIds: ['local'] }));
assert.throws(() => normalizeConfig({ ...config, sshHost: '-oProxyCommand=bad' }));
assert.throws(() => normalizeConfig({ ...config, localPort: 39222 }));
assert.throws(() => safeEndpoint('ws://example.com:39222/devtools/page/1'));
assert.throws(() => safeEndpoint('ws://127.0.0.1:9999/devtools/page/1'));
assert.throws(() => safeEndpoint('wss://127.0.0.1:39222/devtools/page/1'));
assert.equal(safeEndpoint('ws://127.0.0.1:39222/devtools/page/1'), 'ws://127.0.0.1:39222/devtools/page/1');
assert.equal(shellQuote("/tmp/user's folder"), "'/tmp/user'\"'\"'s folder'");
const args = sshArguments(config, 'a'.repeat(64));
assert.ok(args.includes('127.0.0.1:39223:127.0.0.1:43003'));
assert.ok(args.includes('ExitOnForwardFailure=yes'));
assert.ok(args.includes('badge-test@203.0.113.10'));
assert.ok(args.includes('2222'));
assert.ok(!args.includes('StrictHostKeyChecking=no'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-token-ssh-'));
try {
  fs.mkdirSync(path.join(temp, '.ssh'));
  const sshConfig = 'Host different-alias\n  HostName 203.0.113.10\n  User badge-test\n  Port 60222\n';
  fs.writeFileSync(path.join(temp, '.ssh/config'), sshConfig);
  const resolved = resolveSshTarget(rawConfig, temp, (exe, sshArgs) => ({ status: 0, stdout: `hostname ${sshArgs.at(-1) === 'different-alias' ? '203.0.113.10' : 'some-other-host'}\nuser badge-test\nport 60222\n` }));
  assert.equal(resolved.sshHost, 'different-alias');
  assert.equal(resolved.sshPort, 60222);
  assert.equal(fs.readFileSync(path.join(temp, '.ssh/config'), 'utf8'), sshConfig);
  assert.throws(() => resolveSshTarget(rawConfig, temp, () => ({ status: 0, stdout: 'hostname wrong-server\nuser badge-test\nport 22\n' })));
  const privateAliasConfig = 'Host lan-server\n  HostName 192.0.2.32\n  User badge-test\n';
  fs.writeFileSync(path.join(temp, '.ssh/config'), privateAliasConfig);
  const inspected = [];
  const publicTarget = resolveSshTarget(rawConfig, temp, (exe, sshArgs) => {
    const target = sshArgs.at(-1);
    inspected.push(target);
    return { status: 0, stdout: `hostname ${target === 'lan-server' ? '192.0.2.32' : target}\nuser badge-test\nport 22\n` };
  });
  assert.equal(publicTarget.sshHost, '203.0.113.10');
  assert.equal(publicTarget.sshPort, 22);
  assert.deepEqual(inspected, ['203.0.113.10']);
  assert.equal(fs.readFileSync(path.join(temp, '.ssh/config'), 'utf8'), privateAliasConfig);
  const inherited = resolveSshTarget({ ...rawConfig, sshUser: null, expectedHostName: null }, temp,
    (exe, args) => {
      assert.ok(!args.includes('-l'));
      assert.equal(args.at(-1), rawConfig.sshHost);
      return { status: 0, stdout: 'hostname 203.0.113.10\nuser inherited-user\nport 60222\n' };
    });
  assert.equal(inherited.sshUser, 'inherited-user');
  assert.equal(inherited.sshPort, 60222);
  if (process.platform !== 'win32') {
    const script = path.join(temp, "reader's $(touch leaked).py");
    fs.writeFileSync(script, "print('bootstrap-ok')\n");
    const command = sshArguments({ ...config, readerPath: script }, 'a'.repeat(64)).at(-1);
    const execution = spawnSync('/bin/sh', ['-c', command], { cwd: temp, encoding: 'utf8' });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout.trim(), 'bootstrap-ok');
    assert.equal(fs.existsSync(path.join(temp, 'leaked')), false);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
(async () => {
  let request;
  const value = await readRemote(config, 'a'.repeat(64), [id, id, 'invalid'], async (url, options) => {
    request = { url, options };
    return { ok: true, text: async () => JSON.stringify({ ok: true, totals: { [id]: 0, [other]: 987654321, garbage: -1 }, checkedAt: 1 }) };
  });
  assert.deepEqual(JSON.parse(request.options.body), { ids: [id] });
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual({ ...value.totals }, { [id]: 0 });
  assert.ok(value.checkedAt > 1); // Local time prevents remote clock skew.
  const negative = await readRemote(config, 'a'.repeat(64), [id], async () => ({ ok: true, text: async () => JSON.stringify({ ok: true, totals: { [id]: -1 } }) }));
  assert.deepEqual({ ...negative.totals }, {});
  await assert.rejects(readRemote(config, 'a'.repeat(64), [id], async () => ({ ok: false })));
  await assert.rejects(readRemote(config, 'a'.repeat(64), [id], async () => { throw Error('connection lost'); }));
  console.log('PASS: host isolation, localhost-only CDP, SSH quoting, tunnel binding, requested-ID filtering, zero/invalid totals and disconnects.');
})().catch(error => { console.error(error); process.exitCode = 1; });
