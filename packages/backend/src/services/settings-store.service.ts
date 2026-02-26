/**
 * Global settings store at ~/.opensprint/settings.json.
 * Settings are keyed by project_id. No per-project .opensprint/settings.json usage.
 * Schema: { [projectId]: ProjectSettings }
 */
import fs from "fs/promises";
import path from "path";
import type { ProjectSettings } from "@opensprint/shared";
import { writeJsonAtomic } from "../utils/file-utils.js";

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
              settings: v.settings as ProjectSettings,
              updatedAt: (v.updatedAt as string) ?? new Date().toISOString(),
            };
          } else {
            normalized[id] = {
              settings: val as ProjectSettings,
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
 */
export async function getSettingsFromStore(
  projectId: string,
  defaults: ProjectSettings
): Promise<ProjectSettings> {
  const store = await loadStore();
  const entry = store[projectId];
  if (entry?.settings) {
    return entry.settings;
  }
  return defaults;
}

/**
 * Get settings and updatedAt for a project. Returns { settings: defaults, updatedAt: null } if not found.
 */
export async function getSettingsWithMetaFromStore(
  projectId: string,
  defaults: ProjectSettings
): Promise<{ settings: ProjectSettings; updatedAt: string | null }> {
  const store = await loadStore();
  const entry = store[projectId];
  if (entry?.settings) {
    return { settings: entry.settings, updatedAt: entry.updatedAt ?? null };
  }
  return { settings: defaults, updatedAt: null };
}

/**
 * Set settings for a project.
 */
export async function setSettingsInStore(
  projectId: string,
  settings: ProjectSettings
): Promise<void> {
  const store = await loadStore();
  const now = new Date().toISOString();
  store[projectId] = { settings, updatedAt: now };
  await saveStore(store);
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
