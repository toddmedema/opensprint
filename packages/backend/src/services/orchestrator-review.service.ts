/**
 * OrchestratorReviewService — review phase orchestration logic.
 * Extracted from OrchestratorService for clarity and testability.
 */

import fs from "fs/promises";
import path from "path";
import type { ReviewAgentResult, AgentConfig, ReviewAngle } from "@opensprint/shared";
import { resolveTestCommand } from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import type {
  FailureType,
  RetryContext,
  RetryQualityGateDetail,
  ReviewRetryTarget,
  TaskAssignmentLike,
} from "./orchestrator-phase-context.js";
import {
  buildOrchestratorTestStatusContent,
  getOrchestratorTestStatusFsPath,
  getOrchestratorTestStatusStateFsPath,
  parseOrchestratorTestStatusContent,
  type PersistedOrchestratorTestStatus,
} from "./orchestrator-test-status.js";
import {
  TaskPhaseCoordinator,
  type TestOutcome,
  type ReviewOutcome,
} from "./task-phase-coordinator.js";
import type { AgentSlot } from "./orchestrator.service.js";
import { formatReviewFeedback, type PhaseResult } from "./orchestrator-phase-context.js";
import type { PhaseExecutorService } from "./phase-executor.service.js";
import type { FailureHandlerService } from "./failure-handler.service.js";
import type {
  MergeCoordinatorService,
  MergeQualityGateFailure,
} from "./merge-coordinator.service.js";
import type { BranchManager } from "./branch-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { ProjectService } from "./project.service.js";
import type { TaskStoreService } from "./task-store.service.js";
import type { ScopedTestResult } from "./test-runner.js";
import { broadcastToProject } from "../websocket/index.js";
import { notificationService } from "./notification.service.js";
import { agentIdentityService, buildAgentAttemptId } from "./agent-identity.service.js";
import { eventLogService } from "./event-log.service.js";
import { reviewSynthesizerService } from "./review-synthesizer.service.js";
import {
  extractNoResultReasonFromLogs,
  buildReviewNoResultFailureReason,
  classifyNoResultReasonCode,
} from "./no-result-reason.service.js";
import {
  describeStructuredOutputProblem,
  parseReviewAgentResult,
} from "./agent-result-validation.js";
import { summarizeDebugArtifact } from "./agentic-repair.service.js";
import {
  buildTaskLastExecutionSummary,
  compactExecutionText,
  persistTaskLastExecutionSummary,
} from "./task-execution-summary.js";
import { resolveBaseBranch } from "../utils/git-repo-state.js";
import { assertWorktreeIntegrity } from "../utils/worktree-health.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { createLogger } from "../utils/logger.js";
import { localRecoveryStore } from "./local-recovery.service.js";
import { fireAndForget } from "../utils/fire-and-forget.js";

import { governanceExecutionService } from "./governance-execution.service.js";
import { governanceService } from "./governance.service.js";
import {
  resolveTaskReviewBase,
  acceptRemoteReviewIfRequested,
} from "./remote-publication-review-context.js";

const log = createLogger("orchestrator-review");

const REVIEW_RESULT_EXPECTED_SHAPE =
  'a JSON object like {"status":"approved","summary":"..."} or {"status":"rejected","summary":"...","issues":["..."],"notes":"..."}';

