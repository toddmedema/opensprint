/**
 * Baseline vs candidate replay in disposable worktrees.
 *
 * For each mined replay-grade Execute session (or a sampled subset),
 * creates two disposable worktrees — one for baseline behavior and one for
 * candidate behavior — runs an Execute-style agent in each, collects
 * per-session metrics, and disposes worktrees after completion.
 */

import { BranchManager } from "./branch-manager.js";
import type { BehaviorExperimentCandidateBundle } from "./self-improvement-experiment.service.js";
import type { SelfImprovementMetrics } from "./self-improvement-runner.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("experiment-replay");

/** Maximum sessions to replay per experiment run (keeps cost bounded). */
export const DEFAULT_MAX_REPLAY_SESSIONS = 5;

/** Per-session outcome from a single replay run. */
export interface ReplayOutcome {
  success: boolean;
  retryCount: number;
  reviewPassed: boolean;
  latencyMs: number;
  costUsd: number;
  error?: string;
  evaluationComplete?: boolean;
  inputHash?: string;
  rubricId?: string;
  holdout?: boolean;
  label?: string;
  artifact?: { agentResult: string; evaluatorResult: string; codeDiff: string };
}

/** Baseline + candidate outcomes for one replayed session. */
export interface ReplaySessionResult {
  sessionId: number;
  baseline: ReplayOutcome;
  candidate: ReplayOutcome;
}

/** Full experiment replay result with per-session and aggregate metrics. */
export interface ExperimentReplayResult {
  sessions: ReplaySessionResult[];
  baselineMetrics: SelfImprovementMetrics;
  candidateMetrics: SelfImprovementMetrics;
  sampleSize: number;
  /** Only measured runs with held-out positive/negative cases can support activation. */
  evaluationComplete?: boolean;
}

/**
 * Pluggable agent runner so production can invoke a real Execute agent
 * while tests inject a mock. `variant` indicates whether the run uses
 * baseline or candidate instructions.
 */
export interface ReplayAgentRunner {
  run(params: {
    sessionId: number;
    worktreePath: string;
    variant: "baseline" | "candidate";
    candidateBundle?: BehaviorExperimentCandidateBundle;
  }): Promise<ReplayOutcome>;
}

function worktreeKey(runId: string, sessionId: number, variant: "baseline" | "candidate"): string {
  return `replay-${variant}-${sessionId}-${runId}`;
}

function aggregateMetrics(outcomes: ReplayOutcome[]): SelfImprovementMetrics {
  if (outcomes.length === 0) {
    return { taskSuccessRate: 0, retryRate: 0, reviewPassRate: 0, avgLatencyMs: 0, avgCostUsd: 0 };
  }
  const n = outcomes.length;
  return {
    taskSuccessRate: outcomes.filter((o) => o.success).length / n,
    retryRate: outcomes.reduce((sum, o) => sum + o.retryCount, 0) / n,
    reviewPassRate: outcomes.filter((o) => o.reviewPassed).length / n,
    avgLatencyMs: outcomes.reduce((sum, o) => sum + o.latencyMs, 0) / n,
    avgCostUsd: outcomes.reduce((sum, o) => sum + o.costUsd, 0) / n,
  };
}

export interface ExperimentReplayOptions {
  projectId: string;
  repoPath: string;
  runId: string;
  baseBranch?: string;
  sessionIds: number[];
  candidateBundle: BehaviorExperimentCandidateBundle;
  agentRunner: ReplayAgentRunner;
  maxSessions?: number;
  /** Callback invoked when replay stage changes (for status broadcasting). */
  onStageChange?: (stage: "replaying" | "scoring") => void;
  resolveBaseCommit?: (sessionId: number) => Promise<string>;
}

export class ExperimentReplayService {
  private branchManager: BranchManager;

  constructor(branchManager?: BranchManager) {
    this.branchManager = branchManager ?? new BranchManager();
  }

