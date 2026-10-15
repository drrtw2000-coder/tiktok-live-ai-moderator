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
import uuid
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


def _env_int(name: str, default: int, lo: int | None = None,
             hi: int | None = None) -> int:
    """Crash-proof int env: bad values fall back to default (logged once)."""
    try:
        v = int((os.getenv(name, str(default)) or str(default)).strip())
    except (ValueError, TypeError, AttributeError):
        print(f"[config] WARN {name} invalid -> default {default}", flush=True)
        return default
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def _env_float(name: str, default: float) -> float:
    try:
        return float((os.getenv(name, str(default)) or str(default)).strip())
    except (ValueError, TypeError, AttributeError):
        print(f"[config] WARN {name} invalid -> default {default}", flush=True)
        return default


PORT = _env_int("PORT", 3002, 1, 65535)
UPSTREAM = os.getenv("UPSTREAM_TTLIVE_URL", "http://127.0.0.1:3001").rstrip("/")
# Windows + urllib: "localhost" costs ~2 s per call (IPv6/DNS fallback). Force IPv4.
if "//localhost" in UPSTREAM:
    UPSTREAM = UPSTREAM.replace("//localhost", "//127.0.0.1")
API_TOKEN = os.getenv("API_TOKEN", "")
MOD_TOKEN = os.getenv("MOD_TOKEN", "")
REQUIRE_AUTH = (os.getenv("REQUIRE_AUTH", "1") or "1").strip() not in ("0", "false", "no", "")
# TRUST_PROXY: only honor X-Forwarded-For when this is truthy AND the TCP peer
# is loopback (our own tunnel forwarder). Default OFF: behind a public tunnel
# every viewer shares one TCP peer, and an attacker controls XFF — trusting it
# lets them rotate rate-limit buckets and poison auth-fail keys. Set
# TRUST_PROXY=1 only if you run a trusted reverse proxy (Caddy/nginx) on the
# same box that sanitizes XFF.
TRUST_PROXY = (os.getenv("TRUST_PROXY", "0") or "0").strip().lower() \
    not in ("0", "false", "no", "off", "")
PUBLIC_BASE_URL = (os.getenv("PUBLIC_BASE_URL", "") or "").rstrip("/")
# MOD_CONSOLE kill-switch: the comment-moderation console (/overlay/mod,
# /api/flags, mod/all feeds) is off unless explicitly enabled. The overlay
# control panel (/overlay/admin) is unaffected.
MOD_CONSOLE = (os.getenv("MOD_CONSOLE", "1") or "1").strip().lower() \
    not in ("0", "false", "no", "off")
# Tunables (env-overridable, sane defaults):
#   RATE_MAX      max POSTs per RATE_WINDOW seconds per client IP
#   BODY_LIMIT_KB max JSON body size in KB for POST endpoints
#   GET_RATE_MAX  max polls per 60 s per IP (overlay /api/feed)
#   FW_TIMEOUT    upstream forward timeout seconds (3 s default)
#   FW_WORKERS    upstream forward threads (1 default; 2-3 for big streams)
RATE_MAX = _env_int("RATE_MAX", 60, 1, 10000)
RATE_WINDOW = _env_float("RATE_WINDOW", 60.0)
if RATE_WINDOW <= 0:
    print("[config] WARN RATE_WINDOW invalid -> default 60.0", flush=True)
    RATE_WINDOW = 60.0
BODY_LIMIT = _env_int("BODY_LIMIT_KB", 256, 1, 8192) * 1024
MAX_HISTORY = _env_int("MAX_HISTORY", 50, 5, 500)
FW_TIMEOUT = _env_float("FW_TIMEOUT_S", 3.0)
if not 0.5 <= FW_TIMEOUT <= 30:
    print(f"[config] WARN FW_TIMEOUT_S invalid -> default 3.0", flush=True)
    FW_TIMEOUT = 3.0
FW_WORKERS = _env_int("FW_WORKERS", 1, 1, 8)
DB_PATH = os.path.join(HERE, "flags.db")

