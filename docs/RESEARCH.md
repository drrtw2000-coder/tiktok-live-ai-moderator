# Architecture review — thoughts, bottlenecks, optimizations

Date: 2026-10-15. Scope: read-only review, no code changed.
Covered: `moderator/server.py` (1353 lines), `moderator/moderation.py`,
`moderator/demo.py`, `moderator/overlay_chat.html` (~1300 lines),
`moderator/overlay_admin.html`, `moderator/overlay_mod.html`,
`upstream/bridge-to-ttlive.ts`, `upstream/server/tiktok/{connection-manager,event-emitter,event-normalizer,gift-aggregator,tiktok-config,tiktok-types,index}.ts`,
`upstream/shared/types.ts`, `a.bat` / `run.bat` / `upstream/run.bat`,
live `moderator/tunnel.log` / `cloudflared.err.log` / `server-preview.log` /
`server-restart.log`, `flags.db` sizes, `.env.example` files.

Pipeline:

```
TikTok LIVE --WS--> bridge (node, ts-node) --POST /api/comment--> moderator :3002 (py stdlib)
  moderator --POST--> TTLive :3001 (avatar)
  moderator --SSE /events + GET /api/feed--> /overlay/chat (Studio Link, PUBLIC)
  a.bat = moderator + cloudflared trycloudflare + bridge + browser tabs
```

## 1. What works well (keep)

- Fail-open everywhere: classifier/upstream errors pass chat through and log loudly
  (`moderator/server.py:406-444`, `moderation.py:213-216`). A filter outage never
  silences the stream or the avatar. Correct priority.
- Cheap-local-first moderation: wordlist/links/flood/caps before any AI
  (`moderation.py:142-174`). Right cost/latency shape for 10k+ events/min.
- Volume lessons already applied upstream: likes batched 10s
  (`event-emitter.ts:227-286`, default `likeBatchIntervalMs: 10000` in
  `tiktok-config.ts:151`), joins counted then dropped
  (`enableJoinForwarding=false`, `event-emitter.ts:787-790`), gifts held 30s to
  streak-end (`gift-aggregator.ts`, `giftStreakTimeoutMs: 30000`), battle
  keep-alive deduped 10s (`event-emitter.ts:977-986`), ring dedupes everywhere.
- Battle side-stability fix (anchor pinning + `room` tag + 120s watchdog) addresses
  a real observed flip-flop (`event-normalizer.ts:703-816`,
  `overlay_chat.html:941-999`). Good scar tissue.
- Auth hardening is thoughtful: constant-time compare, no full secrets in logs
  (`_mask`), XFF distrust by default, `?token=` for EventSource/Studio that can't
  set headers, mod console fail-closed 503 when `MOD_TOKEN` unset behind a tunnel
  (`server.py:702-729`). Comments explain *why*, not just *what*.
- `SingleInstanceServer` with `SO_EXCLUSIVEADDRUSE` prevents Windows silent
  split-brain double-bind (`server.py:1205-1243`). Real bug, real fix.
- `SDK_COVERAGE.md` (untracked at review time) is exactly the right doc: subscribed
  vs ignored events, used vs ignored fields, volume policy, observed SDK quirks.

## 2. P0 — breaks on a real big / PK-heavy stream

### 2.1 Public overlay can't scale behind the tunnel (one shared rate bucket)
- `moderator/server.py:244-259` (`_client_ip`): with `TRUST_PROXY=0` (the secure
  default) XFF is ignored, so **every** viewer via `cloudflared` appears as
  `127.0.0.1`.
- `server.py:286-301,780-781`: all remote `GET /api/feed` polls share one bucket,
  `GET_RATE_MAX=300/min`. Overlay polls every 1.5s (~40/min each,
  `overlay_chat.html:1243-1245`). **~7 concurrent remote viewers exhaust it**,
  further polls 429 and gifts silently vanish.
- SSE doesn't rescue this: Cloudflare buffers SSE, overlays already fall back to
  poll (`overlay_chat.html:1213-1230` comment). `cloudflared.err.log` proves it:
  endless `stream N canceled ... /events?channel=chat`.
- Directions: per-overlay identity (`cid=` + token bucket), split listeners
  (public chat-only port vs loopback admin port), on-box Caddy sanitizing XFF +
  `TRUST_PROXY=1`, or prefer SSE-healthy detection and back off polling.

### 2.2 Thread-per-SSE on `ThreadingHTTPServer` (thread exhaustion)
- `server.py:995-1051` (`_sse`): each SSE client holds its handler thread
  **forever** (`while True: q.get(timeout=20)`). `MAX_SSE_CLIENTS=200` = up to 200
  parked threads, plus ingest threads, 1–8 forward workers, and `/media` range
  downloads that each hold a thread (`server.py:963-972`). `ThreadingMixIn` is
  unbounded — bursts + reconnect herds = thread churn under GIL with contention
  on `history_lock` / `sse_lock` / `counters_lock` / `db_lock`.
