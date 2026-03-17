import fs from "fs/promises";
import path from "path";
import {
  OPENSPRINT_PATHS,
  REVIEW_ANGLE_OPTIONS,
  SPEC_MD,
  prdToSpecMarkdown,
} from "@opensprint/shared";
import type { ActiveTaskConfig, ReviewAngle } from "@opensprint/shared";
import { buildAutonomyDescription } from "./autonomy-description.js";
import { BranchManager } from "./branch-manager.js";
import { PrdService } from "./prd.service.js";
import { ChatService } from "./chat.service.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { getMergeQualityGateCommands } from "./merge-quality-gates.js";
import type { TaskStoreService } from "./task-store.service.js";
import type { StoredTask } from "./task-store.service.js";
import { notificationService } from "./notification.service.js";
import { getRuntimePath } from "../utils/runtime-dir.js";
import { getSafeTaskActiveDir } from "../utils/path-safety.js";
import { getOrchestratorTestStatusPromptPath } from "./orchestrator-test-status.js";

/** Short checklist items per review angle for angle-specific prompts. Exported for epic final review. */
export const REVIEW_ANGLE_CHECKLISTS: Record<ReviewAngle, string[]> = {
  security: [
    "No injection vulnerabilities (SQL, command, XSS)",
    "Sensitive data is not logged or exposed",
    "Authentication/authorization is correctly enforced",
    "Input validation and sanitization where needed",
  ],
  performance: [
    "No N+1 queries or unnecessary loops",
    "Heavy operations are not on the hot path",
    "Caching considered where appropriate",
    "No obvious memory leaks or unbounded growth",
  ],
  test_coverage: [
    "Target 80–90% coverage for new/changed code — do not demand near-100%.",
    "Tests verify overall behavior aligned with the spec and acceptance criteria.",
    "Critical paths, main flows, and important edge/error paths are covered.",
    "Prefer behavior-focused tests; avoid over-precise tests that lock implementation details and break on small refactors.",
  ],
  code_quality: [
    "Code is readable and well-named",
    "No dead code, unused imports, or commented-out blocks",
    "Follows existing codebase patterns",
    "Complex logic has explanatory comments",
  ],
  design_ux_accessibility: [
    "UI is usable and intuitive",
    "Accessibility: focus order, labels, contrast",
    "Responsive behavior where applicable",
    "No obvious UX regressions",
  ],
};

export { buildAutonomyDescription };

export interface TaskContext {
  taskId: string;
  title: string;
  description: string;
  planContent: string;
  /** True when task originated from feedback (sourceFeedbackIds/Feedback ID marker). */
  isFeedbackTask?: boolean;
  prdExcerpt: string;
  dependencyOutputs: Array<{ taskId: string; diff: string; summary: string }>;
  /** Past review rejection history (populated by orchestrator for review phase) */
  reviewHistory?: string;
  /** Branch diff (main...branch) from main repo; written to context/implementation.diff for review so Reviewer does not run git from worktree */
  branchDiff?: string;
  /** User's answer from Execute open-questions chat (task context + answer). Enables Coder to resolve "this task" references. */
  userClarification?: string;
}

/**
 * Assembles context for agent prompts:
 * - Extracts relevant PRD sections
 * - Reads the parent Plan markdown
 * - Collects diffs/summaries from completed dependency tasks
 * - Generates prompt.md per the coding/review templates
 */
export class ContextAssembler {
  private branchManager = new BranchManager();
  private _chatService: ChatService | null = null;
  private get chatService(): ChatService {
    if (!this._chatService) this._chatService = new ChatService();
    return this._chatService;
  }

  /**
   * Set up the task directory with all necessary context files.
   */
  async assembleTaskDirectory(
    repoPath: string,
    taskId: string,
    config: ActiveTaskConfig,
    context: TaskContext
  ): Promise<string> {
    const taskDir = getSafeTaskActiveDir(repoPath, taskId);
    const contextDir = path.join(taskDir, "context");
    const depsDir = path.join(contextDir, "deps");

    await fs.mkdir(depsDir, { recursive: true });

    // Write config.json
    await fs.writeFile(path.join(taskDir, "config.json"), JSON.stringify(config, null, 2));

    // Write context files
    await fs.writeFile(path.join(contextDir, "spec.md"), context.prdExcerpt);

    await fs.writeFile(path.join(contextDir, "plan.md"), context.planContent);

    // Write dependency outputs
    for (const dep of context.dependencyOutputs) {
      await fs.writeFile(path.join(depsDir, `${dep.taskId}.diff`), dep.diff);
      await fs.writeFile(path.join(depsDir, `${dep.taskId}.summary.md`), dep.summary);
    }

    if (context.branchDiff != null && context.branchDiff !== "") {
      await fs.writeFile(path.join(contextDir, "implementation.diff"), context.branchDiff);
    }

    // Generate prompt(s) — inject agent instructions (AGENTS.md + role-specific) per acceptance criteria
    // agentRole from config (phase 'coding' maps to coder, 'review' to reviewer)
    const agentRole = config.agent_role;
    const agentInstructions = await getCombinedInstructions(repoPath, agentRole);
    if (config.phase === "coding") {
      const prompt = this.buildPromptWithInstructions(
        agentInstructions,
        this.generateCodingPrompt(config, context)
      );
      await fs.writeFile(path.join(taskDir, "prompt.md"), prompt);
    } else {
      const agentInstructions = await getCombinedInstructions(repoPath, "reviewer");
      const reviewAngles = config.reviewAngles;
      const includeGeneral =
        config.includeGeneralReview === true && reviewAngles && reviewAngles.length > 0;
      if (reviewAngles && reviewAngles.length > 0) {
        // Angle-specific: create review-angles/<angle>/ per angle
        for (const angle of reviewAngles as ReviewAngle[]) {
          const angleDir = path.join(taskDir, "review-angles", angle);
          await fs.mkdir(angleDir, { recursive: true });
          const prompt = this.buildPromptWithInstructions(
            agentInstructions,
            this.generateReviewPromptForAngle(config, context, angle)
          );
          await fs.writeFile(path.join(angleDir, "prompt.md"), prompt);
          await fs.writeFile(
            path.join(angleDir, "config.json"),
            JSON.stringify({ ...config, reviewAngle: angle }, null, 2)
          );
        }
      }
      if (!reviewAngles || reviewAngles.length === 0 || includeGeneral) {
        // General: single prompt at task dir (default or general+angles)
        const prompt = this.buildPromptWithInstructions(
          agentInstructions,
          this.generateReviewPrompt(config, context)
        );
        await fs.writeFile(path.join(taskDir, "prompt.md"), prompt);
      }
    }

    return taskDir;
  }

