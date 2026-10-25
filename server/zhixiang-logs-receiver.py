#!/usr/bin/env python3
# Zhixiang log receiver: only stores log text, executes nothing.
import json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, date
from urllib.parse import urlparse, parse_qs
UPLOAD_TOKEN = os.environ.get('ZX_UPLOAD_TOKEN', '')
READ_TOKEN = os.environ.get('ZX_READ_TOKEN', '')
PORT = int(os.environ.get('ZX_PORT', '18091'))
LOG_DIR = os.environ.get('ZX_DIR', '/opt/zhixiang-logs/logs')
MAX_UPLOAD_BYTES = 200 * 1024
MAX_DIR_BYTES = 20 * 1024 * 1024
MAX_READ_LINES = 2000
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def _send(self, code, body, ctype='text/plain; charset=utf-8'):
        data = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path in ('/health', '/zhixiang-logs/health'):
            self._send(200, 'ok')
            return
        if path in ('/read', '/zhixiang-logs/read'):
            qs = parse_qs(urlparse(self.path).query)
            if not READ_TOKEN or qs.get('token', [''])[0] != READ_TOKEN:
                self._send(403, 'forbidden')
                return
            try:
                files = sorted(f for f in os.listdir(LOG_DIR) if f.endswith('.log'))
            except FileNotFoundError:
                files = []
            if not files:
                self._send(200, '(no logs yet)\n')
                return
            latest = os.path.join(LOG_DIR, files[-1])
            try:
                with open(latest, 'r', encoding='utf-8', errors='replace') as f:
                    lines = f.readlines()
            except OSError:
                lines = []
            tail = lines[-MAX_READ_LINES:]
            out = 'file: ' + files[-1] + ' (total ' + str(len(lines)) + ' lines, showing last ' + str(len(tail)) + ')\nall files: ' + ', '.join(files) + '\n---\n' + ''.join(tail)
            self._send(200, out)
            return
        self._send(404, 'not found')
    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path not in ('/upload', '/zhixiang-logs/upload'):
            self._send(404, 'not found')
            return
        if not UPLOAD_TOKEN or self.headers.get('X-ZX-Token', '') != UPLOAD_TOKEN:
            self._send(403, 'forbidden')
            return
        length = int(self.headers.get('Content-Length', '0') or 0)
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self._send(413, 'body too large or empty')
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode('utf-8'))
        except Exception:
            self._send(400, 'bad json')
            return
        entries = payload.get('entries')
        if isinstance(entries, str):
            lines = entries.splitlines()
        elif isinstance(entries, list):
            lines = [str(x) for x in entries]
        else:
            self._send(400, 'entries must be string or array')
            return
        if len(lines) > 1000:
            lines = lines[-1000:]
        version = str(payload.get('version', ''))[:50]
        device = str(payload.get('device', ''))[:50]
        os.makedirs(LOG_DIR, exist_ok=True)
        fname = os.path.join(LOG_DIR, date.today().isoformat() + '.log')
        stamp = datetime.now().strftime('%H:%M:%S')
        with open(fname, 'a', encoding='utf-8') as f:
            f.write('\n===== upload ' + stamp + ' version ' + version + ' device ' + device + ' lines ' + str(len(lines)) + ' =====\n')
            for line in lines:
                f.write(line.rstrip('\n') + '\n')
        try:
            files = sorted(f for f in os.listdir(LOG_DIR) if f.endswith('.log'))
            total = sum(os.path.getsize(os.path.join(LOG_DIR, f)) for f in files)
            for f in files:
                if total <= MAX_DIR_BYTES:
                    break
                p = os.path.join(LOG_DIR, f)
                total -= os.path.getsize(p)
                os.remove(p)
        except OSError:
            pass
        self._send(200, json.dumps({'ok': True, 'saved': len(lines)}), 'application/json')
if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
