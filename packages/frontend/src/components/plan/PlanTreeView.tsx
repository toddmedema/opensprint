import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Plan, PlanDependencyEdge, PlanStatus } from "@opensprint/shared";
import { buildPlanTree, canCreateSubPlan, sortPlansByStatus } from "@opensprint/shared";
import { formatPlanIdAsTitle } from "../../lib/formatting";
import { parsePlanContent } from "../../lib/planContentUtils";
import { GitHubIssueLink } from "./GitHubIssueLink";
import type { PlanGenState } from "../../lib/planGenerationState";
import { PLANNING_TOOLTIP, STALE_TOOLTIP } from "../../lib/planGenerationState";
import {
  PHASE_QUEUE_LIST_SECTION_BODY_CLASSNAME,
  PHASE_QUEUE_ROW_INNER_CLASSNAME,
  PHASE_QUEUE_ROW_META_MUTED_CLASSNAME,
  PHASE_QUEUE_ROW_TITLE_CLASSNAME,
  phaseQueueRowSurfaceClassName,
  phaseQueueRowPrimaryButtonClassName,
} from "../../lib/phaseQueueListView";
import {
  PlanEpicTaskCapIndicator,
  PLAN_TASK_BATCH_MAX,
  computePlanSubtreeTaskAggregate,
  type PlanSubtreeAggregate,
} from "./planTaskBatchCap";

const STATUS_BADGE_LABEL: Record<PlanStatus, string> = {
  planning: "Planning",
  building: "Building",
  in_review: "In review",
  complete: "Complete",
};

const STATUS_BADGE_CLASS: Record<PlanStatus, string> = {
  planning: "bg-theme-info-bg text-brand-700 dark:text-brand-300",
  building: "bg-theme-surface-muted text-theme-text",
  in_review: "bg-theme-warning-bg text-theme-warning-text",
  complete: "bg-theme-success-bg text-theme-success-text",
};

const TREE_TOGGLE_CLASSNAME =
  "shrink-0 inline-flex h-6 w-6 items-center justify-center rounded text-theme-muted hover:bg-theme-border-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500";

const SPLIT_IMPOSSIBLE_TOOLTIP = `Sub-plan split is not possible at maximum depth. Generate tasks (up to ${PLAN_TASK_BATCH_MAX}) to finish decomposition.`;

const PARENT_SUBPLANS_DELEGATE_COPY = "Sub-plans created — generate tasks on each sub-plan";

const PLAN_TOO_LARGE_COPY =
  "This plan may be too large for a single batch — consider narrowing scope in the SPEC";

export interface PlanTreeViewProps {
  plans: Plan[];
  edges: PlanDependencyEdge[];
  selectedPlanId: string | null;
  executingPlanId: string | null;
  reExecutingPlanId: string | null;
  planTasksPlanIds: string[];
  executeError: { planId: string; message: string } | null;
  onSelectPlan: (plan: Plan) => void;
  onShip: (planId: string, lastExecutedVersionNumber?: number) => void;
  onPlanTasks: (planId: string) => void;
  onReship: (planId: string) => void;
  onClearError: () => void;
  onMarkComplete?: (planId: string) => void;
  markCompletePendingPlanId?: string | null;
  onGoToEvaluate?: () => void;
  autoExecutePlans?: boolean;
  getPlanGenState?: (planId: string) => PlanGenState;
  onRetryPlan?: (planId: string) => void;
}

interface PlanTreeNode {
  plan: Plan;
  children: PlanTreeNode[];
}

function isChildPlanEntity(plan: Plan): boolean {
  const raw = plan.metadata.parentPlanId ?? plan.parentPlanId;
  return typeof raw === "string" && raw.trim() !== "";
}

function subtreeAllLeavesHaveTasks(node: PlanTreeNode): boolean {
  if (node.children.length === 0) {
    const p = node.plan;
    return p.hasGeneratedPlanTasksForCurrentVersion === true || (p.taskCount ?? 0) > 0;
  }
  return node.children.every(subtreeAllLeavesHaveTasks);
}

