import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  getNextKey,
  recordLimitHit,
  clearLimitHit,
  ENV_FALLBACK_KEY_ID,
} from "../services/api-key-resolver.service.js";
import { setSettingsInStore } from "../services/settings-store.service.js";
import { setGlobalSettings, getGlobalSettings } from "../services/global-settings.service.js";
import type { ProjectSettings } from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG, DEFAULT_DEPLOYMENT_CONFIG, DEFAULT_REVIEW_MODE } from "@opensprint/shared";

function makeSettings(overrides?: Partial<ProjectSettings>): ProjectSettings {
  const defaultAgent = { type: "cursor" as const, model: null as string | null, cliCommand: null as string | null };
  return {
    simpleComplexityAgent: defaultAgent,
    complexComplexityAgent: defaultAgent,
    deployment: { ...DEFAULT_DEPLOYMENT_CONFIG },
    hilConfig: { ...DEFAULT_HIL_CONFIG },
    testFramework: null,
    testCommand: null,
    reviewMode: DEFAULT_REVIEW_MODE,
    gitWorkingMode: "worktree",
    ...overrides,
  };
}

describe("ApiKeyResolver", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  const projectId = "test-project-1";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-apikey-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CURSOR_API_KEY;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CURSOR_API_KEY;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("getNextKey — priority: global → env", () => {
    it("returns global store key with source 'global' when available", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "g1", value: "sk-ant-global" }],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-global", keyId: "g1", source: "global" });
    });

    it("returns null when all global keys are rate-limited (no env fallback)", async () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "g1", value: "sk-ant-global", limitHitAt: recent }],
        },
      });
      process.env.ANTHROPIC_API_KEY = "env-key-value";
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toBeNull();
    });

    it("falls back to env when no global keys exist", async () => {
      process.env.ANTHROPIC_API_KEY = "env-key-value";
      await setGlobalSettings({});
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "env-key-value", keyId: ENV_FALLBACK_KEY_ID, source: "env" });
    });

    it("does NOT fall back to env when global keys exist but are all rate-limited", async () => {
      process.env.ANTHROPIC_API_KEY = "env-key-value";
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "g1", value: "sk-ant-global", limitHitAt: recent }],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toBeNull();
    });

    it("returns null when nothing configured at all", async () => {
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toBeNull();
    });

    it("returns global key with expired limitHitAt (>24h ago)", async () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "g1", value: "sk-ant-global", limitHitAt: old }],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-global", keyId: "g1", source: "global" });
    });

    it("skips keys with empty value in global store", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "g1", value: "" },
            { id: "g2", value: "sk-ant-valid" },
          ],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-valid", keyId: "g2", source: "global" });
    });

    it("returns first available global key when second has limitHitAt within 24h", async () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-first", limitHitAt: recent },
            { id: "k2", value: "sk-ant-second" },
          ],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-second", keyId: "k2", source: "global" });
    });
  });

  describe("recordLimitHit — global store only", () => {
    it("sets limitHitAt in global store when source is 'global'", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "g1", value: "sk-ant-a" },
            { id: "g2", value: "sk-ant-b" },
          ],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", "g1", "global");

      const gs = await getGlobalSettings();
      expect(gs.apiKeys?.ANTHROPIC_API_KEY?.[0]?.limitHitAt).toBeDefined();
      expect(gs.apiKeys?.ANTHROPIC_API_KEY?.[1]?.limitHitAt).toBeUndefined();

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-b", keyId: "g2", source: "global" });
    });

    it("defaults to global store when source is omitted", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "g1", value: "sk-ant-a" },
            { id: "g2", value: "sk-ant-b" },
          ],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", "g1");

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-b", keyId: "g2", source: "global" });
    });

    it("is no-op when keyId is ENV_FALLBACK_KEY_ID", async () => {
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);
      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", ENV_FALLBACK_KEY_ID, "env");
    });

    it("is no-op when source is 'env'", async () => {
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);
      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", "k1", "env");
    });

    it("is no-op when keyId not found in global entries", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "g1", value: "sk-ant" }],
        },
      });

      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", "nonexistent", "global");

      const gs = await getGlobalSettings();
      expect(gs.apiKeys?.ANTHROPIC_API_KEY?.[0]?.limitHitAt).toBeUndefined();
    });
  });

  describe("clearLimitHit — global store only", () => {
    it("clears limitHitAt in global store when source is 'global'", async () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "g1", value: "sk-ant-a", limitHitAt: recent },
            { id: "g2", value: "sk-ant-b" },
          ],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      await clearLimitHit(projectId, "ANTHROPIC_API_KEY", "g1", "global");

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-a", keyId: "g1", source: "global" });
    });

    it("defaults to global store when source is omitted", async () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "g1", value: "sk-ant-a", limitHitAt: recent },
            { id: "g2", value: "sk-ant-b" },
          ],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      await clearLimitHit(projectId, "ANTHROPIC_API_KEY", "g1");

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-a", keyId: "g1", source: "global" });
    });

    it("is no-op when keyId is ENV_FALLBACK_KEY_ID", async () => {
      await clearLimitHit(projectId, "ANTHROPIC_API_KEY", ENV_FALLBACK_KEY_ID, "env");
    });

    it("is no-op when source is 'env'", async () => {
      await clearLimitHit(projectId, "ANTHROPIC_API_KEY", "k1", "env");
    });

    it("is no-op when provider has no apiKeys in global store", async () => {
      await setGlobalSettings({});
      await clearLimitHit(projectId, "ANTHROPIC_API_KEY", "g1", "global");
    });
  });

  describe("thread-safe updates", () => {
    it("concurrent recordLimitHit on global keys serialized correctly", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "g1", value: "sk-ant-1" },
            { id: "g2", value: "sk-ant-2" },
            { id: "g3", value: "sk-ant-3" },
          ],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      await Promise.all([
        recordLimitHit(projectId, "ANTHROPIC_API_KEY", "g1", "global"),
        recordLimitHit(projectId, "ANTHROPIC_API_KEY", "g2", "global"),
      ]);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-3", keyId: "g3", source: "global" });
    });
  });

  describe("key rotation", () => {
    it("rotates through global keys", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "g1", value: "sk-ant-g1" },
            { id: "g2", value: "sk-ant-g2" },
          ],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const r1 = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(r1).toEqual({ key: "sk-ant-g1", keyId: "g1", source: "global" });

      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", "g1", "global");
      const r2 = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(r2).toEqual({ key: "sk-ant-g2", keyId: "g2", source: "global" });

      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", "g2", "global");
      const r3 = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(r3).toBeNull();
    });
  });

  describe("CURSOR_API_KEY provider", () => {
    it("works for CURSOR_API_KEY provider with global store", async () => {
      await setGlobalSettings({
        apiKeys: {
          CURSOR_API_KEY: [{ id: "c1", value: "cursor-key-123" }],
        },
      });
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "CURSOR_API_KEY");
      expect(result).toEqual({ key: "cursor-key-123", keyId: "c1", source: "global" });
    });

    it("falls back to env for CURSOR_API_KEY when global has none", async () => {
      process.env.CURSOR_API_KEY = "cursor-env-key";
      await setGlobalSettings({});
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "CURSOR_API_KEY");
      expect(result).toEqual({ key: "cursor-env-key", keyId: ENV_FALLBACK_KEY_ID, source: "env" });
    });
  });
});
