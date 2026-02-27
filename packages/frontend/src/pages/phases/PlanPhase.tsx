import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { shallowEqual } from "react-redux";
import type { Plan, PlanStatus } from "@opensprint/shared";
import { sortPlansByStatus } from "@opensprint/shared";
import { store, useAppDispatch, useAppSelector } from "../../store";
import {
  fetchPlans,
  executePlan,
  reExecutePlan,
  planTasks,
  archivePlan,
  deletePlan,
  fetchPlanChat,
  sendPlanMessage,
  fetchSinglePlan,
  updatePlan,
  setSelectedPlanId,
  generatePlan,
  setPlanError,
  setExecutingPlanId,
  clearExecuteError,
  enqueuePlanTasksId,
  addOptimisticPlan,
} from "../../store/slices/planSlice";
import { addNotification } from "../../store/slices/notificationSlice";
import { api } from "../../api/client";
import { CloseButton } from "../../components/CloseButton";
import { CrossEpicConfirmModal } from "../../components/CrossEpicConfirmModal";
import { DependencyGraph } from "../../components/DependencyGraph";
import { PlanDetailContent } from "../../components/plan/PlanDetailContent";
import { AddPlanModal } from "../../components/plan/AddPlanModal";
import { PlanFilterToolbar, type PlanViewMode } from "../../components/plan/PlanFilterToolbar";
import { EpicCard } from "../../components/EpicCard";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";
import { ChatInput } from "../../components/ChatInput";
import { OpenQuestionsBlock } from "../../components/OpenQuestionsBlock";
import { fetchTasks, selectTasksForEpic } from "../../store/slices/executeSlice";
import { usePlanFilter } from "../../hooks/usePlanFilter";
import { useScrollToQuestion } from "../../hooks/useScrollToQuestion";
import { useOpenQuestionNotifications } from "../../hooks/useOpenQuestionNotifications";
import { formatPlanIdAsTitle } from "../../lib/formatting";
import { matchesPlanSearchQuery } from "../../lib/planSearchFilter";