export interface OrchestratorReviewHost {
  getLocalRecoveryStore?(): import("./local-recovery-store.js").LocalRecoveryStore;
  getState(projectId: string): {
    slots: Map<string, AgentSlot>;
    status: { queueDepth: number };
  };
  cleanupSlotIfProjectGone(
    projectId: string,
    repoPath: string,
    taskId: string,
    state: { slots: Map<string, AgentSlot>; status: { queueDepth: number } },
    slot: AgentSlot | undefined,
    callerLabel: string
  ): Promise<boolean>;
  readAssignmentForRun(
    wtPath: string,
    taskId: string,
    angle?: ReviewAngle
  ): Promise<TaskAssignmentLike | null>;
  runAdaptiveValidation(
    projectId: string,
    wtPath: string,
    changedFiles: string[],
    testCommand?: string
  ): Promise<ScopedTestResult>;
  runTaskWorktreeMergeGatesMaybeDeduped(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    wtPath: string,
    baseBranch: string,
    toolchainProfile: import("@opensprint/shared").ToolchainProfile | undefined,
    slot: AgentSlot
  ): Promise<MergeQualityGateFailure | null>;
  applyQualityGateFailure(
    phaseResult: PhaseResult,
    failure: MergeQualityGateFailure,
    wtPath: string
  ): RetryQualityGateDetail;
  formatQualityGateFailureReason(
    detail: RetryQualityGateDetail | null | undefined,
    failureType: FailureType
  ): string;
  clearQualityGateDetail(phaseResult: PhaseResult): void;
  persistCounters(projectId: string, repoPath: string): Promise<void>;
  pauseForGovernance?(projectId: string, repoPath: string, taskId: string): Promise<void>;
  onAgentStateChange(projectId: string): () => void;
  branchManager: BranchManager;
  sessionManager: SessionManager;
  projectService: ProjectService;
  taskStore: TaskStoreService;
  failureHandler: FailureHandlerService;
  mergeCoordinator: MergeCoordinatorService;
  phaseExecutor: PhaseExecutorService;
}

export class OrchestratorReviewService {
  constructor(private host: OrchestratorReviewHost) {}

  private isPendingValidationFragment(text: string): boolean {
    const normalized = text.toLowerCase();
    const mentionsPending = normalized.includes("pending");
    const mentionsOrchestrator = normalized.includes("orchestrator");
    const mentionsValidation =
      normalized.includes("validation") ||
      normalized.includes("test status") ||
      normalized.includes("orchestrator-test-status");
    const mentionsStatusFile = normalized.includes("orchestrator-test-status.md");
    if (
      !(mentionsPending && ((mentionsOrchestrator && mentionsValidation) || mentionsStatusFile))
    ) {
      return false;
    }

    return !/\bpackages\/|\.tsx?\b|\.jsx?\b|line\s+\d+/i.test(text);
  }

  private isPendingValidationOnlyRejection(result: ReviewAgentResult): boolean {
    const summary = result.summary?.trim() ?? "";
    const notes = result.notes?.trim() ?? "";
    const issues = (result.issues ?? []).map((issue) => issue.trim()).filter(Boolean);
    const fragments = [summary, ...issues, notes].filter(Boolean);
    if (fragments.length === 0) return false;

    const hasPendingMention = fragments.some((fragment) =>
      this.isPendingValidationFragment(fragment)
    );
    if (!hasPendingMention) return false;

    if (summary && !this.isPendingValidationFragment(summary)) return false;
    if (issues.some((issue) => !this.isPendingValidationFragment(issue))) return false;

    return true;
  }

  public async clearRateLimitNotifications(projectId: string): Promise<void> {
    try {
      const resolved = await notificationService.resolveRateLimitNotifications(projectId);
      for (const n of resolved) {
        broadcastToProject(projectId, {
          type: "notification.resolved",
          notificationId: n.id,
          projectId,
          source: n.source,
          sourceId: n.sourceId,
        });
      }
    } catch (err) {
      log.warn("Failed to clear rate limit notifications", { projectId, err });
    }
  }

