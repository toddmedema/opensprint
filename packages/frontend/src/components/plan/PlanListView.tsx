import {
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Plan, PlanDependencyEdge, PlanStatus } from "@opensprint/shared";
import { canCreateSubPlan, sortPlansByStatus } from "@opensprint/shared";
import { formatPlanIdAsTitle } from "../../lib/formatting";
import { GitHubIssueLink } from "./GitHubIssueLink";
import { parsePlanContent } from "../../lib/planContentUtils";
import type { PlanGenState } from "../../lib/planGenerationState";
import { PLANNING_TOOLTIP, STALE_TOOLTIP } from "../../lib/planGenerationState";
import { PhaseScrollSectionHeader } from "../PhaseScrollSectionHeader";
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
  computePlanSubtreeTaskAggregate,
  type PlanSubtreeAggregate,
} from "./planTaskBatchCap";

const PLAN_STATUS_ORDER: PlanStatus[] = ["planning", "building", "in_review", "complete"];

const SECTION_LABELS: Record<PlanStatus, string> = {
  planning: "Planning",
  building: "Building",
  in_review: "In review",
  complete: "Complete",
};

const TREE_TOGGLE_CLASSNAME =
  "shrink-0 inline-flex h-6 w-6 items-center justify-center rounded text-theme-muted hover:bg-theme-border-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500";

export interface PlanListViewProps {
  plans: Plan[];
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
  /** When set, the plan with this ID shows loading state for Mark complete. */
  markCompletePendingPlanId?: string | null;
  onGoToEvaluate?: () => void;
  autoExecutePlans?: boolean;
  /** Resolve per-plan generation state (planning/stale/ready). */
  getPlanGenState?: (planId: string) => PlanGenState;
  /** Called when user clicks Retry on a stale plan. */
  onRetryPlan?: (planId: string) => void;
  /**
   * Plan dependency edges (same graph as graph view). Incoming `blocks` edges from plans
   * that are not complete produce a short “waiting on …” line for list context.
   */
  planDependencyEdges?: PlanDependencyEdge[];
}

/** Callback bundle passed down the plan tree (stable shape for recursive items). */
interface PlanTreeRowProps {
  selectedPlanId: string | null;
  executingPlanId: string | null;
  reExecutingPlanId: string | null;
  planTasksPlanIds: string[];
  executeError: PlanListViewProps["executeError"];
  onSelectPlan: PlanListViewProps["onSelectPlan"];
  onShip: PlanListViewProps["onShip"];
  onPlanTasks: PlanListViewProps["onPlanTasks"];
  onReship: PlanListViewProps["onReship"];
  onClearError: PlanListViewProps["onClearError"];
  onMarkComplete?: PlanListViewProps["onMarkComplete"];
  markCompletePendingPlanId: string | null;
  onGoToEvaluate?: PlanListViewProps["onGoToEvaluate"];
  autoExecutePlans: boolean;
  getPlanGenState?: PlanListViewProps["getPlanGenState"];
  onRetryPlan?: PlanListViewProps["onRetryPlan"];
}

interface PlanTreeNode {
  plan: Plan;
  children: PlanTreeNode[];
}

function buildPlanForest(plans: Plan[]): PlanTreeNode[] {
  if (plans.length === 0) return [];
  const idSet = new Set(plans.map((p) => p.metadata.planId));
  const childrenByParent = new Map<string, Plan[]>();

  for (const p of plans) {
    const parent = p.metadata.parentPlanId;
    if (parent && idSet.has(parent)) {
      const arr = childrenByParent.get(parent);
      if (arr) arr.push(p);
      else childrenByParent.set(parent, [p]);
    }
  }

  const roots: Plan[] = [];
  for (const p of plans) {
    const parent = p.metadata.parentPlanId;
    if (!parent || !idSet.has(parent)) roots.push(p);
  }

  const sortedChildren = (list: Plan[]) => sortPlansByStatus([...list]);

  function toNode(plan: Plan): PlanTreeNode {
    const rawKids = childrenByParent.get(plan.metadata.planId) ?? [];
    return { plan, children: sortedChildren(rawKids).map(toNode) };
  }

  return sortedChildren(roots).map(toNode);
}