  /**
   * Read the SPEC (Sketch phase output) and return its content for agent context.
   * Migrates from prd.json or PRD.md if present.
   */
  async extractPrdExcerpt(repoPath: string): Promise<string> {
    try {
      const specPath = path.join(repoPath, SPEC_MD);
      const raw = await fs.readFile(specPath, "utf-8");
      if (raw.trim()) return raw;
      return "# Product Specification\n\nNo content yet.";
    } catch {
      const prdService = new PrdService();
      const migrated = await prdService.migrateFromLegacy(repoPath);
      if (migrated) return prdToSpecMarkdown(migrated);
      return "# Product Specification\n\nNo SPEC available.";
    }
  }

  /**
   * Get plan content from task store by plan ID (for callers that have projectId and planId).
   */
  async getPlanContent(
    projectId: string,
    planId: string,
    taskStore: TaskStoreService
  ): Promise<string> {
    const row = await taskStore.planGet(projectId, planId);
    return row?.content ?? "# Plan\n\nNo plan content available.";
  }

  /**
   * Get plan content for a task by resolving its parent epic and loading plan from task store.
   * Returns empty string if the task has no parent or no plan is linked to that epic.
   */
  async getPlanContentForTask(
    projectId: string,
    _repoPath: string,
    task: StoredTask,
    taskStore: TaskStoreService
  ): Promise<string> {
    const parentId = taskStore.getParentId(task.id);
    if (!parentId) return "";
    const plan = await taskStore.planGetByEpicId(projectId, parentId);
    return plan?.content ?? "";
  }

  /**
   * Build full context for a task.
   * - Gets Plan path from epic description, reads Plan markdown
   * - Extracts relevant PRD sections
   * - For each dependency task: gets git diff (baseBranch...branch) if branch exists, else uses archived session
   * @param options.task - When provided, avoids taskStore.show(taskId) and taskStore.getBlockers (uses issue data).
   * @param options.baseBranch - Base branch for git diff (default: "main")
   */
  async buildContext(
    projectId: string,
    repoPath: string,
    taskId: string,
    taskStore: TaskStoreService,
    branchManager: BranchManager,
    options?: { task?: StoredTask; baseBranch?: string }
  ): Promise<TaskContext> {
    const task = options?.task ?? (await taskStore.show(projectId, taskId));
    const title = task.title ?? "";
    const description = (task.description as string) ?? "";
    const sourceFeedbackIds = Array.isArray(task["sourceFeedbackIds"])
      ? (task["sourceFeedbackIds"] as unknown[])
      : [];
    const isFeedbackTask =
      sourceFeedbackIds.length > 0 || /(?:^|\n)Feedback ID:\s*\S+/i.test(description);

    const planContent =
      (await this.getPlanContentForTask(projectId, repoPath, task, taskStore)) ||
      "# Plan\n\nNo plan content available.";

    const prdExcerpt = await this.extractPrdExcerpt(repoPath);
    const dependencyTaskIds = options?.task
      ? taskStore.getBlockersFromIssue(task)
      : await taskStore.getBlockers(projectId, taskId);
    const baseBranch = options?.baseBranch ?? "main";
    const dependencyOutputs = await this.collectDependencyOutputsWithGitDiff(
      repoPath,
      dependencyTaskIds,
      branchManager,
      baseBranch
    );

    let userClarification: string | undefined;
    try {
      const executeConv = await this.chatService.getHistory(projectId, `execute:${taskId}`);
      const lastUserMsg = [...executeConv.messages].reverse().find((m) => m.role === "user");
      if (lastUserMsg?.content?.trim()) {
        userClarification = lastUserMsg.content.trim();
      }
    } catch {
      // Conversation may not exist; proceed without user clarification
    }
    if (!userClarification) {
      const storedResponses = await notificationService.getResolvedResponsesForTask(
        projectId,
        "execute",
        taskId
      );
      if (storedResponses?.length) {
        userClarification = storedResponses.map((r) => r.answer).join("\n\n").trim();
      }
    }

    return {
      taskId: task.id,
      title,
      description,
      planContent,
      ...(isFeedbackTask && { isFeedbackTask: true }),
      prdExcerpt,
      dependencyOutputs,
      ...(userClarification ? { userClarification } : {}),
    };
  }

