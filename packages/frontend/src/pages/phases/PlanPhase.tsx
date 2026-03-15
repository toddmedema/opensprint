import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { shallowEqual } from "react-redux";
import { useQueryClient } from "@tanstack/react-query";
import type { Plan, PlanStatus } from "@opensprint/shared";
import { sortPlansByStatus } from "@opensprint/shared";
import { useLocation, useNavigate } from "react-router-dom";
import { store, useAppDispatch, useAppSelector } from "../../store";
import {
  executePlan,
  reExecutePlan,
  planTasks,
  fetchPlans,
  archivePlan,
  deletePlan,
  sendPlanMessage,
  updatePlan,
  setSelectedPlanId,
  setPlanChatMessages,
  generatePlan,
  setPlanError,
  setExecutingPlanId,
  clearExecuteError,
  enqueuePlanTasksId,
  addOptimisticPlan,
  setSinglePlan,
} from "../../store/slices/planSlice";
import { addNotification } from "../../store/slices/notificationSlice";
import { addNotification as addOpenQuestionNotification } from "../../store/slices/openQuestionsSlice";
import { clearPhaseUnread } from "../../store/slices/unreadPhaseSlice";
import {
  usePlanChat,
  useSinglePlan,
  usePlans,
  useMarkPlanComplete,
  useProjectSettings,
} from "../../api/hooks";
import { usePhaseLoadingState } from "../../hooks/usePhaseLoadingState";
import { PhaseLoadingSpinner } from "../../components/PhaseLoadingSpinner";
import { queryKeys } from "../../api/queryKeys";
import { api } from "../../api/client";
import { CloseButton } from "../../components/CloseButton";
import { CrossEpicConfirmModal } from "../../components/CrossEpicConfirmModal";
import { DependencyGraph } from "../../components/DependencyGraph";
import { PlanDetailContent } from "../../components/plan/PlanDetailContent";
import { AddPlanModal } from "../../components/plan/AddPlanModal";
import { PlanFilterToolbar, type PlanViewMode } from "../../components/plan/PlanFilterToolbar";
import { AuditorRunsSection } from "../../components/plan/AuditorRunsSection";
import { EpicCard } from "../../components/EpicCard";
import { PhaseEmptyState, PhaseEmptyStateLogo } from "../../components/PhaseEmptyState";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";
import { ChatInput } from "../../components/ChatInput";
import { OpenQuestionsBlock } from "../../components/OpenQuestionsBlock";
import { selectTasksForEpic } from "../../store/slices/executeSlice";
import { wsSend, wsConnect } from "../../store/middleware/websocketMiddleware";
import { usePlanFilter } from "../../hooks/usePlanFilter";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import { VirtualizedAgentOutput } from "../../components/execute/VirtualizedAgentOutput";
import { CollapsibleSection } from "../../components/execute/CollapsibleSection";
import { formatUptime } from "../../lib/formatting";
import { EMPTY_STATE_COPY } from "../../lib/emptyStateCopy";
import { AGENT_ROLE_LABELS } from "@opensprint/shared";
import { useScrollToQuestion } from "../../hooks/useScrollToQuestion";
import { useOpenQuestionNotifications } from "../../hooks/useOpenQuestionNotifications";
import { formatPlanIdAsTitle } from "../../lib/formatting";
import { matchesPlanSearchQuery } from "../../lib/planSearchFilter";
import { parseDetailParams, getProjectPhasePath } from "../../lib/phaseRouting";
import { shouldRightAlignDropdown } from "../../lib/dropdownViewport";

/** Display text for plan chat: show "Plan updated" when agent response contains [PLAN_UPDATE] */
export function getPlanChatMessageDisplay(content: string): string {
  return /\[PLAN_UPDATE\]/.test(content) ? "Plan updated" : content;
}

/** Auditor live output section — status indicator + streaming output (reuses Execute UX patterns). */
function PlanAuditorOutputSection({
  planId,
  auditorOutput,
  wsConnected,
  activeAuditor,
  onRetryConnect,
}: {
  planId: string;
  auditorOutput: string;
  wsConnected: boolean;
  activeAuditor?: { startedAt: string; label?: string };
  onRetryConnect: () => void;
}) {
  const [auditorExpanded, setAuditorExpanded] = useState(true);
  const {
    containerRef: liveOutputRef,
    showJumpToBottom,
    jumpToBottom,
    handleScroll: handleLiveOutputScroll,
  } = useAutoScroll({
    contentLength: auditorOutput.length,
    resetKey: planId,
  });

  const liveOutputContent =
    auditorOutput.length > 0 ? auditorOutput : !wsConnected ? "" : "Waiting for Auditor output...";

  return (
    <div className="border-b border-theme-border">
      <CollapsibleSection
        title="Auditor"
        expanded={auditorExpanded}
        onToggle={() => setAuditorExpanded((p) => !p)}
        expandAriaLabel="Expand Auditor output"
        collapseAriaLabel="Collapse Auditor output"
        contentId="auditor-output-content"
        headerId="auditor-output-header"
      >
        <div className="bg-theme-code-bg rounded-lg border border-theme-border overflow-hidden min-h-[160px] max-h-[320px] flex flex-col">
          {activeAuditor && (
            <div
              className="px-3 py-1.5 rounded-t-lg bg-theme-warning-bg border-b border-theme-warning-border text-xs font-medium text-theme-warning-text flex items-center gap-3 min-w-0"
              data-testid="plan-auditor-active-callout"
            >
              <span className="truncate">
                {AGENT_ROLE_LABELS.auditor ?? "Auditor"}
                {activeAuditor.label && ` · ${activeAuditor.label}`}
                {activeAuditor.startedAt && <> · {formatUptime(activeAuditor.startedAt)}</>}
              </span>
            </div>
          )}
          {!wsConnected ? (
            <div className="p-4 flex flex-col gap-3" data-testid="plan-auditor-connecting">
              <div className="text-sm text-theme-muted flex items-center gap-2">
                <span
                  className="inline-block w-4 h-4 border-2 border-theme-border border-t-brand-500 rounded-full animate-spin"
                  aria-hidden
                />
                Connecting to live output…
              </div>
              <button
                type="button"
                onClick={onRetryConnect}
                className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline self-start"
                data-testid="plan-auditor-retry-connect"
              >
                Retry connection
              </button>
            </div>
          ) : (
            <div className="relative flex flex-col min-h-0 flex-1">
              <VirtualizedAgentOutput
                content={liveOutputContent}
                mode="stream"
                containerRef={liveOutputRef}
                onScroll={handleLiveOutputScroll}
                data-testid="plan-auditor-output"
              />
              {showJumpToBottom && (
                <button
                  type="button"
                  onClick={jumpToBottom}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs font-medium rounded-full bg-theme-surface border border-theme-border text-theme-text shadow-md hover:bg-theme-border-subtle/50 transition-colors z-10"
                  data-testid="plan-auditor-jump-to-bottom"
                  aria-label="Jump to bottom"
                >
                  Jump to bottom
                </button>
              )}
            </div>
          )}
        </div>
      </CollapsibleSection>
    </div>
  );
}