  public async startReviewCoordinatorAndTests(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    settings: import("@opensprint/shared").ProjectSettings,
    changedFiles: string[]
  ): Promise<void> {
    const slot = this.host.getState(projectId).slots.get(task.id);
    if (!slot) return;
    const wtPath = slot.worktreePath ?? repoPath;

    if (wtPath !== repoPath) {
      const integrity = await assertWorktreeIntegrity(repoPath, wtPath, task.id, "review");
      if (!integrity.valid) {
        log.warn("Worktree integrity check failed before review", {
          taskId: task.id,
          failureReason: integrity.failureReason,
          detail: integrity.detail,
          worktreePath: wtPath,
        });
      }
    }

    const testCommand = resolveTestCommand(settings) || undefined;
    const baseBranch = await resolveTaskReviewBase(
      projectId,
      task,
      await resolveBaseBranch(repoPath, settings.worktreeBaseBranch)
    );
    const mergeQualityGates = getMergeQualityGateCommands(settings.toolchainProfile);
    await this.writeReviewTestStatus(task.id, repoPath, wtPath, {
      status: "pending",
      testCommand,
      mergeQualityGates,
    });
    const coordinator = this.createReviewPhaseCoordinator(
      projectId,
      repoPath,
      task,
      branchName,
      settings
    );
    slot.phaseCoordinator = coordinator;

    this.host
      .runAdaptiveValidation(projectId, wtPath, changedFiles, testCommand)
      .then(async (scopedResult) => {
        const sl = this.host.getState(projectId).slots.get(task.id);
        if (!sl) {
          await this.writeReviewTestStatus(task.id, repoPath, wtPath, {
            status: "error",
            testCommand,
            mergeQualityGates,
            errorMessage: "Slot removed during tests",
          });
          void coordinator.setTestOutcome({
            status: "error",
            errorMessage: "Slot removed during tests",
          });
          return;
        }
        sl.phaseResult.testOutput = scopedResult.rawOutput;
        sl.phaseResult.validationCommand = scopedResult.executedCommand ?? testCommand ?? null;
        this.host.clearQualityGateDetail(sl.phaseResult);
        if (scopedResult.failed > 0) {
          const validationCommand = scopedResult.executedCommand ?? testCommand;
          await this.writeReviewTestStatus(task.id, repoPath, wtPath, {
            status: "failed",
            testCommand: validationCommand,
            mergeQualityGates,
            results: scopedResult,
            rawOutput: scopedResult.rawOutput,
          });
          void coordinator.setTestOutcome({
            status: "failed",
            results: scopedResult,
            rawOutput: scopedResult.rawOutput,
          });
        } else {
          sl.phaseResult.testResults = scopedResult;
          await this.host.branchManager.commitWip(wtPath, task.id);
          const qualityGateFailure = await this.host.runTaskWorktreeMergeGatesMaybeDeduped(
            projectId,
            repoPath,
            task,
            branchName,
            wtPath,
            baseBranch,
            settings.toolchainProfile,
            sl
          );
          if (sl.agent.cancelled || this.host.getState(projectId).slots.get(task.id) !== sl) {
            return;
          }
          if (qualityGateFailure) {
            const detail = this.host.applyQualityGateFailure(
              sl.phaseResult,
              qualityGateFailure,
              wtPath
            );
            await this.writeReviewTestStatus(task.id, repoPath, wtPath, {
              status: "failed",
              testCommand: qualityGateFailure.command,
              mergeQualityGates,
              rawOutput: qualityGateFailure.outputSnippet ?? qualityGateFailure.output,
              failureType:
                qualityGateFailure.category === "environment_setup"
                  ? "environment_setup"
                  : "merge_quality_gate",
              qualityGateDetail: detail,
            });
            void coordinator.setTestOutcome({
              status: "failed",
              failureType:
                qualityGateFailure.category === "environment_setup"
                  ? "environment_setup"
                  : "merge_quality_gate",
              rawOutput: qualityGateFailure.outputSnippet ?? qualityGateFailure.output,
              qualityGateDetail: detail,
            });
            return;
          }
          const validationCommand = scopedResult.executedCommand ?? testCommand;
          await this.writeReviewTestStatus(task.id, repoPath, wtPath, {
            status: "passed",
            testCommand: validationCommand,
            mergeQualityGates,
            results: scopedResult,
            mergeGateArtifact: sl.phaseResult.mergeGateArtifactTaskWorktree ?? undefined,
          });
          void coordinator.setTestOutcome({ status: "passed", results: scopedResult });
        }
      })
      .catch((err) => {
        log.error("Background tests failed for task", { taskId: task.id, err });
        void this.writeReviewTestStatus(task.id, repoPath, wtPath, {
          status: "error",
          testCommand,
          mergeQualityGates,
          errorMessage: String(err),
        });
        void coordinator.setTestOutcome({ status: "error", errorMessage: String(err) });
      });
  }