# ---------- state ----------
db_lock = threading.Lock()
db = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=5.0)
with db_lock:
    try:
        db.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass
    try:
        db.execute("PRAGMA busy_timeout=5000")
    except Exception:
        pass
    try:
        db.execute("PRAGMA synchronous=NORMAL")
    except Exception:
        pass
    db.execute("""CREATE TABLE IF NOT EXISTS flags(
        id INTEGER PRIMARY KEY AUTOINCREMENT, tt_id TEXT, user_id TEXT,
        username TEXT, text TEXT, verdict TEXT, score REAL, source TEXT,
        event_type TEXT, ts INTEGER)""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_flags_ts ON flags(ts)")
    # Retention: keep newest 5000 rows, drop older (unbounded growth fix).
    try:
        db.execute("DELETE FROM flags WHERE id <= "
                   "(SELECT MAX(id)-5000 FROM flags)")
    except Exception:
        pass
    db.commit()

chat_history: deque = deque(maxlen=MAX_HISTORY)   # clean only -> overlay
mod_history: deque = deque(maxlen=200)            # everything -> console
counters = {"received": 0, "allowed": 0, "blocked": 0, "flagged": 0,
            "forwarded": 0, "forward_errors": 0, "forward_skipped": 0,
            "dropped_sse": 0}
counters_lock = threading.Lock()
seen: deque = deque(maxlen=2000)                  # ring dedupe of comment ids
seen_set: set = set()                             # O(1) mirror of `seen`
seen_lock = threading.Lock()
sse_lock = threading.Lock()
sse_clients: dict[str, set] = {"chat": set(), "mod": set()}
history_lock = threading.Lock()
_event_seq = [0]  # monotonic seq under history_lock: orders SSE == history
MAX_SSE_CLIENTS = 200
battle_history: deque = deque(maxlen=20)   # latest battle_* events (any color)
_last_battle: list = [None]                # [battleId] of most recent battle


def record_battle(event: dict):
    """Append battle events to the ring for /api/battles + admin history."""
    meta = event.get("meta") or {}
    with history_lock:
        if meta.get("battleId"):
            _last_battle[0] = meta["battleId"]
        battle_history.append({
            "id": event.get("id"), "type": meta.get("eventType"),
            "battleId": meta.get("battleId"), "host": meta.get("battleHost"),
            "guest": meta.get("battleGuest"),
            "hostScore": meta.get("battleHostScore"),
            "guestScore": meta.get("battleGuestScore"),
            "room": meta.get("room"),
            "identitySource": meta.get("identitySource"),
            "text": (event.get("text") or "")[:160],
            "timestamp": event.get("timestamp"),
        })

# ---------- overlay control-plane (admin panel pushes, overlays apply live) --
OVERLAY_DEFAULTS = {"comments": False, "likes": True, "likes_every": 10,
                    "likes_show": 3, "anim": True, "confetti": True,
                    "max": 50, "alerts": 6000}
overlay_config = dict(OVERLAY_DEFAULTS)
overlay_lock = threading.Lock()


def _coerce_overlay(key, val):
    if key in ("comments", "likes", "anim", "confetti"):
        if isinstance(val, str):
            return val.strip().lower() not in ("0", "false", "no", "off", "")
        return bool(val)
    if key in ("likes_every", "likes_show", "max", "alerts"):
        try:
            n = int(val)
        except (ValueError, TypeError):
            return None
        if key == "likes_every":
            return max(3, min(120, n))
        if key == "likes_show":
            return max(1, min(120, n))
        if key == "max":
            return max(5, min(200, n))
        return max(0, min(60000, n))
    return None


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
    """Best-effort client IP. XFF honored only behind a trusted proxy.

    TRUST_PROXY=1 + TCP peer is loopback -> use first X-Forwarded-For hop
    (our own forwarder/Caddy sanitizes it). Otherwise TCP address wins.
    Default (TRUST_PROXY=0) ignores XFF entirely, so a tunneled attacker
    cannot rotate rate-limit buckets by spoofing headers."""
    tcp = (handler.client_address[0] if handler.client_address else "") or ""
    if TRUST_PROXY and _is_loopback(tcp):
        try:
            xff = (handler.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        except Exception:
            xff = ""
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


# --- polling gets its own generous budget (read-only overlay refresh) ---
# Overlays poll /api/feed every 1.5s (40/min each). Behind a tunnel every
# viewer shares one TCP peer, so the POST spam budget (60/min) would 429
# legitimate polls and gifts would silently vanish. Polls are cheap JSON.
_rl_get: dict[str, deque] = {}
GET_RATE_MAX = _env_int("GET_RATE_MAX", 300, 1, 100000)
GET_RATE_WINDOW = 60.0


def _get_limited(ip: str) -> bool:
    now = time.monotonic()
    with _rl_lock:
        dq = _rl_get.setdefault(ip, deque())
        while dq and now - dq[0] > GET_RATE_WINDOW:
            dq.popleft()
        dq.append(now)
        if len(_rl_get) > 5000:
            for k in [k for k, v in _rl_get.items()
                      if not v or now - v[-1] > GET_RATE_WINDOW * 10][:1000]:
                _rl_get.pop(k, None)
        return len(dq) > GET_RATE_MAX


# --- auth-failure logger with light throttling (no token values logged) ---
_auth_fail_last: dict[str, float] = {}
_auth_fail_lock = threading.Lock()


def _auth_fail(path: str, ip: str):
    now = time.monotonic()
    key = f"{path}|{ip}"
    with _auth_fail_lock:
        if now - _auth_fail_last.get(key, 0) <= 5:
            return
        _auth_fail_last[key] = now
        # Bound memory: drop idlest entries when abused (XFF rotation, scans).
        if len(_auth_fail_last) > 5000:
            cutoff = now - 600
            for k in [k for k, v in _auth_fail_last.items()
                      if v < cutoff][:1000]:
                _auth_fail_last.pop(k, None)
            # Still over cap (active flood): drop oldest arbitrarily.
            while len(_auth_fail_last) > 5000:
                _auth_fail_last.pop(next(iter(_auth_fail_last)), None)
    log(f"auth 401 {path} from {ip}")


def bump(key, n=1):
    with counters_lock:
        counters[key] = counters.get(key, 0) + n


def broadcast(channel: str, payload: dict, event: str = "message"):
    data = json.dumps(payload, ensure_ascii=False)
    frame = f"event: {event}\ndata: {data}\n\n".encode()
    with sse_lock:
        targets = list(sse_clients.get(channel, ()))
    dropped = 0
    for q in targets:
        try:
            q.put_nowait((event, frame))
        except queue.Full:
            dropped += 1
    if dropped:
        # Slow overlay silently misses messages (fail-open by design) —
        # count it so /api/stats exposes backpressure instead of hiding it.
        bump("dropped_sse", dropped)


def broadcast_config():
    with overlay_lock:
        cfg = dict(overlay_config)
    broadcast("chat", cfg, event="config")


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


def _db_maintenance():
    """Periodic retention + WAL checkpoint. Runs hourly on a daemon thread.

    Old code trimmed flags only once at startup: a long-lived stream grew
    unbounded (24 KB db + 362 KB wal observed). This keeps newest 5000,
    checkpoints WAL so -wal/-shm don't balloon, and never raises."""
    while True:
        try:
            time.sleep(3600)
            with db_lock:
                try:
                    db.execute("DELETE FROM flags WHERE id <= "
                               "(SELECT MAX(id)-5000 FROM flags)")
                    db.commit()
                except Exception as e:
                    log("!! sqlite retention failed:", e)
                try:
                    db.execute("PRAGMA wal_checkpoint(PASSIVE)")
                except Exception:
                    pass
        except Exception:
            time.sleep(60)


threading.Thread(target=_db_maintenance, daemon=True,
                 name="db-maintenance").start()


fwd_pool: queue.Queue | None = None   # upstream lane (FW_WORKERS drain it)
try:
    fwd_pool = queue.Queue(maxsize=200)
except Exception:
    fwd_pool = None

def _forward_worker(_wid=None):
    """Daemon drains the forward queue. Fail-open: drops + logs when full/down."""
    assert fwd_pool is not None
    suppressed = 0  # per-thread counter; bumps are atomic via bump()
    while True:
        try:
            comment, token = fwd_pool.get()
        except Exception:
            time.sleep(0.05)
            continue
        if not UPSTREAM:
            bump("forward_skipped")
            continue
        try:
            body = json.dumps(comment).encode()
            req = urllib.request.Request(
                UPSTREAM + "/api/comment", data=body, method="POST",
                headers={"Content-Type": "application/json",
                         **({"x-api-token": token} if token else {})})
            with urllib.request.urlopen(req, timeout=FW_TIMEOUT) as r:
                if r.status == 200:
                    bump("forwarded")
                    suppressed = 0
                else:
                    bump("forward_errors")
                    suppressed += 1
                    if suppressed <= 3 or suppressed % 50 == 0:
                        log(f"!! upstream responded {r.status} "
                            f"(fail-open, kept on overlay; {suppressed} total)")
                    elif suppressed == 4:
                        log("!! upstream errors suppressed (every 50th logged)")
        except Exception as e:
            bump("forward_errors")
            suppressed += 1
            if suppressed <= 3 or suppressed % 50 == 0:
                log(f"!! upstream forward failed "
                    f"(fail-open, kept on overlay; {suppressed} total): {e}")
            elif suppressed == 4:
                log("!! upstream errors suppressed (every 50th logged)")


if fwd_pool is not None:
    for _i in range(max(1, FW_WORKERS)):
        threading.Thread(target=_forward_worker, daemon=True,
                         name=f"upstream-forward-{_i}").start()


def forward_upstream(comment: dict, token: str) -> bool:
    """Best-effort forward of CLEAN messages. Fail-open: errors only logged.

    Returns True only when the payload was actually queued."""
    if not UPSTREAM or fwd_pool is None:
        if not UPSTREAM:
            bump("forward_skipped")
        return False
    try:
        fwd_pool.put_nowait((comment, token))
        return True
    except queue.Full:
        bump("forward_errors")
        log("!! upstream queue full (fail-open, kept on overlay)")
        return False


def _new_noid() -> str:
    """Collision-free id for payloads without a stable upstream id.

    Old code used f"noid-{ms}" — two distinct comments in the same ms
    collided and the second was dropped as a false duplicate. UUID suffix
    makes every generated id unique; such ids are never false-deduped."""
    return f"noid-{int(time.time() * 1000)}-{uuid.uuid4().hex[:12]}"


def process_comment(comment: dict, inbound_token: str) -> dict:
    """Verdict -> persist if red -> SSE -> async forward if allowed. Never raises."""
    t0 = time.monotonic()
    bump("received")
    raw_id = comment.get("id")
    # Missing/empty id: mint a unique one (never dedupe distinct chat).
    # Present id: dedupe O(1) via set mirror (deque alone was O(2000) scan).
    cid = str(raw_id) if raw_id else _new_noid()
    with seen_lock:
        if raw_id and cid in seen_set:
            return {"ok": True, "duplicate": True, "allowed": True, "verdict_ms": 0}
        if len(seen) == seen.maxlen:
            try:
                seen_set.discard(seen.popleft())
            except IndexError:
                pass
        seen.append(cid)
        seen_set.add(cid)

    verdict = moderate_comment(comment)
    ms = int((time.monotonic() - t0) * 1000)

    meta = comment.get("meta") or {}
    # Battle end frames carry no battleId: inherit the latest seen so the
    # overlay + history can attribute the winner to the right battle.
    if (meta.get("eventType") in ("battle_end", "battle_punish")
            and not meta.get("battleId")):
        with history_lock:
            if _last_battle[0]:
                meta = dict(meta, battleId=_last_battle[0])

    event = {"id": cid, "userId": comment.get("userId", "unknown"),
             "username": comment.get("username", "Unknown"),
             "text": comment.get("text", "") or "",
             "timestamp": comment.get("timestamp", int(time.time() * 1000)),
             "meta": meta,
             "verdict": verdict, "verdict_ms": ms}
    if (meta.get("eventType") or "").startswith("battle"):
        record_battle(event)

    if verdict.get("severity") == "red":
        bump("blocked")
        save_flag(comment, verdict)
        # Append + broadcast under ONE history_lock hold so concurrent
        # ingest threads cannot interleave SSE out of order vs history.
        # broadcast() only takes sse_lock (put_nowait, never blocks), so
        # lock order history -> sse is consistent and deadlock-free.
        with history_lock:
            _event_seq[0] += 1
            event["seq"] = _event_seq[0]
            mod_history.append(event)
            to_send = [("mod", event)]
        for ch, ev in to_send:
            broadcast(ch, ev)
        log(f"BLOCK [{verdict['verdict']}] @{event['username']}: {event['text'][:80]}")
        queued = False
    else:
        bump("allowed")
        if verdict.get("severity") == "yellow" or verdict.get("flagged"):
            bump("flagged")
        with history_lock:
            _event_seq[0] += 1
            event["seq"] = _event_seq[0]
            chat_history.append(event)
            mod_history.append(event)
            to_send = [("chat", event), ("mod", event)]
        for ch, ev in to_send:
            broadcast(ch, ev)
        # Forward the ENRICHED payload (inherited battleId included) so the
        # upstream avatar sees the same context as the overlay. Fail-open.
        fwd_comment = dict(comment, id=cid, meta=meta)
        queued = forward_upstream(fwd_comment, inbound_token)
    return {"ok": True, "allowed": verdict["allowed"], "verdict": verdict,
            "verdict_ms": ms,
            "forward_queued": queued}

class Handler(BaseHTTPRequestHandler):
    server_version = "AIMod/0.1"
    protocol_version = "HTTP/1.1"

    def _send(self, code, body=b"", ctype="application/json", extra=None,
              frame_deny=False, cors=False):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # Security headers (cheap, no behavior change for Studio/OBS/SSE):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if cors:
            # Public read endpoints only (chat feed + overlay config).
            # Mod endpoints never get ACAO: cross-origin reads stay blocked.
            self.send_header("Access-Control-Allow-Origin", "*")
        if ctype.startswith("text/html"):
            # Chat overlay must be embeddable as a Studio Link source.
            # media-src lets ?video= play local files + remote URLs.
            csp = ("default-src 'none'; style-src 'unsafe-inline'; "
                   "script-src 'unsafe-inline'; connect-src 'self'; "
                   "media-src 'self' https: data: blob:; "
                   "img-src data:; base-uri 'none'; form-action 'none'")
            if frame_deny:
                # Mod console must never be framed (clickjacking/phish).
                csp += "; frame-ancestors 'none'"
            self.send_header("Content-Security-Policy", csp)
            if frame_deny:
                self.send_header("X-Frame-Options", "DENY")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _json(self, code, obj, extra=None, cors=False):
        self._send(code, json.dumps(obj, ensure_ascii=False), extra=extra,
                   cors=cors)

    def _body_too_large(self, limit=None):
        if limit is None:
            limit = BODY_LIMIT
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            return False
        return n > limit

    def _read_raw(self, limit=None):
        """Read exactly Content-Length bytes. Loops: socket reads can
        short-read under load, and a partial JSON body becomes a bogus
        400 (observed as flapping 400s during PK floods). Returns bytes
        of exactly Content-Length, else None (length lied / EOF)."""
        if limit is None:
            limit = BODY_LIMIT
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > limit:
            return None
        try:
            chunks = []
            remaining = n
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            raw = b"".join(chunks)
            return raw if len(raw) == n else None
        except Exception:
            return None

    def _read_json(self, limit=None):
        raw = self._read_raw(limit)
        if raw is None:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def _read_json_reason(self, limit=None):
        """(body, reason): reason ∈ ok|empty|truncated|bad_json|bad_shape.
        Lets 400s say WHY so the bridge log stops guessing."""
        if limit is None:
            limit = BODY_LIMIT
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return None, "empty"
        if n > limit:
            return None, "too_large"
        raw = self._read_raw(limit)
        if raw is None:
            return None, "truncated"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            return None, "bad_json"
        if not isinstance(body, dict) or not isinstance(body.get("text"), str):
            # Return the parsed value too: caller logs its eventType.
            return body, "bad_shape"
        return body, "ok"

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

    def _has_valid_ingest_token(self) -> bool:
        """Trusted-sender check, no logging. The bridge posts every battle
        frame (~1/s in PK fights) + chat + gifts + likes from ONE IP; the
        anonymous 60/min POST budget 429s it and the overlay freezes
        minutes behind live (observed). Valid API_TOKEN skips the throttle;
        everyone else stays throttled (and still 401s without a token)."""
        if not REQUIRE_AUTH:
            return True
        try:
            return _check_token(self._provided_token(), API_TOKEN)
        except Exception:
            return False

    def _check_mod(self):
        """Gate for mod console + flags + stats + mod/all SSE.

        MOD_TOKEN if set (preferred). If unset: same-box loopback without
        proxy headers still passes (dev convenience); anything arriving via
        a proxy/tunnel is denied with 503 until MOD_TOKEN is configured —
        fail-closed, not fail-open. When TRUST_PROXY=0 (default) any
        X-Forwarded-For header is treated as untrusted and forces the 503
        path, so a tunneled attacker cannot launder a loopback bypass."""
        if not REQUIRE_AUTH:
            return ""
        tok = self._provided_token()
        if MOD_TOKEN and _check_token(tok, MOD_TOKEN):
            return tok
        if not MOD_TOKEN:
            tcp = (self.client_address[0] if self.client_address else "") or ""
            has_xff = bool((self.headers.get("X-Forwarded-For") or "").strip())
            if _is_loopback(tcp) and not has_xff:
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

    # NOTE: connection-noise swallowing lives on SingleInstanceServer
    # (handle_error), NOT here. socketserver calls handle_error on the
    # SERVER object — a same-named method on the request handler is dead
    # code and WinError 10053/10054 storms keep printing. Don't re-add here.

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, x-api-token, x-mod-token")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _history_snapshot(self, channel, since_id=None, limit=50):
        """Newest-first slice of the ring buffer for polling fallback.

        Cloudflare/ngrok free tunnels buffer SSE, so overlays behind a
        tunnel poll this instead. Localhost keeps SSE (instant)."""
        try:
            limit = max(1, min(200, int(limit)))
        except (ValueError, TypeError):
            limit = 50
        buf = chat_history if channel == "chat" else mod_history
        with history_lock:
            items = list(buf)
        if since_id:
            try:
                idx = next(i for i, e in enumerate(items)
                           if str(e.get("id")) == str(since_id))
                items = items[idx + 1:]
            except StopIteration:
                pass  # unknown id -> send recent window
        return items[-limit:]

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        path, q = u.path.rstrip("/") or "/", parse_qs(u.query)

        if path == "/healthz":
            return self._json(200, {"ok": True})
        if path in ("/api/feed", "/api/chat"):
            # Polling fallback: GET /api/feed?channel=chat&since=<id>&limit=50
            # chat = public (Studio needs it), mod/all = MOD_TOKEN gate.
            # Light GET throttle: 1.5s overlay pollers are fine, floods aren't.
            if _get_limited("GET:" + _client_ip(self)):
                return self._json(429, {"ok": False, "error": "rate limited"})
            channel = (q.get("channel", ["chat"])[0] or "chat").lower()
            if channel not in ("chat", "mod", "all"):
                channel = "chat"
            if channel in ("mod", "all"):
                if not MOD_CONSOLE:
                    return self._json(404, {"ok": False,
                                            "error": "mod console disabled"})
                gate = self._check_mod()
                if gate is False:
                    return  # 503 already sent
                if gate is None:
                    return self._json(401, {"ok": False,
                                            "error": "bad mod token"})
            return self._json(200, {
                "ok": True, "channel": channel,
                "messages": self._history_snapshot(
                    channel, q.get("since", [""])[0], q.get("limit", ["50"])[0]),
            }, cors=(channel == "chat"))
        if path == "/api/overlay-config":
            with overlay_lock:
                return self._json(200, {"ok": True, "config": dict(overlay_config)},
                                  cors=True)
        if path == "/api/stats":
            gate = self._check_mod()
            if gate is False:
                return  # 503 already sent
            if gate is None:
                return self._json(401, {"ok": False, "error": "bad mod token"})
            with counters_lock:
                snap = dict(counters)
            with history_lock:
                chat_n, mod_n = len(chat_history), len(mod_history)
                battle_n = len(battle_history)
            with sse_lock:
                sse_c, sse_m = len(sse_clients["chat"]), len(sse_clients["mod"])
            snap.update({"chat_buffered": chat_n,
                         "mod_buffered": mod_n,
                         "battle_buffered": battle_n,
                         "sse_chat": sse_c,
                         "sse_mod": sse_m})
            return self._json(200, snap)
        if path == "/api/flags":
            if not MOD_CONSOLE:
                return self._json(404, {"ok": False,
                                        "error": "mod console disabled"})
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
        if path == "/api/battles":
            if not MOD_CONSOLE:
                return self._json(404, {"ok": False,
                                        "error": "mod console disabled"})
            gate = self._check_mod()
            if gate is False:
                return  # 503 already sent
            if gate is None:
                return self._json(401, {"ok": False, "error": "bad mod token"})
            with history_lock:
                items = list(battle_history)
            return self._json(200, {"ok": True, "battles": items[-20:]})
        if path == "/events":
            channel = (q.get("channel", ["all"])[0] or "all").lower()
            if channel in ("mod", "all"):
                if not MOD_CONSOLE:
                    return self._json(404, {"ok": False,
                                            "error": "mod console disabled"})
                gate = self._check_mod()
                if gate is False:
                    return  # 503 already sent
                if gate is None:
                    return self._json(401, {"ok": False,
                                            "error": "bad mod token"})
            return self._sse(channel)
        if path == "/overlay/chat":
            return self._file("overlay_chat.html", "text/html; charset=utf-8")
        if path == "/overlay/admin":
            gate = self._check_mod()
            if gate is False:
                return  # 503 already sent
            if gate is None:
                return self._send(401,
                                  "<h1>admin locked</h1>"
                                  "<p>Append <code>?token=YOUR_MOD_TOKEN</code> "
                                  "to the URL.</p>",
                                  "text/html; charset=utf-8",
                                  frame_deny=True)
            return self._file("overlay_admin.html", "text/html; charset=utf-8",
                              frame_deny=True)
        if path == "/overlay/mod":
            if not MOD_CONSOLE:
                return self._send(404,
                                  "<h1>mod console disabled</h1>"
                                  "<p>Set <code>MOD_CONSOLE=1</code> in "
                                  "moderator/.env to re-enable.</p>",
                                  "text/html; charset=utf-8",
                                  frame_deny=True)
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
                                  "text/html; charset=utf-8",
                                  frame_deny=True)
            return self._file("overlay_mod.html", "text/html; charset=utf-8",
                              frame_deny=True)
        if path == "/media" or path.startswith("/media/"):
            # Serve local test clips from moderator/media/ for
            # ?video=/media/sample.mp4 . Range-aware (206) so browsers can
            # seek/stream without downloading the whole file. Basename only
            # (no traversal), video content-types only.
            from urllib.parse import unquote
            name = unquote(path[len("/media/"):] if path.startswith("/media/") else "")
            if not name or "/" in name or "\\" in name or ".." in name:
                return self._json(404, {"ok": False,
                                        "error": "use /media/<file.mp4>"})
            ctype = {"mp4": "video/mp4", "m4v": "video/mp4",
                     "mov": "video/quicktime",
                     "webm": "video/webm"}.get(name.rsplit(".", 1)[-1].lower(), "")
            if not ctype:
                return self._json(415, {"ok": False,
                                        "error": "mp4/mov/webm only"})
            fpath = os.path.join(HERE, "media", name)
            if not os.path.isfile(fpath):
                return self._json(404, {"ok": False, "error":
                                        "no such file (put it in moderator/media/)"})
            size = os.path.getsize(fpath)
            # One slow /media download holds a ThreadingHTTPServer thread.
            # Cap test clips at 200 MB so a stray 4 GB file can't pin threads.
            if size > 200 * 1024 * 1024:
                return self._json(413, {"ok": False,
                                        "error": "media file too large (200 MB cap)"})
            start, end = 0, size - 1
            status = 200
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                try:
                    spec = rng[len("bytes="):].split(",")[0].strip()
                    if spec.startswith("-"):
                        start = max(0, size - int(spec[1:]))
                    elif spec.endswith("-"):
                        start = int(spec[:-1])
                    else:
                        lo, hi = spec.split("-", 1)
                        start, end = int(lo), int(hi)
                    end = min(end, size - 1)
                    if 0 <= start <= end:
                        status = 206
                    else:
                        start, end, status = 0, size - 1, 200
                except (ValueError, IndexError):
                    start, end, status = 0, size - 1, 200
            length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range",
                                 f"bytes {start}-{end}/{size}")
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            if self.command != "HEAD" and length > 0:
                with open(fpath, "rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            return
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

    def _file(self, name, ctype, frame_deny=False):
        try:
            with open(os.path.join(HERE, name), "rb") as f:
                self._send(200, f.read(), ctype,
                           {"Cache-Control": "no-cache"},
                           frame_deny=frame_deny)
        except FileNotFoundError:
            self._json(404, {"ok": False, "error": f"{name} missing"})

    def _sse(self, channel):
        if channel not in ("chat", "mod", "all"):
            channel = "all"
        # Atomic check-and-add under one lock hold: concurrent connects can
        # no longer overshoot MAX_SSE_CLIENTS (old code released the lock
        # between count check and add).
        q: queue.Queue = queue.Queue(maxsize=200)
        with sse_lock:
            total = len(sse_clients["chat"]) + len(sse_clients["mod"])
            if total >= MAX_SSE_CLIENTS:
                over = True
            else:
                over = False
                if channel in ("chat", "all"):
                    sse_clients["chat"].add(q)
                if channel in ("mod", "all"):
                    sse_clients["mod"].add(q)
        if over:
            return self._json(503, {"ok": False,
                                    "error": "too many streams"})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            with history_lock:
                burst = list(chat_history if channel == "chat" else mod_history)
            for e in burst:
                self.wfile.write(
                    f"event: message\ndata: {json.dumps(e, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
            if channel in ("chat", "all"):
                with overlay_lock:
                    cfg = dict(overlay_config)
                self.wfile.write(
                    f"event: config\ndata: {json.dumps(cfg)}\n\n".encode())
                self.wfile.flush()
            while True:
                try:
                    _ev, frame = q.get(timeout=20)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(frame)
                self.wfile.flush()
        except (ConnectionError, BrokenPipeError, OSError):
            pass
        finally:
            self.close_connection = True
            with sse_lock:
                sse_clients["chat"].discard(q)
                sse_clients["mod"].discard(q)

    def do_POST(self):
        from urllib.parse import urlparse
        path = urlparse(self.path).path.rstrip("/") or "/"

        # Rate-limit POSTs per client IP (spam/DoS backstop). The trusted
        # bridge (valid API_TOKEN) bypasses: it legitimately posts >60/min
        # in battle-heavy streams and must never be throttled into 429s.
        ip = _client_ip(self)
        if not self._has_valid_ingest_token() and _rate_limited(ip):
            return self._json(429, {"ok": False, "error": "rate limited"})
        if self._body_too_large():
            # We have NOT consumed the oversized body — the unread bytes
            # would corrupt the next pipelined request on this HTTP/1.1
            # keep-alive connection. Close it; the client retries clean.
            self.close_connection = True
            return self._json(413, {"ok": False, "error": "body too large"})

        if path == "/api/overlay-config":
            gate = self._check_mod()
            if gate is False:
                return  # 503 already sent
            if gate is None:
                return self._json(401, {"ok": False, "error": "bad mod token"})
            body = self._read_json() or {}
            if not isinstance(body, dict):
                return self._json(400, {"ok": False, "error": "expected JSON"})
            updated = {}
            with overlay_lock:
                for k, v in body.items():
                    if k not in OVERLAY_DEFAULTS:
                        continue
                    cv = _coerce_overlay(k, v)
                    if cv is None:
                        continue
                    overlay_config[k] = cv
                    updated[k] = cv
                # likes_show can never exceed likes_every.
                if overlay_config["likes_show"] > overlay_config["likes_every"]:
                    overlay_config["likes_show"] = overlay_config["likes_every"]
                    updated["likes_show"] = overlay_config["likes_show"]
                cfg = dict(overlay_config)
            broadcast_config()
            log(f"overlay config: {updated}")
            return self._json(200, {"ok": True, "config": cfg})

        if path == "/api/overlay-cmd":
            gate = self._check_mod()
            if gate is False:
                return  # 503 already sent
            if gate is None:
                return self._json(401, {"ok": False, "error": "bad mod token"})
            body = self._read_json() or {}
            if not isinstance(body, dict) or body.get("cmd") != "reload":
                return self._json(400, {"ok": False,
                                        "error": "expected {\"cmd\": \"reload\"}"})
            broadcast("chat", {"cmd": "reload"}, event="overlay")
            log("overlay reload pushed")
            return self._json(200, {"ok": True})

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
                "id": body.get("id") or f"test-{uuid.uuid4().hex[:12]}",
                "userId": body.get("user", "tester"),
                "username": body.get("user", "tester"),
                "text": body.get("text", ""),
                "timestamp": int(time.time() * 1000),
                "meta": body.get("meta") or {"eventType": body.get("eventType", "comment")},
            }
            return self._json(200, process_comment(comment, token or ""))

        if path != "/api/comment":
            return self._json(404, {"ok": False, "error": "not found"})

        token = self._check_ingest()
        if token is None:  # wrong/missing token -> fail-closed 401
            return self._json(401, {"ok": False, "error": "bad api token"})
        body, reason = self._read_json_reason()
        if reason != "ok":
            # Fail-closed, but say WHY (truncated/bad_json/bad_shape/empty)
            # so bridge logs stop guessing. Truncated bodies also close the
            # keep-alive connection (unread remainder would poison pipelining).
            if reason == "truncated":
                self.close_connection = True
            try:
                et = (body.get("meta", {}) or {}).get("eventType") \
                    if isinstance(body, dict) else type(body).__name__
            except Exception:
                et = None
            log(f"ingest 400 ({reason})"
                + (f" eventType={et}" if et else ""))
            return self._json(400, {"ok": False,
                                    "error": "expected TikTokComment JSON",
                                    "reason": reason})
        raw_id = body.get("id")
        result = process_comment({
            "id": str(raw_id) if raw_id else _new_noid(),
            "userId": str(body.get("userId", "unknown")),
            "username": str(body.get("username", "Unknown")),
            "text": body.get("text", ""),
            "timestamp": body.get("timestamp", int(time.time() * 1000)),
            "meta": body.get("meta") if isinstance(body.get("meta"), dict) else {},
        }, token or "")
        result["ok"] = True
        self._json(200, result, {"X-Verdict-Ms": str(result.get("verdict_ms", 0))})


def self_check() -> int:
    """Startup self-test: pipeline + contract, no network, no side effects.

    Dry-run by design: exercises moderate_comment() directly so counters,
    histories, dedupe rings and the upstream forward queue are untouched.
    Old code called process_comment() and polluted prod state on every
    --check run. 0 = pass."""
    fails = []
    weak = API_TOKEN in ("", "changeme-use-same-value-in-bridge-env",
                         "changeme-generate-with-secrets-token_hex-32") or \
        (API_TOKEN and len(API_TOKEN) < 16)
    if REQUIRE_AUTH and (not API_TOKEN or weak):
        fails.append("API_TOKEN missing/weak (POST /api/comment will 401 everything)")
    if REQUIRE_AUTH and not MOD_TOKEN:
        fails.append("MOD_TOKEN unset (tunneled /overlay/mod + /api/flags refuse all)")
    cases = [
        ({"id": "chk-1", "userId": "u", "username": "u", "text": "hello!",
          "timestamp": 1, "meta": {"eventType": "comment"}}, True, "clean allowed"),
        ({"id": "chk-2", "userId": "u", "username": "u",
          "text": "CHECK http://bit.ly/x NOW", "timestamp": 1,
          "meta": {"eventType": "comment"}}, False, "link blocked"),
        ({"id": "chk-3", "userId": "u", "username": "u",
          "text": "[GIFT] @u sent Rose x1 (1)", "timestamp": 1,
          "meta": {"eventType": "gift"}}, True, "gift passthrough"),
    ]
    for comment, want_allowed, name in cases:
        try:
            got = moderate_comment(dict(comment))["allowed"]
            if bool(got) != want_allowed:
                fails.append(f"pipeline: {name} (want allowed={want_allowed})")
        except Exception as e:
            fails.append(f"pipeline raised on {name}: {e}")
    for f in fails:
        log(f"!! check: {f}")
    log("check: PASS" if not fails else f"check: {len(fails)} FAIL(s)")
    return 0 if not fails else 2


class SingleInstanceServer(ThreadingHTTPServer):
    """Refuse multi-bind on Windows (SO_REUSEADDR would silently shard).

    Without this, every re-run of a.bat starts a second moderator on the
    same :PORT and traffic splits randomly across processes (split-brain
    histories/counters/SSE). Fail fast instead.
    """
    allow_reuse_address = False

    def handle_error(self, request, client_address):
        """Swallow normal disconnect noise (SSE/poll aborts).

        Browsers, OBS and cloudflared constantly tear down keep-alive
        SSE/poll sockets (WinError 10053/10054, EPIPE). socketserver calls
        handle_error on the SERVER object, so this MUST live here — the
        same method on the request Handler is dead code (that trap cost
        us months of log storms).
        """
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError,
                            BrokenPipeError)):
            return
        if isinstance(exc, OSError) and exc.errno in (10053, 10054, 32):
            return
        try:
            super().handle_error(request, client_address)
        except Exception:
            pass

    def server_bind(self):
        import socket
        try:
            self.socket.setsockopt(
                socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        except (AttributeError, OSError):
            pass
        super().server_bind()


PID_PATH = os.path.join(HERE, ".pid")


def main():
    import sys
    if "--check" in sys.argv:
        raise SystemExit(self_check())
    try:
        srv = SingleInstanceServer(("0.0.0.0", PORT), Handler)
    except OSError as e:
        log(f"!! :{PORT} in use (another moderator running?) — "
            "close the old 'AI Moderator' window. "
            f"({e})")
        raise SystemExit(2)
    srv.daemon_threads = True
    try:
        with open(PID_PATH, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass
    weak = API_TOKEN in ("", "changeme-use-same-value-in-bridge-env") or \
        (API_TOKEN and len(API_TOKEN) < 16)
    if REQUIRE_AUTH and (not API_TOKEN or weak):
        log("!! API_TOKEN missing/weak: POST /api/comment + /api/test will 401 "
            "everything. Set a 32+ char secret in .env (same value in bridge).")
    if REQUIRE_AUTH and not MOD_TOKEN:
        log("!! MOD_TOKEN unset: /overlay/mod + /api/flags + /api/stats refuse "
            "all TUNNELED/proxied requests (503) until set. Localhost dev "
            "still works.")
    log(f"AI moderator on :{PORT} -> upstream {UPSTREAM or '(forwarding OFF)'} "
        f"(auth {'on' if REQUIRE_AUTH else 'OFF (REQUIRE_AUTH=0)'}, "
        f"api={_mask(API_TOKEN)}, mod={_mask(MOD_TOKEN)})")
    log("overlay/chat PUBLIC for Studio Link | "
        "overlay/admin needs ?token=MOD_TOKEN" +
        ("" if MOD_CONSOLE else " | mod console OFF (MOD_CONSOLE=0)"))
    if not MOD_CONSOLE:
        log("mod console disabled: /overlay/mod + /api/flags + mod/all feeds 404")
    _tunnel_url = ""
    try:
        with open(os.path.join(HERE, ".tunnel-url"), "r",
                  encoding="utf-8") as tf:
            _tunnel_url = tf.read().strip()
    except OSError:
        pass
    if _tunnel_url:
        log(f"public: {_tunnel_url}/overlay/chat (Studio) | "
            f"{_tunnel_url}/overlay/admin?token=… (control)")
    elif PUBLIC_BASE_URL:
        log(f"public: {PUBLIC_BASE_URL}/overlay/chat (Studio) | "
            f"{PUBLIC_BASE_URL}/overlay/admin?token=… (control)")

    def _tunnel_watcher(first: str):
        """Log tunnel URL rotations (a.bat rewrites .tunnel-url on restart).

        Old code read .tunnel-url once at boot: a QUIC reconnect that
        rotates the trycloudflare subdomain left the log (and any cached
        Studio link) stale with no notice. Poll mtime every 30 s."""
        last = first
        path = os.path.join(HERE, ".tunnel-url")
        mtime = None
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            pass
        while True:
            try:
                time.sleep(30)
                try:
                    mt = os.path.getmtime(path)
                except OSError:
                    if last:
                        log("tunnel: .tunnel-url gone (tunnel stopped?)")
                        last = ""
                    mtime = None
                    continue
                if mtime is not None and mt == mtime:
                    continue
                mtime = mt
                try:
                    with open(path, "r", encoding="utf-8") as tf:
                        cur = tf.read().strip()
                except OSError:
                    continue
                if cur != last:
                    last = cur
                    if cur:
                        log(f"public (rotated): {cur}/overlay/chat (Studio)")
                    else:
                        log("tunnel: URL cleared")
            except Exception:
                time.sleep(5)

    threading.Thread(target=_tunnel_watcher, args=(_tunnel_url,),
                     daemon=True, name="tunnel-watcher").start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("bye")
    finally:
        try:
            if os.path.isfile(PID_PATH):
                os.remove(PID_PATH)
        except OSError:
            pass


if __name__ == "__main__":
    main()

