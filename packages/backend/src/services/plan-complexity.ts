import type { PlanComplexity } from "@opensprint/shared";
import { clampTaskComplexity } from "@opensprint/shared";
import {
  taskStore as taskStoreSingleton,
  type TaskStoreService,
  type StoredTask,
} from "./task-store.service.js";

const VALID_COMPLEXITIES: PlanComplexity[] = ["low", "medium", "high", "very_high"];

/** Map plan complexity to task complexity (1-10): low/medium -> 3, high/very_high -> 7 */
export function planComplexityToTask(plan: PlanComplexity): number {
  return plan === "low" || plan === "medium" ? 3 : 7;
}

/**
 * Resolve task-level complexity: task's own value if set (1-10), else infer from epic's plan.
 * Returns undefined if no complexity can be determined.
 */
export function getTaskComplexity(
  task: StoredTask,
  planComplexity: PlanComplexity | undefined
): number | undefined {
  const own = clampTaskComplexity((task as { complexity?: number }).complexity);
  if (own != null) return own;
  if (planComplexity && VALID_COMPLEXITIES.includes(planComplexity)) {
    return planComplexityToTask(planComplexity);
  }
  return undefined;
}

/**
 * Resolve the plan complexity for a task by looking up its parent epic's plan in the task store.
 * Returns undefined if no complexity is found.
 */
export async function getPlanComplexityForTask(
  projectId: string,
  _repoPath: string,
  task: StoredTask,
  taskStore?: TaskStoreService
): Promise<PlanComplexity | undefined> {
  const store = taskStore ?? taskStoreSingleton;
  const parentId = store.getParentId(task.id);
  if (!parentId) return undefined;

  try {
    const plan = await store.planGetByEpicId(projectId, parentId);
    if (!plan?.metadata?.complexity) return undefined;
    const complexity = plan.metadata.complexity as string;
    if (VALID_COMPLEXITIES.includes(complexity as PlanComplexity)) {
      return complexity as PlanComplexity;
    }
  } catch {
    // Parent or plan might not exist
  }

  return undefined;
}

/**
 * Resolve complexity for agent selection: use the higher of task.complexity and epic.complexity.
 * E.g. task=3, epic=7 → use high. Returns PlanComplexity for getAgentForComplexity.
 */
export async function getComplexityForAgent(
  projectId: string,
  repoPath: string,
  task: StoredTask,
  taskStore?: TaskStoreService
): Promise<PlanComplexity | undefined> {
  const taskComplexity = clampTaskComplexity((task as { complexity?: number }).complexity);
  const planComplexity = await getPlanComplexityForTask(
    projectId,
    repoPath,
    task,
    taskStore
  );
  const epicComplexity = planComplexity ? planComplexityToTask(planComplexity) : undefined;

  const taskLevel = taskComplexity ?? -1;
  const epicLevel = epicComplexity ?? -1;
  const maxLevel = Math.max(taskLevel, epicLevel);

  if (maxLevel >= 6) {
    return planComplexity && (planComplexity === "high" || planComplexity === "very_high")
      ? planComplexity
      : "high";
  }
  if (maxLevel >= 1) return "low";
  return undefined;
}
