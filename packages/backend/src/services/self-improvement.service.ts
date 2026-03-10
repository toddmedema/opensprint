/**
 * SelfImprovementService — orchestrates self-improvement runs: change detection,
 * single run per project (delegated to runner), and invoking the review path.
 * Runs change detection (hasCodeChangesSince) before triggering; if repo unchanged, returns without running.
 */

import { ProjectService } from "./project.service.js";
import { hasCodeChangesSince } from "./self-improvement-change-detection.js";
import {
  runSelfImprovement,
  type RunSelfImprovementOptions,
  type RunSelfImprovementResult,
} from "./self-improvement-runner.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("self-improvement");

/** Result of SelfImprovementService.run: success, skipped (in progress), or skipped (no changes). */
export type SelfImprovementRunResult =
  | RunSelfImprovementResult
  | { tasksCreated: 0; skipped: "no_changes" };

/** Options for runIfDue: trigger and context (e.g. planId when trigger is after_each_plan). */
export interface RunIfDueOptions {
  trigger: "after_each_plan";
  planId: string;
}

/**
 * Self-improvement service: one run per project (in runner), change detection before run,
 * then delegates to runner for context build, Reviewer (or equivalent) invocation, parse, and task creation.
 */
export class SelfImprovementService {
  private projectService = new ProjectService();

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

  /**
   * Run self-improvement if due for the given trigger (e.g. after_each_plan).
   * Checks settings.selfImprovementFrequency matches the trigger, then change detection, then runs.
   * Does not run when user clicks Execute; call only when plan execution is fully complete (epic closed, merged).
   */
  async runIfDue(
    projectId: string,
    options: RunIfDueOptions
  ): Promise<SelfImprovementRunResult | { tasksCreated: 0; skipped: "frequency_not_due" }> {
    if (options.trigger !== "after_each_plan") {
      return { tasksCreated: 0, skipped: "frequency_not_due" };
    }
    const settings = await this.projectService.getSettings(projectId);
    if (settings.selfImprovementFrequency !== "after_each_plan") {
      log.debug("Self-improvement skipped: frequency not after_each_plan", {
        projectId,
        frequency: settings.selfImprovementFrequency ?? "never",
      });
      return { tasksCreated: 0, skipped: "frequency_not_due" };
    }
    return this.run(projectId, { planId: options.planId });
  }
}

export const selfImprovementService = new SelfImprovementService();
