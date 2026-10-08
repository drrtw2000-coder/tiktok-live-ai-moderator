# Upstream: TikTok LIVE capture (runnable input stage)

Source: `D:\repos\tiktok-events` (`v3` tree) — the battle-tested
`tiktok-live-connector` + Euler Stream signing stack (~1.5 yrs in production).

This directory is the **UPSTREAM input** of the pipeline:

```
TikTok LIVE --(bridge-to-ttlive.ts)--> moderator :3002 --(forward)--> TTLive :3001
     Webcast WebSocket: chat, gifts, joins, likes, shares, follows, Q&A
```

`vendor/tiktok-events-v3/` stays a **read-only reference snapshot** (do not
run from there). `upstream/` is the **runnable copy** — same sources, plus
`.env.example` / `run.bat` wired to the moderator.

## Files (copied verbatim from `tiktok-events/v3`, no edits)

- `server/tiktok/` — full capture pipeline:
  - `index.ts` → `createTikTokCapture(config, onComment)`
  - `connection-manager.ts` — connect/reconnect/wait-for-live/slow-poll,
    `signApiKey: config.eulerApiKey`
  - `event-emitter.ts` — SDK event registration, dedupe, join rate-limit,
    like batching, first-seen tracking
  - `event-normalizer.ts` — raw SDK → canonical `TikTokComment` (`[TAG]` text + `meta`)
  - `gift-aggregator.ts` — streak aggregation (30 s timeout, tombstones)
  - `tiktok-config.ts` — `TikTokConfig`, defaults, validation
  - `tiktok-types.ts` — connection/capture interfaces
  - `tiktok-client.ts` — 0-byte placeholder upstream; kept for structure
- `server/utils/logger.ts` — `log` used by the pipeline
- `shared/types.ts` — **canonical `TikTokComment` contract** (moderator's
  `POST /api/comment` accepts exactly this shape)
- `package.json` / `package-lock.json` / `tsconfig.json` — Node 20+, TS 5.4

## Scripts (runnable entry points, also verbatim)

- `bridge-to-ttlive.ts` — **the input**: connects to a LIVE stream, forwards
  every normalized event to `TTLIVE_URL/api/comment`. Point `TTLIVE_URL` at
  the **moderator** (`http://127.0.0.1:3002`), which forwards clean events on
  to the real TTLive server.
- `test-tiktok.ts` — read-only capture test (prints events, forwards nothing).
- `inject-comments.ts` / `inject-comments1.ts` — manual/scripted injectors
  (type chat or run dialog firehoses at any `/api/comment` endpoint).

## Quickstart

```powershell
cd upstream
copy .env.example .env   # set API_TOKEN (= moderator's), add Euler key for prod
npm install              # one-time: dotenv + tiktok-live-connector + ts-node
run.bat @streamername    # bridge -> moderator :3002 -> TTLive :3001
run.bat @streamername --wait  # not live yet: ENTER when live; ENTER retries if it drops
```

Or manually:

```powershell
npx ts-node bridge-to-ttlive.ts <tiktok-username>   # TTLIVE_URL from .env
npx ts-node test-tiktok.ts <tiktok-username>        # read-only, no forwarding
npx ts-node inject-comments.ts                      # manual inject (no LIVE needed)
```

## Env contract

| Var | Meaning |
|---|---|
| `TTLIVE_URL` | Bridge target. **Default `http://127.0.0.1:3002` (the moderator).** Never the TTLive server directly in the moderated chain. |
| `API_TOKEN` / `TTLIVE_API_TOKEN` | Same secret as moderator's `API_TOKEN`. Fail-closed 401 on mismatch. |
| `TIKTOK_EULER_API_KEY` | Euler Stream signing key (production stability; free tier is rate-limited without it). |

## Deliberately NOT copied

- `.env` / secrets (tokens stay local; only `.env.example` ships)
- `node_modules/`, `dist/`, `dump/`, `antigravity_output/`, logs, `debug_gifts.txt`
- `tsconfig.v3check.json` (upstream-only lint helper)

## Re-copy rule

Upstream is a live project. When `D:\repos\tiktok-events\v3` changes,
re-copy the verbatim files and update the SHA list below. Never edit the
pipeline sources here — local wiring lives only in `.env`, `run.bat`, and
this README.

## SHA256 (first 12 hex, verified at copy time)

- connection-manager.ts `E74ADE1EF3E0`
- event-emitter.ts `5D4D8F0686BF`
- event-normalizer.ts `E06A0509B4EC`
- gift-aggregator.ts `A51B63CE62F4`
- index.ts `549E51D7E545`
- tiktok-client.ts `01BA4719C80B` (empty upstream)
- tiktok-config.ts `3DEF18AF0DA0`
- tiktok-types.ts `1333A98FF0AB`
- logger.ts `071B3505A7DC`
- shared/types.ts `2A6F5B1142D5`
- bridge-to-ttlive.ts `AC25EBD0A61C`
- test-tiktok.ts `9BDEE0D23D62`
- inject-comments.ts `34B89A414261`
- inject-comments1.ts `42911F540BBB`
