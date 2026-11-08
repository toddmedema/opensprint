import { getEffectiveMergeStrategy } from "@opensprint/shared";
import fs from "fs/promises";
import path from "path";

/**
 * MergeCoordinator — merge-to-main, push, conflict resolution, and post-completion.
 * Extracted from OrchestratorService. Owns all git merge/push logic and the push mutex.
 *
 * Key design principles:
 * - Merge FIRST, close task AFTER (never close before merge)
 * - Merge/rebase conflicts are handled by bounded merger rounds; unresolved conflicts are requeued
 * - Task close is a separate commit after the merge commit
 * - Push rebase conflicts: run bounded merger rounds until rebase completes or fail safely
 */

import {
  BACKOFF_FAILURE_THRESHOLD,
  type BaselineRuntimeStatus,
  type MergeValidationRuntimeStatus,
  QUALITY_GATE_FAILURE_MESSAGE,
  resolveTestCommand,
  type AgentConfig,
  type TestResults,
  type ToolchainProfile,
} from "@opensprint/shared";
import type { ServerEvent } from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import { resolveEpicId } from "./task-store.service.js";
import { RebaseConflictError, RebaseContinueBlockedError } from "./branch-manager.js";
import { gitCommitQueue, MergeJobError } from "./git-commit-queue.service.js";
import { agentIdentityService, buildAgentAttemptId } from "./agent-identity.service.js";
import { eventLogService } from "./event-log.service.js";
import { fireAndForget } from "../utils/fire-and-forget.js";
import { deferredAutoDeployService, type ClaimedDeploy } from "./deferred-auto-deploy.service.js";
import { finalReviewService } from "./final-review.service.js";
import { publishPlanPullRequest } from "./plan-pull-request.service.js";
import {
  PR_GOVERNANCE_INCOMPATIBLE,
  withUngovernedPullRequestDelivery,
} from "./plan-pull-request-governance.js";
import { GOVERNANCE_INVALID_INPUT, governanceError } from "./policy-context.js";
import { reviewPublishedPlanPullRequest } from "./plan-pull-request-review.service.js";
import { notificationService } from "./notification.service.js";
import { selfImprovementService } from "./self-improvement.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { broadcastAuthoritativeTaskUpdated } from "../task-store-events.js";
import type { TimerRegistry } from "./timer-registry.js";
import { createLogger } from "../utils/logger.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { appendCrashLog } from "../utils/crash-log.js";
import { appendRuntimeTrace } from "../utils/runtime-trace.js";
import { buildTaskLastExecutionSummary, compactExecutionText } from "./task-execution-summary.js";
import { inspectGitRepoState, resolveBaseBranch } from "../utils/git-repo-state.js";
import {
  assertWorktreeIntegrity,
  evaluateWorktreeCleanupProtection,
  getWorktreeCleanupAssignmentGuardMs,
  logWorktreeCleanupBlocked,
} from "../utils/worktree-health.js";
import { buildFailureFingerprint } from "../utils/failure-fingerprint.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";
import type { MergeQualityGateProfile } from "./merge-quality-gates.js";
import type { RetryContext, RetryQualityGateDetail } from "./orchestrator-phase-context.js";
import { validationWorkspaceService } from "./validation-workspace.service.js";
import { worktreeCleanupIntentService } from "./worktree-cleanup-intent.service.js";
import { worktreeLeaseService } from "./worktree-lease.service.js";
import { isTaskWorktreeMergeGateArtifactCurrent } from "./merge-verification.service.js";
import {
  buildBaselineFailureFingerprint,
  buildBaselineQualityGateNotificationDetail,
  buildEnvironmentSetupRemediationMessage,
  buildMergeQualityGateJobError,
  buildQualityGateStructuredDetails,
  buildQualityGateSummaryDetailFromMergeError,
  getQualityGateFailureDetailsFromMergeError,
  getQualityGateFirstErrorLine,
  isEnvironmentSetupQualityGateMergeError,
  QUALITY_GATE_OUTPUT_SNIPPET_LIMIT,
  toQualityGateOutputSnippet,
} from "./merge-quality-gate-failure-utils.js";

import { governanceService } from "./governance.service.js";
import { isPublicationLeaseContention } from "./governance-store.js";
import { triggerDeployForEvent } from "./deploy-trigger.service.js";
import {
  governanceExecutionService,
  governanceBranchPathSnapshot,
  governanceCodeSnapshot,
} from "./governance-execution.service.js";

import {
  remotePublicationGovernanceService,
  type RemotePushBatch,
} from "./remote-publication-governance.service.js";

const log = createLogger("merge-coordinator");
const _MAX_PUSH_REBASE_RESOLUTION_ROUNDS = 12;
const NEXT_RETRY_CONTEXT_KEY = "next_retry_context";
const MERGE_RETRY_MODE_KEY = "merge_retry_mode";
const BASELINE_MERGE_RETRY_MODE = "baseline_wait";
const MERGE_RETRY_CONTEXT_FAILURE_LIMIT = 1200;
const BASELINE_QUALITY_GATE_SUCCESS_CACHE_MS = 60_000;
const BASELINE_QUALITY_GATE_PAUSE_MS = 5 * 60_000;
const BASELINE_QUALITY_GATE_PAUSE_MAX_MS = 60 * 60_000;
const BASELINE_QUALITY_GATE_PAUSE_BACKOFF_WINDOW_MS = 30 * 60_000;
const BASELINE_REMEDIATION_SUPPRESSION_MS = 10 * 60_000;
const BASELINE_INCIDENT_HEALTHY_THRESHOLD = 2;
const BASELINE_QUALITY_GATE_PAUSED_UNTIL_KEY = "merge_quality_gate_paused_until";
const MERGE_VALIDATION_PAUSED_UNTIL_KEY = "merge_validation_paused_until";
const BASELINE_QUALITY_GATE_NOTIFICATION_SOURCE_ID = "merge-quality-gate-baseline";
const BASELINE_QUALITY_GATE_TASK_SOURCE = "merge-quality-gate-baseline";
const MERGE_VALIDATION_HEALTH_NOTIFICATION_SOURCE_ID = "merge-validation-health";
const MERGE_VALIDATION_DEGRADED_THRESHOLD = 3;
const MERGE_VALIDATION_FAILURE_WINDOW_MS = 10 * 60_000;
const MERGE_VALIDATION_CANARY_INTERVAL_MS = 5 * 60_000;
const MAX_BASELINE_REMEDIATION_ATTEMPTS = 3;
const MAX_ENVIRONMENT_SETUP_QUALITY_GATE_ATTEMPTS = 3;
const MERGE_ATTEMPT_LEASE_EXPIRES_AT_KEY = "merge_attempt_lease_expires_at";
const MERGE_ATTEMPT_LEASE_ACQUIRED_AT_KEY = "merge_attempt_lease_acquired_at";
const MERGE_ATTEMPT_LEASE_OWNER_KEY = "merge_attempt_lease_owner";
const DETERMINISTIC_MERGE_GATE_PROFILE: MergeQualityGateProfile = "deterministic";

type BaselineCheckSource = "merge_precheck" | "push_precheck" | "push_rebase_recheck";
type BaselineRemediationTaskAction =
  | "created"
  | "updated"
  | "reopened"
  | "suppressed_redundant"
  | "skipped_low_confidence";

/** One-sentence explanation for merge failures shown to users (conflicts with main in same files). */
const HUMAN_MERGE_FAILURE_MESSAGE =
  "The merge could not complete because your branch and main both changed the same files.";
const MERGE_CONFLICT_BLOCK_REASON = "Merge Failure";
const QUALITY_GATE_BLOCK_REASON = "Quality Gate Failure";

type MergeFailureStage = "rebase_before_merge" | "merge_to_main" | "push_rebase" | "quality_gate";

export interface MergeQualityGateRunOptions {
  validationBranchName?: string;
  skipEnvironmentRepair?: boolean;
  projectId: string;
  repoPath: string;
  worktreePath: string;
  taskId: string;
  branchName: string;
  baseBranch: string;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root";
  qualityGateProfile?: MergeQualityGateProfile;
  toolchainProfile?: ToolchainProfile;
}

export interface MergeQualityGateFailure {
  preserveWork?: boolean;
  recoveryIncidentId?: string;
  command: string;
  reason: string;
  output: string;
  outputSnippet?: string;
  worktreePath?: string;
  firstErrorLine?: string;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root";
  category?: "environment_setup" | "quality_gate";
  autoRepairAttempted?: boolean;
  autoRepairSucceeded?: boolean;
  autoRepairCommands?: string[];
  autoRepairOutput?: string;
  executable?: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: string | null;
  classificationConfidence?: "high" | "low";
  classificationReason?: string;
  gitStatusPorcelainSnippet?: string;
  gitNameStatusSnippet?: string;
  gateNodeVersion?: string;
  gateNpmVersion?: string;
  gateDependencyStrategy?: string;
  gateHermeticNodeModules?: boolean;
}

export interface MergeSlot {
  taskId: string;
  attempt: number;
  worktreePath: string | null;
  branchName: string;
  /** When set (per_epic + epic task), worktree key for removeTaskWorktree (e.g. epic_<epicId>). */
  worktreeKey?: string;
  phaseResult: {
    codingDiff: string;
    codingSummary: string;
    testResults: TestResults | null;
    testOutput: string;
    qualityGateDetail?: RetryQualityGateDetail | null;
    mergeGateArtifactTaskWorktree?:
      | import("./merge-verification.service.js").MergeGateVerificationArtifact
      | null;
  };
  agent: { outputLog: string[]; startedAt: string; cancelled?: boolean };
}

interface CleanupTarget {
  taskId: string;
  branchName: string;
  worktreePath: string | null;
  gitWorkingMode: "worktree" | "branches";
  /** When set (per_epic + epic task), key for removeTaskWorktree (e.g. epic_<epicId>). */
  worktreeKey?: string;
}

type PushCompletionStatus = "published" | "local_only" | "publish_failed";

export interface MergeCoordinatorHost {
  getState(projectId: string): {
    slots: Map<string, MergeSlot>;
    status: { totalDone: number; totalFailed: number; queueDepth: number };
    globalTimers: TimerRegistry;
  };
  taskStore: {
    close(projectId: string, taskId: string, reason: string): Promise<unknown>;
    update(projectId: string, taskId: string, fields: Record<string, unknown>): Promise<unknown>;
    comment(projectId: string, taskId: string, text: string): Promise<void>;
    sync?(repoPath: string): Promise<void>;
    syncForPush(projectId: string): Promise<void>;
    listAll(projectId: string): Promise<StoredTask[]>;
    show(projectId: string, id: string): Promise<StoredTask>;
    setCumulativeAttempts(
      projectId: string,
      id: string,
      count: number,
      options?: { currentLabels?: string[] }
    ): Promise<void>;
    getCumulativeAttemptsFromIssue(issue: StoredTask): number;
    setConflictFiles(projectId: string, id: string, files: string[]): Promise<void>;
    setMergeStage(projectId: string, id: string, stage: string | null): Promise<void>;
    planUpdateMetadata(
      projectId: string,
      planId: string,
      metadata: Record<string, unknown>
    ): Promise<void>;
    planGetByEpicId(
      projectId: string,
      epicId: string
    ): Promise<{
      plan_id: string;
      content: string;
      metadata: Record<string, unknown>;
      shipped_content: string | null;
      updated_at: string;
    } | null>;
  };
  branchManager: {
    getWorktreePath(key: string, repoPath?: string): string;
    waitForGitReady(wtPath: string): Promise<void>;
    commitWip(wtPath: string, taskId: string): Promise<unknown>;
    removeTaskWorktree(repoPath: string, taskId: string, actualPath?: string): Promise<boolean>;
    prepareWorktreeForRemoval(worktreeKey: string): Promise<void>;
    deleteBranch(repoPath: string, branchName: string): Promise<void>;
    revertAndReturnToMain?(
      repoPath: string,
      branchName: string,
      baseBranch?: string
    ): Promise<void>;
    getChangedFiles(repoPath: string, branchName: string, baseBranch?: string): Promise<string[]>;
    prepareMainForPush(repoPath: string, baseBranch?: string): Promise<void>;
    pushMain(repoPath: string, baseBranch?: string): Promise<void>;
    pushMainToOrigin(repoPath: string, baseBranch?: string): Promise<void>;
    isMergeInProgress(repoPath: string): Promise<boolean>;
    mergeAbort(repoPath: string): Promise<void>;
    mergeContinue(repoPath: string): Promise<void>;
    rebaseAbort(repoPath: string): Promise<void>;
    rebaseContinue(repoPath: string): Promise<void>;
    reconcileDependenciesAfterMerge(repoPath: string): Promise<void>;
    getGitRev(cwd: string, rev: string): Promise<string | null>;
  };
  runMergerAgentAndWait(options: {
    projectId: string;
    cwd: string;
    config: AgentConfig;
    phase: "rebase_before_merge" | "merge_to_main" | "push_rebase";
    taskId: string;
    branchName: string;
    conflictedFiles: string[];
    testCommand?: string;
    mergeQualityGates?: string[];
    baseBranch?: string;
  }): Promise<boolean>;
  runMergeQualityGates?(
    options: MergeQualityGateRunOptions
  ): Promise<MergeQualityGateFailure | null>;
  setBaselineRuntimeState(
    projectId: string,
    repoPath: string,
    updates: {
      baselineStatus?: BaselineRuntimeStatus;
      baselineCheckedAt?: string | null;
      baselineFailureSummary?: string | null;
      baselineRemediationStatus?: import("@opensprint/shared").BaselineRemediationStatus | null;
      dispatchPausedReason?: string | null;
    }
  ): Promise<void>;
  setMergeValidationRuntimeState(
    projectId: string,
    repoPath: string,
    updates: {
      mergeValidationStatus?: MergeValidationRuntimeStatus;
      mergeValidationFailureSummary?: string | null;
    }
  ): Promise<void>;
  sessionManager: {
    createSession(repoPath: string, data: Record<string, unknown>): Promise<unknown>;
    archiveSession(
      repoPath: string,
      taskId: string,
      attempt: number,
      session: unknown,
      wtPath?: string
    ): Promise<void>;
  };
  fileScopeAnalyzer: {
    recordActual(
      projectId: string,
      repoPath: string,
      taskId: string,
      changedFiles: string[],
      taskStore: unknown
    ): Promise<void>;
  };
  feedbackService: {
    checkAutoResolveOnTaskDone(projectId: string, taskId: string): Promise<void>;
  };
  projectService: {
    getSettings(projectId: string): Promise<{
      simpleComplexityAgent: { type: string; model?: string | null };
      complexComplexityAgent: { type: string; model?: string | null };
      deployment: { targets?: Array<{ name: string; autoDeployTrigger?: string }> };
      testCommand?: string | null;
      testFramework?: string | null;
      toolchainProfile?: ToolchainProfile;
      gitWorkingMode?: "worktree" | "branches";
      worktreeBaseBranch?: string;
      unknownScopeStrategy?: "conservative" | "optimistic";
      mergeStrategy?: "per_task" | "per_epic";
      deliveryMode?: "direct" | "pull_request";
    }>;
  };
  transition(projectId: string, t: { to: "complete" | "fail"; taskId: string }): void;
  suspendLocalValidation?(projectId: string, taskId: string): void;
  persistCounters(projectId: string, repoPath: string): Promise<void>;
  nudge(projectId: string): void;
}

export class MergeCoordinatorService {
  /** Guard against concurrent pushes per project */
  private pushInProgress = new Set<string>();
  /** Promise per project that resolves when the current push completes */
  private pushCompletion = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** Branch/worktree cleanup deferred until push succeeds. */
  private pendingCleanup = new Map<string, Map<string, CleanupTarget>>();
  /** Cached healthy baseline result per project/base branch. */
  private baselineQualityGateSuccessCache = new Map<string, { checkedAtMs: number }>();
  /** Shared in-flight baseline check per project/base branch. */
  private baselineQualityGateSingleFlight = new Map<
    string,
    Promise<MergeQualityGateFailure | null>
  >();
  /** Dedupes baseline gate notifications while baseline remains unhealthy. */
  private baselineQualityGateNotified = new Set<string>();
  /** Baseline incident lifecycle state per project/base branch. */
  private baselineIncidentState = new Map<
    string,
    {
      phase: "healthy" | "failing" | "recovering";
      consecutiveHealthy: number;
      lastFailureAtMs: number | null;
    }
  >();
  /** Repeated baseline-failure fingerprint counters used for bounded pause backoff. */
  private baselineFailureBackoff = new Map<
    string,
    { fingerprint: string; lastAtMs: number; consecutiveFailures: number }
  >();
  /** Suppresses duplicate remediation updates for repeated same-fingerprint failures. */
  private baselineRemediationSuppression = new Map<
    string,
    { fingerprint: string; observedAtMs: number }
  >();
  /** Rolling timestamps of merge-validation environment failures per project. */
  private mergeValidationEnvironmentFailures = new Map<string, number[]>();
  /** Project-level merge-validation health state. */
  private mergeValidationHealth = new Map<
    string,
    {
      status: MergeValidationRuntimeStatus;
      summary: string | null;
      nextCanaryAtMs: number | null;
    }
  >();
  /** Dedupes project-level merge-validation notifications while degraded. */
  private mergeValidationHealthNotified = new Set<string>();
  /** Prevent duplicate merge flow execution for the same project/task/attempt. */
  private inFlightMergeFlows = new Set<string>();

