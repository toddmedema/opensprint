/**
 * Task-worktree rebase-before-gates and deterministic merge-gate dedupe for the orchestrator.
 * Extracted from OrchestratorService behind a narrow host interface.
 */

import type { AgentConfig, ProjectSettings, ToolchainProfile } from "@opensprint/shared";
import { getFailureTypeTitle, resolveTestCommand } from "@opensprint/shared";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";
import type {
  MergeQualityGateFailure,
  MergeQualityGateRunOptions,
} from "./merge-coordinator.service.js";
import {
  isTaskWorktreeMergeGateArtifactCurrent,
  runMergeQualityGatesWithArtifact,
} from "./merge-verification.service.js";
import {
  RebaseConflictError,
  RebaseContinueBlockedError,
  type BranchManager,
} from "./branch-manager.js";
import type { StoredTask } from "./task-store.service.js";
import { eventLogService } from "./event-log.service.js";
import { createLogger } from "../utils/logger.js";
import { fireAndForget } from "../utils/fire-and-forget.js";
import type {
  FailureType,
  PhaseResult,
  RetryQualityGateDetail,
} from "./orchestrator-phase-context.js";
import { compactExecutionText } from "./task-execution-summary.js";

const log = createLogger("orchestrator-task-worktree-gates");

/** Matches git-commit-queue worktree_merge rebase resolution cap. */
export const MAX_PRE_VALIDATION_REBASE_MERGER_ROUNDS = 12;

export interface TaskWorktreeRebaseMergerOptions {
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
}

export interface TaskWorktreeRebaseForGatesHost {
  branchManager: Pick<
    BranchManager,
    | "syncMainWithOrigin"
    | "rebaseOntoMain"
    | "rebaseAbort"
    | "rebaseContinue"
    | "getConflictedFiles"
  >;
  taskStore: {
    setConflictFiles(projectId: string, id: string, files: string[]): Promise<void>;
    setMergeStage(projectId: string, id: string, stage: string | null): Promise<void>;
  };
  projectService: { getSettings(projectId: string): Promise<ProjectSettings> };
  failureHandler: {
    handleTaskFailure(
      projectId: string,
      repoPath: string,
      task: StoredTask,
      branchName: string,
      reason: string,
      testResults: null,
      failureType: "merge_conflict"
    ): Promise<void>;
  };
  runMergerAgentAndWait(options: TaskWorktreeRebaseMergerOptions): Promise<boolean>;
}

export function clearQualityGateDetailOnPhase(phaseResult: PhaseResult): void {
  phaseResult.qualityGateDetail = null;
}

export function toRetryQualityGateDetail(
  failure: MergeQualityGateFailure,
  fallbackWorktreePath: string
): RetryQualityGateDetail {
  return {
    recoveryIncidentId: failure.recoveryIncidentId,
    preserveWork: failure.preserveWork,
    command: failure.command,
    reason: failure.reason?.trim().slice(0, 500) || "Unknown quality gate failure",
    outputSnippet:
      compactExecutionText((failure.outputSnippet ?? failure.output ?? "").trim(), 1800) || null,
    worktreePath: failure.worktreePath ?? fallbackWorktreePath,
    firstErrorLine:
      failure.firstErrorLine?.trim().slice(0, 300) ||
      compactExecutionText((failure.outputSnippet ?? failure.output ?? "").trim(), 300) ||
      null,
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
    gitStatusPorcelainSnippet: failure.gitStatusPorcelainSnippet
      ? compactExecutionText(failure.gitStatusPorcelainSnippet.trim(), 2000)
      : null,
    gitNameStatusSnippet: failure.gitNameStatusSnippet
      ? compactExecutionText(failure.gitNameStatusSnippet.trim(), 2000)
      : null,
    gateNodeVersion: failure.gateNodeVersion ?? null,
    gateNpmVersion: failure.gateNpmVersion ?? null,
    gateDependencyStrategy: failure.gateDependencyStrategy ?? null,
    gateHermeticNodeModules: failure.gateHermeticNodeModules ?? null,
  };
}

