import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { API_PREFIX } from "@opensprint/shared";
import { classifyDbConnectionError } from "../db/db-errors.js";
import { dbStatusRouter } from "../routes/db-status.js";
import { databaseRuntime } from "../services/database-runtime.service.js";
import { errorHandler } from "../middleware/error-handler.js";

describe("classifyDbConnectionError", () => {
  it("returns human-readable message for ECONNREFUSED", () => {
    expect(classifyDbConnectionError({ code: "ECONNREFUSED" })).toBe(
      "The database server could not be reached; make sure PostgreSQL is running and the host and port in your settings are correct."
    );
  });

  it("returns human-readable message for ETIMEDOUT", () => {
    expect(classifyDbConnectionError({ code: "ETIMEDOUT" })).toBe(
      "The database server could not be reached; make sure PostgreSQL is running and the host and port in your settings are correct."
    );
  });

  it("returns human-readable message for ENOTFOUND", () => {
    expect(classifyDbConnectionError({ code: "ENOTFOUND" })).toBe(
      "The database server could not be reached; make sure PostgreSQL is running and the host and port in your settings are correct."
    );
  });

  it("returns human-readable message for 28P01", () => {
    expect(classifyDbConnectionError({ code: "28P01" })).toBe(
      "The database rejected the connection; check the username, password, and database name in your settings."
    );
  });

  it("returns human-readable message for 3D000", () => {
    expect(classifyDbConnectionError({ code: "3D000" })).toBe(
      "The database rejected the connection; check the username, password, and database name in your settings."
    );
  });

  it("returns default message for unknown errors", () => {
    expect(classifyDbConnectionError(new Error("Something else"))).toBe(
      "OpenSprint could not connect to the database; check that the server is running and your connection settings are correct."
    );
  });

  it("returns unreachable for connection refused in message", () => {
    expect(classifyDbConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(
      "The database server could not be reached; make sure PostgreSQL is running and the host and port in your settings are correct."
    );
  });

  it("returns auth/config for password authentication failed in message", () => {
    expect(classifyDbConnectionError(new Error("password authentication failed for user"))).toBe(
      "The database rejected the connection; check the username, password, and database name in your settings."
    );
  });

  it("returns sqlite runtime guidance for native module load failures", () => {
    expect(
      classifyDbConnectionError(
        {
          code: "ERR_DLOPEN_FAILED",
          message:
            "The module '/tmp/better_sqlite3.node' was compiled against a different Node.js version",
        },
        "sqlite"
      )
    ).toBe(
      "OpenSprint could not load its SQLite runtime. The desktop installation may be incomplete or built for the wrong CPU architecture. Reinstall OpenSprint using the installer that matches your machine (x64 or arm64)."
    );
  });

  it("returns sqlite permission guidance for EACCES", () => {
    expect(classifyDbConnectionError({ code: "EACCES" }, "sqlite")).toBe(
      "OpenSprint could not open the database file because of file permissions. Check that the configured folder is writable."
    );
  });
});

describe("GET /db-status", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.restoreAllMocks();
    app = express();
    app.use(express.json());
    app.use(`${API_PREFIX}/db-status`, dbStatusRouter);
    app.use(errorHandler);
  });

  it("returns ok: true when runtime is connected", async () => {
    vi.spyOn(databaseRuntime, "getStatus").mockResolvedValue({
      ok: true,
      state: "connected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await request(app).get(`${API_PREFIX}/db-status`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      ok: true,
      state: "connected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  it("returns ok: false with default message when connection fails", async () => {
    vi.spyOn(databaseRuntime, "getStatus").mockResolvedValue({
      ok: false,
      message:
        "OpenSprint could not connect to the database; check that the server is running and your connection settings are correct.",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await request(app).get(`${API_PREFIX}/db-status`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      ok: false,
      message:
        "OpenSprint could not connect to the database; check that the server is running and your connection settings are correct.",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  it("returns ok: false with root cause when Postgres unreachable", async () => {
    vi.spyOn(databaseRuntime, "getStatus").mockResolvedValue({
      ok: false,
      message:
        "The database server could not be reached; make sure PostgreSQL is running and the host and port in your settings are correct.",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await request(app).get(`${API_PREFIX}/db-status`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      ok: false,
      message:
        "The database server could not be reached; make sure PostgreSQL is running and the host and port in your settings are correct.",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  it("returns ok: false with auth/config message when applicable", async () => {
    vi.spyOn(databaseRuntime, "getStatus").mockResolvedValue({
      ok: false,
      message:
        "The database rejected the connection; check the username, password, and database name in your settings.",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await request(app).get(`${API_PREFIX}/db-status`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      ok: false,
      message:
        "The database rejected the connection; check the username, password, and database name in your settings.",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });
  });
});