interface RowCallbacks {
  selectedPlanId: string | null;
  executingPlanId: string | null;
  reExecutingPlanId: string | null;
  planTasksPlanIds: string[];
  executeError: PlanTreeViewProps["executeError"];
  onSelectPlan: PlanTreeViewProps["onSelectPlan"];
  onSelectPlanById: (planId: string) => void;
  onShip: PlanTreeViewProps["onShip"];
  onPlanTasks: PlanTreeViewProps["onPlanTasks"];
  onReship: PlanTreeViewProps["onReship"];
  onClearError: PlanTreeViewProps["onClearError"];
  onMarkComplete?: PlanTreeViewProps["onMarkComplete"];
  markCompletePendingPlanId: string | null;
  onGoToEvaluate?: PlanTreeViewProps["onGoToEvaluate"];
  autoExecutePlans: boolean;
  getPlanGenState?: PlanTreeViewProps["getPlanGenState"];
  onRetryPlan?: PlanTreeViewProps["onRetryPlan"];
}

function planDisplayTitle(plan: Plan): string {
  const { title } = parsePlanContent(plan.content ?? "");
  if (title.trim()) return title.trim();
  return formatPlanIdAsTitle(plan.metadata.planId);
}

function buildPlanForest(plans: Plan[]): PlanTreeNode[] {
  if (plans.length === 0) return [];
  const idSet = new Set(plans.map((p) => p.metadata.planId));
  const entries = plans.map((p) => ({
    planId: p.metadata.planId,
    parentPlanId: p.metadata.parentPlanId,
    plan: p,
  }));
  const byParent = buildPlanTree(entries);

  const roots: Plan[] = [];
  for (const p of plans) {
    const parent = p.metadata.parentPlanId;
    if (!parent || !idSet.has(parent)) roots.push(p);
  }

  const sortedChildren = (list: Plan[]) => sortPlansByStatus([...list]);

  function toNode(plan: Plan): PlanTreeNode {
    const rawKids = byParent.get(plan.metadata.planId) ?? [];
    const childPlans = rawKids.map((e) => e.plan);
    return { plan, children: sortedChildren(childPlans).map(toNode) };
  }

  return sortedChildren(roots).map(toNode);
}

function useBlockingPlanSummariesByPlanId(plans: Plan[], edges: PlanDependencyEdge[]) {
  return useMemo(() => {
    const map = new Map<string, { planId: string; title: string }[]>();
    if (!edges.length) return map;
    const planById = new Map(plans.map((p) => [p.metadata.planId, p]));
    for (const p of plans) {
      const id = p.metadata.planId;
      const summaries = edges
        .filter((e) => e.to === id && e.type === "blocks")
        .map((e) => e.from)
        .filter((fromId) => {
          const blocker = planById.get(fromId);
          return blocker != null && blocker.status !== "complete";
        })
        .map((fromId) => {
          const blocker = planById.get(fromId)!;
          return { planId: fromId, title: planDisplayTitle(blocker) };
        });
      if (summaries.length) map.set(id, summaries);
    }
    return map;
  }, [plans, edges]);
}

function collectVisibleIds(nodes: PlanTreeNode[], collapsedIds: Set<string>, out: string[]) {
  for (const n of nodes) {
    const id = n.plan.metadata.planId;
    out.push(id);
    const collapsed = collapsedIds.has(id);
    if (n.children.length > 0 && !collapsed) {
      collectVisibleIds(n.children, collapsedIds, out);
    }
  }
}

function buildParentMap(
  nodes: PlanTreeNode[],
  parentId: string | null,
  map: Map<string, string | null>
) {
  for (const n of nodes) {
    const id = n.plan.metadata.planId;
    map.set(id, parentId);
    if (n.children.length) buildParentMap(n.children, id, map);
  }
}

function findFirstChildId(node: PlanTreeNode): string | null {
  return node.children[0]?.plan.metadata.planId ?? null;
}

