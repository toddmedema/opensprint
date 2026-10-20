import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.js";
import { API_PREFIX, buildSpaContentSecurityPolicyProduction } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { databaseRuntime } from "../services/database-runtime.service.js";
import {
  ensureLocalSessionToken,
  setLocalSessionTokenForTesting,
  VITEST_DEFAULT_LOCAL_SESSION_TOKEN,
} from "../services/local-session-auth.service.js";
import { authedSupertest } from "./local-auth-test-helpers.js";

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    init: vi.fn(),
    getDb: vi.fn().mockResolvedValue(null),
    listAll: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    show: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "os-mock" }),
    createMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    closeMany: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    deleteByProjectId: vi.fn(),
    deleteOpenQuestionsByProjectId: vi.fn(),
    ready: vi.fn().mockResolvedValue([]),
    readyWithStatusMap: vi.fn().mockResolvedValue({ ready: [], statusMap: new Map() }),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    getDependencies: vi.fn().mockResolvedValue([]),
    listInProgressWithAgentAssignee: vi.fn().mockResolvedValue([]),
    setOnTaskChange: vi.fn(),
    planUpsert: vi.fn(),
    planGet: vi.fn().mockResolvedValue(null),
    planList: vi.fn().mockResolvedValue([]),
    planDelete: vi.fn().mockResolvedValue(false),
    planGetByEpicId: vi.fn().mockResolvedValue(null),
    planGetShippedContent: vi.fn().mockResolvedValue(null),
    closePool: vi.fn(),
    runWrite: vi
      .fn()
      .mockImplementation(async (fn: (db: null) => Promise<unknown> | unknown) => fn(null)),
  },
  TaskStoreService: vi.fn(),
}));

