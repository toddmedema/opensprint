import type { ApiKeyProvider } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";

const log = createLogger("provider-outage-backoff");
const PROVIDER_OUTAGE_BACKOFF_STEPS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000] as const;

type ProviderOutageBackoffState = {
  attempts: number;
  untilMs: number;
  reason: string;
};

const outageBackoffByProject = new Map<string, Map<ApiKeyProvider, ProviderOutageBackoffState>>();

function getProjectBackoffs(projectId: string): Map<ApiKeyProvider, ProviderOutageBackoffState> {
  let projectBackoffs = outageBackoffByProject.get(projectId);
  if (!projectBackoffs) {
    projectBackoffs = new Map<ApiKeyProvider, ProviderOutageBackoffState>();
    outageBackoffByProject.set(projectId, projectBackoffs);
  }
  return projectBackoffs;
}

function cleanupExpiredBackoff(projectId: string, provider: ApiKeyProvider, nowMs: number): void {
  const projectBackoffs = outageBackoffByProject.get(projectId);
  const state = projectBackoffs?.get(provider);
  if (!state || state.untilMs > nowMs) return;
  projectBackoffs?.delete(provider);
  if (projectBackoffs && projectBackoffs.size === 0) {
    outageBackoffByProject.delete(projectId);
  }
}

export function markProviderOutageBackoff(
  projectId: string,
  provider: ApiKeyProvider,
  reason: string,
  nowMs = Date.now()
): { attempts: number; durationMs: number; until: string } {
  cleanupExpiredBackoff(projectId, provider, nowMs);
  const projectBackoffs = getProjectBackoffs(projectId);
  const previous = projectBackoffs.get(provider);
  const attempts = Math.min(PROVIDER_OUTAGE_BACKOFF_STEPS_MS.length, (previous?.attempts ?? 0) + 1);
  const durationMs = PROVIDER_OUTAGE_BACKOFF_STEPS_MS[attempts - 1]!;
  const untilMs = nowMs + durationMs;
  projectBackoffs.set(provider, {
    attempts,
    untilMs,
    reason: reason.trim().slice(0, 500),
  });
  const until = new Date(untilMs).toISOString();
  log.warn("Marked provider outage backoff", {
    projectId,
    provider,
    attempts,
    until,
  });
  return { attempts, durationMs, until };
}

export function getProviderOutageBackoff(
  projectId: string,
  provider: ApiKeyProvider,
  nowMs = Date.now()
): { attempts: number; until: string; reason: string } | null {
  cleanupExpiredBackoff(projectId, provider, nowMs);
  const state = outageBackoffByProject.get(projectId)?.get(provider);
  if (!state) return null;
  return {
    attempts: state.attempts,
    until: new Date(state.untilMs).toISOString(),
    reason: state.reason,
  };
}

export function clearProviderOutageBackoff(projectId: string, provider: ApiKeyProvider): void {
  const projectBackoffs = outageBackoffByProject.get(projectId);
  if (!projectBackoffs?.has(provider)) return;
  projectBackoffs.delete(provider);
  if (projectBackoffs.size === 0) {
    outageBackoffByProject.delete(projectId);
  }
  log.info("Cleared provider outage backoff", { projectId, provider });
}
