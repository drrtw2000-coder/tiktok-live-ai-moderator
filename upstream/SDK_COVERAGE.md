# TikTok SDK data: what we use vs what we ignore

Source of truth for the read path. SDK = `tiktok-live-connector@^2.1.0`
(Zerody, unofficial reverse-engineering of TikTok's private Webcast
protobufs — there is no official TikTok API for any of this).
Connection signing via Euler Stream `signApiKey` (paid, holds the socket up).

Rule of thumb: if it's not in the tables below, we don't touch it.

---

## 1. Events: subscribed vs ignored

The SDK exposes ~40 Webcast events. We subscribe to 15 (11 gated by
`upstream/.env` flags, 4 always on). Everything else is never registered —
no handler, no traffic, no cost.

| SDK event | We subscribe? | Gate | What happens |
|---|---|---|---|
| `chat` | ✅ | always | → moderator `/api/comment` (the main input) |
| `gift` | ✅ | `enableGifts` | → streak aggregator → resolved gift → moderator |
| `linkMicBattle` | ✅ | `enableBattles` | → battle start (names/identity) |
| `linkMicArmies` | ✅ | `enableBattles` | → battle score updates |
| `linkMicBattlePunishFinish` | ✅ | `enableBattles` | → battle end (best-effort; not all SDK versions emit it) |
| `social` | ✅ | `enableSocial` | → shares |
| `follow` | ✅ | `enableSocial` | → follows (separate SDK event, not part of `social`) |
| `share` | ✅ | `enableSocial` | → shares (some SDK versions emit separately) |
| `member` | ✅ | `enableSocial` | → counted, then **dropped** (`enableJoinForwarding=false`) |
| `subscribe` | ✅ | `enableSocial` | → subscribers |
| `questionNew` | ✅ | `enableQuestions` | → questions |
| `like` | ✅ | `enableLikes` | → 10 s batches, one summary event |
| `roomUser` | ✅ | always | viewer count only, **never forwarded** (internal metric) |
| `emote` (`emoteChat`) | ✅ | always (no gate) | → low-priority emote lines |
| `decodedData` | ✅ | `enableBattles` | raw protobuf peek: anchorInfo escape hatch + schema-drift logging |
| control `connected/disconnected/streamEnd/error` | ✅ | always | reconnect logic, presence pill |
| `liveIntro` | ❌ | — | streamer intro card; no mod/overlay value |
| `envelope` (treasure box) | ❌ | — | promo/gambling box events; ignored |
| `hourlyRank`, `rankUpdate`, `rankText` | ❌ | — | leaderboard/ranking noise |
| `goalUpdate` | ❌ | — | follower/like goals; no consumer |
| `pollMessage` | ❌ | — | TikTok polls; no consumer |
| `captionMessage` | ❌ | — | auto-captions; no consumer |
| `roomMessage`, `roomPin`, `inRoomBanner` | ❌ | — | room announcements/pins; no consumer |
| `barrage` | ❌ | — | danmaku-style bursts; no consumer |
| `imDelete` (message deletes) | ❌ | — | TikTok-side deletions; we never see the deleter's reason, and our overlay is already filtered server-side |
| `unauthorizedMember` | ❌ | — | join-permission signalling; no consumer |
| `oecLiveShopping` | ❌ | — | shopping overlays; no consumer |
| `msgDetect` | ❌ | — | TikTok's own automod verdicts; we run our own pipeline |
| `linkMessage`, `linkLayer` | ❌ | — | co-host signalling plumbing |
| `linkMicBattleTask`, `linkMicFanTicketMethod`, `linkMicMethod` | ❌ | — | battle side-channels (tasks/tickets); scores come from `armies` |
| `roomVerify`, `superFan` | ❌ | — | verification/super-fan fluff |
| `controlMessage` (raw) | ❌ | — | consumed internally by the SDK for reconnects |

Production `bridge-to-ttlive.ts` forces all gates on **except**
`enableJoinForwarding` (joins counted for `isFirstTime`, never forwarded —
busy streams push ~1 join/sec of pure noise).

---

## 2. Per-event fields: used vs ignored

### `user` object (rides on every event)

