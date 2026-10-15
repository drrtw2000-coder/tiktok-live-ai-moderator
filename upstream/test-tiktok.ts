/**
 * test-tiktok.ts
 *
 * Standalone test runner for the TikTok LIVE capture subsystem.
 *
 * USAGE:
 *   npx ts-node test-tiktok.ts <username> [euler-api-key]
 *
 * EXAMPLES:
 *   npx ts-node test-tiktok.ts somecreator
 *   npx ts-node test-tiktok.ts somecreator ek_abc123
 *   TIKTOK_EULER_API_KEY=ek_abc123 npx ts-node test-tiktok.ts somecreator
 */

import 'dotenv/config';

import type { TikTokComment } from './shared/types';
import type { TikTokConfig } from './server/tiktok/tiktok-config';
import type { TikTokCapture } from './server/tiktok/tiktok-types';
import { TIKTOK_DEFAULTS } from './server/tiktok/tiktok-config';
import { createTikTokCapture } from './server/tiktok/index';

// ═════════════════════════════════════════════════════════════════════════════
//  ANSI COLORS
// ═════════════════════════════════════════════════════════════════════════════

const C = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    red:     '\x1b[31m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    blue:    '\x1b[34m',
    magenta: '\x1b[35m',
    cyan:    '\x1b[36m',
    white:   '\x1b[37m',
};

const EVENT_COLORS: Record<string, string> = {
    comment:      C.white,
    gift:         C.yellow + C.bold,
    follow:       C.green,
    share:        C.cyan,
    join:         C.dim,
    subscribe:    C.magenta + C.bold,
    question:     C.blue + C.bold,
    like_batch:   C.dim,
    battle_start: C.red + C.bold,
    battle_update: C.red,
    battle_end:   C.red + C.bold,
    battle_punish: C.red,
    emote:        C.dim,
};

// ═════════════════════════════════════════════════════════════════════════════
//  EVENT DISPLAY
// ═════════════════════════════════════════════════════════════════════════════

let eventCount = 0;
const eventCounts: Record<string, number> = {};
const startTime = Date.now();

function formatTimestamp(): string {
    const now = new Date();
    return `${C.dim}${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}${C.reset}`;
}

