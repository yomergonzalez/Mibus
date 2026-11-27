#!/usr/bin/env python3
"""Proxy mínimo para que el Worker de Corunauta llame a iTranvías con la IP de este servidor.

Solo reenvía GET /queryitr_v3.php?... a https://itranvias.com y solo con la cabecera x-key correcta.
Sin dependencias (Python 3 de serie). Variables: ITR_KEY (obligatoria) y PORT (8880 por defecto).
"""
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = os.environ["ITR_KEY"]
PORT = int(os.environ.get("PORT", "8880"))
UPSTREAM = "https://itranvias.com/queryitr_v3.php"
HEADERS = {"Accept": "application/json", "Referer": "https://itranvias.com/", "User-Agent": "Mozilla/5.0 (corunauta.es)"}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, b"ok", "text/plain")
        if self.headers.get("x-key") != KEY or not self.path.startswith("/queryitr_v3.php?"):
            return self.reply(403, b"no", "text/plain")
        url = UPSTREAM + self.path[len("/queryitr_v3.php"):]
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=10) as r:
                self.reply(r.status, r.read(), r.headers.get("content-type", "application/json"))
        except urllib.error.HTTPError as e:
            self.reply(e.code, e.read(), e.headers.get("content-type", "text/html"))
        except Exception:
            self.reply(502, b"upstream", "text/plain")

    def reply(self, status, body, ctype):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
