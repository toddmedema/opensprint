import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { API_PREFIX } from "@opensprint/shared";
import { classifyDbConnectionError } from "../db/db-errors.js";
import { dbStatusRouter } from "../routes/db-status.js";
import { databaseRuntime } from "../services/database-runtime.service.js";
import { errorHandler } from "../middleware/error-handler.js";

describe("classifyDbConnectionError", () => {
  it("returns 'No PostgreSQL server running' for ECONNREFUSED", () => {
    expect(classifyDbConnectionError({ code: "ECONNREFUSED" })).toBe(
      "No PostgreSQL server running"
    );
  });

  it("returns 'No PostgreSQL server running' for ETIMEDOUT", () => {
    expect(classifyDbConnectionError({ code: "ETIMEDOUT" })).toBe("No PostgreSQL server running");
  });

  it("returns 'No PostgreSQL server running' for ENOTFOUND", () => {
    expect(classifyDbConnectionError({ code: "ENOTFOUND" })).toBe("No PostgreSQL server running");
  });

  it("returns 'PostgreSQL server is running but wrong user or database setup' for 28P01", () => {
    expect(classifyDbConnectionError({ code: "28P01" })).toBe(
      "PostgreSQL server is running but wrong user or database setup"
    );
  });

  it("returns 'PostgreSQL server is running but wrong user or database setup' for 3D000", () => {
    expect(classifyDbConnectionError({ code: "3D000" })).toBe(
      "PostgreSQL server is running but wrong user or database setup"
    );
  });

  it("returns default message for unknown errors", () => {
    expect(classifyDbConnectionError(new Error("Something else"))).toBe(
      "Server is unable to connect to PostgreSQL database."
    );
  });

  it("returns unreachable for connection refused in message", () => {
    expect(classifyDbConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(
      "No PostgreSQL server running"
    );
  });

  it("returns auth/config for password authentication failed in message", () => {
    expect(classifyDbConnectionError(new Error("password authentication failed for user"))).toBe(
      "PostgreSQL server is running but wrong user or database setup"
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
      message: "Server is unable to connect to PostgreSQL database.",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await request(app).get(`${API_PREFIX}/db-status`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      ok: false,
      message: "Server is unable to connect to PostgreSQL database.",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  it("returns ok: false with root cause when Postgres unreachable", async () => {
    vi.spyOn(databaseRuntime, "getStatus").mockResolvedValue({
      ok: false,
      message: "No PostgreSQL server running",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await request(app).get(`${API_PREFIX}/db-status`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      ok: false,
      message: "No PostgreSQL server running",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  it("returns ok: false with auth/config message when applicable", async () => {
    vi.spyOn(databaseRuntime, "getStatus").mockResolvedValue({
      ok: false,
      message: "PostgreSQL server is running but wrong user or database setup",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });

    const res = await request(app).get(`${API_PREFIX}/db-status`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      ok: false,
      message: "PostgreSQL server is running but wrong user or database setup",
      state: "disconnected",
      lastCheckedAt: "2026-03-03T00:00:00.000Z",
    });
  });
});
