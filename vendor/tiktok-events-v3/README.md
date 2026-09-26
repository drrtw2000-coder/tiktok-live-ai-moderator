# Vendor snapshot: tiktok-events v3 (read-only reference)

Source: `D:\repos\tiktok-events` (`v3` tree), copied 2026-09-26.
Upstream: live project — do NOT edit here. Re-copy when it changes.

## Files (11)

- `shared/types.ts` — **canonical `TikTokComment` contract**. The moderator's
  proxy API (`/api/comment`) must accept exactly this shape.
- `server/tiktok/` — full capture pipeline, reference only:
  - `index.ts` → `createTikTokCapture(config, onComment)`
  - `connection-manager.ts` — connect/reconnect/wait-for-live/slow-poll,
    `signApiKey: config.eulerApiKey` (line ~660)
  - `event-emitter.ts` — SDK event registration, dedupe, join rate-limit,
    like batching, first-seen tracking
  - `event-normalizer.ts` — raw SDK → `TikTokComment` (`[TAG]` text + `meta`)
  - `gift-aggregator.ts` — streak aggregation
  - `tiktok-config.ts` — `TikTokConfig`, defaults, validation
    (likes off, joins tracked-not-forwarded, 30 s streak timeout…)
  - `tiktok-types.ts` — connection/capture interfaces
  - `tiktok-client.ts` — 0-byte placeholder upstream; kept for structure
- `server/utils/logger.ts` — `log` used by the pipeline
- `bridge-to-ttlive.ts` — reference wiring: `createTikTokCapture` →
  forward `TikTokComment` to a `/api/comment` endpoint. The moderator
  reuses this pattern (point `TTLIVE_URL` at the moderator; it forwards
  clean messages on to the real TTLive server).

## Deliberately NOT copied

- `.env` / secrets (API tokens stay in `tiktok-events`)
- `node_modules`, `dump/`, logs, `.txt` debug files
- `inject-comments*.ts` (test injector — lives upstream; moderator gets its
  own test client later)
- `test-tiktok.ts`

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
