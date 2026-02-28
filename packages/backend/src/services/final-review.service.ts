/**
 * FinalReviewService — runs a final review agent when the last task of an epic is completed.
 * The agent assesses: (1) missing/incorrect functionality vs plan scope; (2) code quality;
 * (3) test coverage; (4) failing tests. Creates new tasks for any issues found.
 * Epic closure is gated on review pass or user approval.
 */

import type { StoredTask } from "./task-store.service.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { agentService } from "./agent.service.js";
import { getAgentForPlanningRole } from "@opensprint/shared";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { PlanService } from "./plan.service.js";
import { ProjectService } from "./project.service.js";
import { ContextAssembler } from "./context-assembler.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("final-review");

export interface FinalReviewProposedTask {
  title: string;
  description: string;
  priority?: number;
}

export interface FinalReviewResult {
  status: "pass" | "issues";
  assessment: string;
  proposedTasks: FinalReviewProposedTask[];
}

const FINAL_REVIEW_SYSTEM_PROMPT = `You are the Final Review agent for OpenSprint. When all implementation tasks of a plan/epic are completed, you perform a final assessment before the epic can be closed.

Your task: Given the plan scope, full implementation context (completed task summaries, codebase state), assess:
1. **Missing or incorrect functionality** — Does the implementation match the plan scope? Are there gaps or deviations?
2. **Code quality** — Are there obvious quality issues (structure, patterns, maintainability)?
3. **Test coverage** — Are critical paths tested? Are there obvious gaps?
4. **Failing tests** — Based on the context, would tests pass? (We don't run tests here; infer from implementation.)

Respond with ONLY valid JSON in this exact format (no markdown wrapper):
{
  "status": "pass" | "issues",
  "assessment": "Brief summary of your assessment (2-4 sentences).",
  "proposedTasks": [
    {"title": "Task title", "description": "What needs to be done", "priority": 1}
  ]
}

Rules:
- status "pass": Implementation meets plan scope; no significant issues. proposedTasks must be [].
- status "issues": You found issues. proposedTasks lists concrete tasks to address them. Each task should be actionable and linked to a specific gap.
- priority: 0-4 (0=highest). Omit for default 2.
- Be conservative: only propose tasks for clear, actionable issues. Do not nitpick.
- If the plan scope is fully met and quality is acceptable, return status "pass" with empty proposedTasks.`;

export class FinalReviewService {
  private taskStore = taskStoreSingleton;
  private planService = new PlanService();
  private projectService = new ProjectService();
  private contextAssembler = new ContextAssembler();

  /**
   * Run the final review agent for an epic whose implementation tasks are all closed.
   * Returns assessment and proposed tasks. Does not close the epic or create tasks.
   */
  async runFinalReview(
    projectId: string,
    epicId: string,
    repoPath: string
  ): Promise<FinalReviewResult | null> {
    const plan = await this.taskStore.planGetByEpicId(projectId, epicId);
    if (!plan) {
      log.info("Epic has no plan, skipping final review (e.g. deploy-fix epic)", {
        projectId,
        epicId,
      });
      return null;
    }

    const allIssues = await this.taskStore.listAll(projectId);
    const implTasks = allIssues.filter(
      (i) =>
        i.id.startsWith(epicId + ".") &&
        (i.issue_type ?? i.type) !== "epic" &&
        (i.status as string) === "closed"
    );
    if (implTasks.length === 0) {
      log.warn("No implementation tasks found for epic", { projectId, epicId });
      return null;
    }

    const depIds = implTasks.map((t) => t.id);
    const dependencyOutputs = await this.contextAssembler.collectDependencyOutputs(
      repoPath,
      depIds
    );

    const { fileTree, keyFilesContent } = await this.planService.getCodebaseContext(
      projectId
    );
    const prdExcerpt = await this.contextAssembler.extractPrdExcerpt(repoPath);

    const completedTasksSummary = implTasks
      .map((t) => {
        const out = dependencyOutputs.find((d) => d.taskId === t.id);
        const summary = out?.summary ?? (t.close_reason ?? "Completed");
        return `### ${t.id}: ${t.title}\n${summary}`;
      })
      .join("\n\n");

    const prompt = `## Plan scope

${plan.content}

## PRD excerpt

${prdExcerpt.slice(0, 8000)}${prdExcerpt.length > 8000 ? "\n\n...(truncated)" : ""}

## Completed implementation tasks

${completedTasksSummary}

## Repository file structure

\`\`\`
${fileTree}
\`\`\`

## Key source files

${keyFilesContent.slice(0, 15000)}${keyFilesContent.length > 15000 ? "\n\n...(truncated)" : ""}

---

Assess the implementation against the plan scope. Return JSON with status, assessment, and proposedTasks.`;

    const agentId = `final-review-${projectId}-${epicId}-${Date.now()}`;
    const settings = await this.projectService.getSettings(projectId);

    try {
      const response = await agentService.invokePlanningAgent({
        projectId,
        config: getAgentForPlanningRole(settings, "auditor"),
        messages: [{ role: "user", content: prompt }],
        systemPrompt: FINAL_REVIEW_SYSTEM_PROMPT,
        cwd: repoPath,
        tracking: {
          id: agentId,
          projectId,
          phase: "execute",
          role: "auditor",
          label: "Final review",
        },
      });

      const parsed = extractJsonFromAgentResponse<{
        status?: string;
        assessment?: string;
        proposedTasks?: Array<{ title?: string; description?: string; priority?: number }>;
      }>(response.content, "status");

      if (!parsed || !parsed.status) {
        log.warn("Final review agent did not return valid JSON, treating as pass", {
          projectId,
          epicId,
        });
        return {
          status: "pass",
          assessment: "Review agent did not return valid result; assuming pass.",
          proposedTasks: [],
        };
      }

      const status = parsed.status === "issues" ? "issues" : "pass";
      const proposedTasks: FinalReviewProposedTask[] = (parsed.proposedTasks ?? [])
        .filter((t) => t.title && t.description)
        .map((t) => ({
          title: String(t.title),
          description: String(t.description),
          priority: typeof t.priority === "number" ? Math.min(4, Math.max(0, t.priority)) : 2,
        }));

      return {
        status,
        assessment: parsed.assessment ?? "",
        proposedTasks,
      };
    } catch (err) {
      log.error("Final review agent failed", { projectId, epicId, err });
      return null;
    }
  }

  /**
   * Create tasks from proposed tasks and link them to the epic.
   */
  async createTasksFromReview(
    projectId: string,
    epicId: string,
    proposedTasks: FinalReviewProposedTask[]
  ): Promise<string[]> {
    const createdIds: string[] = [];
    for (const task of proposedTasks) {
      try {
        const created = await this.taskStore.create(projectId, task.title, {
          type: "task",
          description: task.description,
          priority: task.priority ?? 2,
          parentId: epicId,
        });
        createdIds.push(created.id);
      } catch (err) {
        log.warn("Failed to create task from final review", {
          projectId,
          epicId,
          title: task.title,
          err,
        });
      }
    }
    return createdIds;
  }
}

export const finalReviewService = new FinalReviewService();
