/**
 * Vitest global setup: use native Postgres for backend tests.
 * Writes the test database URL to .vitest-postgres-url so test-db-helper uses
 * opensprint_test (never the app database "opensprint").
 * Verifies connectivity to the test DB and fails fast if unreachable so we don't skip hundreds of tests.
 * If TEST_DATABASE_URL is already set (e.g. CI), we leave it and do not write the file.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_FILE = path.resolve(__dirname, "../../.vitest-postgres-url");

/** Native Postgres test DB URL. Tests must never use the app DB (opensprint). */
const NATIVE_TEST_URL = "postgresql://opensprint:opensprint@localhost:5432/opensprint_test";

const SETUP_HINT =
  "Start Postgres and ensure the test database exists. Run from repo root: npm run setup";

export default async function globalSetup() {
  if (process.env.TEST_DATABASE_URL) {
    return;
  }

  const { default: pg } = await import("pg");

  // Best-effort: create opensprint_test if we have permission (e.g. superuser or CREATEDB)
  try {
    const pool = new pg.Pool({
      connectionString: "postgresql://opensprint:opensprint@localhost:5432/postgres",
      connectionTimeoutMillis: 5000,
    });
    try {
      const res = await pool.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        ["opensprint_test"]
      );
      if (res.rowCount === 0) {
        await pool.query("CREATE DATABASE opensprint_test");
      }
    } finally {
      await pool.end();
    }
  } catch {
    // Ignore: opensprint may not be able to connect to "postgres" or lack CREATEDB.
    // npm run setup creates opensprint_test as superuser; we'll fail below if it's missing.
  }

  // Require connectivity to opensprint_test so we fail fast instead of skipping hundreds of tests
  const verifyPool = new pg.Pool({
    connectionString: NATIVE_TEST_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await verifyPool.query("SELECT 1");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[vitest globalSetup] Cannot connect to test database opensprint_test: ${msg}. ${SETUP_HINT}`
    );
  } finally {
    await verifyPool.end();
  }

  await fs.writeFile(URL_FILE, NATIVE_TEST_URL, "utf-8");
}
