/**
 * SelfImprovementService — orchestrates self-improvement runs: change detection,
 * single run per project (delegated to runner), and invoking the review path.
 * Runs change detection (hasCodeChangesSince) before triggering; if repo unchanged, returns without running.
 */

import { ProjectService } from "./project.service.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";
import { hasCodeChangesSince } from "./self-improvement-change-detection.js";
import {
  runSelfImprovement,
  type RunSelfImprovementOptions,
  type RunSelfImprovementResult,
} from "./self-improvement-runner.service.js";
import { taskStore } from "./task-store.service.js";
import { createLogger } from "../utils/logger.js";
import { updateSettingsInStore } from "./settings-store.service.js";
import { notificationService } from "./notification.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { runBehaviorVersionStoreWrite } from "./behavior-version-store.service.js";
import { runGovernanceCongress } from "./congress.service.js";
import { governanceService } from "./governance.service.js";

const log = createLogger("self-improvement");
const BASELINE_QUALITY_GATE_TASK_SOURCE = "merge-quality-gate-baseline";
const BASELINE_QUALITY_GATE_TASK_COMPLEXITY = 6;
const BASELINE_QUALITY_GATE_REASON_LIMIT = 1200;
const BASELINE_QUALITY_GATE_OUTPUT_LIMIT = 2400;
const BASELINE_QUALITY_GATE_REOPEN_WINDOW_MS = 60 * 60 * 1000;

/** Result of SelfImprovementService.run: success, skipped (in progress), or skipped (no changes). */
export type SelfImprovementRunResult =
  | RunSelfImprovementResult
  | { tasksCreated: 0; skipped: "no_changes" };

/** Trigger for runIfDue: scheduled (daily/weekly tick) or after plan execution. */
export type SelfImprovementTrigger = "scheduled" | "after_each_plan";

export interface SelfImprovementBehaviorStatus {
  pendingCandidateId?: string;
  activeBehaviorVersionId?: string;
  behaviorVersions: Array<{ id: string; promotedAt: string }>;
  history: Array<{
    timestamp: string;
    action: "approved" | "rejected" | "rollback";
    behaviorVersionId?: string;
    candidateId?: string;
  }>;
}

/** Options for runIfDue: trigger and context (e.g. planId when trigger is after_each_plan). */
export type RunIfDueOptions =
  | { trigger: "after_each_plan"; planId: string }
  | { trigger: "scheduled" };

export interface BaselineQualityGateTaskInput {
  baseBranch: string;
  command: string;
  reason: string;
  outputSnippet?: string | null;
  worktreePath?: string | null;
  firstErrorLine?: string | null;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root" | null;
}

export type BaselineRemediationTaskAction = "created" | "updated" | "reopened";

