/**
 * Test helpers for database: DbClient mocks and Postgres client for integration tests.
 * Tests that need a real DB use createTestPostgresClient() or createPostgresDbClientFromUrl + runSchema.
 *
 * Uses TEST_DATABASE_URL if set, else reads from .vitest-postgres-url (written by global-setup
 * with native Postgres URL). Otherwise uses opensprint_test. Tests always use opensprint_test
 * (never the app DB "opensprint") so they never pollute the real database.
 * Ensure the test DB exists: createdb opensprint_test (global-setup may create it if possible).
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { Pool } from "pg";
import type { DbClient } from "../db/client.js";
import {
  createPostgresDbClientFromUrl,
  runSchema,
} from "../db/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_FILE = path.resolve(__dirname, "../../.vitest-postgres-url");
// Use a different database name than the app default (opensprint) so test setup (e.g. DELETE FROM tasks)
// never wipes the database the running app is using when TEST_DATABASE_URL is unset and no container URL exists.
const FALLBACK_TEST_URL = "postgresql://opensprint:opensprint@localhost:5432/opensprint_test";

/** App default DB name; tests must never use this to avoid wiping live data. */
const APP_DB_NAME = "opensprint";
const TEST_DB_NAME = "opensprint_test";

/**
 * Ensure the URL points at a test database, not the app database.
 * When connecting to local Postgres (localhost/127.0.0.1, port 5432), always use opensprint_test
 * so test setup (e.g. unrestricted DELETE FROM tasks) never wipes the app DB.
 * Testcontainers URLs use a random port, so they are left unchanged.
 */
function ensureTestDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  const port = parsed.port || "5432";
  const host = (parsed.hostname || "").toLowerCase();
  const isLocalPostgres =
    port === "5432" && (host === "localhost" || host === "127.0.0.1" || host === "");
  if (!isLocalPostgres) return url;

  const rawPath = parsed.pathname || "";
  const dbName = rawPath.replace(/^\/+|\/+$/g, "") || APP_DB_NAME;
  if (dbName === APP_DB_NAME) {
    parsed.pathname = "/" + TEST_DB_NAME;
    return parsed.toString();
  }
  return url;
}

/** Tag test connections so PG logs distinguish app (opensprint-app) from test (opensprint-test). */
function addTestApplicationName(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("application_name", "opensprint-test");
    return u.toString();
  } catch {
    return url;
  }
}

/** Get a stable vitest worker id (fork/thread pool id). */
function getVitestWorkerId(): string | null {
  const poolId = process.env.VITEST_POOL_ID?.trim();
  if (poolId) return poolId;
  const workerId = process.env.VITEST_WORKER_ID?.trim();
  if (workerId) return workerId;
  return null;
}

/** Keep schema names safe for SQL identifiers and reasonably short. */
function sanitizeSchemaPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 32);
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, "\"\"")}"`;
}

/**
 * Isolate each Vitest worker to its own schema so parallel workers do not race
 * on DELETE/TRUNCATE setup hooks against shared tables.
 */
function withWorkerScopedSchema(url: string): { url: string; schema: string | null } {
  const workerId = getVitestWorkerId();
  if (!workerId) return { url, schema: null };

  try {
    const schema = `vitest_${sanitizeSchemaPart(workerId)}`;
    const u = new URL(url);
    const options = u.searchParams.get("options") ?? "";
    if (!options.includes("search_path=")) {
      const nextOptions = `${options} -c search_path=${schema},public`.trim();
      u.searchParams.set("options", nextOptions);
    }
    return { url: u.toString(), schema };
  } catch {
    return { url, schema: null };
  }
}

/** Resolve test DB URL (env, .vitest-postgres-url, or opensprint_test). Use for tests that need URL only. */
export async function getTestDatabaseUrl(): Promise<string> {
  let url: string;
  if (process.env.TEST_DATABASE_URL) {
    url = process.env.TEST_DATABASE_URL;
  } else {
    try {
      url = (await fs.readFile(URL_FILE, "utf-8")).trim();
    } catch {
      url = FALLBACK_TEST_URL;
    }
  }
  url = ensureTestDatabaseUrl(url);
  // Refuse even remote prod URL (e.g. TEST_DATABASE_URL=postgresql://.../opensprint in CI)
  try {
    const dbName = new URL(url).pathname.replace(/^\/+|\/+$/g, "") || APP_DB_NAME;
    if (dbName === APP_DB_NAME) {
      throw new TestDatabaseRefusedError();
    }
  } catch (err) {
    if (err instanceof TestDatabaseRefusedError) throw err;
    // URL parse failed; let caller fail later
  }
  return addTestApplicationName(url);
}

/** Error when test would use the app DB; we refuse to avoid wiping live data. */
export class TestDatabaseRefusedError extends Error {
  constructor() {
    super(
      `Tests must not use the app database "${APP_DB_NAME}". Use ${TEST_DB_NAME} (e.g. createdb ${TEST_DB_NAME}).`
    );
    this.name = "TestDatabaseRefusedError";
  }
}

/**
 * Create a Postgres DbClient for tests. Returns null if Postgres is unreachable.
 * Caller must call pool.end() in afterAll.
 * Refuses to connect to the app database (opensprint) so test setup never wipes live data.
 */
export async function createTestPostgresClient(): Promise<{
  client: DbClient;
  pool: Pool;
} | null> {
  try {
    const baseUrl = await getTestDatabaseUrl();
    const { url, schema } = withWorkerScopedSchema(baseUrl);
    const result = await createPostgresDbClientFromUrl(url);
    if (schema) {
      await result.client.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    }
    await result.client.query("SELECT 1");
    const dbRow = await result.client.queryOne("SELECT current_database() AS name");
    const dbName = (dbRow?.name as string) ?? "";
    if (dbName === APP_DB_NAME) {
      throw new TestDatabaseRefusedError();
    }
    // Log once per process so test runs show which DB is used (confirms isolation from app DB).
    if (!process.env.OPENSPRINT_TEST_DB_LOGGED) {
      (process.env as NodeJS.ProcessEnv).OPENSPRINT_TEST_DB_LOGGED = "1";
      const scope = schema ? ` schema=${schema}` : "";
      console.warn(`[test-db-helper] Tests using database: ${dbName}${scope}`);
    }
    await runSchema(result.client);
    return { client: result.client, pool: result.pool };
  } catch (err) {
    if (err instanceof TestDatabaseRefusedError) throw err;
    return null;
  }
}

/** Create a mock DbClient for tests that don't need real DB. */
export function createMockDbClient(overrides?: Partial<DbClient>): DbClient {
  const base: DbClient = {
    query: async () => [],
    queryOne: async () => undefined,
    execute: async () => 0,
    runInTransaction: async (fn) => fn(base),
  };
  return { ...base, ...overrides };
}
