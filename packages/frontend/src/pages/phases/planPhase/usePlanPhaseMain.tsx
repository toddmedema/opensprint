import type { ConversationMessage } from "@opensprint/shared";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useLayoutEffect,
  type JSX,
} from "react";
import { useQueryClient, useIsMutating } from "@tanstack/react-query";
import type { Plan, PlanAttachment, PlanExecuteBatchItem, PlanStatus } from "@opensprint/shared";
import { DEFAULT_MAX_TOTAL_CONCURRENT_AGENTS, sortPlansByStatus } from "@opensprint/shared";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../../../store";
import {
  executePlan,
  executePlanBatch,
  reExecutePlan,
  planTasks,
  fetchPlans,
  archivePlan,
  deletePlan,
  sendPlanMessage,
  updatePlan,
  generatePlan,
  setPlanError,
  setExecutingPlanId,
  clearExecuteError,
  enqueuePlanTasksId,
  addOptimisticPlan,
  setSelectedPlanId,
} from "../../../store/slices/planSlice";
import { addNotification } from "../../../store/slices/notificationSlice";
import { addNotification as addOpenQuestionNotification } from "../../../store/slices/openQuestionsSlice";
import { clearPhaseUnread } from "../../../store/slices/unreadPhaseSlice";
import {
  usePlanChat,
  useSinglePlan,
  usePlans,
  useTasks,
  useActiveAgents,
  useMarkPlanComplete,
  useProjectSettings,
} from "../../../api/hooks";
import { usePhaseLoadingState } from "../../../hooks/usePhaseLoadingState";
import { PhaseLoadingSpinner } from "../../../components/PhaseLoadingSpinner";
import { queryKeys } from "../../../api/queryKeys";
import { api } from "../../../api/client";
import { CloseButton } from "../../../components/CloseButton";
import { CrossEpicConfirmModal } from "../../../components/CrossEpicConfirmModal";
import { DependencyGraph } from "../../../components/DependencyGraph";
import {
  PlanDetailContent,
  formatPlanTasksSidebarSectionTitle,
  type PlanDetailPlanTasksHint,
} from "../../../components/plan/PlanDetailContent";
import { AddPlanModal } from "../../../components/plan/AddPlanModal";
import { PlanFilterToolbar, type PlanViewMode } from "../../../components/plan/PlanFilterToolbar";
import { PlanListView } from "../../../components/plan/PlanListView";
import { PlanTreeView } from "../../../components/plan/PlanTreeView";
import { AuditorRunsSection } from "../../../components/plan/AuditorRunsSection";
import { PhaseEmptyState, PhaseEmptyStateLogo } from "../../../components/PhaseEmptyState";
import { ResizableSidebar } from "../../../components/layout/ResizableSidebar";
import { SidebarSectionNav } from "../../../components/layout/SidebarSectionNav";
import { ChatInput } from "../../../components/ChatInput";
import { OpenQuestionsBlock } from "../../../components/OpenQuestionsBlock";
import { wsSend, wsConnect } from "../../../store/middleware/websocketMiddleware";
import { usePlanFilter } from "../../../hooks/usePlanFilter";
import { chatDraftStorageKey, loadTextDraft } from "../../../lib/agentInputDraftStorage";
import { useOptimisticTextDraft } from "../../../hooks/useOptimisticTextDraft";
import { CollapsibleSection } from "../../../components/execute/CollapsibleSection";
import { EMPTY_STATE_COPY } from "../../../lib/emptyStateCopy";
import type { ActiveAgent } from "@opensprint/shared";
import type { PlanGenState } from "../../../lib/planGenerationState";
import {
  getPlanGenerationState,
  PLANNING_TOOLTIP,
  STALE_TOOLTIP,
} from "../../../lib/planGenerationState";
import { useScrollToQuestion } from "../../../hooks/useScrollToQuestion";
import { useOpenQuestionNotifications } from "../../../hooks/useOpenQuestionNotifications";
import { formatPlanIdAsTitle } from "../../../lib/formatting";
import { parsePlanContent } from "../../../lib/planContentUtils";
import { matchesPlanSearchQuery } from "../../../lib/planSearchFilter";
import { parseDetailParams, getProjectPhasePath } from "../../../lib/phaseRouting";
import {
  PHASE_MAIN_SCROLL_CLASSNAME,
  PHASE_MAIN_SCROLL_CLASSNAME_PLAN_LIST,
} from "../../../lib/phaseMainScrollLayout";
import {
  pollPlanExecuteBatchUntilDone,
  hasGeneratedPlanTasksForCurrentVersion,
  topologicalPlanOrder,
  computePlanDetailPlanTasksHint,
} from "./planPhaseUtils";
import { PlanAuditorOutputSection } from "./PlanAuditorOutputSection";
import { DeletePlanConfirmModal } from "./DeletePlanConfirmModal";
import { PlanPhaseErrorBanner } from "./PlanPhaseErrorBanner";
import { PlanDetailSidebarActions } from "./PlanDetailSidebarActions";
import { PlanRefineWithAISection } from "./PlanRefineWithAISection";

const EMPTY_PLAN_ID_LIST: string[] = [];
const EMPTY_OPTIMISTIC_PLAN_LIST: Plan[] = [];
const EMPTY_ACTIVE_AGENTS: ActiveAgent[] = [];
const EMPTY_AUDITOR_OUTPUT_BY_PLAN_ID = Object.freeze({}) as Record<string, string>;

export interface PlanPhaseProps {
  projectId: string;
  selectedPlanId?: string;
  onSelectPlanId?: (planId: string | null) => void;
  onNavigateToBuildTask?: (taskId: string) => void;
}