function displayEvent(comment: TikTokComment): void {
    eventCount++;
    const eventType = (comment.meta as Record<string, unknown>)?.eventType as string ?? 'comment';
    eventCounts[eventType] = (eventCounts[eventType] ?? 0) + 1;

    const color = EVENT_COLORS[eventType] ?? C.white;
    const tag   = eventType.toUpperCase().padEnd(14);

    // Build detail line
    let detail = '';

    switch (eventType) {
        case 'comment':
            detail = `${C.bold}@${comment.username}${C.reset}: ${comment.text}`;
            break;

        case 'gift': {
            const meta = comment.meta as Record<string, unknown>;
            const diamonds = meta?.giftValue ?? 0;
            const name     = meta?.giftName ?? 'unknown';
            const count    = meta?.giftRepeatCount ?? 1;
            detail = `${C.bold}@${comment.username}${C.reset} sent ${C.yellow}${name}${C.reset}` +
                     `${(count as number) > 1 ? ` x${count}` : ''} (${C.yellow}${diamonds}💎${C.reset})`;
            break;
        }

        case 'follow':
            detail = `${C.bold}@${comment.username}${C.reset} followed`;
            break;

        case 'subscribe':
            detail = `${C.bold}@${comment.username}${C.reset} subscribed`;
            break;

        case 'question':
            detail = `${C.bold}@${comment.username}${C.reset}: ${comment.text.replace('[QUESTION] ', '').replace(`@${comment.username} asks: `, '')}`;
            break;

        case 'join':
            detail = `${C.dim}@${comment.username} joined${C.reset}`;
            break;

        case 'battle_start':
        case 'battle_update':
        case 'battle_end':
        case 'battle_punish':
            detail = comment.text.replace(/\[.*?\]\s*/, '');
            break;

        case 'like_batch': {
            const meta = comment.meta as Record<string, unknown>;
            const count = meta?.likeCount ?? 0;
            const likeWord = count === 1 ? 'like' : 'likes';
            detail = `${C.dim}@${comment.username} +${count} ${likeWord} (${meta?.totalLikeCount ?? 0} total)${C.reset}`;
            break;
        }

        default:
            detail = `@${comment.username}: ${comment.text}`;
    }

    console.log(`${formatTimestamp()} ${color}[${tag}]${C.reset} ${detail}`);

    // Show user meta for significant events
    if (['gift', 'subscribe', 'follow'].includes(eventType)) {
        const meta = comment.meta as Record<string, unknown>;
        const badges: string[] = [];
        if (meta?.isModerator)  badges.push('🛡️ Mod');
        if (meta?.isSubscriber) badges.push('⭐ Sub');
        if (meta?.isNewGifter)  badges.push('🆕 New Gifter');
        if (meta?.isFirstTime)  badges.push('👋 First Time');
        if (meta?.topGifterRank) badges.push(`🏆 #${meta.topGifterRank}`);
        if (meta?.followerCount) badges.push(`👥 ${meta.followerCount}`);

        if (badges.length > 0) {
            console.log(`${' '.repeat(13)} ${C.dim}  └─ ${badges.join(' │ ')}${C.reset}`);
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  PERIODIC STATS
// ═════════════════════════════════════════════════════════════════════════════

function displayStats(capture: TikTokCapture): void {
    const stats    = capture.getStats();
    const conn     = stats.connection;
    const uptimeS  = Math.floor((Date.now() - startTime) / 1000);
    const uptimeM  = Math.floor(uptimeS / 60);
    const uptimeH  = Math.floor(uptimeM / 60);
    const elapsed  = uptimeH > 0
        ? `${uptimeH}h${uptimeM % 60}m`
        : uptimeM > 0
            ? `${uptimeM}m${uptimeS % 60}s`
            : `${uptimeS}s`;

    const eventsPerMin = uptimeS > 0
        ? (eventCount / (uptimeS / 60)).toFixed(1)
        : '0';

    const stateIcon = conn.state === 'connected' ? '🟢' :
                      conn.state === 'reconnecting' ? '🟡' :
                      conn.state === 'waiting_for_live' ? '⏳' :
                      conn.state === 'connecting' ? '🔄' : '🔴';

    console.log('');
    console.log(`${C.cyan}${'─'.repeat(70)}${C.reset}`);
    console.log(`${C.cyan}${C.bold} 📊 STATS${C.reset} (${elapsed} elapsed)`);
    console.log(`${C.cyan}${'─'.repeat(70)}${C.reset}`);
    console.log(`  ${stateIcon} State: ${C.bold}${conn.state}${C.reset} │ Room: ${conn.roomId ?? 'N/A'} │ Viewers: ${C.bold}${conn.viewerCount}${C.reset} │ Reconnects: ${conn.reconnectCount}`);
    console.log(`  📨 Events: ${C.bold}${eventCount}${C.reset} total (${eventsPerMin}/min) │ Dropped: dedup=${stats.events.droppedDedup} joins=${stats.events.droppedJoins} battle=${stats.events.droppedBattleDedup} other=${stats.events.droppedOther}`);

    // Event breakdown
    const breakdown = Object.entries(eventCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([type, count]) => `${type}=${count}`)
        .join(' │ ');
    if (breakdown) {
        console.log(`  📋 ${breakdown}`);
    }

    // Gift details
    if (stats.events.gifts > 0 || stats.giftStreaks.active > 0) {
        console.log(
            `  🎁 Gifts: ${stats.events.gifts} (${C.yellow}${stats.events.giftDiamonds}💎${C.reset}) │ ` +
            `Streaks: ${stats.giftStreaks.active} active, ${stats.giftStreaks.completed} completed, ${stats.giftStreaks.timedOut} timed out`
        );
    }

    console.log(`${C.cyan}${'─'.repeat(70)}${C.reset}`);
    console.log('');
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    const username = (process.argv[2] || "").replace(/^"|"$/g, "").trim();
    const apiKey   = process.argv[3] || process.env.TIKTOK_EULER_API_KEY || '';

    if (!username) {
        console.log(`
${C.bold}TikTok LIVE Capture — Standalone Test Runner${C.reset}

${C.bold}Usage:${C.reset}
  npx ts-node test-tiktok.ts <username> [euler-api-key]

${C.bold}Examples:${C.reset}
  npx ts-node test-tiktok.ts somecreator
  npx ts-node test-tiktok.ts somecreator ek_abc123
  TIKTOK_EULER_API_KEY=ek_abc123 npx ts-node test-tiktok.ts somecreator

${C.bold}Environment Variables:${C.reset}
  TIKTOK_EULER_API_KEY   Euler Stream signing key (recommended for production)

${C.bold}Event Types Captured:${C.reset}
  💬 Comments     🎁 Gifts       👤 Follows     📢 Shares
  🚪 Joins        ⭐ Subscribes  ❓ Questions   ❤️  Likes
  ⚔️  Battles     😀 Emotes
`);
        process.exit(1);
    }

    // ── Build config ────────────────────────────────────────────
    const config: TikTokConfig = {
        ...TIKTOK_DEFAULTS,
        enabled:    true,
        username:   username.replace(/^@/, ''),
        eulerApiKey: apiKey,

        // Enable everything for testing
        enableGifts:     true,
        enableBattles:   true,
        enableSocial:    true,
        enableQuestions:  true,
        enableLikes:     true,

        // Shorter intervals for testing visibility
        likeBatchIntervalMs: 5_000,    // 5s instead of 10s
        staleConnectionThresholdS: 30, // 30s instead of 60s
    };

    // ── Print banner ────────────────────────────────────────────
    console.log('');
    console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
    console.log(`${C.cyan}${C.bold}  📺 TikTok LIVE Capture — Test Mode${C.reset}`);
    console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
    console.log(`  Username:    ${C.bold}@${config.username}${C.reset}`);
    console.log(`  API Key:     ${apiKey ? `${C.green}provided${C.reset} (${apiKey.slice(0, 6)}...)` : `${C.yellow}not set${C.reset} (free tier — may be rate limited)`}`);
    console.log(`  Gifts:       ${config.enableGifts ? `${C.green}ON${C.reset}` : `${C.red}OFF${C.reset}`}  │  Battles: ${config.enableBattles ? `${C.green}ON${C.reset}` : `${C.red}OFF${C.reset}`}`);
    console.log(`  Social:      ${config.enableSocial ? `${C.green}ON${C.reset}` : `${C.red}OFF${C.reset}`}  │  Likes:   ${config.enableLikes ? `${C.green}ON${C.reset}` : `${C.red}OFF${C.reset}`}`);
    console.log(`  Questions:   ${config.enableQuestions ? `${C.green}ON${C.reset}` : `${C.red}OFF${C.reset}`}`);
    console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
    console.log('');
    console.log(`${C.dim}  Connecting... (if streamer is offline, will poll every ${config.livePollIntervalS}s)${C.reset}`);
    console.log('');

    // ── Start capture ───────────────────────────────────────────
    const capture = await createTikTokCapture(config, displayEvent);

    if (!capture) {
        console.error(`${C.red}${C.bold}Failed to create TikTok capture. Check errors above.${C.reset}`);
        process.exit(1);
    }

    // ── Connection state logging ────────────────────────────────
    const connInfo = capture.getConnectionInfo();
    if (connInfo.state === 'connected') {
        console.log(`${C.green}${C.bold}  ✅ Connected!${C.reset} Room ID: ${connInfo.roomId} │ Viewers: ${connInfo.viewerCount}`);
    } else if (connInfo.state === 'waiting_for_live') {
        console.log(`${C.yellow}  ⏳ Streamer is offline. Waiting for live...${C.reset}`);
    } else {
        console.log(`${C.yellow}  🔄 Connection state: ${connInfo.state}${C.reset}`);
    }
    console.log('');
    console.log(`${C.dim}  Press Ctrl+C to stop. Stats shown every 30s.${C.reset}`);
    console.log('');

    // ── Periodic stats display ──────────────────────────────────
    const statsInterval = setInterval(() => {
        displayStats(capture);
    }, 30_000);

    // ── Graceful shutdown ───────────────────────────────────────
    let isShuttingDown = false;

    const shutdown = async (signal: string): Promise<void> => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        console.log('');
        console.log(`${C.yellow}${C.bold}  ⚠️  ${signal} received — shutting down gracefully...${C.reset}`);

        clearInterval(statsInterval);

        // Final stats
        displayStats(capture);

        // Session summary
        const stats = capture.getStats();
        const uptimeS = Math.floor((Date.now() - startTime) / 1000);

        console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
        console.log(`${C.cyan}${C.bold}  📋 SESSION SUMMARY${C.reset}`);
        console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);
        console.log(`  Duration:     ${Math.floor(uptimeS / 60)}m ${uptimeS % 60}s`);
        console.log(`  Total events: ${eventCount}`);
        console.log(`  Comments:     ${stats.events.comments}`);
        console.log(`  Gifts:        ${stats.events.gifts} (${stats.events.giftDiamonds}💎)`);
        console.log(`  Follows:      ${stats.events.follows}`);
        console.log(`  Subscribes:   ${stats.events.subscribes}`);
        console.log(`  Questions:    ${stats.events.questions}`);
        console.log(`  Joins:        ${stats.events.joins}`);
        console.log(`  Shares:       ${stats.events.shares}`);
        console.log(`  Likes:        ${stats.events.likes}`);
        console.log(`  Battles:      ${stats.events.battles}`);
        console.log(`  Emotes:       ${stats.events.emotes}`);
        console.log(`  Dropped:      dedup=${stats.events.droppedDedup} │ joins=${stats.events.droppedJoins} │ battle=${stats.events.droppedBattleDedup} │ other=${stats.events.droppedOther}`);
        console.log(`  Reconnects:   ${stats.connection.reconnectCount}`);
        console.log(`  Gift streaks: ${stats.giftStreaks.completed} completed, ${stats.giftStreaks.timedOut} timed out`);
        console.log(`${C.cyan}${'━'.repeat(70)}${C.reset}`);

        // Shutdown capture
        await capture.shutdown();

        console.log(`${C.green}${C.bold}  ✅ Shutdown complete${C.reset}`);
        console.log('');

        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    // ── Keep alive ──────────────────────────────────────────────
    // The capture system runs via SDK event handlers + internal timers.
    // We just need to keep the process alive.
    await new Promise(() => {});
}

main().catch((err) => {
    console.error(`${C.red}${C.bold}💥 Fatal error:${C.reset}`, err);
    process.exit(1);
});
