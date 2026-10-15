// shared/types.ts
//
// Canonical pipeline types. Imported by:
//   - server/tiktok/event-normalizer.ts (produces TikTokComment)
//   - server/tiktok/event-emitter.ts (forwards TikTokComment)
//   - triage, orchestrator, Gemini, Hindsight (consumes TikTokComment)
//
// CommentMeta is the single interface for all event metadata.
// All fields are explicitly typed. The index signature [key: string]: unknown
// is retained for backward compatibility with consumers that assign
// dynamic properties — it should be removed once all consumers are
// migrated to use explicit fields only.

/**
 * Metadata attached to every TikTokComment.
 *
 * A plain chat comment will only have eventType='comment'.
 * Gifts, battles, follows, etc. populate their respective fields.
 *
 * Downstream consumers that only check the original fields
 * (followerCount, isSubscriber, isFirstTime, giftValue) are unaffected
 * by the addition of new fields.
 */
export interface CommentMeta {
    // ── Event classification ─────────────────────────────────────
    /**
     * Discriminator for event type routing.
     *
     * 'comment'       — standard chat message (default when undefined)
     * 'gift'          — completed gift (streak-end or non-streakable)
     * 'follow'        — new follower
     * 'share'         — stream shared
     * 'join'          — viewer joined
     * 'subscribe'     — new subscriber
     * 'question'      — question via Q&A feature
     * 'like_batch'    — aggregated likes
     * 'battle_start'  — battle initiated
     * 'battle_update' — battle score update
     * 'battle_end'    — battle ended (via status)
     * 'battle_punish' — battle punishment phase complete
     * 'emote'         — custom emote sent
     */
    eventType?: string;

    // ── User profile ─────────────────────────────────────────────
    /** From user.followInfo.followerCount. */
    followerCount?: number;
    /** Whether the user is a subscriber. */
    isSubscriber?: boolean;
    /**
     * True when this is the first interaction from this user in this session.
     * Set by event-emitter's FirstSeenTracker, NOT from the SDK.
     */
    isFirstTime?: boolean;
    /** Profile picture URL. */
    profilePictureUrl?: string;
    /**
     * Follow relationship to host:
     *  0 = none, 1 = following, 2 = friends (mutual follow).
     */
    followRole?: number;
    /** Whether the user is a room moderator. */
    isModerator?: boolean;
    /** Whether this is a new gifter (first-time gift sender in this room). */
    isNewGifter?: boolean;
    /** Top gifter rank (1-based), or null/undefined if unranked. */
    topGifterRank?: number | null;

    // ── Gift details ─────────────────────────────────────────────
    /**
     * Total diamond value of the gift.
     * For streakable: diamondCount × repeatCount (final).
     * For non-streakable: diamondCount × 1.
     * Used by computeRetainRelevance() in the orchestrator.
     */
    giftValue?: number;
    /** Human-readable gift name (e.g. "Rose", "Lion"). */
    giftName?: string;
    /** Diamond cost per single unit. */
    giftDiamonds?: number;
    /** Final repeat count for streakable gifts. */
    giftRepeatCount?: number;