  constructor(private host: MergeCoordinatorHost) {}

  private mergeTraceSessionId(projectId: string, taskId: string, attempt?: number): string {
    return `merge:${projectId}:${taskId}:${attempt ?? 0}`;
  }

  private traceMergeLifecycle(
    event: string,
    projectId: string,
    taskId: string,
    payload?: Record<string, unknown>,
    options?: { attempt?: number; mirrorToCrashLog?: boolean }
  ): void {
    const sessionId = this.mergeTraceSessionId(projectId, taskId, options?.attempt);
    appendRuntimeTrace(`merge.${event}`, sessionId, {
      projectId,
      taskId,
      ...(options?.attempt !== undefined && { attempt: options.attempt }),
      ...(payload ?? {}),
    });
    if (options?.mirrorToCrashLog) {
      appendCrashLog(`merge.${event}`, {
        projectId,
        taskId,
        ...(options?.attempt !== undefined && { attempt: options.attempt }),
        ...(payload ?? {}),
      });
    }
  }

  private async registerPendingCleanup(
    projectId: string,
    repoPath: string,
    target: CleanupTarget
  ): Promise<void> {
    let perProject = this.pendingCleanup.get(projectId);
    if (!perProject) {
      perProject = new Map<string, CleanupTarget>();
      this.pendingCleanup.set(projectId, perProject);
    }
    perProject.set(target.taskId, target);
    await worktreeCleanupIntentService.registerBestEffort(repoPath, projectId, {
      ...target,
    });
    fireAndForget(
      eventLogService.append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: target.taskId,
        event: "worktree.cleanup_intent_registered",
        data: {
          trigger: "merge_success",
          branchName: target.branchName,
          worktreePath: target.worktreePath,
          worktreeKey: target.worktreeKey ?? target.taskId,
          gitWorkingMode: target.gitWorkingMode,
        },
      }),
      "merge-coordinator:worktree-cleanup-intent-registered-event-log"
    );

    // Durable lease stays held until deferred cleanup actually runs (push success or
    // recovery replay). Releasing here raced merge finalization/watchdog pruning while the
    // slot could still be alive or merge/post-merge work not finished.
    if (target.gitWorkingMode === "worktree") {
      log.info("Registered merge-success worktree cleanup intent; lease retained until teardown", {
        taskId: target.taskId,
        worktreeKey: target.worktreeKey ?? target.taskId,
      });
    }
  }

  private async hydratePendingCleanupFromDisk(projectId: string, repoPath: string): Promise<void> {
    const intents = await worktreeCleanupIntentService.list(repoPath, projectId);
    if (intents.length === 0) return;
    let perProject = this.pendingCleanup.get(projectId);
    if (!perProject) {
      perProject = new Map<string, CleanupTarget>();
      this.pendingCleanup.set(projectId, perProject);
    }
    for (const intent of intents) {
      if (!perProject.has(intent.taskId)) {
        perProject.set(intent.taskId, {
          taskId: intent.taskId,
          branchName: intent.branchName,
          worktreePath: intent.worktreePath,
          gitWorkingMode: intent.gitWorkingMode,
          worktreeKey: intent.worktreeKey,
        });
      }
    }
  }

  private async cleanupAfterSuccessfulPush(projectId: string, repoPath: string): Promise<void> {
    await this.hydratePendingCleanupFromDisk(projectId, repoPath);
    const perProject = this.pendingCleanup.get(projectId);
    if (!perProject || perProject.size === 0) return;
    const settings = await this.host.projectService.getSettings(projectId);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);

    for (const target of perProject.values()) {
      log.info("Push succeeded, cleaning up merged branch/worktree", {
        taskId: target.taskId,
        branchName: target.branchName,
      });
      try {
        if (target.gitWorkingMode === "branches") {
          if (this.host.branchManager.revertAndReturnToMain) {
            await this.host.branchManager.revertAndReturnToMain(
              repoPath,
              target.branchName,
              baseBranch
            );
          } else {
            await this.host.branchManager.deleteBranch(repoPath, target.branchName);
          }
        } else {
          const key = target.worktreeKey ?? target.taskId;
          const pathForGuard =
            target.worktreePath ?? this.host.branchManager.getWorktreePath(key, repoPath);
          if (pathForGuard) {
            try {
              await fs.access(pathForGuard);
              const resolvedWt = path.resolve(
                await fs.realpath(pathForGuard).catch(() => pathForGuard)
              );
              const protection = await evaluateWorktreeCleanupProtection(
                projectId,
                resolvedWt,
                (pid, tid) => this.host.taskStore.show(pid, tid),
                getWorktreeCleanupAssignmentGuardMs()
              );
              if (protection.forbid) {
                logWorktreeCleanupBlocked("merge_push_cleanup", {
                  projectId,
                  worktreePath: resolvedWt,
                  reason: protection.reason ?? "unknown",
                  referencingTaskIds: protection.referencingTaskIds,
                  cleanupTrigger: "merge_success_push",
                  intentTaskId: target.taskId,
                });
                continue;
              }
            } catch {
              // Worktree directory missing — nothing to guard on disk
            }
          }
          await this.host.branchManager.prepareWorktreeForRemoval(key);
          await worktreeLeaseService.forceRelease(key).catch((err) => {
            log.warn("Failed to release worktree lease before deferred path cleanup", {
              taskId: target.taskId,
              worktreeKey: key,
              err: err instanceof Error ? err.message : String(err),
            });
          });
          eventLogService
            .append(repoPath, {
              timestamp: new Date().toISOString(),
              projectId,
              taskId: target.taskId,
              event: "worktree.lease_released_for_cleanup",
              data: {
                trigger: "merge_success_push",
                worktreeKey: key,
              },
            })
            .catch(() => {});
          const removedOk = await this.host.branchManager.removeTaskWorktree(
            repoPath,
            key,
            target.worktreePath ?? undefined
          );
          if (!removedOk) {
            log.warn("Deferred cleanup skipped branch delete after worktree removal was blocked", {
              taskId: target.taskId,
              branchName: target.branchName,
              worktreeKey: key,
            });
            continue;
          }
          await this.host.branchManager.deleteBranch(repoPath, target.branchName);
        }
        perProject.delete(target.taskId);
        await worktreeCleanupIntentService.removeBestEffort(repoPath, projectId, target.taskId);
        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: target.taskId,
            event: "worktree.cleanup_succeeded",
            data: {
              trigger: "merge_success_push",
              branchName: target.branchName,
              worktreePath: target.worktreePath,
              worktreeKey: target.worktreeKey ?? target.taskId,
            },
          }),
          "merge-coordinator:worktree-cleanup-succeeded-event-log"
        );
      } catch (err) {
        log.warn("Deferred cleanup failed", {
          taskId: target.taskId,
          branchName: target.branchName,
          err: err instanceof Error ? err.message : String(err),
        });
        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: target.taskId,
            event: "worktree.cleanup_failed",
            data: {
              trigger: "merge_success_push",
              branchName: target.branchName,
              worktreePath: target.worktreePath,
              worktreeKey: target.worktreeKey ?? target.taskId,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
          "merge-coordinator:worktree-cleanup-failed-event-log"
        );
      }
    }

    if (perProject.size === 0) {
      this.pendingCleanup.delete(projectId);
    }
  }

  private getScopeConfidence(issue: StoredTask): "explicit" | "inferred" | "heuristic" {
    const labels = (issue.labels ?? []) as string[];
    if (
      labels.some((l) => l.startsWith("conflict_files:")) ||
      labels.some((l) => l.startsWith("files:"))
    ) {
      return "explicit";
    }
    if (labels.some((l) => l.startsWith("actual_files:"))) {
      return "inferred";
    }
    return "heuristic";
  }

  private getHumanFailureMessage(stage: MergeFailureStage): string {
    return stage === "quality_gate" ? QUALITY_GATE_FAILURE_MESSAGE : HUMAN_MERGE_FAILURE_MESSAGE;
  }

  private getMergeFailureBlockReason(stage: MergeFailureStage): string {
    return stage === "quality_gate" ? QUALITY_GATE_BLOCK_REASON : MERGE_CONFLICT_BLOCK_REASON;
  }

  private getMergeFailureType(
    stage: MergeFailureStage,
    failureTypeOverride?: RetryContext["failureType"]
  ): RetryContext["failureType"] {
    if (failureTypeOverride) return failureTypeOverride;
    return stage === "quality_gate" ? "merge_quality_gate" : "merge_conflict";
  }

  private buildRetryContextForMergeFailure(
    stage: MergeFailureStage,
    mergeFailureReason: string,
    failureTypeOverride?: RetryContext["failureType"],
    qualityGateDetail?: RetryQualityGateDetail | null
  ): RetryContext {
    const stageLabel = stage === "quality_gate" ? "pre-merge quality gate" : "merge";
    const detailSummary =
      stage === "quality_gate" && qualityGateDetail
        ? [
            qualityGateDetail.command ? `cmd: ${qualityGateDetail.command}` : null,
            qualityGateDetail.firstErrorLine
              ? `error: ${qualityGateDetail.firstErrorLine}`
              : qualityGateDetail.reason
                ? `reason: ${qualityGateDetail.reason}`
                : null,
          ]
            .filter((part): part is string => part != null && part.trim().length > 0)
            .join(" | ")
        : "";
    const previousFailure = compactExecutionText(
      `${stageLabel} failed: ${mergeFailureReason}${detailSummary ? ` (${detailSummary})` : ""}`,
      MERGE_RETRY_CONTEXT_FAILURE_LIMIT
    );
    const retryContext: RetryContext = {
      previousFailure,
      failureType: this.getMergeFailureType(stage, failureTypeOverride),
    };
    if (stage === "quality_gate" && qualityGateDetail) {
      retryContext.qualityGateDetail = qualityGateDetail;
    }
    return retryContext;
  }

  private async ensureMergeQualityGates(options: MergeQualityGateRunOptions): Promise<void> {
    if (!this.host.runMergeQualityGates) return;
    const profile = options.qualityGateProfile ?? DETERMINISTIC_MERGE_GATE_PROFILE;
    const slot = this.host.getState(options.projectId).slots.get(options.taskId);
    const artifact = slot?.phaseResult.mergeGateArtifactTaskWorktree;
    if (artifact && options.validationWorkspace === "task_worktree") {
      const stillCurrent = await isTaskWorktreeMergeGateArtifactCurrent(this.host.branchManager, {
        projectId: options.projectId,
        repoPath: options.repoPath,
        wtPath: options.worktreePath,
        baseBranch: options.baseBranch,
        artifact,
        toolchainProfile: options.toolchainProfile,
        qualityGateProfile: profile,
      });
      if (stillCurrent) {
        log.info("merge_gate_skipped_duplicate", {
          taskId: options.taskId,
          stage: "merge_coordinator_task_worktree",
        });
        return;
      }
    }
    const failure = await this.host.runMergeQualityGates({
      ...options,
      qualityGateProfile: profile,
    });
    if (!failure) return;

    throw buildMergeQualityGateJobError(failure, options.worktreePath);
  }

  private baselineCacheKey(projectId: string, baseBranch: string): string {
    return `${projectId}:${baseBranch}`;
  }

  private getBaselineIncidentState(cacheKey: string): {
    phase: "healthy" | "failing" | "recovering";
    consecutiveHealthy: number;
    lastFailureAtMs: number | null;
  } {
    return (
      this.baselineIncidentState.get(cacheKey) ?? {
        phase: "healthy",
        consecutiveHealthy: 0,
        lastFailureAtMs: null,
      }
    );
  }

  private markBaselineFailure(cacheKey: string): void {
    this.baselineIncidentState.set(cacheKey, {
      phase: "failing",
      consecutiveHealthy: 0,
      lastFailureAtMs: Date.now(),
    });
  }

  private markBaselineHealthySample(cacheKey: string): boolean {
    const current = this.getBaselineIncidentState(cacheKey);
    const nextConsecutive = Math.max(0, current.consecutiveHealthy) + 1;
    const hasRecovered = nextConsecutive >= BASELINE_INCIDENT_HEALTHY_THRESHOLD;
    this.baselineIncidentState.set(cacheKey, {
      phase: hasRecovered ? "healthy" : "recovering",
      consecutiveHealthy: hasRecovered ? BASELINE_INCIDENT_HEALTHY_THRESHOLD : nextConsecutive,
      lastFailureAtMs: current.lastFailureAtMs,
    });
    return hasRecovered;
  }

  private async recordBaselineCheckObservation(params: {
    projectId: string;
    repoPath: string;
    baseBranch: string;
    source: BaselineCheckSource;
    outcome: "healthy" | "failing" | "error" | "cached_healthy";
    failure?: MergeQualityGateFailure | null;
  }): Promise<void> {
    const { projectId, repoPath, baseBranch, source, outcome, failure } = params;
    fireAndForget(
      eventLogService.append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: "",
        event: "baseline.check",
        data: {
          source,
          baseBranch,
          outcome,
          validationWorkspace: failure?.validationWorkspace ?? null,
          qualityGateCategory: failure?.category ?? null,
          qualityGateCommand: failure?.command ?? null,
          firstErrorLine: failure?.firstErrorLine ?? null,
          classificationConfidence: failure?.classificationConfidence ?? null,
          classificationReason: failure?.classificationReason ?? null,
        },
      }),
      "merge-coordinator:baseline-check-event-log"
    );
  }

  private invalidateBaselineCacheAfterMerge(projectId: string, baseBranch: string): void {
    const cacheKey = this.baselineCacheKey(projectId, baseBranch);
    this.baselineQualityGateSuccessCache.delete(cacheKey);
    log.info("Invalidated baseline quality-gate cache after merge", { projectId, baseBranch });
  }

  private async reconcileDependenciesAfterMerge(repoPath: string, taskId: string): Promise<void> {
    try {
      await this.host.branchManager.reconcileDependenciesAfterMerge(repoPath);
    } catch (err) {
      log.warn("Post-merge dependency reconciliation failed", { repoPath, taskId, err });
    }
  }

  private buildBaselineDispatchPausedReason(baseBranch: string): string {
    return `Merge queue paused until baseline quality gates on ${baseBranch} pass.`;
  }

  private buildBaselineFailureSummary(
    baseBranch: string,
    failure: Pick<MergeQualityGateFailure, "command" | "firstErrorLine" | "reason">
  ): string {
    const firstErrorLine =
      failure.firstErrorLine?.trim() || failure.reason?.trim() || "Unknown quality gate failure";
    return compactExecutionText(
      `Baseline quality gates failing on ${baseBranch}: ${failure.command} | ${compactExecutionText(firstErrorLine, 220)}`,
      420
    );
  }

  private computeBaselinePauseWithBackoff(
    projectId: string,
    baseBranch: string,
    failure: MergeQualityGateFailure
  ): { pausedUntilIso: string; pauseMs: number; consecutiveFailures: number; fingerprint: string } {
    const now = Date.now();
    const cacheKey = this.baselineCacheKey(projectId, baseBranch);
    const fingerprint = buildBaselineFailureFingerprint(failure);
    const current = this.baselineFailureBackoff.get(cacheKey);
    const sameFingerprintWithinWindow =
      current &&
      current.fingerprint === fingerprint &&
      now - current.lastAtMs <= BASELINE_QUALITY_GATE_PAUSE_BACKOFF_WINDOW_MS;
    const consecutiveFailures = sameFingerprintWithinWindow
      ? Math.min(current.consecutiveFailures + 1, 8)
      : 1;
    this.baselineFailureBackoff.set(cacheKey, {
      fingerprint,
      lastAtMs: now,
      consecutiveFailures,
    });
    const pauseMultiplier = Math.max(1, 2 ** (consecutiveFailures - 1));
    const pauseMs = Math.min(
      BASELINE_QUALITY_GATE_PAUSE_MS * pauseMultiplier,
      BASELINE_QUALITY_GATE_PAUSE_MAX_MS
    );
    return {
      pausedUntilIso: new Date(now + pauseMs).toISOString(),
      pauseMs,
      consecutiveFailures,
      fingerprint,
    };
  }

  private async shouldSuppressRedundantBaselineRemediation(
    projectId: string,
    baseBranch: string,
    fingerprint: string
  ): Promise<boolean> {
    const cacheKey = this.baselineCacheKey(projectId, baseBranch);
    const cached = this.baselineRemediationSuppression.get(cacheKey);
    const now = Date.now();
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      now - cached.observedAtMs <= BASELINE_REMEDIATION_SUPPRESSION_MS
    ) {
      return true;
    }

    const allTasks = await this.host.taskStore.listAll(projectId);
    const openRemediation = allTasks.find(
      (task) =>
        (task.status as string) !== "closed" &&
        this.isBaselineQualityGateRemediationTask(task, baseBranch)
    );
    if (!openRemediation) return false;
    const existingFingerprint = (openRemediation as { baselineFailureFingerprint?: unknown })
      .baselineFailureFingerprint;
    const observedAtRaw = (openRemediation as { baselineFailureObservedAt?: unknown })
      .baselineFailureObservedAt;
    const observedAtMs = typeof observedAtRaw === "string" ? Date.parse(observedAtRaw) : Number.NaN;
    if (
      existingFingerprint === fingerprint &&
      Number.isFinite(observedAtMs) &&
      now - observedAtMs <= BASELINE_REMEDIATION_SUPPRESSION_MS
    ) {
      this.baselineRemediationSuppression.set(cacheKey, { fingerprint, observedAtMs: now });
      return true;
    }
    return false;
  }

  private buildUnexpectedBaselineFailure(err: unknown): MergeQualityGateFailure {
    const reason =
      compactExecutionText(err instanceof Error ? err.message : String(err), 500) ||
      "Baseline validation setup failed";
    return {
      command: "baseline validation setup",
      reason,
      output: reason,
      outputSnippet: reason,
      firstErrorLine: reason,
      validationWorkspace: "baseline",
      category: "environment_setup",
    };
  }

  private isBaselineQualityGateRemediationTask(task: StoredTask, baseBranch: string): boolean {
    const source = (task as { source?: unknown }).source;
    const kind = (task as { selfImprovementKind?: unknown }).selfImprovementKind;
    const sourceId = (task as { baselineQualityGateSource?: unknown }).baselineQualityGateSource;
    const taskBaseBranch = (task as { baselineBaseBranch?: unknown }).baselineBaseBranch;

    if (source !== "self-improvement") return false;
    if (kind !== "baseline-quality-gate" && sourceId !== BASELINE_QUALITY_GATE_TASK_SOURCE) {
      return false;
    }
    if (typeof taskBaseBranch === "string" && taskBaseBranch.trim() !== "") {
      return taskBaseBranch === baseBranch;
    }
    return true;
  }

  private async getBaselineQualityGateFailure(
    projectId: string,
    repoPath: string,
    baseBranch: string,
    options?: { useCache?: boolean; source?: BaselineCheckSource }
  ): Promise<MergeQualityGateFailure | null> {
    if (!this.host.runMergeQualityGates) return null;

    const cacheKey = this.baselineCacheKey(projectId, baseBranch);
    const source = options?.source ?? "merge_precheck";
    const now = Date.now();
    const useCache = options?.useCache !== false;
    const cachedSuccess = this.baselineQualityGateSuccessCache.get(cacheKey);
    if (
      useCache &&
      cachedSuccess &&
      now - cachedSuccess.checkedAtMs < BASELINE_QUALITY_GATE_SUCCESS_CACHE_MS
    ) {
      await this.recordBaselineCheckObservation({
        projectId,
        repoPath,
        baseBranch,
        source,
        outcome: "cached_healthy",
      });
      return null;
    }

    const inFlight = this.baselineQualityGateSingleFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const checkPromise = (async (): Promise<MergeQualityGateFailure | null> => {
      const checkedAt = new Date().toISOString();
      await this.host.setBaselineRuntimeState(projectId, repoPath, {
        baselineStatus: "checking",
      });
      let workspace: Awaited<
        ReturnType<typeof validationWorkspaceService.createBaselineWorkspace>
      > | null = null;

      try {
        workspace = await validationWorkspaceService
          .createBaselineWorkspace(
            repoPath,
            baseBranch,
            (await this.host.projectService.getSettings(projectId)).toolchainProfile,
            true
          )
          .catch((err) => {
            throw this.buildUnexpectedBaselineFailure(err);
          });
        const failure =
          (await this.host.runMergeQualityGates?.({
            projectId,
            repoPath,
            worktreePath: workspace.worktreePath,
            taskId: `baseline:${baseBranch}`,
            branchName: baseBranch,
            baseBranch,
            validationWorkspace: "baseline",
            qualityGateProfile: DETERMINISTIC_MERGE_GATE_PROFILE,
            toolchainProfile: (await this.host.projectService.getSettings(projectId))
              .toolchainProfile,
          })) ?? null;

        if (!failure) {
          this.baselineQualityGateSuccessCache.set(cacheKey, { checkedAtMs: Date.now() });
          const incidentRecovered = this.markBaselineHealthySample(cacheKey);
          if (incidentRecovered) {
            this.baselineQualityGateNotified.delete(cacheKey);
            this.baselineFailureBackoff.delete(cacheKey);
            this.baselineRemediationSuppression.delete(cacheKey);
            await this.resolveBaselineQualityGateNotifications(projectId, baseBranch);
            await this.closeBaselineRemediationTask(projectId, baseBranch);
          }
          const remediationStatus = incidentRecovered
            ? null
            : await this.getBaselineRemediationStatus(projectId, baseBranch);
          await this.markMergeValidationHealthy(projectId, repoPath);
          await this.host.setBaselineRuntimeState(projectId, repoPath, {
            baselineStatus: "healthy",
            baselineCheckedAt: checkedAt,
            baselineFailureSummary: null,
            baselineRemediationStatus: remediationStatus,
            dispatchPausedReason: null,
          });
          await this.recordBaselineCheckObservation({
            projectId,
            repoPath,
            baseBranch,
            source,
            outcome: "healthy",
          });
          return null;
        }

        const normalizedFailure: MergeQualityGateFailure = {
          ...failure,
          validationWorkspace: failure.validationWorkspace ?? "baseline",
        };
        this.markBaselineFailure(cacheKey);
        if (normalizedFailure.category !== "environment_setup") {
          await this.markMergeValidationHealthy(projectId, repoPath);
        }
        this.baselineQualityGateSuccessCache.delete(cacheKey);
        const remediationStatus = await this.getBaselineRemediationStatus(projectId, baseBranch);
        await this.host.setBaselineRuntimeState(projectId, repoPath, {
          baselineStatus: "failing",
          baselineCheckedAt: checkedAt,
          baselineFailureSummary: this.buildBaselineFailureSummary(baseBranch, normalizedFailure),
          baselineRemediationStatus: remediationStatus,
          dispatchPausedReason: this.buildBaselineDispatchPausedReason(baseBranch),
        });
        await this.recordBaselineCheckObservation({
          projectId,
          repoPath,
          baseBranch,
          source,
          outcome: "failing",
          failure: normalizedFailure,
        });
        return normalizedFailure;
      } catch (err) {
        const failure =
          err && typeof err === "object" && "command" in err
            ? (err as MergeQualityGateFailure)
            : this.buildUnexpectedBaselineFailure(err);
        this.markBaselineFailure(cacheKey);
        if (failure.category !== "environment_setup") {
          await this.markMergeValidationHealthy(projectId, repoPath);
        }
        this.baselineQualityGateSuccessCache.delete(cacheKey);
        const remediationStatus = await this.getBaselineRemediationStatus(projectId, baseBranch);
        await this.host.setBaselineRuntimeState(projectId, repoPath, {
          baselineStatus: "failing",
          baselineCheckedAt: checkedAt,
          baselineFailureSummary: this.buildBaselineFailureSummary(baseBranch, failure),
          baselineRemediationStatus: remediationStatus,
          dispatchPausedReason: this.buildBaselineDispatchPausedReason(baseBranch),
        });
        await this.recordBaselineCheckObservation({
          projectId,
          repoPath,
          baseBranch,
          source,
          outcome: "error",
          failure,
        });
        return failure;
      } finally {
        this.baselineQualityGateSingleFlight.delete(cacheKey);
        await workspace?.cleanup().catch((cleanupErr) => {
          log.warn("Failed to clean up baseline validation workspace", {
            projectId,
            baseBranch,
            cleanupErr,
          });
        });
      }
    })();

    this.baselineQualityGateSingleFlight.set(cacheKey, checkPromise);
    return checkPromise;
  }

  private async createBaselineQualityGateNotification(
    projectId: string,
    baseBranch: string,
    detail: string
  ): Promise<void> {
    const cacheKey = this.baselineCacheKey(projectId, baseBranch);
    if (this.baselineQualityGateNotified.has(cacheKey)) return;

    try {
      const notification = await notificationService.createAgentFailed({
        projectId,
        source: "execute",
        sourceId: `${BASELINE_QUALITY_GATE_NOTIFICATION_SOURCE_ID}:${baseBranch}`,
        message: compactExecutionText(
          `Merge queue paused: baseline quality gates on ${baseBranch} are failing. ${detail}`,
          1800
        ),
      });
      this.baselineQualityGateNotified.add(cacheKey);
      broadcastToProject(projectId, {
        type: "notification.added",
        notification,
      });
    } catch (err) {
      log.warn("Failed to create baseline quality-gate notification", {
        projectId,
        baseBranch,
        err,
      });
    }
  }

  private async resolveBaselineQualityGateNotifications(
    projectId: string,
    baseBranch: string
  ): Promise<void> {
    const sourceId = `${BASELINE_QUALITY_GATE_NOTIFICATION_SOURCE_ID}:${baseBranch}`;
    try {
      const notifications = await notificationService.listByProject(projectId);
      const baselineNotifications = notifications.filter(
        (n) =>
          n.kind === "agent_failed" &&
          n.source === "execute" &&
          n.sourceId === sourceId &&
          n.status === "open"
      );
      for (const notification of baselineNotifications) {
        await notificationService.resolve(projectId, notification.id);
        broadcastToProject(projectId, {
          type: "notification.resolved",
          notificationId: notification.id,
          projectId,
          source: notification.source,
          sourceId: notification.sourceId,
        });
      }
    } catch (err) {
      log.warn("Failed to resolve baseline quality-gate notifications", {
        projectId,
        baseBranch,
        err,
      });
    }
  }

  private async getBaselineRemediationStatus(
    projectId: string,
    baseBranch: string
  ): Promise<import("@opensprint/shared").BaselineRemediationStatus | null> {
    try {
      const allTasks = await this.host.taskStore.listAll(projectId);
      const task = allTasks.find(
        (t) =>
          (t.status as string) !== "closed" &&
          this.isBaselineQualityGateRemediationTask(t, baseBranch)
      );
      if (!task) return null;
      return {
        taskId: task.id,
        attempts: this.host.taskStore.getCumulativeAttemptsFromIssue(task),
        maxAttempts: MAX_BASELINE_REMEDIATION_ATTEMPTS,
        status: (task.status as string) ?? "open",
      };
    } catch {
      return null;
    }
  }

  /**
   * Close the open baseline remediation task when baseline is restored to healthy.
   * Each "episode" of main being broken gets its own task; closing it on recovery
   * ensures the next failure episode starts with a fresh task and clean attempt history.
   */
  private async closeBaselineRemediationTask(projectId: string, baseBranch: string): Promise<void> {
    try {
      const allTasks = await this.host.taskStore.listAll(projectId);
      const remediationTask = allTasks.find(
        (task) =>
          (task.status as string) !== "closed" &&
          this.isBaselineQualityGateRemediationTask(task, baseBranch)
      );
      if (remediationTask) {
        await this.host.taskStore.close(projectId, remediationTask.id, "Baseline restored");
        await broadcastAuthoritativeTaskUpdated(broadcastToProject, projectId, remediationTask.id);
        log.info("Closed baseline remediation task after baseline restored", {
          projectId,
          taskId: remediationTask.id,
          baseBranch,
        });
      }
    } catch (err) {
      log.warn("Failed to close baseline remediation task on restore", {
        projectId,
        baseBranch,
        err,
      });
    }
  }

  private getMergeValidationHealth(projectId: string): {
    status: MergeValidationRuntimeStatus;
    summary: string | null;
    nextCanaryAtMs: number | null;
  } {
    return (
      this.mergeValidationHealth.get(projectId) ?? {
        status: "healthy",
        summary: null,
        nextCanaryAtMs: null,
      }
    );
  }

  private buildMergeValidationHealthSummary(params: {
    command?: string | null;
    firstErrorLine?: string | null;
    reason?: string | null;
    remediation?: string | null;
  }): string {
    const firstErrorLine =
      params.firstErrorLine?.trim() ||
      params.reason?.trim() ||
      "Merge validation environment setup failed";
    const command = params.command?.trim();
    return compactExecutionText(
      `Merge validation environment issues detected${command ? `: ${command}` : ""} | ${compactExecutionText(firstErrorLine, 220)}${params.remediation ? ` | remediation: ${compactExecutionText(params.remediation, 220)}` : ""}`,
      500
    );
  }

  private async createMergeValidationHealthNotification(
    projectId: string,
    summary: string
  ): Promise<void> {
    if (this.mergeValidationHealthNotified.has(projectId)) return;
    try {
      const notification = await notificationService.createAgentFailed({
        projectId,
        source: "execute",
        sourceId: MERGE_VALIDATION_HEALTH_NOTIFICATION_SOURCE_ID,
        message: compactExecutionText(`Merge validation is temporarily degraded. ${summary}`, 1800),
      });
      this.mergeValidationHealthNotified.add(projectId);
      broadcastToProject(projectId, {
        type: "notification.added",
        notification,
      });
    } catch (err) {
      log.warn("Failed to create merge-validation health notification", {
        projectId,
        err,
      });
    }
  }

  private async resolveMergeValidationHealthNotifications(projectId: string): Promise<void> {
    try {
      const notifications = await notificationService.listByProject(projectId);
      const healthNotifications = notifications.filter(
        (n) =>
          n.kind === "agent_failed" &&
          n.source === "execute" &&
          n.sourceId === MERGE_VALIDATION_HEALTH_NOTIFICATION_SOURCE_ID &&
          n.status === "open"
      );
      for (const notification of healthNotifications) {
        await notificationService.resolve(projectId, notification.id);
        broadcastToProject(projectId, {
          type: "notification.resolved",
          notificationId: notification.id,
          projectId,
          source: notification.source,
          sourceId: notification.sourceId,
        });
      }
    } catch (err) {
      log.warn("Failed to resolve merge-validation health notifications", {
        projectId,
        err,
      });
    }
  }

  private async markMergeValidationHealthy(projectId: string, repoPath: string): Promise<void> {
    const current = this.getMergeValidationHealth(projectId);
    if (current.status === "healthy" && current.summary == null) return;
    this.mergeValidationHealth.set(projectId, {
      status: "healthy",
      summary: null,
      nextCanaryAtMs: null,
    });
    this.mergeValidationEnvironmentFailures.delete(projectId);
    this.mergeValidationHealthNotified.delete(projectId);
    await this.host.setMergeValidationRuntimeState(projectId, repoPath, {
      mergeValidationStatus: "healthy",
      mergeValidationFailureSummary: null,
    });
    await this.resolveMergeValidationHealthNotifications(projectId);
  }

  private async recordMergeValidationEnvironmentFailure(
    projectId: string,
    repoPath: string,
    summary: string
  ): Promise<void> {
    const now = Date.now();
    const recent = (this.mergeValidationEnvironmentFailures.get(projectId) ?? []).filter(
      (timestamp) => now - timestamp <= MERGE_VALIDATION_FAILURE_WINDOW_MS
    );
    recent.push(now);
    this.mergeValidationEnvironmentFailures.set(projectId, recent);

    const degraded = recent.length >= MERGE_VALIDATION_DEGRADED_THRESHOLD;
    const current = this.getMergeValidationHealth(projectId);
    const nextStatus: MergeValidationRuntimeStatus =
      degraded || current.status === "degraded" ? "degraded" : "healthy";
    const nextCanaryAtMs =
      nextStatus === "degraded" ? now + MERGE_VALIDATION_CANARY_INTERVAL_MS : null;
    const nextState = {
      status: nextStatus,
      summary,
      nextCanaryAtMs,
    } as const;
    this.mergeValidationHealth.set(projectId, nextState);

    if (nextStatus !== "degraded") return;

    await this.host.setMergeValidationRuntimeState(projectId, repoPath, {
      mergeValidationStatus: nextStatus,
      mergeValidationFailureSummary: summary,
    });
    if (degraded) {
      await this.createMergeValidationHealthNotification(projectId, summary);
    }
  }

  private async deferMergeValidationWhileDegraded(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: MergeSlot,
    worktreePath: string
  ): Promise<boolean> {
    const health = this.getMergeValidationHealth(projectId);
    if (health.status !== "degraded") return false;
    const now = Date.now();
    if (health.nextCanaryAtMs == null || health.nextCanaryAtMs <= now) {
      return false;
    }

    const nextCanaryAt = new Date(health.nextCanaryAtMs).toISOString();
    const attempt =
      (typeof slot.attempt === "number" && Number.isFinite(slot.attempt)
        ? slot.attempt
        : Math.max(1, this.host.taskStore.getCumulativeAttemptsFromIssue(task) + 1)) || 1;
    const summary = buildTaskLastExecutionSummary({
      attempt,
      outcome: "requeued",
      phase: "merge",
      failureType: "environment_setup",
      summary: compactExecutionText(
        `Merge validation deferred while project validation health recovers. Canary retry scheduled after ${nextCanaryAt}.${health.summary ? ` ${health.summary}` : ""}`,
        500
      ),
    });
    const qualityGateDetail: RetryQualityGateDetail = {
      command: "merge validation",
      reason: health.summary ?? "Merge validation health is degraded",
      firstErrorLine: health.summary ?? "Merge validation health is degraded",
      worktreePath,
      category: "environment_setup",
      validationWorkspace: "merged_candidate",
      repairAttempted: false,
      repairSucceeded: false,
    };

    await this.host.taskStore.setMergeStage(projectId, task.id, "quality_gate");
    await this.host.taskStore.update(projectId, task.id, {
      status: "open",
      assignee: "",
      extra: {
        last_execution_summary: summary,
        [MERGE_RETRY_MODE_KEY]: BASELINE_MERGE_RETRY_MODE,
        [MERGE_VALIDATION_PAUSED_UNTIL_KEY]: nextCanaryAt,
        worktreePath,
        qualityGateCategory: "environment_setup",
        qualityGateValidationWorkspace: "merged_candidate",
        qualityGateDetail,
      },
    });
    await this.releaseMergeSlot(projectId, repoPath, "fail", task.id);
    this.host.nudge(projectId);
    return true;
  }

  private async pauseMergeForBaselineQualityGateFailure(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    baseBranch: string,
    failure: MergeQualityGateFailure,
    taskWorktreePath: string
  ): Promise<void> {
    const detail = buildBaselineQualityGateNotificationDetail(failure);
    const firstErrorLine = getQualityGateFirstErrorLine(failure);
    const failedGateReason = failure.reason.trim().slice(0, 500) || "Unknown quality gate failure";
    const failedGateOutputSnippet =
      toQualityGateOutputSnippet(failure.outputSnippet ?? failure.output) ??
      compactExecutionText(
        getQualityGateFirstErrorLine(failure),
        QUALITY_GATE_OUTPUT_SNIPPET_LIMIT
      );
    const failureWorktreePath = failure.worktreePath ?? repoPath;
    const qualityGateDetail = {
      command: failure.command,
      reason: failedGateReason,
      outputSnippet: failedGateOutputSnippet,
      worktreePath: failureWorktreePath,
      firstErrorLine,
      category: failure.category ?? "quality_gate",
      validationWorkspace: failure.validationWorkspace ?? null,
      repairAttempted: failure.autoRepairAttempted ?? false,
      repairSucceeded: failure.autoRepairSucceeded ?? false,
      executable: failure.executable ?? null,
      cwd: failure.cwd ?? null,
      exitCode: failure.exitCode ?? null,
      signal: failure.signal ?? null,
      classificationConfidence: failure.classificationConfidence ?? null,
      classificationReason: failure.classificationReason ?? null,
      gateNodeVersion: failure.gateNodeVersion ?? null,
      gateNpmVersion: failure.gateNpmVersion ?? null,
      gateDependencyStrategy: failure.gateDependencyStrategy ?? null,
      gateHermeticNodeModules: failure.gateHermeticNodeModules ?? null,
    };
    const attempt = Math.max(1, this.host.taskStore.getCumulativeAttemptsFromIssue(task) + 1) || 1;
    const {
      pausedUntilIso: pausedUntil,
      pauseMs,
      consecutiveFailures,
      fingerprint: baselineFailureFingerprint,
    } = this.computeBaselinePauseWithBackoff(projectId, baseBranch, failure);
    const isEnvironmentSetupFailure = failure.category === "environment_setup";
    const remediationAction = isEnvironmentSetupFailure
      ? buildEnvironmentSetupRemediationMessage({
          command: failure.command,
          worktreePath: failureWorktreePath,
          validationWorkspace: failure.validationWorkspace ?? null,
        })
      : null;
    const nextAction =
      remediationAction ??
      `Paused until baseline quality gates pass (recheck in ~${Math.max(1, Math.round(pauseMs / 60_000))}m)`;
    const mergeValidationSummary = this.buildMergeValidationHealthSummary({
      command: failure.command,
      firstErrorLine,
      reason: failedGateReason,
      remediation: remediationAction,
    });
    if (isEnvironmentSetupFailure) {
      await this.recordMergeValidationEnvironmentFailure(
        projectId,
        repoPath,
        mergeValidationSummary
      );
    } else {
      await this.markMergeValidationHealthy(projectId, repoPath);
    }
    const requeuedSummary = buildTaskLastExecutionSummary({
      attempt,
      outcome: "requeued",
      phase: "merge",
      failureType: isEnvironmentSetupFailure ? "environment_setup" : "merge_quality_gate",
      summary: compactExecutionText(
        `Merge paused: baseline quality gates on ${baseBranch} are failing (${detail})${remediationAction ? `. Remediation: ${remediationAction}` : ""}. Recheck scheduled in ~${Math.max(1, Math.round(pauseMs / 60_000))}m (same-fingerprint failures: ${consecutiveFailures}).`,
        500
      ),
    });
    const retryContext: RetryContext = {
      previousFailure: compactExecutionText(
        `baseline quality gates failed on ${baseBranch}: ${failure.reason} (cmd: ${failure.command} | error: ${firstErrorLine})`,
        MERGE_RETRY_CONTEXT_FAILURE_LIMIT
      ),
      failureType: isEnvironmentSetupFailure ? "environment_setup" : "merge_quality_gate",
    };
    retryContext.qualityGateDetail = qualityGateDetail;

    await this.host.taskStore.setMergeStage(projectId, task.id, "quality_gate");
    await this.host.taskStore.update(projectId, task.id, {
      status: "open",
      assignee: "",
      extra: {
        last_execution_summary: requeuedSummary,
        [NEXT_RETRY_CONTEXT_KEY]: retryContext,
        [MERGE_RETRY_MODE_KEY]: BASELINE_MERGE_RETRY_MODE,
        [BASELINE_QUALITY_GATE_PAUSED_UNTIL_KEY]: pausedUntil,
        baselineFailureFingerprint,
        baselineQualityGatePauseMs: pauseMs,
        baselineQualityGateConsecutiveFailures: consecutiveFailures,
        failedGateCommand: failure.command,
        failedGateReason,
        failedGateOutputSnippet,
        worktreePath: taskWorktreePath,
        qualityGateCategory: failure.category ?? "quality_gate",
        qualityGateValidationWorkspace: failure.validationWorkspace ?? null,
        qualityGateAutoRepairAttempted: failure.autoRepairAttempted ?? false,
        qualityGateAutoRepairSucceeded: failure.autoRepairSucceeded ?? false,
        qualityGateExecutable: failure.executable ?? null,
        qualityGateCwd: failure.cwd ?? null,
        qualityGateExitCode: failure.exitCode ?? null,
        qualityGateSignal: failure.signal ?? null,
        qualityGateClassificationConfidence: failure.classificationConfidence ?? null,
        qualityGateClassificationReason: failure.classificationReason ?? null,
        qualityGateDetail,
      },
    });
    await broadcastAuthoritativeTaskUpdated(broadcastToProject, projectId, task.id);
    await this.host.taskStore.comment(
      projectId,
      task.id,
      `Merge paused because baseline quality gates on ${baseBranch} are failing. ${QUALITY_GATE_FAILURE_MESSAGE} Details: ${detail}.${remediationAction ? ` Remediation: ${remediationAction}` : ""}`
    );
    await this.createBaselineQualityGateNotification(projectId, baseBranch, detail);
    fireAndForget(
      eventLogService.append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: "merge.failed",
        data: {
          reason: `Baseline quality gates failing on ${baseBranch}: ${failure.reason}`,
          stage: "quality_gate",
          failureType: retryContext.failureType ?? null,
          branchName: baseBranch,
          conflictedFiles: [],
          attempt,
          resolvedBy: "requeued",
          policyDecision: "requeue",
          scopeConfidence: this.getScopeConfidence(task),
          summary: requeuedSummary.summary,
          nextAction,
          qualityGateCategory: failure.category ?? "quality_gate",
          qualityGateValidationWorkspace: failure.validationWorkspace ?? null,
          qualityGateCommand: failure.command,
          baselineFailureFingerprint,
          baselineQualityGatePauseMs: pauseMs,
          baselineQualityGateConsecutiveFailures: consecutiveFailures,
          qualityGateFirstErrorLine: firstErrorLine,
          qualityGateAutoRepairAttempted: failure.autoRepairAttempted ?? false,
          qualityGateAutoRepairSucceeded: failure.autoRepairSucceeded ?? false,
          failedGateCommand: failure.command,
          failedGateReason,
          failedGateOutputSnippet,
          worktreePath: failureWorktreePath,
          qualityGateExecutable: failure.executable ?? null,
          qualityGateCwd: failure.cwd ?? null,
          qualityGateExitCode: failure.exitCode ?? null,
          qualityGateSignal: failure.signal ?? null,
          qualityGateClassificationConfidence: failure.classificationConfidence ?? null,
          qualityGateClassificationReason: failure.classificationReason ?? null,
          qualityGateDetail,
        },
      }),
      "merge-coordinator:merge-failed-baseline-quality-gate-event-log"
    );
    fireAndForget(
      eventLogService.append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: "task.requeued",
        data: {
          attempt,
          phase: "merge",
          failureType: retryContext.failureType ?? null,
          policyDecision: "requeue",
          mergeStage: "quality_gate",
          conflictedFiles: [],
          summary: requeuedSummary.summary,
          nextAction,
          failedGateCommand: failure.command,
          failedGateReason,
          failedGateOutputSnippet,
          worktreePath: failureWorktreePath,
          qualityGateCategory: failure.category ?? "quality_gate",
          qualityGateValidationWorkspace: failure.validationWorkspace ?? null,
          qualityGateAutoRepairAttempted: failure.autoRepairAttempted ?? false,
          qualityGateAutoRepairSucceeded: failure.autoRepairSucceeded ?? false,
          qualityGateExecutable: failure.executable ?? null,
          qualityGateCwd: failure.cwd ?? null,
          qualityGateExitCode: failure.exitCode ?? null,
          qualityGateSignal: failure.signal ?? null,
          qualityGateClassificationConfidence: failure.classificationConfidence ?? null,
          qualityGateClassificationReason: failure.classificationReason ?? null,
          qualityGateDetail,
        },
      }),
      "merge-coordinator:task-requeued-baseline-quality-gate-event-log"
    );
    this.broadcastMergeFailureWs(projectId, task.id, {
      cumulativeAttempts: attempt,
      resolvedBy: "requeued",
      reason: `Baseline quality gates failing on ${baseBranch}: ${failure.reason}`,
      mergeStage: "quality_gate",
      qualityGateDetail,
      failedGateCommand: failure.command,
      failedGateReason,
      failedGateOutputSnippet,
      worktreePath: failureWorktreePath,
    });
    this.broadcastTaskRequeuedWs(projectId, task.id, {
      cumulativeAttempts: attempt,
      phase: "merge",
      mergeStage: "quality_gate",
      summary: requeuedSummary.summary,
      nextAction,
      qualityGateDetail,
      failedGateCommand: failure.command,
      failedGateReason,
      failedGateOutputSnippet,
      worktreePath: failureWorktreePath,
    });
  }

  private broadcastMergeFailureWs(
    projectId: string,
    taskId: string,
    args: {
      cumulativeAttempts: number;
      resolvedBy: "requeued" | "blocked";
      reason?: string | null;
      mergeStage?: string | null;
      qualityGateDetail?: RetryQualityGateDetail | null;
      failedGateCommand?: string | null;
      failedGateReason?: string | null;
      failedGateOutputSnippet?: string | null;
      worktreePath?: string | null;
      failureClass?: string | null;
      failureFingerprint?: string | null;
      circuitBreakerTripped?: boolean;
    }
  ): void {
    const qg = args.qualityGateDetail ?? null;
    broadcastToProject(projectId, {
      type: "merge.failed",
      taskId,
      cumulativeAttempts: args.cumulativeAttempts,
      resolvedBy: args.resolvedBy,
      reason: args.reason ?? null,
      mergeStage: args.mergeStage ?? null,
      qualityGateDetail: qg,
      failedGateCommand: args.failedGateCommand ?? qg?.command ?? null,
      failedGateReason: args.failedGateReason ?? qg?.reason ?? null,
      failedGateOutputSnippet: args.failedGateOutputSnippet ?? qg?.outputSnippet ?? null,
      worktreePath: args.worktreePath ?? qg?.worktreePath ?? null,
      failureClass: args.failureClass ?? null,
      failureFingerprint: args.failureFingerprint ?? null,
      circuitBreakerTripped: args.circuitBreakerTripped ?? false,
    } as unknown as ServerEvent);
  }

  private broadcastTaskRequeuedWs(
    projectId: string,
    taskId: string,
    args: {
      cumulativeAttempts: number;
      phase?: string | null;
      mergeStage?: string | null;
      summary?: string | null;
      nextAction?: string | null;
      qualityGateDetail?: RetryQualityGateDetail | null;
      failedGateCommand?: string | null;
      failedGateReason?: string | null;
      failedGateOutputSnippet?: string | null;
      worktreePath?: string | null;
      failureClass?: string | null;
      failureFingerprint?: string | null;
    }
  ): void {
    const qg = args.qualityGateDetail ?? null;
    broadcastToProject(projectId, {
      type: "task.requeued",
      taskId,
      cumulativeAttempts: args.cumulativeAttempts,
      phase: args.phase ?? null,
      mergeStage: args.mergeStage ?? null,
      summary: args.summary ?? null,
      nextAction: args.nextAction ?? null,
      qualityGateDetail: qg,
      failedGateCommand: args.failedGateCommand ?? qg?.command ?? null,
      failedGateReason: args.failedGateReason ?? qg?.reason ?? null,
      failedGateOutputSnippet: args.failedGateOutputSnippet ?? qg?.outputSnippet ?? null,
      worktreePath: args.worktreePath ?? qg?.worktreePath ?? null,
      failureClass: args.failureClass ?? null,
      failureFingerprint: args.failureFingerprint ?? null,
    } as unknown as ServerEvent);
  }

  private async createBaselineQualityGateRemediationTask(
    repoPath: string,
    projectId: string,
    baseBranch: string,
    failure: MergeQualityGateFailure
  ): Promise<{
    action: BaselineRemediationTaskAction;
    createdTask: boolean;
    fingerprint: string;
  }> {
    const fingerprint = buildBaselineFailureFingerprint(failure);
    if (failure.category === "environment_setup" && failure.classificationConfidence === "low") {
      log.info(
        "Skipping baseline remediation task creation for low-confidence environment failure",
        {
          projectId,
          baseBranch,
          command: failure.command,
          firstErrorLine: failure.firstErrorLine,
          classificationReason: failure.classificationReason ?? null,
        }
      );
      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "baseline.remediation_task",
          data: {
            action: "skipped_low_confidence",
            baseBranch,
            fingerprint,
            command: failure.command,
            category: failure.category ?? null,
            classificationConfidence: failure.classificationConfidence ?? null,
            classificationReason: failure.classificationReason ?? null,
          },
        }),
        "merge-coordinator:baseline-remediation-skipped-event-log"
      );
      return { action: "skipped_low_confidence", createdTask: false, fingerprint };
    }
    if (await this.shouldSuppressRedundantBaselineRemediation(projectId, baseBranch, fingerprint)) {
      const cacheKey = this.baselineCacheKey(projectId, baseBranch);
      this.baselineRemediationSuppression.set(cacheKey, { fingerprint, observedAtMs: Date.now() });
      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "baseline.remediation_task",
          data: {
            action: "suppressed_redundant",
            baseBranch,
            fingerprint,
            command: failure.command,
            category: failure.category ?? null,
          },
        }),
        "merge-coordinator:baseline-remediation-suppressed-event-log"
      );
      return { action: "suppressed_redundant", createdTask: false, fingerprint };
    }
    const failedGateReason = failure.reason.trim().slice(0, 1200) || "Unknown quality gate failure";
    const failedGateOutputSnippet =
      toQualityGateOutputSnippet(failure.outputSnippet ?? failure.output) ?? null;
    const result = await selfImprovementService.ensureBaselineQualityGateTask(projectId, {
      baseBranch,
      command: failure.command,
      reason: failedGateReason,
      outputSnippet: failedGateOutputSnippet,
      firstErrorLine: failure.firstErrorLine ?? null,
      worktreePath:
        failure.validationWorkspace === "baseline" ? null : (failure.worktreePath ?? null),
      validationWorkspace: failure.validationWorkspace ?? null,
    });
    const cacheKey = this.baselineCacheKey(projectId, baseBranch);
    this.baselineRemediationSuppression.set(cacheKey, { fingerprint, observedAtMs: Date.now() });
    fireAndForget(
      eventLogService.append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: result.taskId,
        event: "baseline.remediation_task",
        data: {
          action: result.action,
          created: result.created,
          baseBranch,
          fingerprint,
          command: failure.command,
          category: failure.category ?? null,
          validationWorkspace: failure.validationWorkspace ?? null,
        },
      }),
      "merge-coordinator:baseline-remediation-task-event-log"
    );
    return { action: result.action, createdTask: result.created, fingerprint };
  }

  private async releaseMergeSlot(
    projectId: string,
    repoPath: string,
    outcome: "complete" | "fail",
    taskId: string
  ): Promise<void> {
    const state = this.host.getState(projectId);
    if (!state.slots.has(taskId)) {
      return;
    }
    await this.host.taskStore
      .update(projectId, taskId, {
        extra: {
          [MERGE_ATTEMPT_LEASE_EXPIRES_AT_KEY]: null,
          [MERGE_ATTEMPT_LEASE_ACQUIRED_AT_KEY]: null,
          [MERGE_ATTEMPT_LEASE_OWNER_KEY]: null,
        },
      })
      .catch((err) => {
        log.warn("Failed to clear merge attempt lease before slot release", {
          projectId,
          taskId,
          err,
        });
      });
    this.host.transition(projectId, { to: outcome, taskId });
    await this.host.persistCounters(projectId, repoPath);
  }

  /**
   * Tasks that are implementation work under an epic (exclude epic itself and .0 placeholder IDs).
   * Used to decide when all work in an epic is closed for merge/final-review.
   */
  private getEpicImplementationTasks(allIssues: StoredTask[], epicId: string): StoredTask[] {
    return allIssues.filter(
      (i) =>
        i.id.startsWith(epicId + ".") &&
        !i.id.endsWith(".0") &&
        (i.issue_type ?? (i as { type?: string }).type) !== "epic"
    );
  }

  /**
   * Close task, record attempt, create/archive session, record actual files, eventLog, broadcast,
   * checkAutoResolveOnTaskDone, and release merge slot. Shared by per_epic intermediate and per_task paths.
   */
  private async closeTaskRecordAndReleaseSlot(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    baseBranch: string,
    wtPath: string,
    slot: MergeSlot,
    settings: Awaited<ReturnType<MergeCoordinatorHost["projectService"]["getSettings"]>>
  ): Promise<void> {
    const closeReason = slot.phaseResult.codingSummary || "Implemented and tested";
    await this.host.taskStore.close(projectId, task.id, closeReason);

    const agentConfig = settings.simpleComplexityAgent;
    agentIdentityService
      .recordAttempt(repoPath, {
        taskId: task.id,
        agentId: buildAgentAttemptId(agentConfig, "coder"),
        role: "coder",
        model: agentConfig.model ?? "unknown",
        attempt: slot.attempt,
        startedAt: slot.agent.startedAt,
        completedAt: new Date().toISOString(),
        outcome: "success",
        durationMs: Date.now() - new Date(slot.agent.startedAt).getTime(),
      })
      .catch((err) => log.warn("Failed to record attempt", { err }));

    const session = await this.host.sessionManager.createSession(repoPath, {
      taskId: task.id,
      attempt: slot.attempt,
      agentType: agentConfig.type,
      agentModel: agentConfig.model || "",
      gitBranch: branchName,
      status: "approved",
      outputLog: slot.agent.outputLog.join(""),
      gitDiff: slot.phaseResult.codingDiff,
      summary: slot.phaseResult.codingSummary || undefined,
      testResults: slot.phaseResult.testResults ?? undefined,
      startedAt: slot.agent.startedAt,
    });
    await this.host.sessionManager.archiveSession(repoPath, task.id, slot.attempt, session, wtPath);

    try {
      const changedFiles = await this.host.branchManager.getChangedFiles(
        repoPath,
        branchName,
        baseBranch
      );
      await this.host.fileScopeAnalyzer.recordActual(
        projectId,
        repoPath,
        task.id,
        changedFiles,
        this.host.taskStore
      );
    } catch {
      // best-effort
    }

    fireAndForget(
      eventLogService.append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: "task.completed",
        data: { attempt: slot.attempt },
      }),
      "merge-coordinator:task-completed-event-log"
    );

    broadcastToProject(projectId, {
      type: "agent.completed",
      taskId: task.id,
      status: "approved",
      testResults: slot.phaseResult.testResults,
    });

    await this.host.feedbackService.checkAutoResolveOnTaskDone(projectId, task.id).catch((err) => {
      log.warn("Auto-resolve feedback on task done failed", { taskId: task.id, err });
    });

    await this.releaseMergeSlot(projectId, repoPath, "complete", task.id);
  }

  /**
   * Merge to main, then close task, archive session, clean up.
   * Merge happens FIRST — task is only closed after a successful merge.
   * On conflict: aborts merge and requeues task (branch preserved for next run).
   */
  async performMergeAndDone(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    retainedCandidate?: { worktreePath: string; branchName: string }
  ): Promise<void> {
    log.info("Starting merge and done flow", { taskId: task.id, branchName });
    const state = this.host.getState(projectId);
    const slot = state.slots.get(task.id);
    const mergeFlowKey = `${projectId}:${task.id}:${slot?.attempt ?? 0}`;
    if (this.inFlightMergeFlows.has(mergeFlowKey)) {
      log.warn("Suppressing duplicate merge flow invocation", {
        projectId,
        taskId: task.id,
        attempt: slot?.attempt ?? 0,
        branchName,
      });
      this.traceMergeLifecycle(
        "duplicate_flow_suppressed",
        projectId,
        task.id,
        { branchName },
        { attempt: slot?.attempt }
      );
      return;
    }
    this.inFlightMergeFlows.add(mergeFlowKey);
    try {
      this.traceMergeLifecycle(
        "flow_start",
        projectId,
        task.id,
        { branchName, repoPath },
        { attempt: slot?.attempt, mirrorToCrashLog: true }
      );
      if (!slot) {
        log.warn("performMergeAndDone: no slot found for task", { taskId: task.id });
        this.traceMergeLifecycle(
          "missing_slot",
          projectId,
          task.id,
          { branchName },
          { mirrorToCrashLog: true }
        );
        try {
          await this.host.taskStore.update(projectId, task.id, {
            status: "open",
            assignee: "",
          });
        } catch (err) {
          log.warn("performMergeAndDone: failed to requeue task after missing slot", {
            taskId: task.id,
            err,
          });
        }
        await broadcastAuthoritativeTaskUpdated(broadcastToProject, projectId, task.id);
        this.host.nudge(projectId);
        return;
      }
      const wtPath = slot.worktreePath ?? repoPath;

      if (wtPath !== repoPath) {
        const integrity = await assertWorktreeIntegrity(repoPath, wtPath, task.id, "merge");
        if (!integrity.valid) {
          log.error("Worktree integrity check failed before merge", {
            taskId: task.id,
            phase: integrity.phase,
            failureReason: integrity.failureReason,
            detail: integrity.detail,
            worktreePath: wtPath,
          });
          appendRuntimeTrace("merge.worktree_integrity_failed", task.id, {
            detail: integrity.detail ?? "unknown",
            failureReason: integrity.failureReason,
            worktreePath: wtPath,
          });
          this.traceMergeLifecycle(
            "worktree_integrity_failed",
            projectId,
            task.id,
            { branchName, worktreePath: wtPath, failureReason: integrity.failureReason },
            { mirrorToCrashLog: true }
          );
          try {
            await this.host.taskStore.update(projectId, task.id, {
              status: "open",
              assignee: "",
              extra: {
                last_merge_failure_reason: "workspace_invalid",
                worktree_integrity_detail: integrity.detail ?? "unknown",
              },
            });
          } catch (err) {
            log.warn("performMergeAndDone: failed to requeue task after integrity failure", {
              taskId: task.id,
              err,
            });
          }
          await this.releaseMergeSlot(projectId, repoPath, "fail", task.id);
          await broadcastAuthoritativeTaskUpdated(broadcastToProject, projectId, task.id);
          this.host.nudge(projectId);
          return;
        }
      }

      // 1. Prepare: commit any WIP, then wait for any in-flight push to finish
      await this.host.branchManager.waitForGitReady(wtPath);
      await this.host.branchManager.commitWip(wtPath, task.id);
      await this.waitForPushComplete(projectId);
      const settings = await this.host.projectService.getSettings(projectId);
      const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
      const governanceInactive = await governanceService.isGovernanceInactive(projectId);
      if (!governanceInactive && settings.deliveryMode === "pull_request") {
        governanceError(PR_GOVERNANCE_INCOMPATIBLE, GOVERNANCE_INVALID_INPUT);
      }
      if (!governanceInactive) {
        const pin = await governanceService.getTaskPin(projectId, task.id);
        const code = pin
          ? await governanceCodeSnapshot(wtPath, pin.baseSha, "HEAD", false, pin.baseBranch)
          : await governanceBranchPathSnapshot(wtPath, baseBranch);
        await governanceExecutionService.assertScope(projectId, task.id, code.changedPaths);
        await governanceService.assertMergeAdmission({ projectId, taskId: task.id, ...code });
      }
      const mergeStrategy = getEffectiveMergeStrategy(settings);
      const allIssuesForEpic = await this.host.taskStore.listAll(projectId);
      const epicId = resolveEpicId(task.id, allIssuesForEpic);

      if (settings.deliveryMode === "pull_request") {
        const implTasks = epicId
          ? this.getEpicImplementationTasks(allIssuesForEpic, epicId)
          : [task];
        const planFinished =
          implTasks.length > 0 && implTasks.every((i) => i.id === task.id || i.status === "closed");
        try {
          // Old per-task branches can still be active when delivery mode changes. Fail safely
          // rather than publishing a partial plan or merging its code into the base branch.
          if (epicId && branchName !== `opensprint/epic_${epicId}`) {
            throw new Error(
              "PR delivery requires a shared plan branch. Retry this task to prepare the plan branch."
            );
          }
          if (!retainedCandidate)
            await this.ensureMergeQualityGates({
              projectId,
              repoPath,
              worktreePath: wtPath,
              taskId: task.id,
              branchName,
              baseBranch,
              validationWorkspace: "task_worktree",
              toolchainProfile: settings.toolchainProfile,
            });
          if (planFinished) {
            const epic = allIssuesForEpic.find((i) => i.id === epicId);
            const url = await withUngovernedPullRequestDelivery(projectId, () =>
              publishPlanPullRequest({
                repoPath,
                branchName,
                baseBranch,
                title: epic?.title || task.title || task.id,
                taskIds: implTasks.map((i) => i.id),
              })
            );
            await this.host.taskStore.update(projectId, epicId ?? task.id, {
              extra: {
                pull_request_url: url,
                delivery_branch: branchName,
                worktree_base_branch: baseBranch,
                final_review_pending: true,
              },
            });
            const plan = epicId
              ? await this.host.taskStore.planGetByEpicId(projectId, epicId)
              : null;
            if (plan) {
              await this.host.taskStore.planUpdateMetadata(projectId, plan.plan_id, {
                ...plan.metadata,
                pullRequestUrl: url,
              });
              broadcastToProject(projectId, { type: "plan.updated", planId: plan.plan_id });
            }
            await eventLogService.append(repoPath, {
              timestamp: new Date().toISOString(),
              projectId,
              taskId: task.id,
              event: "task.pull_request_created",
              data: { url, branchName, baseBranch },
            });
          }
        } catch (err) {
          await this.requeueTaskAfterMergeFailure(projectId, repoPath, task, err as Error);
          return;
        }
        await this.closeTaskRecordAndReleaseSlot(
          projectId,
          repoPath,
          task,
          branchName,
          baseBranch,
          wtPath,
          slot,
          settings
        );
        if (planFinished && epicId) {
          try {
            await reviewPublishedPlanPullRequest({
              projectId,
              epicId,
              worktreePath: wtPath,
              taskStore: this.host.taskStore,
            });
          } catch (err) {
            log.warn("Final review after PR publication failed", { projectId, epicId, err });
          }
        }
        this.host.nudge(projectId);
        return;
      }

      const isPerEpicIntermediate = mergeStrategy === "per_epic" && epicId != null;

      if (isPerEpicIntermediate) {
        // per_epic + epic task: do not merge to main; close task, record, archive, release slot
        await this.closeTaskRecordAndReleaseSlot(
          projectId,
          repoPath,
          task,
          branchName,
          baseBranch,
          wtPath,
          slot,
          settings
        );
        this.host.nudge(projectId);

        // Check if all implementation tasks in epic are closed; if not, return (next task uses same epic worktree)
        const freshIssues = await this.host.taskStore.listAll(projectId);
        const implTasks = this.getEpicImplementationTasks(freshIssues, epicId);
        const allImplClosed =
          implTasks.length > 0 && implTasks.every((i) => (i.status as string) === "closed");

        if (!allImplClosed) {
          return;
        }

        // Last task in epic: merge epic branch to main, then push and cleanup via postCompletionAsync
        try {
          this.traceMergeLifecycle(
            "attempt_start",
            projectId,
            task.id,
            {
              mode: "per_epic_final_merge",
              branchName,
              baseBranch,
              wtPath,
            },
            { attempt: slot.attempt, mirrorToCrashLog: true }
          );
          if (
            await this.deferMergeValidationWhileDegraded(projectId, repoPath, task, slot, wtPath)
          ) {
            return;
          }
          if (!this.isBaselineQualityGateRemediationTask(task, baseBranch)) {
            const baselineFailure = await this.getBaselineQualityGateFailure(
              projectId,
              repoPath,
              baseBranch,
              { source: "merge_precheck" }
            );
            if (baselineFailure) {
              await this.createBaselineQualityGateRemediationTask(
                repoPath,
                projectId,
                baseBranch,
                baselineFailure
              );
              await this.pauseMergeForBaselineQualityGateFailure(
                projectId,
                repoPath,
                task,
                baseBranch,
                baselineFailure,
                wtPath
              );
              await this.releaseMergeSlot(projectId, repoPath, "fail", task.id);
              this.host.nudge(projectId);
              return;
            }
          } else {
            log.info("Skipping baseline-on-main precheck for baseline remediation task", {
              taskId: task.id,
              baseBranch,
            });
          }
          if (!retainedCandidate)
            await this.ensureMergeQualityGates({
              projectId,
              repoPath,
              worktreePath: wtPath,
              taskId: task.id,
              branchName,
              baseBranch,
              validationWorkspace: "task_worktree",
              toolchainProfile: settings.toolchainProfile,
            });
          this.traceMergeLifecycle(
            "quality_gates_passed",
            projectId,
            task.id,
            { mode: "per_epic_final_merge", branchName, baseBranch, wtPath },
            { attempt: slot.attempt }
          );
          await gitCommitQueue.drain();
          this.traceMergeLifecycle(
            "queue_merge_begin",
            projectId,
            task.id,
            { mode: "per_epic_final_merge", branchName, baseBranch },
            { attempt: slot.attempt }
          );
          await gitCommitQueue.enqueueAndWait({
            type: "worktree_merge",
            projectId,
            repoPath,
            worktreePath: wtPath,
            branchName,
            taskId: task.id,
            taskTitle: task.title || task.id,
            baseBranch,
            qualityGateProfile: DETERMINISTIC_MERGE_GATE_PROFILE,
            runQualityGates: this.host.runMergeQualityGates?.bind(this.host),
            retainedCandidate,
          });
          this.traceMergeLifecycle(
            "queue_merge_succeeded",
            projectId,
            task.id,
            { mode: "per_epic_final_merge", branchName, baseBranch },
            { attempt: slot.attempt, mirrorToCrashLog: true }
          );
          await this.markMergeValidationHealthy(projectId, repoPath);
          await this.reconcileDependenciesAfterMerge(repoPath, task.id);
          this.invalidateBaselineCacheAfterMerge(projectId, baseBranch);
        } catch (mergeErr) {
          log.warn("Merge epic to main failed", { taskId: task.id, branchName, mergeErr });
          this.traceMergeLifecycle(
            "attempt_failed",
            projectId,
            task.id,
            {
              mode: "per_epic_final_merge",
              branchName,
              baseBranch,
              err:
                mergeErr instanceof Error
                  ? { name: mergeErr.name, message: mergeErr.message, stack: mergeErr.stack }
                  : String(mergeErr),
            },
            { attempt: slot.attempt, mirrorToCrashLog: true }
          );
          await this.requeueTaskAfterMergeFailure(projectId, repoPath, task, mergeErr as Error);
          return;
        }

        await this.registerPendingCleanup(projectId, repoPath, {
          taskId: task.id,
          branchName,
          worktreePath: wtPath,
          gitWorkingMode: settings.gitWorkingMode === "branches" ? "branches" : "worktree",
          worktreeKey: slot.worktreeKey,
        });
        this.host.nudge(projectId);
        this.postCompletionAsync(projectId, repoPath, task.id, { mergedToMain: true }).catch(
          (err) => {
            log.warn("Post-completion async work failed", { taskId: task.id, err });
          }
        );
        return;
      }

      // 2. Attempt merge inside the serialized queue. Rebase now happens there.
      try {
        this.traceMergeLifecycle(
          "attempt_start",
          projectId,
          task.id,
          { mode: "per_task_merge", branchName, baseBranch, wtPath },
          { attempt: slot.attempt, mirrorToCrashLog: true }
        );
        if (await this.deferMergeValidationWhileDegraded(projectId, repoPath, task, slot, wtPath)) {
          return;
        }
        if (!this.isBaselineQualityGateRemediationTask(task, baseBranch)) {
          const baselineFailure = await this.getBaselineQualityGateFailure(
            projectId,
            repoPath,
            baseBranch,
            { source: "merge_precheck" }
          );
          if (baselineFailure) {
            await this.createBaselineQualityGateRemediationTask(
              repoPath,
              projectId,
              baseBranch,
              baselineFailure
            );
            await this.pauseMergeForBaselineQualityGateFailure(
              projectId,
              repoPath,
              task,
              baseBranch,
              baselineFailure,
              wtPath
            );
            await this.releaseMergeSlot(projectId, repoPath, "fail", task.id);
            this.host.nudge(projectId);
            return;
          }
        } else {
          log.info("Skipping baseline-on-main precheck for baseline remediation task", {
            taskId: task.id,
            baseBranch,
          });
        }
        if (!retainedCandidate)
          await this.ensureMergeQualityGates({
            projectId,
            repoPath,
            worktreePath: wtPath,
            taskId: task.id,
            branchName,
            baseBranch,
            validationWorkspace: "task_worktree",
            toolchainProfile: settings.toolchainProfile,
          });
        this.traceMergeLifecycle(
          "quality_gates_passed",
          projectId,
          task.id,
          { mode: "per_task_merge", branchName, baseBranch, wtPath },
          { attempt: slot.attempt }
        );
        await gitCommitQueue.drain();
        this.traceMergeLifecycle(
          "queue_merge_begin",
          projectId,
          task.id,
          { mode: "per_task_merge", branchName, baseBranch },
          { attempt: slot.attempt }
        );
        await gitCommitQueue.enqueueAndWait({
          type: "worktree_merge",
          projectId,
          repoPath,
          worktreePath: wtPath,
          branchName,
          taskId: task.id,
          taskTitle: task.title || task.id,
          baseBranch,
          qualityGateProfile: DETERMINISTIC_MERGE_GATE_PROFILE,
          runQualityGates: this.host.runMergeQualityGates?.bind(this.host),
          retainedCandidate,
        });
        this.traceMergeLifecycle(
          "queue_merge_succeeded",
          projectId,
          task.id,
          { mode: "per_task_merge", branchName, baseBranch },
          { attempt: slot.attempt, mirrorToCrashLog: true }
        );
        await this.markMergeValidationHealthy(projectId, repoPath);
        await this.reconcileDependenciesAfterMerge(repoPath, task.id);
        this.invalidateBaselineCacheAfterMerge(projectId, baseBranch);
      } catch (mergeErr) {
        log.warn("Merge to main failed", { taskId: task.id, branchName, mergeErr });
        this.traceMergeLifecycle(
          "attempt_failed",
          projectId,
          task.id,
          {
            mode: "per_task_merge",
            branchName,
            baseBranch,
            err:
              mergeErr instanceof Error
                ? { name: mergeErr.name, message: mergeErr.message, stack: mergeErr.stack }
                : String(mergeErr),
          },
          { attempt: slot.attempt, mirrorToCrashLog: true }
        );
        await this.requeueTaskAfterMergeFailure(projectId, repoPath, task, mergeErr as Error);
        return;
      }

      // 4. Merge succeeded — close task, record, archive, release slot; then register cleanup and post-completion
      await this.registerPendingCleanup(projectId, repoPath, {
        taskId: task.id,
        branchName,
        worktreePath: wtPath,
        gitWorkingMode: settings.gitWorkingMode === "branches" ? "branches" : "worktree",
        worktreeKey: slot.worktreeKey,
      });
      await this.closeTaskRecordAndReleaseSlot(
        projectId,
        repoPath,
        task,
        branchName,
        baseBranch,
        wtPath,
        slot,
        settings
      );
      this.traceMergeLifecycle(
        "flow_complete",
        projectId,
        task.id,
        { branchName, baseBranch },
        { attempt: slot.attempt, mirrorToCrashLog: true }
      );

      // 5. Async push + post-completion
      this.host.nudge(projectId);

      this.postCompletionAsync(projectId, repoPath, task.id, { mergedToMain: true }).catch(
        (err) => {
          log.warn("Post-completion async work failed", { taskId: task.id, err });
        }
      );
    } finally {
      this.inFlightMergeFlows.delete(mergeFlowKey);
    }
  }

  /**
   * Handle merge failure: abort any in-progress merge, archive session (so output is visible),
   * track attempts, requeue or block. Branch is preserved so the next agent run can rebase and retry.
   */
  private async requeueTaskAfterMergeFailure(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    mergeErr: Error
  ): Promise<void> {
    const slot = this.host.getState(projectId).slots.get(task.id);
    const retainedFailure = getQualityGateFailureDetailsFromMergeError(mergeErr);
    if (retainedFailure?.preserveWork || retainedFailure?.recoveryIncidentId) {
      // This is suspended validation of completed code, not a new coding attempt.
      if (slot?.agent.cancelled) return;
      const fresh = await this.host.taskStore.show(projectId, task.id);
      if (
        fresh.status !== "in_progress" ||
        this.host.getState(projectId).slots.get(task.id) !== slot
      )
        return;
      try {
        await this.host.taskStore.update(projectId, task.id, {
          status: "blocked",
          expectedStatus: "in_progress",
          assignee: "",
          block_reason: "Local validation recovery",
        });
      } catch (error) {
        if ((error as { code?: string }).code === ErrorCodes.TASK_STATE_CHANGED) return;
        throw error;
      }
      if (slot?.agent.cancelled || this.host.getState(projectId).slots.get(task.id) !== slot)
        return;
      if (this.host.suspendLocalValidation) this.host.suspendLocalValidation(projectId, task.id);
      else this.host.getState(projectId).slots.delete(task.id);
      this.host.nudge(projectId);
      return;
    }
    const failedBranchName = slot?.branchName ?? `opensprint/${task.id}`;
    const stage =
      mergeErr instanceof MergeJobError
        ? mergeErr.stage
        : mergeErr instanceof RebaseContinueBlockedError
          ? (mergeErr.mergeFailureStage ?? "merge_to_main")
          : mergeErr instanceof RebaseConflictError
            ? "push_rebase"
            : "merge_to_main";
    const normalizedStage = stage as MergeFailureStage;
    const humanFailureMessage = this.getHumanFailureMessage(normalizedStage);
    const isQualityGateFailure = normalizedStage === "quality_gate";
    const conflictedFiles =
      mergeErr instanceof MergeJobError
        ? mergeErr.conflictedFiles
        : mergeErr instanceof RebaseConflictError
          ? mergeErr.conflictedFiles
          : mergeErr instanceof RebaseContinueBlockedError
            ? mergeErr.diagnostics.conflictedFiles
            : [];
    const rebaseContinueDiagnostics =
      mergeErr instanceof MergeJobError
        ? mergeErr.rebaseContinueDiagnostics
        : mergeErr instanceof RebaseContinueBlockedError
          ? mergeErr.diagnostics
          : undefined;
    if (await this.host.branchManager.isMergeInProgress(repoPath)) {
      await this.host.branchManager.mergeAbort(repoPath);
    }

    // Archive session so task detail sidebar can show agent output when task is blocked/failed
    try {
      const state = this.host.getState(projectId);
      const slot = state.slots.get(task.id);
      if (slot) {
        const settings = await this.host.projectService.getSettings(projectId);
        const agentConfig = settings.simpleComplexityAgent;
        const wtPath = slot.worktreePath ?? repoPath;
        const session = await this.host.sessionManager.createSession(repoPath, {
          taskId: task.id,
          attempt: slot.attempt,
          agentType: agentConfig.type,
          agentModel: agentConfig.model || "",
          gitBranch: slot.branchName,
          status: "failed",
          outputLog: slot.agent.outputLog.join(""),
          failureReason: humanFailureMessage,
          startedAt: slot.agent.startedAt,
        });
        await this.host.sessionManager.archiveSession(
          repoPath,
          task.id,
          slot.attempt,
          session,
          wtPath
        );
      }
    } catch (archiveErr) {
      log.warn("Failed to archive session on merge failure", { taskId: task.id, archiveErr });
    }

    let shouldNudge = false;
    try {
      if (isPublicationLeaseContention(mergeErr)) {
        // Another publication owned the lease; the code was never judged, so spend no attempt.
        await this.host.taskStore.update(projectId, task.id, {
          status: "open",
          assignee: "",
          extra: { [NEXT_RETRY_CONTEXT_KEY]: null },
        });
        shouldNudge = true;
        return;
      }
      const freshIssue = await this.host.taskStore.show(projectId, task.id);
      const cumulativeAttempts = this.host.taskStore.getCumulativeAttemptsFromIssue(freshIssue) + 1;
      await this.host.taskStore.setCumulativeAttempts(projectId, task.id, cumulativeAttempts);
      await this.host.taskStore.setConflictFiles(projectId, task.id, conflictedFiles);
      await this.host.taskStore.setMergeStage(projectId, task.id, normalizedStage);
      const scopeConfidence = this.getScopeConfidence(freshIssue);
      const unknownScopeStrategy =
        (await this.host.projectService.getSettings(projectId)).unknownScopeStrategy ??
        "optimistic";
      const mergeFailureReason = mergeErr.message?.slice(0, 500) ?? "Merge failed";
      const stageLabel = isQualityGateFailure ? "quality-gate" : "merge";
      const qualityGateFailureDetails = getQualityGateFailureDetailsFromMergeError(mergeErr);
      const qualityGateStructuredDetails = buildQualityGateStructuredDetails(
        qualityGateFailureDetails,
        slot?.worktreePath ?? repoPath,
        isQualityGateFailure
          ? {
              reason: mergeFailureReason,
              firstErrorLine: mergeFailureReason,
              category: "quality_gate",
            }
          : undefined
      );
      const isEnvironmentSetupQualityGateFailure =
        isQualityGateFailure && isEnvironmentSetupQualityGateMergeError(mergeErr);
      const environmentSetupRemediation = isEnvironmentSetupQualityGateFailure
        ? buildEnvironmentSetupRemediationMessage({
            command:
              qualityGateStructuredDetails.failedGateCommand ??
              qualityGateFailureDetails?.command ??
              null,
            worktreePath: qualityGateStructuredDetails.worktreePath,
            validationWorkspace:
              qualityGateStructuredDetails.qualityGateValidationWorkspace ??
              qualityGateFailureDetails?.validationWorkspace ??
              null,
          })
        : null;
      const qualityGateSummaryDetail = isQualityGateFailure
        ? buildQualityGateSummaryDetailFromMergeError(mergeErr)
        : null;
      const qualityGateSummarySuffix = qualityGateSummaryDetail
        ? ` (${qualityGateSummaryDetail})`
        : "";
      const qualityGateCommentDetail = qualityGateSummaryDetail
        ? ` Details: ${qualityGateSummaryDetail}.`
        : "";
      const retryContext = this.buildRetryContextForMergeFailure(
        normalizedStage,
        mergeFailureReason,
        isEnvironmentSetupQualityGateFailure ? "environment_setup" : undefined,
        qualityGateStructuredDetails.qualityGateDetail
      );

      const failureFingerprint = buildFailureFingerprint(
        mergeFailureReason,
        normalizedStage,
        failedBranchName,
        qualityGateFailureDetails?.category
      );
      log.info("Merge failure fingerprint", {
        taskId: task.id,
        fingerprintHash: failureFingerprint.hash,
        failureClass: failureFingerprint.failureClass,
        normalizedMessage: failureFingerprint.normalizedMessage,
        phase: failureFingerprint.phase,
      });
      appendRuntimeTrace("merge.failure_fingerprint", task.id, {
        hash: failureFingerprint.hash,
        failureClass: failureFingerprint.failureClass,
        normalizedMessage: failureFingerprint.normalizedMessage,
        phase: failureFingerprint.phase,
        branch: failureFingerprint.branch,
      });
      if (rebaseContinueDiagnostics) {
        log.info("merge.rebase_continue_blocked", {
          taskId: task.id,
          cause: rebaseContinueDiagnostics.cause,
          rebaseMetadataPresent: rebaseContinueDiagnostics.rebaseMetadataPresent,
          conflictedFiles: rebaseContinueDiagnostics.conflictedFiles,
        });
        appendRuntimeTrace("merge.rebase_continue_blocked", task.id, {
          cause: rebaseContinueDiagnostics.cause,
          rebaseMetadataPresent: rebaseContinueDiagnostics.rebaseMetadataPresent,
          conflictedFiles: rebaseContinueDiagnostics.conflictedFiles,
        });
      }

      const mergeBlockReason = this.getMergeFailureBlockReason(normalizedStage);
      const mergeFailureType = this.getMergeFailureType(
        normalizedStage,
        isEnvironmentSetupQualityGateFailure ? "environment_setup" : undefined
      );
      if (isQualityGateFailure) {
        if (isEnvironmentSetupQualityGateFailure) {
          await this.recordMergeValidationEnvironmentFailure(
            projectId,
            repoPath,
            this.buildMergeValidationHealthSummary({
              command:
                qualityGateStructuredDetails.failedGateCommand ??
                qualityGateFailureDetails?.command ??
                null,
              firstErrorLine:
                qualityGateStructuredDetails.qualityGateDetail?.firstErrorLine ??
                qualityGateFailureDetails?.firstErrorLine ??
                null,
              reason:
                qualityGateStructuredDetails.failedGateReason ??
                qualityGateFailureDetails?.reason ??
                mergeFailureReason,
              remediation: environmentSetupRemediation,
            })
          );
        } else {
          await this.markMergeValidationHealthy(projectId, repoPath);
        }
      }

      const previousFingerprint = (freshIssue?.extra as Record<string, unknown> | undefined)
        ?.lastFailureFingerprint as string | undefined;
      const infraFingerprintRepeated =
        failureFingerprint.failureClass === "environment_setup" &&
        previousFingerprint === failureFingerprint.hash;

      if (infraFingerprintRepeated) {
        log.warn("Retry circuit breaker tripped: identical infra fingerprint repeated", {
          taskId: task.id,
          fingerprintHash: failureFingerprint.hash,
          normalizedMessage: failureFingerprint.normalizedMessage,
          attempt: cumulativeAttempts,
        });
        appendRuntimeTrace("merge.circuit_breaker_tripped", task.id, {
          hash: failureFingerprint.hash,
          failureClass: failureFingerprint.failureClass,
          normalizedMessage: failureFingerprint.normalizedMessage,
          attempt: cumulativeAttempts,
        });
      }

      const maxMergeFailures = BACKOFF_FAILURE_THRESHOLD * 2;
      const shouldBypassMergeFailureAutoBlock =
        unknownScopeStrategy === "optimistic" &&
        (normalizedStage === "rebase_before_merge" || normalizedStage === "merge_to_main");
      const reachedEnvironmentSetupFailureLimit =
        isEnvironmentSetupQualityGateFailure &&
        cumulativeAttempts >= MAX_ENVIRONMENT_SETUP_QUALITY_GATE_ATTEMPTS;
      if (
        infraFingerprintRepeated ||
        reachedEnvironmentSetupFailureLimit ||
        (!shouldBypassMergeFailureAutoBlock && cumulativeAttempts >= maxMergeFailures)
      ) {
        const blockedNextAction = environmentSetupRemediation ?? "Blocked pending investigation";
        log.info(`Blocking ${task.id} after ${cumulativeAttempts} ${stageLabel} failures`);
        const blockedSummary = buildTaskLastExecutionSummary({
          attempt: cumulativeAttempts,
          outcome: "blocked",
          phase: "merge",
          failureType: mergeFailureType,
          blockReason: mergeBlockReason,
          summary: compactExecutionText(
            `Attempt ${cumulativeAttempts} ${stageLabel} failed: ${humanFailureMessage}${qualityGateSummarySuffix}${environmentSetupRemediation ? ` | remediation: ${environmentSetupRemediation}` : ""}`,
            500
          ),
        });
        await this.host.taskStore.update(projectId, task.id, {
          status: "blocked",
          assignee: "",
          block_reason: mergeBlockReason,
          extra: {
            last_execution_summary: blockedSummary,
            [NEXT_RETRY_CONTEXT_KEY]: retryContext,
            failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
            failedGateReason: qualityGateStructuredDetails.failedGateReason,
            failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
            worktreePath: qualityGateStructuredDetails.worktreePath,
            qualityGateCategory: qualityGateStructuredDetails.qualityGateCategory,
            qualityGateValidationWorkspace:
              qualityGateStructuredDetails.qualityGateValidationWorkspace,
            qualityGateAutoRepairAttempted: qualityGateStructuredDetails.qualityGateRepairAttempted,
            qualityGateAutoRepairSucceeded: qualityGateStructuredDetails.qualityGateRepairSucceeded,
            qualityGateExecutable: qualityGateStructuredDetails.qualityGateExecutable,
            qualityGateCwd: qualityGateStructuredDetails.qualityGateCwd,
            qualityGateExitCode: qualityGateStructuredDetails.qualityGateExitCode,
            qualityGateSignal: qualityGateStructuredDetails.qualityGateSignal,
            qualityGateClassificationConfidence:
              qualityGateStructuredDetails.qualityGateClassificationConfidence,
            qualityGateClassificationReason:
              qualityGateStructuredDetails.qualityGateClassificationReason,
            qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
            lastFailureFingerprint: failureFingerprint.hash,
            lastFailureClass: failureFingerprint.failureClass,
            ...(rebaseContinueDiagnostics ? { rebaseContinueDiagnostics } : {}),
          },
        });
        await this.host.taskStore.comment(
          projectId,
          task.id,
          isQualityGateFailure
            ? isEnvironmentSetupQualityGateFailure
              ? `Blocked after ${cumulativeAttempts} consecutive environment-setup quality-gate failures. ${humanFailureMessage}${qualityGateCommentDetail} Remediation: ${environmentSetupRemediation}`
              : `Blocked after ${cumulativeAttempts} consecutive quality-gate failures. ${humanFailureMessage}${qualityGateCommentDetail}`
            : `Blocked after ${cumulativeAttempts} consecutive merge failures. ${humanFailureMessage}`
        );
        broadcastToProject(projectId, {
          type: "task.blocked",
          taskId: task.id,
          reason: infraFingerprintRepeated
            ? `Circuit breaker: repeated identical infrastructure failure (${failureFingerprint.failureClass})`
            : isQualityGateFailure
              ? isEnvironmentSetupQualityGateFailure
                ? `Blocked after ${cumulativeAttempts} environment-setup quality-gate failures`
                : `Blocked after ${cumulativeAttempts} quality-gate failures`
              : `Blocked after ${cumulativeAttempts} merge failures`,
          cumulativeAttempts,
          qualityGateDetail: qualityGateStructuredDetails?.qualityGateDetail ?? null,
          failedGateCommand: qualityGateStructuredDetails?.failedGateCommand ?? null,
          failedGateReason: qualityGateStructuredDetails?.failedGateReason ?? null,
          failedGateOutputSnippet: qualityGateStructuredDetails?.failedGateOutputSnippet ?? null,
          worktreePath: qualityGateStructuredDetails?.worktreePath ?? null,
          failureClass: failureFingerprint.failureClass,
          failureFingerprint: failureFingerprint.hash,
          circuitBreakerTripped: infraFingerprintRepeated,
        } as ServerEvent);
        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "merge.failed",
            data: {
              reason: mergeFailureReason,
              stage: normalizedStage,
              failureType: mergeFailureType,
              branchName: failedBranchName,
              conflictedFiles,
              attempt: cumulativeAttempts,
              resolvedBy: "blocked",
              policyDecision: "block",
              blockReason: mergeBlockReason,
              scopeConfidence,
              summary: blockedSummary.summary,
              qualityGateCategory: qualityGateFailureDetails?.category ?? null,
              qualityGateValidationWorkspace:
                qualityGateFailureDetails?.validationWorkspace ?? null,
              qualityGateCommand: qualityGateFailureDetails?.command ?? null,
              qualityGateFirstErrorLine: qualityGateFailureDetails?.firstErrorLine ?? null,
              qualityGateAutoRepairAttempted:
                qualityGateFailureDetails?.autoRepairAttempted ?? false,
              qualityGateAutoRepairSucceeded:
                qualityGateFailureDetails?.autoRepairSucceeded ?? false,
              qualityGateAutoRepairCommands: qualityGateFailureDetails?.autoRepairCommands ?? [],
              qualityGateExecutable: qualityGateFailureDetails?.executable ?? null,
              qualityGateCwd: qualityGateFailureDetails?.cwd ?? null,
              qualityGateExitCode: qualityGateFailureDetails?.exitCode ?? null,
              qualityGateSignal: qualityGateFailureDetails?.signal ?? null,
              qualityGateClassificationConfidence:
                qualityGateFailureDetails?.classificationConfidence ?? null,
              qualityGateClassificationReason:
                qualityGateFailureDetails?.classificationReason ?? null,
              failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
              failedGateReason: qualityGateStructuredDetails.failedGateReason,
              failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
              worktreePath: qualityGateStructuredDetails.worktreePath,
              qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
              nextAction: blockedNextAction,
              failureClass: failureFingerprint.failureClass,
              failureFingerprint: failureFingerprint.hash,
              circuitBreakerTripped: infraFingerprintRepeated,
            },
          }),
          "merge-coordinator:merge-failed-blocked-event-log"
        );
        this.broadcastMergeFailureWs(projectId, task.id, {
          cumulativeAttempts,
          resolvedBy: "blocked",
          reason: mergeFailureReason,
          mergeStage: normalizedStage,
          qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
          failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
          failedGateReason: qualityGateStructuredDetails.failedGateReason,
          failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
          worktreePath: qualityGateStructuredDetails.worktreePath,
          failureClass: failureFingerprint.failureClass,
          failureFingerprint: failureFingerprint.hash,
          circuitBreakerTripped: infraFingerprintRepeated,
        });
        fireAndForget(
          eventLogService.append(repoPath, {
            timestamp: new Date().toISOString(),
            projectId,
            taskId: task.id,
            event: "task.blocked",
            data: {
              attempt: cumulativeAttempts,
              phase: "merge",
              failureType: mergeFailureType,
              policyDecision: "block",
              blockReason: mergeBlockReason,
              mergeStage: normalizedStage,
              conflictedFiles,
              summary: blockedSummary.summary,
              nextAction: blockedNextAction,
              failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
              failedGateReason: qualityGateStructuredDetails.failedGateReason,
              failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
              worktreePath: qualityGateStructuredDetails.worktreePath,
              qualityGateCategory: qualityGateStructuredDetails.qualityGateCategory,
              qualityGateValidationWorkspace:
                qualityGateStructuredDetails.qualityGateValidationWorkspace,
              qualityGateAutoRepairAttempted:
                qualityGateStructuredDetails.qualityGateRepairAttempted,
              qualityGateAutoRepairSucceeded:
                qualityGateStructuredDetails.qualityGateRepairSucceeded,
              qualityGateExecutable: qualityGateStructuredDetails.qualityGateExecutable,
              qualityGateCwd: qualityGateStructuredDetails.qualityGateCwd,
              qualityGateExitCode: qualityGateStructuredDetails.qualityGateExitCode,
              qualityGateSignal: qualityGateStructuredDetails.qualityGateSignal,
              qualityGateClassificationConfidence:
                qualityGateStructuredDetails.qualityGateClassificationConfidence,
              qualityGateClassificationReason:
                qualityGateStructuredDetails.qualityGateClassificationReason,
              qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
            },
          }),
          "merge-coordinator:task-blocked-event-log"
        );
        return;
      }

      log.info("Reopening task after merge failure", { taskId: task.id, cumulativeAttempts });
      const requeuedSummary = buildTaskLastExecutionSummary({
        attempt: cumulativeAttempts,
        outcome: "requeued",
        phase: "merge",
        failureType: mergeFailureType,
        summary: compactExecutionText(
          `Attempt ${cumulativeAttempts} ${stageLabel} failed: ${humanFailureMessage}${qualityGateSummarySuffix}`,
          500
        ),
      });
      await this.host.taskStore.update(projectId, task.id, {
        status: "open",
        assignee: "",
        extra: {
          last_execution_summary: requeuedSummary,
          [NEXT_RETRY_CONTEXT_KEY]: retryContext,
          failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
          failedGateReason: qualityGateStructuredDetails.failedGateReason,
          failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
          worktreePath: qualityGateStructuredDetails.worktreePath,
          qualityGateCategory: qualityGateStructuredDetails.qualityGateCategory,
          qualityGateValidationWorkspace:
            qualityGateStructuredDetails.qualityGateValidationWorkspace,
          qualityGateAutoRepairAttempted: qualityGateStructuredDetails.qualityGateRepairAttempted,
          qualityGateAutoRepairSucceeded: qualityGateStructuredDetails.qualityGateRepairSucceeded,
          qualityGateExecutable: qualityGateStructuredDetails.qualityGateExecutable,
          qualityGateCwd: qualityGateStructuredDetails.qualityGateCwd,
          qualityGateExitCode: qualityGateStructuredDetails.qualityGateExitCode,
          qualityGateSignal: qualityGateStructuredDetails.qualityGateSignal,
          qualityGateClassificationConfidence:
            qualityGateStructuredDetails.qualityGateClassificationConfidence,
          qualityGateClassificationReason:
            qualityGateStructuredDetails.qualityGateClassificationReason,
          qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
          lastFailureFingerprint: failureFingerprint.hash,
          lastFailureClass: failureFingerprint.failureClass,
          ...(rebaseContinueDiagnostics ? { rebaseContinueDiagnostics } : {}),
        },
      });
      await this.host.taskStore.setMergeStage(projectId, task.id, null);
      await this.host.taskStore.comment(
        projectId,
        task.id,
        isQualityGateFailure
          ? `Pre-merge quality gates failed. Task requeued — next run will retry after fixes. ${humanFailureMessage}${qualityGateCommentDetail}`
          : `Merge conflict with current main. Task requeued — next run will rebase and retry. ${humanFailureMessage}`
      );
      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: task.id,
          event: "merge.failed",
          data: {
            reason: mergeFailureReason,
            stage: normalizedStage,
            failureType: mergeFailureType,
            branchName: failedBranchName,
            conflictedFiles,
            attempt: cumulativeAttempts,
            resolvedBy: "requeued",
            policyDecision: "requeue",
            scopeConfidence,
            summary: requeuedSummary.summary,
            qualityGateCategory: qualityGateFailureDetails?.category ?? null,
            qualityGateValidationWorkspace: qualityGateFailureDetails?.validationWorkspace ?? null,
            qualityGateCommand: qualityGateFailureDetails?.command ?? null,
            qualityGateFirstErrorLine: qualityGateFailureDetails?.firstErrorLine ?? null,
            qualityGateAutoRepairAttempted: qualityGateFailureDetails?.autoRepairAttempted ?? false,
            qualityGateAutoRepairSucceeded: qualityGateFailureDetails?.autoRepairSucceeded ?? false,
            qualityGateAutoRepairCommands: qualityGateFailureDetails?.autoRepairCommands ?? [],
            qualityGateExecutable: qualityGateFailureDetails?.executable ?? null,
            qualityGateCwd: qualityGateFailureDetails?.cwd ?? null,
            qualityGateExitCode: qualityGateFailureDetails?.exitCode ?? null,
            qualityGateSignal: qualityGateFailureDetails?.signal ?? null,
            qualityGateClassificationConfidence:
              qualityGateFailureDetails?.classificationConfidence ?? null,
            qualityGateClassificationReason:
              qualityGateFailureDetails?.classificationReason ?? null,
            failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
            failedGateReason: qualityGateStructuredDetails.failedGateReason,
            failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
            worktreePath: qualityGateStructuredDetails.worktreePath,
            qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
            nextAction: "Requeued for retry",
          },
        }),
        "merge-coordinator:merge-failed-requeued-event-log"
      );
      this.broadcastMergeFailureWs(projectId, task.id, {
        cumulativeAttempts,
        resolvedBy: "requeued",
        reason: mergeFailureReason,
        mergeStage: normalizedStage,
        qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
        failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
        failedGateReason: qualityGateStructuredDetails.failedGateReason,
        failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
        worktreePath: qualityGateStructuredDetails.worktreePath,
      });
      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: task.id,
          event: "task.requeued",
          data: {
            attempt: cumulativeAttempts,
            phase: "merge",
            failureType: mergeFailureType,
            policyDecision: "requeue",
            mergeStage: normalizedStage,
            conflictedFiles,
            summary: requeuedSummary.summary,
            nextAction: "Requeued for retry",
            failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
            failedGateReason: qualityGateStructuredDetails.failedGateReason,
            failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
            worktreePath: qualityGateStructuredDetails.worktreePath,
            qualityGateCategory: qualityGateStructuredDetails.qualityGateCategory,
            qualityGateValidationWorkspace:
              qualityGateStructuredDetails.qualityGateValidationWorkspace,
            qualityGateAutoRepairAttempted: qualityGateStructuredDetails.qualityGateRepairAttempted,
            qualityGateAutoRepairSucceeded: qualityGateStructuredDetails.qualityGateRepairSucceeded,
            qualityGateExecutable: qualityGateStructuredDetails.qualityGateExecutable,
            qualityGateCwd: qualityGateStructuredDetails.qualityGateCwd,
            qualityGateExitCode: qualityGateStructuredDetails.qualityGateExitCode,
            qualityGateSignal: qualityGateStructuredDetails.qualityGateSignal,
            qualityGateClassificationConfidence:
              qualityGateStructuredDetails.qualityGateClassificationConfidence,
            qualityGateClassificationReason:
              qualityGateStructuredDetails.qualityGateClassificationReason,
            qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
            failureClass: failureFingerprint.failureClass,
            failureFingerprint: failureFingerprint.hash,
          },
        }),
        "merge-coordinator:task-requeued-event-log"
      );
      this.broadcastTaskRequeuedWs(projectId, task.id, {
        cumulativeAttempts,
        phase: "merge",
        mergeStage: normalizedStage,
        summary: requeuedSummary.summary,
        nextAction: "Requeued for retry",
        qualityGateDetail: qualityGateStructuredDetails.qualityGateDetail,
        failedGateCommand: qualityGateStructuredDetails.failedGateCommand,
        failedGateReason: qualityGateStructuredDetails.failedGateReason,
        failedGateOutputSnippet: qualityGateStructuredDetails.failedGateOutputSnippet,
        worktreePath: qualityGateStructuredDetails.worktreePath,
        failureClass: failureFingerprint.failureClass,
        failureFingerprint: failureFingerprint.hash,
      });

      shouldNudge = true;
    } catch (err) {
      log.warn("Failed to requeue task after merge failure", { taskId: task.id, err });
    } finally {
      await this.releaseMergeSlot(projectId, repoPath, "fail", task.id);
      if (shouldNudge) {
        this.host.nudge(projectId);
      }
    }
  }

  async postCompletionAsync(
    projectId: string,
    repoPath: string,
    taskId: string,
    options?: { mergedToMain?: boolean }
  ): Promise<void> {
    const mergedToMain = options?.mergedToMain !== false;
    const governanceInactive = await governanceService
      .isGovernanceInactive(projectId)
      .catch((err) => {
        log.warn("Could not read governance state; keeping deploys durable", { projectId, err });
        return false;
      });
    if (mergedToMain) {
      if (governanceInactive) {
        // PRD §7.5.3: Auto-deploy on each task only when a merge to main occurred
        triggerDeployForEvent(projectId, "each_task").catch((err) => {
          log.warn("Auto-deploy on task completion failed", { projectId, err });
        });
      } else {
        const task = await this.host.taskStore.show(projectId, taskId).catch(() => null);
        await deferredAutoDeployService.enqueue(
          projectId,
          "each_task",
          taskId,
          String(task?.completed_at ?? "completed")
        );
      }
    }
    let pushStatus: PushCompletionStatus = "publish_failed";
    if (!this.pushInProgress.has(projectId)) {
      let resolvePush!: () => void;
      const pushPromise = new Promise<void>((r) => {
        resolvePush = r;
      });
      this.pushCompletion.set(projectId, { promise: pushPromise, resolve: resolvePush });
      this.pushInProgress.add(projectId);
      try {
        pushStatus = await this.pushMainSafe(projectId, repoPath);
        if (pushStatus !== "publish_failed") {
          await this.cleanupAfterSuccessfulPush(projectId, repoPath);
        }
      } finally {
        this.pushInProgress.delete(projectId);
        const entry = this.pushCompletion.get(projectId);
        if (entry) {
          entry.resolve();
          this.pushCompletion.delete(projectId);
        }
      }
    } else {
      log.info("Push already in progress, skipping (will retry on next completion)");
    }

    this.host.feedbackService.checkAutoResolveOnTaskDone(projectId, taskId).catch((err) => {
      log.warn("Auto-resolve feedback on task done failed", { taskId, err });
    });

    // A completed local merge may still be waiting for remote code re-review.
    if (!governanceInactive) await this.drainDeferredDeploysIfPublished(projectId, repoPath);

    const allIssues = await this.host.taskStore.listAll(projectId);
    const epicId = resolveEpicId(taskId, allIssues);
    if (epicId) {
      const implTasks = this.getEpicImplementationTasks(allIssues, epicId);
      const allClosed =
        implTasks.length > 0 && implTasks.every((i) => (i.status as string) === "closed");
      if (allClosed) {
        const epicIssue = allIssues.find((i) => i.id === epicId);
        if (epicIssue && (epicIssue.status as string) !== "closed") {
          this.runFinalReviewAndCloseOrCreateTasks(projectId, repoPath, epicId).catch((err) =>
            log.warn("Final review flow failed", { projectId, epicId, err })
          );
        } else {
          const shouldDeploy = await this.shouldTriggerDeployForEpic(projectId, epicId);
          if (shouldDeploy) {
            await this.enqueueEpicDeploy(projectId, repoPath, epicId);
          }
          const planRow = await this.host.taskStore.planGetByEpicId(projectId, epicId);
          if (planRow) {
            // Self-improvement (frequency after_each_plan): run once when plan execution is fully complete.
            // runIfDue checks frequency, hasCodeChangesSince(lastRunAt, baseBranch), and no run in progress.
            selfImprovementService
              .runIfDue(projectId, { trigger: "after_each_plan", planId: planRow.plan_id })
              .catch((err) =>
                log.warn("Self-improvement after plan completion failed", {
                  projectId,
                  epicId,
                  err,
                })
              );
          }
        }
      }
    }
  }

  /**
   * Deliver gate: trigger deploy for epic only when plan is complete (reviewedAt set).
   * When plan is in_review (reviewedAt null), do not trigger; user must mark plan complete first.
   */
  private async shouldTriggerDeployForEpic(projectId: string, epicId: string): Promise<boolean> {
    const planRow = await this.host.taskStore.planGetByEpicId(projectId, epicId);
    if (!planRow) return false;
    return planRow.metadata?.reviewedAt != null;
  }

  /**
   * Run final review agent when last task of epic is done.
   * If pass: close epic, trigger deploy. If issues: create tasks, epic stays open, nudge.
   */
  async recoverDeferredPublications(projectId: string, repoPath: string): Promise<void> {
    if (!(await deferredAutoDeployService.hasPending(projectId))) return;
    const settings = await this.host.projectService.getSettings(projectId);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    const repo = await inspectGitRepoState(repoPath, baseBranch);
    const claimed = await governanceService.withPublicationLock(projectId, async (assertLease) => {
      if (repo.remoteMode !== "local_only")
        await remotePublicationGovernanceService.beginPush({ projectId, repoPath, baseBranch });
      return this.claimDeferredDeploys(projectId, repoPath, baseBranch, assertLease);
    });
    this.runClaimedDeploys(projectId, claimed);
  }

  private async claimDeferredDeploys(
    projectId: string,
    repoPath: string,
    baseBranch: string,
    assertLease: () => Promise<void>
  ): Promise<ClaimedDeploy[]> {
    const head = await remotePublicationGovernanceService.getDeployableHead(
      projectId,
      repoPath,
      baseBranch
    );
    if (!head) return [];
    await assertLease();
    return deferredAutoDeployService.claim(projectId, repoPath, head, assertLease);
  }

  /** Deploys run detached and unlocked: a long delivery must not hold up merges or completion. */
  private runClaimedDeploys(projectId: string, claimed: ClaimedDeploy[]): void {
    if (claimed.length)
      fireAndForget(
        deferredAutoDeployService.runClaimed(projectId, claimed),
        "merge-coordinator:deferred-auto-deploy"
      );
  }

  /** Unclaimed jobs stay durable, so a busy lease or a database blip only postpones them. */
  private async drainDeferredDeploysIfPublished(
    projectId: string,
    repoPath: string
  ): Promise<void> {
    try {
      const settings = await this.host.projectService.getSettings(projectId);
      const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
      const claimed = await governanceService.withPublicationLock(projectId, (assertLease) =>
        this.claimDeferredDeploys(projectId, repoPath, baseBranch, assertLease)
      );
      this.runClaimedDeploys(projectId, claimed);
    } catch (err) {
      log.warn("Deferred auto-deploy will retry on the next completion or restart", {
        projectId,
        err,
      });
    }
  }
  private async enqueueEpicDeploy(
    projectId: string,
    repoPath: string,
    epicId: string
  ): Promise<void> {
    if (await governanceService.isGovernanceInactive(projectId)) {
      triggerDeployForEvent(projectId, "each_epic").catch((err) => {
        log.warn("Auto-deploy on epic completion failed", { projectId, err });
      });
      return;
    }
    const task = await this.host.taskStore.show(projectId, epicId).catch(() => null);
    const plan = await this.host.taskStore.planGetByEpicId(projectId, epicId);
    const reviewedAt = (plan?.metadata as { reviewedAt?: string } | undefined)?.reviewedAt;
    await deferredAutoDeployService.enqueue(
      projectId,
      "each_epic",
      epicId,
      String(reviewedAt ?? task?.completed_at ?? "completed")
    );
    await this.drainDeferredDeploysIfPublished(projectId, repoPath);
  }

  private async runFinalReviewAndCloseOrCreateTasks(
    projectId: string,
    repoPath: string,
    epicId: string
  ): Promise<void> {
    const result = await finalReviewService.runFinalReview(projectId, epicId, repoPath);

    if (result === null) {
      // No plan (deploy-fix epic) or agent failed — close epic; deploy only when plan is complete (reviewedAt set)
      await this.host.taskStore.close(projectId, epicId, "All tasks done");
      const shouldDeploy = await this.shouldTriggerDeployForEpic(projectId, epicId);
      if (shouldDeploy) {
        await this.enqueueEpicDeploy(projectId, repoPath, epicId);
      }
      const planRow = await this.host.taskStore.planGetByEpicId(projectId, epicId);
      if (planRow) {
        // Self-improvement (after_each_plan): runIfDue does change detection and run-in-progress check.
        selfImprovementService
          .runIfDue(projectId, { trigger: "after_each_plan", planId: planRow.plan_id })
          .catch((err) =>
            log.warn("Self-improvement after plan completion failed", { projectId, epicId, err })
          );
      }
      return;
    }

    if (result.status === "pass") {
      await this.host.taskStore.close(projectId, epicId, "All tasks done; final review passed");
      const shouldDeploy = await this.shouldTriggerDeployForEpic(projectId, epicId);
      if (shouldDeploy) {
        await this.enqueueEpicDeploy(projectId, repoPath, epicId);
      }
      const planRow = await this.host.taskStore.planGetByEpicId(projectId, epicId);
      if (planRow) {
        // Self-improvement (after_each_plan): runIfDue does change detection and run-in-progress check.
        selfImprovementService
          .runIfDue(projectId, { trigger: "after_each_plan", planId: planRow.plan_id })
          .catch((err) =>
            log.warn("Self-improvement after plan completion failed", { projectId, epicId, err })
          );
      }
      return;
    }

    // Issues found — create tasks, epic stays open
    const createdIds = await finalReviewService.createTasksFromReview(
      projectId,
      epicId,
      result.proposedTasks
    );
    log.info("Final review found issues, created tasks", {
      projectId,
      epicId,
      assessment: result.assessment,
      createdCount: createdIds.length,
    });
    this.host.nudge(projectId);
  }

  async waitForPushComplete(projectId: string): Promise<void> {
    if (!this.pushInProgress.has(projectId)) return;
    const entry = this.pushCompletion.get(projectId);
    if (entry) await entry.promise;
  }

  private async ensurePreparedMainQualityGates(
    projectId: string,
    repoPath: string,
    baseBranch: string,
    source: BaselineCheckSource
  ): Promise<void> {
    const failure = await this.getBaselineQualityGateFailure(projectId, repoPath, baseBranch, {
      useCache: true,
      source,
    });
    if (!failure) return;

    await this.createBaselineQualityGateRemediationTask(repoPath, projectId, baseBranch, failure);
    await this.createBaselineQualityGateNotification(
      projectId,
      baseBranch,
      buildBaselineQualityGateNotificationDetail(failure)
    );
    throw buildMergeQualityGateJobError(failure, repoPath);
  }

  private async resolvePushRebaseConflicts(options: {
    projectId: string;
    repoPath: string;
    baseBranch: string;
    settings: Awaited<ReturnType<MergeCoordinatorHost["projectService"]["getSettings"]>>;
    initialConflict: RebaseConflictError;
    batch: RemotePushBatch;
    assertLease: () => Promise<void>;
  }): Promise<{ ok: true } | { ok: false; error: Error }> {
    const { projectId, repoPath, baseBranch, settings, initialConflict } = options;
    const MAX_PUSH_REBASE_CONFLICT_ROUNDS = 12;
    let round = 0;
    let pendingConflict: RebaseConflictError | null = initialConflict;

    while (pendingConflict) {
      round += 1;
      if (round > MAX_PUSH_REBASE_CONFLICT_ROUNDS) {
        const err = new Error(
          `Push rebase conflict unresolved after ${MAX_PUSH_REBASE_CONFLICT_ROUNDS} attempts`
        );
        log.warn("Push rebase conflict exceeded max conflict-resolution rounds", {
          projectId,
          baseBranch,
          maxRounds: MAX_PUSH_REBASE_CONFLICT_ROUNDS,
        });
        await this.host.branchManager.rebaseAbort(repoPath);
        return { ok: false, error: err };
      }

      log.info("Push rebase conflict, invoking merger agent", {
        projectId,
        files: pendingConflict.conflictedFiles,
        round,
      });
      const resolved = await this.host.runMergerAgentAndWait({
        projectId,
        cwd: repoPath,
        config: settings.simpleComplexityAgent as AgentConfig,
        phase: "push_rebase",
        taskId: "",
        branchName: baseBranch,
        conflictedFiles: pendingConflict.conflictedFiles,
        testCommand: resolveTestCommand(settings),
        mergeQualityGates: getMergeQualityGateCommands(settings.toolchainProfile),
        baseBranch,
      });
      if (!resolved) {
        log.warn("Merger agent failed to resolve push rebase conflicts", {
          projectId,
          round,
        });
        await this.host.branchManager.rebaseAbort(repoPath);
        return {
          ok: false,
          error: new RebaseConflictError(pendingConflict.conflictedFiles),
        };
      }

      try {
        await this.host.branchManager.rebaseContinue(repoPath);
        pendingConflict = null;
      } catch (continueErr) {
        if (continueErr instanceof RebaseConflictError) {
          pendingConflict = continueErr;
        } else if (continueErr instanceof RebaseContinueBlockedError) {
          const d = continueErr.diagnostics;
          if (
            (d.cause === "preflight_unmerged" || d.cause === "preflight_staged_markers") &&
            d.conflictedFiles.length > 0
          ) {
            log.info("merge.merger_rebase_continue_skipped_preflight", {
              projectId,
              round,
              conflictedFiles: d.conflictedFiles,
              rebaseMetadataPresent: d.rebaseMetadataPresent,
              context: "push_rebase",
            });
            appendRuntimeTrace("merge.merger_rebase_continue_skipped_preflight", projectId, {
              round,
              conflictedFiles: d.conflictedFiles,
              rebaseMetadataPresent: d.rebaseMetadataPresent,
              context: "push_rebase",
            });
            pendingConflict = new RebaseConflictError(d.conflictedFiles);
          } else {
            log.warn("rebase continue blocked after merger (push)", {
              projectId,
              round,
              diagnostics: d,
            });
            await this.host.branchManager.rebaseAbort(repoPath);
            return {
              ok: false,
              error: new RebaseContinueBlockedError(
                continueErr.message,
                continueErr.diagnostics,
                "push_rebase"
              ),
            };
          }
        } else {
          log.warn("rebase --continue failed after merger", {
            projectId,
            continueErr,
            round,
          });
          await this.host.branchManager.rebaseAbort(repoPath);
          return {
            ok: false,
            error: continueErr instanceof Error ? continueErr : new Error(String(continueErr)),
          };
        }
      }
    }

    try {
      await this.ensurePreparedMainQualityGates(
        projectId,
        repoPath,
        baseBranch,
        "push_rebase_recheck"
      );
      await this.publishPreparedMain(
        projectId,
        repoPath,
        baseBranch,
        options.batch,
        options.assertLease
      );
      log.info("Merger resolved push rebase conflicts, push succeeded", { projectId });
      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "push.succeeded",
        }),
        "merge-coordinator:push-succeeded-after-rebase-event-log"
      );
      return { ok: true };
    } catch (pushErr) {
      log.warn("push to origin failed after resolving push rebase conflicts", {
        projectId,
        pushErr,
      });
      return {
        ok: false,
        error: pushErr instanceof Error ? pushErr : new Error(String(pushErr)),
      };
    }
  }

  private async publishPreparedMain(
    projectId: string,
    repoPath: string,
    baseBranch: string,
    batch: RemotePushBatch,
    assertLease: () => Promise<void>
  ): Promise<void> {
    const prepared = await remotePublicationGovernanceService.assertPreparedPush({
      projectId,
      repoPath,
      baseBranch,
      batch,
    });
    await assertLease();
    await this.host.branchManager.pushMainToOrigin(repoPath, baseBranch);
    await remotePublicationGovernanceService.completePush(projectId, prepared);
  }

  /**
   * Push main to origin.
   * On rebase conflict: run merger/rebase-continue rounds until rebase is complete
   * (bounded by MAX_PUSH_REBASE_CONFLICT_ROUNDS). If unresolved, abort and retry on next completion.
   */
  private async pushMainSafe(projectId: string, repoPath: string): Promise<PushCompletionStatus> {
    await gitCommitQueue.drain();
    await this.host.taskStore.syncForPush(projectId);

    const settings = await this.host.projectService.getSettings(projectId);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    const repoState = await inspectGitRepoState(repoPath, baseBranch);

    if (repoState.remoteMode === "local_only") {
      log.info("No origin configured; skipping publish after local merge", {
        projectId,
        baseBranch,
      });
      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "push.skipped",
          data: {
            reason: "local_only",
          },
        }),
        "merge-coordinator:push-skipped-event-log"
      );
      return "local_only";
    }

    // Lease acquisition or release failing must not undo what the push actually achieved.
    let outcome: PushCompletionStatus | undefined;
    try {
      await governanceService.withPublicationLock(projectId, async (assertLease) => {
        outcome = await this.publishWithLease(
          projectId,
          repoPath,
          baseBranch,
          settings,
          assertLease
        );
      });
    } catch (err) {
      log.warn("Publication lock unavailable; push will retry on next task completion", {
        projectId,
        err,
      });
    }
    return outcome ?? "publish_failed";
  }

  private async publishWithLease(
    projectId: string,
    repoPath: string,
    baseBranch: string,
    settings: Awaited<ReturnType<MergeCoordinatorHost["projectService"]["getSettings"]>>,
    assertLease: () => Promise<void>
  ): Promise<PushCompletionStatus> {
    let batch: RemotePushBatch | undefined;
    try {
      batch = await remotePublicationGovernanceService.beginPush({
        projectId,
        repoPath,
        baseBranch,
      });
      await this.host.branchManager.prepareMainForPush(repoPath, baseBranch);
      await this.ensurePreparedMainQualityGates(projectId, repoPath, baseBranch, "push_precheck");
      await this.publishPreparedMain(projectId, repoPath, baseBranch, batch, assertLease);
      log.info("Push to origin succeeded", { projectId });
      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "push.succeeded",
        }),
        "merge-coordinator:push-succeeded-event-log"
      );
      return "published";
    } catch (err) {
      let terminalError: Error = err instanceof Error ? err : new Error(String(err));
      let pushStage: "push_rebase" | "push" | "quality_gate" = "push";
      if (err instanceof RebaseConflictError && batch) {
        pushStage = "push_rebase";
        const resolution = await this.resolvePushRebaseConflicts({
          projectId,
          repoPath,
          baseBranch,
          settings,
          initialConflict: err,
          batch,
          assertLease,
        });
        if (resolution.ok) {
          return "published";
        }
        terminalError = resolution.error;
      } else {
        log.warn("Push failed, will retry on next task completion", { projectId, err });
      }
      if (terminalError instanceof MergeJobError && terminalError.stage === "quality_gate") {
        pushStage = "quality_gate";
      }
      const reason = terminalError.message.slice(0, 500);
      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: "",
          event: "push.failed",
          data: {
            reason,
            conflictedFiles:
              terminalError instanceof RebaseConflictError ? terminalError.conflictedFiles : [],
            stage: pushStage,
          },
        }),
        "merge-coordinator:push-failed-event-log"
      );
      await notificationService
        .create({
          projectId,
          source: "execute",
          sourceId: "remote-publish",
          questions: [
            {
              id: `push-${projectId}`,
              text: `Work merged locally, but publish to origin failed: ${reason}`,
            },
          ],
        })
        .catch((notificationErr) =>
          log.warn("Failed to create remote publish warning notification", {
            projectId,
            notificationErr,
          })
        );
      return "publish_failed";
    }
  }
}
