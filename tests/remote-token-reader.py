import hashlib
import importlib.util
import json
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'remote-tokens'
spec = importlib.util.spec_from_file_location('remote_reader', ROOT / 'remote_reader.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
ID = '00000000-0000-0000-0000-000000000001'
ZERO = '00000000-0000-0000-0000-000000000002'


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.dbfile = self.home / 'state_5.sqlite'
        with sqlite3.connect(self.dbfile) as db:
            db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, tokens_used INTEGER, title TEXT, conversation TEXT)')
            db.executemany('INSERT INTO threads VALUES(?,?,?,?)', [(ID, 831517, 'PRIVATE_TITLE', 'PRIVATE_BODY'), (ZERO, 0, 'PRIVATE_TITLE', 'PRIVATE_BODY')])

    def tearDown(self):
        self.temp.cleanup()

    def test_read_only_and_exact_fields(self):
        before = hashlib.sha256(self.dbfile.read_bytes()).digest()
        result = reader.read_totals(self.home, [ID, ZERO, ID, "');DROP TABLE threads;--"])
        self.assertTrue(result['ok'])
        self.assertEqual(result['totals'], {ID: 831517, ZERO: 0})
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertEqual(hashlib.sha256(self.dbfile.read_bytes()).digest(), before)
        with sqlite3.connect(self.dbfile) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM threads').fetchone()[0], 2)
        with sqlite3.connect(self.home / 'state_6.sqlite') as db:
            db.execute('CREATE TABLE unsupported(id TEXT)')
        result = reader.read_totals(self.home, [ID])
        self.assertFalse(result['ok'])
        self.assertEqual(result['totals'], {})

    def test_authenticated_service_and_ssh_eof_cleanup(self):
        token = secrets.token_hex(32)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        proc = subprocess.Popen([sys.executable, str(ROOT / 'remote_reader.py'), '--home', str(self.home), '--port', str(port), '--token', token], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertIn(b'ready', proc.stdout.readline())
            def post(value, authorization=None):
                request = urllib.request.Request(f'http://127.0.0.1:{port}/tokens', data=json.dumps(value).encode(), headers={'Authorization': authorization or 'Bearer ' + token, 'Content-Type': 'application/json'})
                return urllib.request.urlopen(request, timeout=2)
            with post({'ids': [ID]}) as response:
                self.assertEqual(json.load(response)['totals'], {ID: 831517})
            for value, authorization, status in [({'ids': [ID]}, 'Bearer wrong', 403), ({'ids': ['not-an-id']}, None, 400), ({'ids': [ID] * 2001}, None, 400), ({'ids': [ID], 'padding': 'x' * 100001}, None, 400)]:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    post(value, authorization)
                self.assertEqual(caught.exception.code, status)
            proc.stdin.close()  # Models the SSH channel closing.
            self.assertEqual(proc.wait(timeout=3), 0)
            with socket.socket() as sock:
                sock.settimeout(1)
                self.assertNotEqual(sock.connect_ex(('127.0.0.1', port)), 0)
            stderr = proc.stderr.read()
            self.assertNotIn(token.encode(), stderr)
            self.assertNotIn(b'PRIVATE', stderr)
        finally:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=3)
            proc.stdout.close()
            proc.stderr.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
