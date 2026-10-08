/**
 * inject-comments.ts
 *
 * Manual comment injector — type comments in the terminal and they
 * get forwarded to the TTLive avatar server via HTTP POST, exactly
 * like real TikTok comments from bridge-to-ttlive.ts.
 *
 * USAGE:
 *   npx tsx inject-comments.ts [ttlive-url]
 *
 * EXAMPLES:
 *   npx tsx inject-comments.ts
 *   npx tsx inject-comments.ts http://localhost:3001
 *
 * COMMANDS:
 *   Type a message and press Enter to send as the default user.
 *   Use @username message to send as a specific user:
 *     @viewer123 hello world
 *   Use /user <name> to change the default username:
 *     /user coolviewer99
 *   Use /quit or Ctrl+C to exit.
 */

import 'dotenv/config';
import http from 'http';
import readline from 'readline';

// ═════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═════════════════════════════════════════════════════════════════════════════

const TTLIVE_URL = process.argv[2] || process.env.TTLIVE_URL || 'http://localhost:3001';
const API_PATH   = '/api/comment';

// Phase 1 auth (ttlive): required when the server has API_TOKEN set.
// Reads TTLIVE_API_TOKEN first, falling back to API_TOKEN in .env.
const TTLIVE_API_TOKEN =
    process.env.TTLIVE_API_TOKEN || process.env.API_TOKEN || '';

let defaultUsername = 'test_viewer';
let commentCounter  = 0;

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
    cyan:    '\x1b[36m',
    magenta: '\x1b[35m',
};

// ═════════════════════════════════════════════════════════════════════════════
//  HTTP FORWARDER  (same logic as bridge-to-ttlive.ts)
// ═════════════════════════════════════════════════════════════════════════════

let forwarded = 0;
let errors    = 0;

interface TikTokComment {
    id: string;
    userId: string;
    username: string;
    text: string;
    timestamp: number;
    meta?: Record<string, unknown>;
}

function forwardToTTLive(comment: TikTokComment): Promise<boolean> {
    return new Promise((resolve) => {
        const body = JSON.stringify(comment);
        const url  = new URL(API_PATH, TTLIVE_URL);

        const req = http.request(
            {
                hostname: url.hostname,
                port:     url.port,
                path:     url.pathname,
                method:   'POST',
                headers: {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    ...(TTLIVE_API_TOKEN ? { 'x-api-token': TTLIVE_API_TOKEN } : {}),
                },
                timeout: 3000,
            },
            (res) => {
                res.resume();
                if (res.statusCode === 200) {
                    forwarded++;
                    resolve(true);
                } else {
                    errors++;
                    console.log(`${C.yellow}  ⚠  TTLive responded ${res.statusCode}${C.reset}`);
                    resolve(false);
                }
            },
        );

        req.on('error', (err) => {
            errors++;
            console.log(`${C.red}  ✗  Forward failed: ${err.message}${C.reset}`);
            resolve(false);
        });

        req.write(body);
        req.end();
    });
}

// ═════════════════════════════════════════════════════════════════════════════
//  BUILD COMMENT
// ═════════════════════════════════════════════════════════════════════════════

function buildComment(username: string, text: string): TikTokComment {
    commentCounter++;
    return {
        id:        `inject-${Date.now()}-${commentCounter}`,
        userId:    username.toLowerCase().replace(/\s+/g, '_'),
        username:  username,
        text:      text,
        timestamp: Date.now(),
        meta: {
            eventType:     'comment',
            followerCount: Math.floor(Math.random() * 10000),
            isSubscriber:  false,
            isFirstTime:   commentCounter === 1,
        },
    };
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════

function main(): void {
    // ── Banner ─────────────────────────────────────────────────
    console.log('');
    console.log(`${C.cyan}${'━'.repeat(60)}${C.reset}`);
    console.log(`${C.cyan}${C.bold}  💉 TTLive Comment Injector${C.reset}`);
    console.log(`${C.cyan}${'━'.repeat(60)}${C.reset}`);
    console.log(`  Target:   ${C.bold}${TTLIVE_URL}${API_PATH}${C.reset}`);
    console.log(`  Token:    ${TTLIVE_API_TOKEN ? `${C.green}set${C.reset}` : `${C.yellow}NOT SET — server will 401${C.reset}`}`);
    console.log(`  User:     ${C.bold}@${defaultUsername}${C.reset}  ${C.dim}(change with /user <name>)${C.reset}`);
    console.log('');
    console.log(`${C.dim}  Commands:${C.reset}`);
    console.log(`${C.dim}    <message>            Send as default user${C.reset}`);
    console.log(`${C.dim}    @user <message>      Send as specific user${C.reset}`);
    console.log(`${C.dim}    /user <name>         Change default username${C.reset}`);
    console.log(`${C.dim}    /quit                Exit${C.reset}`);
    console.log(`${C.cyan}${'━'.repeat(60)}${C.reset}`);
    console.log('');

    // ── Readline interface ────────────────────────────────────
    const rl = readline.createInterface({
        input:  process.stdin,
        output: process.stdout,
        prompt: `${C.magenta}💬 > ${C.reset}`,
    });

    rl.prompt();

    rl.on('line', async (line: string) => {
        const input = line.trim();

        if (!input) {
            rl.prompt();
            return;
        }

        // ── /quit command ─────────────────────────────────────
        if (input === '/quit' || input === '/exit') {
            console.log(`\n${C.green}  ✅ Done.${C.reset} Sent ${forwarded} comments (${errors} errors)`);
            process.exit(0);
        }

        // ── /user command ─────────────────────────────────────
        if (input.startsWith('/user ')) {
            const newUser = input.slice(6).trim().replace(/^@/, '');
            if (newUser) {
                defaultUsername = newUser;
                console.log(`${C.green}  ✓ Default user → @${defaultUsername}${C.reset}`);
            } else {
                console.log(`${C.yellow}  ⚠ Usage: /user <name>${C.reset}`);
            }
            rl.prompt();
            return;
        }

        // ── Parse @username prefix ────────────────────────────
        let username = defaultUsername;
        let text     = input;

        const atMatch = input.match(/^@(\S+)\s+(.+)$/);
        if (atMatch) {
            username = atMatch[1];
            text     = atMatch[2];
        }

        // ── Build & send ──────────────────────────────────────
        const comment = buildComment(username, text);
        const time    = new Date().toLocaleTimeString('en-US', { hour12: false });

        process.stdout.write(
            `${C.dim}${time}${C.reset} ${C.bold}@${username}${C.reset}: ${text}  `,
        );

        const ok = await forwardToTTLive(comment);
        if (ok) {
            console.log(`${C.green}✓${C.reset}`);
        } else {
            console.log(`${C.red}✗${C.reset}`);
        }

        rl.prompt();
    });

    rl.on('close', () => {
        console.log(`\n${C.green}  ✅ Done.${C.reset} Sent ${forwarded} comments (${errors} errors)`);
        process.exit(0);
    });
}

main();
