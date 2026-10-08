# AI Moderator — filtering proxy + overlays (MVP)

Stdlib-only Python. No `pip install`, no build step — easy customer config.

## Quickstart (5 min, no live stream needed)

Easiest — from the repo root double-click **`run.bat`** (or `run.bat demo` to also
fire scripted chat/gift/spam at the overlay). It creates `moderator\.env` on first
run, opens both overlays in your browser, and starts the server.

Manual equivalent:

```powershell
cd moderator
copy .env.example .env        # set API_TOKEN to match your bridge/TTLive token
py server.py                  # -> http://localhost:3002
py demo.py http://localhost:3002 <API_TOKEN>   # scripted chat, gifts, spam
```

Open while `demo.py` runs:

| URL | What | Where to use |
|---|---|---|
| `http://localhost:3002/overlay/chat` | clean chat wall + gift alerts (transparent) | LIVE Studio `Add source > Link`, or OBS Browser Source |
| `http://localhost:3002/overlay/mod` | mod console: severity feed, review queue, stats | second monitor / another tab (never on stream) |
| `http://localhost:3002/api/stats` | counters JSON | curl / debugging |

## TikTok LIVE Studio setup (customer flow, ~2 min)

1. Start the moderator on the **same PC** as LIVE Studio (`py server.py`).
2. In LIVE Studio pick your Scene → **Add source → Link** → name it `AI Chat`.
3. Paste `http://localhost:3002/overlay/chat` → confirm.
4. Size: start `560 x 700` (companion) or `1080 x 1920` (fullscreen vertical),
   drag it **above** camera/game capture, keep faces and TikTok UI clear.
5. Send a test: `py demo.py` — chat + gift alerts should animate in Studio's preview.
6. Go live. Toxic/link/flood messages never reach this overlay.

OBS works with the same URL via **Browser Source** (transparent bg included).

## Production wiring (filtering proxy, per repo README §7)

```
TikTok LIVE → v3 bridge → POST :3002/api/comment → verdict
  allowed  → SSE to /overlay/chat AND forward to UPSTREAM_TTLIVE_URL/api/comment
  blocked  → SQLite flags.db + mod console only (TTLive never sees it)
```

- Bridge `.env`: `TTLIVE_URL=http://localhost:3002` (was the TTLive server).
- Moderator `.env`: `PORT`, `UPSTREAM_TTLIVE_URL` (= real TTLive server),
  same `API_TOKEN` on both hops. Fail-closed 401 on bad token.
- Fail-open: classifier/upstream errors pass the message through and log loudly.

## API

- `POST /api/comment` — accepts canonical `TikTokComment`
  `{id,userId,username,text,timestamp,meta}`. Header `x-api-token` (or `?token=`).
  Returns `{ok, allowed, verdict:{allowed,verdict,score,source,severity}}`.
- `GET /events?channel=chat|mod|all` — SSE stream. `chat` = clean only
  (overlay), `mod`/`all` = everything (console). Replays last N on connect.
- `GET /api/flags?limit=50&severity=red` — recent flags from SQLite.
- `GET /api/stats` / `GET /healthz`.
- `POST /api/test` — localhost-only inject `{user,text,eventType?,meta?}`
  for quick manual tests without auth.

## Test checklist

- [ ] `py demo.py` → overlay shows chat/gifts, hides spam + insults
- [ ] mod console shows red `link/wordlist/flood/insult`, yellow `caps`
- [ ] `TTLIVE never sees flagged text` — check upstream logs during test
- [ ] comment → decision p99 < 1.5 s (watch `X-Verdict-Ms` / server log)
- [ ] kill upstream server → chat still flows to overlay (fail-open), errors logged
- [ ] wrong API token → 401

## Notes / limits

- **Use `127.0.0.1`, not `localhost`, in URLs on Windows.** `urllib` pays ~2 s
  per call for the IPv6/DNS fallback, which crowds the 3 s forward timeout and
  slows the demo pacing. `server.py`/`demo.py` auto-rewrite `localhost` → `127.0.0.1`.
- Phone-only streams can't show overlays (needs Studio/OBS on a PC) — TikTok-side limit.
- `AI_PROVIDER=stub` is a regex stand-in. Wire Perspective/omni-moderation
  into `moderation.py::stub_ai` when ready; the verdict contract stays the same.
- Session-cookie warning bot / auto-ban are out of scope for v1 (see README §5).