  /**
   * Run baseline vs candidate replay for each session in disposable worktrees.
   * Worktrees are always disposed, even on failure.
   */
  async runReplay(options: ExperimentReplayOptions): Promise<ExperimentReplayResult> {
    const {
      projectId,
      repoPath,
      runId,
      baseBranch = "main",
      sessionIds,
      candidateBundle,
      agentRunner,
      maxSessions = DEFAULT_MAX_REPLAY_SESSIONS,
      onStageChange,
    } = options;

    const sampled = sessionIds.slice(0, maxSessions);

    if (sampled.length === 0) {
      log.info("No sessions to replay", { projectId, runId });
      const emptyMetrics = aggregateMetrics([]);
      return {
        sessions: [],
        baselineMetrics: emptyMetrics,
        candidateMetrics: emptyMetrics,
        sampleSize: 0,
      };
    }

    onStageChange?.("replaying");
    log.info("Starting experiment replay", {
      projectId,
      runId,
      totalAvailable: sessionIds.length,
      sampleSize: sampled.length,
    });

    const results: ReplaySessionResult[] = [];

    for (const sessionId of sampled) {
      let originalBase = baseBranch;
      try {
        originalBase = (await options.resolveBaseCommit?.(sessionId)) ?? baseBranch;
      } catch (err) {
        const unavailable: ReplayOutcome = {
          success: false,
          retryCount: 0,
          reviewPassed: false,
          latencyMs: 0,
          costUsd: 0,
          evaluationComplete: false,
          error: err instanceof Error ? err.message : String(err),
        };
        results.push({ sessionId, baseline: unavailable, candidate: { ...unavailable } });
        continue;
      }
      const result = await this.replaySession({
        sessionId,
        repoPath,
        runId,
        baseBranch: originalBase,
        candidateBundle,
        agentRunner,
      });
      results.push(result);
    }

    onStageChange?.("scoring");

    const baselineOutcomes = results.map((r) => r.baseline);
    const candidateOutcomes = results.map((r) => r.candidate);

    const replayResult: ExperimentReplayResult = {
      sessions: results,
      baselineMetrics: aggregateMetrics(baselineOutcomes),
      candidateMetrics: aggregateMetrics(candidateOutcomes),
      sampleSize: results.length,
      evaluationComplete:
        results.length > 0 &&
        results.every(
          (r) =>
            r.baseline.evaluationComplete === true &&
            r.candidate.evaluationComplete === true &&
            r.baseline.inputHash === r.candidate.inputHash &&
            r.baseline.rubricId === r.candidate.rubricId
        ) &&
        results.some((r) => r.baseline.holdout && r.baseline.label === "compliant") &&
        results.some(
          (r) =>
            r.baseline.holdout &&
            ["defect", "conflict", "retrieval_miss"].includes(r.baseline.label ?? "")
        ),
    };

    log.info("Experiment replay completed", {
      projectId,
      runId,
      sampleSize: replayResult.sampleSize,
      baselineSuccessRate: replayResult.baselineMetrics.taskSuccessRate,
      candidateSuccessRate: replayResult.candidateMetrics.taskSuccessRate,
    });

    return replayResult;
  }

  private async replaySession(params: {
    sessionId: number;
    repoPath: string;
    runId: string;
    baseBranch: string;
    candidateBundle: BehaviorExperimentCandidateBundle;
    agentRunner: ReplayAgentRunner;
  }): Promise<ReplaySessionResult> {
    const { sessionId, repoPath, runId, baseBranch, candidateBundle, agentRunner } = params;

    const baselineKey = worktreeKey(runId, sessionId, "baseline");
    const candidateKey = worktreeKey(runId, sessionId, "candidate");

    // Run baseline
    const baselineOutcome = await this.runInWorktree({
      repoPath,
      worktreeKey: baselineKey,
      branchName: `opensprint/${baselineKey}`,
      baseBranch,
      sessionId,
      variant: "baseline",
      agentRunner,
    });

    // Run candidate
    const candidateOutcome = await this.runInWorktree({
      repoPath,
      worktreeKey: candidateKey,
      branchName: `opensprint/${candidateKey}`,
      baseBranch,
      sessionId,
      variant: "candidate",
      candidateBundle,
      agentRunner,
    });

    return { sessionId, baseline: baselineOutcome, candidate: candidateOutcome };
  }

  /**
   * Create a disposable worktree, run the agent, and always clean up.
   */
  private async runInWorktree(params: {
    repoPath: string;
    worktreeKey: string;
    branchName: string;
    baseBranch: string;
    sessionId: number;
    variant: "baseline" | "candidate";
    candidateBundle?: BehaviorExperimentCandidateBundle;
    agentRunner: ReplayAgentRunner;
  }): Promise<ReplayOutcome> {
    const {
      repoPath,
      worktreeKey: wtKey,
      branchName,
      baseBranch,
      sessionId,
      variant,
      candidateBundle,
      agentRunner,
    } = params;
    let wtPath: string | undefined;

    try {
      wtPath = await this.branchManager.createTaskWorktree(repoPath, wtKey, baseBranch, {
        worktreeKey: wtKey,
        branchName,
      });

      log.info("Replay worktree created", { variant, sessionId, wtPath });

      return await agentRunner.run({
        sessionId,
        worktreePath: wtPath,
        variant,
        candidateBundle,
      });
    } catch (err) {
      log.warn("Replay run failed", {
        variant,
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        retryCount: 0,
        reviewPassed: false,
        latencyMs: 0,
        costUsd: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      try {
        await this.branchManager.prepareWorktreeForRemoval(wtKey);
        await this.branchManager.removeTaskWorktree(repoPath, wtKey, wtPath);
        log.info("Replay worktree disposed", { variant, sessionId, wtKey });
      } catch (cleanupErr) {
        log.warn("Failed to dispose replay worktree", {
          variant,
          sessionId,
          wtKey,
          err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }
  }
}
