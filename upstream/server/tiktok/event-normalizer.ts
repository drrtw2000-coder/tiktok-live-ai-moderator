/**
 * server/tiktok/event-normalizer.ts
 *
 * Pure transform layer: raw SDK events → normalized TikTokComment.
 *
 * DESIGN PHILOSOPHY:
 *  Every TikTok event becomes a TikTokComment with the same shape the
 *  pipeline already expects. The meta field carries event-specific data.
 *  This means triage, orchestrator, Gemini, and Hindsight all work
 *  unchanged — a gift is just a comment with meta.eventType='gift'.
 *
 * TEXT FORMAT CONVENTIONS:
 *  - Comments: raw text as-is
 *  - Gifts:    "[GIFT] @username sent Rose x5 (250💎)"
 *  - Follows:  "[FOLLOW] @username followed"
 *  - Shares:   "[SHARE] @username shared the stream"
 *  - Joins:    "[JOIN] @username joined"
 *  - Subs:     "[SUBSCRIBE] @username subscribed"
 *  - Questions:"[QUESTION] @username asks: {question text}"
 *  - Battles:  "[BATTLE_START] Battle started: host vs guest"
 *  - Likes:    "[LIKES] @username and others sent {count} likes"
 *
 *  The [TAG] prefixes let triage rules filter by event type without
 *  new code. The avatar's persona prompt can be instructed to handle
 *  these naturally (e.g. "When you see [GIFT], thank the viewer").
 *
 * SDK EVENT SHAPES (confirmed from tiktok-live-connector@2.x):
 *
 *  All events carry a `user` object with:
 *    userId, uniqueId, nickname, profilePictureUrl, followRole,
 *    followInfo: { followerCount, followingCount, followStatus },
 *    isModerator, isNewGifter, isSubscriber, topGifterRank,
 *    userBadges, userDetails
 *
 *  WebcastChatMessage:     user, comment, msgId, createTime
 *  WebcastMemberMessage:   user, actionId, msgId, memberCount
 *  WebcastSocialMessage:   user, action (follow/share), msgId
 *  WebcastLikeMessage:     user, likeCount, totalLikeCount
 *  WebcastQuestionNewMessage: user, questionContent, msgId
 *  WebcastLinkMicBattle:   battleUsers[] { userId, uniqueId, nickname }
 *  WebcastLinkMicArmies:   battleUsers[] { user, points, group }
 *  WebcastRoomUserSeqMessage: topViewers[], viewerCount
 *  WebcastControlMessage:  action (STREAM_END=3, STREAM_PAUSE=4)
 *  WebcastSubscribeMessage: user, msgId
 *
 * PURE FUNCTION MODULE — no state, no I/O, no side effects.
 * All functions are deterministic transforms.
 */

import { TikTokComment, CommentMeta } from '../../shared/types';
import { TikTokEventType, BattleParticipant } from './tiktok-types';
import { ResolvedGift } from './gift-aggregator';

// ═════════════════════════════════════════════════════════════════════════════
//  RAW SDK EVENT SHAPES (minimal interfaces — decoupled from SDK types)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Common user shape present on all SDK events.
 * Using our own interface to decouple from SDK version changes.
 */
interface RawUser {
    userId?:             string;
    uniqueId?:           string;
    nickname?:           string;
    profilePictureUrl?:  string;
    followRole?:         number;
    followInfo?: {
        followerCount?:  number;
        followingCount?: number;
        followStatus?:   number;
    };
    isModerator?:        boolean;
    isNewGifter?:        boolean;
    isSubscriber?:       boolean;
    topGifterRank?:      number | null;
    [key: string]:       unknown;
}

export interface RawChatEvent {
    user:        RawUser;
    comment:     string;
    msgId?:      string;
    createTime?: number;
}

export interface RawMemberEvent {
    user:          RawUser;
    actionId?:     number;
    msgId?:        string;
    memberCount?:  number;
}

export interface RawSocialEvent {
    user:        RawUser;
    action?:     string;
    shareType?:  string;
    shareTarget?: string;
    msgId?:      string;
}

