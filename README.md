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

- TikTok has **no official LIVE API** and **no third-party widget store** (no
  Twitch-Extensions equivalent). LIVE Studio's built-in widgets (alert source,
  chatbox, goal, leaderboard, countdown) are first-party only.
- Every third-party LIVE tool works the same way: **an external service reads
  the Webcast WebSocket** (the same data any viewer receives) **and renders
  results as an OBS Browser Source / web dashboard**.
- For an AI moderator that model is fine: reading events is enough to build a
  filtered chat + review queue. The only hard limit is **taking action** —
  programmatic comment deletion / bans are not officially supported (see
  [The hard part](#5-the-hard-part-taking-action)).
- MVP is genuinely weekend-sized for a single streamer; turning it into a SaaS
  is the real work.

---

## Architecture

```
TikTok LIVE stream
      │  Webcast WebSocket: chat · gifts · joins · likes · shares · follows
      ▼
Listener service
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

### A. Prototype — open source, free, DIY

Reverse-engineered libraries read the same Webcast WebSocket any viewer gets.
No login, no app registration — just the streamer's `@username`.

- Python: `TikTokLive` (isaackogan) — `py -m pip install TikTokLive`
- Node.js: `tiktok-live-connector` (Zerody)

```python
from TikTokLive import TikTokLiveClient
from TikTokLive.events import CommentEvent, GiftEvent

client = TikTokLiveClient(unique_id="@target_streamer")

@client.on(CommentEvent)
async def on_comment(event: CommentEvent):
    await moderate(event.user.unique_id, event.comment)

@client.on(GiftEvent)
async def on_gift(event: GiftEvent):
    if event.streaking:      # skip streak intermediates
        return
    log_gift(event.user.unique_id, event.gift.name, event.repeat_count)

client.run()
```

- **Pros:** free, instant start, full event surface.
- **Cons:** reverse engineering — TikTok changes signing/protocol without
  notice. Signing currently relies on a community server (Euler Stream) with
  free rate limits. Fine for 1-10 streams, risky as the backbone of a paid
  product.

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

All providers in this space are unofficial / not affiliated with TikTok.

**Plan: build the MVP on route A, switch to B when selling to streamers.**

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

---

## 3. The AI moderation pipeline

Two stages — cheap first, AI only when needed. This keeps cost and latency
sane on big streams.

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

A tiny HTTP server broadcasts events to the browser via SSE:

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

Reading is unsupported-but-reliable. **Writing is the wall:**

- No official endpoint to delete another user's comment or ban a user.
- Open-source libraries are read-only by design.
- Fully automating TikTok's internal moderation endpoints (emulator /
  Playwright driving the app) works technically but is a fast route to a
  suspended account — **not planned for v1**.

What real products do:

1. **Filtered view** — your overlay / dashboard *is* the clean chat; the
   streamer reads that instead of TikTok's chat. This alone is 80% of the
   value.
2. **Warning bot** — a dedicated TikTok account (moderator in the stream) posts
   `⚠️ @user please keep it friendly` when AI flags. Public-shame effect, works
   today with zero API access.
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

- [ ] Python listener (`TikTokLive`) for one hardcoded `@username`
- [ ] `local_rules()` + one AI classifier (Perspective or omni-moderation)
- [ ] Console log of verdicts
- [ ] `localhost:3333` OBS overlay with filtered chat + gift alerts
- [ ] SQLite table: `flags(user, text, verdict, score, ts)`
- [ ] Test: 1 hour on a live stream with a friend spamming toxic test messages

Out of scope for MVP: multi-stream, auth, billing, bot account, ban automation.

---

## 8. Roadmap

**v1 — single-streamer tool** (the MVP above).

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

*Concept doc written 2026-09-26. Everything here is unofficial and not
affiliated with TikTok / ByteDance.*