export function applyQualityGateFailureToPhaseResult(
  phaseResult: PhaseResult,
  failure: MergeQualityGateFailure,
  fallbackWorktreePath: string
): RetryQualityGateDetail {
  const detail = toRetryQualityGateDetail(failure, fallbackWorktreePath);
  phaseResult.validationCommand = detail.command ?? null;
  phaseResult.testOutput = failure.outputSnippet ?? failure.output ?? "";
  phaseResult.qualityGateDetail = detail;
  return detail;
}

export function formatOrchestratorQualityGateFailureReason(
  detail: RetryQualityGateDetail | null | undefined,
  failureType: FailureType
): string {
  const command = detail?.command?.trim();
  const reason =
    detail?.reason?.trim() || detail?.firstErrorLine?.trim() || "Pre-merge quality gates failed";
  const firstErrorLine = detail?.firstErrorLine?.trim();
  const prefix =
    failureType === "environment_setup"
      ? getFailureTypeTitle("environment_setup")
      : getFailureTypeTitle("quality_gate");
  const commandPart = command ? ` (${command})` : "";
  const detailPart =
    firstErrorLine && firstErrorLine !== reason ? `: ${reason} | ${firstErrorLine}` : `: ${reason}`;
  return compactExecutionText(`${prefix}${commandPart}${detailPart}`, 500);
}

export interface TaskWorktreeMergeGatesDeps {
  runMergeQualityGates: (
    options: MergeQualityGateRunOptions
  ) => Promise<MergeQualityGateFailure | null>;
  branchManager: BranchManager;
}

export async function runTaskWorktreeMergeGatesMaybeDeduped(
  deps: TaskWorktreeMergeGatesDeps,
  params: {
    projectId: string;
    repoPath: string;
    task: StoredTask;
    branchName: string;
    wtPath: string;
    baseBranch: string;
    toolchainProfile: ToolchainProfile | undefined;
    slot: { phaseResult: PhaseResult };
  }
): Promise<MergeQualityGateFailure | null> {
  const { projectId, repoPath, task, branchName, wtPath, baseBranch, toolchainProfile, slot } =
    params;
  const existing = slot.phaseResult.mergeGateArtifactTaskWorktree;
  if (
    existing &&
    (await isTaskWorktreeMergeGateArtifactCurrent(deps.branchManager, {
      projectId,
      repoPath,
      wtPath,
      baseBranch,
      artifact: existing,
      toolchainProfile,
      qualityGateProfile: "deterministic",
    }))
  ) {
    log.info("merge_gate_skipped_duplicate", {
      taskId: task.id,
      stage: "orchestrator_task_worktree",
    });
    return null;
  }
  const { failure, artifact } = await runMergeQualityGatesWithArtifact(
    (opts) => deps.runMergeQualityGates(opts),
    deps.branchManager,
    {
      projectId,
      repoPath,
      worktreePath: wtPath,
      taskId: task.id,
      branchName,
      baseBranch,
      validationWorkspace: "task_worktree",
      qualityGateProfile: "deterministic",
      toolchainProfile,
    }
  );
  if (artifact) {
    slot.phaseResult.mergeGateArtifactTaskWorktree = artifact;
  }
  return failure;
}

