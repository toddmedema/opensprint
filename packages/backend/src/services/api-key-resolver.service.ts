/**
 * ApiKeyResolver: resolves API keys with rotation support.
 * Priority: 1) global store apiKeys, 2) process.env
 * Project-level apiKeys removed; keys live in global-settings.json only.
 * - getNextKey(projectId, provider): first available key (projectId kept for API compatibility)
 * - recordLimitHit(projectId, provider, keyId, source): set limitHitAt in global store
 * - clearLimitHit(projectId, provider, keyId, source): clear limitHitAt in global store
 */
import type { ApiKeyProvider, ApiKeyEntry, GlobalSettings } from "@opensprint/shared";
import { isLimitHitExpired } from "@opensprint/shared";
import {
  getGlobalSettings,
  atomicUpdateGlobalSettings,
} from "./global-settings.service.js";

/** Synthetic keyId when falling back to process.env (recordLimitHit/clearLimitHit no-op) */
export const ENV_FALLBACK_KEY_ID = "__env__";

/** Where the resolved key came from */
export type KeySource = "global" | "env";

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
 * Get the next available API key for the given provider.
 * Priority: 1) global store, 2) process.env.
 * Returns null when no key is available.
 * projectId is kept for API compatibility but not used for key resolution.
 */
export async function getNextKey(
  _projectId: string,
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
    // All global keys have recent limitHitAt — return null (no env fallback when keys exhausted)
    return null;
  }

  // 2) Fall back to process.env
  const envKey = process.env[provider];
  if (envKey && envKey.trim()) {
    return { key: envKey, keyId: ENV_FALLBACK_KEY_ID, source: "env" };
  }

  return null;
}

/**
 * Record that the given key hit a rate/limit. Sets limitHitAt to now.
 * Writes to global store only. No-op for env keys.
 */
export async function recordLimitHit(
  _projectId: string,
  provider: ApiKeyProvider,
  keyId: string,
  source: KeySource = "global"
): Promise<void> {
  if (keyId === ENV_FALLBACK_KEY_ID || source === "env") return;

  await atomicUpdateGlobalSettings((gs: GlobalSettings) => {
    const entries = gs.apiKeys?.[provider];
    if (!entries) return gs;
    const updated = entries.map((e) =>
      e.id === keyId ? { ...e, limitHitAt: new Date().toISOString() } : e
    );
    return { ...gs, apiKeys: { ...gs.apiKeys, [provider]: updated } };
  });
}

/**
 * Clear limitHitAt for the given key on successful API use.
 * Writes to global store only. No-op for env keys.
 */
export async function clearLimitHit(
  _projectId: string,
  provider: ApiKeyProvider,
  keyId: string,
  source: KeySource = "global"
): Promise<void> {
  if (keyId === ENV_FALLBACK_KEY_ID || source === "env") return;

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
}