| Field | Used? | Where it lands |
|---|---|---|
| `uniqueId` (@handle) | ✅ | `userId` (stable identity), flood limits, leaderboard keys |
| `userId` (numeric) | ✅ | fallback identity |
| `nickname` | ✅ | display name on overlay/cards |
| `followInfo.followerCount` | ✅ | `meta.followerCount` |
| `isModerator` | ✅ | moderation bypass (mods skip link/flood/spam/caps; still held to wordlist+AI) |
| `isSubscriber` | ✅ | carried in meta (trust-tier decisions) |
| `isNewGifter` | ✅ | carried in meta |
| `topGifterRank` | ✅ | carried in meta |
| `profilePictureUrl` | ✅ | carried in meta (not rendered yet) |
| `followRole` | ✅ | carried in meta |
| `followInfo.followingCount/followStatus` | ❌ | dropped at normalization |
| badges / `userBadges` / `userDetails` | ❌ | dropped (never read) |

### Chat
USED: `comment` (verbatim), `msgId` (stable dedupe id), `createTime`
(timestamp). IGNORED: everything else on the message.

### Gifts (via streak aggregator)
USED: `giftId`, `giftType`, `repeatCount`, `repeatEnd`, `diamondCount`
(+ extended gift info), `user`. `matchInfo` (PK 2x/3x/CRIT moments) is
passed through when the SDK sends it → `meta.giftMult/giftCrit` →
overlay ⚡ badge. IGNORED: tray/monitor/box/profit-timing internals
(`giftExtra`, `monitorExtra`, `giftsInBox`, `incomeTaskgifts`…).

### Battles
USED: `anchorInfo` (participant identity), `teamUsers` (host/guest side
mapping), `battleUsers` (v2 identity fallback), `battleId`,
`teamArmies` (authoritative totals — **empty in v3, always**),
`battleItems{anchorIdStr, hostScore, userArmy[]{score}}` (the actual v3
score data), `triggerCriticalStrike` (⚡ banner), `battleSettings`
(duration/start/end/overtime → countdown), `fromUserId/giftId/giftCount`
(frame context). IGNORED: `giftSentTime/scoreUpdateTime` (we stamp our
own arrival time), `repeatCount`, `totalDiamondCount` on armies frames,
`gifIconImage`, `fuzzyDisplayConfigV2` (TikTok's score-fuzzing config —
we show raw totals), `hasTeamMatchMvpSfx`, `logId`, `channelId`.

### Likes / joins / follows / shares / subscribes / questions / emotes
- Likes: only `likeCount` + `totalLikeCount`, emitted as one batch / 10 s.
  Individual liker identities are aggregated away.
- Joins: `userId` only (rate-limiter + first-seen); the join itself is
  dropped before the pipeline.
- Follows/shares/subscribes/questions/emotes: `user` + action only.
- RoomUser: `viewerCount` only (`topViewers` ignored).

---

## 3. Write API (sending chat / mod actions)

The installed SDK version **does** ship `client.sendMessage(content)`
(session-cookie auth: `sessionId` option). We **deliberately do not use
it**: cookie sessions expire in days, throttling is mandatory (~2 s),
and spam-shaped traffic risks the bot account's ban. Same reason there
is no auto-mute/ban/delete — no sanctioned endpoint exists, and the
product is designed human-in-the-loop (AI flags → overlay hides →
human clicks in TikTok's own panel). If this ever changes, it needs a
dedicated bot account + throttle queue, not a flag flip.

## 4. Volume policy (why some data is throttled, not forwarded 1:1)

| Stream | Policy | Reason |
|---|---|---|
| Gifts (streakable) | held 30 s, one emit on streak end | a x50 Rose would be 50 posts |
| Likes | 10 s batches | hundreds/sec at peak |
| Joins | 1/user/5 min, then dropped entirely | ~1/sec noise on busy streams |
| Battle updates | identical scores suppressed 10 s (keep-alive heartbeats) | heartbeat noise; real changes always pass |
| RoomUser | never forwarded | viewer-count metric only |

## 5. Known SDK data quirks (observed live, not assumed)

- `teamArmies` is always empty in v3 frames — scores come only from
  `battleItems` (per-anchor aggregates keyed by *gift sender*, with
  `anchorIdStr` pointing at the real participant).
- `battleItems` order is gift-sender order, **not** side order — naive
  positional mapping flip-flops host/guest (we pin sides per battle).
- `endTimeMs` is usually `"0"` (unset) — countdown falls back to
  `startTimeMs + duration`, then first-seen + duration.
- Mid-round score dips happen (observed 90→84) — real TikTok revisions,
  adopted when small (>50%), ignored near zero (partial-frame artifact).
- `linkMicBattlePunishFinish` is missing on some SDK versions — battle
  end also triggers on `battleStatus=2` and a 120 s idle watchdog.
