/** Release only this Vitest run's worker schemas and owned configuration files. */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { buildVitestRunSchemaPrefix } from "./test-db-schema-name.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_FILE = path.resolve(__dirname, "../../.vitest-postgres-url");
const RUN_ID_FILE = path.resolve(__dirname, "../../.vitest-run-id");
const FALLBACK_TEST_URL = "postgresql://opensprint:opensprint@localhost:5432/opensprint_test";

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

async function readRunId(): Promise<string | null> {
  try {
    return (await fs.readFile(RUN_ID_FILE, "utf-8")).trim() || null;
  } catch {
    return null;
  }
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
  const runId = process.env.OPENSPRINT_VITEST_RUN_ID?.trim() || (await readRunId());
  try {
    const testUrl = await resolveTestDatabaseUrl();
    const databaseName = decodeURIComponent(new URL(testUrl).pathname).replace(/^\/+|\/+$/g, "");
    if (databaseName === "opensprint") {
      throw new Error(
        'Refusing to clean application database "opensprint". Use an isolated test database.'
      );
    }
    if (!runId) return;

    const scopes = new Set([
      undefined,
      "unit",
      "int",
      "env",
      process.env.OPENSPRINT_VITEST_SCHEMA_SCOPE,
    ]);
    const prefixes = [...scopes].map((scope) => buildVitestRunSchemaPrefix(runId, scope));
    // Vitest worker IDs are numeric; "main" is the helper's non-worker fallback.
    // Restrict the suffix too so a longer, foreign run ID cannot match our prefix.
    const ownedSchemaPattern = `^(${prefixes.join("|")})([0-9]{1,20}|main)$`;
    const ownedSchema = new RegExp(ownedSchemaPattern);
    try {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: testUrl, connectionTimeoutMillis: 5000 });
      try {
        const rows = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname ~ $1", [
          ownedSchemaPattern,
        ]);
        for (const row of rows.rows) {
          const schema = row.nspname as string | undefined;
          if (!schema || !ownedSchema.test(schema)) continue;
          await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
        }
      } finally {
        await pool.end();
      }
    } catch {
      // A failed test database must not prevent the runner from shutting down.
    }
  } finally {
    if (runId && (await readRunId()) === runId) {
      await fs.unlink(URL_FILE).catch(() => {});
      // A newer run may have published its configuration while cleanup was running.
      if ((await readRunId()) === runId) await fs.unlink(RUN_ID_FILE).catch(() => {});
    }
  }
}
