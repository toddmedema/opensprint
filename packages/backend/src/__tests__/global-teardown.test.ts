import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVitestSchemaName } from "./test-db-schema-name.js";

const mocks = vi.hoisted(() => ({
  pool: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("pg", () => ({ default: { Pool: mocks.pool } }));
vi.mock("fs/promises", () => ({
  default: { readFile: mocks.readFile, unlink: mocks.unlink },
}));

import globalTeardown from "./global-teardown.js";

const RUN_ID = "review-run-123";
const TEST_URL = "postgresql://opensprint:opensprint@localhost:5432/opensprint_test";

describe("backend test database teardown", () => {
  let fileRunId: string | null;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("TEST_DATABASE_URL", undefined);
    vi.stubEnv("OPENSPRINT_VITEST_RUN_ID", RUN_ID);
    vi.stubEnv("OPENSPRINT_VITEST_SCHEMA_SCOPE", undefined);
    fileRunId = RUN_ID;
    mocks.pool.mockImplementation(() => ({ query: mocks.query, end: mocks.end }));
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.end.mockResolvedValue(undefined);
    mocks.readFile.mockImplementation(async (file: string) => {
      if (file.endsWith(".vitest-run-id")) {
        if (!fileRunId) throw new Error("ENOENT");
        return fileRunId;
      }
      return TEST_URL;
    });
    mocks.unlink.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    "postgresql://opensprint:secret@localhost:5432/opensprint",
    "postgres://opensprint:secret@127.0.0.1:5432/opensprint",
    "postgresql://opensprint:secret@database.example.com:5432/opensprint",
    "postgresql://opensprint:secret@database.example.com:5432/%6f%70ensprint",
  ])("refuses an application database URL before opening a pool", async (databaseUrl) => {
    vi.stubEnv("TEST_DATABASE_URL", databaseUrl);
    await expect(globalTeardown()).rejects.toThrow("Refusing to clean application database");
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/\.vitest-postgres-url$/));
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/\.vitest-run-id$/));
  });

  it("drops only this run's worker schemas and retains foreign runs and project scopes", async () => {
    const databaseUrl = "postgresql://test:secret@database.example.com:5432/opensprint_test";
    vi.stubEnv("TEST_DATABASE_URL", databaseUrl);
    const owned = [
      buildVitestSchemaName(RUN_ID, "0", "unit"),
      buildVitestSchemaName(RUN_ID, "1", "int"),
      buildVitestSchemaName(RUN_ID, "2", "env"),
      buildVitestSchemaName(RUN_ID, "main"),
    ];
    const foreign = [
      buildVitestSchemaName("different-run", "0", "unit"),
      buildVitestSchemaName(`${RUN_ID}-foreign`, "0", "unit"),
      buildVitestSchemaName(RUN_ID, "0", "other-project"),
      "public",
    ];
    mocks.query.mockResolvedValueOnce({
      rows: [...owned, ...foreign].map((nspname) => ({ nspname })),
    });
    await globalTeardown();
    expect(mocks.pool).toHaveBeenCalledOnce();
    expect(mocks.pool).toHaveBeenCalledWith({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    const [selectionSql, [selectionPattern]] = mocks.query.mock.calls[0];
    expect(selectionSql).toBe("SELECT nspname FROM pg_namespace WHERE nspname ~ $1");
    const selection = new RegExp(selectionPattern);
    for (const schema of owned) expect(selection.test(schema)).toBe(true);
    for (const schema of foreign) expect(selection.test(schema)).toBe(false);
    expect(mocks.query.mock.calls.slice(1)).toEqual(
      owned.map((schema) => [`DROP SCHEMA IF EXISTS "${schema}" CASCADE`])
    );
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
  });

  it("never resets the entire local test database or terminates other runs", async () => {
    await globalTeardown();
    expect(mocks.pool.mock.calls.map(([options]) => options.connectionString)).toEqual([TEST_URL]);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        /DROP DATABASE|CREATE DATABASE|pg_terminate_backend/.test(sql)
      )
    ).toBe(false);
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
  });

  it("does not query or remove worker configuration when the run identity is unknown", async () => {
    vi.stubEnv("OPENSPRINT_VITEST_RUN_ID", undefined);
    fileRunId = null;
    await globalTeardown();
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("can recover its run identity from published worker metadata", async () => {
    vi.stubEnv("OPENSPRINT_VITEST_RUN_ID", undefined);
    await globalTeardown();
    expect(mocks.pool).toHaveBeenCalledOnce();
    expect(
      new RegExp(mocks.query.mock.calls[0][1][0]).test(buildVitestSchemaName(RUN_ID, "0", "unit"))
    ).toBe(true);
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
  });

  it("retains a concurrent run's metadata, including when refusing an application URL", async () => {
    fileRunId = "newer-run";
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://test:secret@database.example.com/opensprint");
    await expect(globalTeardown()).rejects.toThrow("Refusing to clean application database");
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("keeps newer worker metadata published while its schema cleanup is running", async () => {
    mocks.query.mockImplementation(async () => {
      fileRunId = "newer-run";
      return { rows: [] };
    });
    await globalTeardown();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("still releases owned metadata after a test database cleanup failure", async () => {
    mocks.query.mockRejectedValue(new Error("Test database unreachable"));
    await globalTeardown();
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
  });
});
