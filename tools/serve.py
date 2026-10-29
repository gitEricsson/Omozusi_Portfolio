"""Local preview server that never caches, so edits show on reload.

    python tools/serve.py          # http://127.0.0.1:5173
"""
import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
root = Path(__file__).resolve().parent.parent
handler = functools.partial(NoCache, directory=str(root))
print(f"Serving {root} at http://127.0.0.1:{port}")
ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
