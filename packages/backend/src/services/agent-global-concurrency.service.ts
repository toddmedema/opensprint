/**
 * Per-project async semaphore for maxTotalConcurrentAgents (planning + coding + merger).
 */
import type { ProjectSettings } from "@opensprint/shared";
import {
  DEFAULT_AI_AUTONOMY_LEVEL,
  DEFAULT_DEPLOYMENT_CONFIG,
  DEFAULT_REVIEW_MODE,
  hilConfigFromAiAutonomyLevel,
  parseSettings,
} from "@opensprint/shared";
import { getSettingsFromStore } from "./settings-store.service.js";

const DEFAULT_AGENT = {
  type: "cursor" as const,
  model: null as string | null,
  cliCommand: null as string | null,
};

function storeReadDefaults(): ProjectSettings {
  return {
    simpleComplexityAgent: { ...DEFAULT_AGENT },
    complexComplexityAgent: { ...DEFAULT_AGENT },
    deployment: { ...DEFAULT_DEPLOYMENT_CONFIG },
    aiAutonomyLevel: DEFAULT_AI_AUTONOMY_LEVEL,
    hilConfig: hilConfigFromAiAutonomyLevel(DEFAULT_AI_AUTONOMY_LEVEL),
    testFramework: null,
    testCommand: null,
    validationTimeoutMsOverride: null,
    reviewMode: DEFAULT_REVIEW_MODE,
    maxConcurrentCoders: 1,
    unknownScopeStrategy: "optimistic",
    gitWorkingMode: "worktree",
    mergeStrategy: "per_task",
    worktreeBaseBranch: "main",
    enableHumanTeammates: false,
    selfImprovementFrequency: "never",
    autoExecutePlans: false,
    runAgentEnhancementExperiments: false,
  };
}

interface SlotWaiter {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ProjectSemaphoreState {
  limit: number;
  inFlight: number;
  waitQueue: SlotWaiter[];
  revision: number;
}

const semaphores = new Map<string, ProjectSemaphoreState>();

function holdSlot(state: ProjectSemaphoreState): () => void {
  state.inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.inFlight -= 1;
    drain(state);
  };
}

function getState(projectId: string, limit: number): ProjectSemaphoreState {
  let s = semaphores.get(projectId);
  if (!s) {
    s = { limit, inFlight: 0, waitQueue: [], revision: 0 };
    semaphores.set(projectId, s);
  }
  // Settings changes must preserve holders and FIFO waiters, including runs
  // admitted while the project had no limit.
  s.limit = limit;
  return s;
}

function drain(state: ProjectSemaphoreState): void {
  while (state.waitQueue.length > 0 && state.inFlight < state.limit) {
    const waiter = state.waitQueue.shift()!;
    waiter.signal?.removeEventListener("abort", waiter.onAbort!);
    if (waiter.signal?.aborted) {
      waiter.reject(waiter.signal.reason ?? new Error("Agent admission cancelled"));
      continue;
    }
    waiter.resolve(holdSlot(state));
  }
}

/** Account for a process that is already running after backend recovery. */
export function trackExistingGlobalAgentSlot(projectId: string): () => void {
  const state = semaphores.get(projectId) ?? getState(projectId, Infinity);
  return holdSlot(state);
}

/** Apply a setting change without resetting accounting or waiting for a new invocation. */
export function updateGlobalAgentConcurrencyLimit(projectId: string, limit?: number | null): void {
  const state = getState(projectId, limit != null && limit >= 1 ? limit : Infinity);
  state.revision += 1;
  drain(state);
}

async function readLimit(projectId: string): Promise<number | undefined> {
  const stored = await getSettingsFromStore(projectId, storeReadDefaults());
  const parsed = parseSettings(stored as unknown as Record<string, unknown>);
  return parsed.maxTotalConcurrentAgents ?? undefined;
}

/**
 * Wait until a global agent slot is available for this project, then return a release function.
 * Aborting removes a queued request immediately. Unlimited runs remain accounted
 * for so applying a finite limit cannot over-admit existing work.
 */
export async function acquireGlobalAgentSlot(
  projectId: string,
  signal?: AbortSignal
): Promise<() => void> {
  signal?.throwIfAborted();
  const revision = semaphores.get(projectId)?.revision ?? 0;
  const limit = await readLimit(projectId);
  signal?.throwIfAborted();
  const current = semaphores.get(projectId);
  const state =
    current && current.revision !== revision
      ? current
      : getState(projectId, limit != null && limit >= 1 ? limit : Infinity);

  return new Promise<() => void>((resolve, reject) => {
    const waiter: SlotWaiter = { resolve, reject, signal };
    waiter.onAbort = () => {
      const index = state.waitQueue.indexOf(waiter);
      if (index < 0) return;
      state.waitQueue.splice(index, 1);
      signal?.removeEventListener("abort", waiter.onAbort!);
      reject(signal?.reason ?? new Error("Agent admission cancelled"));
      drain(state);
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    state.waitQueue.push(waiter);
    drain(state);
  });
}

/** Test hook: reset semaphore state for a project. */
export function resetGlobalAgentConcurrencyForTests(projectId?: string): void {
  if (projectId) semaphores.delete(projectId);
  else semaphores.clear();
}
