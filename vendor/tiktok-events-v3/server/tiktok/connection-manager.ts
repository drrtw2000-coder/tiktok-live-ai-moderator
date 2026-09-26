// server/tiktok/connection-manager.ts
//
// Owns the lifecycle of a single TikTok LIVE connection:
//   connect → reconnect → wait-for-live → slow-poll → shutdown.
//
// KEY DESIGN DECISIONS:
//
//   1. REENTRANCY GUARD: _reconnecting boolean prevents concurrent
//      _doReconnect executions from stale checker + SDK disconnect
//      handlers racing. Timer callbacks also check state === 'connected'
//      before proceeding — if a concurrent path already succeeded, the
//      queued timer is a no-op.
//
//   2. processInitialData: false ON RECONNECT: The first connection uses
//      the config's processInitialData setting (typically true). All
//      subsequent connections use false. This prevents replayed events
//      from processInitialData flooding through the pipeline after every
//      reconnect, where the deduplicator's ring buffer may have already
//      evicted the original IDs (bug 1.4).
//
//   3. STATE-BEFORE-DISCONNECT: Every intentional disconnect sets the
//      connection state BEFORE calling _disconnectCurrent(). This prevents
//      the SDK's synchronous 'disconnected' event from hitting
//      _onConnectionStateChange → _scheduleReconnect while the manager
//      is already handling the transition (e.g., stream end, stale check,
//      rate limit). Without this, two reconnect paths race.
//
//   4. GENERATION COUNTER DELEGATION: The event-emitter handles listener
//      invalidation via its internal generation counter. The connection
//      manager does not need removeAllListeners — registering a new
//      connection on the emitter automatically invalidates all handlers
//      from the previous connection.
//
//   5. STREAM END ROUTING: When the stream ends, the manager routes
//      through the standard _doReconnect path (with a 5s cooldown delay)
//      instead of duplicating connection creation logic in a custom timer.
//      _doReconnect → _connectWithFallback → offline → _waitForLive is
//      the natural path.

import { log } from '../utils/logger';
import type { TikTokConfig } from './tiktok-config';
import type {
    TikTokCaptureStats,
    TikTokConnectionState,
    TikTokConnectionInfo,
    TikTokCapture,
} from './tiktok-types';
import type { TikTokComment } from '../../shared/types';
import { TikTokEventEmitter } from './event-emitter';
import type { SDKConnection, TikTokEventCallbacks } from './event-emitter';

// ═════════════════════════════════════════════════════════════════════════════
//  SDK CONNECTION INTERFACE (extended with LIVE-specific methods)
// ═════════════════════════════════════════════════════════════════════════════

export interface SDKLiveConnection extends SDKConnection {
    connect():              Promise<{ roomId?: string; roomInfo?: unknown }>;
    disconnect():           void;
    fetchRoomId():          Promise<string>;
    fetchIsLive():          Promise<boolean>;
    waitForLive(seconds: number, opts?: { signal?: AbortSignal }): Promise<void>;
    fetchRoomInfo():        Promise<unknown>;
    fetchAvailableGifts():  Promise<unknown>;
    readonly roomId:        string;
    readonly state:         { isConnected: boolean; isConnecting: boolean };
}

/**
 * Factory function for creating SDK connection instances.
 *
 * @param isReconnect - true if this is not the first connection attempt.
 *   When true, processInitialData should be false to prevent replayed
 *   events from re-entering the pipeline.
 */
export type ConnectionFactory = (isReconnect: boolean) => SDKLiveConnection;

// ═════════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

/** Delay after stream ends before attempting reconnection. */
const STREAM_END_COOLDOWN_MS = 5_000;

/** Interval for slow-poll mode when max reconnect attempts are exhausted. */
const SLOW_POLL_INTERVAL_MS = 5 * 60 * 1000;

// ═════════════════════════════════════════════════════════════════════════════
//  CONNECTION MANAGER
// ═════════════════════════════════════════════════════════════════════════════

export class TikTokConnectionManager implements TikTokCapture {
    private readonly config:           TikTokConfig;
    private readonly emitter:          TikTokEventEmitter;
    private readonly createConnection: ConnectionFactory;

