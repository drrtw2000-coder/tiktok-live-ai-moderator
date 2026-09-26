// server/tiktok/gift-aggregator.ts

import { log } from '../utils/logger';
import type { GiftStreak } from './tiktok-types';

// ─── Public Interfaces ───────────────────────────────────────────────

export interface RawGiftEvent {
    giftId:              number;
    giftType?:           number;
    repeatCount:         number;
    repeatEnd:           boolean | number;
    diamondCount?:       number;
    giftName?:           string;
    describe?:           string;
    createTime?:         number; // epoch seconds — may be absent on gift frames
    user:                Record<string, unknown> & {
        userId:    string;
        uniqueId?: string;
        nickname?: string;
    };
    giftDetails?:        Record<string, unknown> & {
        giftName?:     string;
        giftType?:     number;
        diamondCount?: number;
    };
    extendedGiftInfo?:   Record<string, unknown> & {
        name?:         string;
        diamondCount?: number;
    };
}

export interface ResolvedGift {
    userId:            string;
    uniqueId:          string;
    nickname:          string;
    giftId:            number;
    giftName:          string;
    giftType:          number;
    diamondCount:      number;
    repeatCount:       number;
    totalDiamonds:     number;
    repeatEnd:         boolean;
    resolvedVia:       'repeat_end' | 'non_streakable' | 'timeout' | 'repeat_end_delta';
    rawUser:           Record<string, unknown>;
    extendedGiftInfo?: Record<string, unknown>;
    description:       string;
    streakDurationMs:  number;
}

export interface GiftAggregatorStats {
    activeStreaks:     number;
    completedTotal:   number;
    timedOutTotal:    number;
    nonStreakTotal:   number;
    totalDiamonds:    number;
    tombstoneCount:   number;
    droppedTombstone: number;
    deltaEmissions:   number;
    droppedStale:     number;
}

// ─── Internal Types ──────────────────────────────────────────────────

interface ResolvedTombstone {
    resolvedAt:   number;
    repeatCount:  number;
    diamondCount: number;
    resolvedVia:  ResolvedGift['resolvedVia'];
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_TOMBSTONE_TTL_MS = 120_000;

const TOMBSTONE_CLEANUP_INTERVAL_MS = 30_000;

const DEFAULT_STALE_THRESHOLD_S = 90;

/**
 * Max tombstone entries retained per streak key.
 *
 * Why > 1: When a streak times out and the user immediately starts a new
 * streak for the same gift, we must NOT delete the old tombstone — a late
 * repeatEnd from the first streak could still arrive. Keeping a small
 * stack (last N) per key lets us match the late repeatEnd against the
 * correct prior resolution while still allowing the new streak to
 * proceed independently.
 *
 * 3 covers: (a) the just-resolved streak, (b) its predecessor if two
 * rapid restarts occurred, and (c) headroom for timing jitter.
 */
const MAX_TOMBSTONES_PER_KEY = 3;

// ─── GiftAggregator ─────────────────────────────────────────────────

export class GiftAggregator {

    private readonly streaks    = new Map<string, GiftStreak>();
    private readonly timers     = new Map<string, ReturnType<typeof setTimeout>>();

    /**
     * Tombstone stack: maps each streak key to an array of recent
     * resolutions, ordered oldest → newest, capped at MAX_TOMBSTONES_PER_KEY.
     *
     * This is the core defense against the timeout→repeatEnd double-count
     * race (bug 1.1) AND the tombstone-clear→late-repeatEnd loophole (B5).
     */
    private readonly tombstones = new Map<string, ResolvedTombstone[]>();

    private readonly onResolved:      (gift: ResolvedGift) => void;
    private readonly timeoutMs:       number;
    private readonly tombstoneTtlMs:  number;
    private readonly staleThresholdS: number;

    // ── Counters ──
    private _completedTotal   = 0; // Natural repeat_end resolutions ONLY
    private _timedOutTotal    = 0;
    private _nonStreakTotal   = 0;
    private _totalDiamonds    = 0;
    private _droppedTombstone = 0;
    private _deltaEmissions   = 0;
    private _droppedStale     = 0;