  /**
   * Collect diffs/summaries from dependency tasks.
   * For each dep: try git diff baseBranch...branch first; if branch doesn't exist (merged/deleted), use archived session.
   */
  private async collectDependencyOutputsWithGitDiff(
    repoPath: string,
    dependencyTaskIds: string[],
    branchManager: BranchManager,
    baseBranch: string = "main"
  ): Promise<Array<{ taskId: string; diff: string; summary: string }>> {
    const outputs: Array<{ taskId: string; diff: string; summary: string }> = [];

    for (const depId of dependencyTaskIds) {
      const branchName = `opensprint/${depId}`;
      let diff = "";
      let summary = `Task ${depId} completed.`;

      // Try git diff first (branch exists if dep is in progress or in review)
      try {
        diff = await branchManager.getDiff(repoPath, branchName, baseBranch);
      } catch {
        // Branch merged/deleted — fall back to archived session
      }

      // If no diff from git, use session archive
      if (!diff) {
        const fromSession = await this.collectDependencyOutputs(repoPath, [depId]);
        if (fromSession.length > 0) {
          diff = fromSession[0].diff;
          summary = fromSession[0].summary;
        }
      }

      outputs.push({ taskId: depId, diff, summary });
    }

    return outputs;
  }

  /** Insert agent instructions after title/objective section when present. */
  private buildPromptWithInstructions(agentInstructions: string, basePrompt: string): string {
    if (!agentInstructions.trim()) return basePrompt;
    const match = basePrompt.match(/(## Objective\n\n[\s\S]*?)(\n## )/);
    if (!match) return `${agentInstructions}\n\n${basePrompt}`;
    const endOfObjective = match.index! + match[1].length;
    return (
      basePrompt.slice(0, endOfObjective) +
      "\n\n" +
      agentInstructions +
      basePrompt.slice(endOfObjective)
    );
  }

  /**
   * Extract a markdown section by heading (e.g. "Acceptance Criteria", "Technical Approach").
   * Returns content between ## Section and the next ## or end of document.
   */
  private extractPlanSection(planContent: string, sectionName: string): string {
    const heading = `## ${sectionName}`;
    const idx = planContent.indexOf(heading);
    if (idx === -1) return "";

    const start = idx + heading.length;
    const rest = planContent.slice(start);
    const nextHeading = rest.match(/\n##\s+/);
    const end = nextHeading ? nextHeading.index! : rest.length;
    return rest.slice(0, end).trim();
  }

  /**
   * Extract task-local acceptance criteria from ticket description.
   * Supports markdown section or single-line "Acceptance:" style.
   */
  private extractTaskAcceptanceCriteria(description: string): string {
    const text = description?.trim() ?? "";
    if (!text) return "";

    const headingMatch = text.match(
      /(?:^|\n)##\s*Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s+|$)/i
    );
    if (headingMatch?.[1]?.trim()) return headingMatch[1].trim();

    const labelMatch = text.match(/(?:^|\n)(?:Acceptance Criteria|Acceptance)\s*:\s*([\s\S]*)$/i);
    if (labelMatch?.[1]?.trim()) return labelMatch[1].trim();

    return "";
  }

  /**
   * Prefer task-local acceptance criteria; for feedback tasks, avoid forcing parent-plan acceptance.
   */
  private resolveAcceptanceCriteria(context: TaskContext): string {
    const taskCriteria = this.extractTaskAcceptanceCriteria(context.description);
    if (taskCriteria) return taskCriteria;
    if (context.isFeedbackTask) return "";
    return this.extractPlanSection(context.planContent, "Acceptance Criteria");
  }

  /**
   * Parent-plan technical approach is reference-only and should not constrain feedback tasks.
   */
  private resolveTechnicalApproach(context: TaskContext): string {
    if (context.isFeedbackTask) return "";
    return this.extractPlanSection(context.planContent, "Technical Approach");
  }

  private buildPlanContextBullet(context: TaskContext): string {
    if (context.isFeedbackTask) {
      return "- `context/plan.md` — surrounding feature context only (reference-only for feedback tasks; not extra acceptance criteria)\n";
    }
    return "- `context/plan.md` — the full feature specification and plan\n";
  }

  private buildFeedbackTaskScopeGuidance(context: TaskContext): string {
    if (!context.isFeedbackTask) return "";
    return [
      "## Feedback Task Scope",
      "This task originated from feedback. The original ticket and the task-local acceptance criteria above are the source of truth.",
      "Use `context/plan.md` only as background context for nearby code and feature intent.",
      "Do not add scope from a parent plan, mapped epic, or prior review feedback unless that requirement is explicitly restated in the ticket.",
    ].join("\n\n");
  }

  /**
   * Collect diffs/summaries from completed dependency tasks for context assembly (PRD §7.3.2).
   * Only uses approved sessions (tasks that reached Done); skips gating tasks and failed attempts.
   * Sessions are stored at .opensprint/sessions/<task-id>-<attempt>/session.json
   * Uses a single readdir and groups by taskId to avoid N readdirs for N deps.
   */
  async collectDependencyOutputs(
    repoPath: string,
    dependencyTaskIds: string[]
  ): Promise<Array<{ taskId: string; diff: string; summary: string }>> {
    const sessionsDir = getRuntimePath(repoPath, OPENSPRINT_PATHS.sessions);
    const depIdSet = new Set(dependencyTaskIds);
    const byTaskId = new Map<string, Array<{ attempt: number; entry: string }>>();

    try {
      const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const lastHyphen = e.name.lastIndexOf("-");
        if (lastHyphen <= 0) continue;
        const taskId = e.name.slice(0, lastHyphen);
        const attemptStr = e.name.slice(lastHyphen + 1);
        const attempt = parseInt(attemptStr, 10);
        if (attemptStr !== String(attempt)) continue;
        if (!depIdSet.has(taskId)) continue;
        let arr = byTaskId.get(taskId);
        if (!arr) {
          arr = [];
          byTaskId.set(taskId, arr);
        }
        arr.push({ attempt, entry: e.name });
      }
    } catch {
      return [];
    }

    for (const arr of byTaskId.values()) {
      arr.sort((a, b) => b.attempt - a.attempt);
    }

    const outputs: Array<{ taskId: string; diff: string; summary: string }> = [];
    for (const depId of dependencyTaskIds) {
      const arr = byTaskId.get(depId);
      if (!arr) continue;
      try {
        for (const { entry } of arr) {
          const sessionPath = path.join(sessionsDir, entry, "session.json");
          const raw = await fs.readFile(sessionPath, "utf-8");
          const session = JSON.parse(raw) as {
            gitDiff?: string;
            summary?: string;
            status?: string;
          };
          if (session.status === "approved") {
            outputs.push({
              taskId: depId,
              diff: session.gitDiff || "",
              summary: session.summary || `Task ${depId} completed.`,
            });
            break;
          }
        }
      } catch {
        // Skip if we can't read dependency output
      }
    }

    return outputs;
  }

  private generateCodingPrompt(config: ActiveTaskConfig, context: TaskContext): string {
    const mergeQualityGateList = getMergeQualityGateCommands()
      .map((command) => `\`${command}\``)
      .join(", ");
    let prompt = `# Task: ${context.title}\n\n`;
    prompt += `Implement the task. Do not re-explain the task or list options — start implementing.\n\n`;
    prompt += `## Objective\n\n${context.description}\n\n`;
    prompt += `## Context\n\n`;
    prompt += context.isFeedbackTask
      ? `You are implementing a task as part of a larger feature. If the task description specifies file paths, use them. If not, infer from the project structure and surrounding feature context. Review the provided context files:\n\n`
      : `You are implementing a task as part of a larger feature. If the task description specifies file paths, use them. If not, infer from the plan's Technical Approach and project structure. Review the provided context files:\n\n`;
    prompt += this.buildPlanContextBullet(context);
    prompt += `- \`context/spec.md\` — relevant product requirements\n`;
    prompt += `- \`context/deps/\` — output from tasks this depends on\n\n`;

    const acceptanceCriteria = this.resolveAcceptanceCriteria(context);
    if (acceptanceCriteria) {
      prompt += `## Acceptance Criteria\n\n${acceptanceCriteria}\n\n`;
    }

    const technicalApproach = this.resolveTechnicalApproach(context);
    if (technicalApproach) {
      prompt += `## Technical Approach\n\n${technicalApproach}\n\n`;
    }

    const feedbackTaskScopeGuidance = this.buildFeedbackTaskScopeGuidance(context);
    if (feedbackTaskScopeGuidance) {
      prompt += `${feedbackTaskScopeGuidance}\n\n`;
    }

    prompt += `## Instructions\n\n`;
    prompt += `1. Work on branch \`${config.branch}\` (already checked out in this worktree).\n`;

    if (config.useExistingBranch) {
      prompt += `2. **This branch contains work from a previous attempt.** Review the existing code before making changes. Build on what's already there rather than starting from scratch.\n`;
      prompt += `3. Implement or fix the task according to the acceptance criteria.\n`;
    } else {
      prompt += `2. Implement the task according to the acceptance criteria.\n`;
    }

    prompt += `${config.useExistingBranch ? "4" : "3"}. Write comprehensive tests (unit, and integration where applicable).\n`;
    prompt += `${config.useExistingBranch ? "5" : "4"}. **Commit after each logical unit** — with descriptive messages (e.g., "Add login API endpoint", "Add auth tests"). Do not wait until the end to commit. This protects your work if the process is interrupted.\n`;
    prompt += `${config.useExistingBranch ? "6" : "5"}. Run the smallest relevant non-watch verification for the workspaces you touch while iterating. Prefer scoped tests first, and add scoped build/typecheck and lint commands whenever your changes could affect them (for example TypeScript, exported interfaces, build config, or linted frontend/backend code).\n`;
    prompt += `   Before writing \`result.json\`, leave the branch in a state where the merge quality gates can pass. If you touched shared packages, exported APIs/types, cross-workspace code, root scripts, or build/lint/test configuration, run the relevant root gate commands yourself (merge quality gates: ${mergeQualityGateList}). The orchestrator will rerun automated validation after you finish. Never use watch mode or leave test processes running in the background.\n`;
    const resultJsonPath =
      config.repoPath && config.taskId
        ? path.join(config.repoPath, ".opensprint", "active", config.taskId, "result.json")
        : `.opensprint/active/${config.taskId}/result.json`;
    prompt += `${config.useExistingBranch ? "7" : "6"}. Write your result to \`${resultJsonPath}\` using this exact JSON format:\n`;
    prompt += `   \`\`\`json\n`;
    prompt += `   { "status": "success", "summary": "Brief description of what you implemented" }\n`;
    prompt += `   \`\`\`\n`;
    prompt += `   Use \`"status": "success"\` when the task is done, or \`"status": "failed"\` if you could not finish it.\n`;
    prompt += `   The \`status\` field MUST be exactly \`"success"\` or \`"failed"\` — no other values.\n`;
    prompt += `   **When the task spec is ambiguous:** Instead of guessing, return \`"status": "failed"\` with \`open_questions\` in the standard protocol format: [{ "id": "q1", "text": "Your clarification question" }]. The server will surface these via the Human Notification System; do not proceed until the user answers.\n`;
    prompt += `   After writing result.json, exit the process immediately so the orchestrator can continue (exit code 0 on success).\n\n`;
    prompt += `If your targeted tests fail after implementation, fix them before writing result.json. Do not report success if you know the relevant tests are failing. The orchestrator will run the repository validation command after you exit.\n\n`;
    prompt += `Never run destructive cleanup commands such as \`rm -rf\`, \`find ... -delete\`, or \`git clean -fdx\` against the repo. If you think broad cleanup is required, stop and report failure; the orchestrator owns cleanup.\n\n`;

    const autonomyDesc = buildAutonomyDescription(config.aiAutonomyLevel, config.hilConfig);
    if (autonomyDesc) {
      prompt += `## AI Autonomy Level\n\n${autonomyDesc}\n\n`;
    }

    if (config.previousFailure) {
      prompt += `## Previous Attempt\n\n`;
      prompt += `This is attempt ${config.attempt}. The previous attempt failed:\n${config.previousFailure}\n\n`;

      if (config.qualityGateDetail) {
        const detail = config.qualityGateDetail;
        prompt += `### Quality Gate Failure\n\n`;
        if (detail.command) {
          prompt += `Failed command: \`${detail.command}\`\n\n`;
        }
        if (detail.firstErrorLine) {
          prompt += `First actionable error:\n\`${detail.firstErrorLine}\`\n\n`;
        } else if (detail.reason) {
          prompt += `Failure reason:\n\`${detail.reason}\`\n\n`;
        }
        if (detail.outputSnippet) {
          prompt += `Condensed gate output:\n\n\`\`\`\n${detail.outputSnippet.slice(0, 2000)}\n\`\`\`\n\n`;
        }
        if (detail.worktreePath) {
          prompt += `Gate worktree: \`${detail.worktreePath}\`\n\n`;
        }
        prompt += `Fix the merge-gate failure directly before reporting success.\n\n`;
      }

      if (config.previousTestOutput) {
        if (config.previousTestFailures?.trim()) {
          prompt += `### Highlighted Test Failures\n\n${config.previousTestFailures.trim()}\n\n`;
        }
        prompt += `### Condensed Test Output\n\n\`\`\`\n${config.previousTestOutput.slice(0, 2000)}\n\`\`\`\n\n`;
        prompt += `The full raw output is omitted by default so you can focus on the first actionable failure.\n\n`;
        prompt += `Focus fixes on the specific failing assertions. Avoid broad refactors unless the failure indicates a design flaw. Fix the failing tests without breaking the passing ones.\n\n`;
      }
    }

    if (config.reviewFeedback) {
      prompt += `## Review Feedback\n\n`;
      prompt += `The review agent rejected the previous implementation:\n${config.reviewFeedback}\n\n`;
      if (context.isFeedbackTask) {
        prompt += `If this feedback asks for work outside the original ticket above, keep the new attempt aligned to the ticket and its acceptance criteria rather than expanding scope.\n\n`;
      }
    }

    if (context.userClarification) {
      prompt += `## User clarification (from open questions)\n\n`;
      prompt += `The user answered your open questions. Use this to proceed with the task:\n\n${context.userClarification}\n\n`;
    }

    return prompt;
  }

  /**
   * Generate a prompt for the Merger agent to resolve conflicts.
   * Supports both rebase (push) and merge (merge-to-main) conflict resolution.
   * @param opts.baseBranch - Base branch for merge/rebase context (default: "main")
   */
  generateMergeConflictPrompt(opts: {
    conflictedFiles: string[];
    conflictDiff: string;
    mode?: "rebase" | "merge";
    recentMerges?: Array<{ taskId: string; summary: string }>;
    baseBranch?: string;
  }): string {
    const mode = opts.mode ?? "rebase";
    const isMerge = mode === "merge";
    const baseBranch = opts.baseBranch ?? "main";

    let prompt = isMerge ? `# Resolve Merge Conflicts\n\n` : `# Resolve Rebase Conflicts\n\n`;
    prompt += `## Situation\n\n`;
    if (isMerge) {
      prompt += `The orchestrator is merging a task branch into local \`${baseBranch}\`. The merge hit conflicts `;
      prompt += `that need manual resolution.\n\n`;
      prompt += `The repository is currently in a **merge-in-progress** state. Your job is to resolve all conflicts `;
      prompt += `and complete the merge.\n\n`;
    } else {
      prompt += `The orchestrator merged a task branch into local \`${baseBranch}\`, then ran \`git rebase origin/${baseBranch}\` `;
      prompt += `to incorporate remote changes before pushing. The rebase hit conflicts that need manual resolution.\n\n`;
      prompt += `The repository is currently in a **rebase-in-progress** state. Your job is to resolve all conflicts `;
      prompt += `and allow the rebase to complete.\n\n`;
    }

    if (opts.recentMerges && opts.recentMerges.length > 0) {
      prompt += `## Recently Merged Tasks\n\n`;
      prompt += `These tasks were merged to ${baseBranch} recently and may explain why conflicts arose:\n\n`;
      for (const m of opts.recentMerges) {
        prompt += `- **${m.taskId}**: ${m.summary}\n`;
      }
      prompt += `\n`;
    }

    prompt += `## Conflicted Files\n\n`;
    for (const f of opts.conflictedFiles) {
      prompt += `- \`${f}\`\n`;
    }
    prompt += `\n`;

    if (opts.conflictDiff) {
      const truncated = opts.conflictDiff.slice(0, 20_000);
      prompt += `## Conflict Diff\n\n\`\`\`diff\n${truncated}\n\`\`\`\n\n`;
      if (opts.conflictDiff.length > 20_000) {
        prompt += `*(diff truncated — run \`git diff\` to see the full output)*\n\n`;
      }
    }

    const continueCmd = isMerge
      ? "`git add -A && git -c core.editor=true commit --no-edit`"
      : "`git -c core.editor=true rebase --continue`";
    const abortCmd = isMerge ? "`git merge --abort`" : "`git rebase --abort`";

    prompt += `## Instructions\n\n`;
    prompt += `1. For each conflicted file, open it, understand both sides, and resolve the conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`). Keep the correct combination of both sides.\n`;
    prompt += `2. After resolving each file, stage it with \`git add <file>\`.\n`;
    prompt += `3. Once ALL conflicts are resolved and staged, run: ${continueCmd}\n`;
    prompt += `4. Verify the operation completed successfully (no more conflicts).\n`;
    prompt += `5. Write your result to \`.opensprint/merge-result.json\` using this exact JSON format:\n`;
    prompt += `   \`\`\`json\n`;
    prompt += `   { "status": "success", "summary": "Brief description of how conflicts were resolved" }\n`;
    prompt += `   \`\`\`\n`;
    prompt += `   Use \`"status": "success"\` when all conflicts are resolved and the ${isMerge ? "merge" : "rebase"} completed.\n`;
    prompt += `   Use \`"status": "failed"\` if you cannot resolve the conflicts.\n`;
    prompt += `   The \`status\` field MUST be exactly \`"success"\` or \`"failed"\`.\n\n`;
    prompt += `## Important\n\n`;
    prompt += `- Do NOT run ${abortCmd}. The orchestrator will handle cleanup if you fail.\n`;
    prompt +=
      "- Do NOT run `git push`. The orchestrator will merge your work into the project base branch after you exit, and publish to the remote when one is configured.\n";
    prompt += `- Do NOT run destructive cleanup commands such as \`rm -rf\`, \`find ... -delete\`, or \`git clean -fdx\`. Resolve conflicts by editing specific files only.\n`;
    prompt += `- Focus only on resolving conflicts — do not make other code changes.\n`;

    return prompt;
  }

  private generateReviewPrompt(config: ActiveTaskConfig, context: TaskContext): string {
    let prompt = `# Review Task: ${context.title}\n\n`;

    prompt += `## Objective\n\n`;
    prompt += `You are reviewing the implementation of a task. Review efficiently — if the implementation clearly meets acceptance criteria and tests pass, approve with a brief summary. Reject only when scope or quality issues exist. Your review covers **two dimensions**:\n`;
    prompt += `1. **Scope compliance** — Does the implementation match the original ticket and meet all acceptance criteria?\n`;
    prompt += `2. **Code quality** — Is the code correct, clear, well-tested, and production-ready?\n\n`;

    prompt += `Approve only if BOTH dimensions pass. Reject with specific, actionable feedback if either fails.\n\n`;

    prompt += `## Original Ticket\n\n`;
    prompt += `**Task ID:** ${context.taskId}\n`;
    prompt += `**Title:** ${context.title}\n\n`;
    prompt += `${context.description}\n\n`;

    const acceptanceCriteria = this.resolveAcceptanceCriteria(context);
    if (acceptanceCriteria) {
      prompt += `## Acceptance Criteria\n\n${acceptanceCriteria}\n\n`;
    }

    const technicalApproach = this.resolveTechnicalApproach(context);
    if (technicalApproach) {
      prompt += `## Technical Approach\n\n${technicalApproach}\n\n`;
    }

    const feedbackTaskScopeGuidance = this.buildFeedbackTaskScopeGuidance(context);
    if (feedbackTaskScopeGuidance) {
      prompt += `${feedbackTaskScopeGuidance}\n\n`;
    }

    prompt += `## Context\n\n`;
    prompt += `Review the provided context files for full requirements and design:\n\n`;
    prompt += this.buildPlanContextBullet(context);
    prompt += `- \`context/spec.md\` — relevant product requirements\n`;
    prompt += `- \`context/deps/\` — output from dependency tasks this builds on\n\n`;

    if (context.reviewHistory) {
      prompt += `## Prior Review History\n\n`;
      prompt += `This task has been reviewed and rejected before. The coding agent was asked to address these issues. `;
      prompt += `**Pay special attention to verifying that the previously identified problems have actually been fixed.**\n\n`;
      if (context.isFeedbackTask) {
        prompt += `If any prior rejection conflicts with the original ticket or task-local acceptance criteria above, the original ticket wins.\n\n`;
      }
      prompt += `${context.reviewHistory}\n\n`;
    }

    const hasProvidedDiff = Boolean(context.branchDiff && context.branchDiff.trim().length > 0);
    const testStatusPath = getOrchestratorTestStatusPromptPath(config.taskId);
    prompt += `## Implementation\n\n`;
    prompt += `The coding agent has produced changes on branch \`${config.branch}\`. The orchestrator has already committed them before invoking you.\n`;
    if (hasProvidedDiff) {
      prompt += `Review the committed changes in \`context/implementation.diff\` (do not run \`git diff\` — the diff is provided from the main repo).\n\n`;
    } else {
      prompt += `Run \`git diff main...${config.branch}\` to review the committed changes.\n\n`;
    }

    prompt += `## Review Checklist\n\n`;
    prompt += `### Part 1: Scope Compliance\n\n`;
    prompt += `- [ ] The implementation addresses what the ticket asks for — no more, no less\n`;
    prompt += `- [ ] ALL acceptance criteria are met (check each one individually)\n`;
    if (technicalApproach) {
      prompt += `- [ ] The technical approach matches the plan (or deviations are justified)\n`;
    }
    prompt += `- [ ] No unrelated changes or scope creep\n\n`;

    prompt += `### Part 2: Code Quality\n\n`;
    prompt += `- [ ] **Correctness** — No bugs, off-by-one errors, race conditions, or unhandled edge cases\n`;
    prompt += `- [ ] **Error handling** — Failures are handled gracefully; no swallowed errors that hide problems\n`;
    prompt += `- [ ] **Clarity** — Code is readable; naming is clear; complex logic has explanatory comments\n`;
    prompt += `- [ ] **No dead code** — No commented-out code, unused imports, or orphaned functions\n`;
    prompt += `- [ ] **Test coverage** — Aim for 80–90% for new/changed code. Tests verify behavior aligned with the spec; cover happy paths, important edge/error paths, and boundaries. Avoid demanding near-100% or over-precise tests that break on small refactors.\n`;
    prompt += `- [ ] **Orchestrator validation status reviewed** — inspect \`${testStatusPath}\`. This file tracks automated validation, including the merge quality gates. If it says \`FAILED\` or \`ERROR\`, reject and cite the failure. If it says \`PENDING\`, continue your code review and do not reject solely for pending status.\n`;
    prompt += `- [ ] **Consistent style** — Follows existing codebase patterns and conventions\n\n`;

    prompt += `## Working directory\n\n`;
    prompt += `The **repository root** is the directory that contains \`package.json\`, \`packages/backend\`, \`packages/frontend\`, etc. You MUST run any \`git\` commands from that directory. Its path is in \`.opensprint/active/${config.taskId}/config.json\` as \`repoPath\`. The orchestrator writes live validation status to \`${testStatusPath}\`. If you need a targeted test reproduction, change to the repo root first, e.g. \`cd "$(jq -r .repoPath .opensprint/active/${config.taskId}/config.json)"\` (or \`cd <repoPath>\` using the value from config.json). Do not rerun the full repo validation or merge quality gates from this review prompt; the orchestrator runs them separately.\n\n`;

    prompt += `## Instructions\n\n`;
    prompt += `1. Read the original ticket, acceptance criteria, and context files above to fully understand the scope.\n`;
    if (hasProvidedDiff) {
      prompt += `2. Review the diff in \`context/implementation.diff\`.\n`;
    } else {
      prompt += `2. Review the diff: \`git diff main...${config.branch}\`\n`;
    }
    prompt += `3. Walk through the checklist above, checking each item.\n`;
    prompt += `4. Do NOT rerun the full repo validation or merge quality gates from this review prompt. The orchestrator runs validation in parallel and writes the result to \`${testStatusPath}\`.\n`;
    prompt += `   Before finalizing, open that file. If it says \`FAILED\` or \`ERROR\`, reject and cite the relevant failure. If it says \`PENDING\`, continue based on code quality/scope findings and do not reject solely for pending status.\n`;
    prompt += `5. If prior reviews rejected this task, verify each previously cited issue was resolved. If not, reject and list which issues remain.\n`;
    if (context.isFeedbackTask) {
      prompt += `   For feedback tasks, do not inherit unrelated requirements from the parent plan or prior review history when they conflict with the original ticket above.\n`;
    }
    prompt += `6. Write your result to \`.opensprint/active/${config.taskId}/result.json\` using this exact JSON format:\n`;
    prompt += `   If approving (do NOT merge — the orchestrator will merge after you exit):\n`;
    prompt += `   \`\`\`json\n`;
    prompt += `   { "status": "approved", "summary": "Brief description of what was reviewed", "notes": "" }\n`;
    prompt += `   \`\`\`\n`;
    prompt += `   If rejecting:\n`;
    prompt += `   \`\`\`json\n`;
    prompt += `   { "status": "rejected", "summary": "One-line reason for rejection", "issues": ["Specific issue 1", "Specific issue 2"], "notes": "Additional context" }\n`;
    prompt += `   \`\`\`\n`;
    prompt += `   The \`status\` field MUST be exactly \`"approved"\` or \`"rejected"\`. The \`summary\` field is required. \`issues\` and \`notes\` are optional.\n\n`;

    prompt += `## Important\n\n`;
    prompt += `- In rejection feedback, cite file:line or snippet. Vague feedback like "improve tests" is not actionable.\n`;
    prompt += `- Do NOT approve out of lenience. If acceptance criteria are unmet or tests fail, reject.\n`;
    prompt += `- Do NOT reject for style preferences (e.g., 2-space vs 4-space) unless the project has an explicit style guide in the repo.\n`;
    prompt += `- Do NOT merge the branch — the orchestrator handles merging after approval.\n`;

    return prompt;
  }

  /**
   * Generate a review prompt focused on a single angle.
   * Used when reviewAngles has 1+ items; each angle gets its own agent.
   * Result path: review-angles/<angle>/result.json
   */
  generateReviewPromptForAngle(
    config: ActiveTaskConfig,
    context: TaskContext,
    angle: ReviewAngle
  ): string {
    const angleLabel = REVIEW_ANGLE_OPTIONS.find((o) => o.value === angle)?.label ?? angle;
    const checklist = REVIEW_ANGLE_CHECKLISTS[angle] ?? [];
    const testStatusPath = getOrchestratorTestStatusPromptPath(config.taskId);

    let prompt = `# Review Task: ${context.title} — ${angleLabel}\n\n`;

    prompt += `## Objective\n\n`;
    prompt += `You are reviewing the implementation of a task **focusing only on this angle: ${angleLabel}**. Approve if the implementation meets this angle's criteria; reject with specific, actionable feedback if it does not.\n\n`;

    prompt += `## Original Ticket\n\n`;
    prompt += `**Task ID:** ${context.taskId}\n`;
    prompt += `**Title:** ${context.title}\n\n`;
    prompt += `${context.description}\n\n`;

    const acceptanceCriteria = this.resolveAcceptanceCriteria(context);
    if (acceptanceCriteria) {
      prompt += `## Acceptance Criteria\n\n${acceptanceCriteria}\n\n`;
    }

    const technicalApproach = this.resolveTechnicalApproach(context);
    if (technicalApproach) {
      prompt += `## Technical Approach\n\n${technicalApproach}\n\n`;
    }

    const feedbackTaskScopeGuidance = this.buildFeedbackTaskScopeGuidance(context);
    if (feedbackTaskScopeGuidance) {
      prompt += `${feedbackTaskScopeGuidance}\n\n`;
    }

    prompt += `## Context\n\n`;
    prompt += `Review the provided context files for full requirements and design:\n\n`;
    prompt += this.buildPlanContextBullet(context);
    prompt += `- \`context/spec.md\` — relevant product requirements\n`;
    prompt += `- \`context/deps/\` — output from dependency tasks this builds on\n\n`;

    if (context.reviewHistory) {
      prompt += `## Prior Review History\n\n`;
      if (context.isFeedbackTask) {
        prompt += `If any prior rejection conflicts with the original ticket or task-local acceptance criteria above, the original ticket wins.\n\n`;
      }
      prompt += `${context.reviewHistory}\n\n`;
    }

    const hasProvidedDiff = Boolean(context.branchDiff && context.branchDiff.trim().length > 0);
    prompt += `## Implementation\n\n`;
    prompt += `The coding agent has produced changes on branch \`${config.branch}\`. The orchestrator has already committed them before invoking you.\n`;
    if (hasProvidedDiff) {
      prompt += `Review the committed changes in \`context/implementation.diff\` (do not run \`git diff\` — the diff is provided from the main repo).\n\n`;
    } else {
      prompt += `Run \`git diff main...${config.branch}\` to review the committed changes.\n\n`;
    }

    prompt += `## Review Checklist — ${angleLabel}\n\n`;
    for (const item of checklist) {
      prompt += `- [ ] ${item}\n`;
    }
    prompt += `\n`;
    if (angle === "test_coverage") {
      prompt += `## Test Coverage Guidance\n\n`;
      prompt += `- **Reasonable coverage:** 80–90% for new/changed code is sufficient. Do not reject for missing coverage on every branch or line.\n`;
      prompt += `- **Behavior over implementation:** Prefer tests that assert outcomes and behavior aligned with the spec; avoid tests that assert internal structure, exact call counts, or implementation details that change with refactors.\n`;
      prompt += `- **Stability:** Flag tests that are likely to be fragile (e.g., tightly coupled to private APIs or formatting). Do not require such tests.\n\n`;
    }

    prompt += `## Working directory\n\n`;
    prompt += `The **repository root** is the directory that contains \`package.json\`, \`packages/backend\`, \`packages/frontend\`, etc. You MUST run any \`git\` commands from that directory. Its path is in \`.opensprint/active/${config.taskId}/review-angles/${angle}/config.json\` as \`repoPath\`. The orchestrator writes live validation status to \`${testStatusPath}\`. If you need a targeted test reproduction, change to the repo root first. Do not rerun the full repo validation or merge quality gates from this review prompt; the orchestrator runs them separately.\n\n`;

    prompt += `## Instructions\n\n`;
    prompt += `1. Read the original ticket and context files above.\n`;
    if (hasProvidedDiff) {
      prompt += `2. Review the diff in \`context/implementation.diff\`.\n`;
    } else {
      prompt += `2. Review the diff: \`git diff main...${config.branch}\`\n`;
    }
    prompt += `3. Walk through the checklist above for ${angleLabel}.\n`;
    prompt += `4. Do NOT rerun the full repo validation or merge quality gates from this review prompt. The orchestrator runs validation in parallel and writes the result to \`${testStatusPath}\`.\n`;
    prompt += `   Before finalizing, open that file. If it says \`FAILED\` or \`ERROR\`, reject and cite the relevant failure. If it says \`PENDING\`, continue based on ${angleLabel} findings and do not reject solely for pending status.\n`;
    prompt += `5. Write your result to \`.opensprint/active/${config.taskId}/review-angles/${angle}/result.json\` using this exact JSON format:\n`;
    prompt += `   If approving:\n`;
    prompt += `   \`\`\`json\n`;
    prompt += `   { "status": "approved", "summary": "Brief description for ${angleLabel}", "notes": "" }\n`;
    prompt += `   \`\`\`\n`;
    prompt += `   If rejecting:\n`;
    prompt += `   \`\`\`json\n`;
    prompt += `   { "status": "rejected", "summary": "One-line reason for rejection", "issues": ["Specific issue 1", "Specific issue 2"], "notes": "Additional context" }\n`;
    prompt += `   \`\`\`\n`;
    prompt += `   The \`status\` field MUST be exactly \`"approved"\` or \`"rejected"\`. The \`summary\` field is required.\n\n`;

    prompt += `## Important\n\n`;
    prompt += `- In rejection feedback, cite file:line or snippet. Vague feedback is not actionable.\n`;
    prompt += `- Do NOT approve out of lenience. If this angle's criteria are unmet, reject.\n`;
    prompt += `- Do NOT merge the branch — the orchestrator handles merging after approval.\n`;

    return prompt;
  }
}
