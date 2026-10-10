"""Build the optional Windows SSH connector, separately from automatic updates."""
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
subprocess.run([sys.executable, str(root / 'build.py')], check=True)
version = json.loads((root / 'package.json').read_text())['windowsVersion']
name = f'CodexUsageBadge-RemoteTokens-Windows-{version}'
files = ['remote-addon.cjs', 'remote_reader.py', 'ui.cjs', 'launcher.ps1',
         'Start.cmd', 'Start.vbs', 'StartConsole.cmd', 'Stop.cmd', 'Status.cmd',
         'Hosts.cmd', 'config.example.json', 'README.md']
payload = {file: (root / 'remote-tokens' / file).read_bytes() for file in files}
payload['LICENSE'] = (root / 'LICENSE').read_bytes()
for file in files:
    if file.endswith('.ps1'):
        text = payload[file].decode('utf-8-sig').replace('\r\n', '\n')
        payload[file] = b'\xef\xbb\xbf' + text.replace('\n', '\r\n').encode('utf-8')
    elif file.endswith(('.cmd', '.vbs')):
        payload[file] = payload[file].decode('ascii').replace('\r\n', '\n').replace('\n', '\r\n').encode('ascii')
payload['SHA256SUMS.txt'] = ''.join(f'{hashlib.sha256(data).hexdigest()}  {file}\n' for file, data in sorted(payload.items())).encode()
dest = root / 'dist'
dest.mkdir(exist_ok=True)
archive = dest / (name + '.zip')
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for file, data in sorted(payload.items()):
        info = zipfile.ZipInfo(name + '/' + file, date_time=(2026, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        bundle.writestr(info, data)
print(archive.name)
