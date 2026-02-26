import type { PlanComplexity, TaskComplexity } from "@opensprint/shared";
import {
  taskStore as taskStoreSingleton,
  type TaskStoreService,
  type StoredTask,
} from "./task-store.service.js";

const VALID_COMPLEXITIES: PlanComplexity[] = ["low", "medium", "high", "very_high"];

/** Map plan complexity to task complexity: low/medium -> simple, high/very_high -> complex */
export function planComplexityToTask(plan: PlanComplexity): TaskComplexity {
  return plan === "low" || plan === "medium" ? "simple" : "complex";
}

/** Normalize legacy low/high to simple/complex */
function normalizeTaskComplexity(raw: string | undefined): TaskComplexity | undefined {
  if (raw === "simple" || raw === "complex") return raw;
  if (raw === "low") return "simple";
  if (raw === "high") return "complex";
  return undefined;
}

/**
 * Resolve task-level complexity: task's own value if set, else infer from epic's plan.
 * Returns undefined if no complexity can be determined. Migrates legacy low/high to simple/complex.
 */
export function getTaskComplexity(
  task: StoredTask,
  planComplexity: PlanComplexity | undefined
): TaskComplexity | undefined {
  const own = (task as { complexity?: string }).complexity;
  const normalized = normalizeTaskComplexity(own);
  if (normalized) return normalized;
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
 * E.g. task=simple, epic=complex → use complex. Returns PlanComplexity for getAgentForComplexity.
 */
export async function getComplexityForAgent(
  projectId: string,
  repoPath: string,
  task: StoredTask,
  taskStore?: TaskStoreService
): Promise<PlanComplexity | undefined> {
  const own = (task as { complexity?: string }).complexity;
  const taskComplexity = normalizeTaskComplexity(own);

  const planComplexity = await getPlanComplexityForTask(
    projectId,
    repoPath,
    task,
    taskStore
  );
  const epicComplexity: TaskComplexity | undefined = planComplexity
    ? planComplexityToTask(planComplexity)
    : undefined;

  const taskLevel = taskComplexity === "complex" ? 1 : taskComplexity === "simple" ? 0 : -1;
  const epicLevel = epicComplexity === "complex" ? 1 : epicComplexity === "simple" ? 0 : -1;
  const maxLevel = Math.max(taskLevel, epicLevel);

  if (maxLevel === 1) {
    return planComplexity && (planComplexity === "high" || planComplexity === "very_high")
      ? planComplexity
      : "high";
  }
  if (maxLevel === 0) return "low";
  return undefined;
}