  public createReviewPhaseCoordinator(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    settings: import("@opensprint/shared").ProjectSettings
  ): TaskPhaseCoordinator {
    const angles = (settings.reviewAngles ?? []).filter(Boolean);
    return new TaskPhaseCoordinator(
      task.id,
      (testOutcome, reviewOutcome) =>
        this.resolveTestAndReview(
          projectId,
          repoPath,
          task,
          branchName,
          testOutcome,
          reviewOutcome
        ),
      {
        persistReviewOutcome: async (outcome, angle) => {
          const slot = this.host.getState(projectId).slots.get(task.id);
          if (slot)
            await (this.host.getLocalRecoveryStore?.() ?? localRecoveryStore).rememberReview(
              projectId,
              task.id,
              `${task.created_at ?? "legacy"}:${slot.attempt}`,
              angle ?? "__general_review__",
              outcome
            );
        },
        reviewAngles: settings.reviewAngles,
        includeGeneralReview: settings.includeGeneralReview === true ? true : undefined,
        ...(angles.length > 1 &&
          !settings.includeGeneralReview && {
            synthesizeReviewResults: async (outcomes) => {
              const angleInputs = [...outcomes.entries()]
                .filter(([, o]) => o.result && (o.status === "approved" || o.status === "rejected"))
                .map(([angle, o]) => ({ angle, result: o.result! }));
              if (angleInputs.length === 0) {
                const first = outcomes.values().next().value;
                return first ?? { status: "no_result" as const, result: null, exitCode: null };
              }
              const synthesized = await reviewSynthesizerService.synthesize(
                projectId,
                repoPath,
                task,
                angleInputs,
                this.host.taskStore
              );
              return {
                status: synthesized.status as "approved" | "rejected",
                result: synthesized,
                exitCode: 0,
              };
            },
          }),
      }
    );
  }

  public async writeReviewTestStatus(
    taskId: string,
    repoPath: string,
    wtPath: string,
    status: PersistedOrchestratorTestStatus
  ): Promise<void> {
    const persistedStatus = {
      ...status,
      updatedAt: status.updatedAt ?? new Date().toISOString(),
    } satisfies PersistedOrchestratorTestStatus;
    const bases = new Set([repoPath, wtPath]);
    await Promise.all(
      [...bases].map(async (basePath) => {
        const statusPath = getOrchestratorTestStatusFsPath(basePath, taskId);
        const statePath = getOrchestratorTestStatusStateFsPath(basePath, taskId);
        await fs.mkdir(path.dirname(statusPath), { recursive: true });
        await Promise.all([
          fs.writeFile(statusPath, buildOrchestratorTestStatusContent(persistedStatus), "utf-8"),
          fs.writeFile(statePath, JSON.stringify(persistedStatus, null, 2), "utf-8"),
        ]);
      })
    );
  }

  public async readPersistedReviewTestStatus(
    taskId: string,
    repoPath: string,
    wtPath: string
  ): Promise<PersistedOrchestratorTestStatus | null> {
    const bases = [wtPath, repoPath];
    for (const basePath of bases) {
      try {
        const raw = await fs.readFile(
          getOrchestratorTestStatusStateFsPath(basePath, taskId),
          "utf-8"
        );
        const parsed = JSON.parse(raw) as PersistedOrchestratorTestStatus;
        if (parsed?.status && parsed.status !== "pending") {
          return parsed;
        }
      } catch {
        // Fall back to the legacy markdown-only status file.
      }

      try {
        const raw = await fs.readFile(getOrchestratorTestStatusFsPath(basePath, taskId), "utf-8");
        const parsed = parseOrchestratorTestStatusContent(raw);
        if (parsed?.status && parsed.status !== "pending") {
          return parsed;
        }
      } catch {
        // Ignore missing status files during recovery.
      }
    }
    return null;
  }

  public toRecoveredTestOutcome(status: PersistedOrchestratorTestStatus): TestOutcome | null {
    switch (status.status) {
      case "pending":
        return null;
      case "passed":
        return {
          status: "passed",
          ...(status.results ? { results: status.results } : {}),
        };
      case "failed":
        return {
          status: "failed",
          ...(status.results ? { results: status.results } : {}),
          ...(status.rawOutput ? { rawOutput: status.rawOutput } : {}),
          ...(status.failureType ? { failureType: status.failureType } : {}),
          ...(status.qualityGateDetail ? { qualityGateDetail: status.qualityGateDetail } : {}),
        };
      case "error":
        return {
          status: "error",
          ...(status.errorMessage ? { errorMessage: status.errorMessage } : {}),
          ...(status.rawOutput ? { rawOutput: status.rawOutput } : {}),
          ...(status.failureType ? { failureType: status.failureType } : {}),
          ...(status.qualityGateDetail ? { qualityGateDetail: status.qualityGateDetail } : {}),
        };
    }
  }

