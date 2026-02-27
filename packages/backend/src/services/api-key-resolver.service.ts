/**
 * ApiKeyResolver: resolves API keys for a project with rotation support.
 * Priority: 1) global store apiKeys, 2) project settings apiKeys, 3) process.env
 * - getNextKey(projectId, provider): first available key in priority order
 * - recordLimitHit(projectId, provider, keyId, source): set limitHitAt in correct store
 * - clearLimitHit(projectId, provider, keyId, source): clear limitHitAt in correct store
 */
import type { ApiKeyProvider, ApiKeyEntry, ProjectSettings, GlobalSettings } from "@opensprint/shared";
import { isLimitHitExpired, DEFAULT_HIL_CONFIG, DEFAULT_DEPLOYMENT_CONFIG, DEFAULT_REVIEW_MODE } from "@opensprint/shared";
import {
  getSettingsFromStore,
  updateSettingsInStore,
} from "./settings-store.service.js";
import {
  getGlobalSettings,
  atomicUpdateGlobalSettings,
} from "./global-settings.service.js";

/** Synthetic keyId when falling back to process.env (recordLimitHit/clearLimitHit no-op) */
export const ENV_FALLBACK_KEY_ID = "__env__";

/** Where the resolved key came from */
export type KeySource = "global" | "project" | "env";

/** Minimal defaults for getSettingsFromStore when project has no stored settings */
function getMinimalDefaults(): ProjectSettings {
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
  };
}

/** Result of getNextKey: key value, stable keyId, and source for recordLimitHit/clearLimitHit */
export interface ResolvedKey {
  key: string;
  keyId: string;
  source: KeySource;
}

/** Find the first available entry (no recent limitHitAt, non-empty value) */
function findAvailable(entries: ApiKeyEntry[] | undefined): ApiKeyEntry | undefined {
  if (!entries || entries.length === 0) return undefined;
  return entries.find(
    (e) => (!e.limitHitAt || isLimitHitExpired(e.limitHitAt)) && e.value.trim()
  );
}

/**
 * Get the next available API key for the given project and provider.
 * Priority: 1) global store, 2) project settings, 3) process.env.
 * Returns null when no key is available.
 */
export async function getNextKey(
  projectId: string,
  provider: ApiKeyProvider
): Promise<ResolvedKey | null> {
  // 1) Global store
  const globalSettings = await getGlobalSettings();
  const globalEntries = globalSettings.apiKeys?.[provider];
  if (globalEntries && globalEntries.length > 0) {
    const available = findAvailable(globalEntries);
    if (available) {
      return { key: available.value, keyId: available.id, source: "global" };
    }
    // All global keys have recent limitHitAt — don't fall through yet,
    // but still try project/env since global keys are exhausted
  }

  // 2) Project settings
  const settings = await getSettingsFromStore(projectId, getMinimalDefaults());
  const projectEntries = settings.apiKeys?.[provider];
  if (projectEntries && projectEntries.length > 0) {
    const available = findAvailable(projectEntries);
    if (available) {
      return { key: available.value, keyId: available.id, source: "project" };
    }
  }

  // If we had keys at either level but all exhausted, return null (no env fallback)
  const hasGlobalKeys = globalEntries && globalEntries.length > 0;
  const hasProjectKeys = projectEntries && projectEntries.length > 0;
  if (hasGlobalKeys || hasProjectKeys) {
    return null;
  }

  // 3) Fall back to process.env
  const envKey = process.env[provider];
  if (envKey && envKey.trim()) {
    return { key: envKey, keyId: ENV_FALLBACK_KEY_ID, source: "env" };
  }

  return null;
}

/**
 * Record that the given key hit a rate/limit. Sets limitHitAt to now.
 * Routes to the correct store based on source. No-op for env keys.
 */
export async function recordLimitHit(
  projectId: string,
  provider: ApiKeyProvider,
  keyId: string,
  source: KeySource = "project"
): Promise<void> {
  if (keyId === ENV_FALLBACK_KEY_ID || source === "env") return;

  if (source === "global") {
    await atomicUpdateGlobalSettings((gs: GlobalSettings) => {
      const entries = gs.apiKeys?.[provider];
      if (!entries) return gs;
      const updated = entries.map((e) =>
        e.id === keyId ? { ...e, limitHitAt: new Date().toISOString() } : e
      );
      return { ...gs, apiKeys: { ...gs.apiKeys, [provider]: updated } };
    });
    return;
  }

  await updateSettingsInStore(projectId, getMinimalDefaults(), (settings) => {
    const entries = settings.apiKeys?.[provider];
    if (!entries) return settings;
    const updated = entries.map((e) =>
      e.id === keyId ? { ...e, limitHitAt: new Date().toISOString() } : e
    );
    return { ...settings, apiKeys: { ...settings.apiKeys, [provider]: updated } };
  });
}

/**
 * Clear limitHitAt for the given key on successful API use.
 * Routes to the correct store based on source. No-op for env keys.
 */
export async function clearLimitHit(
  projectId: string,
  provider: ApiKeyProvider,
  keyId: string,
  source: KeySource = "project"
): Promise<void> {
  if (keyId === ENV_FALLBACK_KEY_ID || source === "env") return;

  if (source === "global") {
    await atomicUpdateGlobalSettings((gs: GlobalSettings) => {
      const entries = gs.apiKeys?.[provider];
      if (!entries) return gs;
      const updated = entries.map((e) => {
        if (e.id !== keyId) return e;
        const { limitHitAt, ...rest } = e;
        return rest as ApiKeyEntry;
      });
      return { ...gs, apiKeys: { ...gs.apiKeys, [provider]: updated } };
    });
    return;
  }

  await updateSettingsInStore(projectId, getMinimalDefaults(), (settings) => {
    const entries = settings.apiKeys?.[provider];
    if (!entries) return settings;
    const updated = entries.map((e) => {
      if (e.id !== keyId) return e;
      const { limitHitAt, ...rest } = e;
      return rest as ApiKeyEntry;
    });
    return { ...settings, apiKeys: { ...settings.apiKeys, [provider]: updated } };
  });
}