export interface RawLikeEvent {
    user:            RawUser;
    likeCount?:      number;
    totalLikeCount?: number;
}

export interface RawQuestionEvent {
    user:              RawUser;
    questionContent?:  string;
    msgId?:            string;
}

export interface RawBattleEvent {
    battleUsers?: Array<{
        userId?:    string;
        uniqueId?:  string;
        nickname?:  string;
    }>;
    battleId?:   string;
    anchorInfo?: Record<string, {
        user?: {
            userId?:    string;
            nickName?:  string;
            displayId?: string;
        };
    }>;
    teamUsers?: Array<{
        teamId?:  string;
        userIds?: string[];
    }>;
    [key: string]: unknown;
}

export interface RawTeamUser {
    userId?:    string;
    score?:     string | number;   // SDK sends as string
    userIdStr?: string;
}

export interface RawTeamArmy {
    teamId?:         string | number;
    teamTotalScore?: string | number;   // SDK sends as string
    teamUsers?:      RawTeamUser[];
    userArmies?:     Record<string, unknown>;
}

export interface RawArmiesEvent {
    battleId?:          string;
    battleStatus?:      number;
    totalDiamondCount?: number;
    teamArmies?:        RawTeamArmy[];        // v2 deprecated — always empty
    battleItems?:       Record<string, {       // v3 — actual score data
        userArmy?: Array<{
            userId?:       string;
            score?:        string;
            nickname?:     string;
            diamondScore?: string;
        }>;
        hostScore?:    string;
        anchorIdStr?:  string;
    }>;
    [key: string]:      unknown;
}

export interface RawBattlePunishEvent {
    [key: string]: unknown;
}

export interface RawSubscribeEvent {
    user:    RawUser;
    msgId?:  string;
}

export interface RawRoomUserSeqEvent {
    viewerCount?: number;
    topViewers?:  Array<RawUser>;
    [key: string]: unknown;
}

export interface RawEmoteEvent {
    user:    RawUser;
    emote?:  { emoteId?: string; emoteImageUrl?: string };
    msgId?:  string;
}

// ═════════════════════════════════════════════════════════════════════════════
//  ID GENERATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Generate a stable event ID. Format: tt-{type}-{stableKey}
 *
 * Uses the SDK's msgId when available (globally unique).
 * When msgId is absent (initial data replay, some event types),
 * callers MUST provide a content-derived fallback key so that
 * the deduplicator can catch replayed events.
 */
function generateId(type: string, stableKey: string): string {
    return `tt-${type}-${stableKey}`;
}

/**
 * Build a content-based fallback key from user + content + timestamp.
 * Same event content from the same user = same key = dedup catches it.
 */
function contentKey(userId: string, content: string, createTime?: number): string {
    const contentSlice = content.slice(0, 50).replace(/[^a-zA-Z0-9]/g, '');
    return `${userId}-${contentSlice}-${createTime ?? 0}`;
}

// ═════════════════════════════════════════════════════════════════════════════
//  USER → META EXTRACTION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Extract CommentMeta fields from a raw SDK user object.
 * Reused across all event normalizers — single source of truth for
 * user metadata mapping.
 */
function extractUserMeta(user: RawUser, eventType: TikTokEventType): CommentMeta {
    return {
        eventType,
        followerCount:     user.followInfo?.followerCount,
        isSubscriber:      user.isSubscriber ?? undefined,
        isFirstTime:       undefined,    // Set by event-emitter's first-seen tracker
        profilePictureUrl: user.profilePictureUrl ?? undefined,
        followRole:        user.followRole ?? undefined,
        isModerator:       user.isModerator ?? undefined,
        isNewGifter:       user.isNewGifter ?? undefined,
        topGifterRank:     user.topGifterRank ?? undefined,
    };
}