- Overlay runs **SSE + poll in parallel** (`overlay_chat.html:1249-1255`) with
  client-side dedupe, so the server pays twice per message.
- `server-restart.log` WinError 10053 storms are the symptom;
  `SingleInstanceServer.handle_error` swallows them now, but the model is still
  wrong for fan-out. Long-term: single broadcaster thread / WS / asyncio server;
  short-term: lower SSE cap, localhost-only SSE, poll-primary behind tunnel.

### 2.3 Ingest is synchronous — hosted AI breaks the `<1.5s` target
- `server.py:479-553` (`process_comment`): `moderate_comment()` runs inline before
  `200 OK`. Stub regex is ~0ms so this is fine today; at Perspective/omni
  300–800ms (README §3 estimate) and ~166 msg/s, ~50–130 handler threads would sit
  parked on network. `X-Verdict-Ms` becomes queue time, bridge
  `httpAgent maxSockets:10` (`bridge-to-ttlive.ts:81-86`) backs up.
- Needed: `202 Accepted` + bounded internal queue + N classify workers + ordered
  emit via the existing `seq` (`server.py:527`), verdict cache LRU on
  `normalize(text)`, AI timeout ~800ms + fail-open, batch API where supported.

### 2.4 Forward lane: 1 worker, no keep-alive, queue 200
- `server.py:400-467`: `fwd_pool maxsize=200`, `FW_WORKERS=1` default,
  `urllib.request.urlopen` = **new TCP per clean message** (no pool, unlike the
  bridge side), `FW_TIMEOUT_S=3.0`. One slow TTLive stalls the lane; full queue =
  `forward_errors++` + drop (overlay kept, TTLive desyncs silently).
- `server-preview.log` shows the mode: `WinError 10061` per message when `:3001`
  is down (log-suppressed after 3, still a `bump()` + lock per drop).
- Bridge mirrors it: `forwardToTTLive` (`bridge-to-ttlive.ts:110-159`)
  fire-and-forget, no retry/backpressure/circuit-breaker, stats only every 60s.
  A slow moderator piles sockets on the bridge.

### 2.5 SQLite: single connection + global `db_lock` + WAL bloat (observed)
- `server.py:121-147,356-393`: one `sqlite3` connection, `db_lock` around every
  red `INSERT`. Observed: `flags.db 32KB` + `flags.db-wal 436KB` + `-shm 32KB`.
  Retention is hourly `DELETE ... MAX(id)-5000` + `PASSIVE` checkpoint only — a
  long stream grows WAL, readers block the writer, red bursts serialize all
  ingest threads on the lock.
- Directions: `wal_autocheckpoint`, periodic `TRUNCATE` checkpoint, single writer
  thread + `?mode=ro` readers, retention by age (GDPR story) not just row count.

### 2.6 Tunnel is demo-grade, not stream-grade (observed failures)
- `moderator/tunnel.log`: QUIC `timeout: no recent network activity` → 30s+
  reconnect loops; trycloudflare subdomain rotates per run. `server.py:1296-1338`
  watcher only **logs** rotation — the Studio Link source still points at the dead
  URL mid-stream.
- `cloudflared.err.log`: `Unable to reach the origin ... dial tcp 127.0.0.1:3002`
  when the moderator restarts — no auto-heal; free tier = no fixed domain, no
  access control, whole moderator (incl. `/api/*`, `/media/*`) publicly exposed.
- Needed: named tunnel + custom/reserved domain (stable Studio URL), split
  public/private listeners, liveness probe + auto-restart in `a.bat`.

## 3. P1 — moderation quality / correctness

- **Stub only.** `moderation.py:124-210`: 4 regexes + length/caps; double
  `stub_ai(text_n)` + `stub_ai(nospace)` per message. `AI_PROVIDER=stub|off` only.
  `BANNED` + thresholds load once at import (`moderation.py:34-40`) — env edits
  need restart; no per-streamer profile (roadmap v2 promises it, schema absent).
- **Handle-based flood gate.** `moderation.py:71,108-121`: `6 msgs/10s` per
  `userId` (= `@uniqueId`). Rotated handles or 2 accounts interleaved bypass it.
  No room-level bucket, no repeat-text similarity, no strike escalation.
- **Mod bypass too broad.** `moderation.py:157-158`: `isModerator` skips
  link/flood/spam/caps. Keep wordlist+AI (done) but still rate-limit mods at a
  higher bucket — compromised mod bypasses flood today.
- **Dedupe windows small for raids.** Moderator `seen maxlen=2000`
  (`server.py:155`), emitter `EventDeduplicator(2000)`, overlays `seen 2000`.
  At 10k/min ≈ 12s window; reconnect replay + `processInitialData` eviction =
  dupes reach TTLive/avatar. Gift IDs embed `Date.now()` (unique by design,
  `event-normalizer.ts:350`) — correct, relies fully on tombstone stack
  (`MAX 3/key, TTL 120s`).