    // ── Battle details ───────────────────────────────────────────
    /** Battle instance ID. */
    battleId?: string;
    /**
     * Battle status from SDK TriggerReason enum:
     *  0 = UNKNOWN, 1 = SCORE_UPDATE, 2 = BATTLE_END, 4 = KEEP_ALIVE
     */
    battleStatus?: number;
    /** Host team score. Set by normalizeBattleUpdate. */
    battleHostScore?: number;
    /** Guest team score. Set by normalizeBattleUpdate. */
    battleGuestScore?: number;
    /** Host participant nickname. Set by battle normalizers. */
    battleHost?: string;
    /** Guest participant nickname. Set by battle normalizers. */
    battleGuest?: string;
    /** Host participant user ID. Set by battle normalizers. */
    battleHostId?: string;
    /** Guest participant user ID. Set by battle normalizers. */
    battleGuestId?: string;
    /** Host @uniqueId (displayId). For home-side detection. */
    battleHostDisplayId?: string;
    /** Guest @uniqueId (displayId). For home-side detection. */
    battleGuestDisplayId?: string;
    /**
     * Which side is the watched streamer: 'host' | 'guest'.
     * Set by the emitter (it knows config.username). Overlay renders that
     * side LEFT, like TikTok. Absent when undeterminable (mid-battle join
     * without a start frame) — overlay falls back to ?home= then host-left.
     */
    battleHomeSide?: string;
    /** Base battle duration in seconds (BattleSetting). */
    battleDurationS?: number;
    /** Epoch ms when the battle ends (BattleSetting.endTimeMs). */
    battleEndsAt?: number;
    /** Epoch ms when the battle started (BattleSetting.startTimeMs). */
    battleStartMs?: number;
    /** Overtime seconds (BattleSetting.extraDurationSecond). */
    battleExtraS?: number;
    /** Crit/multiplier landed on this scoring play (armies frame). */
    battleCrit?: boolean;
    /** User whose gift triggered this armies frame. */
    battleFromUser?: string;
    /** Gift ID behind this armies frame. */
    battleGiftId?: string;
    /** Gift count behind this armies frame. */
    battleGiftCount?: number;
    /** Punish reason: 0 TIME_UP, 1 CUT_SHORT (or raw number). */
    battleEndReason?: string;
    /**
     * Gift multiplier moment from the gift's matchInfo (e.g. "2x", "3x",
     * "CRIT"). Absent when TikTok sends none — the connector only forwards
     * what the protobuf carries; there is no separate powerup event.
     */
    giftMult?: string;
    /** Gift landed on a critical/multiplier moment. */
    giftCrit?: boolean;
    /**
     * Watched room (@uniqueId, lowercased) this battle frame came from.
     * The moderator outlives bridge restarts/retargets and mixes rooms in
     * history — the overlay treats a room change like a new battle so a
     * stale bar from another streamer's room can never linger.
     */
    room?: string;
    /**
     * How battle participants were identified: 'teamUsers' (reliable) |
     * 'positional' (map order, 50/50 without team data) | 'battleUsers'.
     * Transparency for "host name wrong" reports — check this first.
     */
    identitySource?: string;
    /**
     * Diagnostic: which data source provided the battle scores.
     * Values: 'teamArmies', 'battleItems-mapped', 'battleItems-pinned',
     *         'battleItems-positional', 'battleItems-single', 'none'.
     * Consumers should NOT depend on this — it exists for debugging.
     */
    scoreSource?: string;

    // ── Like details ─────────────────────────────────────────────
    /** Number of likes in this batch event. */
    likeCount?: number;
    /** Cumulative total likes for the stream. */
    totalLikeCount?: number;

    // ── Live status ────────────────────────────────────────────
    /** Synthetic bridge event: 'live' | 'waiting' | 'connecting'. */
    liveState?: string;

    // ── Social details ───────────────────────────────────────────
    /** Social action type string from SDK. */
    socialAction?: string;
    /** Share destination type. */
    shareType?: string;
    /** Share target identifier. */
    shareTarget?: string;

    // ── Room info ────────────────────────────────────────────────
    /** Current viewer count (from ROOM_USER events). */
    viewerCount?: number;

    // ── SDK metadata ─────────────────────────────────────────────
    /**
     * Raw message ID from TikTok. Used for deduplication.
     * Distinct from TikTokComment.id which is generated by the capture system.
     */
    tiktokMsgId?: string;
    /** Message creation timestamp from TikTok (epoch seconds). */
    createTime?: number;

    // ── Backward compatibility ───────────────────────────────────
    /**
     * @deprecated Dynamic property access. All known properties should be
     * typed explicitly above. This index signature will be removed in a
     * future release once all consumers are verified to use typed fields.
     *
     * To add a new meta field: add it as an explicit optional property above,
     * do NOT rely on this escape hatch.
     */
    [key: string]: unknown;
}

/**
 * Normalized event flowing through the entire pipeline.
 *
 * Every TikTok event type (chat, gift, follow, battle, etc.) is
 * normalized into this shape. The meta.eventType field discriminates
 * between event types. The text field carries a human-readable
 * representation with [TAG] prefixes for triage filtering.
 */
export interface TikTokComment {
    /** Stable event ID. Format: tt-{type}-{stableKey}. Used for dedup. */
    id: string;
    /** User's @uniqueId (stable handle). For system events: 'system'. */
    userId: string;
    /** User's display nickname. For system events: 'TikTok'. */
    username: string;
    /** Human-readable event text. Chat comments are raw text; all others have [TAG] prefix. */
    text: string;
    /** Event timestamp (ms since epoch). Chat uses SDK createTime; others use Date.now(). */
    timestamp: number;
    /** Event-specific metadata. Always present for TikTok events. */
    meta?: CommentMeta;
}