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
    // Clear env vars that might affect tests
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CURSOR_API_KEY;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CURSOR_API_KEY;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("getNextKey", () => {
    it("returns first key without limitHitAt when project has apiKeys", async () => {
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-first" },
            { id: "k2", value: "sk-ant-second" },
          ],
        },
      });
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-first", keyId: "k1" });
    });

    it("returns first available key when second has limitHitAt within 24h", async () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-first", limitHitAt: recent },
            { id: "k2", value: "sk-ant-second" },
          ],
        },
      });
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-second", keyId: "k2" });
    });

    it("returns key with limitHitAt > 24h ago (available again)", async () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-xxx", limitHitAt: old }],
        },
      });
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-xxx", keyId: "k1" });
    });

    it("returns null when all keys have limitHitAt within 24h", async () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-a", limitHitAt: recent },
            { id: "k2", value: "sk-ant-b", limitHitAt: recent },
          ],
        },
      });
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toBeNull();
    });

    it("falls back to process.env when project has no apiKeys", async () => {
      process.env.ANTHROPIC_API_KEY = "env-key-value";
      const settings = makeSettings(); // no apiKeys
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "env-key-value", keyId: ENV_FALLBACK_KEY_ID });
    });

    it("falls back to process.env when project has empty apiKeys for provider", async () => {
      process.env.CURSOR_API_KEY = "cursor-env-key";
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant" }],
          // CURSOR_API_KEY not in apiKeys
        },
      });
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "CURSOR_API_KEY");
      expect(result).toEqual({ key: "cursor-env-key", keyId: ENV_FALLBACK_KEY_ID });
    });

    it("returns null when no project keys and env is empty", async () => {
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toBeNull();
    });

    it("returns null when project keys exist but all empty string", async () => {
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "" }],
        },
      });
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toBeNull();
    });

    it("skips keys with empty value and uses next available", async () => {
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "" },
            { id: "k2", value: "sk-ant-valid" },
          ],
        },
      });
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-valid", keyId: "k2" });
    });

    it("uses keys in array order: first available key is first in list", async () => {
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-first" },
            { id: "k2", value: "sk-ant-second" },
            { id: "k3", value: "sk-ant-third" },
          ],
        },
      });
      await setSettingsInStore(projectId, settings);

      const r1 = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(r1).toEqual({ key: "sk-ant-first", keyId: "k1" });

      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", "k1");
      const r2 = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(r2).toEqual({ key: "sk-ant-second", keyId: "k2" });

      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", "k2");
      const r3 = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(r3).toEqual({ key: "sk-ant-third", keyId: "k3" });
    });

    it("falls back to env when apiKeys has empty array for provider", async () => {
      process.env.ANTHROPIC_API_KEY = "env-fallback-key";
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [],
        },
      });
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "env-fallback-key", keyId: ENV_FALLBACK_KEY_ID });
    });
  });

  describe("recordLimitHit", () => {
    it("sets limitHitAt for the key", async () => {
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-a" },
            { id: "k2", value: "sk-ant-b" },
          ],
        },
      });
      await setSettingsInStore(projectId, settings);

      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", "k1");

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-b", keyId: "k2" });
    });

    it("is no-op when keyId is ENV_FALLBACK_KEY_ID", async () => {
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);
      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", ENV_FALLBACK_KEY_ID);
      // Should not throw; settings unchanged
    });

    it("is no-op when keyId not found in entries", async () => {
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant" }],
        },
      });
      await setSettingsInStore(projectId, settings);

      await recordLimitHit(projectId, "ANTHROPIC_API_KEY", "nonexistent");

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant", keyId: "k1" });
    });
  });

  describe("clearLimitHit", () => {
    it("clears limitHitAt for the key", async () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-a", limitHitAt: recent },
            { id: "k2", value: "sk-ant-b" },
          ],
        },
      });
      await setSettingsInStore(projectId, settings);

      await clearLimitHit(projectId, "ANTHROPIC_API_KEY", "k1");

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-a", keyId: "k1" });
    });

    it("is no-op when keyId is ENV_FALLBACK_KEY_ID", async () => {
      await clearLimitHit(projectId, "ANTHROPIC_API_KEY", ENV_FALLBACK_KEY_ID);
      // Should not throw
    });

    it("is no-op when provider has no apiKeys", async () => {
      const settings = makeSettings();
      await setSettingsInStore(projectId, settings);
      await clearLimitHit(projectId, "ANTHROPIC_API_KEY", "k1");
      // Should not throw
    });
  });

  describe("thread-safe updates", () => {
    it("concurrent recordLimitHit updates are serialized correctly", async () => {
      const settings = makeSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-1" },
            { id: "k2", value: "sk-ant-2" },
            { id: "k3", value: "sk-ant-3" },
          ],
        },
      });
      await setSettingsInStore(projectId, settings);

      await Promise.all([
        recordLimitHit(projectId, "ANTHROPIC_API_KEY", "k1"),
        recordLimitHit(projectId, "ANTHROPIC_API_KEY", "k2"),
      ]);

      const result = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      expect(result).toEqual({ key: "sk-ant-3", keyId: "k3" });
    });
  });

  describe("CURSOR_API_KEY provider", () => {
    it("works for CURSOR_API_KEY provider", async () => {
      const settings = makeSettings({
        apiKeys: {
          CURSOR_API_KEY: [{ id: "c1", value: "cursor-key-123" }],
        },
      });
      await setSettingsInStore(projectId, settings);

      const result = await getNextKey(projectId, "CURSOR_API_KEY");
      expect(result).toEqual({ key: "cursor-key-123", keyId: "c1" });
    });
  });
});
