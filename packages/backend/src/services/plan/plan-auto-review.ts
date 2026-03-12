/**
 * Plan auto-review: review created plans/tasks against codebase and close already-implemented tasks.
 * Internal module used by PlanDecomposeGenerateService.
 */
import type { Plan, ProjectSettings } from "@opensprint/shared";
import { getAgentForPlanningRole } from "@opensprint/shared";
import { AUTO_REVIEW_SYSTEM_PROMPT } from "./plan-prompts.js";
import { buildPlanTaskSummaryFromCreated } from "./plan-decompose-generate.js";
import { buildCodebaseContextForAutoReview } from "./plan-codebase-context.js";
import { agentService } from "../agent.service.js";
import { getCombinedInstructions } from "../agent-instructions.service.js";
import { extractJsonFromAgentResponse } from "../../utils/json-extract.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("plan-auto-review");

export interface PlanAutoReviewDeps {
  projectId: string;
  repoPath: string;
  settings: { aiAutonomyLevel?: string; hilConfig?: unknown };
  taskStore: {
    close(projectId: string, taskId: string, reason: string): Promise<void | unknown>;
  };
}

/**
 * Run auto-review: identify tasks already implemented in codebase and close them.
 */
export async function runAutoReviewPlanAgainstRepo(
  createdPlans: Array<Plan & { _createdTaskIds?: string[]; _createdTaskTitles?: string[] }>,
  deps: PlanAutoReviewDeps
): Promise<void> {
  if (createdPlans.length === 0) return;

  const validTaskIds = new Set<string>();
  for (const plan of createdPlans) {
    for (const id of plan._createdTaskIds ?? []) {
      validTaskIds.add(id);
    }
  }

  if (validTaskIds.size === 0) return;

  try {
    const codebaseContext = await buildCodebaseContextForAutoReview(deps.repoPath);
    const planSummary = buildPlanTaskSummaryFromCreated(createdPlans);

    const prompt = `Review the following plans and tasks against the codebase. Identify which tasks are already implemented.\n\n## Created plans and tasks\n\n${planSummary}\n\n${codebaseContext}`;

    const agentId = `plan-auto-review-${deps.projectId}-${Date.now()}`;

    const autoReviewSystemPrompt = `${AUTO_REVIEW_SYSTEM_PROMPT}\n\n${await getCombinedInstructions(deps.repoPath, "planner")}`;
    const response = await agentService.invokePlanningAgent({
      projectId: deps.projectId,
      role: "planner",
      config: getAgentForPlanningRole(deps.settings as ProjectSettings, "planner"),
      messages: [{ role: "user", content: prompt }],
      systemPrompt: autoReviewSystemPrompt,
      cwd: deps.repoPath,
      tracking: {
        id: agentId,
        projectId: deps.projectId,
        phase: "plan",
        role: "planner",
        label: "Plan auto-review",
      },
    });

    const parsed = extractJsonFromAgentResponse<{
      taskIdsToClose?: string[];
      reason?: string;
    }>(response.content, "taskIdsToClose");
    if (!parsed) {
      log.warn("Auto-review agent did not return valid JSON, skipping");
      return;
    }

    const ids = parsed.taskIdsToClose ?? [];
    const toClose = ids.filter((id) => validTaskIds.has(id));

    for (const taskId of toClose) {
      try {
        await deps.taskStore.close(deps.projectId, taskId, "Already implemented (auto-review)");
      } catch (err) {
        log.warn("Auto-review: failed to close task", { taskId, err });
      }
    }

    if (toClose.length > 0) {
      log.info("Auto-review marked tasks as done", { count: toClose.length, taskIds: toClose });
    }
  } catch (err) {
    log.error("Auto-review against repo failed", { err });
  }
}
