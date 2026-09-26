/**
 * server/tiktok/event-emitter.ts
 *
 * Typed bridge between raw SDK events and the avatar pipeline.
 *
 * RESPONSIBILITIES:
 *  1. Register event handlers on TikTokLiveConnection for every event type.
 *  2. Apply config-based filtering (gifts enabled? battles enabled?).
 *  3. Route gifts through GiftAggregator before normalizing.
 *  4. Rate-limit join events (1/user/configurable window).
 *  5. Batch like events (aggregate into periodic summaries).
 *  6. Track first-seen users for isFirstTime detection.
 *  7. Deduplicate across reconnects (track last N event IDs).
 *  8. Call onComment(normalized) for events entering the pipeline.
 *  9. Track viewer count from ROOM_USER events.
 *  10. Emit connection lifecycle events (connected, disconnected, stream end).
 *
 * SDK EVENT REGISTRATION (confirmed from tiktok-live-connector@2.x):
 *
 *  connection.on(WebcastEvent.CHAT, (data) => ...)
 *  connection.on(WebcastEvent.GIFT, (data) => ...)
 *  connection.on(WebcastEvent.MEMBER, (data) => ...)
 *  connection.on(WebcastEvent.LIKE, (data) => ...)
 *  connection.on(WebcastEvent.SOCIAL, (data) => ...)
 *  connection.on(WebcastEvent.ROOM_USER, (data) => ...)
 *  connection.on(WebcastEvent.QUESTION_NEW, (data) => ...)
 *  connection.on(WebcastEvent.LINK_MIC_BATTLE, (data) => ...)
 *  connection.on(WebcastEvent.LINK_MIC_ARMIES, (data) => ...)
 *  connection.on(WebcastEvent.SUBSCRIBE, (data) => ...)
 *  connection.on(WebcastEvent.EMOTE_CHAT, (data) => ...)
 *  connection.on(ControlEvent.CONNECTED, () => ...)
 *  connection.on(ControlEvent.DISCONNECTED, () => ...)
 *  connection.on(ControlEvent.STREAM_END, () => ...)
 *  connection.on(ControlEvent.ERROR, ({ info, exception }) => ...)
 *
 * EVENT FLOW:
 *  SDK event → config filter → dedup → rate limit → normalize → onComment
 *                                  ↓ (gifts only)
 *                          GiftAggregator → normalize → onComment
 *
 * NEVER throws. All handler errors are caught and logged.
 */

import { TikTokConfig } from './tiktok-config';
import {
    TikTokCaptureStats,
    TikTokConnectionState,
    TikTokConnectionInfo,
} from './tiktok-types';
import { GiftAggregator, RawGiftEvent, ResolvedGift } from './gift-aggregator';
import {
    normalizeChat,
    normalizeGift,
    normalizeJoin,
    normalizeFollow,
    normalizeShare,
    normalizeSocial,
    normalizeSubscribe,
    normalizeQuestion,
    normalizeLikeBatch,
    normalizeBattleStart,
    normalizeBattleUpdate,
    normalizeBattleEnd,
    normalizeEmote,
    extractViewerCount,
    RawChatEvent,
    RawMemberEvent,
    RawSocialEvent,
    RawLikeEvent,
    RawQuestionEvent,
    RawBattleEvent,
    RawArmiesEvent,
    RawBattlePunishEvent,
    RawSubscribeEvent,
    RawRoomUserSeqEvent,
    RawEmoteEvent,
    BattleState,
} from './event-normalizer';
import { TikTokComment } from '../../shared/types';
import { log } from '../utils/logger';

// ═════════════════════════════════════════════════════════════════════════════
//  TYPES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Minimal interface for the SDK connection.
 * Avoids importing the full SDK type — decouples from version changes.
 */
