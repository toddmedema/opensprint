/**
 * Global settings store at ~/.opensprint/settings.json.
 * Settings are keyed by project_id. No per-project .opensprint/settings.json usage.
 * Schema: { [projectId]: ProjectSettings }
 * apiKeys are never read or written; they live in global-settings.json only.
 */
import fs from "fs/promises";
import path from "path";
import type { ProjectSettings } from "@opensprint/shared";
import { writeJsonAtomic } from "../utils/file-utils.js";

/** Strip apiKeys from settings (project-level keys deprecated; use global store only). */
function stripApiKeys<T extends Record<string, unknown>>(obj: T): Omit<T, "apiKeys"> {
  const { apiKeys: _omit, ...rest } = obj;
  return rest as Omit<T, "apiKeys">;
}

function getSettingsStorePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".opensprint", "settings.json");
}

export interface SettingsEntry {
  settings: ProjectSettings;
  updatedAt: string;
}

export type SettingsStore = Record<string, SettingsEntry>;

async function loadStore(): Promise<SettingsStore> {
  const file = getSettingsStorePath();
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const store = parsed as Record<string, unknown>;
      // Normalize: entries may be { settings, updatedAt } or legacy raw ProjectSettings
      const normalized: SettingsStore = {};
      for (const [id, val] of Object.entries(store)) {
        if (val && typeof val === "object") {
          const v = val as Record<string, unknown>;
          if ("settings" in v && typeof v.settings === "object") {
            normalized[id] = {
              settings: stripApiKeys(v.settings as Record<string, unknown>) as ProjectSettings,
              updatedAt: (v.updatedAt as string) ?? new Date().toISOString(),
            };
          } else {
            normalized[id] = {
              settings: stripApiKeys(val as Record<string, unknown>) as ProjectSettings,
              updatedAt: new Date().toISOString(),
            };
          }
        }
      }
      return normalized;
    }
  } catch {
    // File missing or corrupt
  }
  return {};
}

async function saveStore(store: SettingsStore): Promise<void> {
  const file = getSettingsStorePath();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(file, store);
}

/**
 * Get settings for a project. Returns defaults if not found.
 * Strips apiKeys from stored data (project-level keys deprecated).
 */
export async function getSettingsFromStore(
  projectId: string,
  defaults: ProjectSettings
): Promise<ProjectSettings> {
  const store = await loadStore();
  const entry = store[projectId];
  if (entry?.settings) {
    return stripApiKeys(entry.settings as Record<string, unknown>) as ProjectSettings;
  }
  return defaults;
}

/**
 * Get settings and updatedAt for a project. Returns { settings: defaults, updatedAt: null } if not found.
 * Strips apiKeys from stored data (project-level keys deprecated).
 */
export async function getSettingsWithMetaFromStore(
  projectId: string,
  defaults: ProjectSettings
): Promise<{ settings: ProjectSettings; updatedAt: string | null }> {
  const store = await loadStore();
  const entry = store[projectId];
  if (entry?.settings) {
    return {
      settings: stripApiKeys(entry.settings as Record<string, unknown>) as ProjectSettings,
      updatedAt: entry.updatedAt ?? null,
    };
  }
  return { settings: defaults, updatedAt: null };
}

/**
 * Set settings for a project. Strips apiKeys before persisting (project-level keys deprecated).
 */
export async function setSettingsInStore(
  projectId: string,
  settings: ProjectSettings
): Promise<void> {
  const store = await loadStore();
  const now = new Date().toISOString();
  const toStore = stripApiKeys(settings as Record<string, unknown>) as ProjectSettings;
  store[projectId] = { settings: toStore, updatedAt: now };
  await saveStore(store);
}

/** Per-project lock for atomic updates (avoids race conditions on concurrent limitHitAt updates) */
const updateLocks = new Map<string, Promise<void>>();

/**
 * Atomically update project settings. Serializes concurrent updates per projectId.
 * Uses defaults when project has no stored settings.
 */
export async function updateSettingsInStore(
  projectId: string,
  defaults: ProjectSettings,
  updater: (settings: ProjectSettings) => ProjectSettings
): Promise<void> {
  const prev = updateLocks.get(projectId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  updateLocks.set(projectId, prev.then(() => next));
  await prev;
  try {
    const store = await loadStore();
    const entry = store[projectId];
    const current = entry?.settings ?? defaults;
    const updated = updater(current);
    const now = new Date().toISOString();
    const toStore = stripApiKeys(updated as Record<string, unknown>) as ProjectSettings;
    store[projectId] = { settings: toStore, updatedAt: now };
    await saveStore(store);
  } finally {
    resolve!();
  }
}

/**
 * Remove settings for a project (e.g. on project delete).
 */
export async function deleteSettingsFromStore(projectId: string): Promise<void> {
  const store = await loadStore();
  if (projectId in store) {
    delete store[projectId];
    await saveStore(store);
  }
}