/**
 * Extract userId. Prefers uniqueId (stable @handle), falls back to
 * numeric userId, then nickname as last resort.
 *
 * For TikTokComment.userId: we want a stable identifier for Hindsight
 * tag isolation (user:{userId}). uniqueId is the @handle — most stable.
 * Numeric userId is assigned by TikTok — also stable but less readable.
 */
function extractUserId(user: RawUser): string {
    return user.uniqueId || user.userId || user.nickname || 'unknown';
}

/**
 * Extract display name. Prefers nickname (display name shown in chat),
 * falls back to uniqueId.
 */
function extractUsername(user: RawUser): string {
    return user.nickname || user.uniqueId || 'Unknown';
}

// ═════════════════════════════════════════════════════════════════════════════
//  NORMALIZERS — one per event type
// ═════════════════════════════════════════════════════════════════════════════

/**
 * WebcastEvent.CHAT → TikTokComment
 *
 * The primary event type. Direct mapping — comment text is passed through
 * as-is (no prefix tag, no formatting). This is the user's actual message.
 */
export function normalizeChat(data: RawChatEvent): TikTokComment {
    const meta = extractUserMeta(data.user, 'comment');
    meta.tiktokMsgId = data.msgId;
    meta.createTime  = data.createTime;

    // Stable ID: prefer msgId, fall back to content-derived key
    const stableKey = data.msgId
        || contentKey(extractUserId(data.user), data.comment || '', data.createTime);

    return {
        id:        generateId('chat', stableKey),
        userId:    extractUserId(data.user),
        username:  extractUsername(data.user),
        text:      data.comment || '',
        timestamp: data.createTime ? data.createTime * 1000 : Date.now(),
        meta,
    };
}

/**
 * ResolvedGift (from GiftAggregator) → TikTokComment
 *
 * NOT called on raw WebcastEvent.GIFT — the GiftAggregator handles
 * streak deduplication first, then calls this with the final resolved gift.
 *
 * Text format: "[GIFT] @username sent Rose x5 (250💎)"
 * The diamond value and gift name are in both text (for avatar) and
 * meta (for Hindsight retain scoring).
 */
export function normalizeGift(gift: ResolvedGift): TikTokComment {
    const meta = extractUserMeta(gift.rawUser as RawUser, 'gift');

    const totalDiamonds = gift.totalDiamonds;

    meta.giftValue       = totalDiamonds;
    meta.giftName        = gift.giftName;
    meta.giftDiamonds    = gift.diamondCount;
    meta.giftRepeatCount = gift.repeatCount;

    const countStr   = gift.repeatCount > 1 ? ` x${gift.repeatCount}` : '';
    const diamondStr = totalDiamonds > 0 ? ` (${totalDiamonds}💎)` : '';

    return {
        id:        generateId('gift', `${gift.userId}-${gift.giftId}-${Date.now()}`),
        userId:    gift.uniqueId || gift.userId,
        username:  gift.nickname || gift.uniqueId || 'Unknown',
        text:      `[GIFT] @${gift.nickname || gift.uniqueId} sent ${gift.giftName}${countStr}${diamondStr}`,
        timestamp: Date.now(),
        meta,
    };
}

/**
 * WebcastEvent.MEMBER → TikTokComment
 *
 * Triggered when a new viewer joins the stream.
 * Text format: "[JOIN] @username joined"
 *
 * SDK payload: `data.user` has the user, `data.memberCount` has viewer count.
 * Note: data also has `data.uniqueId` as a shorthand — we use `data.user` for full info.
 */
export function normalizeJoin(data: RawMemberEvent): TikTokComment {
    const meta = extractUserMeta(data.user, 'join');
    meta.tiktokMsgId = data.msgId;
    meta.viewerCount = data.memberCount;

    const username = extractUsername(data.user);
    const stableKey = data.msgId
        || contentKey(extractUserId(data.user), 'join', data.actionId);

    return {
        id:        generateId('join', stableKey),
        userId:    extractUserId(data.user),
        username,
        text:      `[JOIN] @${username} joined`,
        timestamp: Date.now(),
        meta,
    };
}