    private connection:             SDKLiveConnection | null = null;
    private state:                  TikTokConnectionState = 'disconnected';
    private roomId:                 string | null = null;
    private _viewerCount            = 0;
    private reconnectCount          = 0;
    private reconnectAttempt        = 0;
    private isShutDown              = false;
    private staleCheckTimer:        ReturnType<typeof setInterval> | null = null;
    private reconnectTimer:         ReturnType<typeof setTimeout> | null = null;
    private waitForLiveAbort:       AbortController | null = null;

    /** True after the first successful or attempted connection. */
    private _hasConnectedOnce       = false;

    /**
     * Reentrancy guard for _doReconnect.
     *
     * Prevents concurrent reconnect executions from:
     *   - Stale checker force-disconnect + SDK 'disconnected' event
     *   - Two _scheduleReconnect timers firing in close succession
     *   - _onConnectionStateChange racing with _onStreamEnd
     *
     * Set true at the start of _doReconnect, false in finally block.
     * Timer callbacks also check state === 'connected' to skip if a
     * concurrent path already succeeded.
     */
    private _reconnecting           = false;

    constructor(
        config:           TikTokConfig,
        createConnection: ConnectionFactory,
        onComment:        (comment: TikTokComment) => void,
    ) {
        this.config           = config;
        this.createConnection = createConnection;

        const callbacks: TikTokEventCallbacks = {
            onComment,
            onConnectionStateChange: (s) => this._onConnectionStateChange(s),
            onViewerCountUpdate:     (c) => { this._viewerCount = c; },
            onStreamEnd:             ()  => this._onStreamEnd(),
            onError:                 (info, ex) => this._onError(info, ex),
        };

        this.emitter = new TikTokEventEmitter(config, callbacks);
    }

    // ─── Start ───────────────────────────────────────────────────────

    async start(): Promise<void> {
        if (this.isShutDown) return;

        log.info('TIKTOK CONNECTION START', {
            username:  this.config.username,
            hasApiKey: !!this.config.eulerApiKey,
        });

        this._setState('connecting');

        try {
            await this._connectWithFallback();
        } catch (err: unknown) {
            log.warn('TIKTOK INITIAL CONNECTION FAILED', {
                error:  (err as Error)?.message ?? String(err),
                action: 'Will retry via reconnect loop',
            });
            this._scheduleReconnect();
        }

        this._startStaleChecker();
    }

    // ─── Core Connection Logic ───────────────────────────────────────

    /**
     * Create a connection, register handlers, and attempt to connect.
     * If the streamer is offline, falls through to _waitForLive.
     * On other errors, throws so the caller can schedule a reconnect.
     *
     * IMPORTANT: Always disconnects the current connection FIRST to
     * prevent orphaned SDK WebSocket connections. The emitter's generation
     * counter invalidates handlers from the old connection automatically.
     */
    private async _connectWithFallback(): Promise<void> {
        if (this.isShutDown) return;

        // Clean up any existing connection before creating a new one.
        // Safe to call on first connect (this.connection is null → no-op).
        this._disconnectCurrent();

        const isReconnect = this._hasConnectedOnce;
        this.connection   = this.createConnection(isReconnect);

        this.emitter.register(this.connection);

        try {
            const connectState = await this.connection.connect();

            if (this.isShutDown) return;

            this.roomId           = connectState.roomId ?? this.connection.roomId ?? null;
            this.reconnectAttempt = 0;
            this._hasConnectedOnce = true;
            this._setState('connected');

            log.info('TIKTOK ROOM JOINED', {
                roomId:      this.roomId,
                hasRoomInfo: !!connectState.roomInfo,
                isReconnect,
            });

            return;
        } catch (err: unknown) {
            const msg = (err as Error)?.message ?? String(err);

            const isOffline =
                msg.includes('not live') ||
                msg.includes('NOT_LIVE') ||
                msg.includes('LIVE has ended') ||
                msg.includes('offline');

            if (isOffline) {
                log.info('TIKTOK STREAMER OFFLINE', {
                    username:     this.config.username,
                    action:       'Waiting for live',
                    pollInterval: this.config.livePollIntervalS,
                });

                this._hasConnectedOnce = true;
                await this._waitForLive();
                return;
            }

            // Non-offline error. The connection was created and registered
            // but failed to connect. _disconnectCurrent at the top of the
            // next _connectWithFallback call (or in _doReconnect) will
            // clean it up. The generation counter ensures no stale events
            // from this failed connection reach the pipeline.
            throw err;
        }
    }

    // ─── Wait For Live ───────────────────────────────────────────────

