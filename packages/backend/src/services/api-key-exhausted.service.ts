/**
 * Tracks which API key providers are exhausted per project (all keys rate-limited or missing).
 * Used to stop the orchestrator from dispatching new agents until keys are available again.
 * Cleared when getNextKey returns non-null on re-check.
 */

import type { ApiKeyProvider } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";

const log = createLogger("api-key-exhausted");

/** Per-project set of exhausted providers */
const exhaustedByProject = new Map<string, Set<ApiKeyProvider>>();

/**
 * Mark a provider as exhausted for a project.
 */
export function markExhausted(projectId: string, provider: ApiKeyProvider): void {
  let set = exhaustedByProject.get(projectId);
  if (!set) {
    set = new Set();
    exhaustedByProject.set(projectId, set);
  }
  set.add(provider);
  log.info("Marked provider exhausted", { projectId, provider });
}

/**
 * Clear exhausted state for a provider (keys available again).
 */
export function clearExhausted(projectId: string, provider: ApiKeyProvider): void {
  const set = exhaustedByProject.get(projectId);
  if (set) {
    set.delete(provider);
    if (set.size === 0) exhaustedByProject.delete(projectId);
    log.info("Cleared exhausted provider", { projectId, provider });
  }
}

/**
 * Check if a provider is exhausted for a project.
 */
export function isExhausted(projectId: string, provider: ApiKeyProvider): boolean {
  return exhaustedByProject.get(projectId)?.has(provider) ?? false;
}

/**
 * Clear exhausted state for a provider across all projects.
 * Used when a rate-limited key is cleared via global settings Retry so the orchestrator
 * can resume work promptly.
 * @returns Project IDs that had the provider cleared
 */
export function clearExhaustedForProviderAcrossAllProjects(
  provider: ApiKeyProvider
): string[] {
  const cleared: string[] = [];
  for (const [projectId, set] of exhaustedByProject.entries()) {
    if (set.has(provider)) {
      set.delete(provider);
      if (set.size === 0) exhaustedByProject.delete(projectId);
      cleared.push(projectId);
      log.info("Cleared exhausted provider (retry success)", { projectId, provider });
    }
  }
  return cleared;
}