function findNodeById(nodes: PlanTreeNode[], id: string): PlanTreeNode | null {
  for (const n of nodes) {
    if (n.plan.metadata.planId === id) return n;
    const found = findNodeById(n.children, id);
    if (found) return found;
  }
  return null;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-4 w-4 transition-transform ${expanded ? "" : "-rotate-90"}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function PlanTreeRowInner({
  plan,
  isSelected,
  executingPlanId,
  reExecutingPlanId,
  planTasksPlanIds,
  executeError,
  onShip,
  onPlanTasks,
  onReship,
  onClearError,
  onMarkComplete,
  markCompletePendingPlanId,
  onGoToEvaluate,
  autoExecutePlans,
  planGenState = "ready",
  onRetryPlan,
  treeDepth,
  leadingControl,
  blockingSummaries,
  showMaxDepthHint,
  subtreeAggregate,
  hasChildPlans,
  subtreeLeavesAllHaveTasks,
  onSelectPlanById,
}: {
  plan: Plan;
  isSelected: boolean;
  executingPlanId: string | null;
  reExecutingPlanId: string | null;
  planTasksPlanIds: string[];
  executeError: { planId: string; message: string } | null;
  onShip: (planId: string, lastExecutedVersionNumber?: number) => void;
  onPlanTasks: (planId: string) => void;
  onReship: (planId: string) => void;
  onClearError: () => void;
  onMarkComplete?: (planId: string) => void;
  markCompletePendingPlanId?: string | null;
  onGoToEvaluate?: () => void;
  autoExecutePlans?: boolean;
  planGenState?: PlanGenState;
  onRetryPlan?: (planId: string) => void;
  treeDepth: number;
  leadingControl: ReactNode;
  blockingSummaries: { planId: string; title: string }[];
  showMaxDepthHint: boolean;
  subtreeAggregate: PlanSubtreeAggregate | null;
  hasChildPlans: boolean;
  subtreeLeavesAllHaveTasks: boolean;
  onSelectPlanById: (planId: string) => void;
}) {
  const isMarkCompletePending = markCompletePendingPlanId === plan.metadata.planId;
  const planId = plan.metadata.planId;
  const isExecuting = executingPlanId === planId;
  const hasGeneratedTasksForCurrentVersion = plan.hasGeneratedPlanTasksForCurrentVersion === true;
  const isPlanningTasks =
    plan.status === "planning" &&
    !hasGeneratedTasksForCurrentVersion &&
    planTasksPlanIds.includes(planId);
  const isPlannerInFlight = planGenState === "planning";
  const isPlannerStale = planGenState === "stale";
  const baseReadyForTaskGeneration =
    plan.status === "planning" &&
    !hasGeneratedTasksForCurrentVersion &&
    !autoExecutePlans &&
    !planTasksPlanIds.includes(planId) &&
    !isPlannerInFlight &&
    !isPlannerStale;

  const showProminentChildGenerate =
    baseReadyForTaskGeneration && !hasChildPlans && isChildPlanEntity(plan) && plan.taskCount === 0;

  const showGenerateTasks =
    baseReadyForTaskGeneration && !hasChildPlans && !showProminentChildGenerate;

  const showParentDelegateHint =
    hasChildPlans &&
    plan.status === "planning" &&
    !hasGeneratedTasksForCurrentVersion &&
    !subtreeLeavesAllHaveTasks &&
    !isPlannerInFlight &&
    !isPlannerStale;

  const showAllSubplansHaveTasks = hasChildPlans && subtreeLeavesAllHaveTasks;

  const showTooLargeHint =
    plan.tooLargeForLeaf === true || (plan.failedPlanIds?.includes(planId) ?? false);
  const showExecute =
    plan.status === "planning" &&
    !isPlannerInFlight &&
    !isPlannerStale &&
    (hasGeneratedTasksForCurrentVersion ||
      (autoExecutePlans &&
        (planTasksPlanIds.includes(planId) || !hasGeneratedTasksForCurrentVersion)));
  const showMarkComplete = plan.status === "in_review" && onMarkComplete;
  const showReship =
    plan.status === "complete" &&
    plan.metadata.shippedAt &&
    plan.lastModified &&
    plan.lastModified > plan.metadata.shippedAt;
  const errorForThisPlan = executeError?.planId === planId;

  const rowPadLeft = `calc(0.75rem + ${treeDepth * 14}px)`;
  const depthVal = plan.depth ?? plan.metadata.depth ?? treeDepth + 1;

  return (
    <>
      {isPlanningTasks && (
        <span data-testid="plan-tasks-loading" className="sr-only" role="status" aria-live="polite">
          Generating tasks
        </span>
      )}
      <div
        className={`${PHASE_QUEUE_ROW_INNER_CLASSNAME} min-h-[52px] border-l-2 border-theme-border-subtle`}
        style={{ paddingLeft: rowPadLeft, marginLeft: treeDepth > 0 ? "2px" : undefined }}
      >
        {leadingControl}
        <div className={phaseQueueRowPrimaryButtonClassName(isSelected)}>
          <span className={PHASE_QUEUE_ROW_TITLE_CLASSNAME} title={planDisplayTitle(plan)}>
            {planDisplayTitle(plan)}
          </span>
          <GitHubIssueLink issue={plan.metadata.githubIssue} compact />
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_BADGE_CLASS[plan.status]}`}
            data-testid={`plan-tree-status-${planId}`}
          >
            {STATUS_BADGE_LABEL[plan.status]}
          </span>
          <span
            className="shrink-0 text-xs text-theme-muted tabular-nums"
            data-testid={`plan-tree-depth-${planId}`}
            title={`Hierarchy depth ${depthVal} (max 4 levels)`}
          >
            D{depthVal}
          </span>
          {showMaxDepthHint && (
            <span
              className="shrink-0 text-xs text-theme-muted max-w-[140px] truncate"
              title="This plan is at the maximum sub-plan depth. Further work should be split into tasks, not nested plans."
              data-testid="plan-tree-max-depth-hint"
            >
              Max depth
            </span>
          )}
          {showMaxDepthHint && (
            <span
              className="sr-only"
              aria-disabled="true"
              data-testid={`plan-tree-split-impossible-${planId}`}
            >
              {SPLIT_IMPOSSIBLE_TOOLTIP}
            </span>
          )}
          <PlanEpicTaskCapIndicator taskCount={plan.taskCount} testIdSuffix={planId} />
          {plan.status === "planning" && isPlanningTasks && (
            <span className={PHASE_QUEUE_ROW_META_MUTED_CLASSNAME} aria-hidden>
              Generating tasks...
            </span>
          )}
          {plan.status === "planning" && isPlannerInFlight && !isPlanningTasks && (
            <span
              className={`${PHASE_QUEUE_ROW_META_MUTED_CLASSNAME} flex items-center gap-1`}
              title={PLANNING_TOOLTIP}
            >
              <span
                className="inline-block w-3 h-3 border-2 border-theme-border border-t-brand-500 rounded-full animate-spin"
                aria-hidden
              />
              Planning…
            </span>
          )}
          {plan.status === "planning" && isPlannerStale && !isPlanningTasks && (
            <span className="shrink-0 text-xs text-theme-warning-text" title={STALE_TOOLTIP}>
              May be stuck
            </span>
          )}
          {showAllSubplansHaveTasks && (
            <span
              className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-theme-success-text"
              data-testid={`plan-tree-all-subplans-tasks-${planId}`}
            >
              <span aria-hidden>✓</span>
              All sub-plans have tasks
            </span>
          )}
        </div>
        <span
          className="shrink-0 flex items-center gap-1.5"
          data-testid="plan-list-action-cluster"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          {isPlannerInFlight && !isPlanningTasks && (
            <span
              className="shrink-0 text-xs font-medium text-theme-muted px-2 py-1 rounded cursor-default opacity-60"
              title={PLANNING_TOOLTIP}
              aria-disabled="true"
              data-testid="plan-list-planning-indicator"
            >
              Planning
            </span>
          )}
          {isPlannerStale && !isPlanningTasks && onRetryPlan && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRetryPlan(planId);
              }}
              className="shrink-0 text-xs font-medium text-theme-warning-text hover:bg-theme-warning-bg px-2 py-1 rounded transition-colors"
              title={STALE_TOOLTIP}
              data-testid="plan-list-retry"
            >
              Retry
            </button>
          )}
          {showGenerateTasks && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPlanTasks(planId);
              }}
              title={showMaxDepthHint ? SPLIT_IMPOSSIBLE_TOOLTIP : undefined}
              className="shrink-0 text-xs font-medium text-brand-600 hover:bg-theme-info-bg px-2 py-1 rounded transition-colors"
              data-testid={`plan-tree-generate-tasks-${planId}`}
            >
              Generate tasks
            </button>
          )}
          {showExecute && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onShip(planId, plan.lastExecutedVersionNumber);
              }}
              disabled={
                !!executingPlanId ||
                (autoExecutePlans && !hasGeneratedTasksForCurrentVersion && isPlanningTasks)
              }
              className="shrink-0 text-xs font-medium text-brand-600 hover:bg-theme-info-bg px-2 py-1 rounded transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="plan-list-execute"
            >
              {isExecuting ||
              (autoExecutePlans && !hasGeneratedTasksForCurrentVersion && isPlanningTasks)
                ? !hasGeneratedTasksForCurrentVersion && isPlanningTasks
                  ? "Generating tasks…"
                  : "Executing…"
                : plan.lastExecutedVersionNumber != null
                  ? `Execute v${plan.lastExecutedVersionNumber}`
                  : "Execute"}
            </button>
          )}
          {showMarkComplete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMarkComplete!(planId);
              }}
              disabled={!!isMarkCompletePending}
              className="shrink-0 text-xs font-medium text-brand-600 hover:bg-theme-info-bg px-2 py-1 rounded transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="plan-list-mark-complete"
            >
              {isMarkCompletePending ? "…" : "Approve"}
            </button>
          )}
          {onGoToEvaluate && plan.status === "in_review" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onGoToEvaluate();
              }}
              className="shrink-0 text-xs font-medium text-theme-muted hover:bg-theme-border-subtle px-2 py-1 rounded transition-colors"
              data-testid="plan-list-go-to-evaluate"
            >
              Review
            </button>
          )}
          {showReship && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReship(planId);
              }}
              disabled={!!reExecutingPlanId}
              className="shrink-0 text-xs font-medium text-theme-muted hover:bg-theme-border-subtle px-2 py-1 rounded transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="plan-list-reship"
            >
              {reExecutingPlanId === planId ? "…" : "Re-execute"}
            </button>
          )}
          {errorForThisPlan && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClearError();
              }}
              className="shrink-0 text-xs text-theme-error-text hover:bg-theme-error-bg px-2 py-1 rounded"
              aria-label="Dismiss error"
              data-testid="plan-list-dismiss-error"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </span>
      </div>
      {subtreeAggregate != null && (
        <div
          className="px-4 pb-2 text-xs text-theme-muted"
          style={{ paddingLeft: `calc(0.75rem + 24px + ${treeDepth * 14}px)` }}
          data-testid={`plan-tree-subtree-aggregate-${planId}`}
        >
          Total tasks: {subtreeAggregate.totalIncludingSelf} across{" "}
          {subtreeAggregate.descendantPlanCount} sub-plans
        </div>
      )}
      {showParentDelegateHint && (
        <div
          className="px-4 pb-1.5 text-xs text-theme-muted leading-snug"
          style={{ paddingLeft: `calc(0.75rem + 24px + ${treeDepth * 14}px)` }}
          data-testid={`plan-tree-parent-delegate-${planId}`}
          role="status"
        >
          {PARENT_SUBPLANS_DELEGATE_COPY}
        </div>
      )}
      {showProminentChildGenerate && (
        <div
          className="px-4 pb-2"
          style={{ paddingLeft: `calc(0.75rem + 24px + ${treeDepth * 14}px)` }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPlanTasks(planId);
            }}
            title={showMaxDepthHint ? SPLIT_IMPOSSIBLE_TOOLTIP : undefined}
            className="w-full max-w-sm text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-600 px-4 py-2.5 rounded-lg shadow-sm transition-colors"
            data-testid={`plan-tree-generate-tasks-cta-row-${planId}`}
          >
            Generate tasks
          </button>
        </div>
      )}
      {blockingSummaries.length > 0 && (
        <div
          className="px-4 pb-2 text-xs text-theme-muted"
          style={{ paddingLeft: `calc(0.75rem + 24px + ${treeDepth * 14}px)` }}
          role="status"
          data-testid={`plan-list-blocked-hint-${planId}`}
        >
          <span className="text-theme-text font-medium">Blocked by:</span>{" "}
          {blockingSummaries.map((b, i) => (
            <span key={b.planId}>
              {i > 0 ? ", " : ""}
              <button
                type="button"
                className="text-brand-600 hover:underline font-medium"
                data-testid={`plan-tree-blocker-link-${planId}-${b.planId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPlanById(b.planId);
                }}
              >
                {b.title}
              </button>
            </span>
          ))}
        </div>
      )}
      {showTooLargeHint && (
        <div
          className="px-4 pb-2 text-xs text-theme-warning-text"
          style={{ paddingLeft: `calc(0.75rem + 24px + ${treeDepth * 14}px)` }}
          role="alert"
          data-testid={`plan-tree-too-large-${planId}`}
        >
          {PLAN_TOO_LARGE_COPY}
        </div>
      )}
      {errorForThisPlan && executeError && (
        <div
          className="px-4 py-2 text-xs text-theme-error-text bg-theme-error-bg border-b border-theme-border-subtle"
          role="alert"
          data-testid="plan-list-execute-error"
        >
          {executeError.message}
        </div>
      )}
    </>
  );
}

