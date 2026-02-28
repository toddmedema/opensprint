import fs from "fs/promises";
import path from "path";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import type { ActiveTaskConfig } from "@opensprint/shared";
import { BranchManager } from "./branch-manager.js";
import type { TaskStoreService } from "./task-store.service.js";
import type { StoredTask } from "./task-store.service.js";
import { getRuntimePath } from "../utils/runtime-dir.js";

export interface TaskContext {
  taskId: string;
  title: string;
  description: string;
  planContent: string;
  prdExcerpt: string;
  dependencyOutputs: Array<{ taskId: string; diff: string; summary: string }>;
  /** Past review rejection history (populated by orchestrator for review phase) */
  reviewHistory?: string;
  /** Branch diff (main...branch) from main repo; written to context/implementation.diff for review so Reviewer does not run git from worktree */
  branchDiff?: string;
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

  /**
   * Set up the task directory with all necessary context files.
   */
  async assembleTaskDirectory(
    repoPath: string,
    taskId: string,
    config: ActiveTaskConfig,
    context: TaskContext
  ): Promise<string> {
    const taskDir = path.join(repoPath, OPENSPRINT_PATHS.active, taskId);
    const contextDir = path.join(taskDir, "context");
    const depsDir = path.join(contextDir, "deps");

    await fs.mkdir(depsDir, { recursive: true });

    // Write config.json
    await fs.writeFile(path.join(taskDir, "config.json"), JSON.stringify(config, null, 2));

    // Write context files
    await fs.writeFile(path.join(contextDir, "prd_excerpt.md"), context.prdExcerpt);

    await fs.writeFile(path.join(contextDir, "plan.md"), context.planContent);

    // Write dependency outputs
    for (const dep of context.dependencyOutputs) {
      await fs.writeFile(path.join(depsDir, `${dep.taskId}.diff`), dep.diff);
      await fs.writeFile(path.join(depsDir, `${dep.taskId}.summary.md`), dep.summary);
    }

    if (context.branchDiff != null && context.branchDiff !== "") {
      await fs.writeFile(path.join(contextDir, "implementation.diff"), context.branchDiff);
    }

    // Generate prompt.md
    const prompt =
      config.phase === "coding"
        ? this.generateCodingPrompt(config, context)
        : this.generateReviewPrompt(config, context);

    await fs.writeFile(path.join(taskDir, "prompt.md"), prompt);

    return taskDir;
  }

