#!/usr/bin/env python3
"""Read only thread IDs/token totals; serve only inside an authenticated SSH tunnel."""
import argparse
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

UUID = re.compile(r"^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$")
MAX_IDS = 2000
MAX_BODY = 100000


def read_totals(home, ids):
    result = {"ok": False, "totals": {}, "checkedAt": int(time.time() * 1000)}
    if not isinstance(ids, list) or len(ids) > MAX_IDS:
        return result
    checked = list(dict.fromkeys(x for x in ids if isinstance(x, str) and UUID.fullmatch(x)))
    if not checked:
        result["ok"] = True
        return result
    try:
        files = [p for p in Path(home).glob("state_*.sqlite") if re.fullmatch(r"state_\d+\.sqlite", p.name)]
        if not files:
            return result
        latest = max(files, key=lambda p: int(p.stem.split("_")[1]))
        # A newer, unsupported schema must fail, never fall back to stale account data.
        conn = sqlite3.connect(latest.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)
        try:
            conn.execute("PRAGMA query_only=ON")
            for offset in range(0, len(checked), 200):
                chunk = checked[offset:offset + 200]
                sql = "SELECT id, tokens_used FROM threads WHERE id IN (" + ",".join("?" for _ in chunk) + ")"
                for thread_id, total in conn.execute(sql, chunk):
                    if isinstance(total, int) and 0 <= total <= 9007199254740991:
                        result["totals"][thread_id] = total
            result["ok"] = True
        finally:
            conn.close()
    except (OSError, sqlite3.Error, ValueError):
        result["totals"] = {}
    return result


def make_server(home, port, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log IDs, authentication headers, paths or chat data.

        def reply(self, status, value):
            body = json.dumps(value, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            self.connection.settimeout(3)
            authorization = self.headers.get("Authorization", "")
            if not hmac.compare_digest(authorization.encode("utf-8"), ("Bearer " + token).encode("ascii")):
                self.reply(403, {"ok": False})
                return
            if self.path != "/tokens":
                self.reply(404, {"ok": False})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    raise ValueError()
                value = json.loads(self.rfile.read(length))
                ids = value.get("ids") if isinstance(value, dict) else None
                if not isinstance(ids, list) or len(ids) > MAX_IDS or any(not isinstance(x, str) or not UUID.fullmatch(x) for x in ids):
                    raise ValueError()
            except (ValueError, OSError):
                self.reply(400, {"ok": False})
                return
            self.reply(200, read_totals(home, ids))

    class Server(HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(3)
            return connection, address

    server = Server(("127.0.0.1", port), Handler)
    server.timeout = 3
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", default=os.environ.get("CODEX_HOME") or str(Path.home() / ".codex"))
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535 or not re.fullmatch(r"[0-9a-f]{64}", args.token):
        parser.error("invalid port/session token")
    try:
        server = make_server(str(Path(args.home).expanduser()), args.port, args.token)
    except OSError:
        print("Remote Token port is in use. Existing processes were left untouched.", file=sys.stderr)
        return 1

    def exit_on_disconnect():
        try:
            while sys.stdin.buffer.read(1):
                pass
        finally:
            server.shutdown()

    threading.Thread(target=exit_on_disconnect, daemon=True).start()
    print("Read-only remote Token reader ready; it exits with this SSH connection.", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
