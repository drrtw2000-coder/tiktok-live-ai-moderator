# TikTok LIVE AI Moderator — Core Idea

**Status:** concept / scoping doc — no code yet.
**Repo owner:** @drrtw2000-coder

A third-party AI moderator for TikTok LIVE streams. It reads a stream's chat and
activity in real time, scores every message for toxicity, spam and rule breaks,
and gives the streamer two things TikTok doesn't:

1. **A clean chat** — an OBS overlay showing only messages that pass moderation.
2. **A fast mod dashboard** — severity flags, one-click enforcement, audit log.

---

## TL;DR

- TikTok has **no official LIVE chat/mod API** and **no third-party widget
  store** (no Twitch-Extensions equivalent). LIVE Studio's built-in widgets
  (alert source, chatbox, goal, leaderboard, countdown) are first-party only.
- **Reading is a solved, commercial problem.** The proven stack — running in
  production in the `tiktok-events` project for ~1.5 years — is the
  `tiktok-live-connector` library plus an **Euler Stream `signApiKey`**, a
  paid service (eulerstream.com) that signs the WebSocket connection so it
  holds up in production. Without a key the free tier is severely
  rate-limited.
- Every third-party LIVE tool therefore works the same way: **an external
  service reads the Webcast WebSocket** (the same data any viewer receives)
  **and renders results as a bridge, dashboard or overlay**.