- **Gift timer/memory unbounded.** `gift-aggregator.ts:141-144`: `streaks` map +
  per-streak `setTimeout`, no global cap. Gift-bomb raid = timer storm.
  Tombstone sweep is amortized 30s (fine at low volume).
- **Battle countdown overstates on late join.** `endTimeMs="0"` fallback
  (`overlay_chat.html:831-842`), single-anchor `0` frames need the `>50%`
  heuristic (`overlay_chat.html:975-978`); `linkMicBattlePunishFinish` missing on
  some SDKs (covered by `status=2` + watchdog — ok).
- **`ts-node` in prod** (`a.bat:195`, `upstream/run.bat`): slow boot, JIT, no
  build output. Ship compiled `dist/*.js`.
- **Floating SDK** (`tiktok-live-connector ^2.1.0`): minor drift already observed
  (`teamArmies` always empty in v3 — `SDK_COVERAGE.md`). Pin exact, keep
  `decodedData` drift logging (currently `debug` only) and promote to warn on
  unknown shapes.

## 4. P2 — ops / security / SaaS readiness

- **Auth footguns:** `?token=` in URL (logs/history/`Referer`),
  `MOD_TOKEN`→`API_TOKEN` fallback (`server.py:726`) weakens separation,
  `REQUIRE_AUTH=0` kills all auth (fine local, lethal tunneled — no guard).
  `/media/*` unauthenticated + thread-per-slow-download (200MB cap helps, no rate
  limit). Public `ACAO: *` correctly limited to chat/config; mod endpoints lack
  it (correct).
- **XSS surface is `esc()`-dependent.** All overlays use `innerHTML` + manual
  `esc()` — audited ok, but one missed path = stored XSS rendered live on
  stream. Prefer `textContent` (battle names already do).
- **Shallow health.** `/healthz` = `{"ok":true}` only. No db-ok, upstream
  reachability, TikTok state, `verdict_ms` histogram, `fwd_pool.qsize()`
  (exists, unexposed). Counters in-memory, lost on restart. No log rotation.
- **Windows-only ops.** `a.bat`/`run.bat` PowerShell probes, `for /f` `.env`
  parsing (space/quote fragile), stale `upstream/.bridge-*.lock` files linger
  (5 found, all dated 10/09 — cleaned locally 10/15, all gitignored), `.pid` with
  no staleness check (`SingleInstanceServer` fail-fast is good; `a.bat` reuses an
  old moderator without version/env check).
- **Single-stream only.** One bridge process per `@user`, lockfile warns on a
  second. SaaS needs a supervisor: N bridges, per-stream JWT, per-streamer
  wordlist/thresholds table (currently global env).
- **Thin tests.** `py server.py --check` = 3 cases, `demo.py` = ~20 scripted
  posts, no `pytest`/`jest`, no load harness for the claimed `p99 < 1.5s`.

## 5. Optimizations, ordered by leverage

1. **Ingest/emit split** (biggest win): bounded ingest queue (~2000) + `202`,
   N classify workers, ordered SSE via existing `seq`; verdict LRU on
   normalized text; AI timeout + fail-open; batch where the provider allows.
2. **Fix fan-out:** poll-primary behind tunnel, SSE localhost-only (or WS);
   single broadcaster thread; alert on `dropped_sse` (already counted).
3. **Forward lane:** default `FW_WORKERS=2-3` for big streams, persistent
   keep-alive pool, one log line per upstream outage (not per message), expose
   queue depth in `/api/stats`.
4. **Stable public URL:** named Cloudflare tunnel or reserved domain; separate
   public (chat only) vs loopback (admin) binds; tunnel liveness + auto-restart.
5. **DB:** autocheckpoint + `TRUNCATE`, writer thread, age-based retention.
6. **Quality without LLM first:** per-user strikes, last-N context for AI calls,
   trust tiers (subs/`topGifterRank<=3` skip spam heuristics, never wordlist+AI),
   strip zero-width chars (`\u200b-\u200d`, which NFKD+ascii misses).
7. **Bridge:** compiled JS, bounded forward queue (drop-oldest + counter),
   circuit-breaker after consecutive non-200s.
8. **Overlays:** `prefers-reduced-motion` confetti kill, DPR cap for Studio CEF,
   stop dual SSE+poll once SSE is healthy 30s.
9. **SaaS:** `flags(streamer_id, ...)`,
   `profiles(streamer_id, banned_json, thresholds_json)`, per-stream JWT instead
   of global `API_TOKEN`, one `docker compose` (bridge pool + moderator + TTLive)
   honoring the current env contract.

## 6. Verdict

Read path solved and well-hardened; human-in-the-loop write posture is correct;
small/medium streams are fine. Before advertising low-latency at scale, fix the
three coupled ceilings: **tunnel-shared rate bucket (~7 remote viewers),
thread-per-SSE + synchronous classify, single forward worker** — plus a stable
tunnel URL. Everything else is P1/P2.