function PlanTreeItem({
  node,
  treeDepth,
  collapsedIds,
  onToggleCollapsed,
  blockingByPlanId,
  rowProps,
  focusedPlanId,
  onTreeKeyDown,
  setFocusedPlanId,
}: {
  node: PlanTreeNode;
  treeDepth: number;
  collapsedIds: Set<string>;
  onToggleCollapsed: (planId: string) => void;
  blockingByPlanId: Map<string, { planId: string; title: string }[]>;
  rowProps: RowCallbacks;
  focusedPlanId: string | null;
  onTreeKeyDown: (e: KeyboardEvent<HTMLLIElement>, planId: string) => void;
  setFocusedPlanId: (id: string | null) => void;
}) {
  const planId = node.plan.metadata.planId;
  const hasChildren = node.children.length > 0;
  const collapsed = collapsedIds.has(planId);
  const blockingSummaries = blockingByPlanId.get(planId) ?? [];
  const subtreeLeavesAllHaveTasks = subtreeAllLeavesHaveTasks(node);
  const depthVal = node.plan.depth ?? node.plan.metadata.depth ?? treeDepth + 1;
  const showMaxDepthHint = depthVal != null && !canCreateSubPlan(depthVal);
  const subtreeAggregate = node.children.length > 0 ? computePlanSubtreeTaskAggregate(node) : null;

  const title = planDisplayTitle(node.plan);
  const leadingControl = hasChildren ? (
    <button
      type="button"
      className={TREE_TOGGLE_CLASSNAME}
      aria-label={
        collapsed ? `Expand sub-plans under ${title}` : `Collapse sub-plans under ${title}`
      }
      aria-expanded={!collapsed}
      data-testid={`plan-tree-toggle-${planId}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggleCollapsed(planId);
      }}
    >
      <ChevronIcon expanded={!collapsed} />
    </button>
  ) : (
    <span className="inline-flex h-6 w-6 shrink-0" aria-hidden />
  );

  const isSelected = rowProps.selectedPlanId === planId;
  const isFocused = focusedPlanId === planId;

  return (
    <li
      role="treeitem"
      aria-selected={isSelected}
      aria-level={treeDepth + 1}
      aria-expanded={hasChildren ? !collapsed : undefined}
      data-testid={`plan-tree-row-${planId}`}
      data-plan-focus-id={planId}
      tabIndex={isFocused ? 0 : -1}
      className={`flex w-full min-w-0 cursor-pointer flex-col outline-none focus-visible:outline-none ${phaseQueueRowSurfaceClassName(isSelected)}`}
      data-queue-row-selected={isSelected ? "true" : "false"}
      aria-current={isSelected ? "true" : undefined}
      onFocus={() => setFocusedPlanId(planId)}
      onClick={(e: MouseEvent<HTMLLIElement>) => {
        const el = e.target as HTMLElement;
        if (el.closest('[data-testid="plan-list-action-cluster"]')) return;
        if (el.closest("button") && !el.closest(`[data-testid="plan-tree-toggle-${planId}"]`)) {
          return;
        }
        if (el.closest(`[data-testid="plan-tree-toggle-${planId}"]`)) return;
        rowProps.onSelectPlan(node.plan);
      }}
      onKeyDown={(e) => {
        onTreeKeyDown(e, planId);
      }}
    >
      <PlanTreeRowInner
        plan={node.plan}
        isSelected={isSelected}
        treeDepth={treeDepth}
        leadingControl={leadingControl}
        blockingSummaries={blockingSummaries}
        showMaxDepthHint={showMaxDepthHint}
        subtreeAggregate={subtreeAggregate}
        hasChildPlans={hasChildren}
        subtreeLeavesAllHaveTasks={subtreeLeavesAllHaveTasks}
        onSelectPlanById={rowProps.onSelectPlanById}
        executingPlanId={rowProps.executingPlanId}
        reExecutingPlanId={rowProps.reExecutingPlanId}
        planTasksPlanIds={rowProps.planTasksPlanIds}
        executeError={rowProps.executeError}
        onShip={rowProps.onShip}
        onPlanTasks={rowProps.onPlanTasks}
        onReship={rowProps.onReship}
        onClearError={rowProps.onClearError}
        onMarkComplete={rowProps.onMarkComplete}
        markCompletePendingPlanId={rowProps.markCompletePendingPlanId}
        onGoToEvaluate={rowProps.onGoToEvaluate}
        autoExecutePlans={rowProps.autoExecutePlans}
        planGenState={rowProps.getPlanGenState?.(planId)}
        onRetryPlan={rowProps.onRetryPlan}
      />
      {hasChildren && !collapsed && (
        <ul
          role="group"
          className={`${PHASE_QUEUE_LIST_SECTION_BODY_CLASSNAME} border-l border-theme-border-subtle ml-3`}
          aria-label={`Sub-plans under ${title}`}
        >
          {node.children.map((child) => (
            <PlanTreeItem
              key={child.plan.metadata.planId}
              node={child}
              treeDepth={treeDepth + 1}
              collapsedIds={collapsedIds}
              onToggleCollapsed={onToggleCollapsed}
              blockingByPlanId={blockingByPlanId}
              rowProps={rowProps}
              focusedPlanId={focusedPlanId}
              onTreeKeyDown={onTreeKeyDown}
              setFocusedPlanId={setFocusedPlanId}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PlanTreeView({
  plans,
  edges,
  selectedPlanId,
  executingPlanId,
  reExecutingPlanId,
  planTasksPlanIds,
  executeError,
  onSelectPlan,
  onShip,
  onPlanTasks,
  onReship,
  onClearError,
  onMarkComplete,
  markCompletePendingPlanId = null,
  onGoToEvaluate,
  autoExecutePlans = false,
  getPlanGenState,
  onRetryPlan,
}: PlanTreeViewProps) {
  const forest = useMemo(() => buildPlanForest(plans), [plans]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const forestRef = useRef(forest);
  forestRef.current = forest;

  const visibleIds = useMemo(() => {
    const out: string[] = [];
    collectVisibleIds(forest, collapsedIds, out);
    return out;
  }, [forest, collapsedIds]);

  const parentById = useMemo(() => {
    const m = new Map<string, string | null>();
    buildParentMap(forest, null, m);
    return m;
  }, [forest]);

  const [focusedPlanId, setFocusedPlanId] = useState<string | null>(null);

  useEffect(() => {
    if (visibleIds.length === 0) {
      setFocusedPlanId(null);
      return;
    }
    if (focusedPlanId == null || !visibleIds.includes(focusedPlanId)) {
      setFocusedPlanId(visibleIds[0] ?? null);
    }
  }, [visibleIds, focusedPlanId]);

  useEffect(() => {
    if (selectedPlanId && visibleIds.includes(selectedPlanId)) {
      setFocusedPlanId(selectedPlanId);
    }
  }, [selectedPlanId, visibleIds]);

  useEffect(() => {
    if (!focusedPlanId) return;
    const el = document.querySelector<HTMLElement>(
      `[data-plan-focus-id="${CSS.escape(focusedPlanId)}"]`
    );
    el?.focus({ preventScroll: true });
  }, [focusedPlanId, visibleIds, collapsedIds]);

  const onToggleCollapsed = useCallback((planId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(planId)) next.delete(planId);
      else next.add(planId);
      return next;
    });
  }, []);

  const blockingByPlanId = useBlockingPlanSummariesByPlanId(plans, edges);

  const onSelectPlanById = useCallback(
    (planId: string) => {
      const p = plans.find((x) => x.metadata.planId === planId);
      if (p) onSelectPlan(p);
    },
    [plans, onSelectPlan]
  );

  const rowProps: RowCallbacks = {
    selectedPlanId,
    executingPlanId,
    reExecutingPlanId,
    planTasksPlanIds,
    executeError,
    onSelectPlan,
    onSelectPlanById,
    onShip,
    onPlanTasks,
    onReship,
    onClearError,
    onMarkComplete,
    markCompletePendingPlanId,
    onGoToEvaluate,
    autoExecutePlans,
    getPlanGenState,
    onRetryPlan,
  };

  const onTreeKeyDown = useCallback(
    (e: KeyboardEvent<HTMLLIElement>, planId: string) => {
      const f = forestRef.current;
      const node = findNodeById(f, planId);
      if (!node) return;

      const collapsed = collapsedIds.has(planId);
      const hasChildren = node.children.length > 0;
      const idx = visibleIds.indexOf(planId);
      const parentId = parentById.get(planId) ?? null;

      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const p = plans.find((x) => x.metadata.planId === planId);
        if (p) onSelectPlan(p);
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (idx >= 0 && idx < visibleIds.length - 1) setFocusedPlanId(visibleIds[idx + 1]!);
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (idx > 0) setFocusedPlanId(visibleIds[idx - 1]!);
        return;
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (hasChildren) {
          if (collapsed) onToggleCollapsed(planId);
          else {
            const first = findFirstChildId(node);
            if (first) setFocusedPlanId(first);
          }
        }
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (hasChildren && !collapsed) onToggleCollapsed(planId);
        else if (parentId) setFocusedPlanId(parentId);
        return;
      }
    },
    [collapsedIds, onSelectPlan, onToggleCollapsed, parentById, plans, visibleIds]
  );

  if (forest.length === 0) {
    return <div data-testid="plan-tree-view" className="w-full" />;
  }

  return (
    <div data-testid="plan-tree-view" className="w-full">
      <ul
        className={PHASE_QUEUE_LIST_SECTION_BODY_CLASSNAME}
        role="tree"
        aria-label="Plan hierarchy"
      >
        {forest.map((node) => (
          <PlanTreeItem
            key={node.plan.metadata.planId}
            node={node}
            treeDepth={0}
            collapsedIds={collapsedIds}
            onToggleCollapsed={onToggleCollapsed}
            blockingByPlanId={blockingByPlanId}
            rowProps={rowProps}
            focusedPlanId={focusedPlanId}
            onTreeKeyDown={onTreeKeyDown}
            setFocusedPlanId={setFocusedPlanId}
          />
        ))}
      </ul>
    </div>
  );
}
