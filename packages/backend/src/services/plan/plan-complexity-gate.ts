/**
 * Complexity gate: decide whether a plan node should generate tasks directly
 * or split into sub-plans before task generation.
 */
import type { AgentConfig, PlanComplexity, ProjectSettings } from "@opensprint/shared";
import {
  type SubPlanDecompositionResult,
  parseSubPlanDecompositionResponse,
} from "./planner-normalize.js";
import {
  SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT,
  SUB_PLAN_DECOMPOSITION_REPAIR_PROMPT,
  MAX_SUB_PLAN_DEPTH,
  buildSubPlanCountRepairPrompt,
  buildTaskCountRepairPrompt,
  buildDepthExceededTaskRepairPrompt,
} from "./plan-prompts.js";
import { MAX_TASKS_PER_PLAN } from "./planner-normalize.js";
import { runPlannerWithRepoGuard } from "./plan-repo-guard.js";
import { getCombinedInstructions } from "../agent-instructions.service.js";
import { invokeStructuredPlanningAgent } from "../structured-agent-output.service.js";
import { createLogger } from "../../utils/logger.js";

import { buildPlanningTaskPolicy, type PlanningTaskSettings } from "./plan-task-policy.js";
import {
  formatPlanTaskHierarchyContextForPrompt,
  parseTaskGenerationContent,
  type PlanTaskHierarchyContext,
} from "./plan-task-generation.js";
import { buildAutonomyDescription } from "../autonomy-description.js";

const log = createLogger("plan-complexity-gate");

const MIN_SUB_PLANS = 2;
const MAX_SUB_PLANS = 8;

export interface EvaluatePlanComplexityOptions {
  projectId: string;
  repoPath: string;
  planContent: string;
  prdContext: string;
  currentDepth: number;
  agentConfig: AgentConfig;
  planComplexity?: PlanComplexity;
  settings?: PlanningTaskSettings & Pick<ProjectSettings, "aiAutonomyLevel" | "hilConfig">;
  hierarchyContext?: PlanTaskHierarchyContext;
  planId?: string;
  ancestorChainSummary?: string;
  siblingPlanSummaries?: string;
}

/**
 * Evaluate whether a plan should be decomposed into tasks directly or split
 * into sub-plans first. At depth >= MAX_PLAN_DEPTH, forces `strategy: 'tasks'`
 * without invoking the LLM.
 */
export async function evaluatePlanComplexity(
  options: EvaluatePlanComplexityOptions
): Promise<SubPlanDecompositionResult> {
  const {
    projectId,
    repoPath,
    planContent,
    prdContext,
    currentDepth,
    agentConfig,
    planId,
    ancestorChainSummary,
    siblingPlanSummaries,
  } = options;

  if (currentDepth >= MAX_SUB_PLAN_DEPTH) {
    log.info("Depth >= MAX_SUB_PLAN_DEPTH; forcing tasks strategy without LLM call", {
      currentDepth,
      maxDepth: MAX_SUB_PLAN_DEPTH,
      planId,
    });
    return { strategy: "tasks", tasks: [] };
  }

  const contextParts: string[] = [
    `## Feature Plan\n\n${planContent}`,
    `## PRD Context\n\n${prdContext}`,
    `## Current Depth\n\nThis plan is at depth **${currentDepth}** (max ${MAX_SUB_PLAN_DEPTH}).`,
  ];

  if (options.hierarchyContext) {
    contextParts.push(formatPlanTaskHierarchyContextForPrompt(options.hierarchyContext));
  }

  if (!options.hierarchyContext && ancestorChainSummary) {
    contextParts.push(`## Ancestor Chain\n\n${ancestorChainSummary}`);
  }
  if (!options.hierarchyContext && siblingPlanSummaries) {
    contextParts.push(`## Sibling Plans\n\n${siblingPlanSummaries}`);
  }

  const userPrompt =
    "Decide whether the following plan should be split into sub-plans or decomposed directly into implementation tasks.\n\n" +
    contextParts.join("\n\n");

  const agentId = `plan-complexity-gate-${projectId}-${Date.now()}`;

  const autonomy = options.settings
    ? buildAutonomyDescription(options.settings.aiAutonomyLevel, options.settings.hilConfig)
    : "";
  const systemPrompt = `${SUB_PLAN_DECOMPOSITION_SYSTEM_PROMPT}\n\n${buildPlanningTaskPolicy(options.settings)}${autonomy ? `\n\n## AI Autonomy Level\n\n${autonomy}` : ""}\n\n${await getCombinedInstructions(repoPath, "planner")}`;

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: userPrompt },
  ];

  const response = await runPlannerWithRepoGuard({
    repoPath,
    label: "Complexity gate",
    run: () =>
      invokeStructuredPlanningAgent({
        projectId,
        role: "planner",
        config: agentConfig,
        messages,
        systemPrompt,
        cwd: repoPath,
        tracking: {
          id: agentId,
          projectId,
          phase: "plan",
          role: "planner",
          label: "Complexity gate evaluation",
          planId,
        },
        contract: {
          parse: (content) => parseSubPlanDecompositionResponse(content),
          repairPrompt: (invalidReason) => {
            if (invalidReason?.startsWith("task-count-exceeded:")) {
              const countMatch = invalidReason.match(/returned (\d+) tasks/);
              const count = countMatch ? Number(countMatch[1]) : 0;
              return buildTaskCountRepairPrompt(count);
            }
            if (invalidReason?.startsWith("sub-plan-count-out-of-range:")) {
              const countMatch = invalidReason.match(/returned (\d+) sub-plans/);
              const count = countMatch ? Number(countMatch[1]) : 0;
              return buildSubPlanCountRepairPrompt(count);
            }
            if (invalidReason?.startsWith("depth-exceeded-sub-plans:")) {
              return buildDepthExceededTaskRepairPrompt(currentDepth);
            }
            return SUB_PLAN_DECOMPOSITION_REPAIR_PROMPT;
          },
          invalidReason: (content) => {
            const parsed = parseSubPlanDecompositionResponse(content);
            if (parsed) {
              if (parsed.strategy === "sub_plans" && currentDepth >= MAX_SUB_PLAN_DEPTH) {
                return `depth-exceeded-sub-plans: Agent returned sub_plans at depth ${currentDepth}, but max depth is ${MAX_SUB_PLAN_DEPTH}.`;
              }
              if (parsed.strategy === "tasks" && parsed.tasks.length > MAX_TASKS_PER_PLAN) {
                return `task-count-exceeded: Planner returned ${parsed.tasks.length} tasks, max is ${MAX_TASKS_PER_PLAN}.`;
              }
              if (
                parsed.strategy === "sub_plans" &&
                (parsed.subPlans.length < MIN_SUB_PLANS || parsed.subPlans.length > MAX_SUB_PLANS)
              ) {
                return `sub-plan-count-out-of-range: Planner returned ${parsed.subPlans.length} sub-plans, range is ${MIN_SUB_PLANS}–${MAX_SUB_PLANS}.`;
              }
              return undefined;
            }
            const taskResult = parseTaskGenerationContent(content);
            if (
              !taskResult.ok &&
              /^(duplicate|invalid)-task-title:/.test(taskResult.parseFailureReason)
            ) {
              return taskResult.parseFailureReason;
            }
            return "Agent response was not valid sub-plan decomposition JSON.";
          },
        },
      }),
  });

  if (response.parsed) {
    return response.parsed;
  }

  log.warn("Complexity gate agent did not return valid result; defaulting to tasks strategy", {
    planId,
    projectId,
    invalidReason: response.invalidReason,
  });
  return { strategy: "tasks", tasks: [] };
}