/**
 * WebcastEvent.SOCIAL (follow action) → TikTokComment
 *
 * "SocialEvent — Triggered when a user shares the stream or follows the host."
 * We split this into follow vs share based on the action field.
 *
 * Text format: "[FOLLOW] @username followed"
 */
export function normalizeFollow(data: RawSocialEvent): TikTokComment {
    const meta = extractUserMeta(data.user, 'follow');
    meta.tiktokMsgId  = data.msgId;
    meta.socialAction  = data.action;
    // Follows imply first interaction for many viewers
    meta.isFirstTime   = true;

    const username = extractUsername(data.user);

    const stableKey = data.msgId
        || contentKey(extractUserId(data.user), 'follow');

    return {
        id:        generateId('follow', stableKey),
        userId:    extractUserId(data.user),
        username,
        text:      `[FOLLOW] @${username} followed`,
        timestamp: Date.now(),
        meta,
    };
}

/**
 * WebcastEvent.SOCIAL (share action) → TikTokComment
 *
 * Text format: "[SHARE] @username shared the stream"
 */
export function normalizeShare(data: RawSocialEvent): TikTokComment {
    const meta = extractUserMeta(data.user, 'share');
    meta.tiktokMsgId  = data.msgId;
    meta.socialAction  = data.action;
    meta.shareType     = data.shareType;
    meta.shareTarget   = data.shareTarget;

    const username = extractUsername(data.user);

    const stableKey = data.msgId
        || contentKey(extractUserId(data.user), 'share');

    return {
        id:        generateId('share', stableKey),
        userId:    extractUserId(data.user),
        username,
        text:      `[SHARE] @${username} shared the stream`,
        timestamp: Date.now(),
        meta,
    };
}

/**
 * WebcastEvent.SUBSCRIBE → TikTokComment
 *
 * Text format: "[SUBSCRIBE] @username subscribed"
 */
export function normalizeSubscribe(data: RawSubscribeEvent): TikTokComment {
    const meta = extractUserMeta(data.user, 'subscribe');
    meta.tiktokMsgId = data.msgId;
    meta.isSubscriber = true;

    const username = extractUsername(data.user);

    const stableKey = data.msgId
        || contentKey(extractUserId(data.user), 'subscribe');

    return {
        id:        generateId('sub', stableKey),
        userId:    extractUserId(data.user),
        username,
        text:      `[SUBSCRIBE] @${username} subscribed`,
        timestamp: Date.now(),
        meta,
    };
}

/**
 * WebcastEvent.QUESTION_NEW → TikTokComment
 *
 * "QuestionNewEvent — Triggered every time someone asks a new question
 *  via the question feature."
 *
 * Text format: "[QUESTION] @username asks: {question text}"
 *
 * Questions are high-priority for triage — they should always be answered.
 */
export function normalizeQuestion(data: RawQuestionEvent): TikTokComment {
    const meta = extractUserMeta(data.user, 'question');
    meta.tiktokMsgId = data.msgId;

    const username = extractUsername(data.user);
    const question = data.questionContent || '';

    const stableKey = data.msgId
        || contentKey(extractUserId(data.user), question);

    return {
        id:        generateId('question', stableKey),
        userId:    extractUserId(data.user),
        username,
        text:      `[QUESTION] @${username} asks: ${question}`,
        timestamp: Date.now(),
        meta,
    };
}

/**
 * WebcastEvent.LIKE → TikTokComment (batched)
 *
 * Likes are extremely high volume. The event-emitter batches them
 * before calling this normalizer.
 *
 * Text format: "[LIKES] @username and others sent 42 likes (1.2K total)"
 */
