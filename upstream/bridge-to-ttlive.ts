/**
 * bridge-to-ttlive.ts
 *
 * Connects to a TikTok LIVE stream and forwards comment events
 * to the TTLive avatar server via HTTP POST.
 *
 * USAGE:
 *   npx tsx bridge-to-ttlive.ts <tiktok-username> [ttlive-url]
 *
 * EXAMPLES:
 *   npx tsx bridge-to-ttlive.ts somecreator
 *   npx tsx bridge-to-ttlive.ts somecreator http://localhost:3001
 *
 * ENV:
 *   TIKTOK_EULER_API_KEY  — Euler Stream signing key (optional)
 *   TTLIVE_URL            — TTLive server URL (default: http://localhost:3001)
 *   TTLIVE_API_TOKEN      — TTLive auth token (or API_TOKEN); required when
 *                           the server has API_TOKEN set, else 401 on forward.
 */

import 'dotenv/config';
import http from 'http';
import type { TikTokComment } from './shared/types';
import type { TikTokConfig } from './server/tiktok/tiktok-config';
import { TIKTOK_DEFAULTS } from './server/tiktok/tiktok-config';
import { createTikTokCapture } from './server/tiktok/index';

// ═════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═════════════════════════════════════════════════════════════════════════════

const TTLIVE_URL = process.argv[3] || process.env.TTLIVE_URL || 'http://localhost:3001';
const API_PATH   = '/api/comment';

// Phase 1 auth (ttlive): /api/comment is fail-closed. Set TTLIVE_API_TOKEN
// (or API_TOKEN) in .env to the SAME value as the server's API_TOKEN.
const TTLIVE_API_TOKEN =
    process.env.TTLIVE_API_TOKEN || process.env.API_TOKEN || '';

// =============================================================================
//  ANSI COLORS
// =============================================================================
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

// =============================================================================
//  EVENT COLORS & WHITELIST
// =============================================================================
const EVENT_COLORS: Record<string, string> = {
  comment:    C.white,
  gift:       C.yellow + C.bold,
  follow:     C.green,
  share:      C.cyan,
  join:       C.dim,
  subscribe:  C.magenta + C.bold,
  question:   C.blue + C.bold,
  like_batch: C.dim,
  emote:      C.dim,
};

// Only forward events that have been validated by the normalizer/aggregator.
// Battles are explicitly excluded for now.
const ALLOWED_EVENT_TYPES = new Set(Object.keys(EVENT_COLORS));

// ═════════════════════════════════════════════════════════════════════════════
//  HTTP CONNECTION POOL (Prevents socket exhaustion during raids)
// ═════════════════════════════════════════════════════════════════════════════
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,       // Pool 10 persistent connections
  maxFreeSockets: 5,
  timeout: 3000,
});

// ═════════════════════════════════════════════════════════════════════════════
//  HTTP FORWARDER
// ═════════════════════════════════════════════════════════════════════════════

let forwarded = 0;
let errors    = 0;

/**
 * Fire-and-forget POST to ttlive's /api/comment.
 * Uses Node's built-in http — no extra dependencies.
 */
function forwardToTTLive(comment: TikTokComment): void {
    const body = JSON.stringify(comment);
    const url  = new URL(API_PATH, TTLIVE_URL);

    const req = http.request(
        {
            hostname: url.hostname,
            port:     url.port,
            path:     url.pathname,
            method:   'POST',
            agent:    httpAgent, // 🔥 USE THE CONNECTION POOL
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...(TTLIVE_API_TOKEN ? { 'x-api-token': TTLIVE_API_TOKEN } : {}),
            },
            timeout: 3000,
        },
        (res) => {
            // Consume response to free socket
            res.resume();

            if (res.statusCode === 200) {
                forwarded++;
            } else {
                errors++;
                console.log(`${C.yellow}  ⚠  TTLive responded ${res.statusCode}${C.reset}`);
            }
        },
    );

    req.on('error', (err) => {
        errors++;
        // Only log periodically to avoid flooding console when ttlive is down
        if (errors <= 3 || errors % 50 === 0) {
            console.log(
                `${C.red}  ✗  Forward failed (${errors} total): ${err.message}${C.reset}` +
                (errors === 3 ? `${C.dim} (suppressing further logs)${C.reset}` : ''),
            );
        }
    });

    req.write(body);
    req.end();
}