/** Topological order for plan IDs: prerequisites first. Edge (from, to) means "from blocks to". */
function topologicalPlanOrder(planIds: string[], edges: { from: string; to: string }[]): string[] {
  const idSet = new Set(planIds);
  const outgoing = new Map<string, string[]>();
  for (const id of planIds) outgoing.set(id, []);
  for (const e of edges) {
    if (idSet.has(e.from) && idSet.has(e.to)) {
      outgoing.get(e.from)!.push(e.to);
    }
  }
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const to of outgoing.get(id) ?? []) visit(to);
    order.push(id);
  };
  for (const id of planIds) visit(id);
  order.reverse();
  return order;
}

interface PlanPhaseProps {
  projectId: string;
  onNavigateToBuildTask?: (taskId: string) => void;
}

export function PlanPhase({ projectId, onNavigateToBuildTask }: PlanPhaseProps) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    dispatch(clearPhaseUnread({ projectId, phase: "plan" }));
  }, [dispatch, projectId, queryClient]);

  /* ── TanStack Query for loading state (data synced to Redux by ProjectShell) ── */
  const plansQuery = usePlans(projectId);
  const markPlanCompleteMutation = useMarkPlanComplete(projectId);
  const { data: projectSettings } = useProjectSettings(projectId);
  const autoExecutePlans = projectSettings?.autoExecutePlans === true;

  /* ── Redux state (needed for hook args) ── */
  const selectedPlanId = useAppSelector((s) => s.plan.selectedPlanId);
  const planChatQuery = usePlanChat(
    projectId,
    selectedPlanId ? `plan:${selectedPlanId}` : undefined
  );
  const singlePlanQuery = useSinglePlan(projectId, selectedPlanId ?? undefined);

  useEffect(() => {
    if (planChatQuery.data) {
      dispatch(
        setPlanChatMessages({
          context: planChatQuery.data.context,
          messages: planChatQuery.data.messages,
        })
      );
    }
  }, [planChatQuery.data, dispatch]);

  useEffect(() => {
    if (singlePlanQuery.data) dispatch(setSinglePlan(singlePlanQuery.data));
  }, [singlePlanQuery.data, dispatch]);

  /* ── Redux state ── */
  const plans = useAppSelector((s) => s.plan.plans);
  const dependencyGraph = useAppSelector((s) => s.plan.dependencyGraph);
  const chatMessages = useAppSelector((s) => s.plan.chatMessages);
  const executingPlanId = useAppSelector((s) => s.plan.executingPlanId);
  const reExecutingPlanId = useAppSelector((s) => s.plan.reExecutingPlanId);
  const planTasksPlanIds = useAppSelector((s) => s.plan.planTasksPlanIds);
  const auditorOutputByPlanId = useAppSelector((s) => s.plan.auditorOutputByPlanId ?? {});
  const wsConnected = useAppSelector((s) => s.websocket?.connected ?? false);
  const activeAgents = useAppSelector((s) => s.execute?.activeAgents ?? []);
  const archivingPlanId = useAppSelector((s) => s.plan.archivingPlanId);
  const deletingPlanId = useAppSelector((s) => s.plan.deletingPlanId);
  const optimisticPlans = useAppSelector((s) => s.plan.optimisticPlans ?? []);
  const planError = useAppSelector((s) => s.plan.error);
  const executeError = useAppSelector((s) => s.plan.executeError);

  const selectedPlan = plans.find((p) => p.metadata.planId === selectedPlanId) ?? null;
  /* ── Memoized task selectors (only re-render when tasks for current plan change) ── */
  const selectedPlanTasks = useAppSelector(
    (s) => selectTasksForEpic(s, selectedPlan?.metadata.epicId),
    shallowEqual
  );

  /* ── Local UI state (preserved by mount-all) ── */
  const [addPlanModalOpen, setAddPlanModalOpen] = useState(false);
  const [crossEpicModal, setCrossEpicModal] = useState<{
    planId: string;
    prerequisitePlanIds: string[];
  } | null>(null);
  const [deleteConfirmPlanId, setDeleteConfirmPlanId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | PlanStatus>("all");
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [tasksSectionExpanded, setTasksSectionExpanded] = useState(true);
  const [mockupsSectionExpanded, setMockupsSectionExpanded] = useState(true);
  const [refineSectionExpanded, setRefineSectionExpanded] = useState(true);
  const [viewMode, setViewMode] = useState<PlanViewMode>(() => {
    if (typeof window === "undefined") return "card";
    try {
      const stored = localStorage.getItem("opensprint.planView");
      return stored === "card" || stored === "graph" ? stored : "card";
    } catch {
      return "card";
    }
  });
  const [savingPlanContentId, setSavingPlanContentId] = useState<string | null>(null);
  const [planAllInProgress, setPlanAllInProgress] = useState(false);
  const [executeAllInProgress, setExecuteAllInProgress] = useState(false);
  const [selectedVersionNumber, setSelectedVersionNumber] = useState<number | null>(null);
  const [planActionsMenuOpen, setPlanActionsMenuOpen] = useState(false);
  const planActionsMenuRef = useRef<HTMLDivElement>(null);
  const planActionsMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedVersionNumber(null);
    setPlanActionsMenuOpen(false);
  }, [selectedPlanId]);

  useEffect(() => {
    if (!planActionsMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (planActionsMenuRef.current && !planActionsMenuRef.current.contains(e.target as Node)) {
        setPlanActionsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [planActionsMenuOpen]);

  const [planActionsMenuAlignRight, setPlanActionsMenuAlignRight] = useState(false);
  useEffect(() => {
    if (planActionsMenuOpen && planActionsMenuTriggerRef.current) {
      setPlanActionsMenuAlignRight(
        shouldRightAlignDropdown(planActionsMenuTriggerRef.current.getBoundingClientRect())
      );
    }
  }, [planActionsMenuOpen]);

  const {
    searchExpanded,
    searchInputValue,
    setSearchInputValue,
    searchQuery,
    searchInputRef,
    isSearchActive,
    handleSearchExpand,
    handleSearchClose,
    handleSearchKeyDown,
  } = usePlanFilter();
  useScrollToQuestion();
  const { notifications: openQuestionNotifications, refetch: refetchNotifications } =
    useOpenQuestionNotifications(projectId);
  const selectedPlanNotification =
    (selectedPlanId &&
      openQuestionNotifications.find(
        (n) => n.source === "plan" && n.sourceId === selectedPlanId
      )) ??
    null;
  const activeQuestionId = parseDetailParams(location.search).question;
  const draftPlanNotifications = useMemo(
    () =>
      openQuestionNotifications.filter(
        (n) => n.source === "plan" && n.sourceId.startsWith("draft:")
      ),
    [openQuestionNotifications]
  );
  const draftPlanNotification = useMemo(() => {
    if (activeQuestionId) {
      const matching = draftPlanNotifications.find((n) => n.id === activeQuestionId);
      if (matching) return matching;
    }
    return draftPlanNotifications[0] ?? null;
  }, [activeQuestionId, draftPlanNotifications]);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const prevChatMessageCountRef = useRef(0);

  const planQueueRef = useRef<string[]>([]);
  const processingQueueRef = useRef(false);
  const generateQueueRef = useRef<Array<{ description: string; tempId: string }>>([]);
  const processingGenerateRef = useRef(false);

  const filteredAndSortedPlans = useMemo(() => {
    let filtered = statusFilter === "all" ? plans : plans.filter((p) => p.status === statusFilter);
    if (searchQuery.trim()) {
      filtered = filtered.filter((p) => matchesPlanSearchQuery(p, searchQuery));
    }
    return sortPlansByStatus(filtered);
  }, [plans, statusFilter, searchQuery]);

  const plansEmpty = plans.length === 0 && optimisticPlans.length === 0;
  const { showSpinner: showPlansSpinner, showEmptyState: showPlansEmptyState } =
    usePhaseLoadingState(plansQuery.isLoading, plansEmpty);

  /** Process the generate-plan queue sequentially (one at a time). */
  const processGenerateQueue = useCallback(async () => {
    if (processingGenerateRef.current || generateQueueRef.current.length === 0) return;
    processingGenerateRef.current = true;
    try {
      while (generateQueueRef.current.length > 0) {
        const { description, tempId } = generateQueueRef.current[0];
        generateQueueRef.current = generateQueueRef.current.slice(1);
        const result = await dispatch(generatePlan({ projectId, description, tempId }));
        if (generatePlan.fulfilled.match(result)) {
          if (result.payload.status === "created") {
            void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
          } else {
            dispatch(addOpenQuestionNotification(result.payload.notification));
            dispatch(
              addNotification({
                message: "Planner needs clarification before generating this plan",
                severity: "info",
              })
            );
            void refetchNotifications();
          }
        } else if (generatePlan.rejected.match(result)) {
          dispatch(
            addNotification({
              message: result.error?.message || "Failed to generate plan",
              severity: "error",
            })
          );
        }
      }
    } finally {
      processingGenerateRef.current = false;
    }
  }, [dispatch, projectId, queryClient, refetchNotifications]);

  const planCountByStatus = useMemo(() => {
    const counts = { all: plans.length, planning: 0, building: 0, in_review: 0, complete: 0 };
    for (const p of plans) {
      if (p.status === "planning") counts.planning += 1;
      else if (p.status === "building") counts.building += 1;
      else if (p.status === "in_review") counts.in_review += 1;
      else if (p.status === "complete") counts.complete += 1;
    }
    return counts;
  }, [plans]);

  // Reset to "all" when the selected filter chip is hidden (count 0)
  useEffect(() => {
    if (statusFilter === "all") return;
    const count = planCountByStatus[statusFilter];
    if (count === 0) setStatusFilter("all");
  }, [statusFilter, planCountByStatus]);

  const filteredDependencyGraph = useMemo(() => {
    if (!dependencyGraph) return null;
    let filteredPlans =
      statusFilter === "all"
        ? dependencyGraph.plans
        : dependencyGraph.plans.filter((p) => p.status === statusFilter);
    if (searchQuery.trim()) {
      filteredPlans = filteredPlans.filter((p) => matchesPlanSearchQuery(p, searchQuery));
    }
    const filteredPlanIds = new Set(filteredPlans.map((p) => p.metadata.planId));
    const filteredEdges = dependencyGraph.edges.filter(
      (e) => filteredPlanIds.has(e.from) && filteredPlanIds.has(e.to)
    );
    return {
      plans: sortPlansByStatus(filteredPlans),
      edges: filteredEdges,
    };
  }, [dependencyGraph, statusFilter, searchQuery]);

  /** Plans that show "Generate Tasks" (planning status, zero tasks). Used for "Generate All Tasks" button. */
  const plansWithNoTasks = useMemo(() => {
    return plans.filter((p) => p.status === "planning" && p.taskCount === 0);
  }, [plans]);

  /** Plan IDs for "Generate All Tasks" in dependency order (foundational first), or current order if no edges. */
  const plansWithNoTasksOrderedIds = useMemo(() => {
    const ids = plansWithNoTasks.map((p) => p.metadata.planId);
    if (dependencyGraph?.edges?.length) {
      return topologicalPlanOrder(ids, dependencyGraph.edges);
    }
    return ids;
  }, [plansWithNoTasks, dependencyGraph?.edges]);

  /** Plans that show "Execute" (planning, has ≥1 task). Used for "Execute All" button. */
  const plansReadyToExecute = useMemo(() => {
    return plans.filter((p) => p.status === "planning" && p.taskCount > 0);
  }, [plans]);

  /** Plan IDs for "Execute All" in dependency order (foundational first). */
  const plansReadyToExecuteOrderedIds = useMemo(() => {
    const ids = plansReadyToExecute.map((p) => p.metadata.planId);
    if (dependencyGraph?.edges?.length) {
      return topologicalPlanOrder(ids, dependencyGraph.edges);
    }
    return ids;
  }, [plansReadyToExecute, dependencyGraph?.edges]);

  /** When autoExecutePlans: all planning plans in dependency order (no-task plans get generate+execute, others just execute). */
  const plansEligibleForExecuteAllOrderedIds = useMemo(() => {
    const ids = plans.filter((p) => p.status === "planning").map((p) => p.metadata.planId);
    if (dependencyGraph?.edges?.length) {
      return topologicalPlanOrder(ids, dependencyGraph.edges);
    }
    return ids;
  }, [plans, dependencyGraph?.edges]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem("opensprint.planView", viewMode);
    } catch {
      // ignore
    }
  }, [viewMode]);

  // Use selectedPlanId when available so chat can display even before plans load (e.g. deep link)
  const planContext = selectedPlanId ? `plan:${selectedPlanId}` : null;
  const currentChatMessages = useMemo(
    () => (planContext ? (chatMessages[planContext] ?? []) : []),
    [planContext, chatMessages]
  );

  // Plan chat and single plan are loaded via usePlanChat / useSinglePlan and synced to Redux above.

  // When sidebar opens: scroll to top of plan content, no animation
  useEffect(() => {
    if (planContext) {
      prevChatMessageCountRef.current = 0;
      const el = sidebarScrollRef.current;
      if (el) {
        el.scrollTop = 0;
      }
    }
  }, [planContext]);

  // Auto-scroll chat to bottom only when new messages arrive (not on initial open)
  useEffect(() => {
    const prev = prevChatMessageCountRef.current;
    const curr = currentChatMessages.length;
    prevChatMessageCountRef.current = curr;
    if (prev > 0 && curr > prev) {
      const el = messagesEndRef.current;
      if (el?.scrollIntoView) {
        el.scrollIntoView({ behavior: "auto" });
      }
    }
  }, [currentChatMessages]);

  // Subscribe to Auditor output when Re-execute is in progress
  const prevReExecutingPlanIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevReExecutingPlanIdRef.current;
    const curr = reExecutingPlanId;
    prevReExecutingPlanIdRef.current = curr;

    if (prev && !curr) {
      dispatch(wsSend({ type: "plan.agent.unsubscribe", planId: prev }));
    }
    if (curr) {
      dispatch(wsSend({ type: "plan.agent.subscribe", planId: curr }));
    }
  }, [reExecutingPlanId, dispatch]);

  const handleShip = async (planId: string, versionNumber?: number) => {
    dispatch(setExecutingPlanId(planId));
    try {
      const deps = await api.plans.getCrossEpicDependencies(projectId, planId);
      if (deps.prerequisitePlanIds.length > 0) {
        dispatch(setExecutingPlanId(null));
        setCrossEpicModal({ planId, prerequisitePlanIds: deps.prerequisitePlanIds });
        return;
      }
    } catch {
      // Cross-epic deps check failed; proceed with execute
    }
    const result = await dispatch(
      executePlan({ projectId, planId, version_number: versionNumber })
    );
    if (executePlan.fulfilled.match(result)) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
    }
  };

  /** When autoExecutePlans: generate tasks then execute in one step for a single plan. */
  const handleShipOrGenerateAndShip = async (plan: Plan) => {
    if (plan.taskCount === 0) {
      dispatch(setExecutingPlanId(plan.metadata.planId));
      const result = await dispatch(planTasks({ projectId, planId: plan.metadata.planId }));
      if (!planTasks.fulfilled.match(result)) {
        dispatch(setExecutingPlanId(null));
        dispatch(
          addNotification({
            message: result.error?.message ?? "Failed to generate tasks",
            severity: "error",
          })
        );
        return;
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.plans.detail(projectId, plan.metadata.planId),
      });
      await handleShip(plan.metadata.planId);
    } else {
      await handleShip(plan.metadata.planId, plan.lastExecutedVersionNumber);
    }
  };

  const handleCrossEpicConfirm = async () => {
    if (!crossEpicModal) return;
    const { planId, prerequisitePlanIds } = crossEpicModal;
    setCrossEpicModal(null);
    const plan = plans.find((p) => p.metadata.planId === planId);
    const versionNumber = plan?.lastExecutedVersionNumber;
    const result = await dispatch(
      executePlan({ projectId, planId, prerequisitePlanIds, version_number: versionNumber })
    );
    if (executePlan.fulfilled.match(result)) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
    }
  };

  /** Process the shared plan-tasks queue sequentially. */
  const processQueue = useCallback(async () => {
    if (processingQueueRef.current) return;
    processingQueueRef.current = true;
    let completed = 0;
    try {
      while (planQueueRef.current.length > 0) {
        const planId = planQueueRef.current[0];
        const result = await dispatch(planTasks({ projectId, planId }));
        planQueueRef.current = planQueueRef.current.slice(1);
        dispatch(fetchPlans({ projectId, background: true }));
        // planTasksListener dispatches fetchTasks on planTasks.fulfilled for live updates
        const currentSelected = store.getState().plan.selectedPlanId;
        if (currentSelected === planId) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.plans.detail(projectId, planId),
          });
        }
        if (planTasks.fulfilled.match(result)) {
          completed += 1;
        } else if (planTasks.rejected.match(result)) {
          dispatch(
            addNotification({
              message: result.error?.message ?? "Failed to generate tasks",
              severity: "error",
            })
          );
        }
      }
      if (completed > 0) {
        dispatch(
          addNotification({
            message:
              completed === 1
                ? "Tasks generated successfully"
                : `Tasks generated for ${completed} plans`,
            severity: "success",
          })
        );
      }
    } finally {
      processingQueueRef.current = false;
      setPlanAllInProgress(false);
    }
  }, [dispatch, projectId, queryClient]);

  const enqueuePlan = useCallback(
    (planId: string) => {
      if (planQueueRef.current.includes(planId)) return;
      dispatch(enqueuePlanTasksId(planId));
      planQueueRef.current = [...planQueueRef.current, planId];
      processQueue();
    },
    [dispatch, processQueue]
  );

  const handlePlanTasks = (planId: string) => {
    enqueuePlan(planId);
  };

  /** Queue all plans with no tasks to be planned one-by-one in dependency order (foundational first). */
  const handlePlanAllTasks = () => {
    if (plansWithNoTasksOrderedIds.length === 0 || planAllInProgress) return;
    setPlanAllInProgress(true);
    for (const planId of plansWithNoTasksOrderedIds) {
      enqueuePlan(planId);
    }
  };

  /** Execute all plans ready to execute, in dependency order. Stops and opens cross-epic modal if a plan has deps outside the batch. */
  const handleExecuteAll = async () => {
    if (plansReadyToExecuteOrderedIds.length === 0 || executeAllInProgress || !!executingPlanId)
      return;
    setExecuteAllInProgress(true);
    const batchSet = new Set(plansReadyToExecuteOrderedIds);
    try {
      for (const planId of plansReadyToExecuteOrderedIds) {
        const deps = await api.plans.getCrossEpicDependencies(projectId, planId);
        const outsideBatch = deps.prerequisitePlanIds.filter((id) => !batchSet.has(id));
        if (outsideBatch.length > 0) {
          setCrossEpicModal({ planId, prerequisitePlanIds: deps.prerequisitePlanIds });
          break;
        }
        const plan = plansReadyToExecute.find((p) => p.metadata.planId === planId);
        const versionNumber = plan?.lastExecutedVersionNumber;
        const result = await dispatch(
          executePlan({
            projectId,
            planId,
            prerequisitePlanIds:
              deps.prerequisitePlanIds.length > 0 ? deps.prerequisitePlanIds : undefined,
            version_number: versionNumber,
          })
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
        if (executePlan.rejected.match(result)) break;
      }
    } finally {
      setExecuteAllInProgress(false);
    }
  };

  /** When autoExecutePlans: generate-then-execute for no-task plans, execute for rest; in dependency order. */
  const handleExecuteAllOrGenerateAndExecute = async () => {
    if (
      plansEligibleForExecuteAllOrderedIds.length === 0 ||
      executeAllInProgress ||
      !!executingPlanId
    )
      return;
    setExecuteAllInProgress(true);
    const batchSet = new Set(plansEligibleForExecuteAllOrderedIds);
    try {
      for (const planId of plansEligibleForExecuteAllOrderedIds) {
        const plan = plans.find((p) => p.metadata.planId === planId);
        if (!plan) continue;
        if (plan.taskCount === 0) {
          const ptResult = await dispatch(planTasks({ projectId, planId }));
          if (!planTasks.fulfilled.match(ptResult)) {
            dispatch(
              addNotification({
                message: ptResult.error?.message ?? "Failed to generate tasks",
                severity: "error",
              })
            );
            break;
          }
          void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
        }
        const deps = await api.plans.getCrossEpicDependencies(projectId, planId);
        const outsideBatch = deps.prerequisitePlanIds.filter((id) => !batchSet.has(id));
        if (outsideBatch.length > 0) {
          setCrossEpicModal({ planId, prerequisitePlanIds: deps.prerequisitePlanIds });
          break;
        }
        const currentPlan = plans.find((p) => p.metadata.planId === planId);
        const versionNumber = currentPlan?.lastExecutedVersionNumber;
        const result = await dispatch(
          executePlan({
            projectId,
            planId,
            prerequisitePlanIds:
              deps.prerequisitePlanIds.length > 0 ? deps.prerequisitePlanIds : undefined,
            version_number: versionNumber,
          })
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
        if (executePlan.rejected.match(result)) break;
      }
    } finally {
      setExecuteAllInProgress(false);
    }
  };

  const handleReship = async (planId: string) => {
    const result = await dispatch(reExecutePlan({ projectId, planId }));
    if (reExecutePlan.fulfilled.match(result)) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
    }
  };

  const handleArchive = async (planId: string) => {
    const result = await dispatch(archivePlan({ projectId, planId }));
    if (archivePlan.fulfilled.match(result)) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.detail(projectId, planId) });
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmPlanId) return;
    const result = await dispatch(deletePlan({ projectId, planId: deleteConfirmPlanId }));
    if (deletePlan.fulfilled.match(result)) {
      setDeleteConfirmPlanId(null);
      dispatch(setSelectedPlanId(null));
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
    } else {
      dispatch(
        addNotification({
          message: result.error?.message ?? "Failed to delete plan",
          severity: "error",
        })
      );
    }
  };

  const handleGeneratePlan = useCallback(
    (description: string) => {
      const trimmed = description.trim();
      if (!trimmed) return;

      const title = trimmed.slice(0, 45);
      const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      dispatch(addOptimisticPlan({ tempId, title }));
      generateQueueRef.current = [...generateQueueRef.current, { description: trimmed, tempId }];
      processGenerateQueue();
    },
    [dispatch, processGenerateQueue]
  );

  const handleSelectPlan = useCallback(
    (plan: Plan) => {
      dispatch(setSelectedPlanId(plan.metadata.planId));
    },
    [dispatch]
  );

  const handleClosePlan = useCallback(() => {
    dispatch(setSelectedPlanId(null));
  }, [dispatch]);

  const handlePlanContentSave = useCallback(
    async (content: string) => {
      if (!selectedPlanId) return;
      setSavingPlanContentId(selectedPlanId);
      const result = await dispatch(updatePlan({ projectId, planId: selectedPlanId, content }));
      setSavingPlanContentId(null);
      if (updatePlan.fulfilled.match(result)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      }
    },
    [dispatch, projectId, queryClient, selectedPlanId]
  );

  const handleSendChat = async () => {
    if (!chatInput.trim() || !planContext || chatSending) return;

    const text = chatInput.trim();
    setChatInput("");
    setChatSending(true);

    const result = await dispatch(
      sendPlanMessage({ projectId, message: text, context: planContext })
    );

    if (sendPlanMessage.fulfilled.match(result)) {
      const response = result.payload?.response;
      if (response?.planUpdate && selectedPlanId) {
        await dispatch(
          updatePlan({ projectId, planId: selectedPlanId, content: response.planUpdate })
        );
        void queryClient.invalidateQueries({
          queryKey: queryKeys.plans.versions(projectId, selectedPlanId),
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      if (selectedPlanId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.plans.detail(projectId, selectedPlanId!),
        });
      }
      // Refetch chat history so persisted messages are authoritative in Redux (survives reload)
      void planChatQuery.refetch();
    }

    setChatSending(false);
  };

  /* ── RENDER: Loading spinner during fetch (no fake page content) ── */
  if (showPlansSpinner) {
    return (
      <div
        className="flex flex-1 min-h-0 items-center justify-center bg-theme-bg"
        data-testid="plan-phase-loading"
      >
        <PhaseLoadingSpinner data-testid="plan-phase-loading-spinner" aria-label="Loading plans" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <PlanFilterToolbar
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          planCountByStatus={planCountByStatus}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          plansWithNoTasksCount={plansWithNoTasks.length}
          plansReadyToExecuteCount={
            autoExecutePlans
              ? plansEligibleForExecuteAllOrderedIds.length
              : plansReadyToExecute.length
          }
          planAllInProgress={planAllInProgress}
          executeAllInProgress={executeAllInProgress}
          executingPlanId={executingPlanId}
          planTasksPlanIds={planTasksPlanIds ?? []}
          onPlanAllTasks={handlePlanAllTasks}
          onExecuteAll={autoExecutePlans ? handleExecuteAllOrGenerateAndExecute : handleExecuteAll}
          autoExecutePlans={autoExecutePlans}
          onAddPlan={() => setAddPlanModalOpen(true)}
          searchExpanded={searchExpanded}
          searchInputValue={searchInputValue}
          setSearchInputValue={setSearchInputValue}
          searchInputRef={searchInputRef}
          handleSearchExpand={handleSearchExpand}
          handleSearchClose={handleSearchClose}
          handleSearchKeyDown={handleSearchKeyDown}
        />

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6">
          {/* Error banner — inline, dismissible */}
          {planError && (
            <div
              role="alert"
              className="mb-4 flex items-center justify-between gap-3 p-3 bg-theme-error-bg border border-theme-error-border rounded-lg"
              data-testid="plan-error-banner"
            >
              <span className="flex-1 min-w-0 text-sm text-theme-error-text">{planError}</span>
              <button
                type="button"
                onClick={() => dispatch(setPlanError(null))}
                className="shrink-0 p-1.5 rounded hover:bg-theme-error-border/50 text-theme-error-text hover:opacity-80 transition-colors"
                aria-label="Dismiss error"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {viewMode === "graph" ? (
            /* Graph Mode: dependency graph full screen */
            <div
              className="h-full min-h-[200px] sm:min-h-[320px] md:min-h-[400px] overflow-hidden"
              data-testid="plan-graph-view"
            >
              {filteredDependencyGraph && filteredDependencyGraph.plans.length === 0 ? (
                <div className="text-center py-10 text-theme-muted">
                  {isSearchActive
                    ? "No plans match your search."
                    : `No plans match the "${statusFilter === "all" ? "All" : statusFilter === "in_review" ? "In review" : statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)}" filter.`}
                </div>
              ) : (
                <DependencyGraph
                  graph={filteredDependencyGraph}
                  onPlanClick={handleSelectPlan}
                  fillHeight
                />
              )}
            </div>
          ) : (
            /* Card Mode: Feature Plans */
            <>
              {/* Plan Cards */}
              <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
                <h2 className="text-lg font-semibold text-theme-text">Feature Plans</h2>
              </div>

              {!selectedPlanNotification && draftPlanNotification && (
                <div className="mb-4">
                  <OpenQuestionsBlock
                    notification={draftPlanNotification}
                    projectId={projectId}
                    source="plan"
                    sourceId={draftPlanNotification.sourceId}
                    onResolved={refetchNotifications}
                    onAnswerSent={async (message) => {
                      const draftId = draftPlanNotification.sourceId.replace(/^draft:/, "");
                      const result = await dispatch(
                        sendPlanMessage({
                          projectId,
                          message,
                          context: `plan-draft:${draftId}`,
                        })
                      );
                      if (!sendPlanMessage.fulfilled.match(result)) {
                        throw new Error(result.error?.message ?? "Failed to send");
                      }
                      if (result.payload.response.planGenerated?.planId) {
                        const planId = result.payload.response.planGenerated.planId;
                        dispatch(setSelectedPlanId(planId));
                        void queryClient.invalidateQueries({
                          queryKey: queryKeys.plans.list(projectId),
                        });
                        void queryClient.invalidateQueries({
                          queryKey: queryKeys.plans.detail(projectId, planId),
                        });
                      }
                    }}
                  />
                </div>
              )}

              {showPlansEmptyState ? (
                <PhaseEmptyState
                  title={EMPTY_STATE_COPY.plan.title}
                  description={EMPTY_STATE_COPY.plan.description}
                  illustration={<PhaseEmptyStateLogo />}
                  primaryAction={{
                    label: EMPTY_STATE_COPY.plan.primaryActionLabel,
                    onClick: () => setAddPlanModalOpen(true),
                    "data-testid": "empty-state-new-plan",
                  }}
                />
              ) : filteredAndSortedPlans.length === 0 && optimisticPlans.length === 0 ? (
                <div className="text-center py-10">
                  <p className="text-theme-muted">
                    {isSearchActive
                      ? "No plans match your search."
                      : `No plans match the "${statusFilter === "all" ? "All" : statusFilter === "in_review" ? "In review" : statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)}" filter.`}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {/* Optimistic cards first (top-left), visible when filter is all or planning */}
                  {(statusFilter === "all" || statusFilter === "planning") &&
                    optimisticPlans.map((opt) => {
                      const optimisticPlan: Plan = {
                        metadata: {
                          planId: opt.title,
                          epicId: opt.tempId,
                          shippedAt: null,
                          complexity: "medium",
                        },
                        content: "",
                        status: "planning",
                        taskCount: 0,
                        doneTaskCount: 0,
                        dependencyCount: 0,
                      };
                      return (
                        <EpicCard
                          key={opt.tempId}
                          plan={optimisticPlan}
                          isOptimistic
                          executingPlanId={null}
                          reExecutingPlanId={null}
                          planTasksPlanIds={[]}
                          onSelect={() => {}}
                          onShip={() => {}}
                          onPlanTasks={() => {}}
                          onReship={() => {}}
                        />
                      );
                    })}
                  {filteredAndSortedPlans.map((plan) => (
                    <EpicCard
                      key={plan.metadata.planId}
                      plan={plan}
                      executingPlanId={executingPlanId}
                      reExecutingPlanId={reExecutingPlanId}
                      planTasksPlanIds={planTasksPlanIds}
                      executeError={executeError}
                      onSelect={() => handleSelectPlan(plan)}
                      onShip={
                        autoExecutePlans
                          ? () => handleShipOrGenerateAndShip(plan)
                          : () => handleShip(plan.metadata.planId, plan.lastExecutedVersionNumber)
                      }
                      onPlanTasks={() => handlePlanTasks(plan.metadata.planId)}
                      onReship={() => handleReship(plan.metadata.planId)}
                      onClearError={() => dispatch(clearExecuteError())}
                      onGoToEvaluate={() => navigate(getProjectPhasePath(projectId, "eval"))}
                      onMarkComplete={(planId) => markPlanCompleteMutation.mutate(planId)}
                      isMarkCompletePending={
                        markPlanCompleteMutation.isPending &&
                        markPlanCompleteMutation.variables === plan.metadata.planId
                      }
                      autoExecutePlans={autoExecutePlans}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {addPlanModalOpen && (
        <AddPlanModal onGenerate={handleGeneratePlan} onClose={() => setAddPlanModalOpen(false)} />
      )}

      {crossEpicModal && (
        <CrossEpicConfirmModal
          planId={crossEpicModal.planId}
          prerequisitePlanIds={crossEpicModal.prerequisitePlanIds}
          onConfirm={handleCrossEpicConfirm}
          onCancel={() => setCrossEpicModal(null)}
          confirming={executingPlanId === crossEpicModal.planId}
        />
      )}

      {/* Delete plan confirmation */}
      {deleteConfirmPlanId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            className="absolute inset-0 w-full h-full bg-theme-overlay backdrop-blur-sm border-0 cursor-default"
            onClick={() => !deletingPlanId && setDeleteConfirmPlanId(null)}
            aria-label="Close"
          />
          <div className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border">
              <h2 className="text-lg font-semibold text-theme-text">Delete plan</h2>
              <CloseButton
                onClick={() => !deletingPlanId && setDeleteConfirmPlanId(null)}
                ariaLabel="Close delete confirmation"
              />
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-theme-text">Are you sure?</p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
              <button
                type="button"
                onClick={() => !deletingPlanId && setDeleteConfirmPlanId(null)}
                className="btn-secondary"
                disabled={!!deletingPlanId}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={!!deletingPlanId}
                className="btn-primary disabled:opacity-50"
              >
                {deletingPlanId ? "Deleting…" : "Yes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sidebar: Plan Detail + Chat — show when planContext set so chat persists across reloads (e.g. deep link) */}
      {planContext && (
        <ResizableSidebar
          storageKey="plan"
          defaultWidth={420}
          responsive={true}
          onClose={handleClosePlan}
        >
          {/* Sticky header + scrollable body (matches Execute sidebar) */}
          {selectedPlan ? (
            <PlanDetailContent
              key={selectedPlan.metadata.planId}
              plan={selectedPlan}
              onContentSave={handlePlanContentSave}
              saving={savingPlanContentId === selectedPlan.metadata.planId}
              projectId={projectId}
              planId={selectedPlan.metadata.planId}
              selectedVersionNumber={selectedVersionNumber}
              onVersionSelect={setSelectedVersionNumber}
              headerActions={
                <>
                  <div ref={planActionsMenuRef} className="relative shrink-0">
                    <button
                      ref={planActionsMenuTriggerRef}
                      type="button"
                      onClick={() => setPlanActionsMenuOpen((o) => !o)}
                      className="p-1.5 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
                      aria-label="Plan actions"
                      aria-haspopup="menu"
                      aria-expanded={planActionsMenuOpen}
                      data-testid="plan-sidebar-actions-menu-trigger"
                    >
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                        <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
                      </svg>
                    </button>
                    {planActionsMenuOpen && (
                      <ul
                        role="menu"
                        className={`absolute top-full mt-1 z-50 min-w-[140px] rounded-lg border border-theme-border bg-theme-surface shadow-lg py-1 ${planActionsMenuAlignRight ? "right-0 left-auto" : "left-0 right-auto"}`}
                        data-testid="plan-sidebar-actions-menu"
                      >
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              handleArchive(selectedPlan.metadata.planId);
                              setPlanActionsMenuOpen(false);
                            }}
                            disabled={!!archivingPlanId}
                            className="dropdown-item w-full flex items-center gap-2 text-left text-xs text-theme-text hover:bg-theme-border-subtle/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            data-testid="plan-sidebar-archive-btn"
                          >
                            {archivingPlanId ? "Archiving…" : "Archive"}
                          </button>
                        </li>
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setDeleteConfirmPlanId(selectedPlan.metadata.planId);
                              setPlanActionsMenuOpen(false);
                            }}
                            disabled={!!deletingPlanId}
                            className="dropdown-item w-full flex items-center gap-2 text-left text-xs text-theme-error-text hover:bg-theme-error-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            data-testid="plan-sidebar-delete-btn"
                          >
                            {deletingPlanId ? "Deleting…" : "Delete"}
                          </button>
                        </li>
                      </ul>
                    )}
                  </div>
                  <CloseButton onClick={handleClosePlan} ariaLabel="Close plan panel" />
                </>
              }
            >
              {({ header, body }) => (
                <>
                  <div className="shrink-0 bg-theme-bg">{header}</div>
                  <div
                    ref={sidebarScrollRef}
                    className="flex-1 overflow-y-auto min-h-0 flex flex-col"
                  >
                    {body}
                    {/* Mockups — collapsible (matches Execute sidebar section styling) */}
                    {selectedPlan.metadata.mockups && selectedPlan.metadata.mockups.length > 0 && (
                      <CollapsibleSection
                        title="Mockups"
                        expanded={mockupsSectionExpanded}
                        onToggle={() => setMockupsSectionExpanded((e) => !e)}
                        expandAriaLabel="Expand Mockups"
                        collapseAriaLabel="Collapse Mockups"
                        contentId="plan-mockups-content"
                        headerId="plan-mockups-header"
                        contentClassName="p-4 pt-0"
                      >
                        <div className="space-y-3">
                          {selectedPlan.metadata.mockups.map((mockup, i) => (
                            <div
                              key={i}
                              className="bg-theme-surface rounded-lg border overflow-hidden"
                            >
                              <div className="px-3 py-1.5 bg-theme-bg-elevated border-b">
                                <span className="text-xs font-medium text-theme-text">
                                  {mockup.title}
                                </span>
                              </div>
                              <pre className="p-3 text-xs leading-tight text-theme-text overflow-x-auto font-mono whitespace-pre">
                                {mockup.content}
                              </pre>
                            </div>
                          ))}
                        </div>
                      </CollapsibleSection>
                    )}

                    {/* Tasks — collapsible (matches Execute sidebar section styling) */}
                    <CollapsibleSection
                      title={`Tasks (${selectedPlanTasks.length})`}
                      expanded={tasksSectionExpanded}
                      onToggle={() => setTasksSectionExpanded((e) => !e)}
                      expandAriaLabel="Expand Tasks"
                      collapseAriaLabel="Collapse Tasks"
                      contentId="plan-tasks-content"
                      headerId="plan-tasks-header"
                      contentClassName="px-4 pt-0"
                    >
                      <div className="space-y-2">
                        {selectedPlanTasks.length === 0 ? (
                          <div className="space-y-2">
                            {!autoExecutePlans && (
                              <p className="text-sm text-theme-muted">
                                Use the chat to refine the plan, then click Generate Tasks when
                                you&apos;re ready to break it down into specific tickets
                              </p>
                            )}
                            {autoExecutePlans ? (
                              <button
                                type="button"
                                onClick={() =>
                                  selectedPlan && handleShipOrGenerateAndShip(selectedPlan)
                                }
                                disabled={
                                  !!executingPlanId ||
                                  (planTasksPlanIds ?? []).includes(selectedPlan.metadata.planId)
                                }
                                className="btn-primary text-sm w-full py-2 rounded-lg font-medium inline-flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
                                data-testid="execute-button-sidebar"
                              >
                                {(planTasksPlanIds ?? []).includes(selectedPlan.metadata.planId) ||
                                executingPlanId === selectedPlan.metadata.planId
                                  ? "Generating & executing…"
                                  : "Execute"}
                              </button>
                            ) : (planTasksPlanIds ?? []).includes(selectedPlan.metadata.planId) ? (
                              <p
                                className="text-sm text-theme-muted"
                                aria-busy="true"
                                aria-label="Planning tasks"
                                data-testid="plan-tasks-loading-sidebar"
                              >
                                Planning tasks…
                              </p>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handlePlanTasks(selectedPlan.metadata.planId)}
                                className="btn-primary text-sm w-full py-2 rounded-lg font-medium inline-flex items-center justify-center"
                                data-testid="plan-tasks-button-sidebar"
                              >
                                Generate Tasks
                              </button>
                            )}
                          </div>
                        ) : (
                          selectedPlanTasks.map((task) => (
                            <button
                              key={task.id}
                              type="button"
                              onClick={() => onNavigateToBuildTask?.(task.id)}
                              className="w-full flex items-center gap-2 p-2 bg-theme-surface rounded-lg border border-theme-border text-sm text-left hover:border-theme-info-border hover:bg-theme-info-bg/50 transition-colors cursor-pointer"
                            >
                              <span
                                className={`shrink-0 w-2 h-2 rounded-full ${
                                  task.kanbanColumn === "done"
                                    ? "bg-theme-success-solid"
                                    : task.kanbanColumn === "in_progress" ||
                                        task.kanbanColumn === "in_review"
                                      ? "bg-theme-info-solid"
                                      : "bg-theme-ring"
                                }`}
                                title={task.kanbanColumn}
                              />
                              <span className="flex-1 truncate text-theme-text" title={task.title}>
                                {task.title}
                              </span>
                              <span className="shrink-0 text-xs text-theme-muted capitalize">
                                {task.kanbanColumn.replace(/_/g, " ")}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    </CollapsibleSection>

                    {/* Auditor live output — when Re-execute is running */}
                    {reExecutingPlanId === selectedPlan.metadata.planId && (
                      <PlanAuditorOutputSection
                        planId={selectedPlan.metadata.planId}
                        auditorOutput={auditorOutputByPlanId[selectedPlan.metadata.planId] ?? ""}
                        wsConnected={wsConnected}
                        activeAuditor={activeAgents.find(
                          (a) => a.role === "auditor" && a.planId === selectedPlan.metadata.planId
                        )}
                        onRetryConnect={() => dispatch(wsConnect({ projectId }))}
                      />
                    )}

                    {/* Auditor runs — historical execution logs; hide when selected version is still in Planning */}
                    {(() => {
                      const effectiveVersion =
                        selectedVersionNumber ?? selectedPlan.currentVersionNumber ?? 1;
                      const lastExec = selectedPlan.lastExecutedVersionNumber;
                      const showAuditorRuns = lastExec != null && effectiveVersion <= lastExec;
                      return showAuditorRuns ? (
                        <AuditorRunsSection
                          projectId={projectId}
                          planId={selectedPlan.metadata.planId}
                        />
                      ) : null;
                    })()}

                    {/* Open questions block — when planner needs clarification */}
                    {selectedPlanNotification && (
                      <OpenQuestionsBlock
                        notification={selectedPlanNotification}
                        projectId={projectId}
                        source="plan"
                        sourceId={selectedPlan.metadata.planId}
                        onResolved={refetchNotifications}
                        onAnswerSent={async (message) => {
                          const result = await dispatch(
                            sendPlanMessage({
                              projectId,
                              message,
                              context: planContext!,
                            })
                          );
                          if (sendPlanMessage.fulfilled.match(result)) {
                            void queryClient.invalidateQueries({
                              queryKey: queryKeys.plans.list(projectId),
                            });
                            if (selectedPlanId) {
                              void queryClient.invalidateQueries({
                                queryKey: queryKeys.plans.detail(projectId, selectedPlanId!),
                              });
                            }
                            void planChatQuery.refetch();
                          } else {
                            throw new Error(result.error?.message ?? "Failed to send");
                          }
                        }}
                      />
                    )}

                    {/* Refine with AI — collapsible (matches Execute sidebar section styling) */}
                    <CollapsibleSection
                      title="Refine with AI"
                      expanded={refineSectionExpanded}
                      onToggle={() => setRefineSectionExpanded((e) => !e)}
                      expandAriaLabel="Expand Refine with AI"
                      collapseAriaLabel="Collapse Refine with AI"
                      contentId="plan-refine-content"
                      headerId="plan-refine-header"
                      contentClassName="p-4 pt-0"
                    >
                      <div
                        className="space-y-3"
                        data-testid="plan-chat-messages"
                        {...(selectedPlanNotification && {
                          "data-question-id": selectedPlanNotification.id,
                        })}
                      >
                        {currentChatMessages.length === 0 && (
                          <p className="text-sm text-theme-muted">
                            Chat with the planning agent to refine this plan. Ask questions, suggest
                            changes, or request updates.
                          </p>
                        )}
                        {currentChatMessages.map((msg, i) => (
                          <div
                            key={`${msg.role}-${i}-${msg.timestamp}`}
                            data-testid={`plan-chat-message-${msg.role}`}
                            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                          >
                            <div
                              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                                msg.role === "user"
                                  ? "border border-theme-border bg-theme-surface text-theme-text shadow-sm"
                                  : "bg-theme-surface border border-theme-border text-theme-text"
                              }`}
                            >
                              <p className="whitespace-pre-wrap">
                                {getPlanChatMessageDisplay(msg.content)}
                              </p>
                            </div>
                          </div>
                        ))}
                        {chatSending && (
                          <div className="flex justify-start">
                            <div className="bg-theme-surface border border-theme-border rounded-2xl px-3 py-2 text-sm text-theme-muted">
                              Thinking...
                            </div>
                          </div>
                        )}
                        <div ref={messagesEndRef} />
                      </div>
                    </CollapsibleSection>
                  </div>
                </>
              )}
            </PlanDetailContent>
          ) : (
            <>
              <div className="shrink-0 bg-theme-bg p-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-theme-text truncate">
                  {selectedPlanId ? formatPlanIdAsTitle(selectedPlanId) : "Plan"}
                </h3>
                <CloseButton onClick={handleClosePlan} ariaLabel="Close plan panel" />
              </div>
              <div ref={sidebarScrollRef} className="flex-1 overflow-y-auto min-h-0 flex flex-col">
                <div className="p-4 text-sm text-theme-muted">Loading plan...</div>
                <CollapsibleSection
                  title="Refine with AI"
                  expanded={refineSectionExpanded}
                  onToggle={() => setRefineSectionExpanded((e) => !e)}
                  expandAriaLabel="Expand Refine with AI"
                  collapseAriaLabel="Collapse Refine with AI"
                  contentId="plan-refine-content"
                  headerId="plan-refine-header"
                  contentClassName="p-4 pt-0"
                >
                  <div
                    className="space-y-3"
                    data-testid="plan-chat-messages"
                    {...(selectedPlanNotification && {
                      "data-question-id": selectedPlanNotification.id,
                    })}
                  >
                    {currentChatMessages.length === 0 && (
                      <p className="text-sm text-theme-muted">
                        Chat with the planning agent to refine this plan. Ask questions, suggest
                        changes, or request updates.
                      </p>
                    )}
                    {currentChatMessages.map((msg, i) => (
                      <div
                        key={`${msg.role}-${i}-${msg.timestamp}`}
                        data-testid={`plan-chat-message-${msg.role}`}
                        className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                            msg.role === "user"
                              ? "border border-theme-border bg-theme-surface text-theme-text shadow-sm"
                              : "bg-theme-surface border border-theme-border text-theme-text"
                          }`}
                        >
                          <p className="whitespace-pre-wrap">
                            {getPlanChatMessageDisplay(msg.content)}
                          </p>
                        </div>
                      </div>
                    ))}
                    {chatSending && (
                      <div className="flex justify-start">
                        <div className="bg-theme-surface border border-theme-border rounded-2xl px-3 py-2 text-sm text-theme-muted">
                          Thinking...
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                </CollapsibleSection>
              </div>
            </>
          )}

          {/* Pinned chat input at bottom (no divider — matches Execute sidebar) */}
          <div className="shrink-0 p-4 bg-theme-bg">
            <ChatInput
              value={chatInput}
              onChange={setChatInput}
              onSend={handleSendChat}
              sendDisabled={chatSending}
              placeholder="Refine this plan..."
              aria-label="Refine this plan"
            />
          </div>
        </ResizableSidebar>
      )}
    </div>
  );
}
