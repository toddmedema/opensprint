/**
 * Vitest global teardown: remove generated test URL file.
 * Native Postgres is not started by us, so there is no container to stop.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_FILE = path.resolve(__dirname, "../../.vitest-postgres-url");
const RUN_ID_ENV = "OPENSPRINT_VITEST_RUN_ID";
const FALLBACK_TEST_URL = "postgresql://opensprint:opensprint@localhost:5432/opensprint_test";

function sanitizeSchemaPart(value: string, maxLen = 20): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return (sanitized || "x").slice(0, maxLen);
}

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

export default async function globalTeardown() {
  const runId = process.env[RUN_ID_ENV]?.trim();
  if (runId) {
    try {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({
        connectionString: await resolveTestDatabaseUrl(),
        connectionTimeoutMillis: 5000,
      });
      try {
        const schemaPrefix = `vitest_${sanitizeSchemaPart(runId)}_`;
        const rows = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE $1", [
          `${schemaPrefix}%`,
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
  }

  await fs.unlink(URL_FILE).catch(() => {});
}