export async function ensureTaskWorktreeRebasedForMergeGates(
  host: TaskWorktreeRebaseForGatesHost,
  params: {
    projectId: string;
    repoPath: string;
    task: StoredTask;
    wtPath: string;
    baseBranch: string;
    branchName: string;
  }
): Promise<boolean> {
  const { projectId, repoPath, task, wtPath, baseBranch, branchName } = params;
  await host.branchManager.syncMainWithOrigin(repoPath, baseBranch);

  let rebaseConflict: RebaseConflictError | null = null;
  try {
    await host.branchManager.rebaseOntoMain(wtPath, baseBranch);
  } catch (e) {
    if (e instanceof RebaseConflictError) {
      rebaseConflict = e;
    } else {
      throw e;
    }
  }

  let ranMergerResolution = false;
  if (rebaseConflict) {
    ranMergerResolution = true;
    const settings = await host.projectService.getSettings(projectId);
    const mergerConfig = settings.simpleComplexityAgent as AgentConfig;
    const mergerTestCommand = resolveTestCommand(settings) || undefined;
    const mergerQualityGates = getMergeQualityGateCommands(settings.toolchainProfile);

    let round = 0;
    while (rebaseConflict) {
      round += 1;
      const conflictedFiles = rebaseConflict.conflictedFiles;
      if (round > MAX_PRE_VALIDATION_REBASE_MERGER_ROUNDS) {
        await host.branchManager.rebaseAbort(wtPath).catch((err: unknown) => {
          log.warn("rebase abort failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        });
        await host.taskStore.setConflictFiles(projectId, task.id, conflictedFiles);
        await host.taskStore.setMergeStage(projectId, task.id, "rebase_before_merge");
        await host.failureHandler.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Rebase onto ${baseBranch} before validation: unresolved after ${MAX_PRE_VALIDATION_REBASE_MERGER_ROUNDS} merger rounds (conflicts: ${conflictedFiles.join(", ")})`,
          null,
          "merge_conflict"
        );
        return false;
      }

      log.info("Pre-validation rebase conflict, invoking merger agent", {
        taskId: task.id,
        branchName,
        conflictedFiles,
        round,
      });
      await host.taskStore.setConflictFiles(projectId, task.id, conflictedFiles);
      if (round === 1) {
        await host.taskStore.setMergeStage(projectId, task.id, "rebase_before_merge");
      }

      const resolved = await host.runMergerAgentAndWait({
        projectId,
        cwd: wtPath,
        config: mergerConfig,
        phase: "rebase_before_merge",
        taskId: task.id,
        branchName,
        conflictedFiles,
        testCommand: mergerTestCommand,
        mergeQualityGates: mergerQualityGates,
        baseBranch,
      });
      if (!resolved) {
        await host.branchManager.rebaseAbort(wtPath).catch((err: unknown) => {
          log.warn("rebase abort failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        });
        await host.failureHandler.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Rebase onto ${baseBranch} before validation: merger could not resolve conflicts (${conflictedFiles.join(", ")})`,
          null,
          "merge_conflict"
        );
        return false;
      }

      fireAndForget(
        eventLogService.append(repoPath, {
          timestamp: new Date().toISOString(),
          projectId,
          taskId: task.id,
          event: "merge.resolved",
          data: {
            stage: "rebase_before_merge",
            branchName,
            conflictedFiles,
            resolvedBy: "merger",
            round,
            context: "pre_validation",
          },
        }),
        "quality-gates:merge.resolved"
      );

      try {
        await host.branchManager.rebaseContinue(wtPath);
        rebaseConflict = null;
      } catch (continueErr) {
        if (continueErr instanceof RebaseConflictError) {
          rebaseConflict = continueErr;
        } else if (continueErr instanceof RebaseContinueBlockedError) {
          const d = continueErr.diagnostics;
          if (
            (d.cause === "preflight_unmerged" || d.cause === "preflight_staged_markers") &&
            d.conflictedFiles.length > 0
          ) {
            log.info("merge.merger_rebase_continue_skipped_preflight", {
              taskId: task.id,
              branchName,
              round,
              conflictedFiles: d.conflictedFiles,
              rebaseMetadataPresent: d.rebaseMetadataPresent,
              context: "pre_validation",
            });
            rebaseConflict = new RebaseConflictError(d.conflictedFiles);
          } else {
            await host.branchManager.rebaseAbort(wtPath).catch((err: unknown) => {
              log.warn("rebase abort failed", {
                err: err instanceof Error ? err.message : String(err),
              });
            });
            await host.failureHandler.handleTaskFailure(
              projectId,
              repoPath,
              task,
              branchName,
              `Rebase onto ${baseBranch} before validation: ${continueErr.message}`,
              null,
              "merge_conflict"
            );
            return false;
          }
        } else {
          const cf = await host.branchManager.getConflictedFiles(wtPath);
          if (cf.length > 0) {
            rebaseConflict = new RebaseConflictError(cf);
          } else {
            await host.branchManager.rebaseAbort(wtPath).catch((err: unknown) => {
              log.warn("rebase abort failed", {
                err: err instanceof Error ? err.message : String(err),
              });
            });
            throw continueErr;
          }
        }
      }
    }
  }

  if (ranMergerResolution) {
    await host.taskStore.setConflictFiles(projectId, task.id, []);
    await host.taskStore.setMergeStage(projectId, task.id, null);
  }
  return true;
}
