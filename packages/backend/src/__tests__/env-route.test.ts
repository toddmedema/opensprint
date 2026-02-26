import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { envRouter } from "../routes/env.js";
import { API_PREFIX } from "@opensprint/shared";
import { setEnvPathForTesting } from "../routes/env.js";
import { errorHandler } from "../middleware/error-handler.js";
import { setGlobalSettings } from "../services/global-settings.service.js";

const mockValidateApiKey = vi.fn();

vi.mock("../routes/models.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../routes/models.js")>();
  return {
    ...mod,
    validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
  };
});

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

function createMinimalEnvApp() {
  const app = express();
  app.use(express.json());
  app.use(`${API_PREFIX}/env`, envRouter);
  app.use(errorHandler);
  return app;
}

describe("Env API", () => {
  let app: ReturnType<typeof createMinimalEnvApp>;
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    app = createMinimalEnvApp();
    vi.clearAllMocks();
    tmpDir = path.join(
      os.tmpdir(),
      `env-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "", "utf-8");
    setEnvPathForTesting(envPath);
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    setEnvPathForTesting(null);
    process.env.HOME = originalHome;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("POST /env/keys/validate", () => {
    it("returns 400 when provider and value are missing", async () => {
      const res = await request(app).post(`${API_PREFIX}/env/keys/validate`).send({});
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
      expect(res.body.error?.message).toContain("provider and value are required");
      expect(mockValidateApiKey).not.toHaveBeenCalled();
    });

    it("returns 400 when provider is not claude or cursor", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/env/keys/validate`)
        .send({ provider: "openai", value: "sk-test" });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
      expect(res.body.error?.message).toContain("provider must be");
      expect(mockValidateApiKey).not.toHaveBeenCalled();
    });

    it("returns valid: true when validation succeeds for Claude", async () => {
      mockValidateApiKey.mockResolvedValue({ valid: true });

      const res = await request(app)
        .post(`${API_PREFIX}/env/keys/validate`)
        .send({ provider: "claude", value: "sk-ant-test" });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ valid: true });
      expect(mockValidateApiKey).toHaveBeenCalledWith("claude", "sk-ant-test");
    });

    it("returns valid: true when validation succeeds for Cursor", async () => {
      mockValidateApiKey.mockResolvedValue({ valid: true });

      const res = await request(app)
        .post(`${API_PREFIX}/env/keys/validate`)
        .send({ provider: "cursor", value: "cursor-key-123" });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ valid: true });
      expect(mockValidateApiKey).toHaveBeenCalledWith("cursor", "cursor-key-123");
    });

    it("returns valid: false with error when validation fails", async () => {
      mockValidateApiKey.mockResolvedValue({
        valid: false,
        error: "Invalid API key",
      });

      const res = await request(app)
        .post(`${API_PREFIX}/env/keys/validate`)
        .send({ provider: "claude", value: "bad-key" });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ valid: false, error: "Invalid API key" });
      expect(mockValidateApiKey).toHaveBeenCalledWith("claude", "bad-key");
    });
  });

  describe("GET /env/keys", () => {
    it("returns shape with anthropic, cursor, claudeCli, useCustomCli booleans", async () => {
      const res = await request(app).get(`${API_PREFIX}/env/keys`);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(typeof res.body.data.anthropic).toBe("boolean");
      expect(typeof res.body.data.cursor).toBe("boolean");
      expect(typeof res.body.data.claudeCli).toBe("boolean");
      expect(typeof res.body.data.useCustomCli).toBe("boolean");
    });

    it("anthropic true when global store has ANTHROPIC_API_KEY", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-xxx" }],
        },
      });

      const res = await request(app).get(`${API_PREFIX}/env/keys`);
      expect(res.status).toBe(200);
      expect(res.body.data.anthropic).toBe(true);
    });

    it("cursor true when global store has CURSOR_API_KEY", async () => {
      await setGlobalSettings({
        apiKeys: {
          CURSOR_API_KEY: [{ id: "k2", value: "cursor-xxx" }],
        },
      });

      const res = await request(app).get(`${API_PREFIX}/env/keys`);
      expect(res.status).toBe(200);
      expect(res.body.data.cursor).toBe(true);
    });

    it("anthropic true when process.env has ANTHROPIC_API_KEY", async () => {
      const original = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";

      try {
        const res = await request(app).get(`${API_PREFIX}/env/keys`);
        expect(res.status).toBe(200);
        expect(res.body.data.anthropic).toBe(true);
      } finally {
        process.env.ANTHROPIC_API_KEY = original;
      }
    });

    it("cursor true when process.env has CURSOR_API_KEY", async () => {
      const original = process.env.CURSOR_API_KEY;
      process.env.CURSOR_API_KEY = "cursor-test-key";

      try {
        const res = await request(app).get(`${API_PREFIX}/env/keys`);
        expect(res.status).toBe(200);
        expect(res.body.data.cursor).toBe(true);
      } finally {
        process.env.CURSOR_API_KEY = original;
      }
    });

    it("useCustomCli reflects global settings", async () => {
      await setGlobalSettings({ useCustomCli: true });

      const res = await request(app).get(`${API_PREFIX}/env/keys`);
      expect(res.status).toBe(200);
      expect(res.body.data.useCustomCli).toBe(true);
    });
  });

  describe("POST /env/keys", () => {
    it("returns 400 when key and value are missing", async () => {
      const res = await request(app).post(`${API_PREFIX}/env/keys`).send({});
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
    });

    it("returns 400 when key is not allowed", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/env/keys`)
        .send({ key: "OTHER_KEY", value: "secret" });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_KEY");
    });

    it("returns 400 when value is empty", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/env/keys`)
        .send({ key: "ANTHROPIC_API_KEY", value: "   " });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
    });

    it("saves allowed key to .env and returns 200", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/env/keys`)
        .send({ key: "ANTHROPIC_API_KEY", value: "sk-test-value" });
      expect(res.status).toBe(200);
      expect(res.body.data?.saved).toBe(true);

      const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
      expect(content).toMatch(/ANTHROPIC_API_KEY=.*sk-test-value/);
    });

    it("appends to existing .env without stripping other keys", async () => {
      fs.writeFileSync(path.join(tmpDir, ".env"), "EXISTING=ok\n", "utf-8");

      await request(app)
        .post(`${API_PREFIX}/env/keys`)
        .send({ key: "CURSOR_API_KEY", value: "cursor-secret" });

      const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
      expect(content).toMatch(/EXISTING=ok/);
      expect(content).toMatch(/CURSOR_API_KEY=.*cursor-secret/);
    });
  });

  describe("GET /env/global-status", () => {
    it("returns hasAnyKey and useCustomCli", async () => {
      const res = await request(app).get(`${API_PREFIX}/env/global-status`);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(typeof res.body.data.hasAnyKey).toBe("boolean");
      expect(typeof res.body.data.useCustomCli).toBe("boolean");
    });

    it("hasAnyKey true when global store has keys", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-xxx" }],
        },
      });

      const res = await request(app).get(`${API_PREFIX}/env/global-status`);
      expect(res.status).toBe(200);
      expect(res.body.data.hasAnyKey).toBe(true);
    });

    it("hasAnyKey true when process.env has ANTHROPIC_API_KEY", async () => {
      const original = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";

      try {
        const res = await request(app).get(`${API_PREFIX}/env/global-status`);
        expect(res.status).toBe(200);
        expect(res.body.data.hasAnyKey).toBe(true);
      } finally {
        process.env.ANTHROPIC_API_KEY = original;
      }
    });

    it("hasAnyKey true when process.env has CURSOR_API_KEY", async () => {
      const original = process.env.CURSOR_API_KEY;
      process.env.CURSOR_API_KEY = "cursor-test-key";

      try {
        const res = await request(app).get(`${API_PREFIX}/env/global-status`);
        expect(res.status).toBe(200);
        expect(res.body.data.hasAnyKey).toBe(true);
      } finally {
        process.env.CURSOR_API_KEY = original;
      }
    });

    it("useCustomCli reflects global settings", async () => {
      await setGlobalSettings({ useCustomCli: true });

      const res = await request(app).get(`${API_PREFIX}/env/global-status`);
      expect(res.status).toBe(200);
      expect(res.body.data.useCustomCli).toBe(true);
    });
  });

  describe("PUT /env/global-settings", () => {
    it("updates useCustomCli and returns it", async () => {
      const res = await request(app)
        .put(`${API_PREFIX}/env/global-settings`)
        .send({ useCustomCli: true });

      expect(res.status).toBe(200);
      expect(res.body.data.useCustomCli).toBe(true);

      const statusRes = await request(app).get(`${API_PREFIX}/env/global-status`);
      expect(statusRes.body.data.useCustomCli).toBe(true);
    });

    it("persists useCustomCli across requests", async () => {
      await request(app)
        .put(`${API_PREFIX}/env/global-settings`)
        .send({ useCustomCli: true });

      const res = await request(app).get(`${API_PREFIX}/env/global-status`);
      expect(res.body.data.useCustomCli).toBe(true);
    });

    it("returns current useCustomCli when body has no valid updates", async () => {
      await setGlobalSettings({ useCustomCli: true });

      const res = await request(app)
        .put(`${API_PREFIX}/env/global-settings`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.useCustomCli).toBe(true);
    });

    it("can set useCustomCli to false", async () => {
      await setGlobalSettings({ useCustomCli: true });

      const res = await request(app)
        .put(`${API_PREFIX}/env/global-settings`)
        .send({ useCustomCli: false });

      expect(res.status).toBe(200);
      expect(res.body.data.useCustomCli).toBe(false);
    });
  });
});
