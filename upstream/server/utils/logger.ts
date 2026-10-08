/**
 * server/utils/logger.ts — Standalone stub
 *
 * Minimal logger for standalone testing. In production, this is
 * the full structured JSON logger from ttlive v6.
 */

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    error: 0,
    warn:  1,
    info:  2,
    debug: 3,
    trace: 4,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
    error: '\x1b[31m',  // red
    warn:  '\x1b[33m',  // yellow
    info:  '\x1b[36m',  // cyan
    debug: '\x1b[2m',   // dim
    trace: '\x1b[2m',   // dim
};

const RESET = '\x1b[0m';

// Set via LOG_LEVEL env var, default to 'info'
const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
const currentPriority = LEVEL_PRIORITY[currentLevel] ?? 2;

function shouldLog(level: LogLevel): boolean {
    return (LEVEL_PRIORITY[level] ?? 2) <= currentPriority;
}

function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (!shouldLog(level)) return;

    const ts    = new Date().toLocaleTimeString('en-US', { hour12: false });
    const color = LEVEL_COLORS[level] ?? '';
    const tag   = level.toUpperCase().padEnd(5);

    let line = `${color}${ts} [${tag}] ${msg}${RESET}`;

    if (data && Object.keys(data).length > 0) {
        // Compact single-line JSON for debug data
        try {
            const compact = JSON.stringify(data, null, 0);
            if (compact.length < 200) {
                line += ` ${RESET}\x1b[2m${compact}${RESET}`;
            } else {
                line += `\n${RESET}\x1b[2m${JSON.stringify(data, null, 2)}${RESET}`;
            }
        } catch {
            line += ` [unserializable data]`;
        }
    }

    if (level === 'error') {
        console.error(line);
    } else if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }
}

export const log = {
    error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
    warn:  (msg: string, data?: Record<string, unknown>) => emit('warn',  msg, data),
    info:  (msg: string, data?: Record<string, unknown>) => emit('info',  msg, data),
    debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
    trace: (msg: string, data?: Record<string, unknown>) => emit('trace', msg, data),
};
