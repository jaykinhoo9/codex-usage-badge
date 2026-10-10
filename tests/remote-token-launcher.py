"""Exercise PowerShell launcher control flow with a temporary worker, without SSH/Codex."""
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'remote-tokens'
PWSH = os.environ.get('REMOTE_TOKEN_PWSH') or shutil.which('pwsh')


@unittest.skipUnless(PWSH and os.name == 'posix', 'requires an isolated PowerShell runtime on Linux')
class LauncherTest(unittest.TestCase):
    def test_hidden_worker_control_and_unicode_paths(self):
        with tempfile.TemporaryDirectory(prefix='remote-token-launcher-') as tmp:
            folder = Path(tmp) / '含中文 空格'
            folder.mkdir()
            shutil.copyfile(ROOT / 'launcher.ps1', folder / 'launcher.ps1')
            (folder / 'config.json').write_text('{}')
            harness = folder / 'harness.cjs'
            harness.write_text('''
const fs = require('node:fs'), path = require('node:path');
const root = __dirname, flag = name => path.join(root, name);
const args = process.argv.slice(2);
if (args.includes('--status')) {
  console.log(JSON.stringify({running:fs.existsSync(flag('running')),state:'connected'}));
} else if (args.includes('--check-ssh')) {
  fs.writeFileSync(flag('probed'), 'ok');
} else if (args.includes('--stop')) {
  fs.writeFileSync(flag('stop'), 'stop');
} else {
  if (!args.includes('--background')) throw Error('background argument missing');
  fs.writeFileSync(flag('running'), args[0]);
  const timer = setInterval(() => {
    if (fs.existsSync(flag('stop'))) { fs.unlinkSync(flag('running')); clearInterval(timer); }
  }, 30);
}
''')
            node = folder / 'node.exe'
            # File paths have no shell-special characters except spaces/Chinese here.
            node.write_text(f'#!/bin/sh\nexec "{shutil.which("node")}" "{harness}" "$@"\n')
            node.chmod(0o755)
            profile = folder / 'profile'
            config_dir = profile / 'CodexUsageBadge'
            config_dir.mkdir(parents=True)
            (config_dir / 'config.json').write_text(json.dumps({'NodeExe': str(node)}))
            env = {**os.environ, 'LOCALAPPDATA': str(profile)}
            command = [PWSH, '-NoLogo', '-NoProfile', '-File', str(folder / 'launcher.ps1')]
            worker = subprocess.Popen(command + ['-Action', 'StartBackground'], env=env,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                until = time.monotonic() + 12
                while not (folder / 'running').exists() and time.monotonic() < until:
                    if worker.poll() is not None:
                        self.fail(worker.communicate())
                    time.sleep(0.05)
                self.assertTrue((folder / 'running').exists())
                self.assertTrue((folder / 'probed').exists())
                self.assertEqual((folder / 'running').read_text(), str(folder / 'remote-addon.cjs'))
                status = subprocess.run(command + ['-Action', 'Status'], env=env,
                                        capture_output=True, text=True, timeout=12)
                self.assertEqual(status.returncode, 0, status.stderr)
                self.assertIn('已连接', status.stdout)
                # A repeated start should leave the existing worker alone.
                duplicate = subprocess.run(command + ['-Action', 'StartBackground'], env=env,
                                           capture_output=True, text=True, timeout=12)
                self.assertEqual(duplicate.returncode, 0, duplicate.stderr)
                stopped = subprocess.run(command + ['-Action', 'Stop'], env=env,
                                         capture_output=True, text=True, timeout=12)
                self.assertEqual(stopped.returncode, 0, stopped.stderr)
                output, errors = worker.communicate(timeout=12)
                self.assertEqual(worker.returncode, 0, errors)
                self.assertFalse((folder / 'running').exists())
            finally:
                if worker.poll() is None:
                    (folder / 'stop').write_text('stop')
                    worker.communicate(timeout=12)


if __name__ == '__main__':
    unittest.main()
