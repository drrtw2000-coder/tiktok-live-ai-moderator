#!/usr/bin/env python3
"""server.py - AI moderator filtering proxy + SSE overlays (stdlib only).

Run from this directory:   py server.py
Env (.env auto-loaded):    PORT, UPSTREAM_TTLIVE_URL, API_TOKEN (ingest),
                           MOD_TOKEN (mod console), AI_PROVIDER, MAX_HISTORY,
                           PUBLIC_BASE_URL, REQUIRE_AUTH

Endpoints:
  POST /api/comment   TikTokComment -> verdict, SSE broadcast, async forward
  GET  /events?channel=chat|mod|all   SSE (chat=public read, mod/all=MOD_TOKEN)
  GET  /overlay/chat  clean chat wall for LIVE Studio Link source (PUBLIC)
  GET  /overlay/mod   mod console (MOD_TOKEN gate, never on stream)
  GET  /api/flags     recent SQLite flags (MOD_TOKEN gate)
  GET  /api/stats     counters (MOD_TOKEN gate)   GET /healthz   liveness
  POST /api/test      manual inject (API_TOKEN gate, localhost hint only)
"""
import hashlib
import hmac
import json
import os
import queue
import sqlite3
import threading
import time
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_dotenv(path: str) -> None:
    """Minimal stdlib .env loader. Real env vars always win over file values."""
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except FileNotFoundError:
        pass


_load_dotenv(os.path.join(HERE, ".env"))

from moderation import moderate_comment  # noqa: E402  reads env at import time

PORT = int((os.getenv("PORT", "3002") or "3002").strip())
UPSTREAM = os.getenv("UPSTREAM_TTLIVE_URL", "http://127.0.0.1:3001").rstrip("/")
# Windows + urllib: "localhost" costs ~2 s per call (IPv6/DNS fallback). Force IPv4.
if "//localhost" in UPSTREAM:
    UPSTREAM = UPSTREAM.replace("//localhost", "//127.0.0.1")
API_TOKEN = os.getenv("API_TOKEN", "")
MOD_TOKEN = os.getenv("MOD_TOKEN", "")
REQUIRE_AUTH = (os.getenv("REQUIRE_AUTH", "1") or "1").strip() not in ("0", "false", "no", "")
PUBLIC_BASE_URL = (os.getenv("PUBLIC_BASE_URL", "") or "").rstrip("/")
# Tunables (env-overridable, sane defaults):
#   RATE_MAX      max POSTs per RATE_WINDOW seconds per client IP
#   BODY_LIMIT_KB max JSON body size in KB for POST endpoints
RATE_MAX = int((os.getenv("RATE_MAX", "60") or "60").strip())
RATE_WINDOW = float((os.getenv("RATE_WINDOW", "60") or "60").strip())
BODY_LIMIT = int((os.getenv("BODY_LIMIT_KB", "256") or "256").strip()) * 1024
MAX_HISTORY = int((os.getenv("MAX_HISTORY", "50") or "50").strip())
DB_PATH = os.path.join(HERE, "flags.db")

# ---------- state ----------
db_lock = threading.Lock()
db = sqlite3.connect(DB_PATH, check_same_thread=False)
with db_lock:
    db.execute("""CREATE TABLE IF NOT EXISTS flags(
        id INTEGER PRIMARY KEY AUTOINCREMENT, tt_id TEXT, user_id TEXT,
        username TEXT, text TEXT, verdict TEXT, score REAL, source TEXT,
        event_type TEXT, ts INTEGER)""")
    db.commit()

chat_history: deque = deque(maxlen=MAX_HISTORY)   # clean only -> overlay
mod_history: deque = deque(maxlen=200)            # everything -> console
counters = {"received": 0, "allowed": 0, "blocked": 0, "flagged": 0,
            "forwarded": 0, "forward_errors": 0}
counters_lock = threading.Lock()
seen: deque = deque(maxlen=2000)                  # ring dedupe of comment ids
seen_lock = threading.Lock()
sse_lock = threading.Lock()
sse_clients: dict[str, set] = {"chat": set(), "mod": set()}


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def _mask(token: str, keep: int = 4) -> str:
    """Last-N-chars only for logs: never print a full secret."""
    if not token:
        return "(empty)"
    return "(too short)" if len(token) < 8 else f"…{token[-keep:]}"