// =============================================================================
//  COMMENT HANDLER
// =============================================================================
function onComment(comment: TikTokComment): void {
  const meta = (comment.meta ?? {}) as Record<string, unknown>;
  const eventType = (meta.eventType as string) ?? 'comment';

  // Filter out battles and any other unvalidated events
  if (!ALLOWED_EVENT_TYPES.has(eventType)) {
    return;
  }

  // Display locally with colors
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const color = EVENT_COLORS[eventType] ?? C.white;
  const tag = eventType.toUpperCase().padEnd(12);
  
  let detail = '';
  switch (eventType) {
    case 'comment':
      detail = `${C.bold}@${comment.username}${C.reset}: ${comment.text}`;
      break;
    case 'gift': {
      const diamonds = meta.giftValue ?? 0;
      const name = meta.giftName ?? 'unknown';
      const count = meta.giftRepeatCount ?? 1;
      detail = `${C.bold}@${comment.username}${C.reset} sent ${C.yellow}${name}${C.reset}` +
        `${(count as number) > 1 ? ` x${count}` : ''} (${C.yellow}${diamonds}${C.reset})`;
      break;
    }
    case 'follow':
      detail = `${C.bold}@${comment.username}${C.reset} followed`;
      break;
    case 'subscribe':
      detail = `${C.bold}@${comment.username}${C.reset} subscribed`;
      break;
    case 'share':
      detail = `${C.bold}@${comment.username}${C.reset} shared the stream`;
      break;
    case 'question':
      // Clean up the [QUESTION] @user asks: prefix for the console log
      const cleanQ = comment.text.replace(/^\[QUESTION\]\s*/i, '').replace(/^@.*? asks:\s*/i, '');
      detail = `${C.bold}@${comment.username}${C.reset} asks: ${cleanQ}`;
      break;
    case 'join':
      detail = `${C.dim}@${comment.username} joined${C.reset}`;
      break;
    case 'like_batch': {
      const count = meta.likeCount ?? 0;
      detail = `${C.dim}@${comment.username} sent ${count} likes${C.reset}`;
      break;
    }
    case 'emote':
      detail = `${C.dim}@${comment.username} sent an emote${C.reset}`;
      break;
    default:
      detail = `@${comment.username}: ${comment.text}`;
  }

  console.log(`${C.dim}${time}${C.reset} ${color}[${tag}]${C.reset} ${detail}  ${C.dim}-> ttlive${C.reset}`);

  // Forward to TTLive
  forwardToTTLive(comment);
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    const username = process.argv[2];
    const apiKey   = process.env.TIKTOK_EULER_API_KEY || '';

    if (!username) {
        console.log(`
${C.bold}TikTok → TTLive Bridge${C.reset}

${C.bold}Usage:${C.reset}
  npx tsx bridge-to-ttlive.ts <tiktok-username> [ttlive-url]

${C.bold}Examples:${C.reset}
  npx tsx bridge-to-ttlive.ts somecreator
  npx tsx bridge-to-ttlive.ts somecreator http://192.168.1.5:3001

${C.bold}Environment:${C.reset}
  TIKTOK_EULER_API_KEY   Euler signing key
  TTLIVE_URL             Target server (default: http://localhost:3001)
  TTLIVE_API_TOKEN       TTLive API token (required if server sets API_TOKEN)
`);
        process.exit(1);
    }

    // -- Build TikTok config ------------------------------------
    const config: TikTokConfig = {
        ...TIKTOK_DEFAULTS,
        enabled:          true,
        username:         username.replace(/^@/, ''),
        eulerApiKey:      apiKey,
        enableGifts:      true,    // Wire up gifts (streaks handled by aggregator)
        enableBattles:    false,   // Keeping battles off as requested
        enableSocial:     true,    // Wire up follow, share, join, subscribe
        enableQuestions:  true,    // Wire up Q&A feature
        enableLikes:      true,    // Wire up batched likes
    };

    // ── Banner ─────────────────────────────────────────────────
    console.log('');
    console.log(`${C.cyan}${'━'.repeat(60)}${C.reset}`);
    console.log(`${C.cyan}${C.bold}  🔗 TikTok → TTLive Bridge${C.reset}`);
    console.log(`${C.cyan}${'━'.repeat(60)}${C.reset}`);
    console.log(`  TikTok:  ${C.bold}@${config.username}${C.reset}`);
    console.log(`  TTLive:  ${C.bold}${TTLIVE_URL}${API_PATH}${C.reset}`);
    console.log(`  API Key: ${apiKey ? `${C.green}set${C.reset}` : `${C.yellow}not set${C.reset}`}`);
    console.log(`  Token:   ${TTLIVE_API_TOKEN ? `${C.green}set${C.reset}` : `${C.yellow}NOT SET — server will 401 every forward${C.reset}`}`);
    console.log(`  Mode:    ${C.bold}comments + gifts + social + questions + likes${C.reset}`);
    console.log(`${C.cyan}${'='.repeat(60)}${C.reset}`);
    console.log('');

    // ── Start capture ──────────────────────────────────────────
    const capture = await createTikTokCapture(config, onComment);

    if (!capture) {
        console.error(`${C.red}${C.bold}Failed to start TikTok capture.${C.reset}`);
        process.exit(1);
    }

    const connInfo = capture.getConnectionInfo();
    if (connInfo.state === 'connected') {
        console.log(`${C.green}  ✅ Connected to TikTok${C.reset} │ Room: ${connInfo.roomId}`);
    } else if (connInfo.state === 'waiting_for_live') {
        console.log(`${C.yellow}  ⏳ Waiting for @${config.username} to go live...${C.reset}`);
    }
    console.log(`${C.dim}  Forwarding comments to ${TTLIVE_URL}${C.reset}`);
    console.log('');

    // ── Periodic stats ─────────────────────────────────────────
    const statsTimer = setInterval(() => {
        const stats = capture.getStats();
        console.log(
            `${C.cyan}  📊 ${forwarded} forwarded │ ${errors} errors │ ` +
            `viewers: ${stats.connection.viewerCount} │ ` +
            `state: ${stats.connection.state}${C.reset}`,
        );
    }, 60_000);

    // ── Shutdown ───────────────────────────────────────────────
    const shutdown = async (signal: string) => {
        console.log(`\n${C.yellow}  ⚠  ${signal} — shutting down${C.reset}`);
        clearInterval(statsTimer);
        await capture.shutdown();
        console.log(`${C.green}  ✅ Done.${C.reset} Forwarded ${forwarded} comments (${errors} errors)`);
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    // Keep alive
    await new Promise(() => {});
}

main().catch((err) => {
    console.error(`${C.red}💥 Fatal:${C.reset}`, err);
    process.exit(1);
});
