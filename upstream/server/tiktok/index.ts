/**
 * server/tiktok/index.ts
 *
 * Public API: createTikTokCapture()
 *
 * Single entry point for the TikTok LIVE capture subsystem.
 * Creates, validates, connects, and returns a TikTokCapture handle.
 */

import { TikTokConfig, validateTikTokConfig } from './tiktok-config';
import { TikTokCapture } from './tiktok-types';
import { createConnectionManager } from './connection-manager';
import { TikTokComment } from '../../shared/types';
import { log } from '../utils/logger';

// Re-export public types
export type { TikTokCapture } from './tiktok-types';
export type { TikTokConfig } from './tiktok-config';
export { TIKTOK_DEFAULTS } from './tiktok-config';

/**
 * Create and start the TikTok LIVE capture system.
 *
 * @param config    Full TikTok config (use { ...TIKTOK_DEFAULTS, ... } to override)
 * @param onComment Callback fired for every normalized event entering the pipeline
 * @returns         TikTokCapture handle for lifecycle management, or null if disabled/invalid
 */
export async function createTikTokCapture(
    config:    TikTokConfig,
    onComment: (comment: TikTokComment) => void,
): Promise<TikTokCapture | null> {
    // ── Validate ────────────────────────────────────────────────
    if (!config.enabled) {
        log.info('TIKTOK CAPTURE DISABLED');
        return null;
    }

    const errors = validateTikTokConfig(config);
    for (const err of errors) {
        // Distinguish hard errors from warnings
        if (err.includes('required') || err.includes('below the minimum') || err.includes('too aggressive')) {
            log.error('TIKTOK CONFIG ERROR', { error: err });
        } else {
            log.warn('TIKTOK CONFIG WARNING', { warning: err });
        }
    }

    // Hard errors (username missing) → abort
    const hardErrors = errors.filter(e =>
        e.includes('TIKTOK_USERNAME is required')
    );
    if (hardErrors.length > 0) {
        log.error('TIKTOK CAPTURE ABORTED', { errors: hardErrors });
        return null;
    }

    // ── Create manager ──────────────────────────────────────────
    log.info('TIKTOK CAPTURE INIT', {
        username:  config.username,
        hasApiKey: !!config.eulerApiKey,
        gifts:     config.enableGifts,
        battles:   config.enableBattles,
        social:    config.enableSocial,
        questions: config.enableQuestions,
        likes:     config.enableLikes,
    });

    const manager = createConnectionManager(config, onComment);

    // ── Start connection (non-blocking lifecycle) ───────────────
    await manager.start();

    return manager;
}
