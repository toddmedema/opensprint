import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { globalSettingsRouter } from "../routes/global-settings.js";
import { API_PREFIX } from "@opensprint/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { setGlobalSettings } from "../services/global-settings.service.js";

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

function createGlobalSettingsApp() {
  const app = express();
  app.use(express.json());
  app.use(`${API_PREFIX}/global-settings`, globalSettingsRouter);
  app.use(errorHandler);
  return app;
}

describe("Global Settings API", () => {
  let app: ReturnType<typeof createGlobalSettingsApp>;
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    app = createGlobalSettingsApp();
    tmpDir = path.join(
      os.tmpdir(),
      `global-settings-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("GET /global-settings", () => {
    it("returns masked default databaseUrl when not configured", async () => {
      const res = await request(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.databaseUrl).toBe(
        "postgresql://opensprint:***@localhost:5432/opensprint"
      );
    });

    it("returns masked databaseUrl with password redacted", async () => {
      await setGlobalSettings({
        databaseUrl: "postgresql://user:secret123@db.example.com:5432/mydb",
      });

      const res = await request(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toBe(
        "postgresql://user:***@db.example.com:5432/mydb"
      );
      expect(res.body.data.databaseUrl).not.toContain("secret123");
    });

    it("returns host and port visible in masked URL", async () => {
      await setGlobalSettings({
        databaseUrl: "postgresql://admin:xyz@remote.host:15432/prod",
      });

      const res = await request(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toContain("remote.host");
      expect(res.body.data.databaseUrl).toContain("15432");
      expect(res.body.data.databaseUrl).toContain("admin");
      expect(res.body.data.databaseUrl).not.toContain("xyz");
    });
  });

  describe("PUT /global-settings", () => {
    it("updates databaseUrl and returns masked value", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          databaseUrl: "postgresql://myuser:mypass@supabase.example.com:5432/db",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toBe(
        "postgresql://myuser:***@supabase.example.com:5432/db"
      );

      const getRes = await request(app).get(`${API_PREFIX}/global-settings`);
      expect(getRes.body.data.databaseUrl).toBe(
        "postgresql://myuser:***@supabase.example.com:5432/db"
      );
    });

    it("accepts postgres:// scheme", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
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

      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toBe("postgresql://a:***@host:5432/db");
    });

    it("returns 400 when databaseUrl is not a string", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ databaseUrl: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
      expect(res.body.error?.message).toContain("string");
    });

    it("returns 400 when databaseUrl is empty", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ databaseUrl: "   " });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
      expect(res.body.error?.message).toContain("empty");
    });

    it("returns 400 when databaseUrl has invalid scheme", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ databaseUrl: "mysql://localhost/db" });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
    });

    it("returns 400 when databaseUrl has no host", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({ databaseUrl: "postgresql://" });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
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

      const res = await request(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.apiKeys).toBeDefined();
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY).toEqual([
        { id: "k1", masked: "••••••••" },
      ]);
      expect(res.body.data.apiKeys.CURSOR_API_KEY).toEqual([
        { id: "k2", masked: "••••••••" },
      ]);
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY[0]).not.toHaveProperty("value");
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY[0]).not.toContain("secret");
    });

    it("omits apiKeys when not configured", async () => {
      const res = await request(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toBeDefined();
      expect(res.body.data.apiKeys).toBeUndefined();
    });

    it("returns limitHitAt in masked apiKeys when key is rate-limited", async () => {
      const limitHitAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-secret", limitHitAt },
          ],
        },
      });

      const res = await request(app).get(`${API_PREFIX}/global-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY).toEqual([
        { id: "k1", masked: "••••••••", limitHitAt },
      ]);
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY[0]).not.toHaveProperty("value");
    });
  });

  describe("PUT /global-settings with apiKeys", () => {
    it("accepts and persists apiKeys, returns masked", async () => {
      const res = await request(app)
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

      const getRes = await request(app).get(`${API_PREFIX}/global-settings`);
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

      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          apiKeys: {
            ANTHROPIC_API_KEY: [{ id: "k1" }],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.apiKeys.ANTHROPIC_API_KEY).toEqual([
        { id: "k1", masked: "••••••••" },
      ]);

      const getRes = await request(app).get(`${API_PREFIX}/global-settings`);
      expect(getRes.body.data.apiKeys.ANTHROPIC_API_KEY).toEqual([
        { id: "k1", masked: "••••••••" },
      ]);
    });

    it("accepts databaseUrl and apiKeys together", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/global-settings`)
        .send({
          databaseUrl: "postgresql://u:p@localhost:5432/db",
          apiKeys: {
            CURSOR_API_KEY: [{ id: "c1", value: "cursor-key" }],
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.databaseUrl).toContain("localhost");
      expect(res.body.data.apiKeys.CURSOR_API_KEY).toEqual([
        { id: "c1", masked: "••••••••" },
      ]);
    });
  });

  describe("GET /global-settings/reveal-key/:provider/:id", () => {
    it("returns the raw key value for a stored API key", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret-123" }],
        },
      });

      const res = await request(app).get(
        `${API_PREFIX}/global-settings/reveal-key/ANTHROPIC_API_KEY/k1`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ value: "sk-ant-secret-123" });
    });

    it("returns 404 when key not found", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/global-settings/reveal-key/ANTHROPIC_API_KEY/nonexistent`
      );

      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe("NOT_FOUND");
    });

    it("returns 400 for invalid provider", async () => {
      const res = await request(app).get(
        `${API_PREFIX}/global-settings/reveal-key/INVALID_PROVIDER/k1`
      );

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
    });
  });
});
