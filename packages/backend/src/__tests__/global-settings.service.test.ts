/**
 * Unit tests for GlobalSettingsService: read/write round-trip, atomic write, schema validation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  getGlobalSettings,
  setGlobalSettings,
  updateGlobalSettings,
  getDatabaseUrl,
  ensureDefaultDatabaseUrl,
} from "../services/global-settings.service.js";
import { DEFAULT_DATABASE_URL } from "@opensprint/shared";

describe("global-settings.service", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-global-settings-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function getFilePath(): string {
    return path.join(tempDir, ".opensprint", "global-settings.json");
  }

  describe("getGlobalSettings", () => {
    it("returns empty object when file does not exist", async () => {
      const settings = await getGlobalSettings();
      expect(settings).toEqual({});
    });

    it("returns empty object when file is corrupt", async () => {
      const dir = path.join(tempDir, ".opensprint");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(getFilePath(), "invalid json{", "utf-8");

      const settings = await getGlobalSettings();
      expect(settings).toEqual({});
    });

    it("returns empty object when file is not an object", async () => {
      const dir = path.join(tempDir, ".opensprint");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(getFilePath(), '["array"]', "utf-8");

      const settings = await getGlobalSettings();
      expect(settings).toEqual({});
    });

    it("returns settings from existing file", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-xxx" }],
        },
        useCustomCli: true,
      });

      const settings = await getGlobalSettings();
      expect(settings.apiKeys?.ANTHROPIC_API_KEY).toHaveLength(1);
      expect(settings.apiKeys?.ANTHROPIC_API_KEY?.[0]).toEqual({
        id: "k1",
        value: "sk-ant-xxx",
      });
      expect(settings.useCustomCli).toBe(true);
    });

    it("returns databaseUrl when set", async () => {
      const customUrl = "postgresql://user:pass@remote.example.com:5432/mydb";
      await setGlobalSettings({ databaseUrl: customUrl });

      const settings = await getGlobalSettings();
      expect(settings.databaseUrl).toBe(customUrl);
    });

    it("omits invalid databaseUrl from file (falls back to default via getDatabaseUrl)", async () => {
      const dir = path.join(tempDir, ".opensprint");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        getFilePath(),
        JSON.stringify({ databaseUrl: "mysql://invalid" }),
        "utf-8"
      );

      const settings = await getGlobalSettings();
      expect(settings.databaseUrl).toBeUndefined();

      const url = await getDatabaseUrl();
      expect(url).toBe(DEFAULT_DATABASE_URL);
    });
  });

  describe("ensureDefaultDatabaseUrl", () => {
    it("creates ~/.opensprint and writes default databaseUrl when file missing", async () => {
      await ensureDefaultDatabaseUrl();

      const raw = await fs.readFile(getFilePath(), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.databaseUrl).toBe(DEFAULT_DATABASE_URL);
    });

    it("adds databaseUrl when file exists but databaseUrl is missing", async () => {
      await setGlobalSettings({ useCustomCli: true });

      await ensureDefaultDatabaseUrl();

      const settings = await getGlobalSettings();
      expect(settings.databaseUrl).toBe(DEFAULT_DATABASE_URL);
      expect(settings.useCustomCli).toBe(true);
    });

    it("does not overwrite existing databaseUrl", async () => {
      const customUrl = "postgresql://user:pass@remote:5432/db";
      await setGlobalSettings({ databaseUrl: customUrl });

      await ensureDefaultDatabaseUrl();

      const settings = await getGlobalSettings();
      expect(settings.databaseUrl).toBe(customUrl);
    });

    it("is idempotent (safe to run multiple times)", async () => {
      await ensureDefaultDatabaseUrl();
      await ensureDefaultDatabaseUrl();

      const settings = await getGlobalSettings();
      expect(settings.databaseUrl).toBe(DEFAULT_DATABASE_URL);
    });
  });

  describe("getDatabaseUrl", () => {
    it("returns DEFAULT_DATABASE_URL when databaseUrl is not set", async () => {
      const url = await getDatabaseUrl();
      expect(url).toBe(DEFAULT_DATABASE_URL);
    });

    it("returns configured databaseUrl when set", async () => {
      const customUrl = "postgresql://custom:secret@host:5432/db";
      await setGlobalSettings({ databaseUrl: customUrl });

      const url = await getDatabaseUrl();
      expect(url).toBe(customUrl);
    });
  });

  describe("setGlobalSettings", () => {
    it("creates ~/.opensprint directory if missing", async () => {
      await setGlobalSettings({ useCustomCli: true });

      const stat = await fs.stat(path.join(tempDir, ".opensprint"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("writes settings to global-settings.json", async () => {
      const apiKeys = {
        ANTHROPIC_API_KEY: [{ id: "a1", value: "sk-ant-secret" }],
        CURSOR_API_KEY: [
          { id: "c1", value: "cursor-key-1" },
          { id: "c2", value: "cursor-key-2", limitHitAt: "2025-02-25T12:00:00Z" },
        ],
      };
      await setGlobalSettings({ apiKeys, useCustomCli: false });

      const raw = await fs.readFile(getFilePath(), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.apiKeys).toEqual(apiKeys);
      expect(parsed.useCustomCli).toBe(false);
    });

    it("replaces entire file (overwrites existing)", async () => {
      await setGlobalSettings({
        apiKeys: { ANTHROPIC_API_KEY: [{ id: "k1", value: "v1" }] },
        useCustomCli: true,
      });
      await setGlobalSettings({
        apiKeys: { CURSOR_API_KEY: [{ id: "k2", value: "v2" }] },
      });

      const settings = await getGlobalSettings();
      expect(settings.apiKeys?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(settings.apiKeys?.CURSOR_API_KEY).toHaveLength(1);
      expect(settings.apiKeys?.CURSOR_API_KEY?.[0]).toEqual({ id: "k2", value: "v2" });
      expect(settings.useCustomCli).toBeUndefined();
    });

    it("sanitizes invalid apiKeys entries", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "valid", value: "sk-ant-ok" },
            { id: "", value: "invalid" } as unknown as { id: string; value: string },
            null as unknown as { id: string; value: string },
          ],
        },
      });

      const settings = await getGlobalSettings();
      expect(settings.apiKeys?.ANTHROPIC_API_KEY).toHaveLength(1);
      expect(settings.apiKeys?.ANTHROPIC_API_KEY?.[0]).toEqual({ id: "valid", value: "sk-ant-ok" });
    });

    it("writes databaseUrl to global-settings.json", async () => {
      const customUrl = "postgresql://user:pass@localhost:5432/customdb";
      await setGlobalSettings({ databaseUrl: customUrl });

      const raw = await fs.readFile(getFilePath(), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.databaseUrl).toBe(customUrl);
    });

    it("throws when databaseUrl has invalid format", async () => {
      await expect(setGlobalSettings({ databaseUrl: "mysql://localhost/db" })).rejects.toThrow(
        "databaseUrl must start with postgres:// or postgresql://"
      );
    });
  });

  describe("updateGlobalSettings", () => {
    it("merges partial updates into existing settings", async () => {
      await setGlobalSettings({
        apiKeys: { ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-1" }] },
        useCustomCli: false,
      });

      const updated = await updateGlobalSettings({ useCustomCli: true });

      expect(updated.useCustomCli).toBe(true);
      expect(updated.apiKeys?.ANTHROPIC_API_KEY).toHaveLength(1);
      expect(updated.apiKeys?.ANTHROPIC_API_KEY?.[0]).toEqual({ id: "k1", value: "sk-ant-1" });

      const settings = await getGlobalSettings();
      expect(settings).toEqual(updated);
    });

    it("adds apiKeys when none exist", async () => {
      await setGlobalSettings({ useCustomCli: true });

      const updated = await updateGlobalSettings({
        apiKeys: { CURSOR_API_KEY: [{ id: "c1", value: "cursor-key" }] },
      });

      expect(updated.apiKeys?.CURSOR_API_KEY).toHaveLength(1);
      expect(updated.apiKeys?.CURSOR_API_KEY?.[0]).toEqual({ id: "c1", value: "cursor-key" });
      expect(updated.useCustomCli).toBe(true);
    });

    it("replaces apiKeys when provided", async () => {
      await setGlobalSettings({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "a1", value: "old" }],
        },
      });

      const updated = await updateGlobalSettings({
        apiKeys: {
          CURSOR_API_KEY: [{ id: "c1", value: "new" }],
        },
      });

      expect(updated.apiKeys?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(updated.apiKeys?.CURSOR_API_KEY).toHaveLength(1);
      expect(updated.apiKeys?.CURSOR_API_KEY?.[0]).toEqual({ id: "c1", value: "new" });
    });

    it("creates file when updating from empty", async () => {
      const updated = await updateGlobalSettings({ useCustomCli: true });

      expect(updated.useCustomCli).toBe(true);
      const raw = await fs.readFile(getFilePath(), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.useCustomCli).toBe(true);
    });

    it("updates databaseUrl", async () => {
      await setGlobalSettings({ useCustomCli: true });

      const customUrl = "postgresql://remote:secret@db.example.com:5432/opensprint";
      const updated = await updateGlobalSettings({ databaseUrl: customUrl });

      expect(updated.databaseUrl).toBe(customUrl);
      expect(updated.useCustomCli).toBe(true);

      const settings = await getGlobalSettings();
      expect(settings.databaseUrl).toBe(customUrl);
    });

    it("throws when databaseUrl has invalid format", async () => {
      await setGlobalSettings({ useCustomCli: true });

      await expect(updateGlobalSettings({ databaseUrl: "invalid-url" })).rejects.toThrow(
        "databaseUrl must start with postgres:// or postgresql://"
      );
    });
  });

  describe("atomic write", () => {
    it("writes to .tmp then renames (atomic)", async () => {
      await setGlobalSettings({ useCustomCli: true });

      const filePath = getFilePath();
      const tmpPath = filePath + ".tmp";
      const tmpExists = await fs
        .access(tmpPath)
        .then(() => true)
        .catch(() => false);
      expect(tmpExists).toBe(false);

      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.useCustomCli).toBe(true);
    });
  });

  describe("round-trip", () => {
    it("full round-trip: set → get → update → get", async () => {
      const initial = {
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "a1", value: "sk-ant-1" },
            { id: "a2", value: "sk-ant-2", limitHitAt: "2025-02-25T12:00:00Z" },
          ],
          CURSOR_API_KEY: [{ id: "c1", value: "cursor-1" }],
        },
        useCustomCli: false,
      };

      await setGlobalSettings(initial);
      const afterSet = await getGlobalSettings();
      expect(afterSet.apiKeys).toEqual(initial.apiKeys);
      expect(afterSet.useCustomCli).toBe(initial.useCustomCli);

      const updated = await updateGlobalSettings({ useCustomCli: true });
      expect(updated.useCustomCli).toBe(true);
      expect(updated.apiKeys).toEqual(initial.apiKeys);

      const afterUpdate = await getGlobalSettings();
      expect(afterUpdate).toEqual(updated);
    });
  });
});
