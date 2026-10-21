/**
 * Global settings store at ~/.opensprint/settings.json.
 * Settings are keyed by project_id. No per-project .opensprint/settings.json usage.
 * Schema: { [projectId]: ProjectSettings }
 * apiKeys are never read or written; they live in global-settings.json only.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { isDeepStrictEqual } from "node:util";
import type { ProjectSettings } from "@opensprint/shared";
import { omitInheritedAgentTiersForStore, parseSettings } from "@opensprint/shared";
import { writeJsonAtomic } from "../utils/file-utils.js";
import { createLogger } from "../utils/logger.js";
import { AppError } from "../middleware/error-handler.js";
import { lockProject, appendProjectEvent, stableFingerprint } from "./project-event.service.js";
import { getRequestContext } from "./request-context.js";

const log = createLogger("settings-store");

let settingsStorePathForTesting: string | null = null;

/** Strip apiKeys from settings (project-level keys deprecated; use global store only). */
function stripApiKeys<T extends Record<string, unknown>>(obj: T): Omit<T, "apiKeys"> {
  const { apiKeys: _omit, revision: _revision, ...rest } = obj;
  return rest as Omit<T, "apiKeys">;
}

function getSettingsStorePath(): string {
  if (settingsStorePathForTesting) return settingsStorePathForTesting;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, ".opensprint", "settings.json");
}

export function setSettingsStorePathForTesting(testPath: string | null): void {
  settingsStorePathForTesting = testPath;
}

export interface SettingsEntry {
  settings: ProjectSettings;
  updatedAt: string;
  revision?: number;
}

export type SettingsStore = Record<string, SettingsEntry>;

interface RawSettingsEntry {
  settings: Record<string, unknown>;
  updatedAt: string;
  revision: number;
}