function truncateText(value: string | null | undefined, maxLen: number): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen).trimEnd()}...`;
}

function buildBaselineFailureFingerprint(input: BaselineQualityGateTaskInput): string {
  const command = input.command.trim().toLowerCase();
  const firstErrorLine = (input.firstErrorLine ?? input.reason).trim().toLowerCase();
  const workspace = (input.validationWorkspace ?? "unknown").trim().toLowerCase();
  return `${command}|${firstErrorLine}|${workspace}`.slice(0, 600);
}

/**
 * Self-improvement service: one run per project (in runner), change detection before run,
 * then delegates to runner for context build, Reviewer (or equivalent) invocation, parse, and task creation.
 */
export class SelfImprovementService {
  private projectService = new ProjectService();
  private baselineTaskUpsertInFlight = new Map<
    string,
    Promise<{ taskId: string; created: boolean; action: BaselineRemediationTaskAction }>
  >();

  private buildBaselineQualityGateTaskTitle(baseBranch: string): string {
    return `Restore baseline quality gates on ${baseBranch}`;
  }

  private toBehaviorStatus(settings: {
    selfImprovementPendingCandidateId?: string;
    selfImprovementActiveBehaviorVersionId?: string;
    selfImprovementBehaviorVersions?: Array<{ id: string; promotedAt: string }>;
    selfImprovementBehaviorHistory?: Array<{
      timestamp: string;
      action: "approved" | "rejected" | "rollback";
      behaviorVersionId?: string;
      candidateId?: string;
    }>;
  }): SelfImprovementBehaviorStatus {
    return {
      ...(settings.selfImprovementPendingCandidateId && {
        pendingCandidateId: settings.selfImprovementPendingCandidateId,
      }),
      ...(settings.selfImprovementActiveBehaviorVersionId && {
        activeBehaviorVersionId: settings.selfImprovementActiveBehaviorVersionId,
      }),
      behaviorVersions: settings.selfImprovementBehaviorVersions ?? [],
      history: settings.selfImprovementBehaviorHistory ?? [],
    };
  }

  async approvePendingCandidate(
    projectId: string,
    requestedCandidateId?: string
  ): Promise<SelfImprovementBehaviorStatus> {
    const settings = await this.projectService.getSettings(projectId);
    const pendingCandidateId = settings.selfImprovementPendingCandidateId;
    if (!pendingCandidateId) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, "No pending self-improvement candidate");
    }
    if (requestedCandidateId && requestedCandidateId !== pendingCandidateId) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "candidateId does not match pending candidate"
      );
    }

    const now = new Date().toISOString();
    await updateSettingsInStore(projectId, settings, (current) => {
      const versions = current.selfImprovementBehaviorVersions ?? [];
      const hasVersion = versions.some((v) => v.id === pendingCandidateId);
      const nextVersions = hasVersion
        ? versions
        : [...versions, { id: pendingCandidateId, promotedAt: now }];
      const history = current.selfImprovementBehaviorHistory ?? [];
      return {
        ...current,
        selfImprovementPendingCandidateId: undefined,
        selfImprovementActiveBehaviorVersionId: pendingCandidateId,
        selfImprovementBehaviorVersions: nextVersions,
        selfImprovementBehaviorHistory: [
          ...history,
          {
            timestamp: now,
            action: "approved",
            behaviorVersionId: pendingCandidateId,
            candidateId: pendingCandidateId,
          },
        ],
      };
    });

    await notificationService.resolveSelfImprovementApprovalNotifications(
      projectId,
      pendingCandidateId
    );
    await runBehaviorVersionStoreWrite((store) =>
      store.promoteToActive(projectId, pendingCandidateId, now, null)
    );
    const updated = await this.projectService.getSettings(projectId);
    return this.toBehaviorStatus(updated);
  }

  async rejectPendingCandidate(
    projectId: string,
    requestedCandidateId?: string
  ): Promise<SelfImprovementBehaviorStatus> {
    const settings = await this.projectService.getSettings(projectId);
    const pendingCandidateId = settings.selfImprovementPendingCandidateId;
    if (!pendingCandidateId) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, "No pending self-improvement candidate");
    }
    if (requestedCandidateId && requestedCandidateId !== pendingCandidateId) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "candidateId does not match pending candidate"
      );
    }

    const now = new Date().toISOString();
    await updateSettingsInStore(projectId, settings, (current) => {
      const history = current.selfImprovementBehaviorHistory ?? [];
      return {
        ...current,
        selfImprovementPendingCandidateId: undefined,
        selfImprovementBehaviorHistory: [
          ...history,
          {
            timestamp: now,
            action: "rejected",
            candidateId: pendingCandidateId,
          },
        ],
      };
    });

    await notificationService.resolveSelfImprovementApprovalNotifications(
      projectId,
      pendingCandidateId
    );
    const updated = await this.projectService.getSettings(projectId);
    return this.toBehaviorStatus(updated);
  }

  async rollbackToBehaviorVersion(
    projectId: string,
    behaviorVersionId: string
  ): Promise<SelfImprovementBehaviorStatus> {
    const settings = await this.projectService.getSettings(projectId);
    const versions = settings.selfImprovementBehaviorVersions ?? [];
    const exists = versions.some((v) => v.id === behaviorVersionId);
    if (!exists) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "behaviorVersionId is not a promoted version for this project"
      );
    }

    const now = new Date().toISOString();
    await updateSettingsInStore(projectId, settings, (current) => {
      const history = current.selfImprovementBehaviorHistory ?? [];
      return {
        ...current,
        selfImprovementActiveBehaviorVersionId: behaviorVersionId,
        selfImprovementBehaviorHistory: [
          ...history,
          {
            timestamp: now,
            action: "rollback",
            behaviorVersionId,
          },
        ],
      };
    });

    await runBehaviorVersionStoreWrite((store) =>
      store.setActivePromoted(projectId, behaviorVersionId)
    );

    const updated = await this.projectService.getSettings(projectId);
    return this.toBehaviorStatus(updated);
  }

  private buildBaselineQualityGateTaskDescription(
    input: BaselineQualityGateTaskInput,
    mergeQualityGateCommands: string[]
  ): string {
    const commands = mergeQualityGateCommands;
    const reason =
      truncateText(input.reason, BASELINE_QUALITY_GATE_REASON_LIMIT) || "Unknown failure";
    const outputSnippet = truncateText(input.outputSnippet, BASELINE_QUALITY_GATE_OUTPUT_LIMIT);
    const lines = [
      `Open Sprint detected that the baseline merge quality gates on \`${input.baseBranch}\` are failing, but allowed task merges to continue.`,
      "",
      "Restore the baseline quickly so merges back to main stay trustworthy.",
      "",
      `Failed command: \`${input.command}\``,
      `Base branch: \`${input.baseBranch}\``,
      `Expected passing commands: ${commands.map((command) => `\`${command}\``).join(", ")}`,
      ...(input.firstErrorLine
        ? ["", `First actionable error: \`${truncateText(input.firstErrorLine, 500)}\``]
        : []),
      "",
      "Failure reason:",
      "```",
      reason,
      "```",
      ...(outputSnippet ? ["", "Latest output snippet:", "```", outputSnippet, "```"] : []),
    ];
    return lines.join("\n");
  }

  async ensureBaselineQualityGateTask(
    projectId: string,
    input: BaselineQualityGateTaskInput
  ): Promise<{ taskId: string; created: boolean; action: BaselineRemediationTaskAction }> {
    const lockKey = `${projectId}:${input.baseBranch}`;
    const inFlight = this.baselineTaskUpsertInFlight.get(lockKey);
    if (inFlight) {
      return inFlight;
    }

    const upsertPromise = (async (): Promise<{
      taskId: string;
      created: boolean;
      action: BaselineRemediationTaskAction;
    }> => {
      const settings = await this.projectService.getSettings(projectId);
      const mergeQualityGateCommands = getMergeQualityGateCommands(settings.toolchainProfile);
      const title = this.buildBaselineQualityGateTaskTitle(input.baseBranch);
      const description = this.buildBaselineQualityGateTaskDescription(
        input,
        mergeQualityGateCommands
      );
      const reason = truncateText(input.reason, BASELINE_QUALITY_GATE_REASON_LIMIT);
      const outputSnippet = truncateText(input.outputSnippet, BASELINE_QUALITY_GATE_OUTPUT_LIMIT);
      const fingerprint = buildBaselineFailureFingerprint(input);
      const observedAtIso = new Date().toISOString();
      const extra = {
        source: "self-improvement",
        selfImprovementKind: "baseline-quality-gate",
        baselineQualityGateSource: BASELINE_QUALITY_GATE_TASK_SOURCE,
        baselineBaseBranch: input.baseBranch,
        failedGateCommand: input.command,
        failedGateReason: reason,
        failedGateOutputSnippet: outputSnippet,
        firstErrorLine: input.firstErrorLine?.trim() || null,
        worktreePath: input.worktreePath ?? null,
        validationWorkspace: input.validationWorkspace ?? null,
        baselineFailureFingerprint: fingerprint,
        baselineFailureObservedAt: observedAtIso,
        baselineQualityGateCommands: mergeQualityGateCommands,
      };

      const allTasks = await taskStore.listAll(projectId);
      const existing = allTasks.find((task) => {
        const status = (task.status as string) ?? "open";
        if (status === "closed") return false;
        const source = (task as { source?: unknown }).source;
        const kind = (task as { selfImprovementKind?: unknown }).selfImprovementKind;
        const sourceId = (task as { baselineQualityGateSource?: unknown })
          .baselineQualityGateSource;
        const baseBranch = (task as { baselineBaseBranch?: unknown }).baselineBaseBranch;
        return (
          source === "self-improvement" &&
          (kind === "baseline-quality-gate" || sourceId === BASELINE_QUALITY_GATE_TASK_SOURCE) &&
          baseBranch === input.baseBranch
        );
      });

      if (existing) {
        await taskStore.update(projectId, existing.id, {
          title,
          description,
          priority: 0,
          complexity: BASELINE_QUALITY_GATE_TASK_COMPLEXITY,
          extra,
        });
        return { taskId: existing.id, created: false, action: "updated" };
      }

      const nowMs = Date.now();
      const recentlyClosedMatch = allTasks.find((task) => {
        const status = (task.status as string) ?? "open";
        if (status !== "closed") return false;
        const source = (task as { source?: unknown }).source;
        const kind = (task as { selfImprovementKind?: unknown }).selfImprovementKind;
        const sourceId = (task as { baselineQualityGateSource?: unknown })
          .baselineQualityGateSource;
        const baseBranch = (task as { baselineBaseBranch?: unknown }).baselineBaseBranch;
        const existingFingerprint = (task as { baselineFailureFingerprint?: unknown })
          .baselineFailureFingerprint;
        if (
          source !== "self-improvement" ||
          (kind !== "baseline-quality-gate" && sourceId !== BASELINE_QUALITY_GATE_TASK_SOURCE) ||
          baseBranch !== input.baseBranch ||
          existingFingerprint !== fingerprint
        ) {
          return false;
        }
        const updatedAtRaw = (task.updated_at as string | undefined) ?? "";
        const updatedAtMs = Date.parse(updatedAtRaw);
        return (
          Number.isFinite(updatedAtMs) &&
          nowMs - updatedAtMs <= BASELINE_QUALITY_GATE_REOPEN_WINDOW_MS
        );
      });
      if (recentlyClosedMatch) {
        await taskStore.update(projectId, recentlyClosedMatch.id, {
          status: "open",
          assignee: "",
          title,
          description,
          priority: 0,
          complexity: BASELINE_QUALITY_GATE_TASK_COMPLEXITY,
          extra,
        });
        return { taskId: recentlyClosedMatch.id, created: false, action: "reopened" };
      }

      const created = await taskStore.create(projectId, title, {
        type: "bug",
        priority: 0,
        description,
        complexity: BASELINE_QUALITY_GATE_TASK_COMPLEXITY,
        extra,
      });
      log.info("Created self-improvement task for baseline quality-gate failure", {
        projectId,
        taskId: created.id,
        baseBranch: input.baseBranch,
        command: input.command,
      });
      return { taskId: created.id, created: true, action: "created" };
    })();

    this.baselineTaskUpsertInFlight.set(lockKey, upsertPromise);
    try {
      return await upsertPromise;
    } finally {
      const active = this.baselineTaskUpsertInFlight.get(lockKey);
      if (active === upsertPromise) {
        this.baselineTaskUpsertInFlight.delete(lockKey);
      }
    }
  }

  /**
   * Run self-improvement if the trigger matches project frequency, then run change detection and flow.
   * For trigger 'scheduled': only runs when settings.selfImprovementFrequency is 'daily' or 'weekly'.
   * For trigger 'after_each_plan': only runs when frequency is 'after_each_plan'.
   * Otherwise returns without running.
   */
  async runIfDue(
    projectId: string,
    options: RunIfDueOptions
  ): Promise<SelfImprovementRunResult | { tasksCreated: 0; skipped: "frequency_not_due" }> {
    const settings = await this.projectService.getSettings(projectId);
    const freq = settings.selfImprovementFrequency ?? "never";

    if (options.trigger === "scheduled") {
      if (freq !== "daily" && freq !== "weekly") return { tasksCreated: 0, skipped: "no_changes" };
      return this.run(projectId, { trigger: "scheduled" });
    }
    if (options.trigger === "after_each_plan") {
      if (freq !== "after_each_plan") {
        log.debug("Self-improvement skipped: frequency not after_each_plan", {
          projectId,
          frequency: freq,
        });
        return { tasksCreated: 0, skipped: "frequency_not_due" };
      }
      return this.run(projectId, { planId: options.planId });
    }
    return { tasksCreated: 0, skipped: "no_changes" };
  }

  /**
   * Run self-improvement for a project if the repo has changed since last run.
   * (1) Only one run per project at a time (enforced by runner).
   * (2) Change detection: if unchanged, return without running.
   * (3) Runner builds context, invokes Reviewer (or equivalent), parses output, creates tasks, updates lastRun.
   * On Reviewer failure/timeout the runner does not update lastRunAt.
   */
  async run(
    projectId: string,
    options?: RunSelfImprovementOptions
  ): Promise<SelfImprovementRunResult> {
    // Rulings are new evidence even when the repository commit has not changed.
    try {
      if (!(await governanceService.isGovernanceInactive(projectId)))
        await runGovernanceCongress(projectId);
    } catch (err) {
      log.warn("Governance congress failed; continuing self-improvement", { projectId, err });
    }
    const project = await this.projectService.getProject(projectId);
    const settings = await this.projectService.getSettings(projectId);
    const repoPath = project.repoPath;
    const lastRunAt = settings.selfImprovementLastRunAt;
    const lastSha = settings.selfImprovementLastCommitSha;
    const baseBranch = settings.worktreeBaseBranch;

    const hasChanged = await hasCodeChangesSince(repoPath, {
      sinceTimestamp: lastRunAt,
      sinceCommitSha: lastSha,
      baseBranch: baseBranch ?? undefined,
    });

    if (!hasChanged) {
      log.debug("Self-improvement skipped: no changes since last run", {
        projectId,
        lastRunAt: lastRunAt ?? "(none)",
      });
      return { tasksCreated: 0, skipped: "no_changes" };
    }

    return runSelfImprovement(projectId, options);
  }
}

export const selfImprovementService = new SelfImprovementService();