    private _lastTombstoneCleanup = Date.now();

    constructor(
        onResolved:      (gift: ResolvedGift) => void,
        timeoutMs        = 30_000,
        tombstoneTtlMs   = DEFAULT_TOMBSTONE_TTL_MS,
        staleThresholdS  = DEFAULT_STALE_THRESHOLD_S,
    ) {
        this.onResolved      = onResolved;
        this.timeoutMs       = timeoutMs;
        this.tombstoneTtlMs  = tombstoneTtlMs;
        this.staleThresholdS = staleThresholdS;

        log.info('GIFT AGGREGATOR INIT', {
            timeoutMs,
            tombstoneTtlMs,
            staleThresholdS,
        });
    }

    // ─── Public API ──────────────────────────────────────────────────

    /**
     * Primary entry point for every raw gift event from the SDK.
     *
     * Stale-event rejection is applied inline when createTime is present.
     * If TikTok gifts lack createTime on a given SDK version, the guard
     * is a no-op — the emitter layer should implement its own receivedAt
     * window for non-streakable gifts as a secondary defense.
     */
    process(event: RawGiftEvent): void {
        this._maybeCleanTombstones();

        // ── Stale replay rejection (fix for 1.4) ──
        if (event.createTime !== undefined && event.createTime !== 0) {
            if (this._isStaleEvent(event.createTime)) {
                log.debug('GIFT STALE REPLAY DROPPED', {
                    giftId:     event.giftId,
                    userId:     event.user.userId,
                    createTime: event.createTime,
                    ageS:       Math.floor((Date.now() / 1000) - event.createTime),
                });
                return;
            }
        }

        // ── Resolve gift type ──
        let giftType = event.giftDetails?.giftType ?? event.giftType;

        if (giftType === undefined) {
            giftType = 2;
            log.warn('GIFT TYPE UNKNOWN -- defaulting to non-streakable', {
                giftId:   event.giftId,
                giftName: event.giftName,
            });
        }

        if (giftType !== 1) {
            this._emitNonStreakable(event, giftType);
            return;
        }

        // ── Streakable gift (giftType === 1) ──
        const key = `${event.user.userId}-${event.giftId}`;

        if (event.repeatEnd) {
            this._resolveStreak(key, event, 'repeat_end');
        } else {
            this._upsertStreak(key, event, giftType);
        }
    }

    /**
     * Force-resolve all active streaks (called on shutdown / flush).
     * Returns the number of streaks flushed.
     */
    flush(): number {
        const count = this.streaks.size;
        if (count === 0) return 0;

        log.info('GIFT AGGREGATOR FLUSH', { activeStreaks: count });

        const keys = [...this.streaks.keys()];
        for (const key of keys) {
            this._resolveStreak(key, null, 'timeout');
        }

        return count;
    }

    /** Hard reset — clears all state including tombstones. */
    reset(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.streaks.clear();
        this.tombstones.clear();

        this._completedTotal   = 0;
        this._timedOutTotal    = 0;
        this._nonStreakTotal   = 0;
        this._totalDiamonds    = 0;
        this._droppedTombstone = 0;
        this._deltaEmissions   = 0;
        this._droppedStale     = 0;
    }

    getStats(): GiftAggregatorStats {
        let tombstoneCount = 0;
        for (const stack of this.tombstones.values()) {
            tombstoneCount += stack.length;
        }

        return {
            activeStreaks:    this.streaks.size,
            completedTotal:  this._completedTotal,
            timedOutTotal:   this._timedOutTotal,
            nonStreakTotal:  this._nonStreakTotal,
            totalDiamonds:   this._totalDiamonds,
            tombstoneCount,
            droppedTombstone: this._droppedTombstone,
            deltaEmissions:  this._deltaEmissions,
            droppedStale:    this._droppedStale,
        };
    }

    // ─── Stale Detection ─────────────────────────────────────────────