/** Mutation reads retain absent fields and never turn a corrupt store into an empty one. */
async function loadRawFileStore(): Promise<Record<string, RawSettingsEntry>> {
  let content: string;
  try {
    content = await fs.readFile(getSettingsStorePath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Settings store must contain a project settings object.");
  }
  const store: Record<string, RawSettingsEntry> = Object.create(null);
  for (const [projectId, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid settings entry for project ${projectId}.`);
    }
    const entry = value as Record<string, unknown>;
    const settings = "settings" in entry ? entry.settings : entry;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error(`Invalid settings entry for project ${projectId}.`);
    }
    store[projectId] = {
      settings: stripApiKeys(settings as Record<string, unknown>),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
      revision:
        Number.isSafeInteger(entry.revision) && Number(entry.revision) >= 0
          ? Number(entry.revision)
          : 0,
    };
  }
  return store;
}

async function settingsDb() {
  const { taskStore } = await import("./task-store.service.js");
  const source = getSettingsStorePath();
  if (
    await taskStore.runRead((tx) =>
      tx.queryOne("SELECT source FROM settings_store_migrations WHERE source = $1", [source])
    )
  )
    return taskStore;
  // Parse before taking a SQL lock; a malformed legacy store must never be erased.
  const legacy = await loadRawFileStore();
  await taskStore.runWrite(async (tx) => {
    const migrated = await tx.queryOne(
      "SELECT source FROM settings_store_migrations WHERE source = $1",
      [source]
    );
    if (migrated) return;
    // Concurrent replica imports are serialized by the migration marker insert.
    const inserted = await tx.execute(
      "INSERT INTO settings_store_migrations (source) VALUES ($1) ON CONFLICT DO NOTHING",
      [source]
    );
    if (!inserted) return;
    for (const [projectId, entry] of Object.entries(legacy))
      await tx.execute(
        "INSERT INTO project_settings (project_id, settings, revision, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [projectId, JSON.stringify(entry.settings), entry.revision, entry.updatedAt]
      );
  });
  return taskStore;
}

async function loadRawStore(): Promise<Record<string, RawSettingsEntry>> {
  if (settingsStorePathForTesting) return loadRawFileStore();
  const db = await settingsDb();
  return db.runRead(async (tx) => {
    const rows = await tx.query("SELECT * FROM project_settings");
    return Object.fromEntries(
      rows.map((row) => [
        String(row.project_id),
        {
          settings: JSON.parse(String(row.settings)) as Record<string, unknown>,
          revision: Number(row.revision),
          updatedAt: String(row.updated_at),
        },
      ])
    );
  });
}

async function loadStore(): Promise<SettingsStore> {
  try {
    const parsed: unknown = await loadRawStore();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const store = parsed as Record<string, unknown>;
      // Normalize: entries may be { settings, updatedAt } or legacy raw ProjectSettings
      const normalized: SettingsStore = {};
      for (const [id, val] of Object.entries(store)) {
        if (val && typeof val === "object") {
          const v = val as Record<string, unknown>;
          if ("settings" in v && typeof v.settings === "object") {
            let settings: ProjectSettings;
            try {
              settings = parseSettings(stripApiKeys(v.settings as Record<string, unknown>));
            } catch (err) {
              log.warn("parseSettings failed for project %s, using raw cast", {
                id,
                err: err instanceof Error ? err.message : String(err),
              });
              settings = stripApiKeys(
                v.settings as Record<string, unknown>
              ) as unknown as ProjectSettings;
            }
            normalized[id] = {
              settings,
              updatedAt: (v.updatedAt as string) ?? new Date().toISOString(),
              revision: Number(v.revision ?? 0),
            };
          } else {
            let settings: ProjectSettings;
            try {
              settings = parseSettings(stripApiKeys(val as Record<string, unknown>));
            } catch (err) {
              log.warn("parseSettings failed for legacy project %s, using raw cast", {
                id,
                err: err instanceof Error ? err.message : String(err),
              });
              settings = stripApiKeys(val as Record<string, unknown>) as unknown as ProjectSettings;
            }
            normalized[id] = {
              settings,
              updatedAt: new Date().toISOString(),
            };
          }
        }
      }
      return normalized;
    }
  } catch (error) {
    if (!settingsStorePathForTesting) throw error;
    // File missing or corrupt
  }
  return {};
}

async function saveStore(store: Record<string, RawSettingsEntry>): Promise<void> {
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
    return stripApiKeys(
      entry.settings as unknown as Record<string, unknown>
    ) as unknown as ProjectSettings;
  }
  return defaults;
}

/**
 * Read the on-disk settings entry for a project without `parseSettings` normalization.
 * Raw object as stored (no merge with global agents); agent-tier keys omitted in JSON stay absent
 * for {@link projectStoredDefinesSimpleAgent} / global merge. `loadStore()` parses through
 * `parseSettings`, which materializes default agents and would falsely mark tiers as project-defined
 * in {@link projectSettingsFromRaw}.
 */
async function readRawSettingsRecordFromDisk(projectId: string): Promise<Record<string, unknown>> {
  const store = await loadRawStore();
  return structuredClone(store[projectId]?.settings ?? {});
}

/** Empty object when missing. */
export async function getRawSettingsRecord(projectId: string): Promise<Record<string, unknown>> {
  return readRawSettingsRecordFromDisk(projectId);
}

/**
 * Get settings and updatedAt for a project. Returns { settings: defaults, updatedAt: null } if not found.
 * Strips apiKeys from stored data (project-level keys deprecated).
 */
export async function getSettingsWithMetaFromStore(
  projectId: string,
  defaults: ProjectSettings
): Promise<{ settings: ProjectSettings; updatedAt: string | null; revision: number }> {
  const store = await loadStore();
  const entry = store[projectId];
  if (entry?.settings) {
    return {
      settings: stripApiKeys(
        entry.settings as unknown as Record<string, unknown>
      ) as unknown as ProjectSettings,
      updatedAt: entry.updatedAt ?? null,
      revision: entry.revision ?? 0,
    };
  }
  return { settings: defaults, updatedAt: null, revision: 0 };
}

/**
 * File-level lock: serializes ALL read-modify-write operations on settings.json.
 * Without this, concurrent setSettingsInStore / updateSettingsInStore / deleteSettingsFromStore
 * calls (even for different projects) race on the shared file and can clobber each other.
 */
let storeLock: Promise<void> = Promise.resolve();

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = storeLock;
  storeLock = prev.then(() => next);
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release!();
    }
  });
}

/**
 * Set settings for a project. Strips apiKeys before persisting (project-level keys deprecated).
 */
export async function setSettingsInStore(
  projectId: string,
  settings: ProjectSettings
): Promise<void> {
  await transformRawSettingsInStore(
    projectId,
    () => settings as unknown as Record<string, unknown>
  );
}

export interface SettingsTransformResult {
  settings: Record<string, unknown>;
  updatedAt: string | null;
  revision: number;
  exists: boolean;
}

/** Raw values and revision come from one committed snapshot. */
export async function getRawSettingsWithMetaFromStore(
  projectId: string
): Promise<SettingsTransformResult> {
  const entry = (await loadRawStore())[projectId];
  return {
    settings: structuredClone(entry?.settings ?? {}),
    updatedAt: entry?.updatedAt ?? null,
    revision: entry?.revision ?? 0,
    exists: !!entry,
  };
}

/**
 * Apply a synchronous transformation to the latest raw project record while
 * holding the file lock. Never call another settings writer from the callback.
 * Return undefined to retain the existing record without creating or revising it.
 */
export async function transformRawSettingsInStore(
  projectId: string,
  transform: (
    current: Record<string, unknown>,
    metadata: { exists: boolean; revision: number }
  ) => Record<string, unknown> | undefined,
  requestPayload?: unknown
): Promise<SettingsTransformResult> {
  if (!settingsStorePathForTesting) {
    const db = await settingsDb();
    const result = await db.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      const row = await tx.queryOne("SELECT * FROM project_settings WHERE project_id = $1", [
        projectId,
      ]);
      const settings = row ? (JSON.parse(String(row.settings)) as Record<string, unknown>) : {};
      const revision = Number(row?.revision ?? 0);
      const request = getRequestContext();
      const fingerprint = stableFingerprint({
        projectId,
        revision: request?.expectedRevision,
        payload: requestPayload,
      });
      if (request?.requestId && requestPayload !== undefined) {
        const previous = await tx.queryOne(
          "SELECT * FROM collaboration_commands WHERE project_id = $1 AND command_id = $2",
          [projectId, request.requestId]
        );
        if (previous) {
          if (
            previous.actor_id !== request.principal.actorId ||
            previous.fingerprint !== fingerprint
          )
            throw new AppError(
              409,
              "REQUEST_ID_REUSED",
              "The settings request ID was already used for a different mutation."
            );
          return JSON.parse(String(previous.result)) as SettingsTransformResult;
        }
        if (!Number.isSafeInteger(request.expectedRevision))
          throw new AppError(
            400,
            "EXPECTED_REVISION_REQUIRED",
            "An expected settings revision is required."
          );
        if (request.expectedRevision !== revision)
          throw new AppError(
            409,
            "REVISION_CONFLICT",
            "Settings changed. Refresh before retrying.",
            { revision, state: settings }
          );
      }
      const updated = transform(structuredClone(settings), { exists: !!row, revision });
      if (updated === undefined)
        return {
          settings,
          revision,
          updatedAt: row ? String(row.updated_at) : null,
          exists: !!row,
        };
      if (!updated || typeof updated !== "object" || Array.isArray(updated) || "then" in updated)
        throw new Error("Settings transformations must synchronously return a settings object.");
      const next = stripApiKeys(updated);
      const nextRevision = revision + 1;
      const updatedAt = new Date().toISOString();
      await tx.execute(
        "INSERT INTO project_settings (project_id, settings, revision, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (project_id) DO UPDATE SET settings = excluded.settings, revision = excluded.revision, updated_at = excluded.updated_at",
        [projectId, JSON.stringify(next), nextRevision, updatedAt]
      );
      const result = { settings: next, revision: nextRevision, updatedAt, exists: true };
      await appendProjectEvent(tx, {
        projectId,
        type: "settings_changed",
        payload: { revision: nextRevision, state: next },
      });
      if (request?.requestId && requestPayload !== undefined)
        await tx.execute(
          "INSERT INTO collaboration_commands (project_id, command_id, actor_id, fingerprint, result) VALUES ($1,$2,$3,$4,$5)",
          [
            projectId,
            request.requestId,
            request.principal.actorId,
            fingerprint,
            JSON.stringify(result),
          ]
        );
      return result;
    });
    const { updateGlobalAgentConcurrencyLimit } =
      await import("./agent-global-concurrency.service.js");
    updateGlobalAgentConcurrencyLimit(
      projectId,
      typeof result.settings.maxTotalConcurrentAgents === "number"
        ? result.settings.maxTotalConcurrentAgents
        : undefined
    );
    return result;
  }
  return withStoreLock(async () => {
    const store = await loadRawStore();
    const entry = store[projectId];
    const current = structuredClone(entry?.settings ?? {});
    const revision = entry?.revision ?? 0;
    const updated = transform(current, { exists: entry !== undefined, revision });
    if (updated === undefined) {
      return {
        settings: entry?.settings ?? {},
        updatedAt: entry?.updatedAt ?? null,
        revision,
        exists: entry !== undefined,
      };
    }
    if (!updated || typeof updated !== "object" || Array.isArray(updated) || "then" in updated) {
      throw new Error("Settings transformations must synchronously return a settings object.");
    }
    const nextRevision = revision + 1;
    if (!Number.isSafeInteger(nextRevision)) throw new Error("Settings revision exhausted.");
    const toStore = stripApiKeys(updated);
    const updatedAt = new Date().toISOString();
    store[projectId] = { settings: toStore, updatedAt, revision: nextRevision };
    await saveStore(store);
    const { updateGlobalAgentConcurrencyLimit } =
      await import("./agent-global-concurrency.service.js");
    updateGlobalAgentConcurrencyLimit(
      projectId,
      typeof toStore.maxTotalConcurrentAgents === "number"
        ? toStore.maxTotalConcurrentAgents
        : undefined
    );
    return { settings: toStore, updatedAt, revision: nextRevision, exists: true };
  });
}

/**
 * Atomically update project settings via read-modify-write.
 * Serialized by the file-level lock so concurrent writes cannot clobber each other.
 * Uses defaults when project has no stored settings.
 */
export async function updateSettingsInStore(
  projectId: string,
  defaults: ProjectSettings,
  updater: (settings: ProjectSettings) => ProjectSettings
): Promise<void> {
  await transformRawSettingsInStore(projectId, (raw, { exists }) => {
    let current: ProjectSettings;
    try {
      current = exists ? parseSettings(raw) : structuredClone(defaults);
    } catch {
      current = raw as unknown as ProjectSettings;
    }
    const before = structuredClone(current) as unknown as Record<string, unknown>;
    const updated = updater(current) as unknown as Record<string, unknown>;
    // Apply only the updater's changes. parseSettings fills defaults (including
    // agents), and persisting those unchanged defaults would sever inheritance.
    const next = exists
      ? { ...raw }
      : omitInheritedAgentTiersForStore(defaults as unknown as Record<string, unknown>, raw);
    for (const key of new Set([...Object.keys(before), ...Object.keys(updated)])) {
      if (!isDeepStrictEqual(before[key], updated[key])) {
        if (updated[key] === undefined) delete next[key];
        else next[key] = updated[key];
      }
    }
    return next;
  });
}

/**
 * Remove settings for a project (e.g. on project delete).
 */
export async function deleteSettingsFromStore(projectId: string): Promise<void> {
  if (!settingsStorePathForTesting) {
    const db = await settingsDb();
    await db.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      await tx.execute("DELETE FROM project_settings WHERE project_id = $1", [projectId]);
      await appendProjectEvent(tx, { projectId, type: "settings_changed", payload: null });
    });
    return;
  }
  return withStoreLock(async () => {
    const store = await loadRawStore();
    if (projectId in store) {
      delete store[projectId];
      await saveStore(store);
      const { updateGlobalAgentConcurrencyLimit } =
        await import("./agent-global-concurrency.service.js");
      updateGlobalAgentConcurrencyLimit(projectId);
    }
  });
}
