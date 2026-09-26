// server/tiktok/tiktok-types.ts
//
// Internal types for the TikTok LIVE capture subsystem.
// CommentMeta and TikTokComment live in shared/types.ts (the canonical location).

// ═════════════════════════════════════════════════════════════════════════════
//  EVENT TYPES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * All possible TikTok event types that flow through the pipeline.
 * Used by triage to distinguish event types without parsing text prefixes.
 */
export type TikTokEventType =
    | 'comment'
    | 'gift'
    | 'gift_streak'
    | 'follow'
    | 'share'
    | 'join'
    | 'subscribe'
    | 'question'
    | 'like_batch'
    | 'battle_start'
    | 'battle_update'
    | 'battle_end'
    | 'battle_punish'
    | 'viewer_update'
    | 'stream_end'
    | 'emote';

// ═════════════════════════════════════════════════════════════════════════════
//  BATTLE TYPES
// ═════════════════════════════════════════════════════════════════════════════

export interface BattleParticipant {
    userId: string;
    uniqueId: string;
    nickname: string;
    points?: number;
    group?: number;    // 1 = host team, 2 = guest team
}

// ═════════════════════════════════════════════════════════════════════════════
//  GIFT STREAK TRACKING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Represents an in-progress gift streak.
 * Used internally by GiftAggregator — not forwarded to the pipeline
 * until the streak resolves (repeatEnd=true or timeout).
 */
export interface GiftStreak {
    /** Unique key: `${userId}-${giftId}` */
    key: string;
    userId: string;
    uniqueId: string;
    nickname: string;
    giftId: number;
    giftName: string;
    giftType: number;
    diamondCount: number;
    repeatCount: number;
    repeatEnd: boolean;
    firstSeenAt: number;
    lastUpdatedAt: number;
    /** Full SDK user object reference for normalization. */
    rawUser: Record<string, unknown>;
    /** Extended gift info (if available). */
    extendedGiftInfo?: Record<string, unknown>;
}

// ═════════════════════════════════════════════════════════════════════════════
//  CONNECTION STATE
// ═════════════════════════════════════════════════════════════════════════════

export type TikTokConnectionState =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'waiting_for_live'
    | 'failed';

export interface TikTokConnectionInfo {
    state: TikTokConnectionState;
    roomId: string | null;
    username: string;
    isLive: boolean;
    viewerCount: number;
    connectedAt: number | null;
    reconnectCount: number;
    lastEventAt: number | null;
    uptime: number;
}

// ═════════════════════════════════════════════════════════════════════════════
//  CAPTURE STATS
// ═════════════════════════════════════════════════════════════════════════════

export interface TikTokCaptureStats {
    connection: TikTokConnectionInfo;
    events: {
        comments: number;
        gifts: number;
        giftDiamonds: number;
        follows: number;
        shares: number;
        joins: number;
        subscribes: number;
        questions: number;
        likes: number;
        battles: number;
        emotes: number;
        droppedDedup: number;
        droppedJoins: number;
        droppedBattleDedup: number;
        droppedOther: number;
    };
    giftStreaks: {
        /** Currently in-progress streaks awaiting resolution. */
        active: number;
        /** Streaks resolved naturally via repeatEnd=true. */
        completed: number;
        /** Streaks resolved via timeout (repeatEnd never arrived). */
        timedOut: number;
        /** Tombstone entries currently retained for double-count prevention. */
        tombstoneCount: number;
        /** Late repeatEnd events dropped because a tombstone matched. */
        droppedTombstone: number;
        /**
         * Delta corrections emitted when a late repeatEnd arrived with a
         * higher repeatCount than the timed-out resolution. Only the
         * difference was emitted; neither counted in completed nor timedOut.
         */
        deltaEmissions: number;
        /** Gift events dropped because createTime was older than the stale threshold. */
        droppedStale: number;
    };
}

// ═════════════════════════════════════════════════════════════════════════════
//  CAPTURE SYSTEM HANDLE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Opaque handle to the running TikTok capture system.
 * Returned by createTikTokCapture().
 */
export interface TikTokCapture {
    /** Graceful disconnect. Safe to call multiple times. */
    shutdown(): Promise<void>;
    /** Full stats snapshot. */
    getStats(): TikTokCaptureStats;
    /** Current connection state. */
    getConnectionInfo(): TikTokConnectionInfo;
    /** Whether the streamer is currently live. */
    isLive(): boolean;
    /** Last known viewer count (0 if unknown). */
    getViewerCount(): number;
}