    /**
     * Returns true if the event's createTime is older than the stale
     * threshold, indicating a replay from processInitialData on reconnect.
     *
     * Private — called inline from process(). Downstream callers should
     * pass createTime through on RawGiftEvent and let the aggregator decide.
     */
    private _isStaleEvent(createTimeS: number): boolean {
        const ageS = (Date.now() / 1000) - createTimeS;
        if (ageS > this.staleThresholdS) {
            this._droppedStale++;
            return true;
        }
        return false;
    }

    // ─── Non-Streakable Path ─────────────────────────────────────────

    private _emitNonStreakable(event: RawGiftEvent, giftType: number): void {
        const diamonds    = this._resolveDiamondCount(event);
        const repeatCount = Math.max(1, event.repeatCount || 1);
        const total       = diamonds * repeatCount;
        const giftName    = this._resolveGiftName(event);

        const resolved: ResolvedGift = {
            userId:           event.user.userId,
            uniqueId:         (event.user.uniqueId as string) ?? '',
            nickname:         (event.user.nickname as string) ?? '',
            giftId:           event.giftId,
            giftName,
            giftType,
            diamondCount:     diamonds,
            repeatCount,
            totalDiamonds:    total,
            repeatEnd:        true,
            resolvedVia:      'non_streakable',
            rawUser:          event.user,
            extendedGiftInfo: event.giftDetails ?? event.extendedGiftInfo,
            description:      `sent ${giftName}${repeatCount > 1 ? ` x${repeatCount}` : ''}`,
            streakDurationMs: 0,
        };

        this._nonStreakTotal++;
        this._totalDiamonds += total;

        this.onResolved(resolved);
    }

    // ─── Streak Upsert ───────────────────────────────────────────────

    private _upsertStreak(key: string, event: RawGiftEvent, giftType: number): void {
        const now      = Date.now();
        const existing = this.streaks.get(key);

        if (existing) {
            // ── TODO (pre-existing hazard, not introduced by this rewrite): ──
            //
            // If a late repeatEnd from a *previous* streak arrives while a
            // *new* streak is active under the same key, _resolveStreak will
            // find the active streak and apply:
            //
            //   streak.repeatCount = Math.max(streak.repeatCount, latestEvent.repeatCount)
            //
            // If the old repeatEnd has count=100 and the new streak is at
            // count=5, the new streak gets resolved prematurely at 100.
            //
            // The only true fix is a TikTok-provided streak ID (which does
            // not exist in the current SDK) or a time-based heuristic: if
            // the incoming repeatEnd's repeatCount is dramatically higher
            // than the current streak's count AND the streak is young (e.g.,
            // < 5 seconds old), treat it as a stale event from a prior
            // streak and route it through tombstone checking instead.
            //
            // Frequency: rare — requires a timeout to fire on streak #1
            // right as streak #2 starts, with the repeatEnd arriving during
            // the new streak's early phase. The tombstone stack limits the
            // blast radius but does not prevent this specific path.

            existing.repeatCount   = Math.max(existing.repeatCount, event.repeatCount);
            existing.lastUpdatedAt = now;
            existing.rawUser       = event.user;
        } else {
            // ── DO NOT clear tombstones on new streak start. ──
            //
            // Rationale (B5): If user A's first Rose streak timed out and
            // was tombstoned, then user A immediately starts a second Rose
            // streak, clearing the tombstone here would leave the first
            // streak unprotected. A late repeatEnd from streak #1 would
            // arrive, find no active streak AND no tombstone, and be
            // emitted as a standalone gift — double-counting.
            //
            // Instead, tombstones are kept in a stack (MAX_TOMBSTONES_PER_KEY
            // entries per key) and expire naturally via TTL. The new streak
            // will resolve independently. When it plants its own tombstone,
            // it appends to the stack. The old tombstone remains to catch
            // late arrivals from the prior streak.

            const giftName = this._resolveGiftName(event);
            const diamonds = this._resolveDiamondCount(event);

            const streak: GiftStreak = {
                key,
                userId:           event.user.userId,
                uniqueId:         (event.user.uniqueId as string) ?? '',
                nickname:         (event.user.nickname as string) ?? '',
                giftId:           event.giftId,
                giftName,
                giftType,
                diamondCount:     diamonds,
                repeatCount:      event.repeatCount,
                repeatEnd:        false,
                firstSeenAt:      now,
                lastUpdatedAt:    now,
                rawUser:          event.user,
                extendedGiftInfo: event.giftDetails ?? event.extendedGiftInfo,
            };

            this.streaks.set(key, streak);
        }

        this._resetTimer(key);
    }