    private async _waitForLive(): Promise<void> {
        if (this.isShutDown || !this.connection) return;

        this._setState('waiting_for_live');
        this.waitForLiveAbort = new AbortController();

        try {
            await this.connection.waitForLive(
                Math.max(30, this.config.livePollIntervalS),
                { signal: this.waitForLiveAbort.signal },
            );

            if (this.isShutDown) return;

            log.info('TIKTOK STREAMER NOW LIVE', { username: this.config.username });
            this._setState('connecting');

            const connectState = await this.connection.connect();

            if (this.isShutDown) return;

            this.roomId           = connectState.roomId ?? this.connection.roomId ?? null;
            this.reconnectAttempt = 0;
            this._setState('connected');

            log.info('TIKTOK ROOM JOINED', { roomId: this.roomId });
        } catch (err: unknown) {
            if (this.isShutDown) return;

            const isAbort = (err as Error)?.name === 'AbortError';
            if (isAbort) {
                log.debug('TIKTOK WAIT FOR LIVE CANCELLED');
                return;
            }

            log.warn('TIKTOK WAIT FOR LIVE FAILED', {
                error: (err as Error)?.message ?? String(err),
            });

            this._scheduleReconnect();
        } finally {
            this.waitForLiveAbort = null;
        }
    }

    // ─── Reconnect Scheduling ────────────────────────────────────────

