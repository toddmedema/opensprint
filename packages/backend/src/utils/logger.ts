/**
 * Structured logging utility for the backend.
 * Provides consistent [namespace] prefixes and optional context objects.
 * LOG_LEVEL env var controls verbosity: debug | info | warn | error.
 * Default is info in app runtime, error in Vitest to reduce test I/O noise.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isVitestRuntime(): boolean {
  return Boolean(
    process.env.VITEST ||
    process.env.VITEST_WORKER_ID ||
    process.env.VITEST_POOL_ID ||
    process.env.NODE_ENV === "test" ||
    process.env.TEST === "true"
  );
}

function getLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw) {
    if (raw in LEVEL_ORDER) return raw as LogLevel;
    return "info";
  }
  if (isVitestRuntime()) return "error";
  return "info";
}

let cachedLevel: LogLevel | null = null;

/** Reset cached log level (for tests). */
export function resetLogLevelCache(): void {
  cachedLevel = null;
}

function shouldLog(level: LogLevel): boolean {
  if (cachedLevel === null) cachedLevel = getLogLevel();
  return LEVEL_ORDER[level] >= LEVEL_ORDER[cachedLevel];
}

function formatMessage(namespace: string, msg: string, ctx?: Record<string, unknown>): string {
  const prefix = `[${namespace}] ${msg}`;
  if (ctx && Object.keys(ctx).length > 0) {
    return `${prefix} ${JSON.stringify(ctx)}`;
  }
  return prefix;
}

export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
}

/**
 * Create a namespaced logger. All messages are prefixed with [namespace].
 * Context objects are appended as JSON when provided.
 */
export function createLogger(namespace: string): Logger {
  return {
    info(msg: string, ctx?: Record<string, unknown>): void {
      if (shouldLog("info")) {
        console.log(formatMessage(namespace, msg, ctx));
      }
    },
    warn(msg: string, ctx?: Record<string, unknown>): void {
      if (shouldLog("warn")) {
        console.warn(formatMessage(namespace, msg, ctx));
      }
    },
    error(msg: string, ctx?: Record<string, unknown>): void {
      if (shouldLog("error")) {
        console.error(formatMessage(namespace, msg, ctx));
      }
    },
    debug(msg: string, ctx?: Record<string, unknown>): void {
      if (shouldLog("debug")) {
        console.log(formatMessage(namespace, msg, ctx));
      }
    },
  };
}
