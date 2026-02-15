import fs from 'fs/promises';
import path from 'path';
import { OPENSPRINT_PATHS } from '@opensprint/shared';
import type { ActiveTaskConfig } from '@opensprint/shared';
import { BranchManager } from './branch-manager.js';
import type { BeadsService } from './beads.service.js';

export interface TaskContext {
  taskId: string;
  title: string;
  description: string;
  planContent: string;
  prdExcerpt: string;
  dependencyOutputs: Array<{ taskId: string; diff: string; summary: string }>;
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
    context: TaskContext,
  ): Promise<string> {
    const taskDir = path.join(repoPath, OPENSPRINT_PATHS.active, taskId);
    const contextDir = path.join(taskDir, 'context');
    const depsDir = path.join(contextDir, 'deps');

    await fs.mkdir(depsDir, { recursive: true });

    // Write config.json
    await fs.writeFile(
      path.join(taskDir, 'config.json'),
      JSON.stringify(config, null, 2),
    );

    // Write context files
    await fs.writeFile(
      path.join(contextDir, 'prd_excerpt.md'),
      context.prdExcerpt,
    );

    await fs.writeFile(
      path.join(contextDir, 'plan.md'),
      context.planContent,
    );

    // Write dependency outputs
    for (const dep of context.dependencyOutputs) {
      await fs.writeFile(
        path.join(depsDir, `${dep.taskId}.diff`),
        dep.diff,
      );
      await fs.writeFile(
        path.join(depsDir, `${dep.taskId}.summary.md`),
        dep.summary,
      );
    }

    // Generate prompt.md
    const prompt = config.phase === 'coding'
      ? this.generateCodingPrompt(config, context)
      : this.generateReviewPrompt(config, context);

    await fs.writeFile(path.join(taskDir, 'prompt.md'), prompt);

    return taskDir;
  }

  /**
   * Read the PRD and extract relevant sections.
   */
  async extractPrdExcerpt(repoPath: string): Promise<string> {
    try {
      const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
      const raw = await fs.readFile(prdPath, 'utf-8');
      const prd = JSON.parse(raw);

      let excerpt = '# Product Requirements (Excerpt)\n\n';
      for (const [key, section] of Object.entries(prd.sections || {})) {
        const sec = section as { content: string };
        if (sec.content) {
          excerpt += `## ${key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}\n\n`;
          excerpt += sec.content + '\n\n';
        }
      }
      return excerpt;
    } catch {
      return '# Product Requirements\n\nNo PRD available.';
    }
  }

  /**
   * Read a Plan markdown file.
   */
  async readPlanContent(repoPath: string, planId: string): Promise<string> {
    try {
      const planPath = path.join(repoPath, OPENSPRINT_PATHS.plans, `${planId}.md`);
      return await fs.readFile(planPath, 'utf-8');
    } catch {
      return '# Plan\n\nNo plan content available.';
    }
  }

  /**
   * Build full context for a task given only taskId (ContextBuilder per feature decomposition).
   * - Gets Plan path from epic description, reads Plan markdown
   * - Extracts relevant PRD sections
   * - For each dependency task: gets git diff (main...branch) if branch exists, else uses archived session
   */
  async buildContext(
    repoPath: string,
    taskId: string,
    beads: BeadsService,
    branchManager: BranchManager,
  ): Promise<TaskContext> {
    const task = await beads.show(repoPath, taskId);
    const title = task.title ?? '';
    const description = (task.description as string) ?? '';

    // Get Plan path from epic (parent's description)
    let planContent = '# Plan\n\nNo plan content available.';
    const parentId = beads.getParentId(taskId);
    if (parentId) {
      try {
        const parent = await beads.show(repoPath, parentId);
        const desc = parent.description as string;
        if (desc?.startsWith('.opensprint/plans/')) {
          const planId = path.basename(desc, '.md');
          planContent = await this.readPlanContent(repoPath, planId);
        }
      } catch {
        // Parent might not exist
      }
    }

    const prdExcerpt = await this.extractPrdExcerpt(repoPath);
    const dependencyTaskIds = await beads.getBlockers(repoPath, taskId);
    const dependencyOutputs = await this.collectDependencyOutputsWithGitDiff(
      repoPath,
      dependencyTaskIds,
      branchManager,
    );

    return {
      taskId,
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
    branchManager: BranchManager,
  ): Promise<Array<{ taskId: string; diff: string; summary: string }>> {
    const outputs: Array<{ taskId: string; diff: string; summary: string }> = [];

    for (const depId of dependencyTaskIds) {
      const branchName = `opensprint/${depId}`;
      let diff = '';
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
    if (idx === -1) return '';

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
   */
  async collectDependencyOutputs(
    repoPath: string,
    dependencyTaskIds: string[],
  ): Promise<Array<{ taskId: string; diff: string; summary: string }>> {
    const outputs: Array<{ taskId: string; diff: string; summary: string }> = [];

    for (const depId of dependencyTaskIds) {
      try {
        const sessionsDir = path.join(repoPath, OPENSPRINT_PATHS.sessions);
        const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
        const sessionDirs = entries
          .filter((e) => e.isDirectory() && e.name.startsWith(depId + '-'))
          .map((e) => e.name)
          .sort((a, b) => {
            const attemptA = parseInt(a.slice((depId + '-').length) || '0', 10);
            const attemptB = parseInt(b.slice((depId + '-').length) || '0', 10);
            return attemptB - attemptA;
          });

        // Find the latest approved session (completed task output)
        for (const dir of sessionDirs) {
          const sessionPath = path.join(sessionsDir, dir, 'session.json');
          const raw = await fs.readFile(sessionPath, 'utf-8');
          const session = JSON.parse(raw) as {
            gitDiff?: string;
            summary?: string;
            status?: string;
          };
          if (session.status === 'approved') {
            outputs.push({
              taskId: depId,
              diff: session.gitDiff || '',
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
    prompt += `## Objective\n\n${context.description}\n\n`;
    prompt += `## Context\n\n`;
    prompt += `You are implementing a task as part of a larger feature. Review the provided context files:\n\n`;
    prompt += `- \`context/plan.md\` — the full feature specification\n`;
    prompt += `- \`context/prd_excerpt.md\` — relevant product requirements\n`;
    prompt += `- \`context/deps/\` — output from tasks this depends on\n\n`;

    const acceptanceCriteria = this.extractPlanSection(context.planContent, 'Acceptance Criteria');
    if (acceptanceCriteria) {
      prompt += `## Acceptance Criteria\n\n${acceptanceCriteria}\n\n`;
    }

    const technicalApproach = this.extractPlanSection(context.planContent, 'Technical Approach');
    if (technicalApproach) {
      prompt += `## Technical Approach\n\n${technicalApproach}\n\n`;
    }

    prompt += `## Instructions\n\n`;
    prompt += `1. Work on branch \`${config.branch}\` (already checked out).\n`;
    prompt += `2. Implement the task according to the acceptance criteria.\n`;
    prompt += `3. Write comprehensive tests (unit, and integration where applicable).\n`;
    prompt += `4. Run \`${config.testCommand}\` and ensure all tests pass.\n`;
    prompt += `5. Commit your changes with a descriptive message.\n`;
    prompt += `6. Write your completion summary to \`.opensprint/active/${config.taskId}/result.json\`.\n\n`;

    if (config.previousFailure) {
      prompt += `## Previous Attempt\n\n`;
      prompt += `This is a retry. The previous attempt failed:\n${config.previousFailure}\n\n`;
    }

    if (config.reviewFeedback) {
      prompt += `## Review Feedback\n\n`;
      prompt += `The review agent rejected the previous implementation:\n${config.reviewFeedback}\n\n`;
    }

    return prompt;
  }

  private generateReviewPrompt(config: ActiveTaskConfig, context: TaskContext): string {
    let prompt = `# Review Task: ${context.title}\n\n`;
    prompt += `## Objective\n\n`;
    prompt += `Review the implementation of this task against its specification and acceptance criteria.\n\n`;
    prompt += `## Task Specification\n\n${context.description}\n\n`;

    const acceptanceCriteria = this.extractPlanSection(context.planContent, 'Acceptance Criteria');
    if (acceptanceCriteria) {
      prompt += `## Acceptance Criteria\n\n${acceptanceCriteria}\n\n`;
    }

    prompt += `## Implementation\n\n`;
    prompt += `The coding agent has committed changes on branch \`${config.branch}\`.\n`;
    prompt += `Run \`git diff main...${config.branch}\` to review the changes.\n\n`;
    prompt += `## Instructions\n\n`;
    prompt += `1. Review the diff between main and the task branch using \`git diff main...${config.branch}\`.\n`;
    prompt += `2. Verify the implementation meets ALL acceptance criteria.\n`;
    prompt += `3. Verify tests exist and cover the ticket scope (not just happy paths).\n`;
    prompt += `4. Run \`${config.testCommand}\` and confirm all tests pass.\n`;
    prompt += `5. Check code quality: no obvious bugs, reasonable error handling, consistent style.\n`;
    prompt += `6. If approving: merge the branch to main (\`git checkout main && git merge ${config.branch}\`) and write your result to \`.opensprint/active/${config.taskId}/result.json\` with status "approved".\n`;
    prompt += `7. If rejecting: do NOT merge. Write your result to \`.opensprint/active/${config.taskId}/result.json\` with status "rejected" and provide specific, actionable feedback.\n\n`;

    return prompt;
  }
}