    private _scheduleReconnect(aggressive = false): void {
        if (this.isShutDown) return;

        this.reconnectAttempt++;
        this.reconnectCount++;

        const base   = this.config.reconnectBaseDelayMs;
        const max    = this.config.reconnectMaxDelayMs;
        const exp    = Math.min(base * Math.pow(2, this.reconnectAttempt - 1), max);
        const jitter = 0.75 + Math.random() * 0.5;
        const mult   = aggressive ? 3 : 1;
        const delay  = Math.min(Math.round(exp * jitter * mult), max);

        if (this.reconnectAttempt > this.config.reconnectMaxAttempts) {
            log.warn('TIKTOK MAX RECONNECT ATTEMPTS', {
                attempts: this.reconnectAttempt,
                max:      this.config.reconnectMaxAttempts,
                action:   'Switching to slow poll mode',
            });
            this._scheduleSlowPoll();
            return;
        }

        this._setState('reconnecting');

        log.info('TIKTOK RECONNECT SCHEDULED', {
            attempt:    this.reconnectAttempt,
            max:        this.config.reconnectMaxAttempts,
            delayMs:    delay,
            aggressive,
        });

        this._clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // If a concurrent reconnect already succeeded, skip.
            if (this.isShutDown || this.state === 'connected') return;
            void this._doReconnect();
        }, delay);

        if (typeof this.reconnectTimer === 'object' && 'unref' in this.reconnectTimer) {
            this.reconnectTimer.unref();
        }
    }

    /**
     * Execute a reconnection attempt.
     *
     * Reentrancy-guarded: if _doReconnect is already in progress (from
     * a stale checker trigger, a disconnect event, etc.), the second
     * call returns immediately. The timer callback also checks
     * state === 'connected' to skip if a concurrent path succeeded.
     *
     * On failure, schedules another reconnect attempt with exponential
     * backoff.
     */
    private async _doReconnect(): Promise<void> {
        if (this.isShutDown || this._reconnecting) return;
        this._reconnecting = true;

        try {
            // Set state BEFORE disconnecting to prevent _onConnectionStateChange
            // from racing. The disconnect may synchronously fire a 'disconnected'
            // SDK event; the state guard in _onConnectionStateChange will see
            // 'reconnecting' (not 'connected') and skip the duplicate schedule.
            this._setState('reconnecting');
            this._disconnectCurrent();

            await this._connectWithFallback();
        } catch (err: unknown) {
            if (this.isShutDown) return;

            log.warn('TIKTOK RECONNECT FAILED', {
                attempt: this.reconnectAttempt,
                error:   (err as Error)?.message ?? String(err),
            });
            this._scheduleReconnect();
        } finally {
            this._reconnecting = false;
        }
    }

    // ─── Slow Poll ───────────────────────────────────────────────────

    private _scheduleSlowPoll(): void {
        if (this.isShutDown) return;

        this._setState('waiting_for_live');

        log.info('TIKTOK SLOW POLL MODE', { intervalMs: SLOW_POLL_INTERVAL_MS });

        this._clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isShutDown || this.state === 'connected') return;

            // Reset attempt counter so the next failure goes through the
            // normal exponential backoff before falling back to slow poll again.
            this.reconnectAttempt = 0;

            void this._doReconnect();
        }, SLOW_POLL_INTERVAL_MS);

        if (typeof this.reconnectTimer === 'object' && 'unref' in this.reconnectTimer) {
            this.reconnectTimer.unref();
        }
    }

    // ─── SDK Event Callbacks ─────────────────────────────────────────

    /**
     * Called by the emitter when the SDK reports a connection state change.
     *
     * Only triggers a reconnect when the SDK reports 'disconnected' AND
     * the manager believes we were 'connected'. All other transitions
     * (reconnecting, waiting_for_live, etc.) are already being handled
     * by the manager's own state machine.
     */
    private _onConnectionStateChange(newState: TikTokConnectionState): void {
        // Only react to unexpected disconnections.
        // Intentional disconnections (stale check, stream end, rate limit)
        // set the state to 'reconnecting' or 'waiting_for_live' BEFORE
        // calling _disconnectCurrent(), so this guard fails.
        if (newState === 'disconnected' && this.state === 'connected') {
            if (!this.isShutDown) {
                log.warn('TIKTOK DISCONNECT DETECTED', {
                    roomId: this.roomId,
                    action: 'Scheduling reconnect',
                });
                this._scheduleReconnect();
            }
        }
    }

    /**
     * Called when the live stream ends (streamer goes offline).
     *
     * Routes through the standard _doReconnect path after a short
     * cooldown. _doReconnect → _connectWithFallback → detect offline →
     * _waitForLive is the natural progression. This eliminates the
     * original code's duplicate connection-creation logic in a custom
     * timer callback that bypassed the reconnect state machine.
     *
     * The cooldown delay gives TikTok's servers time to finalize the
     * room teardown before we start polling for the next live session.
     */
    private _onStreamEnd(): void {
        if (this.isShutDown) return;

        log.info('TIKTOK STREAM ENDED', {
            roomId: this.roomId,
            action: 'Will reconnect after cooldown',
        });

        // State-before-disconnect: prevents _onConnectionStateChange race.
        this._setState('reconnecting');
        this._disconnectCurrent();

        // Reset attempt counter so the post-stream reconnect gets full
        // exponential backoff budget before falling to slow poll.
        this.reconnectAttempt = 0;

        this._clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isShutDown || this.state === 'connected') return;
            void this._doReconnect();
        }, STREAM_END_COOLDOWN_MS);

        if (typeof this.reconnectTimer === 'object' && 'unref' in this.reconnectTimer) {
            this.reconnectTimer.unref();
        }
    }

    /**
     * SDK error handler. Detects rate limiting and triggers aggressive
     * backoff to avoid burning API quota.
     */
    private _onError(info: string, exception?: Error): void {
        log.warn('TIKTOK SDK ERROR', {
            info,
            error: exception?.message,
        });

        const isRateLimited =
            info.includes('429') ||
            info.includes('rate') ||
            info.includes('TOO_MANY');

        if (isRateLimited && !this.isShutDown) {
            log.warn('TIKTOK RATE LIMITED', { action: 'Aggressive backoff' });
            // State-before-disconnect: prevents _onConnectionStateChange race.
            this._setState('reconnecting');
            this._disconnectCurrent();
            this._scheduleReconnect(true);
        }
    }

    // ─── Stale Connection Checker ────────────────────────────────────

    /**
     * Periodically checks whether the connection is receiving events.
     * If no events have been received for staleConnectionThresholdS,
     * force-disconnects and triggers a reconnect.
     *
     * The emitter resets _lastEventAt to Date.now() on connect, so a
     * fresh connection always gets a full threshold window before the
     * stale checker can trigger. This prevents the death spiral where:
     *   reconnect → stale checker sees old lastEventAt → force disconnect
     *   → reconnect → repeat.
     */
    private _startStaleChecker(): void {
        const checkIntervalMs = Math.max(10_000, this.config.staleConnectionThresholdS * 500);

        this.staleCheckTimer = setInterval(() => {
            if (this.isShutDown || this.state !== 'connected') return;

            const lastEvent = this.emitter.lastEventAt;
            if (!lastEvent) return;

            const staleSec = (Date.now() - lastEvent) / 1000;

            if (staleSec >= this.config.staleConnectionThresholdS) {
                log.warn('TIKTOK STALE CONNECTION', {
                    lastEventAgo: `${staleSec.toFixed(0)}s`,
                    threshold:    `${this.config.staleConnectionThresholdS}s`,
                    action:       'Force reconnect',
                });

                // State-before-disconnect: prevents _onConnectionStateChange race.
                this._setState('reconnecting');
                this._disconnectCurrent();
                this._scheduleReconnect();
            }
        }, checkIntervalMs);

        if (typeof this.staleCheckTimer === 'object' && 'unref' in this.staleCheckTimer) {
            this.staleCheckTimer.unref();
        }
    }

    // ─── State Management ────────────────────────────────────────────

    private _setState(state: TikTokConnectionState): void {
        if (this.state === state) return;

        const prev = this.state;
        this.state = state;
        this.emitter.setConnectionState(state);

        log.debug('TIKTOK STATE', { from: prev, to: state });
    }

    // ─── Connection Cleanup ──────────────────────────────────────────

    /**
     * Disconnect the current SDK connection.
     *
     * Does NOT change the manager's state — the caller is responsible
     * for setting state BEFORE calling this method to prevent the
     * _onConnectionStateChange race. See design decision #3 in the
     * module header.
     */
    private _disconnectCurrent(): void {
        if (this.connection) {
            try {
                this.connection.disconnect();
            } catch (err: unknown) {
                log.debug('TIKTOK DISCONNECT ERROR', {
                    error: (err as Error)?.message ?? String(err),
                });
            }
            this.connection = null;
        }
    }

    private _clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    // ─── Shutdown ────────────────────────────────────────────────────

    async shutdown(): Promise<void> {
        if (this.isShutDown) return;
        this.isShutDown = true;

        log.info('TIKTOK SHUTDOWN START');

        // Cancel any in-progress waitForLive poll
        this.waitForLiveAbort?.abort();

        // Clear all timers
        this._clearReconnectTimer();
        if (this.staleCheckTimer) {
            clearInterval(this.staleCheckTimer);
            this.staleCheckTimer = null;
        }

        // Flush pending events (gift streaks, like batches)
        this.emitter.flush();

        // Disconnect SDK
        this._disconnectCurrent();

        // Destroy emitter (clears internal state, increments generation
        // to invalidate any lingering handlers)
        this.emitter.destroy();

        this._setState('disconnected');
        log.info('TIKTOK SHUTDOWN COMPLETE');
    }

    // ─── Public API (TikTokCapture interface) ────────────────────────

    getStats(): TikTokCaptureStats {
        const stats = this.emitter.getStats();

        stats.connection.state          = this.state;
        stats.connection.roomId         = this.roomId;
        stats.connection.reconnectCount = this.reconnectCount;
        stats.connection.viewerCount    = this._viewerCount;

        return stats;
    }

    getConnectionInfo(): TikTokConnectionInfo {
        const info = this.emitter.getConnectionInfo();
        info.state          = this.state;
        info.roomId         = this.roomId;
        info.reconnectCount = this.reconnectCount;
        info.viewerCount    = this._viewerCount;
        return info;
    }

    isLive(): boolean {
        return this.state === 'connected';
    }

    getViewerCount(): number {
        return this._viewerCount;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  FACTORY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Create a TikTokConnectionManager with the tiktok-live-connector SDK.
 *
 * The connection factory receives an `isReconnect` parameter:
 *   - First connect: processInitialData from config (typically true)
 *   - Reconnects:    processInitialData = false
 *
 * This prevents replayed events on reconnect from re-entering the
 * pipeline when the deduplicator's ring buffer has already evicted
 * the original event IDs.
 */
export function createConnectionManager(
    config:    TikTokConfig,
    onComment: (comment: TikTokComment) => void,
): TikTokConnectionManager {

    // Dynamic require — the SDK is an optional peer dependency.
    // If it fails to load, the error is immediately visible (crash on start).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TikTokLiveConnection } = require('tiktok-live-connector');

    const createConnection: ConnectionFactory = (isReconnect: boolean): SDKLiveConnection => {
        return new TikTokLiveConnection(config.username, {
            signApiKey:             config.eulerApiKey || undefined,
            enableExtendedGiftInfo: config.enableExtendedGiftInfo,
            processInitialData:     isReconnect ? false : config.processInitialData,
        }) as SDKLiveConnection;
    };

    return new TikTokConnectionManager(config, createConnection, onComment);
}