- For an AI moderator, reading is enough to build a filtered chat + review
  queue. The **real limit is writing**: no sanctioned way to post replies,
  delete comments, or mute/ban — only fragile session-cookie hacks on
  internal endpoints (see
  [The hard part](#5-the-hard-part-taking-action)).
- MVP is weekend-sized — and most of it already exists in `tiktok-events` v3
  (see §7). Turning it into a SaaS is the real work.

---

## Architecture

```
TikTok LIVE stream
      │  Webcast WebSocket: chat · gifts · joins · likes · shares · follows
      ▼
Listener service — REUSE `tiktok-events` v3 capture, don't rebuild
      │      (async queue — never block the event loop; big streams push
      │       10k+ events/min, heavy work must be dropped or deferred)
      ▼
Moderation pipeline
  1. local rules      regex, banned words, links, caps/emoji spam,
                      per-user rate limits                       ~0 ms
  2. AI classifier    toxicity / intent / context                300-800 ms
      ▼
Action layer
  ├─ clean overlay for OBS   filtered chat, gift alerts, viewer count
  ├─ mod dashboard           severity flags, review queue, audit log
  └─ warning bot             separate TikTok account posts warnings
```

**End-to-end latency target: < 1.5 s from comment → decision.**

---

## Sections

1. [How to read TikTok LIVE chat](#1-how-to-read-tiktok-live-chat)
2. [Events you get for free](#2-events-you-get-for-free)
3. [The AI moderation pipeline](#3-the-ai-moderation-pipeline)
4. [The "widget" side: overlay + dashboard](#4-the-widget-side-overlay--dashboard)
5. [The hard part: taking action](#5-the-hard-part-taking-action)
6. [Account safety / ToS notes](#6-account-safety--tos-notes)
7. [MVP scope](#7-mvp-scope)
8. [Roadmap](#8-roadmap)

---

## 1. How to read TikTok LIVE chat

Two routes, both unofficial:

### A. The read stack: `tiktok-live-connector` + Euler Stream signing

The connector reads the same Webcast WebSocket any viewer gets. No TikTok
login, no app registration — just the streamer's `@username`. What makes it
production-grade is **Euler Stream**: a commercial signing service. You pass
its API key as `signApiKey` to the connection constructor and the WebSocket
holds up — this is the exact setup running in `tiktok-events` v2/v3 with no
issues (Euler's own guidance: "For most users, passing signApiKey to the
TikTokLiveConnection constructor is enough.").

- Node.js: `tiktok-live-connector@^2.1.x` (Zerody)
- Signing: Euler Stream key (`TIKTOK_EULER_API_KEY`); without it the free
  tier is severely rate-limited
- Alt for quick prototypes: Python `TikTokLive` (isaackogan)

```ts
import { TikTokLiveConnection, WebcastEvent }
  from 'tiktok-live-connector';

// Euler Stream signs the connection → production-grade stability
// (exact setup running in tiktok-events v2/v3)
const conn = new TikTokLiveConnection('@target_streamer', {
  signApiKey: process.env.TIKTOK_EULER_API_KEY,
});

conn.on(WebcastEvent.CHAT, (msg) => moderate(msg.user.uniqueId, msg.comment));
// … GIFT (streak-aware), MEMBER, SOCIAL, SUBSCRIBE, FOLLOW, SHARE,
// QUESTION_NEW, battles, likes …

await conn.connect();
```

- **Pros:** battle-tested (~1.5 years in `tiktok-events`), instant start,
  full event surface, commercial signing so connections hold.
- **Cons:** the data path is still unofficial (TikTok can change the Webcast
  protocol; Euler absorbs most of that). Free tier without a key is useless
  for production. And either way: **read-only** — the connector ships zero
  write methods, and the requested moderator API
  ([issue #258](https://github.com/zerodytrash/TikTok-Live-Connector/issues/258))
  was closed unimplemented.

### B. Production — managed LIVE API

Managed providers (Tik.Tools, Euler Stream) handle signing, reconnects,
protocol drift and scale; you get WebSocket + REST + webhooks behind an
API key / JWT.

```js
import { TikTokLive } from '@tiktool/live'

const client = new TikTokLive({
  uniqueId: 'target_streamer',
  apiKey: process.env.TIKTOOL_API_KEY,
})

client.on('chat', e => moderate(e.user.uniqueId, e.comment))
client.on('gift', e => logGift(e.user.uniqueId, e.giftName, e.diamondCount))
await client.connect()
```

All providers in this space are unofficial / not affiliated with TikTok. Their documented capabilities cover reads; message-sending or mod actions are not openly documented.

**Plan: no new listener — the MVP consumes `tiktok-events` v3's existing
capture pipeline as a filtering proxy (see §7). Route B stays an option for
a multi-tenant SaaS later: same shape (read WebSocket + REST), write access
not openly documented.**

---

## 2. Events you get for free

| Event | Payload highlights | Use for moderation |
|---|---|---|
| `CommentEvent` / chat | user, comment, badges | the main input |
| `GiftEvent` | gift name, repeat count, streak flags | alerts; reward / whitelist logic |
| `LikeEvent` | user, like count | engagement signals |
| `MemberEvent` / join | user | first-message gating, welcome |
| `FollowEvent` / `ShareEvent` | user | alerts |
| `RoomUserSeqEvent` | viewer count | scaling / load decisions |
| `SubscribeEvent` | subscriber info | trust tiers (skip checks) |
| `BattleEvent` (PK) | score, opponent | cross-stream moderation |
| +50 more | polls, captions, room pins, control msgs | future features |

Lifecycle: connect → `roomInfo`; stream ends → socket closes → poll
"is live" or use webhooks before reconnecting. Don't hammer reconnects.

> Rich context comes on the events themselves: `user` carries `isModerator`,
> `isSubscriber`, `topGifterRank`, badges and follow info, and (with
> extended gift info) diamond values — the `tiktok-events` normalizer
> already flattens all of this into `TikTokComment.meta` for the pipeline.

---

## 3. The AI moderation pipeline

Two stages — cheap first, AI only when needed. This keeps cost and latency
sane on big streams. Input is the **normalized `TikTokComment`** from the
v3 bridge (§7): `[TAG]`-prefixed text plus `meta` (event type, badges,
`isModerator`, `topGifterRank`).

```python
import re

BAD_WORDS = {"word1", "word2", ...}          # per-streamer config
LINK_RE   = re.compile(r"(https?://|www\.|t\.me/|discord\.gg/)")

def local_rules(user_id, text) -> tuple | None:
    if LINK_RE.search(text):                     return ("link",     0.9)
    if len(text) > 200 or text.count("!") > 8:   return ("spam",     0.8)
    if len(text) > 12 and text.isupper():        return ("caps",     0.6)
    if hits(BAD_WORDS, normalize(text)):         return ("wordlist", 0.95)
    if over_rate_limit(user_id):                 return ("flood",    0.9)
    return None

async def moderate(user_id, text):
    verdict = local_rules(user_id, text)
    if verdict is None and needs_ai(text):       # obscure case → AI
        score = await ai_classify(text)
        if score.toxicity > 0.8:
            verdict = ("toxic", score.toxicity)
    act(user_id, text, verdict)                  # overlay / dashboard / bot
```

### Choosing the classifier

| Option | Cost | Notes |
|---|---|---|
| Google Perspective API | free tier | purpose-built for toxic-comment scoring |
| OpenAI `omni-moderation` | ~free | broad categories, hosted |
| Detoxify (local, PyTorch) | free | runs on your box, private, no per-call latency |
| Llama Guard / small LLM | self-host | best context understanding, most work |

### Volume lessons (learned in `tiktok-events` v3)

- **Likes: off by default.** Like events are extremely high-volume; batch
  (10 s windows) or ignore them for moderation.
- **Joins: track, don't forward.** On busy streams joins flood (~1/sec);
  keep them for `isFirstTime` detection, don't feed the classifier.
- **Streak-aware gifts:** aggregate streakable gifts on a ~30 s timeout and
  act once on the final event.
- **Dedupe + no replays:** ring-buffer dedupe on message IDs, and
  `processInitialData=false` on reconnect to avoid backlog floods.
- **Reconnect discipline:** stale-connection detection, backoff with
  slow-poll fallback — see v3's `connection-manager.ts`. The moderator
  inherits all of this for free by reusing the pipeline.

### Hardening ideas

- Normalize before matching (leetspeak, padding, unicode homoglyphs).
- Per-user history: repeat offenders escalate automatically.
- Context window: send the previous N messages with the flagged one.
- Per-streamer scoring profile — a gaming stream tolerates different language
  than a kids' channel.
- Whitelist mods, top gifters and subscribers from the spam heuristics.

---

## 4. The "widget" side: overlay + dashboard

Do **not** try to inject into TikTok itself — you can't. Ship two UIs instead.

### a) OBS overlay (Browser Source)

**Proxy mode (recommended with `tiktok-events`):** instead of building a
separate SSE server, the moderator exposes the same `/api/comment` endpoint
the TTLive avatar server uses. Point `bridge-to-ttlive`'s `TTLIVE_URL` at
the moderator; it forwards only clean messages to the real TTLive server
(passing the API token through). Zero changes to `tiktok-events`, and the
avatar only ever "hears" clean chat.

Standalone alternative — a tiny HTTP server broadcasts events to the
browser via SSE:

```
listener → Express/SSE (/events) → overlay.html → OBS Browser Source
```

```js
// server.mjs
app.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  clients.add(res)
  req.on('close', () => clients.delete(res))
})

onVerdict(v => broadcast('chat', { user: v.user, text: v.text, ok: v.ok }))
```

`overlay.html` keeps the last ~50 messages, renders only `ok: true`, animates
gift alerts, shows viewer count. Filtering is server-side, so toxic text never
even reaches the browser source.

### b) Mod dashboard

Web page for the streamer / mod team:

- live feed colored by severity (green / yellow / red)
- click a flag → message context, user history, prior flags
- actions: hide from overlay (auto), warn, log; "ban" copies the username to
  TikTok's own mod panel (human-in-the-loop)
- SQLite log of every decision (audit + tuning data)

---

## 5. The hard part: taking action

**Reading is solved and commercial (`tiktok-events` runs it in prod).
Writing is the wall** — no sanctioned write API exists, and no
open-source library ships write methods:

- The connector has **zero** write methods; the request for mod methods
  ([issue #258](https://github.com/zerodytrash/TikTok-Live-Connector/issues/258))
  was closed unimplemented.
- Even real mods are limited: per that thread, a moderator can **mute and
  block** — there is **no single-message delete**.
- Managed APIs document reads; message-sending and mod actions are not
  openly documented.

The only proven write path is unofficial — **session-cookie bots**
([example](https://github.com/AutoFTbot/tiktok-ai-auto-reply-live)): run a
logged-in TikTok account, lift `TIKTOK_SESSION_ID` + `tt-target-idc` cookies
from a browser session, and call TikTok's internal `webcast.tiktok.com`
endpoints to post chat messages. Reality check from that project: cookies
expire in days, keep ~2 s between messages, and the account gets
banned/limited if it looks like spam. A **moderator account's** session is
the only route to mute/block actions — unproven in open source, same
fragility. UI automation (emulator / Playwright driving the real app) is
the other fallback — slower, same ban risk — **not planned for v1**.

What real products do:

1. **Filtered view** — your overlay / dashboard *is* the clean chat; the
   streamer reads that instead of TikTok's chat. This alone is 80% of the
   value.
2. **Warning bot** — a dedicated TikTok account (moderator in the stream) posts
   `⚠️ @user please keep it friendly` when AI flags, via the session-cookie
   pattern above (dedicated account, ~2 s throttling). Public-shame effect,
   works today.
3. **Human-in-the-loop** — AI flags with severity + reason; a human clicks ban
   in TikTok's UI. Roughly 10x faster than reading raw chat.

---

## 6. Account safety / ToS notes

- Use a **dedicated bot account**, never the streamer's main.
- Throttle bot messages; never look like spam — TikTok may suspend accounts
  that do.
- All live-event tooling in this space is unofficial and not endorsed by
  TikTok; document that for your users.
- Cache aggressively and dedupe; clients pull the same public websocket data
  as viewers, but abusive reconnection patterns get blocked.

---

## 7. MVP scope (weekend)

No new TikTok listener — `tiktok-events` v3 already captures, normalizes
(`TikTokComment`: `[TAG]`-prefixed text + `meta`), dedupes and bridges.
The moderator plugs in as a **filtering proxy** in front of the TTLive
avatar server:

```
TikTok LIVE → v3 capture/normalize → moderator /api/comment → verdict
    ok      → forward to TTLive server (unchanged feed)
    flagged → SQLite flags table + dashboard, dropped from forward
```

- [ ] HTTP service accepting `TikTokComment` JSON on `/api/comment`
      (same shape the bridge already posts)
- [ ] `local_rules()` + one AI classifier (Perspective or omni-moderation)
      over `text` + `meta` (event type, badges, `isModerator`…)
- [ ] Forward clean messages to the real `TTLIVE_URL` (API token passed
      through); point the bridge's `TTLIVE_URL` at the moderator
- [ ] SQLite table: `flags(user, text, verdict, score, ts)`
- [ ] Dashboard page: severity feed + review queue (overlay optional —
      the TTLive avatar already renders the clean feed)
- [ ] Test: 1 hour on a live stream with toxic test messages; verify drops,
      latency < 1.5 s, and that TTLive never sees flagged text

Out of scope for MVP: its own TikTok connection, multi-stream, auth,
billing, bot account, ban automation.

---

## 8. Roadmap

**v1 — single-streamer tool** (the proxy MVP above, reusing `tiktok-events` v3).

**v2 — SaaS:**
- managed LIVE API with per-streamer JWT, multi-stream concurrency
- web signup, streamer dashboard, Stripe billing
- per-streamer moderation profiles (wordlists, thresholds, whitelists for
  mods / top gifters)
- webhooks so streamers can plug in their own automations
- review queue + appeals, exportable audit log

**v3 — differentiators:**
- evasion detection (leetspeak, unicode homoglyphs, spaced-out words)
- semantic context (sarcasm, dog-whistles) via a small local LLM
- cross-stream reputation (known troll user IDs shared across customers)
- TTS readout of approved chat, auto-clip of moderation incidents

---

## Open questions

- Which managed API / signing provider, and what is pricing at 100+ concurrent
  streams?
- Classifier choice: hosted (simpler) vs local (cheaper, private)?
- Bot account strategy: one per streamer, or a shared pool?
- Where does the product live: overlay + dashboard only, or also an OBS plugin?
- Legal: GDPR / data-retention stance on stored chat logs?

## Effort estimate

MVP: ~1 weekend. Polished single-streamer product: 2-4 weeks. Multi-tenant
SaaS: months. The moat is moderation quality + fleet reliability, not the
WebSocket plumbing.

---

*Concept doc written 2026-09-26 (read/write corrections 2026-09-26).
Everything here is unofficial and not affiliated with TikTok / ByteDance.
Read path: `tiktok-live-connector` + Euler Stream commercial signing,
battle-tested in `tiktok-events` v2/v3.*