export function usePlanPhaseMain({
  projectId,
  selectedPlanId: propSelectedPlanId,
  onSelectPlanId,
  onNavigateToBuildTask,
}: PlanPhaseProps): JSX.Element {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const selectedPlanIdFromStore = useAppSelector((s) => s.plan.selectedPlanId);
  /**
   * When close is triggered while selection is URL-controlled, keep the sidebar closed
   * until the parent clears or changes the prop. This avoids a visible re-open flicker
   * while route state catches up.
   */
  const [dismissedControlledPlanId, setDismissedControlledPlanId] = useState<string | null>(null);
  const selectedPlanId =
    (propSelectedPlanId != null && propSelectedPlanId === dismissedControlledPlanId
      ? undefined
      : propSelectedPlanId) ??
    selectedPlanIdFromStore ??
    null;
  const [selectedDraftPlanId, setSelectedDraftPlanId] = useState<string | null>(null);
  /** After the user closes the plan sidebar, do not auto-reopen from draft notifications until they select a plan or draft again. */
  const [planSidebarDismissed, setPlanSidebarDismissed] = useState(false);

  useEffect(() => {
    if (dismissedControlledPlanId == null) return;
    if (propSelectedPlanId == null || propSelectedPlanId !== dismissedControlledPlanId) {
      setDismissedControlledPlanId(null);
    }
  }, [dismissedControlledPlanId, propSelectedPlanId]);

  useEffect(() => {
    if (selectedPlanId != null || selectedDraftPlanId != null) {
      setPlanSidebarDismissed(false);
    }
  }, [selectedPlanId, selectedDraftPlanId]);

  useEffect(() => {
    dispatch(clearPhaseUnread({ projectId, phase: "plan" }));
  }, [dispatch, projectId, queryClient]);

  useEffect(() => {
    if (
      dismissedControlledPlanId != null &&
      propSelectedPlanId != null &&
      propSelectedPlanId === dismissedControlledPlanId
    ) {
      return;
    }
    if (propSelectedPlanId === undefined || selectedPlanIdFromStore === propSelectedPlanId) return;
    if (propSelectedPlanId) {
      setSelectedDraftPlanId(null);
    }
    dispatch(setSelectedPlanId(propSelectedPlanId ?? null));
  }, [dispatch, dismissedControlledPlanId, propSelectedPlanId, selectedPlanIdFromStore]);

  /* ── TanStack Query owns server state and loading state ── */
  const plansQuery = usePlans(projectId);
  const decomposeMutationsInFlight = useIsMutating({
    mutationKey: queryKeys.plans.decompose(projectId),
  });
  const markPlanCompleteMutation = useMarkPlanComplete(projectId);
  const { data: projectSettings } = useProjectSettings(projectId);
  const autoExecutePlans = projectSettings?.autoExecutePlans === true;

  /* ── Redux state (needed for hook args) ── */
  const planChatQuery = usePlanChat(
    projectId,
    selectedPlanId
      ? `plan:${selectedPlanId}`
      : selectedDraftPlanId
        ? `plan-draft:${selectedDraftPlanId}`
        : undefined
  );
  const singlePlanQuery = useSinglePlan(projectId, selectedPlanId ?? undefined);
  const selectedPlanIdRef = useRef<string | null>(selectedPlanId ?? null);

  useEffect(() => {
    selectedPlanIdRef.current = selectedPlanId ?? null;
  }, [selectedPlanId]);

  const plans = useMemo(() => {
    const list = plansQuery.data?.plans ?? [];
    if (!singlePlanQuery.data) return list;
    const selected = singlePlanQuery.data;
    return list.map((plan) =>
      plan.metadata.planId === selected.metadata.planId &&
      (selected.revision ?? 0) >= (plan.revision ?? 0)
        ? selected
        : plan
    );
  }, [plansQuery.data, singlePlanQuery.data]);
  const dependencyGraph = plansQuery.data ?? null;
  const chatMessages = useMemo(
    () => (planChatQuery.data ? { [planChatQuery.data.context]: planChatQuery.data.messages } : {}),
    [planChatQuery.data]
  );
  const tasksQuery = useTasks(projectId);
  const agentsQuery = useActiveAgents(projectId);
  const executingPlanId = useAppSelector((s) => s.plan.executingPlanId);
  const reExecutingPlanId = useAppSelector((s) => s.plan.reExecutingPlanId);
  const planTasksPlanIds = useAppSelector((s) => s.plan.planTasksPlanIds ?? EMPTY_PLAN_ID_LIST);
  const auditorOutputByPlanId = useAppSelector(
    (s) => s.plan.auditorOutputByPlanId ?? EMPTY_AUDITOR_OUTPUT_BY_PLAN_ID
  );
  const wsConnected = useAppSelector((s) => s.websocket?.connected ?? false);
  const activeAgents = agentsQuery.data?.agents ?? EMPTY_ACTIVE_AGENTS;
  const archivingPlanId = useAppSelector((s) => s.plan.archivingPlanId);
  const deletingPlanId = useAppSelector((s) => s.plan.deletingPlanId);
  const optimisticPlans = useAppSelector(
    (s) => s.plan.optimisticPlans ?? EMPTY_OPTIMISTIC_PLAN_LIST
  );
  const decomposeGeneratedCount = useAppSelector((s) => s.plan.decomposeGeneratedCount ?? 0);
  const decomposeTotalCount = useAppSelector((s) => s.plan.decomposeTotalCount ?? null);
  const planError = useAppSelector((s) => s.plan.error);
  const executeError = useAppSelector((s) => s.plan.executeError);

  const selectedPlan = plans.find((p) => p.metadata.planId === selectedPlanId) ?? null;

  const planHierarchyNav = useMemo(() => {
    if (!selectedPlan) {
      return {
        parent: null as { planId: string; title: string } | null,
        children: [] as { planId: string; title: string }[],
      };
    }
    const rawParent = selectedPlan.metadata.parentPlanId ?? selectedPlan.parentPlanId ?? undefined;
    const pid = typeof rawParent === "string" && rawParent.trim() !== "" ? rawParent.trim() : null;
    const parentPlan = pid ? plans.find((p) => p.metadata.planId === pid) : undefined;
    const parentTitle = parentPlan
      ? (() => {
          const { title } = parsePlanContent(parentPlan.content ?? "");
          return title.trim() || formatPlanIdAsTitle(pid!);
        })()
      : pid
        ? formatPlanIdAsTitle(pid)
        : "";

    const childIds = selectedPlan.childPlanIds ?? [];
    const children = childIds.map((id) => {
      const p = plans.find((x) => x.metadata.planId === id);
      const { title } = p ? parsePlanContent(p.content ?? "") : { title: "" };
      return { planId: id, title: title.trim() || formatPlanIdAsTitle(id) };
    });

    return {
      parent: pid ? { planId: pid, title: parentTitle } : null,
      children,
    };
  }, [selectedPlan, plans]);

  /** Resolve plan generation state for a given plan: planning / stale / ready. */
  const getPlanGenStateCallback = useCallback(
    (planId: string): PlanGenState => getPlanGenerationState(planId, activeAgents),
    [activeAgents]
  );

  const selectedPlanGenState = selectedPlan
    ? getPlanGenStateCallback(selectedPlan.metadata.planId)
    : ("ready" as PlanGenState);

  /* ── Memoized task selectors (only re-render when tasks for current plan change) ── */
  const selectedPlanTasks = useMemo(
    () => (tasksQuery.data ?? []).filter((task) => task.epicId === selectedPlan?.metadata.epicId),
    [tasksQuery.data, selectedPlan?.metadata.epicId]
  );
  const selectedPlanNeedsTaskGeneration =
    selectedPlan != null &&
    selectedPlan.status === "planning" &&
    !hasGeneratedPlanTasksForCurrentVersion(selectedPlan);
  const selectedPlanTasksGenerating =
    selectedPlan != null && (planTasksPlanIds ?? []).includes(selectedPlan.metadata.planId);

  const selectedPlanTasksHint = useMemo((): PlanDetailPlanTasksHint | null => {
    if (!selectedPlan) return null;
    return computePlanDetailPlanTasksHint(selectedPlan, plans, dependencyGraph?.edges);
  }, [selectedPlan, plans, dependencyGraph?.edges]);

  /* ── Local UI state (preserved by mount-all) ── */
  const [addPlanModalOpen, setAddPlanModalOpen] = useState(false);
  const [crossEpicModal, setCrossEpicModal] = useState<{
    planId: string;
    prerequisitePlanIds: string[];
  } | null>(null);
  const [deleteConfirmPlanId, setDeleteConfirmPlanId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | PlanStatus>("all");
  const [chatInput, setChatInput] = useState("");
  const [pendingPlanMessages, setPendingPlanMessages] = useState<
    Array<ConversationMessage & { context: string }>
  >([]);
  const [chatSending, setChatSending] = useState(false);
  const [tasksSectionExpanded, setTasksSectionExpanded] = useState(true);
  const [mockupsSectionExpanded, setMockupsSectionExpanded] = useState(true);
  const [refineSectionExpanded, setRefineSectionExpanded] = useState(true);
  const [viewMode, setViewMode] = useState<PlanViewMode>(() => {
    if (typeof window === "undefined") return "card";
    try {
      const stored = localStorage.getItem("opensprint.planView");
      return stored === "card" || stored === "graph" || stored === "tree" ? stored : "card";
    } catch {
      return "card";
    }
  });
  const [savingPlanContentId, setSavingPlanContentId] = useState<string | null>(null);
  const [planAllInProgress, setPlanAllInProgress] = useState(false);
  const [executeAllInProgress, setExecuteAllInProgress] = useState(false);
  /** If the user refreshes while a server-side execute-all batch is running, reattach and poll to completion. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const active = await api.plans.getActiveExecuteBatch(projectId);
        if (cancelled || !active || active.status !== "running") return;
        setExecuteAllInProgress(true);
        try {
          const final = await pollPlanExecuteBatchUntilDone(projectId, active.batchId);
          if (cancelled) return;
          void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
          if (final.status === "failed" && final.errorMessage) {
            dispatch(addNotification({ message: final.errorMessage, severity: "error" }));
          }
        } finally {
          if (!cancelled) setExecuteAllInProgress(false);
        }
      } catch {
        // Older server or transient errors — ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, dispatch, queryClient]);
  const [selectedVersionNumber, setSelectedVersionNumber] = useState<number | null>(null);
  const [sectionExpansionCommand, setSectionExpansionCommand] = useState<{
    mode: "expand" | "collapse";
    token: number;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  /** Skip first persist so hierarchy default can choose tree before `opensprint.planView` is written. */
  const skipInitialPlanViewPersistRef = useRef(true);

  useEffect(() => {
    setSelectedVersionNumber(null);
  }, [selectedPlanId]);

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
  const prevPlanQuestionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const q = activeQuestionId ?? undefined;
    if (q != null && q !== prevPlanQuestionIdRef.current) {
      setPlanSidebarDismissed(false);
    }
    prevPlanQuestionIdRef.current = q;
  }, [activeQuestionId]);
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
  const fallbackDraftPlanId =
    !selectedPlanId && draftPlanNotification?.sourceId?.startsWith("draft:")
      ? draftPlanNotification.sourceId.replace(/^draft:/, "")
      : null;
  const activeDraftPlanId = selectedDraftPlanId ?? fallbackDraftPlanId;
  const selectedDraftNotification =
    (activeDraftPlanId &&
      openQuestionNotifications.find(
        (n) => n.source === "plan" && n.sourceId === `draft:${activeDraftPlanId}`
      )) ??
    null;
  const sidebarOpenQuestionNotification =
    draftPlanNotification ?? selectedPlanNotification ?? selectedDraftNotification;
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const prevChatMessageCountRef = useRef(0);

  useEffect(() => {
    if (planSidebarDismissed) return;
    if (!selectedDraftPlanId && fallbackDraftPlanId) {
      setSelectedDraftPlanId(fallbackDraftPlanId);
    }
  }, [fallbackDraftPlanId, selectedDraftPlanId, planSidebarDismissed]);

  const planQueueRef = useRef<string[]>([]);
  const processingQueueRef = useRef(false);
  const generateQueueRef = useRef<
    Array<{
      description: string;
      tempId: string;
      attachments?: PlanAttachment[];
      resolve?: (ok: boolean) => void;
    }>
  >([]);
  const processingGenerateRef = useRef(false);

  const filteredAndSortedPlans = useMemo(() => {
    let filtered = statusFilter === "all" ? plans : plans.filter((p) => p.status === statusFilter);
    if (searchQuery.trim()) {
      filtered = filtered.filter((p) => matchesPlanSearchQuery(p, searchQuery));
    }
    return sortPlansByStatus(filtered);
  }, [plans, statusFilter, searchQuery]);

  /** Plans to show in list view: optimistic (planning) first when filter includes planning, then filtered. */
  const plansForListView = useMemo(() => {
    const showOptimistic = statusFilter === "all" || statusFilter === "planning";
    if (!showOptimistic || optimisticPlans.length === 0) return filteredAndSortedPlans;
    const optimisticAsPlans: Plan[] = optimisticPlans.map((opt) => ({
      metadata: {
        planId: opt.title,
        epicId: opt.tempId,
        shippedAt: null,
        complexity: "medium",
      },
      content: "",
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
      dependencyCount: 0,
    }));
    return [...optimisticAsPlans, ...filteredAndSortedPlans];
  }, [filteredAndSortedPlans, optimisticPlans, statusFilter]);

  const plansEmpty = plans.length === 0 && optimisticPlans.length === 0;

  /** After decompose finishes, Redux may lag the plans query refetch — keep full-page generating until list fetch settles. */
  const [awaitingPlansAfterDecompose, setAwaitingPlansAfterDecompose] = useState(false);
  const prevDecomposeMutatingRef = useRef(0);
  const sawPlansFetchAfterAwaitingRef = useRef(false);

  useEffect(() => {
    const prev = prevDecomposeMutatingRef.current;
    const now = decomposeMutationsInFlight;
    if (prev > 0 && now === 0 && plansEmpty) {
      sawPlansFetchAfterAwaitingRef.current = false;
      setAwaitingPlansAfterDecompose(true);
    }
    prevDecomposeMutatingRef.current = now;
  }, [decomposeMutationsInFlight, plansEmpty]);

  useEffect(() => {
    if (!plansEmpty) {
      setAwaitingPlansAfterDecompose(false);
      sawPlansFetchAfterAwaitingRef.current = false;
    }
  }, [plansEmpty]);

  useEffect(() => {
    if (!awaitingPlansAfterDecompose) return;
    if (plansQuery.isFetching) {
      sawPlansFetchAfterAwaitingRef.current = true;
      return;
    }
    if (sawPlansFetchAfterAwaitingRef.current) {
      setAwaitingPlansAfterDecompose(false);
      sawPlansFetchAfterAwaitingRef.current = false;
    }
  }, [awaitingPlansAfterDecompose, plansQuery.isFetching]);

  useEffect(() => {
    if (!awaitingPlansAfterDecompose) return;
    const t = window.setTimeout(() => {
      setAwaitingPlansAfterDecompose(false);
      sawPlansFetchAfterAwaitingRef.current = false;
    }, 15_000);
    return () => window.clearTimeout(t);
  }, [awaitingPlansAfterDecompose]);

  const generatingPlansFromPrd =
    plansEmpty && (decomposeMutationsInFlight > 0 || awaitingPlansAfterDecompose);

  const { showSpinner: showPlansSpinner, showEmptyState: showPlansEmptyState } =
    usePhaseLoadingState(plansQuery.isLoading, plansEmpty);

  /** Process the generate-plan queue sequentially (one at a time). */
  const processGenerateQueue = useCallback(async () => {
    if (processingGenerateRef.current || generateQueueRef.current.length === 0) return;
    processingGenerateRef.current = true;
    try {
      while (generateQueueRef.current.length > 0) {
        const {
          description,
          tempId,
          attachments: queueAttachments,
          resolve,
        } = generateQueueRef.current[0];
        generateQueueRef.current = generateQueueRef.current.slice(1);
        const result = await dispatch(
          generatePlan({ projectId, description, tempId, attachments: queueAttachments })
        );
        if (generatePlan.fulfilled.match(result)) {
          if (result.payload.status === "created") {
            resolve?.(true);
            void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
          } else {
            // Clarification flow continues in the sidebar (plan-draft context), not the modal.
            resolve?.(true);
            setSelectedDraftPlanId(result.payload.draftId);
            dispatch(setSelectedPlanId(null));
            onSelectPlanId?.(null);
            dispatch(addOpenQuestionNotification(result.payload.notification));
            dispatch(
              addNotification({
                message: "Planner needs clarification before generating this plan",
                severity: "info",
              })
            );
            void refetchNotifications();
          }
        } else {
          resolve?.(false);
          if (generatePlan.rejected.match(result)) {
            dispatch(
              addNotification({
                message: result.error?.message || "Failed to generate plan",
                severity: "error",
              })
            );
          }
        }
      }
    } finally {
      processingGenerateRef.current = false;
    }
  }, [dispatch, onSelectPlanId, projectId, queryClient, refetchNotifications]);

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

  /** Plans that should show "Generate Tasks" (planning status, generation not yet run, no active planner). */
  const plansWithNoTasks = useMemo(() => {
    return plans.filter(
      (p) =>
        p.status === "planning" &&
        !hasGeneratedPlanTasksForCurrentVersion(p) &&
        getPlanGenStateCallback(p.metadata.planId) === "ready"
    );
  }, [plans, getPlanGenStateCallback]);

  /** Plan IDs for "Generate All Tasks" in dependency order (foundational first), or current order if no edges. */
  const plansWithNoTasksOrderedIds = useMemo(() => {
    const ids = plansWithNoTasks.map((p) => p.metadata.planId);
    if (dependencyGraph?.edges?.length) {
      return topologicalPlanOrder(ids, dependencyGraph.edges);
    }
    return ids;
  }, [plansWithNoTasks, dependencyGraph?.edges]);

  /** Plans that should show "Execute" (planning + task generation already run for current version). */
  const plansReadyToExecute = useMemo(() => {
    return plans.filter(
      (p) => p.status === "planning" && hasGeneratedPlanTasksForCurrentVersion(p)
    );
  }, [plans]);

  /** Plan IDs for "Execute All" in dependency order (foundational first). */
  const plansReadyToExecuteOrderedIds = useMemo(() => {
    const ids = plansReadyToExecute.map((p) => p.metadata.planId);
    if (dependencyGraph?.edges?.length) {
      return topologicalPlanOrder(ids, dependencyGraph.edges);
    }
    return ids;
  }, [plansReadyToExecute, dependencyGraph?.edges]);

  /** When autoExecutePlans: all planning plans in dependency order (non-generated plans get generate+execute, others execute). */
  const plansEligibleForExecuteAllOrderedIds = useMemo(() => {
    const ids = plans.filter((p) => p.status === "planning").map((p) => p.metadata.planId);
    if (dependencyGraph?.edges?.length) {
      return topologicalPlanOrder(ids, dependencyGraph.edges);
    }
    return ids;
  }, [plans, dependencyGraph?.edges]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (skipInitialPlanViewPersistRef.current) {
      skipInitialPlanViewPersistRef.current = false;
      return;
    }
    try {
      localStorage.setItem("opensprint.planView", viewMode);
    } catch {
      // ignore
    }
  }, [viewMode]);

  /** When the user has never persisted a view choice, prefer tree if any plan has sub-plans. */
  useEffect(() => {
    if (plansQuery.isLoading) return;
    let hasStored = false;
    try {
      const stored = localStorage.getItem("opensprint.planView");
      hasStored = stored === "card" || stored === "graph" || stored === "tree";
    } catch {
      return;
    }
    if (hasStored) return;

    const hasHierarchy = plans.some((p) => (p.childPlanIds?.length ?? 0) > 0);
    const nextMode: PlanViewMode = hasHierarchy ? "tree" : "card";
    setViewMode((prev) => (prev === nextMode ? prev : nextMode));
  }, [plans, plansQuery.isLoading]);

  // Use selectedPlanId when available so chat can display even before plans load (e.g. deep link)
  const planContext =
    selectedPlanId && !sidebarOpenQuestionNotification?.sourceId?.startsWith("draft:")
      ? `plan:${selectedPlanId}`
      : null;
  const notificationDraftPlanId =
    !selectedPlanId && sidebarOpenQuestionNotification?.sourceId?.startsWith("draft:")
      ? sidebarOpenQuestionNotification.sourceId.replace(/^draft:/, "")
      : null;
  const effectiveDraftPlanId = planSidebarDismissed
    ? selectedDraftPlanId
    : (activeDraftPlanId ?? notificationDraftPlanId);
  const draftPlanContext = effectiveDraftPlanId ? `plan-draft:${effectiveDraftPlanId}` : null;
  const activePlanContext = planContext ?? draftPlanContext;
  const planChatDraftKey = useMemo(
    () => (activePlanContext ? chatDraftStorageKey(projectId, activePlanContext) : undefined),
    [projectId, activePlanContext]
  );
  const { beginSend, onSuccess, onFailure } = useOptimisticTextDraft(
    planChatDraftKey,
    chatInput,
    setChatInput
  );
  const currentChatMessages = useMemo(
    () => [
      ...(activePlanContext ? (chatMessages[activePlanContext] ?? []) : []),
      ...pendingPlanMessages.filter((message) => message.context === activePlanContext),
    ],
    [activePlanContext, chatMessages, pendingPlanMessages]
  );

  // Plan chat and plan detail are observed directly through their shared queries.

  // When sidebar opens: scroll to top of plan content, no animation
  useEffect(() => {
    if (activePlanContext) {
      prevChatMessageCountRef.current = 0;
      const el = sidebarScrollRef.current;
      if (el) {
        el.scrollTop = 0;
      }
    }
  }, [activePlanContext]);

  useLayoutEffect(() => {
    if (!activePlanContext) {
      setChatInput("");
      return;
    }
    setChatInput(loadTextDraft(chatDraftStorageKey(projectId, activePlanContext)));
  }, [projectId, activePlanContext]);

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
    if (!hasGeneratedPlanTasksForCurrentVersion(plan)) {
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

  /** When unset, cap in-flight planTasks HTTP calls during bulk generate (backend still enforces maxTotalConcurrentAgents when set). */

  /** Process the shared plan-tasks queue with bounded parallelism (FIFO). */
  const processQueue = useCallback(async () => {
    if (processingQueueRef.current) return;
    processingQueueRef.current = true;
    let completed = 0;
    try {
      while (planQueueRef.current.length > 0) {
        const batchConcurrency = Math.max(
          1,
          Math.min(
            planQueueRef.current.length,
            projectSettings?.maxTotalConcurrentAgents ?? DEFAULT_MAX_TOTAL_CONCURRENT_AGENTS
          )
        );

        const runWorker = async () => {
          for (;;) {
            const planId = planQueueRef.current.shift();
            if (!planId) break;
            const result = await dispatch(planTasks({ projectId, planId }));
            dispatch(fetchPlans({ projectId, background: true }));
            const currentSelected = selectedPlanIdRef.current;
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
        };

        await Promise.all(Array.from({ length: batchConcurrency }, () => runWorker()));
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
  }, [dispatch, projectId, queryClient, projectSettings?.maxTotalConcurrentAgents]);

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

  /**
   * Queue all plans that still need generation (dependency order: foundational first in the shared queue).
   * Append every id before calling `processQueue` once so the worker pool sees the full queue and
   * `batchConcurrency` is not stuck at 1 (calling `enqueuePlan` in a loop used to start processing
   * after only the first id was appended).
   */
  const handlePlanAllTasks = () => {
    if (plansWithNoTasksOrderedIds.length === 0 || planAllInProgress) return;
    setPlanAllInProgress(true);
    for (const planId of plansWithNoTasksOrderedIds) {
      if (planQueueRef.current.includes(planId)) continue;
      dispatch(enqueuePlanTasksId(planId));
      planQueueRef.current = [...planQueueRef.current, planId];
    }
    void processQueue();
  };

  /** Execute all plans ready to execute, in dependency order. Stops and opens cross-epic modal if a plan has deps outside the batch. */
  const handleExecuteAll = async () => {
    if (plansReadyToExecuteOrderedIds.length === 0 || executeAllInProgress || !!executingPlanId)
      return;
    setExecuteAllInProgress(true);
    const batchSet = new Set(plansReadyToExecuteOrderedIds);
    try {
      const items: PlanExecuteBatchItem[] = [];
      for (const planId of plansReadyToExecuteOrderedIds) {
        const deps = await api.plans.getCrossEpicDependencies(projectId, planId);
        const outsideBatch = deps.prerequisitePlanIds.filter((id) => !batchSet.has(id));
        if (outsideBatch.length > 0) {
          setCrossEpicModal({ planId, prerequisitePlanIds: deps.prerequisitePlanIds });
          return;
        }
        const plan = plansReadyToExecute.find((p) => p.metadata.planId === planId);
        const versionNumber = plan?.lastExecutedVersionNumber;
        const item: PlanExecuteBatchItem = { planId };
        if (deps.prerequisitePlanIds.length > 0)
          item.prerequisitePlanIds = deps.prerequisitePlanIds;
        if (versionNumber != null) item.version_number = versionNumber;
        items.push(item);
      }
      const result = await dispatch(executePlanBatch({ projectId, items }));
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      if (executePlanBatch.rejected.match(result)) {
        dispatch(
          addNotification({
            message: result.error?.message ?? "Execute all failed to start",
            severity: "error",
          })
        );
        return;
      }
      const { batchId } = result.payload;
      const final = await pollPlanExecuteBatchUntilDone(projectId, batchId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      if (final.status === "failed" && final.errorMessage) {
        dispatch(addNotification({ message: final.errorMessage, severity: "error" }));
      }
    } finally {
      setExecuteAllInProgress(false);
    }
  };

  /** When autoExecutePlans: generate-then-execute for non-generated plans, execute for generated ones; in dependency order. */
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
        if (!hasGeneratedPlanTasksForCurrentVersion(plan)) {
          const ptResult = await dispatch(planTasks({ projectId, planId }));
          if (!planTasks.fulfilled.match(ptResult)) {
            dispatch(
              addNotification({
                message: ptResult.error?.message ?? "Failed to generate tasks",
                severity: "error",
              })
            );
            return;
          }
          void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
        }
      }
      const graph = await queryClient.fetchQuery({
        queryKey: queryKeys.plans.list(projectId),
        queryFn: () => api.plans.list(projectId),
      });
      const freshPlans = graph.plans;
      const items: PlanExecuteBatchItem[] = [];
      for (const planId of plansEligibleForExecuteAllOrderedIds) {
        const p = freshPlans.find((x) => x.metadata.planId === planId);
        if (!p || !hasGeneratedPlanTasksForCurrentVersion(p)) {
          dispatch(
            addNotification({
              message: "A plan is still not generated after task generation; cannot execute all.",
              severity: "error",
            })
          );
          return;
        }
        const deps = await api.plans.getCrossEpicDependencies(projectId, planId);
        const outsideBatch = deps.prerequisitePlanIds.filter((id) => !batchSet.has(id));
        if (outsideBatch.length > 0) {
          setCrossEpicModal({ planId, prerequisitePlanIds: deps.prerequisitePlanIds });
          return;
        }
        const item: PlanExecuteBatchItem = { planId };
        if (deps.prerequisitePlanIds.length > 0)
          item.prerequisitePlanIds = deps.prerequisitePlanIds;
        if (p.lastExecutedVersionNumber != null) item.version_number = p.lastExecutedVersionNumber;
        items.push(item);
      }
      const result = await dispatch(executePlanBatch({ projectId, items }));
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      if (executePlanBatch.rejected.match(result)) {
        dispatch(
          addNotification({
            message: result.error?.message ?? "Execute all failed to start",
            severity: "error",
          })
        );
        return;
      }
      const { batchId } = result.payload;
      const final = await pollPlanExecuteBatchUntilDone(projectId, batchId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      if (final.status === "failed" && final.errorMessage) {
        dispatch(addNotification({ message: final.errorMessage, severity: "error" }));
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
      onSelectPlanId?.(null);
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
    (description: string, attachments?: PlanAttachment[]): Promise<boolean> => {
      const trimmed = description.trim();
      if (!trimmed) return Promise.resolve(false);

      const title = trimmed.slice(0, 45);
      const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      dispatch(addOptimisticPlan({ tempId, title }));
      return new Promise<boolean>((resolve) => {
        generateQueueRef.current = [
          ...generateQueueRef.current,
          { description: trimmed, tempId, attachments, resolve },
        ];
        processGenerateQueue();
      });
    },
    [dispatch, processGenerateQueue]
  );

  /** Retry plan generation for a stale plan — re-generate using the plan's title. */
  const handleRetryPlan = useCallback(
    async (planId: string) => {
      const plan = plans.find((p) => p.metadata.planId === planId);
      if (!plan) return;
      const titleMatch = plan.content.match(/^#\s+(.+)$/m);
      const description = titleMatch?.[1]?.trim() || planId;
      const ok = await handleGeneratePlan(description);
      if (ok) {
        const result = await dispatch(deletePlan({ projectId, planId }));
        if (deletePlan.fulfilled.match(result)) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
        }
      }
    },
    [plans, handleGeneratePlan, dispatch, projectId, queryClient]
  );

  const handleSelectPlan = useCallback(
    (plan: Plan) => {
      setSelectedDraftPlanId(null);
      dispatch(setSelectedPlanId(plan.metadata.planId));
      onSelectPlanId?.(plan.metadata.planId);
    },
    [dispatch, onSelectPlanId]
  );

  const handleHierarchyPlanSelect = useCallback(
    (planId: string) => {
      const plan = plans.find((p) => p.metadata.planId === planId);
      if (plan) handleSelectPlan(plan);
    },
    [plans, handleSelectPlan]
  );

  const handleClosePlan = useCallback(() => {
    setDismissedControlledPlanId(propSelectedPlanId ?? null);
    setPlanSidebarDismissed(true);
    setSelectedDraftPlanId(null);
    dispatch(setSelectedPlanId(null));
    onSelectPlanId?.(null);
  }, [dispatch, onSelectPlanId, propSelectedPlanId]);

  const handlePlanContentSave = useCallback(
    async (content: string, expectedRevision?: number) => {
      if (!selectedPlanId) return;
      setSavingPlanContentId(selectedPlanId);
      const result = await dispatch(
        updatePlan({ projectId, planId: selectedPlanId, content, expectedRevision })
      );
      setSavingPlanContentId(null);
      if (updatePlan.fulfilled.match(result)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
        return result.payload.revision;
      }
    },
    [dispatch, projectId, queryClient, selectedPlanId]
  );

  const handleCollapseAllPlanSections = useCallback(() => {
    setTasksSectionExpanded(false);
    setMockupsSectionExpanded(false);
    setRefineSectionExpanded(false);
    setSectionExpansionCommand({ mode: "collapse", token: Date.now() });
  }, []);

  const handleExpandAllPlanSections = useCallback(() => {
    setTasksSectionExpanded(true);
    setMockupsSectionExpanded(true);
    setRefineSectionExpanded(true);
    setSectionExpansionCommand({ mode: "expand", token: Date.now() });
  }, []);

  const handleSendChat = async () => {
    if (!chatInput.trim() || !activePlanContext || chatSending) return;

    const text = chatInput.trim();
    setChatSending(true);
    beginSend(text);
    const pendingId = crypto.randomUUID();
    setPendingPlanMessages((previous) => [
      ...previous,
      {
        id: pendingId,
        context: activePlanContext,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      },
    ]);

    const result = await dispatch(
      sendPlanMessage({ projectId, message: text, context: activePlanContext })
    );

    if (sendPlanMessage.fulfilled.match(result)) {
      onSuccess();
      const response = result.payload?.response;
      if (response?.planGenerated?.planId) {
        const generatedPlanId = response.planGenerated.planId;
        setSelectedDraftPlanId(null);
        dispatch(setSelectedPlanId(generatedPlanId));
        onSelectPlanId?.(generatedPlanId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.plans.detail(projectId, generatedPlanId),
        });
      }
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
    } else {
      onFailure();
    }

    await queryClient.invalidateQueries({
      queryKey: queryKeys.plans.chat(projectId, activePlanContext),
    });
    setPendingPlanMessages((previous) => previous.filter((message) => message.id !== pendingId));
    setChatSending(false);
  };

  /* ── RENDER: Centered pulsing logo + status during fetch or PRD→plans decomposition ── */
  const showPlansBlockingSpinner = showPlansSpinner || generatingPlansFromPrd;
  const plansBlockingStatus = generatingPlansFromPrd
    ? decomposeMutationsInFlight > 0
      ? (decomposeTotalCount ?? 0) > 0
        ? decomposeGeneratedCount >= decomposeTotalCount!
          ? `Finalizing ${decomposeTotalCount} generated ${
              decomposeTotalCount === 1 ? "plan" : "plans"
            }...`
          : `Generating Plan #${decomposeGeneratedCount + 1}/${decomposeTotalCount}...`
        : "Generating Plan..."
      : decomposeGeneratedCount > 0
        ? `Loading ${decomposeGeneratedCount} generated ${
            decomposeGeneratedCount === 1 ? "plan" : "plans"
          }...`
        : "Generating Plan..."
    : "Loading plans…";
  const plansBlockingAriaLabel = generatingPlansFromPrd ? "Generating plan" : "Loading plans";

  if (showPlansBlockingSpinner) {
    return (
      <div
        className="flex flex-1 min-h-0 items-center justify-center"
        data-testid="plan-phase-loading"
      >
        <PhaseLoadingSpinner
          data-testid="plan-phase-loading-spinner"
          aria-label={plansBlockingAriaLabel}
          status={plansBlockingStatus}
        />
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

        <div
          className={
            viewMode === "graph"
              ? PHASE_MAIN_SCROLL_CLASSNAME
              : PHASE_MAIN_SCROLL_CLASSNAME_PLAN_LIST
          }
          data-testid="plan-main-scroll"
        >
          {/* Error banner — inline, dismissible */}
          {planError && (
            <PlanPhaseErrorBanner
              message={planError}
              onDismiss={() => dispatch(setPlanError(null))}
            />
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
            /* Card Mode: plan list */
            <>
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
              ) : viewMode === "tree" ? (
                <PlanTreeView
                  plans={plansForListView}
                  edges={dependencyGraph?.edges ?? []}
                  selectedPlanId={selectedPlanId ?? null}
                  executingPlanId={executingPlanId}
                  reExecutingPlanId={reExecutingPlanId}
                  planTasksPlanIds={planTasksPlanIds ?? []}
                  executeError={executeError}
                  onSelectPlan={handleSelectPlan}
                  onShip={(planId, lastExecutedVersionNumber) => {
                    const plan = plansForListView.find((p) => p.metadata.planId === planId);
                    if (autoExecutePlans && plan) handleShipOrGenerateAndShip(plan);
                    else handleShip(planId, lastExecutedVersionNumber);
                  }}
                  onPlanTasks={handlePlanTasks}
                  onReship={handleReship}
                  onClearError={() => dispatch(clearExecuteError())}
                  onMarkComplete={(planId) => markPlanCompleteMutation.mutate(planId)}
                  markCompletePendingPlanId={
                    markPlanCompleteMutation.isPending
                      ? (markPlanCompleteMutation.variables ?? null)
                      : null
                  }
                  onGoToEvaluate={() => navigate(getProjectPhasePath(projectId, "eval"))}
                  autoExecutePlans={autoExecutePlans}
                  getPlanGenState={getPlanGenStateCallback}
                  onRetryPlan={handleRetryPlan}
                />
              ) : (
                <PlanListView
                  plans={plansForListView}
                  planDependencyEdges={dependencyGraph?.edges}
                  selectedPlanId={selectedPlanId ?? null}
                  executingPlanId={executingPlanId}
                  reExecutingPlanId={reExecutingPlanId}
                  planTasksPlanIds={planTasksPlanIds ?? []}
                  executeError={executeError}
                  onSelectPlan={handleSelectPlan}
                  onShip={(planId, lastExecutedVersionNumber) => {
                    const plan = plansForListView.find((p) => p.metadata.planId === planId);
                    if (autoExecutePlans && plan) handleShipOrGenerateAndShip(plan);
                    else handleShip(planId, lastExecutedVersionNumber);
                  }}
                  onPlanTasks={handlePlanTasks}
                  onReship={handleReship}
                  onClearError={() => dispatch(clearExecuteError())}
                  onMarkComplete={(planId) => markPlanCompleteMutation.mutate(planId)}
                  markCompletePendingPlanId={
                    markPlanCompleteMutation.isPending
                      ? (markPlanCompleteMutation.variables ?? null)
                      : null
                  }
                  onGoToEvaluate={() => navigate(getProjectPhasePath(projectId, "eval"))}
                  autoExecutePlans={autoExecutePlans}
                  getPlanGenState={getPlanGenStateCallback}
                  onRetryPlan={handleRetryPlan}
                />
              )}
            </>
          )}
        </div>
      </div>

      {addPlanModalOpen && (
        <AddPlanModal
          projectId={projectId}
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
        <DeletePlanConfirmModal
          deletingPlanId={deletingPlanId}
          onCancel={() => setDeleteConfirmPlanId(null)}
          onConfirm={handleDeleteConfirm}
        />
      )}

      {/* Sidebar: Plan Detail + Chat — show for plan or draft-plan chat contexts. */}
      {activePlanContext && (
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
              sectionExpansionCommand={sectionExpansionCommand}
              parentPlanNav={planHierarchyNav.parent}
              childPlansNav={planHierarchyNav.children}
              onSelectHierarchyPlan={handleHierarchyPlanSelect}
              planTasksHint={selectedPlanTasksHint}
              onPlanTasksHintGenerate={() => handlePlanTasks(selectedPlan.metadata.planId)}
              onPlanTasksHintSelectPlan={handleHierarchyPlanSelect}
              planTasksHintGenerateDisabled={
                selectedPlanTasksGenerating ||
                selectedPlanGenState === "planning" ||
                selectedPlanGenState === "stale"
              }
              headerActions={
                <PlanDetailSidebarActions
                  planId={selectedPlan.metadata.planId}
                  archivingPlanId={archivingPlanId}
                  deletingPlanId={deletingPlanId}
                  onArchive={handleArchive}
                  onRequestDelete={setDeleteConfirmPlanId}
                  onClosePanel={handleClosePlan}
                />
              }
            >
              {({ header, body }) => (
                <>
                  <div className="shrink-0 bg-theme-bg">{header}</div>
                  <div
                    ref={sidebarScrollRef}
                    className="flex-1 overflow-y-auto min-h-0 flex flex-col"
                  >
                    <SidebarSectionNav
                      scrollContainerRef={sidebarScrollRef}
                      onCollapseAll={handleCollapseAllPlanSections}
                      onExpandAll={handleExpandAllPlanSections}
                    />
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
                        sectionNavId="plan-mockups-section"
                        sectionNavTitle="Mockups"
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
                      title={formatPlanTasksSidebarSectionTitle(selectedPlanTasks.length)}
                      expanded={tasksSectionExpanded}
                      onToggle={() => setTasksSectionExpanded((e) => !e)}
                      expandAriaLabel="Expand Tasks"
                      collapseAriaLabel="Collapse Tasks"
                      contentId="plan-tasks-content"
                      headerId="plan-tasks-header"
                      contentClassName="px-4 pt-0"
                      sectionNavId="plan-tasks-section"
                      sectionNavTitle="Tasks"
                    >
                      <div className="space-y-2">
                        {selectedPlanNeedsTaskGeneration && (
                          <div className="space-y-2">
                            {selectedPlanGenState === "planning" && !selectedPlanTasksGenerating ? (
                              <>
                                <p className="text-sm text-theme-muted">{PLANNING_TOOLTIP}</p>
                                <button
                                  type="button"
                                  disabled
                                  className="btn-primary text-sm w-full py-2 rounded-lg font-medium inline-flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
                                  title={PLANNING_TOOLTIP}
                                  data-testid="plan-tasks-planning-sidebar"
                                >
                                  <span
                                    className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin mr-2"
                                    aria-hidden
                                  />
                                  Planning
                                </button>
                              </>
                            ) : selectedPlanGenState === "stale" && !selectedPlanTasksGenerating ? (
                              <>
                                <p className="text-sm text-theme-warning-text">{STALE_TOOLTIP}</p>
                                <button
                                  type="button"
                                  onClick={() => handleRetryPlan(selectedPlan.metadata.planId)}
                                  className="btn-primary text-sm w-full py-2 rounded-lg font-medium inline-flex items-center justify-center bg-theme-warning-bg text-theme-warning-text border border-theme-warning-border hover:opacity-90"
                                  data-testid="plan-tasks-retry-sidebar"
                                >
                                  Retry
                                </button>
                              </>
                            ) : selectedPlanTasksHint?.showParentDelegateSubplans &&
                              !autoExecutePlans ? (
                              <p
                                className="text-sm text-theme-muted"
                                data-testid="plan-tasks-parent-delegate-sidebar"
                                role="status"
                              >
                                Sub-plans created — generate tasks on each sub-plan
                              </p>
                            ) : (
                              <>
                                {!autoExecutePlans &&
                                  !selectedPlanTasksHint?.showProminentGenerateTasks && (
                                    <p className="text-sm text-theme-muted">
                                      Use the chat to refine the plan, then click Generate Tasks
                                      when you&apos;re ready to break it down into specific tickets
                                    </p>
                                  )}
                                {!autoExecutePlans &&
                                  selectedPlanTasksHint?.showProminentGenerateTasks && (
                                    <p
                                      className="text-sm text-theme-muted"
                                      data-testid="plan-tasks-child-prominent-hint"
                                    >
                                      A prominent{" "}
                                      <strong className="text-theme-text">Generate tasks</strong>{" "}
                                      control is in the plan header above; you can also use the
                                      tree.
                                    </p>
                                  )}
                                {autoExecutePlans ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      selectedPlan && handleShipOrGenerateAndShip(selectedPlan)
                                    }
                                    disabled={!!executingPlanId || selectedPlanTasksGenerating}
                                    className="btn-primary text-sm w-full py-2 rounded-lg font-medium inline-flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
                                    data-testid="execute-button-sidebar"
                                  >
                                    {selectedPlanTasksGenerating ||
                                    executingPlanId === selectedPlan.metadata.planId
                                      ? "Generating & executing…"
                                      : "Execute"}
                                  </button>
                                ) : selectedPlanTasksGenerating ? (
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
                              </>
                            )}
                          </div>
                        )}
                        {selectedPlanTasks.length === 0 && !selectedPlanNeedsTaskGeneration ? (
                          <p className="text-sm text-theme-muted">No tasks yet.</p>
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
                    {sidebarOpenQuestionNotification && (
                      <OpenQuestionsBlock
                        notification={sidebarOpenQuestionNotification}
                        projectId={projectId}
                        source="plan"
                        sourceId={sidebarOpenQuestionNotification.sourceId}
                        onResolved={refetchNotifications}
                        onAnswerSent={async (message) => {
                          const result = await dispatch(
                            sendPlanMessage({
                              projectId,
                              message,
                              context: activePlanContext,
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
                            if (result.payload.response.planGenerated?.planId) {
                              const generatedPlanId = result.payload.response.planGenerated.planId;
                              setSelectedDraftPlanId(null);
                              dispatch(setSelectedPlanId(generatedPlanId));
                              onSelectPlanId?.(generatedPlanId);
                            }
                            void planChatQuery.refetch();
                          } else {
                            throw new Error(result.error?.message ?? "Failed to send");
                          }
                        }}
                      />
                    )}

                    <PlanRefineWithAISection
                      expanded={refineSectionExpanded}
                      onToggle={() => setRefineSectionExpanded((e) => !e)}
                      messages={currentChatMessages}
                      chatSending={chatSending}
                      messagesEndRef={messagesEndRef}
                      questionNotificationId={sidebarOpenQuestionNotification?.id}
                    />
                  </div>
                </>
              )}
            </PlanDetailContent>
          ) : (
            <>
              <div className="shrink-0 bg-theme-bg p-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-theme-text truncate">
                  {selectedPlanId
                    ? formatPlanIdAsTitle(selectedPlanId)
                    : effectiveDraftPlanId
                      ? "Draft Plan"
                      : "Plan"}
                </h3>
                <CloseButton onClick={handleClosePlan} ariaLabel="Close plan panel" />
              </div>
              <div ref={sidebarScrollRef} className="flex-1 overflow-y-auto min-h-0 flex flex-col">
                <SidebarSectionNav
                  scrollContainerRef={sidebarScrollRef}
                  onCollapseAll={handleCollapseAllPlanSections}
                  onExpandAll={handleExpandAllPlanSections}
                />
                <div className="p-4 text-sm text-theme-muted">Loading plan...</div>
                {sidebarOpenQuestionNotification && (
                  <OpenQuestionsBlock
                    notification={sidebarOpenQuestionNotification}
                    projectId={projectId}
                    source="plan"
                    sourceId={sidebarOpenQuestionNotification.sourceId}
                    onResolved={refetchNotifications}
                    onAnswerSent={async (message) => {
                      const result = await dispatch(
                        sendPlanMessage({
                          projectId,
                          message,
                          context: activePlanContext,
                        })
                      );
                      if (!sendPlanMessage.fulfilled.match(result)) {
                        throw new Error(result.error?.message ?? "Failed to send");
                      }
                      if (result.payload.response.planGenerated?.planId) {
                        const planId = result.payload.response.planGenerated.planId;
                        setSelectedDraftPlanId(null);
                        dispatch(setSelectedPlanId(planId));
                        onSelectPlanId?.(planId);
                        void queryClient.invalidateQueries({
                          queryKey: queryKeys.plans.list(projectId),
                        });
                        void queryClient.invalidateQueries({
                          queryKey: queryKeys.plans.detail(projectId, planId),
                        });
                      }
                      void planChatQuery.refetch();
                    }}
                  />
                )}
                <PlanRefineWithAISection
                  expanded={refineSectionExpanded}
                  onToggle={() => setRefineSectionExpanded((e) => !e)}
                  messages={currentChatMessages}
                  chatSending={chatSending}
                  messagesEndRef={messagesEndRef}
                  questionNotificationId={sidebarOpenQuestionNotification?.id}
                />
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