  public applyRecoveredTestOutcome(
    phaseResult: PhaseResult,
    outcome: TestOutcome,
    status: PersistedOrchestratorTestStatus
  ): void {
    phaseResult.validationCommand = status.testCommand ?? null;
    phaseResult.testResults = null;
    if (outcome.status === "passed") {
      phaseResult.testResults = outcome.results ?? null;
      phaseResult.testOutput = "";
      this.host.clearQualityGateDetail(phaseResult);
      if (status.mergeGateArtifact) {
        phaseResult.mergeGateArtifactTaskWorktree = status.mergeGateArtifact;
      }
      return;
    }

    phaseResult.testOutput = outcome.rawOutput ?? outcome.errorMessage ?? "";
    if (outcome.status === "failed") {
      phaseResult.testResults = outcome.results ?? null;
    }
    phaseResult.qualityGateDetail = outcome.qualityGateDetail ?? null;
  }

  public async executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    retryContext?: RetryContext,
    reviewTarget?: ReviewRetryTarget
  ): Promise<void> {
    return this.host.phaseExecutor.executeReviewPhase(
      projectId,
      repoPath,
      task,
      branchName,
      retryContext,
      reviewTarget
    );
  }

  private async readReviewResult(
    wtPath: string,
    taskId: string,
    angle?: ReviewAngle
  ): Promise<ReviewAgentResult | null> {
    const { result } = await this.readReviewResultWithRaw(wtPath, taskId, angle);
    return result;
  }

  private async readReviewResultWithRaw(
    wtPath: string,
    taskId: string,
    angle?: ReviewAngle
  ): Promise<{ raw: string | null; result: ReviewAgentResult | null }> {
    const raw = await this.host.sessionManager.readRawResult(wtPath, taskId, angle);
    return {
      raw,
      result: parseReviewAgentResult(raw),
    };
  }

  async retryReviewStructuredOutputRepair(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: AgentSlot,
    rawResult: string | null,
    angle?: ReviewAngle
  ): Promise<boolean> {
    const wtPath = slot.worktreePath ?? repoPath;
    const assignment = await this.host.readAssignmentForRun(wtPath, task.id, angle);
    if (assignment?.retryContext?.structuredOutputRepairAttempted) {
      return false;
    }

    const retryContext: RetryContext = {
      ...(assignment?.retryContext ?? {}),
      previousFailure: describeStructuredOutputProblem({
        fileLabel: angle
          ? `.opensprint/active/${task.id}/review-angles/${angle}/result.json`
          : `.opensprint/active/${task.id}/result.json`,
        rawContent: rawResult,
        expectedShape: REVIEW_RESULT_EXPECTED_SHAPE,
      }),
      useExistingBranch: true,
      structuredOutputRepairAttempted: true,
    };

    log.warn("Retrying reviewer once to repair structured output", {
      projectId,
      taskId: task.id,
      branchName: slot.branchName,
      angle: angle ?? "general",
    });

    await this.executeReviewPhase(
      projectId,
      repoPath,
      task,
      slot.branchName,
      retryContext,
      angle ?? "general"
    );
    return true;
  }

  public async handleReviewDone(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    exitCode: number | null,
    angle?: ReviewAngle
  ): Promise<void> {
    const state = this.host.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) {
      log.warn("handleReviewDone: no slot found for task", { taskId: task.id });
      return;
    }
    if (
      !(await this.host.cleanupSlotIfProjectGone(
        projectId,
        repoPath,
        task.id,
        state,
        slot,
        "handleReviewDone"
      ))
    ) {
      return;
    }
    const wtPath = slot.worktreePath ?? repoPath;
    const { raw: rawResult, result } = await this.readReviewResultWithRaw(wtPath, task.id, angle);

    if (!result) {
      const retried = await this.retryReviewStructuredOutputRepair(
        projectId,
        repoPath,
        task,
        slot,
        rawResult,
        angle
      );
      if (retried) {
        return;
      }
    }

    const reviewAgentState = angle ? slot.reviewAgents?.get(angle) : undefined;
    const killedDueToTimeout =
      reviewAgentState?.agent.killedDueToTimeout ?? slot.agent.killedDueToTimeout;
    const status: ReviewOutcome["status"] =
      result?.status === "approved"
        ? "approved"
        : result?.status === "rejected"
          ? "rejected"
          : "no_result";
    const noResultReason =
      status === "no_result"
        ? await extractNoResultReasonFromLogs(
            wtPath,
            task.id,
            angle ? (reviewAgentState?.agent.outputLog ?? []) : slot.agent.outputLog,
            angle
          )
        : undefined;

    if (slot.phaseCoordinator) {
      if (status === "approved") {
        const runAgent = reviewAgentState?.agent ?? slot.agent;
        const assignment = await this.host.readAssignmentForRun(wtPath, task.id, angle);
        const settings = await this.host.projectService.getSettings(projectId);
        const agentConfig =
          (assignment?.agentConfig as AgentConfig | undefined) ??
          slot.activeAgentConfig ??
          settings.simpleComplexityAgent;
        slot.activeAgentConfig = agentConfig;
        agentIdentityService
          .recordAttempt(repoPath, {
            taskId: task.id,
            agentId: buildAgentAttemptId(agentConfig, "reviewer", {
              reviewScope: angle ?? "general",
            }),
            role: "reviewer",
            model: agentConfig.model ?? "unknown",
            attempt: slot.attempt,
            startedAt: runAgent.startedAt ?? new Date().toISOString(),
            completedAt: new Date().toISOString(),
            outcome: "success",
            durationMs: Math.max(
              0,
              Date.now() - new Date(runAgent.startedAt ?? Date.now()).getTime()
            ),
          })
          .catch((err) =>
            log.warn("Failed to record reviewer run for Agent Log (coordinated approved)", { err })
          );
      }
      await slot.phaseCoordinator.setReviewOutcome(
        {
          status,
          result,
          exitCode,
          ...(status === "no_result" && {
            failureContext: [
              {
                ...(angle && { angle }),
                exitCode,
                ...(noResultReason && { reason: noResultReason }),
              },
            ],
          }),
        },
        angle
      );
      if (angle) {
        slot.reviewAgents?.delete(angle as ReviewAngle);
        if (slot.reviewAgents && slot.reviewAgents.size === 0) {
          slot.reviewAgents = undefined;
        }
      }
      return;
    }

    if (result && result.status === "approved") {
      const assignment = await this.host.readAssignmentForRun(wtPath, task.id);
      const settings = await this.host.projectService.getSettings(projectId);
      const agentConfig =
        (assignment?.agentConfig as AgentConfig | undefined) ??
        slot.activeAgentConfig ??
        settings.simpleComplexityAgent;
      slot.activeAgentConfig = agentConfig;
      agentIdentityService
        .recordAttempt(repoPath, {
          taskId: task.id,
          agentId: buildAgentAttemptId(agentConfig, "reviewer", {
            reviewScope: "general",
          }),
          role: "reviewer",
          model: agentConfig.model ?? "unknown",
          attempt: slot.attempt,
          startedAt: slot.agent.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          outcome: "success",
          durationMs: Math.max(
            0,
            Date.now() - new Date(slot.agent.startedAt ?? Date.now()).getTime()
          ),
        })
        .catch((err) =>
          log.warn("Failed to record reviewer run for Agent Log (approved)", { err })
        );
      await this.acceptApprovedReview(projectId, repoPath, task, branchName, wtPath);
    } else if (result && result.status === "rejected") {
      await this.handleReviewRejection(projectId, repoPath, task, branchName, result);
    } else {
      const failureType: FailureType = killedDueToTimeout
        ? "timeout"
        : exitCode === 143 || exitCode === 137
          ? "agent_crash"
          : "no_result";
      const noResultReasonCode =
        failureType === "no_result"
          ? classifyNoResultReasonCode({
              rawResult,
              readFailure: null,
              agentOutputHint: noResultReason,
            })
          : undefined;
      slot.agent.killedDueToTimeout = false;
      if (reviewAgentState) reviewAgentState.agent.killedDueToTimeout = false;
      await this.host.failureHandler.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        angle
          ? `Review agent (${angle}) exited with code ${exitCode} without producing a valid result${noResultReason ? ` (${noResultReason})` : ""}`
          : `Review agent exited with code ${exitCode} without producing a valid result${noResultReason ? ` (${noResultReason})` : ""}`,
        null,
        failureType,
        undefined,
        { reviewScope: angle ?? "general", noResultReasonCode }
      );
    }
  }

  public async resolveTestAndReview(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    testOutcome: TestOutcome,
    reviewOutcome: ReviewOutcome
  ): Promise<void> {
    const state = this.host.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) return;

    try {
      if (testOutcome.status === "failed") {
        if (
          testOutcome.failureType === "merge_quality_gate" ||
          testOutcome.failureType === "environment_setup"
        ) {
          if (testOutcome.qualityGateDetail) {
            slot.phaseResult.qualityGateDetail = testOutcome.qualityGateDetail;
          }
          await this.host.failureHandler.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            this.host.formatQualityGateFailureReason(
              slot.phaseResult.qualityGateDetail ?? testOutcome.qualityGateDetail,
              testOutcome.failureType
            ),
            null,
            testOutcome.failureType
          );
          return;
        }
        const r = testOutcome.results ?? {
          passed: 0,
          failed: 0,
          skipped: 0,
          total: 0,
          details: [],
        };
        await this.host.failureHandler.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Tests failed: ${r.failed} failed, ${r.passed} passed`,
          r,
          "test_failure"
        );
        return;
      }
      if (testOutcome.status === "error") {
        if (
          testOutcome.failureType === "merge_quality_gate" ||
          testOutcome.failureType === "environment_setup"
        ) {
          if (testOutcome.qualityGateDetail) {
            slot.phaseResult.qualityGateDetail = testOutcome.qualityGateDetail;
          }
          await this.host.failureHandler.handleTaskFailure(
            projectId,
            repoPath,
            task,
            branchName,
            this.host.formatQualityGateFailureReason(
              slot.phaseResult.qualityGateDetail ?? testOutcome.qualityGateDetail,
              testOutcome.failureType
            ),
            null,
            testOutcome.failureType
          );
          return;
        }
        await this.host.failureHandler.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          testOutcome.errorMessage ?? "Test runner error",
          null,
          "test_failure"
        );
        return;
      }

      if (reviewOutcome.status === "approved") {
        await this.acceptApprovedReview(
          projectId,
          repoPath,
          task,
          branchName,
          slot.worktreePath ?? repoPath
        );
      } else if (reviewOutcome.status === "rejected") {
        const pin = await governanceService.getTaskPin(projectId, task.id);
        if (!pin && this.isPendingValidationOnlyRejection(reviewOutcome.result!)) {
          log.warn("Ignoring review rejection caused only by pending validation status", {
            projectId,
            taskId: task.id,
          });
          await this.host.mergeCoordinator.performMergeAndDone(
            projectId,
            repoPath,
            task,
            branchName
          );
          return;
        }
        await this.handleReviewRejection(
          projectId,
          repoPath,
          task,
          branchName,
          reviewOutcome.result!
        );
      } else {
        const failureType: FailureType = "no_result";
        const noResultReason = buildReviewNoResultFailureReason(reviewOutcome);
        await this.host.failureHandler.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          noResultReason,
          null,
          failureType
        );
      }
    } catch (err) {
      const reason = `Failed to finalize review/test outcome: ${getErrorMessage(err)}`;
      log.error("resolveTestAndReview failed", {
        projectId,
        taskId: task.id,
        branchName,
        err: getErrorMessage(err),
      });
      await this.host.failureHandler.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        reason,
        null,
        "agent_crash"
      );
    }
  }

  /** Every approval reaches the merge the same way, so none can skip the durable review record. */
  private async acceptApprovedReview(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    cwd: string
  ): Promise<void> {
    await governanceExecutionService.approved(projectId, task.id, cwd);
    await acceptRemoteReviewIfRequested({ projectId, task, repoPath, cwd, branchName });
    await this.host.mergeCoordinator.performMergeAndDone(projectId, repoPath, task, branchName);
  }

  public async handleReviewRejection(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    branchName: string,
    result: ReviewAgentResult
  ): Promise<void> {
    const state = this.host.getState(projectId);
    const slot = state.slots.get(task.id);
    if (!slot) return;
    const wtPath = slot.worktreePath ?? repoPath;

    const adjudication = await governanceExecutionService.rejected({
      projectId,
      taskId: task.id,
      cwd: wtPath,
      title: String(task.title ?? task.id),
      result,
      appeals: slot.phaseResult.governanceAppeals ?? [],
      reviewOutput: slot.agent.outputLog.join(""),
      reviewerAgent: slot.activeAgentConfig,
      attempt: slot.attempt,
      invocationId: (await this.host.readAssignmentForRun(wtPath, task.id))?.invocationId,
    });
    if (adjudication.authorized) {
      await this.acceptApprovedReview(projectId, repoPath, task, branchName, wtPath);
      return;
    }
    if (adjudication.waiting) {
      // Case/task hold has already been committed; dropping the in-memory slot is restart safe.
      if (this.host.pauseForGovernance)
        await this.host.pauseForGovernance(projectId, repoPath, task.id);
      else {
        slot.timers.clearAll();
        state.slots.delete(task.id);
        await this.host.persistCounters(projectId, repoPath);
      }
      return;
    }

    const reason = `Review rejected: ${result.issues?.join("; ") || result.summary || "No details provided"}`;
    const reviewFeedback = formatReviewFeedback(result);
    const rejectionSummary = buildTaskLastExecutionSummary({
      attempt: slot.attempt,
      outcome: "rejected",
      phase: "review",
      failureType: "review_rejection",
      summary: compactExecutionText(reason, 500),
    });

    const settings = await this.host.projectService.getSettings(projectId);
    const baseBranch = await resolveTaskReviewBase(
      projectId,
      task,
      await resolveBaseBranch(repoPath, settings.worktreeBaseBranch)
    );
    let gitDiff = "";
    try {
      const branchDiff = await this.host.branchManager.captureBranchDiff(
        repoPath,
        branchName,
        baseBranch
      );
      const uncommittedDiff = await this.host.branchManager.captureUncommittedDiff(wtPath);
      gitDiff = [branchDiff, uncommittedDiff]
        .filter(Boolean)
        .join("\n\n--- Uncommitted changes ---\n\n");
    } catch {
      // Best-effort capture
    }
    const session = await this.host.sessionManager.createSession(repoPath, {
      taskId: task.id,
      attempt: slot.attempt,
      agentType: settings.simpleComplexityAgent.type,
      agentModel: settings.simpleComplexityAgent.model || "",
      gitBranch: branchName,
      status: "rejected",
      outputLog: slot.agent.outputLog.join(""),
      failureReason: result.summary || "Review rejected (no summary provided)",
      gitDiff: gitDiff || undefined,
      startedAt: slot.agent.startedAt,
      debugArtifactSummary: summarizeDebugArtifact(result.debugArtifact),
      repairIterations: result.debugArtifact ? 1 : 0,
      rootCauseCategory: result.debugArtifact?.rootCauseCategory ?? null,
    });
    await this.host.sessionManager.archiveSession(repoPath, task.id, slot.attempt, session, wtPath);
    await persistTaskLastExecutionSummary(
      this.host.taskStore,
      projectId,
      task.id,
      rejectionSummary
    );
    fireAndForget(
      eventLogService.append(repoPath, {
        timestamp: new Date().toISOString(),
        projectId,
        taskId: task.id,
        event: "review.rejected",
        data: {
          attempt: slot.attempt,
          phase: "review",
          failureType: "review_rejection",
          model: settings.simpleComplexityAgent.model ?? null,
          summary: rejectionSummary.summary,
          reason,
          nextAction: "Retry coding with review feedback",
        },
      }),
      "orchestrator-review:review.rejected"
    );

    await this.host.failureHandler.handleTaskFailure(
      projectId,
      repoPath,
      task,
      branchName,
      reason,
      null,
      "review_rejection",
      reviewFeedback,
      { agentDebugArtifact: result.debugArtifact, reviewScope: "general" }
    );
  }

  public async buildReviewHistory(repoPath: string, taskId: string): Promise<string> {
    try {
      const sessions = await this.host.sessionManager.listSessions(repoPath, taskId);
      const rejections = sessions
        .filter((s) => s.status === "rejected")
        .sort((a, b) => a.attempt - b.attempt);

      if (rejections.length === 0) return "";

      const parts: string[] = [];
      for (const session of rejections) {
        parts.push(`### Attempt ${session.attempt} — Rejected`);
        if (session.failureReason) {
          parts.push(`\n**Reason:** ${session.failureReason}`);
        }
        parts.push("");
      }
      return parts.join("\n");
    } catch {
      return "";
    }
  }
}