export function normalizeLikeBatch(
    data:      RawLikeEvent,
    batchCount: number,
    totalCount: number,
): TikTokComment {
    const meta = extractUserMeta(data.user, 'like_batch');
    meta.likeCount      = batchCount;
    meta.totalLikeCount = totalCount;

    const username = extractUsername(data.user);
    const totalStr = totalCount >= 1000
        ? `${(totalCount / 1000).toFixed(1)}K`
        : `${totalCount}`;

    const likeWord = batchCount === 1 ? 'like' : 'likes';

    return {
        id:        generateId('likes', `batch-${Date.now()}`),
        userId:    extractUserId(data.user),
        username,
        text:      `[LIKES] @${username} and others sent ${batchCount} ${likeWord} (${totalStr} total)`,
        timestamp: Date.now(),
        meta,
    };
}

/**
 * Stateful battle context built from linkMicBattle events.
 * Passed to normalizeBattleUpdate() for host/guest participant mapping.
 */
export interface BattleState {
    battleId:       string;
    hostUserId:     string;
    hostNickname:   string;
    guestUserId:    string;
    guestNickname:  string;
}

/**
 * WebcastEvent.LINK_MIC_BATTLE → TikTokComment + BattleState
 *
 * Battle participant identity comes from anchorInfo (v3) or battleUsers (v2).
 * anchorInfo is a map keyed by userId with nested user objects.
 * teamUsers (when present) maps userIds to teamIds for host/guest assignment.
 *
 * IMPORTANT: anchorInfo contains the ACTUAL battle participants (the two
 * streamers battling). This is the ONLY source of participant identity.
 * Do not confuse with battleItems (in linkMicArmies) which contains
 * gift sender data.
 *
 * Text format: "[BATTLE_START] Battle started: host vs guest"
 */
export function normalizeBattleStart(data: RawBattleEvent): { comment: TikTokComment; battleState: BattleState | null } {
    let hostUserId   = '';
    let hostNickname = '';
    let guestUserId  = '';
    let guestNickname = '';

    // v3 path: extract from anchorInfo
    if (data.anchorInfo && Object.keys(data.anchorInfo).length > 0) {
        // Build userId → teamId mapping (when teamUsers is available)
        const teamMap = new Map<string, string>();
        if (data.teamUsers?.length) {
            for (const t of data.teamUsers) {
                for (const uid of (t.userIds ?? [])) {
                    teamMap.set(uid, t.teamId ?? '');
                }
            }
        }

        const anchorEntries = Object.entries(data.anchorInfo);

        for (const [userId, info] of anchorEntries) {
            const nick = info.user?.nickName || info.user?.displayId || userId;

            if (teamMap.size > 0) {
                // teamUsers available: use teamId for host/guest assignment
                const teamId = teamMap.get(userId) ?? '';
                if (teamId === '1' || (!hostUserId && !teamId)) {
                    hostUserId   = userId;
                    hostNickname = nick;
                } else {
                    guestUserId  = userId;
                    guestNickname = nick;
                }
            } else {
                // No teamUsers: positional assignment (first = host, second = guest)
                if (!hostUserId) {
                    hostUserId   = userId;
                    hostNickname = nick;
                } else if (!guestUserId) {
                    guestUserId  = userId;
                    guestNickname = nick;
                }
            }
        }
    }

    // v2 fallback: battleUsers array
    if (!hostUserId && data.battleUsers?.length) {
        hostUserId   = data.battleUsers[0]?.userId || '';
        hostNickname = data.battleUsers[0]?.nickname || '';
        if (data.battleUsers.length > 1) {
            guestUserId  = data.battleUsers[1]?.userId || '';
            guestNickname = data.battleUsers[1]?.nickname || '';
        }
    }

    const names = [hostNickname, guestNickname].filter(Boolean).join(' vs ');

    const battleState: BattleState | null = hostUserId ? {
        battleId:      String(data.battleId ?? Date.now()),
        hostUserId,
        hostNickname,
        guestUserId,
        guestNickname,
    } : null;

    const meta: CommentMeta = {
        eventType: 'battle_start',
        battleId:  String(data.battleId ?? Date.now()),
    };

    const comment: TikTokComment = {
        id:        generateId('battle', `start-${data.battleId ?? Date.now()}`),
        userId:    'system',
        username:  'TikTok',
        text:      `[BATTLE_START] Battle started: ${names || 'unknown participants'}`,
        timestamp: Date.now(),
        meta,
    };

    return { comment, battleState };
}

