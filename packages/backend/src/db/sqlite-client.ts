/**
 * SQLite DbClient implementation using better-sqlite3.
 * Converts $1, $2 placeholders to ? and strips Postgres ::type casts for compatibility.
 */

import fs from "fs/promises";
import path from "path";
import type { DbClient, DbRow } from "./client.js";
import { databaseRuntime } from "../services/database-runtime.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { classifyDbConnectionError, isDbConnectionError } from "./db-errors.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("sqlite-runtime");
const DESKTOP_RUNTIME_MANIFEST = "runtime-diagnostics.json";

/** Convert Postgres $1, $2 placeholders to SQLite ? and return params in order. */
function toSqliteSqlAndParams(sql: string, params: unknown[] = []): { sql: string; params: unknown[] } {
  let out = sql.replace(/\$(\d+)/g, "?");
  // Strip Postgres ::type casts so the same SQL works on both (e.g. COUNT(*)::int)
  out = out.replace(/::(int|integer|bigint|text)\b/gi, "");
  return { sql: out, params };
}

function runAsync<T>(fn: () => T | Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      Promise.resolve(fn())
        .then(resolve)
        .catch(reject);
    });
  });
}

function rethrowDatabaseError(err: unknown): never {
  if (err instanceof AppError && err.code === ErrorCodes.DATABASE_UNAVAILABLE) {
    throw err;
  }
  if (isDbConnectionError(err)) {
    databaseRuntime.handleOperationalFailure(err);
    throw new AppError(
      503,
      ErrorCodes.DATABASE_UNAVAILABLE,
      classifyDbConnectionError(err, "sqlite")
    );
  }
  throw err;
}

async function withErrorHandling<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    rethrowDatabaseError(err);
  }
}

function resolvePathForPlatform(value: string): string {
  return process.platform === "win32" ? path.win32.resolve(value) : path.resolve(value);
}

function getUnknownErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function getUnknownErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }
  return null;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function collectDesktopSqliteRuntimeDiagnostics(absPath: string): Promise<Record<string, unknown>> {
  const cwd = process.cwd();
  const modulePath = path.join(cwd, "node_modules", "better-sqlite3");
  const bindingPath = path.join(modulePath, "build", "Release", "better_sqlite3.node");
  const moduleExists = await pathExists(modulePath);
  const bindingExists = await pathExists(bindingPath);
  let bindingBytes: number | null = null;
  if (bindingExists) {
    try {
      const stats = await fs.stat(bindingPath);
      bindingBytes = stats.size;
    } catch {
      bindingBytes = null;
    }
  }
  const runtimeManifestPath = path.join(cwd, DESKTOP_RUNTIME_MANIFEST);
  let runtimeManifest: unknown = null;
  if (await pathExists(runtimeManifestPath)) {
    try {
      runtimeManifest = JSON.parse(await fs.readFile(runtimeManifestPath, "utf8"));
    } catch (err) {
      runtimeManifest = {
        parseError: getUnknownErrorMessage(err),
      };
    }
  }
  return {
    sqlitePath: absPath,
    cwd,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? null,
    nodeModuleVersion: process.versions.modules ?? null,
    modulePath,
    moduleExists,
    bindingPath,
    bindingExists,
    bindingBytes,
    runtimeManifestPath,
    runtimeManifest,
  };
}

async function logDesktopSqliteRuntimeFailure(
  stage: "module-import" | "database-open",
  err: unknown,
  absPath: string
): Promise<void> {
  if (process.env.OPENSPRINT_DESKTOP !== "1") {
    return;
  }
  const diagnostics = await collectDesktopSqliteRuntimeDiagnostics(absPath);
  log.error("SQLite runtime load failed", {
    stage,
    code: getUnknownErrorCode(err),
    message: getUnknownErrorMessage(err),
    ...diagnostics,
  });
}

const LEGACY_SQLITE_PREFIX_RE = /^sqlite:(?!\/\/)/i;
const LEGACY_FILE_PREFIX_RE = /^file:(?!\/\/)/i;

function normalizeLegacySqliteInput(value: string): string {
  let normalized = value.trim();
  let guard = 0;
  while (LEGACY_SQLITE_PREFIX_RE.test(normalized) && guard < 16) {
    normalized = normalized.replace(/^sqlite:/i, "").trim();
    guard += 1;
  }
  if (LEGACY_FILE_PREFIX_RE.test(normalized)) {
    normalized = normalized.replace(/^file:/i, "").trim();
  }
  return normalized;
}

/**
 * Resolve a SQLite database URL or path to an absolute file path.
 * Accepts: sqlite:///path, file:///path, or bare path (relative or absolute).
 */
