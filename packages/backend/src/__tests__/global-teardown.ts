/**
 * Vitest global teardown: drop vitest_* schemas, optionally drop/recreate opensprint_test
 * so the test DB does not grow unbounded, then remove generated test files.
 * Native Postgres is not started by us, so there is no container to stop.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_FILE = path.resolve(__dirname, "../../.vitest-postgres-url");
const RUN_ID_FILE = path.resolve(__dirname, "../../.vitest-run-id");
const FALLBACK_TEST_URL = "postgresql://opensprint:opensprint@localhost:5432/opensprint_test";

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

async function resolveTestDatabaseUrl(): Promise<string> {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  try {
    return (await fs.readFile(URL_FILE, "utf-8")).trim();
  } catch {
    return FALLBACK_TEST_URL;
  }
}

/** True when test DB is the local native opensprint_test (so we can safely drop/recreate it). */
function isLocalNativeTestDb(url: string): boolean {
  try {
    const u = new URL(url);
    const host = (u.hostname || "").toLowerCase();
    const port = u.port || "5432";
    const db = (u.pathname || "").replace(/^\/+|\/+$/g, "") || "";
    return (
      port === "5432" &&
      (host === "localhost" || host === "127.0.0.1" || host === "") &&
      db === "opensprint_test"
    );
  } catch {
    return false;
  }
}

/** Build URL for the postgres database (same host/port/user) to run DROP/CREATE DATABASE. */
function toPostgresUrl(testUrl: string): string {
  const u = new URL(testUrl);
  u.pathname = "/postgres";
  return u.toString();
}

export default async function globalTeardown() {
  const testUrl = await resolveTestDatabaseUrl();

  try {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: testUrl,
      connectionTimeoutMillis: 5000,
    });
    try {
      // Drop all vitest_* schemas (current run and any orphans from workers without runId)
      const rows = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE $1", [
        "vitest_%",
      ]);
      for (const row of rows.rows) {
        const schema = row.nspname as string | undefined;
        if (!schema) continue;
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      }
    } finally {
      await pool.end();
    }
  } catch {
    // Best-effort cleanup only.
  }

  // Drop and recreate local native test DB so disk usage does not grow (no accumulation/bloat)
  if (isLocalNativeTestDb(testUrl)) {
    try {
      const { default: pg } = await import("pg");
      const adminPool = new pg.Pool({
        connectionString: toPostgresUrl(testUrl),
        connectionTimeoutMillis: 5000,
      });
      try {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          ["opensprint_test"]
        );
        await adminPool.query("DROP DATABASE IF EXISTS opensprint_test");
        await adminPool.query("CREATE DATABASE opensprint_test");
      } finally {
        await adminPool.end();
      }
    } catch {
      // Best-effort; e.g. permission denied or DB in use
    }
  }

  await fs.unlink(URL_FILE).catch(() => {});
  await fs.unlink(RUN_ID_FILE).catch(() => {});
}
