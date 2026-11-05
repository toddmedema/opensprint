import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  pool: vi.fn(),
  adminQuery: vi.fn(),
  verifyQuery: vi.fn(),
  adminEnd: vi.fn(),
  verifyEnd: vi.fn(),
  writeFile: vi.fn(),
  events: [] as string[],
}));

vi.mock("pg", () => ({ default: { Pool: mocks.pool } }));
vi.mock("fs/promises", () => ({ default: { writeFile: mocks.writeFile } }));

import { setup as globalSetup } from "./global-setup.js";

// Capture this during worker module loading: the root lifecycle must publish it
// before unit workers start, even when the integration project is not selected.
const workerBootstrap = {
  url:
    process.env.TEST_DATABASE_URL ??
    readFileSync(new URL("../../.vitest-postgres-url", import.meta.url), "utf-8").trim(),
  runId: readFileSync(new URL("../../.vitest-run-id", import.meta.url), "utf-8").trim(),
};

describe("root bootstrap before unit workers", () => {
  it("has published an isolated database URL and run identity before loading the worker", () => {
    expect(new URL(workerBootstrap.url).pathname).not.toBe("/opensprint");
    expect(workerBootstrap.runId).not.toBe("");
  });
});

describe("backend test database bootstrap", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.events.length = 0;
    vi.stubEnv("TEST_DATABASE_URL", undefined);
    vi.stubEnv("OPENSPRINT_VITEST_RUN_ID", "bootstrap-regression");
    vi.stubEnv("DATABASE_URL", "postgresql://production.example.com/opensprint");
    mocks.pool.mockImplementation(({ connectionString }: { connectionString: string }) => {
      if (new URL(connectionString).pathname === "/postgres") {
        return { query: mocks.adminQuery, end: mocks.adminEnd };
      }
      return { query: mocks.verifyQuery, end: mocks.verifyEnd };
    });
    mocks.adminQuery.mockImplementation(async (sql: string) => {
      mocks.events.push(sql.startsWith("SELECT") ? "check database" : "create database");
      return { rowCount: 0 };
    });
    mocks.verifyQuery.mockImplementation(async () => {
      mocks.events.push("verify test database");
      return { rows: [{ value: 1 }] };
    });
    mocks.writeFile.mockImplementation(async () => {
      mocks.events.push("publish worker configuration");
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("creates the missing test database and verifies it before publishing worker configuration", async () => {
    await globalSetup();
    expect(mocks.events).toEqual([
      "check database",
      "create database",
      "verify test database",
      "publish worker configuration",
      "publish worker configuration",
    ]);
    expect(mocks.adminQuery).toHaveBeenCalledWith("CREATE DATABASE opensprint_test");
    expect(
      mocks.pool.mock.calls.map(([options]) => new URL(options.connectionString).pathname)
    ).toEqual(["/postgres", "/opensprint_test"]);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.vitest-postgres-url$/),
      "postgresql://opensprint:opensprint@localhost:5432/opensprint_test",
      "utf-8"
    );
    expect(mocks.adminEnd).toHaveBeenCalledOnce();
    expect(mocks.verifyEnd).toHaveBeenCalledOnce();
  });

  it("uses an existing test database without requiring database creation", async () => {
    mocks.adminQuery.mockResolvedValue({ rowCount: 1 });
    await globalSetup();
    expect(mocks.adminQuery).toHaveBeenCalledTimes(1);
    expect(mocks.verifyQuery).toHaveBeenCalledWith("SELECT 1");
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  });

  it("can verify a pre-provisioned test database when admin access is unavailable", async () => {
    mocks.adminQuery.mockRejectedValue(new Error("Admin access denied"));
    await globalSetup();
    expect(mocks.verifyQuery).toHaveBeenCalledWith("SELECT 1");
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    expect(mocks.adminEnd).toHaveBeenCalledOnce();
  });

  it("fails before publishing worker configuration when the test database is unavailable", async () => {
    mocks.adminQuery.mockRejectedValue(new Error("Admin access denied"));
    mocks.verifyQuery.mockRejectedValue(new Error('database "opensprint_test" does not exist'));
    await expect(globalSetup()).rejects.toThrow("Cannot connect to test database opensprint_test");
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.adminEnd).toHaveBeenCalledOnce();
    expect(mocks.verifyEnd).toHaveBeenCalledOnce();
  });
});