    // ─── Streak Resolution ───────────────────────────────────────────

    private _resolveStreak(
        key:         string,
        latestEvent: RawGiftEvent | null,
        via:         'repeat_end' | 'timeout',
    ): void {
        const streak = this.streaks.get(key);

        // ── No active streak for this key ──
        if (!streak) {
            if (!latestEvent) return;

            const tombstoneResult = this._checkTombstone(key, latestEvent);
            if (tombstoneResult === 'drop') return;
            if (tombstoneResult === 'delta') return;

            // No tombstone matched — emit as standalone.
            this._emitFromEvent(latestEvent, via);
            return;
        }

        // ── Active streak exists — resolve it ──

        if (latestEvent) {
            streak.repeatCount = Math.max(streak.repeatCount, latestEvent.repeatCount);
            streak.rawUser     = latestEvent.user;
        }

        const now              = Date.now();
        const totalDiamonds    = streak.diamondCount * streak.repeatCount;
        const streakDurationMs = now - streak.firstSeenAt;

        const resolved: ResolvedGift = {
            userId:           streak.userId,
            uniqueId:         streak.uniqueId,
            nickname:         streak.nickname,
            giftId:           streak.giftId,
            giftName:         streak.giftName,
            giftType:         streak.giftType,
            diamondCount:     streak.diamondCount,
            repeatCount:      streak.repeatCount,
            totalDiamonds,
            repeatEnd:        via === 'repeat_end',
            resolvedVia:      via,
            rawUser:          streak.rawUser,
            extendedGiftInfo: streak.extendedGiftInfo,
            description:      `sent ${streak.giftName} x${streak.repeatCount}`,
            streakDurationMs,
        };

        // Plant tombstone BEFORE deleting streak.
        this._pushTombstone(key, streak.repeatCount, streak.diamondCount, via);

        this.streaks.delete(key);
        this._clearTimer(key);

        if (via === 'repeat_end') {
            this._completedTotal++;
        } else {
            this._timedOutTotal++;
            log.warn('GIFT STREAK TIMEOUT', {
                key,
                giftName:       streak.giftName,
                repeatCount:    streak.repeatCount,
                totalDiamonds,
                durationMs:     streakDurationMs,
                lastUpdatedAgo: now - streak.lastUpdatedAt,
            });
        }
        this._totalDiamonds += totalDiamonds;

        this.onResolved(resolved);
    }

    // ─── Tombstone Check (floor-match-from-below) ────────────────────