/** Display text for plan chat: show "Plan updated" when agent response contains [PLAN_UPDATE] */
export function getPlanChatMessageDisplay(content: string): string {
  return /\[PLAN_UPDATE\]/.test(content) ? "Plan updated" : content;
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

  /* ── Redux state ── */
  const plans = useAppSelector((s) => s.plan.plans);
  const dependencyGraph = useAppSelector((s) => s.plan.dependencyGraph);
  const selectedPlanId = useAppSelector((s) => s.plan.selectedPlanId);
  const chatMessages = useAppSelector((s) => s.plan.chatMessages);
  const loading = useAppSelector((s) => s.plan.loading);
  const executingPlanId = useAppSelector((s) => s.plan.executingPlanId);
  const reExecutingPlanId = useAppSelector((s) => s.plan.reExecutingPlanId);
  const planTasksPlanIds = useAppSelector((s) => s.plan.planTasksPlanIds);
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
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
  const planNotification =
    (selectedPlanId &&
      openQuestionNotifications.find(
        (n) => n.source === "plan" && n.sourceId === selectedPlanId
      )) ?? null;
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const prevChatMessageCountRef = useRef(0);

  const planQueueRef = useRef<string[]>([]);
  const processingQueueRef = useRef(false);
  const generateQueueRef = useRef<Array<{ description: string; tempId: string }>>([]);
  const processingGenerateRef = useRef(false);

  const filteredAndSortedPlans = useMemo(() => {
    let filtered =
      statusFilter === "all" ? plans : plans.filter((p) => p.status === statusFilter);
    if (searchQuery.trim()) {
      filtered = filtered.filter((p) => matchesPlanSearchQuery(p, searchQuery));
    }
    return sortPlansByStatus(filtered);
  }, [plans, statusFilter, searchQuery]);

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
          dispatch(addNotification({ message: "Plan generated successfully", severity: "success" }));
          dispatch(fetchPlans({ projectId, background: true }));
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
  }, [dispatch, projectId]);

  const planCountByStatus = useMemo(() => {
    const counts = { all: plans.length, planning: 0, building: 0, complete: 0 };
    for (const p of plans) {
      if (p.status === "planning") counts.planning += 1;
      else if (p.status === "building") counts.building += 1;
      else if (p.status === "complete") counts.complete += 1;
    }
    return counts;
  }, [plans]);

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

  /** Plans that show "Plan Tasks" (planning status, zero tasks). Used for "Plan All Tasks" button. */
  const plansWithNoTasks = useMemo(() => {
    return plans.filter((p) => p.status === "planning" && p.taskCount === 0);
  }, [plans]);

  /** Plan IDs for "Plan All Tasks" in dependency order (foundational first), or current order if no edges. */
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

  // Fetch chat history when a plan is selected
  useEffect(() => {
    if (planContext) {
      dispatch(fetchPlanChat({ projectId, context: planContext }));
    }
  }, [planContext, projectId, dispatch]);

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

  const handleShip = async (planId: string) => {
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
    const result = await dispatch(executePlan({ projectId, planId }));
    if (executePlan.fulfilled.match(result)) {
      dispatch(fetchPlans({ projectId, background: true }));
    }
  };

  const handleCrossEpicConfirm = async () => {
    if (!crossEpicModal) return;
    const { planId, prerequisitePlanIds } = crossEpicModal;
    setCrossEpicModal(null);
    const result = await dispatch(executePlan({ projectId, planId, prerequisitePlanIds }));
    if (executePlan.fulfilled.match(result)) {
      dispatch(fetchPlans({ projectId, background: true }));
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
        dispatch(fetchTasks(projectId));
        const currentSelected = store.getState().plan.selectedPlanId;
        if (currentSelected === planId) {
          dispatch(fetchSinglePlan({ projectId, planId }));
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
  }, [dispatch, projectId]);

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
        const result = await dispatch(
          executePlan({
            projectId,
            planId,
            prerequisitePlanIds:
              deps.prerequisitePlanIds.length > 0 ? deps.prerequisitePlanIds : undefined,
          })
        );
        dispatch(fetchPlans({ projectId, background: true }));
        if (executePlan.rejected.match(result)) break;
      }
    } finally {
      setExecuteAllInProgress(false);
    }
  };

  const handleReship = async (planId: string) => {
    const result = await dispatch(reExecutePlan({ projectId, planId }));
    if (reExecutePlan.fulfilled.match(result)) {
      dispatch(fetchPlans({ projectId, background: true }));
    }
  };

  const handleArchive = async (planId: string) => {
    const result = await dispatch(archivePlan({ projectId, planId }));
    if (archivePlan.fulfilled.match(result)) {
      dispatch(fetchPlans({ projectId, background: true }));
      dispatch(fetchTasks(projectId));
      dispatch(fetchSinglePlan({ projectId, planId }));
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmPlanId) return;
    const result = await dispatch(deletePlan({ projectId, planId: deleteConfirmPlanId }));
    if (deletePlan.fulfilled.match(result)) {
      setDeleteConfirmPlanId(null);
      dispatch(setSelectedPlanId(null));
      dispatch(fetchPlans({ projectId, background: true }));
      dispatch(fetchTasks(projectId));
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

      const title = trimmed.slice(0, 30);
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
        dispatch(fetchPlans({ projectId, background: true }));
      }
    },
    [dispatch, projectId, selectedPlanId]
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
      dispatch(fetchPlans({ projectId, background: true }));
      if (selectedPlanId) {
        dispatch(fetchSinglePlan({ projectId, planId: selectedPlanId }));
      }
      // Refetch chat history so persisted messages are authoritative in Redux (survives reload)
      dispatch(fetchPlanChat({ projectId, context: planContext, forceReplace: true }));
    }

    setChatSending(false);
  };

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
          plansReadyToExecuteCount={plansReadyToExecute.length}
          planAllInProgress={planAllInProgress}
          executeAllInProgress={executeAllInProgress}
          executingPlanId={executingPlanId}
          planTasksPlanIds={planTasksPlanIds ?? []}
          onPlanAllTasks={handlePlanAllTasks}
          onExecuteAll={handleExecuteAll}
          onAddPlan={() => setAddPlanModalOpen(true)}
          searchExpanded={searchExpanded}
          searchInputValue={searchInputValue}
          setSearchInputValue={setSearchInputValue}
          searchInputRef={searchInputRef}
          handleSearchExpand={handleSearchExpand}
          handleSearchClose={handleSearchClose}
          handleSearchKeyDown={handleSearchKeyDown}
        />

        <div className="flex-1 min-h-0 overflow-auto p-6">
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
            <div className="h-full min-h-[400px]" data-testid="plan-graph-view">
              {filteredDependencyGraph && filteredDependencyGraph.plans.length === 0 ? (
                <div className="text-center py-10 text-theme-muted">
                  {isSearchActive
                    ? "No plans match your search."
                    : `No plans match the "${statusFilter === "all" ? "All" : statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)}" filter.`}
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

        {loading ? (
          <div className="text-center py-10 text-theme-muted">Loading plans...</div>
        ) : plans.length === 0 && optimisticPlans.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-theme-muted">
              No plans yet. Click &ldquo;Add Plan&rdquo; in the topbar to generate a plan, or use
              &ldquo;Plan it&rdquo; from the Sketch phase.
            </p>
          </div>
        ) : filteredAndSortedPlans.length === 0 && optimisticPlans.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-theme-muted">
              {isSearchActive
                ? "No plans match your search."
                : `No plans match the "${statusFilter === "all" ? "All" : statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)}" filter.`}
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
                onShip={() => handleShip(plan.metadata.planId)}
                onPlanTasks={() => handlePlanTasks(plan.metadata.planId)}
                onReship={() => handleReship(plan.metadata.planId)}
                onClearError={() => dispatch(clearExecuteError())}
              />
            ))}
          </div>
        )}
            </>
          )}
        </div>
      </div>

      {addPlanModalOpen && (
        <AddPlanModal
          onGenerate={handleGeneratePlan}
          onClose={() => setAddPlanModalOpen(false)}
        />
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
          <div
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
            onClick={() => !deletingPlanId && setDeleteConfirmPlanId(null)}
          />
          <div
            className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
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
        <ResizableSidebar storageKey="plan" defaultWidth={420}>
          {/* Sticky header + scrollable body (matches Execute sidebar) */}
          {selectedPlan ? (
            <PlanDetailContent
              key={selectedPlan.metadata.planId}
              plan={selectedPlan}
              onContentSave={handlePlanContentSave}
              saving={savingPlanContentId === selectedPlan.metadata.planId}
              headerActions={
                <>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmPlanId(selectedPlan.metadata.planId)}
                    disabled={!!deletingPlanId}
                    className="p-1.5 text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Delete plan"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleArchive(selectedPlan.metadata.planId)}
                    disabled={!!archivingPlanId}
                    className="p-1.5 text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Archive plan (mark all ready/open tasks as done)"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M21 8v13H3V8" />
                      <path d="M1 3h22v5H1z" />
                      <path d="M10 12h4" />
                    </svg>
                  </button>
                  <CloseButton onClick={handleClosePlan} ariaLabel="Close plan panel" />
                </>
              }
            >
              {({ header, body }) => (
                <>
                  <div className="shrink-0 bg-theme-bg border-b border-theme-border">{header}</div>
                  <div
                    ref={sidebarScrollRef}
                    className="flex-1 overflow-y-auto min-h-0 flex flex-col"
                  >
                    {body}
                    {/* Mockups */}
                    {selectedPlan.metadata.mockups && selectedPlan.metadata.mockups.length > 0 && (
                      <div className="p-4 border-b border-theme-border">
                        <h4 className="text-xs font-medium text-theme-muted uppercase tracking-wide mb-2">
                          Mockups
                        </h4>
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
                      </div>
                    )}

                    {/* Tasks — collapsible */}
                    <div className="border-b border-theme-border">
                      <button
                        type="button"
                        onClick={() => setTasksSectionExpanded(!tasksSectionExpanded)}
                        className="w-full flex items-center justify-between p-4 text-left hover:bg-theme-border-subtle/50 transition-colors"
                      >
                        <h4 className="text-xs font-medium text-theme-muted uppercase tracking-wide">
                          Tasks ({selectedPlanTasks.length})
                        </h4>
                        <span className="text-theme-muted text-xs">
                          {tasksSectionExpanded ? "▼" : "▶"}
                        </span>
                      </button>
                      {tasksSectionExpanded && (
                        <div className="px-4 pb-4 space-y-2">
                          {selectedPlanTasks.length === 0 ? (
                            <div className="space-y-2">
                              <p className="text-sm text-theme-muted">
                                No tasks yet. Click \u201CPlan Tasks\u201D below or on the card to
                                generate tasks from this plan, or use the AI chat to refine it
                                first.
                              </p>
                              {(planTasksPlanIds ?? []).includes(selectedPlan.metadata.planId) ? (
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
                                  Plan Tasks
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
                                <span
                                  className="flex-1 truncate text-theme-text"
                                  title={task.title}
                                >
                                  {task.title}
                                </span>
                                <span className="shrink-0 text-xs text-theme-muted capitalize">
                                  {task.kanbanColumn.replace(/_/g, " ")}
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>

                    {/* Open questions block — when planner needs clarification */}
                    {planNotification && (
                      <OpenQuestionsBlock
                        notification={planNotification}
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
                            dispatch(fetchPlans({ projectId, background: true }));
                            if (selectedPlanId) {
                              dispatch(fetchSinglePlan({ projectId, planId: selectedPlanId }));
                            }
                            dispatch(
                              fetchPlanChat({ projectId, context: planContext!, forceReplace: true })
                            );
                          } else {
                            throw new Error(result.error?.message ?? "Failed to send");
                          }
                        }}
                      />
                    )}

                    {/* Chat messages */}
                    <div
                      className="p-4"
                      data-testid="plan-chat-messages"
                      {...(planNotification && { "data-question-id": planNotification.id })}
                    >
                      <h4 className="text-xs font-medium text-theme-muted uppercase tracking-wide mb-3">
                        Refine with AI
                      </h4>
                      <div className="space-y-3">
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
                                  ? "bg-brand-600 text-white"
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
                    </div>
                  </div>
                </>
              )}
            </PlanDetailContent>
          ) : (
            <>
              <div className="shrink-0 bg-theme-bg border-b border-theme-border p-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-theme-text truncate">
                  {selectedPlanId ? formatPlanIdAsTitle(selectedPlanId) : "Plan"}
                </h3>
                <CloseButton onClick={handleClosePlan} ariaLabel="Close plan panel" />
              </div>
              <div
                ref={sidebarScrollRef}
                className="flex-1 overflow-y-auto min-h-0 flex flex-col"
              >
                <div className="p-4 text-sm text-theme-muted">Loading plan...</div>
                <div
                  className="p-4"
                  data-testid="plan-chat-messages"
                  {...(planNotification && { "data-question-id": planNotification.id })}
                >
                  <h4 className="text-xs font-medium text-theme-muted uppercase tracking-wide mb-3">
                    Refine with AI
                  </h4>
                  <div className="space-y-3">
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
                              ? "bg-brand-600 text-white"
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
                </div>
              </div>
            </>
          )}

          {/* Pinned chat input at bottom */}
          <div className="shrink-0 border-t border-theme-border p-4 bg-theme-bg">
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