  /**
   * Read the PRD and extract relevant sections.
   */
  async extractPrdExcerpt(repoPath: string): Promise<string> {
    try {
      const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
      const raw = await fs.readFile(prdPath, "utf-8");
      const prd = JSON.parse(raw);

      let excerpt = "# Product Requirements (Excerpt)\n\n";
      for (const [key, section] of Object.entries(prd.sections || {})) {
        const sec = section as { content: string };
        if (sec.content) {
          excerpt += `## ${key.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}\n\n`;
          excerpt += sec.content + "\n\n";
        }
      }
      return excerpt;
    } catch {
      return "# Product Requirements\n\nNo PRD available.";
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
   * - For each dependency task: gets git diff (main...branch) if branch exists, else uses archived session
   * @param options.task - When provided, avoids taskStore.show(taskId) and taskStore.getBlockers (uses issue data).
   */
  async buildContext(
    projectId: string,
    repoPath: string,
    taskId: string,
    taskStore: TaskStoreService,
    branchManager: BranchManager,
    options?: { task?: StoredTask }
  ): Promise<TaskContext> {
    const task = options?.task ?? (await taskStore.show(projectId, taskId));
    const title = task.title ?? "";
    const description = (task.description as string) ?? "";

    const planContent =
      (await this.getPlanContentForTask(projectId, repoPath, task, taskStore)) ||
      "# Plan\n\nNo plan content available.";

    const prdExcerpt = await this.extractPrdExcerpt(repoPath);
    const dependencyTaskIds = options?.task
      ? taskStore.getBlockersFromIssue(task)
      : await taskStore.getBlockers(projectId, taskId);
    const dependencyOutputs = await this.collectDependencyOutputsWithGitDiff(
      repoPath,
      dependencyTaskIds,
      branchManager
    );

    return {
      taskId: task.id,
      title,
      description,
      planContent,
      prdExcerpt,
      dependencyOutputs,
    };
  }

  /**
   * Collect diffs/summaries from dependency tasks.
   * For each dep: try git diff main...branch first; if branch doesn't exist (merged/deleted), use archived session.
   */
  private async collectDependencyOutputsWithGitDiff(
    repoPath: string,
    dependencyTaskIds: string[],
    branchManager: BranchManager
  ): Promise<Array<{ taskId: string; diff: string; summary: string }>> {
    const outputs: Array<{ taskId: string; diff: string; summary: string }> = [];

    for (const depId of dependencyTaskIds) {
      const branchName = `opensprint/${depId}`;
      let diff = "";
      let summary = `Task ${depId} completed.`;

      // Try git diff first (branch exists if dep is in progress or in review)
      try {
        diff = await branchManager.getDiff(repoPath, branchName);
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
    let prompt = `# Task: ${context.title}\n\n`;
    prompt += `Implement the task. Do not re-explain the task or list options — start implementing.\n\n`;
    prompt += `## Objective\n\n${context.description}\n\n`;
    prompt += `## Context\n\n`;
    prompt += `You are implementing a task as part of a larger feature. If the task description specifies file paths, use them. If not, infer from the plan's Technical Approach and project structure. Review the provided context files:\n\n`;
    prompt += `- \`context/plan.md\` — the full feature specification\n`;
    prompt += `- \`context/prd_excerpt.md\` — relevant product requirements\n`;
    prompt += `- \`context/deps/\` — output from tasks this depends on\n\n`;

    const acceptanceCriteria = this.extractPlanSection(context.planContent, "Acceptance Criteria");
    if (acceptanceCriteria) {
      prompt += `## Acceptance Criteria\n\n${acceptanceCriteria}\n\n`;
    }

    const technicalApproach = this.extractPlanSection(context.planContent, "Technical Approach");
    if (technicalApproach) {
      prompt += `## Technical Approach\n\n${technicalApproach}\n\n`;
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
    prompt += `${config.useExistingBranch ? "6" : "5"}. Run \`${config.testCommand}\` and ensure all tests pass.\n`;
    prompt += `${config.useExistingBranch ? "7" : "6"}. Write your result to \`.opensprint/active/${config.taskId}/result.json\` using this exact JSON format:\n`;
    prompt += `   \`\`\`json\n`;
    prompt += `   { "status": "success", "summary": "Brief description of what you implemented" }\n`;
    prompt += `   \`\`\`\n`;
    prompt += `   Use \`"status": "success"\` when the task is done, or \`"status": "failed"\` if you could not finish it.\n`;
    prompt += `   The \`status\` field MUST be exactly \`"success"\` or \`"failed"\` — no other values.\n`;
    prompt += `   **When the task spec is ambiguous:** Instead of guessing, return \`"status": "failed"\` with \`open_questions\`: [{ "id": "q1", "text": "Your clarification question" }]. The user will answer; do not proceed until clarified.\n`;
    prompt += `   After writing result.json, exit the process immediately so the orchestrator can continue (exit code 0 on success).\n\n`;
    prompt += `If tests fail after implementation, fix them before writing result.json. Do not report success with failing tests.\n\n`;

    if (config.hilConfig) {
      const modes = Object.values(config.hilConfig);
      const autonomyDesc =
        modes.every((m) => m === "automated") ? "Full autonomy: proceed without confirmation." :
        modes.some((m) => m === "requires_approval") ? "Confirm major changes before proceeding." :
        "Notify user but proceed with changes.";
      prompt += `## Autonomy Level\n\n${autonomyDesc}\n\n`;
    }

    if (config.previousFailure) {
      prompt += `## Previous Attempt\n\n`;
      prompt += `This is attempt ${config.attempt}. The previous attempt failed:\n${config.previousFailure}\n\n`;

      if (config.previousTestOutput) {
        prompt += `### Test Output\n\n\`\`\`\n${config.previousTestOutput.slice(0, 5000)}\n\`\`\`\n\n`;
        prompt += `Focus fixes on the specific failing assertions. Avoid broad refactors unless the failure indicates a design flaw. Fix the failing tests without breaking the passing ones.\n\n`;
      }
    }

    if (config.reviewFeedback) {
      prompt += `## Review Feedback\n\n`;
      prompt += `The review agent rejected the previous implementation:\n${config.reviewFeedback}\n\n`;
    }

    return prompt;
  }

  /**
   * Generate a prompt for the Merger agent to resolve conflicts.
   * Supports both rebase (push) and merge (merge-to-main) conflict resolution.
   */
  generateMergeConflictPrompt(opts: {
    conflictedFiles: string[];
    conflictDiff: string;
    mode?: "rebase" | "merge";
    recentMerges?: Array<{ taskId: string; summary: string }>;
  }): string {
    const mode = opts.mode ?? "rebase";
    const isMerge = mode === "merge";

    let prompt = isMerge ? `# Resolve Merge Conflicts\n\n` : `# Resolve Rebase Conflicts\n\n`;
    prompt += `## Situation\n\n`;
    if (isMerge) {
      prompt += `The orchestrator is merging a task branch into local \`main\`. The merge hit conflicts `;
      prompt += `that need manual resolution.\n\n`;
      prompt += `The repository is currently in a **merge-in-progress** state. Your job is to resolve all conflicts `;
      prompt += `and complete the merge.\n\n`;
    } else {
      prompt += `The orchestrator merged a task branch into local \`main\`, then ran \`git rebase origin/main\` `;
      prompt += `to incorporate remote changes before pushing. The rebase hit conflicts that need manual resolution.\n\n`;
      prompt += `The repository is currently in a **rebase-in-progress** state. Your job is to resolve all conflicts `;
      prompt += `and allow the rebase to complete.\n\n`;
    }

    if (opts.recentMerges && opts.recentMerges.length > 0) {
      prompt += `## Recently Merged Tasks\n\n`;
      prompt += `These tasks were merged to main recently and may explain why conflicts arose:\n\n`;
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
    prompt += `- Do NOT run \`git push\`. The orchestrator will push after you exit.\n`;
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

    const acceptanceCriteria = this.extractPlanSection(context.planContent, "Acceptance Criteria");
    if (acceptanceCriteria) {
      prompt += `## Acceptance Criteria\n\n${acceptanceCriteria}\n\n`;
    }

    const technicalApproach = this.extractPlanSection(context.planContent, "Technical Approach");
    if (technicalApproach) {
      prompt += `## Technical Approach\n\n${technicalApproach}\n\n`;
    }

    prompt += `## Context\n\n`;
    prompt += `Review the provided context files for full requirements and design:\n\n`;
    prompt += `- \`context/plan.md\` — the full feature specification and plan\n`;
    prompt += `- \`context/prd_excerpt.md\` — relevant product requirements\n`;
    prompt += `- \`context/deps/\` — output from dependency tasks this builds on\n\n`;

    if (context.reviewHistory) {
      prompt += `## Prior Review History\n\n`;
      prompt += `This task has been reviewed and rejected before. The coding agent was asked to address these issues. `;
      prompt += `**Pay special attention to verifying that the previously identified problems have actually been fixed.**\n\n`;
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

    prompt += `## Review Checklist\n\n`;
    prompt += `### Part 1: Scope Compliance\n\n`;
    prompt += `- [ ] The implementation addresses what the ticket asks for — no more, no less\n`;
    prompt += `- [ ] ALL acceptance criteria are met (check each one individually)\n`;
    prompt += `- [ ] The technical approach matches the plan (or deviations are justified)\n`;
    prompt += `- [ ] No unrelated changes or scope creep\n\n`;

    prompt += `### Part 2: Code Quality\n\n`;
    prompt += `- [ ] **Correctness** — No bugs, off-by-one errors, race conditions, or unhandled edge cases\n`;
    prompt += `- [ ] **Error handling** — Failures are handled gracefully; no swallowed errors that hide problems\n`;
    prompt += `- [ ] **Clarity** — Code is readable; naming is clear; complex logic has explanatory comments\n`;
    prompt += `- [ ] **No dead code** — No commented-out code, unused imports, or orphaned functions\n`;
    prompt += `- [ ] **Test coverage** — Tests exist for the new/changed behavior and cover:\n`;
    prompt += `  - Happy paths\n`;
    prompt += `  - Edge cases and error paths\n`;
    prompt += `  - Boundary conditions where applicable\n`;
    prompt += `- [ ] **All tests pass** — Run \`${config.testCommand}\` and confirm zero failures\n`;
    prompt += `- [ ] **Consistent style** — Follows existing codebase patterns and conventions\n\n`;

    prompt += `## Working directory\n\n`;
    prompt += `The **repository root** is the directory that contains \`package.json\`, \`packages/backend\`, \`packages/frontend\`, etc. You MUST run the test command and any \`git\` commands from that directory. Its path is in \`.opensprint/active/${config.taskId}/config.json\` as \`repoPath\`. If your current working directory is \`.opensprint/active/${config.taskId}/\` (the task folder), change to the repo root first, e.g. \`cd "$(jq -r .repoPath .opensprint/active/${config.taskId}/config.json)"\` (or \`cd <repoPath>\` using the value from config.json), then run \`${config.testCommand}\`. Do not run \`npm test\` from the task folder — it has no \`package.json\` and will fail with ENOENT.\n\n`;

    prompt += `## Instructions\n\n`;
    prompt += `1. Read the original ticket, acceptance criteria, and context files above to fully understand the scope.\n`;
    if (hasProvidedDiff) {
      prompt += `2. Review the diff in \`context/implementation.diff\`.\n`;
    } else {
      prompt += `2. Review the diff: \`git diff main...${config.branch}\`\n`;
    }
    prompt += `3. Walk through the checklist above, checking each item.\n`;
    prompt += `4. From the repository root (see Working directory above), run the full test suite: \`${config.testCommand}\` — confirm ALL tests pass (not just the new ones). Regressions in other tests are grounds for rejection.\n`;
    prompt += `5. If prior reviews rejected this task, verify each previously cited issue was resolved. If not, reject and list which issues remain.\n`;
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
}