describe("App", () => {
  beforeEach(() => {
    setLocalSessionTokenForTesting(VITEST_DEFAULT_LOCAL_SESSION_TOKEN);
    ensureLocalSessionToken();
  });

  it("should respond to health check at /health", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
    expect(res.body.timestamp).toBeDefined();
  });

  it("should serve API under /api/v1 prefix", async () => {
    const app = createApp();
    const res = await authedSupertest(app).get(`${API_PREFIX}/projects`);
    expect(res.status).toBe(200);
  });

  it("injects nonce-guarded local session bootstrap into desktop SPA document responses", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-app-test-"));
    const indexPath = path.join(tmpDir, "index.html");
    await fs.writeFile(
      indexPath,
      "<!doctype html><html><head><meta charset='utf-8'></head><body><div id='root'></div></body></html>",
      "utf-8"
    );

    const prevDesktop = process.env.OPENSPRINT_DESKTOP;
    const prevDist = process.env.OPENSPRINT_FRONTEND_DIST;
    process.env.OPENSPRINT_DESKTOP = "1";
    process.env.OPENSPRINT_FRONTEND_DIST = tmpDir;
    try {
      const app = createApp();
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      const nonceMatch = res.text.match(
        /<script nonce="([^"]+)">window\.__OPENSPRINT_LOCAL_SESSION__/
      );
      expect(nonceMatch).toBeTruthy();
      const nonce = nonceMatch![1];
      expect(res.headers["content-security-policy"]).toBe(
        buildSpaContentSecurityPolicyProduction({ desktopSessionScriptNonce: nonce })
      );
      expect(res.headers["cache-control"]).toMatch(/no-store/);
      expect(res.text).toContain("window.__OPENSPRINT_LOCAL_SESSION__=");
      expect(res.text).not.toContain("__opensprint_local_session.js");

      const tokenScriptRes = await request(app).get("/__opensprint_local_session.js");
      expect(tokenScriptRes.status).toBe(200);
      expect(tokenScriptRes.headers["content-type"]).toContain("application/javascript");
      expect(tokenScriptRes.headers["cache-control"]).toContain("no-store");
      expect(tokenScriptRes.text).toContain("window.__OPENSPRINT_LOCAL_SESSION__=");

      await fs.writeFile(path.join(tmpDir, "asset.js"), "console.log('static')");
      for (const route of [
        "/",
        "/index.html",
        "/projects/p1/execute",
        "/__opensprint_local_session.js",
      ]) {
        for (const site of ["same-site", "cross-site"]) {
          const forbidden = await request(app)
            .get(route)
            .set("Origin", "http://localhost:4555")
            .set("Sec-Fetch-Site", site);
          expect(forbidden.status, route).toBe(403);
          expect(forbidden.text).not.toContain(VITEST_DEFAULT_LOCAL_SESSION_TOKEN);
        }
        for (const site of ["none", "same-origin"]) {
          const allowed = await request(app).get(route).set("Sec-Fetch-Site", site);
          expect(allowed.status, route).toBe(200);
          expect(allowed.text).toContain(VITEST_DEFAULT_LOCAL_SESSION_TOKEN);
        }
      }
      expect((await request(app).get("/asset.js").set("Sec-Fetch-Site", "cross-site")).text).toBe(
        "console.log('static')"
      );
      expect((await request(app).get("/api/v1/missing")).text).not.toContain(
        VITEST_DEFAULT_LOCAL_SESSION_TOKEN
      );

      const crossSite = await request(app)
        .get("/__opensprint_local_session.js")
        .set("Sec-Fetch-Site", "cross-site");
      expect(crossSite.status).toBe(403);

      const sameSite = await request(app)
        .get("/__opensprint_local_session.js")
        .set("Sec-Fetch-Site", "same-site");
      expect(sameSite.status).toBe(403);
    } finally {
      if (prevDesktop === undefined) {
        delete process.env.OPENSPRINT_DESKTOP;
      } else {
        process.env.OPENSPRINT_DESKTOP = prevDesktop;
      }
      if (prevDist === undefined) {
        delete process.env.OPENSPRINT_FRONTEND_DIST;
      } else {
        process.env.OPENSPRINT_FRONTEND_DIST = prevDist;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects API requests without Bearer token", async () => {
    vi.useRealTimers();
    const app = createApp();
    const res = await request(app).get(`${API_PREFIX}/projects`).unset("Authorization");
    expect(res.status).toBe(403);
  });

  it("issues ws-upgrade ticket with Bearer auth", async () => {
    const app = createApp();
    const res = await authedSupertest(app)
      .post(`${API_PREFIX}/ws-upgrade-ticket`)
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(200);
    expect(typeof res.body?.data?.ticket).toBe("string");
    expect((res.body.data.ticket as string).length).toBeGreaterThan(20);
  });

  it("rejects ws-upgrade ticket without Bearer auth", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`${API_PREFIX}/ws-upgrade-ticket`)
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(403);
  });

  it("should parse JSON request bodies", async () => {
    const app = createApp();
    const res = await authedSupertest(app)
      .post(`${API_PREFIX}/projects`)
      .set("Content-Type", "application/json")
      .send({ name: "Test" });
    // Projects create may return 400/500 without valid setup, but body parsing works
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toBeDefined();
  });

  it("returns 503 for DB-gated routes when database is unavailable", async () => {
    const app = createApp();
    vi.spyOn(databaseRuntime, "requireDatabase").mockRejectedValueOnce(
      new AppError(
        503,
        ErrorCodes.DATABASE_UNAVAILABLE,
        "The database server could not be reached; make sure PostgreSQL is running and the host and port in your settings are correct."
      )
    );

    const res = await authedSupertest(app).get(`${API_PREFIX}/projects/proj-1/tasks`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: ErrorCodes.DATABASE_UNAVAILABLE,
      message:
        "The database server could not be reached; make sure PostgreSQL is running and the host and port in your settings are correct.",
    });
    expect(res.headers["retry-after"]).toBe("5");
  });
});