export interface SDKConnection {
    on(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * Callbacks from the event emitter to the connection manager / index.
 */
export interface TikTokEventCallbacks {
    /** Called for every normalized event that should enter the triage pipeline. */
    onComment: (comment: TikTokComment) => void;
    /** Called when connection state changes. */
    onConnectionStateChange?: (state: TikTokConnectionState) => void;
    /** Called when viewer count updates. */
    onViewerCountUpdate?: (count: number) => void;
    /** Called when stream ends (CONTROL event). */
    onStreamEnd?: () => void;
    /** Called on SDK error. */
    onError?: (info: string, exception?: Error) => void;
}

// ═════════════════════════════════════════════════════════════════════════════
//  DEDUPLICATOR
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Ring-buffer deduplicator. Tracks last N event IDs to prevent
 * re-processing after reconnects (SDK may replay recent events
 * when processInitialData=true).
 */
class EventDeduplicator {
    private readonly seen = new Set<string>();
    private readonly ring: string[];
    private head = 0;
    private tail = 0;
    private count = 0;
    private readonly maxSize: number;

    constructor(maxSize = 2000) {
        this.maxSize = maxSize;
        this.ring = new Array<string>(maxSize);
    }

    /**
     * Returns true if this ID has been seen before.
     * Marks it as seen regardless.
     *
     * Uses a pre-allocated circular ring buffer for O(1) eviction
     * instead of Array.shift() which is O(N) and causes CPU spikes
     * at high event volumes.
     */
    checkAndMark(id: string): boolean {
        if (this.seen.has(id)) return true;

        this.seen.add(id);
        this.ring[this.tail] = id;
        this.tail = (this.tail + 1) % this.maxSize;

        if (this.count < this.maxSize) {
            this.count++;
        } else {
            // Buffer is full, evict the oldest (at head) in O(1)
            const oldest = this.ring[this.head];
            this.seen.delete(oldest);
            this.head = (this.head + 1) % this.maxSize;
        }
        return false;
    }

    clear(): void {
        this.seen.clear();
        this.head = 0;
        this.tail = 0;
        this.count = 0;
    }

    get size(): number { return this.seen.size; }
}

// ═════════════════════════════════════════════════════════════════════════════
//  RATE LIMITER (per-key, sliding window)
// ═════════════════════════════════════════════════════════════════════════════

class PerKeyRateLimiter {
    private readonly entries = new Map<string, number[]>();
    private readonly maxPerWindow: number;
    private readonly windowMs:     number;

    constructor(maxPerWindow: number, windowMs: number) {
        this.maxPerWindow = maxPerWindow;
        this.windowMs     = windowMs;
    }

    /** Returns true if the key is within rate limit (allowed). */
    allow(key: string): boolean {
        const now  = Date.now();
        let   hits = this.entries.get(key);

        if (!hits) {
            hits = [];
            this.entries.set(key, hits);
        }

        // Prune expired entries
        const cutoff = now - this.windowMs;
        while (hits.length > 0 && hits[0] < cutoff) hits.shift();

        if (hits.length >= this.maxPerWindow) return false;

        hits.push(now);
        return true;
    }

    /** Periodic cleanup of stale keys. Call from a timer. */
    cleanup(): void {
        const now    = Date.now();
        const cutoff = now - this.windowMs;

        for (const [key, hits] of this.entries) {
            while (hits.length > 0 && hits[0] < cutoff) hits.shift();
            if (hits.length === 0) this.entries.delete(key);
        }
    }

    clear(): void {
        this.entries.clear();
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  LIKE BATCHER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Aggregates high-volume like events into periodic batches.
 * Instead of forwarding every like event (can be hundreds/sec),
 * emits one summary event per batch interval.
 */
class LikeBatcher {
    private batchCount  = 0;
    private totalCount  = 0;
    private lastUser:     RawLikeEvent | null = null;
    private timer:        ReturnType<typeof setTimeout> | null = null;
    private readonly intervalMs: number;
    private readonly onFlush:    (lastUser: RawLikeEvent, batchCount: number, totalCount: number) => void;

    constructor(
        intervalMs: number,
        onFlush:    (lastUser: RawLikeEvent, batchCount: number, totalCount: number) => void,
    ) {
        this.intervalMs = intervalMs;
        this.onFlush    = onFlush;
    }

    add(data: RawLikeEvent): void {
        this.batchCount += data.likeCount ?? 1;
        this.totalCount  = data.totalLikeCount ?? this.totalCount;
        this.lastUser    = data;

        // Start timer on first event in batch
        if (!this.timer) {
            this.timer = setTimeout(() => this._flush(), this.intervalMs);
            if (typeof this.timer === 'object' && 'unref' in this.timer) {
                this.timer.unref();
            }
        }
    }

    private _flush(): void {
        this.timer = null;
        if (this.lastUser && this.batchCount > 0) {
            this.onFlush(this.lastUser, this.batchCount, this.totalCount);
        }
        this.batchCount = 0;
        this.lastUser   = null;
    }

    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this._flush();
        }
    }

    reset(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer      = null;
        this.batchCount = 0;
        this.totalCount = 0;
        this.lastUser   = null;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  FIRST-SEEN TRACKER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Tracks which users have been seen in this session.
 * Used to set meta.isFirstTime on the first interaction from a user.
 *
 * Note: "first time" is per-session, not per-lifetime. TikTok doesn't
 * expose a "first time viewer" flag. For cross-session first-time
 * detection, Hindsight's memory can be checked.
 */
class FirstSeenTracker {
    // Map preserves insertion order, allowing O(1) LRU eviction.
    // Caps memory at maxSize entries to prevent OOM during bot-army floods.
    private readonly seen = new Map<string, number>();
    private readonly maxSize: number;

    constructor(maxSize = 10_000) {
        this.maxSize = maxSize;
    }

    /**
     * Returns true if this is the first time this userId has been seen.
     * Marks them as seen regardless.
     */
    checkAndMark(userId: string): boolean {
        if (this.seen.has(userId)) {
            // Refresh LRU position (move to end of iteration order)
            this.seen.delete(userId);
            this.seen.set(userId, Date.now());
            return false;
        }

        // Evict oldest if at capacity
        if (this.seen.size >= this.maxSize) {
            const oldestKey = this.seen.keys().next().value;
            if (oldestKey !== undefined) this.seen.delete(oldestKey);
        }

        this.seen.set(userId, Date.now());
        return true;
    }

    clear(): void { this.seen.clear(); }
    get size(): number { return this.seen.size; }
}

// ═════════════════════════════════════════════════════════════════════════════
//  EVENT EMITTER
// ═════════════════════════════════════════════════════════════════════════════

export class TikTokEventEmitter {
    private readonly config:       TikTokConfig;
    private readonly callbacks:    TikTokEventCallbacks;
    private readonly giftAgg:      GiftAggregator;
    private readonly dedup:        EventDeduplicator;
    private readonly joinLimiter:  PerKeyRateLimiter;
    private readonly likeBatcher:  LikeBatcher;
    private readonly firstSeen:    FirstSeenTracker;
    private readonly cleanupTimer: ReturnType<typeof setInterval>;

    // ── Stats ─────────────────────────────────────────────────────
    private _viewerCount    = 0;
    private _connectedAt:     number | null = null;
    private _lastEventAt:     number | null = null;
    private _connectionState: TikTokConnectionState = 'disconnected';

    // ── Battle dedup ──────────────────────────────────────────────
    private _lastBattleScores: { host: number; guest: number } | null = null;
    private _lastBattleEmitAt = 0;
    private _lastBattleId: string | null = null;
    private _battleState: BattleState | null = null;

    // ── decodedData escape hatch for battle anchorInfo ────────────
    // Stores raw anchorInfo from WebcastLinkMicBattle protobuf.
    // Used when the SDK's typed event doesn't expose anchorInfo.
    private _pendingBattleAnchorInfo: Record<string, unknown> | null = null;

    private _stats = {
        comments:           0,
        gifts:              0,
        giftDiamonds:       0,
        follows:            0,
        shares:             0,
        joins:              0,
        subscribes:         0,
        questions:          0,
        likes:              0,
        battles:            0,
        emotes:             0,
        droppedDedup:       0,    // events caught by deduplicator (replays, reconnects)
        droppedJoins:       0,    // joins suppressed by rate limiter or forwarding gate
        droppedBattleDedup: 0,    // battle updates suppressed by score-change gate
        droppedOther:       0,    // other rate limiting
    };

    constructor(config: TikTokConfig, callbacks: TikTokEventCallbacks) {
        this.config    = config;
        this.callbacks = callbacks;
        this.dedup     = new EventDeduplicator(2000);
        this.firstSeen = new FirstSeenTracker();

        // Gift aggregator: emits resolved gifts → normalizeGift → onComment
        this.giftAgg = new GiftAggregator(
            (gift: ResolvedGift) => this._onGiftResolved(gift),
            config.giftStreakTimeoutMs,
        );

        // Join rate limiter: 1 per user per 5min (configurable)
        this.joinLimiter = new PerKeyRateLimiter(
            config.joinRateLimitPerUser,
            config.joinRateLimitWindowMs,
        );

        // Like batcher: aggregate into periodic summaries
        this.likeBatcher = new LikeBatcher(
            config.likeBatchIntervalMs,
            (lastUser, batchCount, totalCount) => {
                this._onLikeBatch(lastUser, batchCount, totalCount);
            },
        );

        // Periodic cleanup of rate limiter entries (every 60s)
        this.cleanupTimer = setInterval(() => this.joinLimiter.cleanup(), 60_000);
        if (typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
            this.cleanupTimer.unref();
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  REGISTRATION — bind all handlers to an SDK connection
    // ═════════════════════════════════════════════════════════════════

    /**
     * Register all event handlers on the SDK connection.
     *
     * Called once per connection (including reconnections).
     * The connection object is the TikTokLiveConnection instance.
     *
     * SDK uses string-based event names that match the enum values:
     *  WebcastEvent.CHAT = 'chat', WebcastEvent.GIFT = 'gift', etc.
     *  ControlEvent.CONNECTED = 'connected', etc.
     */
    register(connection: SDKConnection): void {
        // ── Control events ──────────────────────────────────────
        connection.on('connected', () => this._onConnected());
        connection.on('disconnected', () => this._onDisconnected());
        connection.on('streamEnd', () => this._onStreamEnd());
        connection.on('error', (data: unknown) => {
            const { info, exception } = (data ?? {}) as { info?: string; exception?: Error };
            this._onError(info ?? 'unknown', exception);
        });

        // ── Chat (always enabled) ───────────────────────────────
        connection.on('chat', (data: unknown) => {
            this._safeHandle('chat', () => this._onChat(data as RawChatEvent));
        });

        // ── Gifts ───────────────────────────────────────────────
        if (this.config.enableGifts) {
            connection.on('gift', (data: unknown) => {
                this._safeHandle('gift', () => this._onGift(data as RawGiftEvent));
            });
        }

        // ── Social (share) + Follow + Share (separate SDK events) ─
        if (this.config.enableSocial) {
            // 'social' catches shares (and any non-follow social actions)
            connection.on('social', (data: unknown) => {
                this._safeHandle('social', () => this._onSocial(data as RawSocialEvent));
            });

            // Follow is a SEPARATE event from social in the SDK.
            // Confirmed via diagnostic: SDK emits 'follow' independently.
            connection.on('follow', (data: unknown) => {
                this._safeHandle('follow', () => this._onFollow(data as RawSocialEvent));
            });

            // 'share' may also be emitted separately by some SDK versions
            connection.on('share', (data: unknown) => {
                this._safeHandle('share', () => this._onShare(data as RawSocialEvent));
            });

            connection.on('member', (data: unknown) => {
                this._safeHandle('member', () => this._onMember(data as RawMemberEvent));
            });

            // Subscribe is a separate event from social
            connection.on('subscribe', (data: unknown) => {
                this._safeHandle('subscribe', () => this._onSubscribe(data as RawSubscribeEvent));
            });
        }

        // ── Questions ───────────────────────────────────────────
        if (this.config.enableQuestions) {
            connection.on('questionNew', (data: unknown) => {
                this._safeHandle('question', () => this._onQuestion(data as RawQuestionEvent));
            });
        }

        // ── Likes ───────────────────────────────────────────────
        if (this.config.enableLikes) {
            connection.on('like', (data: unknown) => {
                this._safeHandle('like', () => this._onLike(data as RawLikeEvent));
            });
        }

        // ── Battles ─────────────────────────────────────────────
        if (this.config.enableBattles) {
            connection.on('linkMicBattle', (data: unknown) => {
                this._safeHandle('battle', () => this._onBattleStart(data as RawBattleEvent));
            });
            connection.on('linkMicArmies', (data: unknown) => {
                this._safeHandle('battleUpdate', () => this._onBattleUpdate(data as RawArmiesEvent));
            });
            // Battle punish finish — not all SDK versions emit this
            try {
                connection.on('linkMicBattlePunishFinish', (data: unknown) => {
                    this._safeHandle('battleEnd', () => this._onBattleEnd(data as RawBattlePunishEvent));
                });
            } catch {
                // SDK version may not support this event — non-fatal
            }
        }

        // ── Viewer count (always enabled — internal use) ────────
        connection.on('roomUser', (data: unknown) => {
            this._safeHandle('roomUser', () => {
                const count = extractViewerCount(data as RawRoomUserSeqEvent);
                this._viewerCount = count;
                this._lastEventAt = Date.now();
                this.callbacks.onViewerCountUpdate?.(count);
            });
        });

        // ── Emotes (low priority, no config gate) ───────────────
        connection.on('emote', (data: unknown) => {
            this._safeHandle('emote', () => this._onEmote(data as RawEmoteEvent));
        });

        // ── Raw protobuf access (schema drift detection + escape hatch) ─
        // The decodedData event fires for every protobuf message before
        // the SDK maps it. We use it for:
        //  1. Capturing anchorInfo from WebcastLinkMicBattle (participant identity)
        //  2. Detecting schema drift when score data is missing
        connection.on('decodedData', (eventName: unknown, decodedData: unknown) => {
            if (!this.config.enableBattles) return;
            const d = decodedData as Record<string, unknown>;

            if (eventName === 'WebcastLinkMicBattle') {
                // Escape hatch: capture anchorInfo from raw protobuf.
                // If the SDK's typed event doesn't expose anchorInfo,
                // _onBattleStart will merge this data.
                const anchorInfo = d?.anchorInfo as Record<string, unknown> | undefined;
                if (anchorInfo && Object.keys(anchorInfo).length > 0) {
                    this._pendingBattleAnchorInfo = anchorInfo;
                    log.debug('TIKTOK DECODED: linkMicBattle anchorInfo captured', {
                        anchorIds: Object.keys(anchorInfo),
                    });
                } else {
                    log.debug('TIKTOK DECODED: linkMicBattle has no anchorInfo', {
                        keys: Object.keys(d ?? {}),
                    });
                }
            }

            if (eventName === 'WebcastLinkMicArmies') {
                const battleItems = d?.battleItems as Record<string, unknown> | undefined;
                const teamArmies = d?.teamArmies as unknown[] | undefined;
                if ((!battleItems || Object.keys(battleItems).length === 0) && (!teamArmies || teamArmies.length === 0)) {
                    log.debug('TIKTOK SCHEMA DRIFT: linkMicArmies has no score data', {
                        keys: Object.keys(d ?? {}),
                    });
                }
            }
        });

        log.info('TIKTOK EVENTS REGISTERED', {
            gifts:     this.config.enableGifts,
            battles:   this.config.enableBattles,
            social:    this.config.enableSocial,
            questions: this.config.enableQuestions,
            likes:     this.config.enableLikes,
        });
    }

    // ═════════════════════════════════════════════════════════════════
    //  EVENT HANDLERS
    // ═════════════════════════════════════════════════════════════════

    private _onConnected(): void {
        this._connectionState = 'connected';
        this._connectedAt     = Date.now();
        log.info('TIKTOK CONNECTED');
        this.callbacks.onConnectionStateChange?.('connected');
    }

    private _onDisconnected(): void {
        this._connectionState = 'disconnected';
        log.warn('TIKTOK DISCONNECTED');
        this.callbacks.onConnectionStateChange?.('disconnected');
    }

    private _onStreamEnd(): void {
        this._connectionState = 'disconnected';
        log.info('TIKTOK STREAM END');
        this.callbacks.onStreamEnd?.();
        this.callbacks.onConnectionStateChange?.('disconnected');
    }

    private _onError(info: string, exception?: Error): void {
        // Don't log here — connection manager logs via the onError callback.
        // Logging in both places produces duplicate error lines.
        this.callbacks.onError?.(info, exception);
    }

    // ── Chat ────────────────────────────────────────────────────

    private _onChat(data: RawChatEvent): void {
        this._lastEventAt = Date.now();

        // Filter empty/whitespace-only comments — avatar shouldn't respond to blanks
        if (!data.comment || data.comment.trim().length === 0) return;

        const comment = normalizeChat(data);

        // Dedup
        if (this.dedup.checkAndMark(comment.id)) {
            this._stats.droppedDedup++;
            log.debug('TIKTOK CHAT DEDUP DROP', { id: comment.id, userId: comment.userId });
            return;
        }

        // First-seen tracking
        if (this.firstSeen.checkAndMark(comment.userId) && comment.meta) {
            comment.meta.isFirstTime = true;
        }

        this._stats.comments++;
        this.callbacks.onComment(comment);
    }

    // ── Gifts ───────────────────────────────────────────────────

    private _onGift(data: RawGiftEvent): void {
        this._lastEventAt = Date.now();

        // DIAGNOSTIC: dump raw SDK gift fields at debug level.
        // Run with LOG_LEVEL=debug to diagnose diamond=1 bug.
        // This reveals which fields (giftDetails vs extendedGiftInfo vs direct)
        // the SDK actually populates so we can fix the resolution chain.
        log.debug('TIKTOK RAW GIFT', {
            giftId:              data.giftId,
            giftName:            data.giftName,
            giftType:            data.giftType,
            diamondCount:        data.diamondCount,
            repeatCount:         data.repeatCount,
            repeatEnd:           data.repeatEnd,
            describe:            data.describe,
            hasGiftDetails:      !!data.giftDetails,
            giftDetailsDiamonds: data.giftDetails?.diamondCount,
            giftDetailsName:     data.giftDetails?.giftName,
            giftDetailsType:     data.giftDetails?.giftType,
            hasExtendedGiftInfo: !!data.extendedGiftInfo,
            extendedDiamonds:    data.extendedGiftInfo?.diamondCount,
            extendedName:        data.extendedGiftInfo?.name,
            rawKeys:             Object.keys(data as unknown as Record<string, unknown>),
        });

        // Route through aggregator — it calls _onGiftResolved when ready
        this.giftAgg.process(data);
    }

    private _onGiftResolved(gift: ResolvedGift): void {
        const comment = normalizeGift(gift);

        // Dedup (gift IDs are generated, but protect against double-resolve)
        if (this.dedup.checkAndMark(comment.id)) {
            this._stats.droppedDedup++;
            return;
        }

        // First-seen tracking
        if (this.firstSeen.checkAndMark(comment.userId) && comment.meta) {
            comment.meta.isFirstTime = true;
        }

        this._stats.gifts++;
        this._stats.giftDiamonds += gift.totalDiamonds;

        // Use debug (not info) — the test runner's displayEvent() already shows
        // a GIFT line; info here produces duplicate output in the test console.
        log.debug('TIKTOK GIFT RESOLVED', {
            from:     gift.nickname || gift.uniqueId,
            gift:     gift.giftName,
            count:    gift.repeatCount,
            diamonds: gift.totalDiamonds,
            via:      gift.resolvedVia,
        });

        this.callbacks.onComment(comment);
    }

    // ── Social (shares via 'social' event) ───────────────────────

    private _onSocial(data: RawSocialEvent): void {
        this._lastEventAt = Date.now();

        // 'social' event mainly carries shares. If a follow slips through
        // (some SDK versions), normalizeSocial routes it correctly.
        const comment = normalizeSocial(data);

        if (this.dedup.checkAndMark(comment.id)) {
            this._stats.droppedDedup++;
            return;
        }

        if (this.firstSeen.checkAndMark(comment.userId) && comment.meta) {
            comment.meta.isFirstTime = true;
        }

        if (comment.meta?.eventType === 'follow') {
            this._stats.follows++;
        } else {
            this._stats.shares++;
        }

        this.callbacks.onComment(comment);
    }

    // ── Follow (dedicated SDK event) ────────────────────────────

    private _onFollow(data: RawSocialEvent): void {
        this._lastEventAt = Date.now();

        const comment = normalizeFollow(data);

        if (this.dedup.checkAndMark(comment.id)) {
            this._stats.droppedDedup++;
            return;
        }

        if (this.firstSeen.checkAndMark(comment.userId) && comment.meta) {
            comment.meta.isFirstTime = true;
        }

        this._stats.follows++;
        this.callbacks.onComment(comment);
    }

    // ── Share (dedicated SDK event) ─────────────────────────────

    private _onShare(data: RawSocialEvent): void {
        this._lastEventAt = Date.now();

        const comment = normalizeShare(data);

        if (this.dedup.checkAndMark(comment.id)) {
            this._stats.droppedDedup++;
            return;
        }

        if (this.firstSeen.checkAndMark(comment.userId) && comment.meta) {
            comment.meta.isFirstTime = true;
        }

        this._stats.shares++;
        this.callbacks.onComment(comment);
    }

    // ── Member (join) ───────────────────────────────────────────

    private _onMember(data: RawMemberEvent): void {
        this._lastEventAt = Date.now();

        const userId = data.user?.uniqueId || data.user?.userId || '';

        // Always track first-seen — even when not forwarding joins, we want
        // isFirstTime to work correctly on subsequent comments/gifts from this user.
        const isFirst = this.firstSeen.checkAndMark(userId);

        // Rate limit: 1 join per user per window
        if (!this.joinLimiter.allow(userId)) {
            this._stats.droppedJoins++;
            log.debug('TIKTOK JOIN RATE LIMITED', { userId, username: data.user?.nickname as string });
            return;
        }

        this._stats.joins++;

        // Only forward to pipeline if explicitly enabled.
        // Default is false — on high-traffic streams (470+ viewers) join events
        // flood the pipeline at 1/sec even after rate-limiting.
        if (!this.config.enableJoinForwarding) {
            log.debug('TIKTOK JOIN SUPPRESSED (enableJoinForwarding=false)', { userId });
            return;
        }

        const comment = normalizeJoin(data);

        if (this.dedup.checkAndMark(comment.id)) {
            this._stats.droppedJoins++;
            return;
        }

        if (comment.meta) {
            comment.meta.isFirstTime = isFirst;
        }

        this.callbacks.onComment(comment);
    }

    // ── Subscribe ───────────────────────────────────────────────

    private _onSubscribe(data: RawSubscribeEvent): void {
        this._lastEventAt = Date.now();

        const comment = normalizeSubscribe(data);

        if (this.dedup.checkAndMark(comment.id)) {
            this._stats.droppedDedup++;
            return;
        }

        if (this.firstSeen.checkAndMark(comment.userId) && comment.meta) {
            comment.meta.isFirstTime = true;
        }

        this._stats.subscribes++;
        this.callbacks.onComment(comment);
    }

    // ── Question ────────────────────────────────────────────────

    private _onQuestion(data: RawQuestionEvent): void {
        this._lastEventAt = Date.now();

        const comment = normalizeQuestion(data);

        if (this.dedup.checkAndMark(comment.id)) {
            this._stats.droppedDedup++;
            return;
        }

        if (this.firstSeen.checkAndMark(comment.userId) && comment.meta) {
            comment.meta.isFirstTime = true;
        }

        this._stats.questions++;
        this.callbacks.onComment(comment);
    }

    // ── Likes (batched) ─────────────────────────────────────────

    private _onLike(data: RawLikeEvent): void {
        this._lastEventAt = Date.now();
        this._stats.likes += data.likeCount ?? 1;
        // Don't forward directly — batch via LikeBatcher
        this.likeBatcher.add(data);
    }

    private _onLikeBatch(lastUser: RawLikeEvent, batchCount: number, totalCount: number): void {
        const comment = normalizeLikeBatch(lastUser, batchCount, totalCount);
        // Likes are batched so no dedup needed
        this.callbacks.onComment(comment);
    }

    // ── Battles ─────────────────────────────────────────────────

    private _onBattleStart(data: RawBattleEvent): void {
        this._lastEventAt = Date.now();

        // Merge decodedData anchorInfo if the typed event is missing it
        if (
            (!data.anchorInfo || Object.keys(data.anchorInfo).length === 0) &&
            this._pendingBattleAnchorInfo
        ) {
            log.debug('TIKTOK BATTLE START: merging anchorInfo from decodedData escape hatch');
            (data as Record<string, unknown>).anchorInfo = this._pendingBattleAnchorInfo;
        }
        this._pendingBattleAnchorInfo = null; // Consumed

        const { comment, battleState } = normalizeBattleStart(data);
        this._battleState = battleState;
        this._stats.battles++;

        log.info('TIKTOK BATTLE START', {
            text:      comment.text,
            host:      battleState?.hostNickname,
            hostId:    battleState?.hostUserId,
            guest:     battleState?.guestNickname,
            guestId:   battleState?.guestUserId,
            hasAnchorInfo: !!data.anchorInfo,
            hasBattleUsers: !!(data.battleUsers?.length),
        });
        this.callbacks.onComment(comment);
    }

    private _onBattleUpdate(data: RawArmiesEvent): void {
        this._lastEventAt = Date.now();

        // DIAGNOSTIC: dump both score sources for debugging
        log.debug('TIKTOK RAW BATTLE UPDATE', {
            battleId:        data.battleId,
            battleStatus:    data.battleStatus,
            hasBattleState:  !!this._battleState,
            battleItemsKeys: data.battleItems ? Object.keys(data.battleItems) : [],
            teamArmiesLen:   Array.isArray(data.teamArmies) ? data.teamArmies.length : 0,
            teamArmiesData:  data.teamArmies?.map(t => ({
                teamId: t.teamId,
                score:  t.teamTotalScore,
            })),
        });

        // Detect new battle (resets tracking)
        if (data.battleId && data.battleId !== this._lastBattleId) {
            this._lastBattleId = data.battleId;
            this._lastBattleScores = null;
            this._lastBattleEmitAt = 0;
        }

        // SDK TriggerReason enum:
        //   0 = UNKNOWN, 1 = SCORE_UPDATE, 2 = BATTLE_END, 4 = KEEP_ALIVE
        const comment = normalizeBattleUpdate(data, this._battleState ?? undefined);

        // Extract scores from the normalized text for dedup
        const scoreMatch = comment.text.match(/:\s*(\d+)\s*vs\s*\S+:\s*(\d+)/);
        const host  = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
        const guest = scoreMatch ? parseInt(scoreMatch[2], 10) : 0;

        // Status-aware dedup:
        //  - SCORE_UPDATE (1): always meaningful, but suppress identical scores within window
        //  - KEEP_ALIVE (4): suppress if scores unchanged (heartbeat noise)
        //  - BATTLE_END (2): always emit, then clear state
        const now = Date.now();
        const isKeepAlive = data.battleStatus === 4;
        const isBattleEnd = data.battleStatus === 2;

        if (
            !isBattleEnd &&
            this._lastBattleScores &&
            this._lastBattleScores.host === host &&
            this._lastBattleScores.guest === guest &&
            (isKeepAlive || now - this._lastBattleEmitAt < 10_000)
        ) {
            this._stats.droppedBattleDedup++;
            return;
        }

        this._lastBattleScores = { host, guest };
        this._lastBattleEmitAt = now;

        this.callbacks.onComment(comment);

        // Detect battle end via status
        if (isBattleEnd) {
            log.info('TIKTOK BATTLE FINISHED (via status)', { battleId: data.battleId });
            this._battleState = null;
            this._lastBattleScores = null;
        }
    }

    private _onBattleEnd(data: RawBattlePunishEvent): void {
        this._lastEventAt = Date.now();

        const comment = normalizeBattleEnd(data);

        log.info('TIKTOK BATTLE PUNISHMENT PHASE END');
        this._battleState = null;
        this.callbacks.onComment(comment);
    }

    // ── Emotes ──────────────────────────────────────────────────

    private _onEmote(data: RawEmoteEvent): void {
        this._lastEventAt = Date.now();

        const comment = normalizeEmote(data);

        if (this.dedup.checkAndMark(comment.id)) {
            this._stats.droppedDedup++;
            return;
        }

        this._stats.emotes++;
        // Emotes are low priority — still forward to pipeline
        // (triage will likely skip them)
        this.callbacks.onComment(comment);
    }

    // ═════════════════════════════════════════════════════════════════
    //  SAFE HANDLER WRAPPER
    // ═════════════════════════════════════════════════════════════════

    /**
     * Wraps every event handler in a try/catch.
     * A single malformed event must never crash the entire capture system.
     */
    private _safeHandle(eventName: string, handler: () => void): void {
        try {
            handler();
        } catch (err: unknown) {
            log.warn('TIKTOK EVENT HANDLER ERROR', {
                event: eventName,
                error: (err as Error)?.message ?? String(err),
            });
            // Don't rethrow — event processing is best-effort
        }
    }

    // ═════════════════════════════════════════════════════════════════
    //  STATE & STATS
    // ═════════════════════════════════════════════════════════════════

    setConnectionState(state: TikTokConnectionState): void {
        this._connectionState = state;
    }

    getConnectionInfo(): TikTokConnectionInfo {
        const now = Date.now();
        return {
            state:          this._connectionState,
            roomId:         null, // Set by connection-manager
            username:       this.config.username,
            isLive:         this._connectionState === 'connected',
            viewerCount:    this._viewerCount,
            connectedAt:    this._connectedAt,
            reconnectCount: 0, // Set by connection-manager
            lastEventAt:    this._lastEventAt,
            uptime:         this._connectedAt ? now - this._connectedAt : 0,
        };
    }

    getStats(): TikTokCaptureStats {
        const giftStats = this.giftAgg.getStats();

        return {
            connection: this.getConnectionInfo(),
            events: {
                comments:     this._stats.comments,
                gifts:        this._stats.gifts,
                giftDiamonds: this._stats.giftDiamonds,
                follows:      this._stats.follows,
                shares:       this._stats.shares,
                joins:        this._stats.joins,
                subscribes:   this._stats.subscribes,
                questions:    this._stats.questions,
                likes:        this._stats.likes,
                battles:      this._stats.battles,
                emotes:       this._stats.emotes,
                droppedDedup:       this._stats.droppedDedup,
                droppedJoins:       this._stats.droppedJoins,
                droppedBattleDedup: this._stats.droppedBattleDedup,
                droppedOther:       this._stats.droppedOther,
            },
            giftStreaks: {
                active:           giftStats.activeStreaks,
                completed:        giftStats.completedTotal,
                timedOut:         giftStats.timedOutTotal,
                tombstoneCount:   giftStats.tombstoneCount,
                droppedTombstone: giftStats.droppedTombstone,
                deltaEmissions:   giftStats.deltaEmissions,
                droppedStale:     giftStats.droppedStale,
            },
        };
    }

    get viewerCount(): number { return this._viewerCount; }
    get lastEventAt(): number | null { return this._lastEventAt; }
    get connectionState(): TikTokConnectionState { return this._connectionState; }

    // ═════════════════════════════════════════════════════════════════
    //  LIFECYCLE
    // ═════════════════════════════════════════════════════════════════

    /**
     * Flush all pending state (gift streaks, like batches).
     * Called during graceful shutdown.
     */
    flush(): void {
        const flushedGifts = this.giftAgg.flush();
        this.likeBatcher.flush();

        if (flushedGifts > 0) {
            log.info('TIKTOK EVENT EMITTER FLUSH', { giftStreaks: flushedGifts });
        }
    }

    /**
     * Full cleanup. Stops timers, clears all state.
     */
    destroy(): void {
        this.flush();
        clearInterval(this.cleanupTimer);
        this.likeBatcher.reset();
        this.joinLimiter.clear();
        this.dedup.clear();
        this.firstSeen.clear();
        this.giftAgg.reset();
    }
}