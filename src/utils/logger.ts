export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
};

let currentLevel: LogLevel = (process.env.FLIGHT_AGENT_LOG_LEVEL as LogLevel) || 'info';
const useColor = process.stderr.isTTY && !process.env.NO_COLOR;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function colorise(text: string, color: keyof typeof COLORS): string {
  return useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

function emit(level: Exclude<LogLevel, 'silent'>, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[currentLevel] < LEVEL_ORDER[level]) return;
  const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : level === 'debug' ? 'gray' : 'cyan';
  const prefix = colorise(`[${level}]`, color);
  const scoped = colorise(`${scope}`, 'dim');
  // Logs go to stderr so the CLI's formatted answer on stdout stays pipe-friendly.
  const line = `${prefix} ${scoped} ${message}`;
  if (extra !== undefined) console.error(line, extra);
  else console.error(line);
}

export interface Logger {
  error(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  debug(message: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    error: (message, extra) => emit('error', scope, message, extra),
    warn: (message, extra) => emit('warn', scope, message, extra),
    info: (message, extra) => emit('info', scope, message, extra),
    debug: (message, extra) => emit('debug', scope, message, extra),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
