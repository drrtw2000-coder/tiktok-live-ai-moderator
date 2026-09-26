/**
 * server/tiktok/tiktok-config.ts
 *
 * Centralized configuration for the TikTok LIVE event capture subsystem.
 *
 * ARCHITECTURE:
 *  - Reads from global config (server/config.ts) — all env vars prefixed TIKTOK_
 *  - Exports a typed TikTokConfig interface + extraction function
 *  - Three kill switches:
 *      TIKTOK_ENABLED=false     → entire system disabled (default)
 *      TIKTOK_ENABLE_GIFTS=false → gift events suppressed
 *      TIKTOK_ENABLE_BATTLES=false → battle events suppressed
 *
 * SIGNING REQUIREMENT:
 *  - tiktok-live-connector delegates WebSocket URL signing to Euler Stream.
 *  - "For most users, passing signApiKey to the TikTokLiveConnection
 *     constructor is enough."
 *  - Without a key: severely rate-limited free tier.
 *  - With a key: production-grade connection stability.
 *
 * SDK VERSION: tiktok-live-connector@^2.1.1
 *
 * Events available (confirmed from SDK types):
 *  WebcastEvent.CHAT, GIFT, MEMBER, LIKE, SOCIAL, ENVELOPE,
 *  QUESTION_NEW, LINK_MIC_BATTLE, LINK_MIC_ARMIES, LIVE_INTRO,
 *  SUBSCRIBE, FOLLOW, SHARE, ROOM_USER, EMOTE, BARRAGE,
 *  LINK_MIC_BATTLE_PUNISH_FINISH, LINK_MIC_BATTLE_TASK, etc.
 *
 *  ControlEvent.CONNECTED, DISCONNECTED, STREAM_END, ERROR,
 *  WEBSOCKET_CONNECTED, RAW_DATA, DECODED_DATA
 */

// ═════════════════════════════════════════════════════════════════════════════
//  TIKTOK CONFIG INTERFACE
// ═════════════════════════════════════════════════════════════════════════════

export interface TikTokConfig {
    // ── Core ──────────────────────────────────────────────────────
    /** Master kill switch. Default: false. */
    enabled:    boolean;
    /** TikTok @uniqueId of the streamer to connect to. Required when enabled. */
    username:   string;
    /** Euler Stream API key for WebSocket signing. Required for production. */
    eulerApiKey: string;

    // ── Event toggles ─────────────────────────────────────────────
    /** Enable gift events (WebcastEvent.GIFT). Default: true. */
    enableGifts:   boolean;
    /** Enable battle events (LINK_MIC_BATTLE, LINK_MIC_ARMIES, etc.). Default: true. */
    enableBattles: boolean;
    /** Enable social events (follow, share, join, subscribe). Default: true. */
    enableSocial:  boolean;
    /** Enable question events (QUESTION_NEW). Default: true. */
    enableQuestions: boolean;
    /** Enable like events (aggregated, not per-like). Default: false.
     *  Like events are extremely high volume — disabled by default. */
    enableLikes: boolean;

    // ── SDK options ───────────────────────────────────────────────
    /**
     * Fetch extended gift info (diamond values, names, images) on connect.
     * "You will receive additional information via the extendedGiftInfo
     * attribute when you enable the enableExtendedGiftInfo option."
     * Default: true.
     */
    enableExtendedGiftInfo: boolean;
    /**
     * Process initial data (backlog of events) on connect.
     * Useful for catching up on recent messages after reconnect.
     * Default: true.
     */
    processInitialData: boolean;

    // ── Connection resilience ─────────────────────────────────────
    /** Max reconnect attempts before switching to slow poll mode. Default: 10. */
    reconnectMaxAttempts: number;
    /** Base delay for exponential backoff on reconnect (ms). Default: 2000. */
    reconnectBaseDelayMs: number;
    /** Max reconnect delay cap (ms). Default: 60000. */
    reconnectMaxDelayMs: number;
    /**
     * Seconds between "is live?" polls when streamer is offline.
     * "Polls fetchIsLive every seconds seconds (minimum 30) until
     * the streamer goes live."
     * Default: 30.
     */
    livePollIntervalS: number;
    /** Timeout for HTTP requests to TikTok APIs (ms). Default: 10000. */
    httpTimeoutMs: number;
    /** Timeout for WebSocket connection (ms). Default: 10000. */
    wsTimeoutMs: number;