def _is_loopback(ip: str) -> bool:
    return (ip or "").strip() in ("127.0.0.1", "::1", "::ffff:127.0.0.1")


def _directly_exposed(ip: str) -> bool:
    """True when the TCP peer is NOT loopback — i.e. behind ngrok/proxy/VPS.

    The old code trusted client_address == 127.0.0.1 as 'localhost only',
    but a tunnel forwarder always connects from loopback, laundering a
    remote attacker's address. So: loopback alone proves nothing when a
    proxy header is present — a token is always required remotely."""
    return not _is_loopback(ip)


def _check_token(provided: str, expected: str) -> bool:
    if not expected:
        return False
    return hmac.compare_digest(provided or "", expected)


def _client_ip(handler) -> str:
    """Best-effort client IP honoring one trusted proxy hop.

    Only trusts X-Forwarded-For when the TCP peer is loopback (our own
    ngrok forwarder / Caddy on the same box). Direct remote peers use
    their TCP address. Spoofing XFF directly is useless: a direct remote
    peer's header is ignored, and loopback peers are already local."""
    tcp = (handler.client_address[0] if handler.client_address else "") or ""
    if _is_loopback(tcp):
        xff = (handler.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        if xff:
            return xff
    return tcp


# --- per-IP rate limiter (POST endpoints): RATE_MAX per RATE_WINDOW ---
_rl: dict[str, deque] = {}
_rl_lock = threading.Lock()


def _rate_limited(ip: str) -> bool:
    now = time.monotonic()
    with _rl_lock:
        dq = _rl.setdefault(ip, deque())
        while dq and now - dq[0] > RATE_WINDOW:
            dq.popleft()
        dq.append(now)
        if len(_rl) > 5000:  # memory cap: drop idlest buckets
            for k in [k for k, v in _rl.items()
                      if not v or now - v[-1] > RATE_WINDOW * 10][:1000]:
                _rl.pop(k, None)
        return len(dq) > RATE_MAX


# --- auth-failure logger with light throttling (no token values logged) ---
_auth_fail_last: dict[str, float] = {}


def _auth_fail(path: str, ip: str):
    now = time.monotonic()
    key = f"{path}|{ip}"
    if now - _auth_fail_last.get(key, 0) > 5:
        _auth_fail_last[key] = now
        log(f"auth 401 {path} from {ip}")


def bump(key, n=1):
    with counters_lock:
        counters[key] = counters.get(key, 0) + n


def broadcast(channel: str, payload: dict):
    data = json.dumps(payload, ensure_ascii=False)
    with sse_lock:
        targets = list(sse_clients.get(channel, ()))
    for q in targets:
        try:
            q.put_nowait(data)
        except queue.Full:
            pass


def save_flag(comment: dict, verdict: dict):
    try:
        with db_lock:
            db.execute(
                "INSERT INTO flags(tt_id,user_id,username,text,verdict,score,"
                "source,event_type,ts) VALUES(?,?,?,?,?,?,?,?,?)",
                (comment.get("id"), comment.get("userId"), comment.get("username"),
                 (comment.get("text") or "")[:500], verdict.get("verdict"),
                 float(verdict.get("score", 0)), verdict.get("source"),
                 ((comment.get("meta") or {}).get("eventType") or "comment"),
                 int(time.time() * 1000)))
            db.commit()
    except Exception as e:
        log("!! sqlite save failed:", e)


def forward_upstream(comment: dict, token: str):
    """Best-effort forward of CLEAN messages. Fail-open: errors only logged."""
    if not UPSTREAM:
        return
    try:
        body = json.dumps(comment).encode()
        req = urllib.request.Request(
            UPSTREAM + "/api/comment", data=body, method="POST",
            headers={"Content-Type": "application/json",
                     **({"x-api-token": token} if token else {})})
        with urllib.request.urlopen(req, timeout=3) as r:
            if r.status == 200:
                bump("forwarded")
            else:
                bump("forward_errors")
                log(f"!! upstream responded {r.status} (fail-open, kept on overlay)")
    except Exception as e:
        bump("forward_errors")
        log(f"!! upstream forward failed (fail-open, kept on overlay): {e}")


def process_comment(comment: dict, inbound_token: str) -> dict:
    """Verdict -> persist if red -> SSE -> async forward if allowed. Never raises."""
    t0 = time.monotonic()
    bump("received")
    cid = comment.get("id") or f"noid-{int(time.time()*1000)}"
    with seen_lock:
        if cid in seen:
            return {"ok": True, "duplicate": True, "allowed": True, "verdict_ms": 0}
        seen.append(cid)

    verdict = moderate_comment(comment)
    ms = int((time.monotonic() - t0) * 1000)

    event = {"id": cid, "userId": comment.get("userId", "unknown"),
             "username": comment.get("username", "Unknown"),
             "text": comment.get("text", "") or "",
             "timestamp": comment.get("timestamp", int(time.time() * 1000)),
             "meta": comment.get("meta") or {},
             "verdict": verdict, "verdict_ms": ms}

    if verdict.get("severity") == "red":
        bump("blocked")
        save_flag(comment, verdict)
        mod_history.append(event)
        broadcast("mod", event)
        log(f"BLOCK [{verdict['verdict']}] @{event['username']}: {event['text'][:80]}")
    else:
        bump("allowed")
        if verdict.get("severity") == "yellow" or verdict.get("flagged"):
            bump("flagged")
        chat_history.append(event)
        mod_history.append(event)
        broadcast("chat", event)
        broadcast("mod", event)
        threading.Thread(target=forward_upstream,
                         args=(comment, inbound_token), daemon=True).start()
    return {"ok": True, "allowed": verdict["allowed"], "verdict": verdict,
            "verdict_ms": ms}

class Handler(BaseHTTPRequestHandler):
    server_version = "AIMod/0.1"
    protocol_version = "HTTP/1.1"

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # Security headers (cheap, no behavior change for Studio/OBS/SSE):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if ctype.startswith("text/html"):
            # Chat overlay must be embeddable as a Studio Link source.
            self.send_header("Content-Security-Policy",
                             "default-src 'none'; style-src 'unsafe-inline'; "
                             "script-src 'unsafe-inline'; connect-src 'self'; "
                             "img-src data:; base-uri 'none'; form-action 'none'")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _json(self, code, obj, extra=None):
        self._send(code, json.dumps(obj, ensure_ascii=False), extra=extra)

    def _read_json(self, limit=None):
        if limit is None:
            limit = BODY_LIMIT
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > limit:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return None

    def _provided_token(self):
        """Token from header (preferred) or ?token= (for EventSource/img).

        Studio Link sources and EventSource cannot set headers, so the mod
        console passes ?token= in the URL. Header stays preferred for
        bridge/server-to-server calls."""
        from urllib.parse import urlparse, parse_qs
        tok = self.headers.get("x-api-token") or self.headers.get("x-mod-token")
        if tok:
            return tok
        q = parse_qs(urlparse(self.path).query)
        return q.get("token", [""])[0]

    def _check_ingest(self):
        """Gate for /api/comment + /api/test. Returns token or None (401)."""
        if not REQUIRE_AUTH:
            return ""
        tok = self._provided_token()
        if _check_token(tok, API_TOKEN):
            return tok
        _auth_fail(self.path.split("?")[0], _client_ip(self))
        return None

    def _check_mod(self):
        """Gate for mod console + flags + stats + mod/all SSE.

        MOD_TOKEN if set (preferred). If unset: same-box loopback without
        proxy headers still passes (dev convenience); anything arriving via
        a proxy/tunnel (X-Forwarded-For present, ngrok, Caddy) is denied
        with 503 until MOD_TOKEN is configured — fail-closed, not fail-open."""
        if not REQUIRE_AUTH:
            return ""
        tok = self._provided_token()
        if MOD_TOKEN and _check_token(tok, MOD_TOKEN):
            return tok
        if not MOD_TOKEN:
            tcp = (self.client_address[0] if self.client_address else "") or ""
            if _is_loopback(tcp) and not self.headers.get("X-Forwarded-For"):
                return ""  # pure local dev, no proxy in path
            self._json(503, {"ok": False,
                             "error": "mod console locked: set MOD_TOKEN in .env"})
            return False  # already answered
        # MOD_TOKEN is set but caller failed it: allow API_TOKEN as fallback
        # so one secret still works for single-user setups.
        if _check_token(tok, API_TOKEN):
            return tok
        _auth_fail(self.path.split("?")[0], _client_ip(self))
        return None

    def log_message(self, *a):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, x-api-token")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        path, q = u.path.rstrip("/") or "/", parse_qs(u.query)

        if path == "/healthz":
            return self._json(200, {"ok": True,
                                    "auth": "on" if REQUIRE_AUTH else "off"})
        if path == "/api/stats":
            gate = self._check_mod()
            if gate is False:
                return  # 503 already sent
            if gate is None:
                return self._json(401, {"ok": False, "error": "bad mod token"})
            with counters_lock:
                snap = dict(counters)
            snap.update({"chat_buffered": len(chat_history),
                         "mod_buffered": len(mod_history),
                         "sse_chat": len(sse_clients["chat"]),
                         "sse_mod": len(sse_clients["mod"])})
            return self._json(200, snap)
        if path == "/api/flags":
            gate = self._check_mod()
            if gate is False:
                return  # 503 already sent
            if gate is None:
                return self._json(401, {"ok": False, "error": "bad mod token"})
            try:
                limit = max(1, min(200, int(q.get("limit", ["50"])[0])))
            except ValueError:
                limit = 50
            with db_lock:
                rows = db.execute(
                    "SELECT tt_id,user_id,username,text,verdict,score,"
                    "source,event_type,ts FROM flags ORDER BY id DESC LIMIT ?",
                    (limit,)).fetchall()
            keys = ("tt_id", "user_id", "username", "text", "verdict",
                    "score", "source", "event_type", "ts")
            return self._json(200, {"flags": [dict(zip(keys, r)) for r in rows]})
        if path == "/events":
            channel = (q.get("channel", ["all"])[0] or "all").lower()
            if channel in ("mod", "all"):
                gate = self._check_mod()
                if gate is False:
                    return  # 503 already sent
                if gate is None:
                    return self._json(401, {"ok": False,
                                            "error": "bad mod token"})
            return self._sse(channel)
        if path == "/overlay/chat":
            return self._file("overlay_chat.html", "text/html; charset=utf-8")
        if path == "/overlay/mod":
            gate = self._check_mod()
            if gate is False:
                return  # 503 already sent
            if gate is None:
                # Browser-friendly: EventSource/Link can't set headers, so a
                # missing token gets a 401 page (not bare JSON) with a hint.
                return self._send(401,
                                  "<h1>mod console locked</h1>"
                                  "<p>Append <code>?token=YOUR_MOD_TOKEN</code> "
                                  "to the URL. Never use this page as a stream "
                                  "source.</p>",
                                  "text/html; charset=utf-8")
            return self._file("overlay_mod.html", "text/html; charset=utf-8")
        if path == "/":
            return self._send(200, (
                "<h1>AI Moderator</h1><ul>"
                "<li><a href='/overlay/chat'>/overlay/chat</a> "
                "(TikTok LIVE Studio Link source — public)</li>"
                "<li>/overlay/mod (mod console — needs ?token=MOD_TOKEN, "
                "never on stream)</li>"
                "<li>/api/stats + /api/flags (need mod token) "
                "<a href='/healthz'>/healthz</a></li></ul>"),
                "text/html; charset=utf-8")
        return self._json(404, {"ok": False, "error": "not found"})

    def _file(self, name, ctype):
        try:
            with open(os.path.join(HERE, name), "rb") as f:
                self._send(200, f.read(), ctype, {"Cache-Control": "no-cache"})
        except FileNotFoundError:
            self._json(404, {"ok": False, "error": f"{name} missing"})

    def _sse(self, channel):
        if channel not in ("chat", "mod", "all"):
            channel = "all"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        q: queue.Queue = queue.Queue(maxsize=200)
        with sse_lock:
            if channel in ("chat", "all"):
                sse_clients["chat"].add(q)
            if channel in ("mod", "all"):
                sse_clients["mod"].add(q)
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            for e in list(chat_history if channel == "chat" else mod_history):
                self.wfile.write(
                    f"event: message\ndata: {json.dumps(e, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    data = q.get(timeout=20)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(f"event: message\ndata: {data}\n\n".encode())
                self.wfile.flush()
        except (ConnectionError, BrokenPipeError, OSError):
            pass
        finally:
            with sse_lock:
                sse_clients["chat"].discard(q)
                sse_clients["mod"].discard(q)

    def do_POST(self):
        from urllib.parse import urlparse
        path = urlparse(self.path).path.rstrip("/") or "/"

        # Rate-limit all POSTs per client IP (spam/DoS backstop).
        ip = _client_ip(self)
        if _rate_limited(ip):
            return self._json(429, {"ok": False, "error": "rate limited"})

        if path == "/api/test":
            # Was 'localhost only' — broken behind ngrok/tunnel because the
            # forwarder connects from loopback and launders the remote IP.
            # Now: same API_TOKEN as /api/comment. Localhost alone grants
            # nothing; the token does.
            token = self._check_ingest()
            if token is None:
                return self._json(401, {"ok": False, "error": "bad api token"})
            body = self._read_json() or {}
            comment = {
                "id": body.get("id") or f"test-{int(time.time()*1000)}",
                "userId": body.get("user", "tester"),
                "username": body.get("user", "tester"),
                "text": body.get("text", ""),
                "timestamp": int(time.time() * 1000),
                "meta": body.get("meta") or {"eventType": body.get("eventType", "comment")},
            }
            return self._json(200, process_comment(comment, ""))

        if path != "/api/comment":
            return self._json(404, {"ok": False, "error": "not found"})

        token = self._check_ingest()
        if token is None:  # wrong/missing token -> fail-closed 401
            return self._json(401, {"ok": False, "error": "bad api token"})
        body = self._read_json()
        if not isinstance(body, dict) or not isinstance(body.get("text"), str):
            return self._json(400, {"ok": False,
                                    "error": "expected TikTokComment JSON"})
        result = process_comment({
            "id": str(body.get("id", f"noid-{int(time.time()*1000)}")),
            "userId": str(body.get("userId", "unknown")),
            "username": str(body.get("username", "Unknown")),
            "text": body.get("text", ""),
            "timestamp": body.get("timestamp", int(time.time() * 1000)),
            "meta": body.get("meta") if isinstance(body.get("meta"), dict) else {},
        }, token or "")
        result["ok"] = True
        self._json(200, result, {"X-Verdict-Ms": str(result.get("verdict_ms", 0))})


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    weak = API_TOKEN in ("", "changeme-use-same-value-in-bridge-env") or \
        (API_TOKEN and len(API_TOKEN) < 16)
    if REQUIRE_AUTH and (not API_TOKEN or weak):
        log("!! API_TOKEN missing/weak: POST /api/comment + /api/test will 401 "
            "everything. Set a 32+ char secret in .env (same value in bridge).")
    if REQUIRE_AUTH and not MOD_TOKEN:
        log("!! MOD_TOKEN unset: /overlay/mod + /api/flags + /api/stats refuse "
            "all TUNNELED/proxied requests (503) until set. Localhost dev "
            "still works.")
    log(f"AI moderator on :{PORT} -> upstream {UPSTREAM} "
        f"(auth {'on' if REQUIRE_AUTH else 'OFF (REQUIRE_AUTH=0)'}, "
        f"api={_mask(API_TOKEN)}, mod={_mask(MOD_TOKEN)})")
    log("overlay/chat PUBLIC for Studio Link | overlay/mod needs ?token=MOD_TOKEN")
    if PUBLIC_BASE_URL:
        log(f"public: {PUBLIC_BASE_URL}/overlay/chat (Studio) | "
            f"{PUBLIC_BASE_URL}/overlay/mod?token=… (mods only)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("bye")


if __name__ == "__main__":
    main()

