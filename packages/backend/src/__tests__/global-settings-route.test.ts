import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { globalSettingsRouter } from "../routes/global-settings.js";
import { API_PREFIX } from "@opensprint/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { requireLocalSessionAuth } from "../middleware/require-local-session-auth.js";
import {
  setGlobalSettings,
  getGlobalSettings,
  setGlobalSettingsPathForTesting,
} from "../services/global-settings.service.js";
import {
  ensureLocalSessionToken,
  setLocalSessionTokenForTesting,
  VITEST_DEFAULT_LOCAL_SESSION_TOKEN,
} from "../services/local-session-auth.service.js";
import { authedSupertest } from "./local-auth-test-helpers.js";

vi.mock("../db/app-db.js", () => ({
  initAppDb: vi.fn().mockResolvedValue({
    getClient: vi.fn().mockResolvedValue(undefined),
    runWrite: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    init: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    listInProgressWithAgentAssignee: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    comment: vi.fn().mockResolvedValue(undefined),
    ready: vi.fn().mockResolvedValue([]),
    addDependency: vi.fn().mockResolvedValue(undefined),
    syncForPush: vi.fn().mockResolvedValue(undefined),
  },
  TaskStoreService: vi.fn(),
  SCHEMA_SQL: "",
}));

const mockNudge = vi.fn();
vi.mock("../services/orchestrator.service.js", () => ({
  orchestratorService: { nudge: (...args: unknown[]) => mockNudge(...args) },
}));

const mockGetProjects = vi.fn().mockResolvedValue([]);
vi.mock("../services/project-index.js", () => ({
  getProjectIndexRevision: vi.fn().mockResolvedValue(null),
  getProjects: () => mockGetProjects(),
}));

vi.mock("../services/database-runtime.service.js", () => ({
  databaseRuntime: { requestReconnect: vi.fn() },
}));

function createGlobalSettingsApp() {
  setLocalSessionTokenForTesting(VITEST_DEFAULT_LOCAL_SESSION_TOKEN);
  ensureLocalSessionToken();
  const app = express();
  app.use(express.json());
  app.use(API_PREFIX, requireLocalSessionAuth);
  app.use(`${API_PREFIX}/global-settings`, globalSettingsRouter);
  app.use(errorHandler);
  return app;
}

function isTransientSupertestTransportError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : "";
  return (
    /socket hang up|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|timeout|ECONNREFUSED|Parse Error/i.test(
      msg
    ) || /socket hang up|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|timeout|ECONNREFUSED/i.test(code)
  );
}

/** Same pattern as env-route `getGlobalStatus`: timeout + retries under parallel vitest (merge-gate flakes). */
const GS_SUPERTEST_TIMEOUT_MS = 10_000;

function gsAuthed(app: ReturnType<typeof createGlobalSettingsApp>) {
  const base = authedSupertest(app);
  async function retry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isTransientSupertestTransportError(err) || attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
  return {
    get: (url: string) => retry(() => base.get(url).timeout(GS_SUPERTEST_TIMEOUT_MS)),
    put: (url: string) => ({
      send: (body: object) =>
        retry(() => base.put(url).send(body).timeout(GS_SUPERTEST_TIMEOUT_MS)),
    }),
    post: (url: string) => ({
      send: (body: object) =>
        retry(() => base.post(url).send(body).timeout(GS_SUPERTEST_TIMEOUT_MS)),
    }),
  };
}

