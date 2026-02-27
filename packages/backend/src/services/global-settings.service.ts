/**
 * Global settings store at ~/.opensprint/global-settings.json.
 * Schema: { apiKeys?: ApiKeys, useCustomCli?: boolean }
 * Uses same ApiKeyEntry structure for apiKeys. Atomic writes via writeJsonAtomic.
 */
import fs from "fs/promises";
import path from "path";
import type { GlobalSettings, ApiKeys } from "@opensprint/shared";
import { sanitizeApiKeys } from "@opensprint/shared";
import { writeJsonAtomic } from "../utils/file-utils.js";

function getGlobalSettingsPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".opensprint", "global-settings.json");
}

/** Default empty settings */
const DEFAULT: GlobalSettings = {};

async function load(): Promise<GlobalSettings> {
  const file = getGlobalSettingsPath();
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const apiKeys = sanitizeApiKeys(obj.apiKeys);
      const useCustomCli =
        obj.useCustomCli === true ? true : obj.useCustomCli === false ? false : undefined;
      return {
        ...(apiKeys && { apiKeys }),
        ...(useCustomCli !== undefined && { useCustomCli }),
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
    const sanitized = sanitizeApiKeys(updates.apiKeys);
    merged.apiKeys = sanitized ?? undefined;
  }
  if (updates.useCustomCli !== undefined) {
    merged.useCustomCli = updates.useCustomCli;
  }

  await save(merged);
  return merged;
}

/** Serialization lock for atomic updates */
let atomicLock: Promise<void> = Promise.resolve();

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
    () => new Promise<void>((r) => { resolve = r; })
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