    /**
     * Checks the tombstone stack for a matching prior resolution.
     *
     * Uses floor-match strategy: finds the tombstone with the highest
     * repeatCount that is ≤ the incoming count. This tombstone is the
     * most plausible match for the incoming repeatEnd — it belongs to
     * the most recent streak whose resolved count does not exceed the
     * incoming event.
     *
     * Why NOT tightest-from-above (ceiling match):
     *   Stack [T1(100), T2(5)], incoming count 8.
     *   Ceiling: T1(100) covers 8 → drops as duplicate. WRONG.
     *   Floor:   T2(5) is the floor → delta of 3. CORRECT.
     *   The incoming 8 belongs to the second streak (T2), not the first.
     *
     * Returns:
     *   'drop'  — incoming event is fully covered by an exact tombstone match,
     *             OR incomingCount < all tombstones (already resolved at a
     *             higher count, so this is a stale/partial echo)
     *   'delta' — incoming event has a higher count than its floor tombstone;
     *             delta was emitted
     *   null    — no tombstone matched; caller should proceed normally
     */
    private _checkTombstone(
        key:         string,
        latestEvent: RawGiftEvent,
    ): 'drop' | 'delta' | null {
        const stack = this.tombstones.get(key);
        if (!stack || stack.length === 0) return null;

        const incomingCount = Math.max(1, latestEvent.repeatCount || 1);

        // Find the tombstone with the highest repeatCount that is ≤ incomingCount.
        // This is the "floor" — the most plausible streak this repeatEnd belongs to.
        let floor: ResolvedTombstone | null = null;

        for (const ts of stack) {
            if (
                ts.repeatCount <= incomingCount &&
                (!floor || ts.repeatCount > floor.repeatCount)
            ) {
                floor = ts;
            }
        }

        if (floor) {
            if (floor.repeatCount === incomingCount) {
                // Exact match — this repeatEnd is a duplicate of a resolved streak.
                this._droppedTombstone++;
                log.debug('GIFT TOMBSTONE EXACT MATCH — dropping duplicate', {
                    key,
                    incomingCount,
                    stackSize: stack.length,
                });
                return 'drop';
            }

            // incomingCount > floor.repeatCount — delta relative to the
            // most plausible prior streak resolution.
            const delta = incomingCount - floor.repeatCount;
            this._emitDelta(latestEvent, delta, floor);
            return 'delta';
        }

        // incomingCount is less than ALL tombstones in the stack.
        // Every prior resolution already accounted for at least this many
        // repeats. This is a stale or partial echo — drop it.
        this._droppedTombstone++;
        log.debug('GIFT TOMBSTONE COVERED — dropping duplicate', {
            key,
            incomingCount,
            smallestTombstone: Math.min(...stack.map(t => t.repeatCount)),
            stackSize:         stack.length,
        });
        return 'drop';
    }

    // ─── Fallback: No Active Streak, No Tombstone ────────────────────

    private _emitFromEvent(event: RawGiftEvent, via: 'repeat_end' | 'timeout'): void {
        const giftType    = event.giftDetails?.giftType ?? event.giftType ?? 1;
        const diamonds    = this._resolveDiamondCount(event);
        const repeatCount = Math.max(1, event.repeatCount || 1);
        const giftName    = this._resolveGiftName(event);
        const total       = diamonds * repeatCount;

        const resolved: ResolvedGift = {
            userId:           event.user.userId,
            uniqueId:         (event.user.uniqueId as string) ?? '',
            nickname:         (event.user.nickname as string) ?? '',
            giftId:           event.giftId,
            giftName,
            giftType,
            diamondCount:     diamonds,
            repeatCount,
            totalDiamonds:    total,
            repeatEnd:        true,
            resolvedVia:      via,
            rawUser:          event.user,
            extendedGiftInfo: event.giftDetails ?? event.extendedGiftInfo,
            description:      `sent ${giftName}${repeatCount > 1 ? ` x${repeatCount}` : ''}`,
            streakDurationMs: 0,
        };

        // Tombstone this emission so a subsequent duplicate is caught
        const key = `${event.user.userId}-${event.giftId}`;
        this._pushTombstone(key, repeatCount, diamonds, via);

        this._completedTotal++;
        this._totalDiamonds += total;

        this.onResolved(resolved);
    }

    // ─── Delta Emission ──────────────────────────────────────────────