describe("Global Settings API", () => {
  let app: ReturnType<typeof createGlobalSettingsApp>;
  let tmpDir: string;

  beforeEach(() => {
    app = createGlobalSettingsApp();
    tmpDir = path.join(
      os.tmpdir(),
      `global-settings-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    setGlobalSettingsPathForTesting(path.join(tmpDir, ".opensprint", "global-settings.json"));
    mockNudge.mockClear();
    mockGetProjects.mockResolvedValue([]);
  });

  afterEach(() => {
    setGlobalSettingsPathForTesting(null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    // Other suites call `setLocalSessionTokenForTesting` with a non-default token; reset so the
    // next file's `authedSupertest` / mini-apps agree with the Vitest default (merge-gate flake).
    setLocalSessionTokenForTesting(VITEST_DEFAULT_LOCAL_SESSION_TOKEN);
    ensureLocalSessionToken();
  });

  describe("GET /global-settings", () => {
    it("returns masked default databaseUrl when not configured", async () => {
      const res = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.databaseUrl).toContain("opensprint.sqlite");
      expect(res.body.data.databaseDialect).toBe("sqlite");
    });

    it("returns preferredEditor defaulting to 'auto' when not configured", async () => {
      const res = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.preferredEditor).toBe("auto");
    });

    it("returns masked databaseUrl with password redacted", async () => {
      await setGlobalSettings({
        databaseUrl: "postgresql://user:secret123@db.example.com:5432/mydb",
      });

      const res = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toBe("postgresql://user:***@db.example.com:5432/mydb");
      expect(res.body.data.databaseUrl).not.toContain("secret123");
    });

    it("returns host and port visible in masked URL", async () => {
      await setGlobalSettings({
        databaseUrl: "postgresql://admin:xyz@remote.host:15432/prod",
      });

      const res = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toContain("remote.host");
      expect(res.body.data.databaseUrl).toContain("15432");
      expect(res.body.data.databaseUrl).toContain("admin");
      expect(res.body.data.databaseUrl).not.toContain("xyz");
    });
  });

  describe("PUT /global-settings", () => {
    it("updates databaseUrl and returns masked value", async () => {
      const res = await gsAuthed(app).put(`${API_PREFIX}/global-settings`).send({
        databaseUrl: "postgresql://myuser:mypass@supabase.example.com:5432/db",
      });

      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toBe(
        "postgresql://myuser:***@supabase.example.com:5432/db"
      );

      const getRes = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(getRes.body.data.databaseUrl).toBe(
        "postgresql://myuser:***@supabase.example.com:5432/db"
      );
    });

    it("accepts postgres:// scheme", async () => {
      const res = await gsAuthed(app).put(`${API_PREFIX}/global-settings`).send({
        databaseUrl: "postgres://u:secret@localhost:5432/test",
      });

      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toContain("localhost");
      expect(res.body.data.databaseUrl).toContain("5432");
      expect(res.body.data.databaseUrl).toBe("postgres://u:***@localhost:5432/test");
      expect(res.body.data.databaseUrl).not.toContain("secret");
    });

    it("returns current masked value when body has no databaseUrl", async () => {
      await setGlobalSettings({
        databaseUrl: "postgresql://a:b@host:5432/db",
      });

      const res = await gsAuthed(app).put(`${API_PREFIX}/global-settings`).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toBe("postgresql://a:***@host:5432/db");
    });

    it("returns 400 when databaseUrl is not a string", async () => {
      const res = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ databaseUrl: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
      expect(res.body.error?.message).toContain("string");
    });

    it("returns 400 when databaseUrl is empty", async () => {
      const res = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ databaseUrl: "   " });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
      expect(res.body.error?.message).toContain("empty");
    });

    it("returns 400 when databaseUrl has invalid scheme", async () => {
      const res = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ databaseUrl: "mysql://localhost/db" });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
    });

    it("returns 400 when databaseUrl has no host", async () => {
      const res = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ databaseUrl: "postgresql://" });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
    });

    it("round-trips global agent defaults on PUT and GET", async () => {
      const simple = { type: "cursor", model: "global-simple", cliCommand: null };
      const complex = { type: "cursor", model: "global-complex", cliCommand: null };
      const putRes = await gsAuthed(app).put(`${API_PREFIX}/global-settings`).send({
        simpleComplexityAgent: simple,
        complexComplexityAgent: complex,
      });
      expect(putRes.status).toBe(200);
      expect(putRes.body.data.simpleComplexityAgent).toEqual(simple);
      expect(putRes.body.data.complexComplexityAgent).toEqual(complex);

      const getRes = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.simpleComplexityAgent).toEqual(simple);
      expect(getRes.body.data.complexComplexityAgent).toEqual(complex);

      const disk = await getGlobalSettings();
      expect(disk.simpleComplexityAgent).toEqual(simple);
      expect(disk.complexComplexityAgent).toEqual(complex);
    });

    it("round-trips preferredEditor on PUT and GET", async () => {
      const putRes = await gsAuthed(app).put(`${API_PREFIX}/global-settings`).send({
        preferredEditor: "cursor",
      });
      expect(putRes.status).toBe(200);
      expect(putRes.body.data.preferredEditor).toBe("cursor");
      const getRes = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(getRes.body.data.preferredEditor).toBe("cursor");
    });

    it("returns 400 for invalid preferredEditor", async () => {
      const res = await gsAuthed(app).put(`${API_PREFIX}/global-settings`).send({
        preferredEditor: "vim",
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
    });

    it("clears preferredEditor when null (reverts to default auto)", async () => {
      await gsAuthed(app).put(`${API_PREFIX}/global-settings`).send({
        preferredEditor: "vscode",
      });
      const clear = await gsAuthed(app).put(`${API_PREFIX}/global-settings`).send({
        preferredEditor: null,
      });
      expect(clear.status).toBe(200);
      expect(clear.body.data.preferredEditor).toBe("auto");
      const disk = await getGlobalSettings();
      expect(disk.preferredEditor).toBe("auto");
    });

    it("accepts all valid preferredEditor values", async () => {
      for (const editor of ["vscode", "cursor", "auto"]) {
        const res = await gsAuthed(app).put(`${API_PREFIX}/global-settings`).send({
          preferredEditor: editor,
        });
        expect(res.status).toBe(200);
        expect(res.body.data.preferredEditor).toBe(editor);
      }
    });

    it("clears global agent defaults when PUT sends null", async () => {
      await setGlobalSettings({
        simpleComplexityAgent: { type: "cursor", model: "x", cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: "y", cliCommand: null },
      });
      const putRes = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ simpleComplexityAgent: null, complexComplexityAgent: null });
      expect(putRes.status).toBe(200);
      expect(putRes.body.data.simpleComplexityAgent).toBeUndefined();
      expect(putRes.body.data.complexComplexityAgent).toBeUndefined();
    });

    it("returns 400 for invalid global agent config", async () => {
      const res = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          simpleComplexityAgent: { type: "cursor", model: "ok", cliCommand: null },
          complexComplexityAgent: { type: "invalid-type", model: null, cliCommand: null },
        });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_AGENT_CONFIG");
    });
  });

  describe("GET /global-settings with apiKeys", () => {
    it("returns masked apiKeys when configured", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret123" }],
          CURSOR_API_KEY: [{ id: "k2", value: "cursor-key-xyz" }],
        },
      });

      const res = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.apiKeys).toBeDefined();
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY).toEqual([{ id: "k1", masked: "••••••••" }]);
      expect(res.body.data.apiKeys.CURSOR_API_KEY).toEqual([{ id: "k2", masked: "••••••••" }]);
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY[0]).not.toHaveProperty("value");
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY[0]).not.toContain("secret");
    });

    it("omits apiKeys when not configured", async () => {
      const res = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toBeDefined();
      expect(res.body.data.apiKeys).toBeUndefined();
    });

    it("returns limitHitAt in masked apiKeys when key is rate-limited", async () => {
      const limitHitAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret", limitHitAt }],
        },
      });

      const res = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY).toEqual([
        { id: "k1", masked: "••••••••", limitHitAt },
      ]);
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY[0]).not.toHaveProperty("value");
    });
  });

  describe("PUT /global-settings with apiKeys", () => {
    it("accepts and persists apiKeys, returns masked", async () => {
      const res = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          apiKeys: {
            ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-new-key" }],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.apiKeys).toEqual({
        ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
      });
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY[0]).not.toContain("sk-ant-new-key");

      const getRes = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(getRes.body.data.apiKeys.ANTHROPIC_API_KEY).toEqual([
        { id: "k1", masked: "••••••••" },
      ]);
    });

    it("merges apiKeys with existing, preserves value when omitted", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "original-secret" }],
        },
      });

      const res = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          apiKeys: {
            ANTHROPIC_API_KEY: [{ id: "k1" }],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY).toEqual([{ id: "k1", masked: "••••••••" }]);

      const getRes = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(getRes.body.data.apiKeys.ANTHROPIC_API_KEY).toEqual([
        { id: "k1", masked: "••••••••" },
      ]);
    });

    it("accepts databaseUrl and apiKeys together", async () => {
      const res = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          databaseUrl: "postgresql://u:p@localhost:5432/db",
          apiKeys: {
            CURSOR_API_KEY: [{ id: "c1", value: "cursor-key" }],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toContain("localhost");
      expect(res.body.data.apiKeys.CURSOR_API_KEY).toEqual([{ id: "c1", masked: "••••••••" }]);
    });

    it("persists apiKeys array order (drag-to-reorder); GET returns same order", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-1" },
            { id: "k2", value: "sk-ant-2" },
            { id: "k3", value: "sk-ant-3" },
          ],
        },
      });

      const reordered = [
        { id: "k3", value: "sk-ant-3" },
        { id: "k1", value: "sk-ant-1" },
        { id: "k2", value: "sk-ant-2" },
      ];
      const putRes = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          apiKeys: { ANTHROPIC_API_KEY: reordered },
        });
      expect(putRes.status).toBe(200);
      const putIds = putRes.body.data.apiKeys.ANTHROPIC_API_KEY.map((e: { id: string }) => e.id);
      expect(putIds).toEqual(["k3", "k1", "k2"]);

      const getRes = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(getRes.status).toBe(200);
      const getIds = getRes.body.data.apiKeys.ANTHROPIC_API_KEY.map((e: { id: string }) => e.id);
      expect(getIds).toEqual(["k3", "k1", "k2"]);
    });
  });

  describe("GET /global-settings/reveal-key/:provider/:id", () => {
    it("returns the raw key value for a stored API key", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret-123" }],
        },
      });

      const res = await gsAuthed(app).get(
        `${API_PREFIX}/global-settings/reveal-key/ANTHROPIC_API_KEY/k1`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ value: "sk-ant-secret-123" });
    });

    it("returns 404 when key not found", async () => {
      const res = await gsAuthed(app).get(
        `${API_PREFIX}/global-settings/reveal-key/ANTHROPIC_API_KEY/nonexistent`
      );

      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe("NOT_FOUND");
    });

    it("returns 400 for invalid provider", async () => {
      const res = await gsAuthed(app).get(
        `${API_PREFIX}/global-settings/reveal-key/INVALID_PROVIDER/k1`
      );

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /global-settings/clear-limit-hit/:provider/:id", () => {
    it("clears limitHitAt for a rate-limited key and returns updated settings", async () => {
      const limitHitAt = new Date().toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret", limitHitAt }],
        },
      });

      const res = await gsAuthed(app)
        .post(`${API_PREFIX}/global-settings/clear-limit-hit/ANTHROPIC_API_KEY/k1`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY).toEqual([{ id: "k1", masked: "••••••••" }]);
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY[0]).not.toHaveProperty("limitHitAt");

      const gs = await getGlobalSettings();
      expect(gs.apiKeys?.ANTHROPIC_API_KEY?.[0]).not.toHaveProperty("limitHitAt");
    });

    it("returns 400 for invalid provider", async () => {
      const res = await gsAuthed(app)
        .post(`${API_PREFIX}/global-settings/clear-limit-hit/INVALID_PROVIDER/k1`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
    });

    it("no-ops when key has no limitHitAt (idempotent)", async () => {
      await setGlobalSettings({
        apiKeys: {
          CURSOR_API_KEY: [{ id: "c1", value: "cursor-key" }],
        },
      });

      const res = await gsAuthed(app)
        .post(`${API_PREFIX}/global-settings/clear-limit-hit/CURSOR_API_KEY/c1`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.apiKeys.CURSOR_API_KEY).toEqual([{ id: "c1", masked: "••••••••" }]);
    });

    it("nudges orchestrator for all projects when retry succeeds", async () => {
      const limitHitAt = new Date().toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret", limitHitAt }],
        },
      });
      mockGetProjects.mockResolvedValue([
        { id: "proj-a", name: "A", repoPath: "/a", createdAt: new Date().toISOString() },
        { id: "proj-b", name: "B", repoPath: "/b", createdAt: new Date().toISOString() },
      ]);

      const res = await gsAuthed(app)
        .post(`${API_PREFIX}/global-settings/clear-limit-hit/ANTHROPIC_API_KEY/k1`)
        .send({});

      expect(res.status).toBe(200);
      expect(mockNudge).toHaveBeenCalledTimes(2);
      expect(mockNudge).toHaveBeenCalledWith("proj-a");
      expect(mockNudge).toHaveBeenCalledWith("proj-b");
    });
  });

  describe("POST /global-settings/setup-tables", () => {
    it("returns 400 when databaseUrl is missing", async () => {
      const res = await gsAuthed(app).post(`${API_PREFIX}/global-settings/setup-tables`).send({});

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
      expect(res.body.error?.message).toContain("string");
    });

    it("returns 400 when databaseUrl is empty", async () => {
      const res = await gsAuthed(app)
        .post(`${API_PREFIX}/global-settings/setup-tables`)
        .send({ databaseUrl: "   " });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
      expect(res.body.error?.message).toMatch(/empty|string|required|min/i);
    });

    it("returns 400 when databaseUrl has invalid scheme", async () => {
      const res = await gsAuthed(app)
        .post(`${API_PREFIX}/global-settings/setup-tables`)
        .send({ databaseUrl: "mysql://localhost/db" });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
    });

    it("returns 200 and runs schema when databaseUrl is valid", async () => {
      const { getTestDatabaseUrl } = await import("./test-db-helper.js");
      let testUrl: string;
      try {
        testUrl = await getTestDatabaseUrl();
      } catch {
        return; // Skip if test DB not available
      }

      const res = await gsAuthed(app)
        .post(`${API_PREFIX}/global-settings/setup-tables`)
        .send({ databaseUrl: testUrl });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ ok: true });
    });
  });

  describe("Todoist credentials", () => {
    it("PUT saves todoistOAuth and GET returns masked credentials", async () => {
      const putRes = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          todoistOAuth: {
            clientId: "my-client-id",
            clientSecret: "my-secret",
            redirectUri: "http://localhost:3000/callback",
          },
        });

      expect(putRes.status).toBe(200);
      expect(putRes.body.data.todoistOAuth).toEqual({
        clientId: "my-client-id",
        clientSecretMasked: "••••••••",
        redirectUri: "http://localhost:3000/callback",
        configured: true,
      });

      const getRes = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(getRes.body.data.todoistOAuth).toEqual({
        clientId: "my-client-id",
        clientSecretMasked: "••••••••",
        redirectUri: "http://localhost:3000/callback",
        configured: true,
      });
    });

    it("GET /reveal-todoist-secret returns raw secret", async () => {
      await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          todoistOAuth: {
            clientId: "id",
            clientSecret: "the-actual-secret",
            redirectUri: "http://localhost/cb",
          },
        });

      const res = await gsAuthed(app).get(`${API_PREFIX}/global-settings/reveal-todoist-secret`);
      expect(res.status).toBe(200);
      expect(res.body.data.value).toBe("the-actual-secret");
    });

    it("GET /reveal-todoist-secret returns 404 when not configured", async () => {
      const res = await gsAuthed(app).get(`${API_PREFIX}/global-settings/reveal-todoist-secret`);
      expect(res.status).toBe(404);
    });

    it("PUT with todoistOAuth: null clears stored credentials", async () => {
      await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          todoistOAuth: {
            clientId: "id",
            clientSecret: "secret",
            redirectUri: "http://localhost/cb",
          },
        });

      const clearRes = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ todoistOAuth: null });

      expect(clearRes.status).toBe(200);
      expect(clearRes.body.data.todoistOAuth).toBeUndefined();

      const getRes = await gsAuthed(app).get(`${API_PREFIX}/global-settings`);
      expect(getRes.body.data.todoistOAuth).toBeUndefined();
    });

    it("preserves existing secret when updating clientId/redirectUri with empty secret", async () => {
      await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          todoistOAuth: {
            clientId: "id-original",
            clientSecret: "secret-original",
            redirectUri: "http://localhost/original",
          },
        });

      const updateRes = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          todoistOAuth: {
            clientId: "id-updated",
            clientSecret: "",
            redirectUri: "http://localhost/updated",
          },
        });

      expect(updateRes.status).toBe(200);
      const settings = await getGlobalSettings();
      expect(settings.todoistOAuth).toEqual({
        clientId: "id-updated",
        clientSecret: "secret-original",
        redirectUri: "http://localhost/updated",
      });
    });

    it("rejects todoistOAuth updates missing a usable clientSecret", async () => {
      const res = await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          todoistOAuth: {
            clientId: "id-only",
            clientSecret: "",
            redirectUri: "http://localhost/callback",
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
      expect(res.body.error?.message).toContain("clientSecret");
    });

    it("persists todoistOAuth to disk and reads it back", async () => {
      await gsAuthed(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          todoistOAuth: {
            clientId: "persist-id",
            clientSecret: "persist-secret",
            redirectUri: "http://localhost/persist",
          },
        });

      const settings = await getGlobalSettings();
      expect(settings.todoistOAuth).toEqual({
        clientId: "persist-id",
        clientSecret: "persist-secret",
        redirectUri: "http://localhost/persist",
      });
    });
  });

  describe("local session auth", () => {
    it("rejects PUT /global-settings without bearer or localhost Origin/Referer", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ databaseUrl: "postgresql://u:p@127.0.0.1:5432/db" });

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe("LOCAL_SESSION_AUTH_REQUIRED");
    });

    it("rejects PUT /global-settings with only localhost Origin (CSRF protection)", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .set("Origin", "http://127.0.0.1:5173")
        .send({ databaseUrl: "postgresql://u:p@127.0.0.1:5432/db" });

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe("LOCAL_SESSION_AUTH_REQUIRED");
    });
  });
});