    // ── Gift aggregation ──────────────────────────────────────────
    /**
     * TTL for gift streak tracking (ms). If a streak hasn't updated
     * in this window, emit what we have (TikTok may have dropped
     * the final repeatEnd:true event). Default: 30000.
     */
    giftStreakTimeoutMs: number;

    // ── Rate limiting ─────────────────────────────────────────────
    /** Max join events forwarded per user per window. Default: 1. */
    joinRateLimitPerUser: number;
    /** Join rate limit window (ms). Default: 300000 (5 min). */
    joinRateLimitWindowMs: number;
    /** Like events are batched — minimum interval between like event
     *  emissions to the pipeline (ms). Default: 10000. */
    likeBatchIntervalMs: number;
    /**
     * Forward join events to the triage pipeline. Default: false.
     * When false, joins are still tracked internally (for isFirstTime
     * detection on subsequent comments/gifts) but do NOT enter the
     * pipeline. On high-traffic streams (470+ viewers) joins can flood
     * the pipeline at 1/sec even after rate-limiting.
     */
    enableJoinForwarding: boolean;

    // ── Health monitoring ─────────────────────────────────────────
    /** Max seconds without any event before marking connection stale. Default: 60. */
    staleConnectionThresholdS: number;
}

// ═════════════════════════════════════════════════════════════════════════════
//  DEFAULTS
// ═════════════════════════════════════════════════════════════════════════════

export const TIKTOK_DEFAULTS: Readonly<TikTokConfig> = Object.freeze({
    enabled:                false,
    username:               '',
    eulerApiKey:            '',

    enableGifts:            true,
    enableBattles:          true,
    enableSocial:           true,
    enableQuestions:         true,
    enableLikes:            false,

    enableExtendedGiftInfo: true,
    processInitialData:     true,

    reconnectMaxAttempts:   10,
    reconnectBaseDelayMs:   2_000,
    reconnectMaxDelayMs:    60_000,
    livePollIntervalS:      30,
    httpTimeoutMs:          10_000,
    wsTimeoutMs:            10_000,

    giftStreakTimeoutMs:    30_000,

    joinRateLimitPerUser:   1,
    joinRateLimitWindowMs:  300_000,
    likeBatchIntervalMs:    10_000,
    enableJoinForwarding:   false,

    staleConnectionThresholdS: 60,
});

// ═════════════════════════════════════════════════════════════════════════════
//  VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate a TikTokConfig. Returns an array of error strings.
 * Empty array = valid.
 */
export function validateTikTokConfig(cfg: TikTokConfig): string[] {
    const errors: string[] = [];

    if (!cfg.enabled) return errors; // Nothing to validate when disabled

    if (!cfg.username || cfg.username.trim().length === 0) {
        errors.push('TIKTOK_USERNAME is required when TIKTOK_ENABLED=true');
    }

    if (!cfg.eulerApiKey || cfg.eulerApiKey.trim().length === 0) {
        // Warning, not error — free tier works but is rate-limited
        errors.push(
            'TIKTOK_EULER_API_KEY is not set. Connection will use the severely ' +
            'rate-limited free tier. Get a key at https://www.eulerstream.com'
        );
    }

    if (cfg.livePollIntervalS < 30) {
        errors.push(
            `TIKTOK_LIVE_POLL_S=${cfg.livePollIntervalS} is below the minimum of 30. ` +
            'The SDK enforces a 30-second floor.'
        );
    }

    if (cfg.reconnectBaseDelayMs < 500) {
        errors.push(
            `TIKTOK_RECONNECT_BASE_MS=${cfg.reconnectBaseDelayMs} is too aggressive. ` +
            'Minimum recommended: 500ms to avoid rate limiting.'
        );
    }

    return errors;
}