    /**
     * Emits only the difference between a late repeatEnd's count and
     * the previously tombstoned resolution.
     *
     * Does NOT increment _completedTotal — this is a correction, not a
     * natural completion. Tracked separately via _deltaEmissions so
     * dashboards that show "streaks completed naturally" are not inflated.
     */
    private _emitDelta(
        event:     RawGiftEvent,
        delta:     number,
        tombstone: ResolvedTombstone,
    ): void {
        const diamonds  = this._resolveDiamondCount(event);
        const giftName  = this._resolveGiftName(event);
        const giftType  = event.giftDetails?.giftType ?? event.giftType ?? 1;
        const total     = diamonds * delta;
        const fullCount = Math.max(1, event.repeatCount || 1);

        const resolved: ResolvedGift = {
            userId:           event.user.userId,
            uniqueId:         (event.user.uniqueId as string) ?? '',
            nickname:         (event.user.nickname as string) ?? '',
            giftId:           event.giftId,
            giftName,
            giftType,
            diamondCount:     diamonds,
            repeatCount:      delta,
            totalDiamonds:    total,
            repeatEnd:        true,
            resolvedVia:      'repeat_end_delta',
            rawUser:          event.user,
            extendedGiftInfo: event.giftDetails ?? event.extendedGiftInfo,
            description:      `sent ${giftName} x${delta} (delta; full streak was x${fullCount})`,
            streakDurationMs: 0,
        };

        // Update tombstone stack to reflect the authoritative full count
        const key = `${event.user.userId}-${event.giftId}`;
        this._pushTombstone(key, fullCount, diamonds, 'repeat_end');

        this._deltaEmissions++;
        this._totalDiamonds += total;

        log.info('GIFT DELTA EMISSION', {
            key,
            delta,
            previousCount: tombstone.repeatCount,
            fullCount,
            diamonds:      total,
        });

        this.onResolved(resolved);
    }

    // ─── Tombstone Stack Management ──────────────────────────────────

    /**
     * Appends a tombstone to the stack for this key.
     * Evicts the oldest entry if the stack exceeds MAX_TOMBSTONES_PER_KEY.
     */
    private _pushTombstone(
        key:          string,
        repeatCount:  number,
        diamondCount: number,
        via:          ResolvedGift['resolvedVia'],
    ): void {
        let stack = this.tombstones.get(key);
        if (!stack) {
            stack = [];
            this.tombstones.set(key, stack);
        }

        stack.push({
            resolvedAt:   Date.now(),
            repeatCount,
            diamondCount,
            resolvedVia:  via,
        });

        // Cap stack depth — evict oldest first
        while (stack.length > MAX_TOMBSTONES_PER_KEY) {
            stack.shift();
        }
    }

    /** Amortized sweep — runs at most once per TOMBSTONE_CLEANUP_INTERVAL_MS. */
    private _maybeCleanTombstones(): void {
        const now = Date.now();
        if (now - this._lastTombstoneCleanup < TOMBSTONE_CLEANUP_INTERVAL_MS) return;
        this._lastTombstoneCleanup = now;

        const cutoff = now - this.tombstoneTtlMs;

        for (const [key, stack] of this.tombstones) {
            let writeIdx = 0;
            for (let readIdx = 0; readIdx < stack.length; readIdx++) {
                if (stack[readIdx].resolvedAt >= cutoff) {
                    stack[writeIdx++] = stack[readIdx];
                }
            }
            stack.length = writeIdx;

            if (stack.length === 0) {
                this.tombstones.delete(key);
            }
        }
    }

    // ─── Timer Management ────────────────────────────────────────────

    private _resetTimer(key: string): void {
        this._clearTimer(key);

        const timer = setTimeout(() => {
            this.timers.delete(key);
            this._resolveStreak(key, null, 'timeout');
        }, this.timeoutMs);

        if (typeof timer === 'object' && 'unref' in timer) {
            timer.unref();
        }

        this.timers.set(key, timer);
    }

    private _clearTimer(key: string): void {
        const existing = this.timers.get(key);
        if (existing) {
            clearTimeout(existing);
            this.timers.delete(key);
        }
    }

    // ─── Diamond / Name Resolution ───────────────────────────────────

    private _resolveDiamondCount(event: RawGiftEvent): number {
        const resolved =
            event.extendedGiftInfo?.diamondCount ??
            event.giftDetails?.diamondCount ??
            event.diamondCount ??
            0;

        return Math.max(0, Math.floor(resolved));
    }

    private _resolveGiftName(event: RawGiftEvent): string {
        return (
            event.giftDetails?.giftName ||
            event.extendedGiftInfo?.name ||
            event.giftName ||
            `Gift #${event.giftId}`
        );
    }
}