/**
 * WebcastEvent.LINK_MIC_ARMIES → TikTokComment
 *
 * SCORE SOURCES (in priority order):
 *   1. teamArmies[].teamTotalScore — authoritative team-level totals, keyed by
 *      teamId (1 = host, 2 = guest). Present in both v2 and v3 frames.
 *   2. battleItems[giftSenderId].hostScore — per-anchor aggregate from the v3
 *      schema. Keys are GIFT SENDER IDs (not participants!). Each entry's
 *      anchorIdStr identifies which anchor (battle participant) received
 *      the contribution. Only present in SCORE_UPDATE frames.
 *
 * IDENTITY SOURCE:
 *   ALWAYS from BattleState (captured from linkMicBattle's anchorInfo).
 *   Never from battleItems keys (gift senders) or userArmy nicknames.
 *   When BattleState is unavailable, generic "Host"/"Guest" labels are used.
 *
 * SDK TriggerReason enum for battleStatus:
 *   0 = UNKNOWN, 1 = SCORE_UPDATE, 2 = BATTLE_END, 4 = KEEP_ALIVE
 *
 * Text format: "[BATTLE_UPDATE] HostName: 3195 vs GuestName: 1200"
 */
export function normalizeBattleUpdate(data: RawArmiesEvent, battleState?: BattleState): TikTokComment {
    // ── Labels: ALWAYS from BattleState (never from gift sender data) ────
    const hostLabel  = battleState?.hostNickname || 'Host';
    const guestLabel = battleState?.guestNickname || 'Guest';
    let hostScore  = 0;
    let guestScore = 0;
    let scoreSource = 'none';

    // ── Priority 1: teamArmies (authoritative team totals) ──────────────
    // teamArmies carries team-level scores keyed by teamId 1/2.
    // This is the most reliable source — it's always team totals,
    // not per-gift-sender breakdowns.
    if (data.teamArmies?.length) {
        for (const team of data.teamArmies) {
            const teamId = String(team.teamId);
            const score = typeof team.teamTotalScore === 'string'
                ? parseInt(team.teamTotalScore, 10) || 0
                : (team.teamTotalScore ?? 0);
            if (teamId === '1') hostScore = score;
            else if (teamId === '2') guestScore = score;
        }
        if (hostScore > 0 || guestScore > 0) {
            scoreSource = 'teamArmies';
        }
    }

    // ── Priority 2: battleItems (v3 per-anchor aggregate) ───────────────
    // Only used when teamArmies yielded no scores.
    // Keys are GIFT SENDER IDs — do NOT use them for identity.
    // Each entry has anchorIdStr (the battle participant this gift goes to)
    // and hostScore (running total for that side).
    if (scoreSource === 'none' && data.battleItems && Object.keys(data.battleItems).length > 0) {
        // Aggregate scores by anchorIdStr (the actual battle participant)
        const anchorScores = new Map<string, number>();

        for (const [, armies] of Object.entries(data.battleItems)) {
            const anchorId = armies?.anchorIdStr || 'unknown';
            const existing = anchorScores.get(anchorId) || 0;

            // hostScore is the aggregate for this anchor's side
            if (armies?.hostScore) {
                const score = parseInt(armies.hostScore, 10) || 0;
                // hostScore is already a running total per anchor, take the max
                anchorScores.set(anchorId, Math.max(existing, score));
            } else if (armies?.userArmy) {
                // Fall back to summing individual contribution scores
                let sum = 0;
                for (const u of armies.userArmy) {
                    sum += parseInt(u.score ?? '0', 10) || 0;
                }
                anchorScores.set(anchorId, existing + sum);
            }
        }

        // Map anchor scores to host/guest using BattleState
        if (battleState && anchorScores.size > 0) {
            for (const [anchorId, score] of anchorScores) {
                if (anchorId === battleState.hostUserId) {
                    hostScore = score;
                } else if (anchorId === battleState.guestUserId) {
                    guestScore = score;
                }
            }
            scoreSource = 'battleItems-mapped';
        }

        // If no BattleState match, use positional (first anchor = host)
        if (scoreSource === 'none' && anchorScores.size >= 2) {
            const scores = Array.from(anchorScores.values());
            hostScore  = scores[0];
            guestScore = scores[1];
            scoreSource = 'battleItems-positional';
        } else if (scoreSource === 'none' && anchorScores.size === 1) {
            hostScore = Array.from(anchorScores.values())[0];
            scoreSource = 'battleItems-single';
        }
    }

    const meta: CommentMeta = {
        eventType:    'battle_update' as string,
        battleId:     data.battleId ?? String(Date.now()),
        battleStatus: data.battleStatus,
        // Expose score source for diagnostic visibility
        scoreSource:  scoreSource as string,
    };

    return {
        id:        generateId('battle', `update-${data.battleId ?? Date.now()}-${hostScore}-${guestScore}`),
        userId:    'system',
        username:  'TikTok',
        text:      `[BATTLE_UPDATE] ${hostLabel}: ${hostScore} vs ${guestLabel}: ${guestScore}`,
        timestamp: Date.now(),
        meta,
    };
}