function useBlockingPlansById(plans: Plan[], edges: PlanDependencyEdge[] | undefined) {
  return useMemo(() => {
    const map = new Map<string, string[]>();
    if (!edges?.length) return map;
    const planById = new Map(plans.map((p) => [p.metadata.planId, p]));
    for (const p of plans) {
      const id = p.metadata.planId;
      const blockers = edges
        .filter((e) => e.to === id && e.type === "blocks")
        .map((e) => e.from)
        .filter((fromId) => {
          const blocker = planById.get(fromId);
          return blocker != null && blocker.status !== "complete";
        });
      if (blockers.length) map.set(id, blockers);
    }
    return map;
  }, [plans, edges]);
}

function PlanListRowInner({
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
  blockingPlanIds,
  showMaxDepthHint,
  subtreeAggregate,
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
  blockingPlanIds: string[];
  showMaxDepthHint: boolean;
  subtreeAggregate: PlanSubtreeAggregate | null;
}) {
  const isMarkCompletePending = markCompletePendingPlanId === plan.metadata.planId;
  const planId = plan.metadata.planId;
  const displayTitle = plan.metadata.githubIssue
    ? parsePlanContent(plan.content).title || formatPlanIdAsTitle(planId)
    : formatPlanIdAsTitle(planId);
  const isExecuting = executingPlanId === planId;
  const hasGeneratedTasksForCurrentVersion = plan.hasGeneratedPlanTasksForCurrentVersion === true;
  const isPlanningTasks =
    plan.status === "planning" &&
    !hasGeneratedTasksForCurrentVersion &&
    planTasksPlanIds.includes(planId);
  const isPlannerInFlight = planGenState === "planning";
  const isPlannerStale = planGenState === "stale";
  const showGenerateTasks =
    plan.status === "planning" &&
    !hasGeneratedTasksForCurrentVersion &&
    !autoExecutePlans &&
    !planTasksPlanIds.includes(planId) &&
    !isPlannerInFlight &&
    !isPlannerStale;
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

  const rowPadLeft = `calc(1rem + ${treeDepth * 12}px)`;

  return (
    <>
      {isPlanningTasks && (
        <span data-testid="plan-tasks-loading" className="sr-only" role="status" aria-live="polite">
          Generating tasks
        </span>
      )}
      <div
        className={`${PHASE_QUEUE_ROW_INNER_CLASSNAME} min-h-[52px]`}
        style={{ paddingLeft: rowPadLeft }}
      >
        {leadingControl}
        <div className={phaseQueueRowPrimaryButtonClassName(isSelected)}>
          <span className={PHASE_QUEUE_ROW_TITLE_CLASSNAME} title={displayTitle}>
            {displayTitle}
          </span>
          <GitHubIssueLink issue={plan.metadata.githubIssue} compact />
          {showMaxDepthHint && (
            <span
              className="shrink-0 text-xs text-theme-muted max-w-[140px] truncate"
              title="This plan is at the maximum sub-plan depth. Further work should be split into tasks, not nested plans."
              data-testid="plan-list-max-depth-hint"
            >
              Max depth
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
              className="shrink-0 text-xs font-medium text-brand-600 hover:bg-theme-info-bg px-2 py-1 rounded transition-colors"
              data-testid="plan-list-generate-tasks"
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
          style={{ paddingLeft: `calc(1rem + 24px + ${treeDepth * 12}px)` }}
          data-testid={`plan-list-subtree-aggregate-${planId}`}
        >
          Total tasks: {subtreeAggregate.totalIncludingSelf} across{" "}
          {subtreeAggregate.descendantPlanCount} sub-plans
        </div>
      )}
      {blockingPlanIds.length > 0 && (
        <div
          className="px-4 pb-2 text-xs text-theme-muted"
          style={{ paddingLeft: `calc(1rem + 24px + ${treeDepth * 12}px)` }}
          role="status"
          data-testid={`plan-list-blocked-hint-${planId}`}
        >
          Waiting on {blockingPlanIds.map((bid) => formatPlanIdAsTitle(bid)).join(", ")} before this
          plan can run.
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

function PlanTreeItem({
  node,
  treeDepth,
  collapsedIds,
  onToggleCollapsed,
  blockingByPlanId,
  rowProps,
}: {
  node: PlanTreeNode;
  treeDepth: number;
  collapsedIds: Set<string>;
  onToggleCollapsed: (planId: string) => void;
  blockingByPlanId: Map<string, string[]>;
  rowProps: PlanTreeRowProps;
}) {
  const planId = node.plan.metadata.planId;
  const hasChildren = node.children.length > 0;
  const collapsed = collapsedIds.has(planId);
  const blockingPlanIds = blockingByPlanId.get(planId) ?? [];
  const depthVal = node.plan.depth;
  const showMaxDepthHint = depthVal != null && !canCreateSubPlan(depthVal);
  const subtreeAggregate = node.children.length > 0 ? computePlanSubtreeTaskAggregate(node) : null;

  const title = formatPlanIdAsTitle(planId);
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

  const rowSurfaceHandlers = {
    "aria-current": (isSelected ? "true" : undefined) as "true" | undefined,
    "data-queue-row-selected": isSelected ? "true" : "false",
    tabIndex: 0 as const,
    onClick: (e: MouseEvent<HTMLLIElement>) => {
      const el = e.target as HTMLElement;
      if (el.closest('[data-testid="plan-list-action-cluster"]')) return;
      if (el.closest("button")) return;
      rowProps.onSelectPlan(node.plan);
    },
    onKeyDown: (e: KeyboardEvent<HTMLLIElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (document.activeElement !== e.currentTarget) return;
      e.preventDefault();
      rowProps.onSelectPlan(node.plan);
    },
  };

  return (
    <li
      role="treeitem"
      aria-selected={isSelected}
      data-testid={`plan-list-row-${planId}`}
      className={`flex w-full min-w-0 cursor-pointer flex-col outline-none focus-visible:outline-none ${phaseQueueRowSurfaceClassName(isSelected)}`}
      {...rowSurfaceHandlers}
    >
      <PlanListRowInner
        plan={node.plan}
        isSelected={isSelected}
        treeDepth={treeDepth}
        leadingControl={leadingControl}
        blockingPlanIds={blockingPlanIds}
        showMaxDepthHint={showMaxDepthHint}
        subtreeAggregate={subtreeAggregate}
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
          className="list-none divide-y divide-theme-border-subtle"
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
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Groups plans by status and renders a hierarchical tree with section headers and row actions on the right (Execute queue pattern). */
export function PlanListView({
  plans,
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
  planDependencyEdges,
}: PlanListViewProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const onToggleCollapsed = useCallback((planId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(planId)) next.delete(planId);
      else next.add(planId);
      return next;
    });
  }, []);

  const blockingByPlanId = useBlockingPlansById(plans, planDependencyEdges);

  const grouped = useMemo(() => {
    const byStatus: Record<PlanStatus, Plan[]> = {
      planning: [],
      building: [],
      in_review: [],
      complete: [],
    };
    for (const p of plans) {
      if (p.status in byStatus) byStatus[p.status as PlanStatus].push(p);
    }
    for (const status of PLAN_STATUS_ORDER) {
      byStatus[status] = sortPlansByStatus(byStatus[status]);
    }
    return byStatus;
  }, [plans]);

  const rowProps: PlanTreeRowProps = {
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
    markCompletePendingPlanId,
    onGoToEvaluate,
    autoExecutePlans,
    getPlanGenState,
    onRetryPlan,
  };

  return (
    <div data-testid="plan-list-view" className="w-full">
      {PLAN_STATUS_ORDER.map((status) => {
        const sectionPlans = grouped[status];
        if (sectionPlans.length === 0) return null;
        const forest = buildPlanForest(sectionPlans);
        const sectionLabel = SECTION_LABELS[status];
        return (
          <section key={status} data-testid={`plan-list-section-${status}`}>
            <PhaseScrollSectionHeader variant="plan-list" title={sectionLabel} />
            <ul
              className={PHASE_QUEUE_LIST_SECTION_BODY_CLASSNAME}
              role="tree"
              aria-label={`${sectionLabel} plans`}
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
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
