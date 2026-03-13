/**
 * Global settings store at ~/.opensprint/global-settings.json.
 * Schema: { apiKeys?: ApiKeys, useCustomCli?: boolean, databaseUrl?: string }
 * Uses same ApiKeyEntry structure for apiKeys. Atomic writes via writeJsonAtomic.
 * databaseUrl is stored only in this JSON file; never in the database.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { GlobalSettings } from "@opensprint/shared";
import {
  sanitizeApiKeys,
  mergeApiKeysWithCurrent,
  getDefaultDatabaseUrl,
  validateDatabaseUrl,
} from "@opensprint/shared";
import { writeJsonAtomic } from "../utils/file-utils.js";

function getGlobalSettingsPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, ".opensprint", "global-settings.json");
}

/** Default empty settings */
const DEFAULT: GlobalSettings = {};

function parseDatabaseUrl(raw: unknown): string | undefined {
  if (raw == null || typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    return validateDatabaseUrl(raw);
  } catch {
    return undefined;
  }
}

async function load(): Promise<GlobalSettings> {
  const file = getGlobalSettingsPath();
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const apiKeys = sanitizeApiKeys(obj.apiKeys);
      const useCustomCli =
        obj.useCustomCli === true || obj.useCustomCli === false ? obj.useCustomCli : undefined;
      const databaseUrl = parseDatabaseUrl(obj.databaseUrl);
      const expoToken =
        obj.expoToken != null && typeof obj.expoToken === "string" && obj.expoToken.trim()
          ? obj.expoToken.trim()
          : undefined;
      const showNotificationDotInMenuBar =
        obj.showNotificationDotInMenuBar === false
          ? false
          : obj.showNotificationDotInMenuBar === true
            ? true
            : undefined;
      const showRunningAgentCountInMenuBar =
        obj.showRunningAgentCountInMenuBar === false
          ? false
          : obj.showRunningAgentCountInMenuBar === true
            ? true
            : undefined;
      return {
        ...(apiKeys && { apiKeys }),
        ...(useCustomCli !== undefined && { useCustomCli }),
        ...(databaseUrl && { databaseUrl }),
        ...(expoToken && { expoToken }),
        ...(showNotificationDotInMenuBar !== undefined && { showNotificationDotInMenuBar }),
        ...(showRunningAgentCountInMenuBar !== undefined && { showRunningAgentCountInMenuBar }),
      };
    }
  } catch {
    // File missing or corrupt
  }
  return { ...DEFAULT };
}

async function save(settings: GlobalSettings): Promise<void> {
  const file = getGlobalSettingsPath();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(file, settings);
}

/**
 * Get global settings. Returns empty object if file missing or corrupt.
 */
export async function getGlobalSettings(): Promise<GlobalSettings> {
  return load();
}

/**
 * Get the effective database URL. Precedence: DATABASE_URL env (12-factor), then
 * databaseUrl from global settings, then default SQLite path (~/.opensprint/data/opensprint.sqlite).
 * Never stored in the database; only in ~/.opensprint/global-settings.json or env.
 */
export async function getDatabaseUrl(): Promise<string> {
  return (await getEffectiveDatabaseConfig()).databaseUrl;
}

export type DatabaseUrlSource = "env" | "global-settings" | "default";

export async function getEffectiveDatabaseConfig(): Promise<{
  databaseUrl: string;
  source: DatabaseUrlSource;
}> {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv != null && fromEnv.trim() !== "") {
    try {
      return {
        databaseUrl: validateDatabaseUrl(fromEnv.trim()),
        source: "env",
      };
    } catch {
      // Invalid DATABASE_URL ignored; fall through to file/default
    }
  }
  const settings = await getGlobalSettings();
  if (settings.databaseUrl) {
    return {
      databaseUrl: settings.databaseUrl,
      source: "global-settings",
    };
  }
  return {
    databaseUrl: getDefaultDatabaseUrl(),
    source: "default",
  };
}

/**
 * Set global settings (replace entire file).
 */
export async function setGlobalSettings(settings: GlobalSettings): Promise<void> {
  const sanitized: GlobalSettings = {};
  if (settings.apiKeys) {
    const sanitizedKeys = sanitizeApiKeys(settings.apiKeys);
    if (sanitizedKeys) sanitized.apiKeys = sanitizedKeys;
  }
  if (settings.useCustomCli !== undefined) {
    sanitized.useCustomCli = settings.useCustomCli;
  }
  if (settings.databaseUrl !== undefined) {
    sanitized.databaseUrl = validateDatabaseUrl(settings.databaseUrl);
  }
  if (settings.expoToken !== undefined) {
    sanitized.expoToken = settings.expoToken.trim() || undefined;
  }
  if (settings.showNotificationDotInMenuBar !== undefined) {
    sanitized.showNotificationDotInMenuBar = settings.showNotificationDotInMenuBar;
  }
  if (settings.showRunningAgentCountInMenuBar !== undefined) {
    sanitized.showRunningAgentCountInMenuBar = settings.showRunningAgentCountInMenuBar;
  }
  await save(sanitized);
}

/**
 * Update global settings with partial merge. Merges into existing settings.
 */
export async function updateGlobalSettings(
  updates: Partial<GlobalSettings>
): Promise<GlobalSettings> {
  const current = await load();
  const merged: GlobalSettings = { ...current };

  if (updates.apiKeys !== undefined) {
    const mergedKeys = mergeApiKeysWithCurrent(updates.apiKeys, current.apiKeys);
    const sanitized = sanitizeApiKeys(mergedKeys);
    merged.apiKeys = sanitized ?? undefined;
  }
  if (updates.useCustomCli !== undefined) {
    merged.useCustomCli = updates.useCustomCli;
  }
  if (updates.databaseUrl !== undefined) {
    merged.databaseUrl = validateDatabaseUrl(updates.databaseUrl);
  }
  if (updates.expoToken !== undefined) {
    merged.expoToken = updates.expoToken.trim() || undefined;
  }
  if (updates.showNotificationDotInMenuBar !== undefined) {
    merged.showNotificationDotInMenuBar = updates.showNotificationDotInMenuBar;
  }
  if (updates.showRunningAgentCountInMenuBar !== undefined) {
    merged.showRunningAgentCountInMenuBar = updates.showRunningAgentCountInMenuBar;
  }

  await save(merged);
  return merged;
}

/** Serialization lock for atomic updates */
let atomicLock: Promise<void> = Promise.resolve();

/**
 * Ensures ~/.opensprint exists and global-settings.json has default databaseUrl if missing.
 * Used by setup.sh. Idempotent; safe to run multiple times.
 */
export async function ensureDefaultDatabaseUrl(): Promise<void> {
  const current = await load();
  if (!current.databaseUrl) {
    await updateGlobalSettings({ databaseUrl: getDefaultDatabaseUrl() });
  }
}

/**
 * Atomically update global settings via read-modify-write with serialization.
 * Prevents concurrent updates from clobbering each other (same pattern as updateSettingsInStore).
 */
export async function atomicUpdateGlobalSettings(
  updater: (settings: GlobalSettings) => GlobalSettings
): Promise<void> {
  const prev = atomicLock;
  let resolve: () => void;
  atomicLock = prev.then(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      })
  );
  await prev;
  try {
    const current = await load();
    const updated = updater(current);
    await save(updated);
  } finally {
    resolve!();
  }
}