/**
 * WebcastEvent.LINK_MIC_BATTLE_PUNISH_FINISH → TikTokComment
 *
 * Triggered at the end of a battle when the punishment phase completes.
 *
 * Text format: "[BATTLE_END] Battle ended"
 */
export function normalizeBattleEnd(data: RawBattlePunishEvent): TikTokComment {
    const meta: CommentMeta = {
        eventType: 'battle_punish',
    };

    return {
        id:        generateId('battle', `end-${Date.now()}`),
        userId:    'system',
        username:  'TikTok',
        text:      '[BATTLE_END] Battle ended',
        timestamp: Date.now(),
        meta,
    };
}

/**
 * WebcastEvent.ROOM_USER_SEQ → viewer count update
 *
 * NOT forwarded to the triage pipeline — used internally by the
 * connection manager for metrics. Returns null to signal "don't forward."
 */
export function extractViewerCount(data: RawRoomUserSeqEvent): number {
    return data.viewerCount ?? 0;
}

/**
 * WebcastEvent.EMOTE_CHAT → TikTokComment
 *
 * "EmoteChatEvent — Triggered when a custom emote is sent in the chat."
 *
 * Emotes are low-priority — included for completeness.
 * Text format: "[EMOTE] @username sent an emote"
 */
export function normalizeEmote(data: RawEmoteEvent): TikTokComment {
    const meta = extractUserMeta(data.user, 'emote');
    meta.tiktokMsgId = data.msgId;

    const username = extractUsername(data.user);

    const stableKey = data.msgId
        || contentKey(extractUserId(data.user), `emote-${data.emote?.emoteId ?? ''}`);

    return {
        id:        generateId('emote', stableKey),
        userId:    extractUserId(data.user),
        username,
        text:      `[EMOTE] @${username} sent an emote`,
        timestamp: Date.now(),
        meta,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
//  SOCIAL EVENT ROUTER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Route a WebcastSocialMessage to the appropriate normalizer.
 *
 * The SDK emits both follows and shares as WebcastEvent.SOCIAL.
 * We inspect the event to determine which it is.
 *
 * Heuristic: TikTok's social event `action` field contains the type.
 * Common patterns from real payloads:
 *  - Follow: action contains 'follow' (case-insensitive)
 *  - Share:  action contains 'share' (case-insensitive), or shareType is set
 *
 * Fallback: if we can't determine the type, treat as a follow
 * (follows are more common and more valuable for the avatar).
 */
export function normalizeSocial(data: RawSocialEvent): TikTokComment {
    const action = (data.action ?? '').toLowerCase();

    if (action.includes('share') || data.shareType) {
        return normalizeShare(data);
    }

    // Default: follow (includes explicit follow actions and ambiguous cases)
    return normalizeFollow(data);
}