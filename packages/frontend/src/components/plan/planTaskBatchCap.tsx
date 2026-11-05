/** Matches backend `MAX_TASKS_PER_PLAN` / planner cap per plan node. */
export const PLAN_TASK_BATCH_MAX = 15;

export const PLAN_TASK_BATCH_CAP_TOOLTIP =
  "15 tasks maximum per plan to ensure quality and reviewability";

export function formatPlanTasksSidebarSectionTitle(taskCount: number): string {
  return `Tasks: ${taskCount} of ${PLAN_TASK_BATCH_MAX} max per batch`;
}

export interface PlanEpicTaskCapIndicatorProps {
  /** Raw implementation-task count for this plan epic (may exceed cap in edge cases). */
  taskCount: number;
  /** Optional suffix for stable `data-testid`s in list vs tree. */
  testIdSuffix?: string;
}

/**
 * Shows `{count}/15` with a horizontal fill bar once tasks exist; warning styling at the cap.
 * Tooltip explains the batch limit (native `title` for simplicity and a11y baseline).
 */
export function PlanEpicTaskCapIndicator({
  taskCount,
  testIdSuffix = "",
}: PlanEpicTaskCapIndicatorProps) {
  const safe = Number.isFinite(taskCount) ? Math.max(0, taskCount) : 0;
  if (safe === 0) return null;

  const displayCount = Math.min(safe, PLAN_TASK_BATCH_MAX);
  const pct = (displayCount / PLAN_TASK_BATCH_MAX) * 100;
  const atCap = safe >= PLAN_TASK_BATCH_MAX;
  const testId = `plan-epic-task-cap${testIdSuffix ? `-${testIdSuffix}` : ""}`;

  return (
    <span
      className="shrink-0 inline-flex items-center gap-1.5 min-w-0 max-w-full"
      data-testid={testId}
      title={PLAN_TASK_BATCH_CAP_TOOLTIP}
    >
      <span
        className={`tabular-nums text-xs whitespace-nowrap ${atCap ? "text-theme-warning-text font-medium" : "text-theme-muted"}`}
      >
        {displayCount}/{PLAN_TASK_BATCH_MAX}
      </span>
      <span
        className="h-1.5 w-12 max-w-[30%] rounded-full overflow-hidden shrink-0 bg-theme-border-subtle"
        aria-hidden
      >
        <span
          className={`block h-full rounded-full transition-[width] duration-150 ${atCap ? "bg-theme-warning-text" : "bg-brand-500"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

export interface PlanSubtreeAggregate {
  /** This plan's tasks plus every descendant plan's `taskCount`. */
  totalIncludingSelf: number;
  /** Number of descendant plan nodes (not including this node). */
  descendantPlanCount: number;
}

export type SubtreeNodeForAggregate = {
  plan: { taskCount: number };
  children: SubtreeNodeForAggregate[];
};

export function computePlanSubtreeTaskAggregate(
  node: SubtreeNodeForAggregate
): PlanSubtreeAggregate {
  let sumFromDescendants = 0;
  let descCount = 0;
  for (const c of node.children) {
    descCount += 1;
    const sub = computePlanSubtreeTaskAggregate(c);
    sumFromDescendants += sub.totalIncludingSelf;
    descCount += sub.descendantPlanCount;
  }
  return {
    totalIncludingSelf: node.plan.taskCount + sumFromDescendants,
    descendantPlanCount: descCount,
  };
}
