/**
 * Minimal structured logger — one JSON object per line, no dependency.
 *
 * info/debug → stdout, warn/error → stderr (matches the prior console.* split
 * and 12-factor: let the supervisor route the streams). Each line carries a
 * timestamp, level, message, the cluster worker id (when running under
 * `vaultbase cluster`), and whatever context fields the call site passes.
 *
 * Level threshold via `VAULTBASE_LOG_LEVEL` (debug|info|warn|error, default
 * info). Error values in context are serialised to {name,message,stack} — a
 * plain JSON.stringify would otherwise emit `{}` for an Error.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;
export type LogContext = Record<string, unknown>;

const threshold = LEVELS[(process.env.VAULTBASE_LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;
const workerId = process.env.VAULTBASE_WORKER_ID;

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function emit(level: LogLevel, msg: string, ctx?: LogContext): void {
  if (LEVELS[level] < threshold) return;
  const entry: LogContext = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(workerId ? { worker: workerId } : {}),
    ...ctx,
  };
  const line = `${JSON.stringify(entry, replacer)}\n`;
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(line);
}

export const log = {
  debug: (msg: string, ctx?: LogContext) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit("error", msg, ctx),
};