export function resolveSqlitePath(databaseUrl: string): string {
  const trimmed = normalizeLegacySqliteInput(databaseUrl);
  if (
    trimmed === ":memory:" ||
    trimmed === "sqlite://:memory:" ||
    trimmed === "sqlite:///:memory:" ||
    trimmed === "file::memory:" ||
    trimmed === "file://:memory:" ||
    trimmed === "file:///:memory:"
  ) {
    return ":memory:";
  }
  if (/^sqlite:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      const p = u.pathname || u.hostname || "";
      const decoded = decodeURIComponent(p.replace(/^\//, ""));
      if (decoded === ":memory:") return ":memory:";
      return resolvePathForPlatform(decoded);
    } catch {
      return resolvePathForPlatform(trimmed.replace(/^sqlite:\/\/\/?/i, ""));
    }
  }
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      const decoded = decodeURIComponent(u.pathname);
      if (decoded === ":memory:" || decoded === "/:memory:") return ":memory:";
      if (process.platform === "win32") {
        // Windows file URLs are typically file:///C:/... where URL.pathname starts with /C:/...
        if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) {
          return resolvePathForPlatform(decoded.slice(1));
        }
        // file://server/share/path -> UNC path on Windows.
        if (u.hostname) {
          const uncPath = `\\\\${u.hostname}${decoded.replace(/\//g, "\\")}`;
          return resolvePathForPlatform(uncPath);
        }
      }
      if (u.hostname) {
        return `//${u.hostname}${decoded}`;
      }
      return resolvePathForPlatform(decoded);
    } catch {
      return resolvePathForPlatform(trimmed.replace(/^file:\/\/\/?/i, ""));
    }
  }
  return resolvePathForPlatform(trimmed);
}

/**
 * Open a SQLite database from URL/path. Ensures parent directory exists.
 * Returns the Database instance and a close function.
 */
export async function openSqliteDatabase(
  databaseUrl: string
): Promise<{ db: import("better-sqlite3").Database; close: () => void }> {
  const absPath = resolveSqlitePath(databaseUrl);
  if (absPath !== ":memory:") {
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });
  }
  let Database: typeof import("better-sqlite3");
  try {
    const imported = await import("better-sqlite3");
    Database =
      (imported as { default?: typeof import("better-sqlite3") }).default ??
      (imported as unknown as typeof import("better-sqlite3"));
  } catch (err) {
    await logDesktopSqliteRuntimeFailure("module-import", err, absPath);
    throw err;
  }

  let db: import("better-sqlite3").Database;
  try {
    db = new Database(absPath);
  } catch (err) {
    await logDesktopSqliteRuntimeFailure("database-open", err, absPath);
    throw err;
  }
  if (absPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  return {
    db,
    close: () => {
      db.close();
    },
  };
}

/**
 * Create a DbClient backed by a better-sqlite3 Database.
 * Sync better-sqlite3 calls are run in setImmediate to avoid blocking the event loop.
 */
export function createSqliteDbClient(db: import("better-sqlite3").Database): DbClient {
  const runQuery = (sql: string, params: unknown[]): DbRow[] => {
    const { sql: s, params: p } = toSqliteSqlAndParams(sql, params);
    const stmt = db.prepare(s);
    if (stmt.reader) {
      return stmt.all(...p) as DbRow[];
    }
    stmt.run(...p);
    return [];
  };

  const runExecute = (sql: string, params: unknown[]): number => {
    const { sql: s, params: p } = toSqliteSqlAndParams(sql, params);
    const result = db.prepare(s).run(...p);
    return result.changes;
  };

  return {
    async query(sql: string, params?: unknown[]): Promise<DbRow[]> {
      return withErrorHandling(async () =>
        runAsync(() => runQuery(sql, params ?? []))
      );
    },
    async queryOne(sql: string, params?: unknown[]): Promise<DbRow | undefined> {
      return withErrorHandling(async () =>
        runAsync(() => {
          const rows = runQuery(sql, params ?? []);
          return rows.length > 0 ? rows[0] : undefined;
        })
      );
    },
    async execute(sql: string, params?: unknown[]): Promise<number> {
      return withErrorHandling(async () =>
        runAsync(() => runExecute(sql, params ?? []))
      );
    },
    async runInTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
      return withErrorHandling(async () =>
        runAsync(async () => {
          db.exec("BEGIN");
          try {
            const txClient: DbClient = {
              query: (s, p) => Promise.resolve(runQuery(s, p ?? [])),
              queryOne: (s, p) =>
                Promise.resolve(
                  (() => {
                    const rows = runQuery(s, p ?? []);
                    return rows.length > 0 ? rows[0] : undefined;
                  })()
                ),
              execute: (s, p) => Promise.resolve(runExecute(s, p ?? [])),
              runInTransaction: (nestedFn) => nestedFn(txClient),
            };
            const result = await fn(txClient);
            db.exec("COMMIT");
            return result;
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
        })
      );
    },
  };
}
