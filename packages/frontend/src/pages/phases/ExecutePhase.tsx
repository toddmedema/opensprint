import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useStore } from "react-redux";
import type { RootState } from "../../store";
import { awaitGuidanceReceipt } from "../../lib/awaitGuidanceReceipt";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  setAgentOutputBackfill,
  setArchivedSessions,
  setSelectedTaskId,
  selectTasks,
  selectTaskById,
  selectSelectedTaskOutput,
  selectAgentOutputLastReceivedAt,
  selectCompletionState,
  sweepExpiredBaselineMergePauseTick,
} from "../../store/slices/executeSlice";
import { wsSend } from "../../store/middleware/websocketMiddleware";
import {
  selectChatMessages,
  selectChatSending,
  selectChatSupport,
  addOptimisticUserMessage,
  fetchAgentChatHistory,
  fetchAgentChatSupport,
} from "../../store/slices/agentChatSlice";
import {
  useTaskDetail,
  useArchivedSessions,
  useLiveOutputBackfill,
  useTaskExecutionDiagnostics,
  useMarkTaskDone,
  useUnblockTask,
  useDeleteTask,
  useForceRetryTask,
  useTasks,
  useProjectSettings,
  getExecuteTasksRefetchInterval,
} from "../../api/hooks";
import { usePhaseLoadingState } from "../../hooks/usePhaseLoadingState";
import { PhaseLoadingSpinner } from "../../components/PhaseLoadingSpinner";
import { queryKeys } from "../../api/queryKeys";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";
import { BuildEpicCard } from "../../components/kanban";
import { useTaskFilter } from "../../hooks/useTaskFilter";
import {
  useExecuteSwimlanes,
  showReadyInLineSections,
  showPlanningSection,
} from "../../hooks/useExecuteSwimlanes";
import { useScrollToQuestion } from "../../hooks/useScrollToQuestion";
import { useOpenQuestionNotifications } from "../../hooks/useOpenQuestionNotifications";
import { updateNotification, removeNotification } from "../../store/slices/openQuestionsSlice";
import { addNotification } from "../../store/slices/notificationSlice";
import type { Notification } from "@opensprint/shared";
import { ExecuteFilterToolbar } from "../../components/execute/ExecuteFilterToolbar";
import { TaskDetailSidebar } from "../../components/execute/TaskDetailSidebar";
import { TimelineList } from "../../components/execute/TimelineList";
import { clearPhaseUnread } from "../../store/slices/unreadPhaseSlice";
import { PhaseEmptyState, PhaseEmptyStateLogo } from "../../components/PhaseEmptyState";
import { getProjectPhasePath } from "../../lib/phaseRouting";
import { EXECUTE_MAIN_SCROLL_CLASSNAME } from "../../lib/phaseMainScrollLayout";
import { EMPTY_STATE_COPY } from "../../lib/emptyStateCopy";
import type { StatusFilter } from "../../lib/executeTaskFilter";
import { mergeExecuteSelectedTaskData } from "../../lib/mergeExecuteSelectedTask";

interface ExecutePhaseProps {
  projectId: string;
  selectedTaskId?: string;
  initialTaskIdFromUrl?: string;
  onSelectTaskId?: (taskId: string | null) => void;
  onNavigateToPlan?: (planId: string) => void;
  /** Called when user closes the sidebar. When provided (e.g. from ProjectView), clears URL param. */
  onClose?: () => void;
}

const EMPTY_ACTIVE_TASKS: {
  taskId: string;
  phase: string;
  startedAt: string;
}[] = [];
const EMPTY_TASK_STARTED_AT = Object.freeze({}) as Record<string, string>;

/** Clears stale baseline-merge pause UI when server derives expiry without a DB write. */
const BASELINE_MERGE_PAUSE_SWEEP_MS = 8000;

/** Status filters that still apply to the task list but have no chip on the current Execute toolbar. */
const EXECUTE_FILTERS_WITHOUT_CHIPS: StatusFilter[] = ["planning", "in_line"];

export function ExecutePhase({
  projectId,
  selectedTaskId: propSelectedTaskId,
  initialTaskIdFromUrl,
  onSelectTaskId,
  onNavigateToPlan,
  onClose: onCloseProp,
}: ExecutePhaseProps) {
  const dispatch = useAppDispatch();
  const guidanceStore = useStore<RootState>();
  const navigate = useNavigate();
  useEffect(() => {
    dispatch(clearPhaseUnread({ projectId, phase: "execute" }));
  }, [dispatch, projectId]);

  useEffect(() => {
    const id = window.setInterval(() => {
      dispatch(sweepExpiredBaselineMergePauseTick());
    }, BASELINE_MERGE_PAUSE_SWEEP_MS);
    return () => window.clearInterval(id);
  }, [dispatch]);
  const [viewMode, setViewMode] = useState<"kanban" | "timeline">(() => {
    const stored = localStorage.getItem("opensprint.executeView");
    return stored === "kanban" || stored === "timeline" ? stored : "timeline";
  });
  const [artifactsSectionExpanded, setArtifactsSectionExpanded] = useState(true);
  const [descriptionSectionExpanded, setDescriptionSectionExpanded] = useState(true);
  const [diagnosticsSectionExpanded, setDiagnosticsSectionExpanded] = useState(true);
  const [sourceFeedbackExpanded, setSourceFeedbackExpanded] = useState<Record<string, boolean>>({});
  const executeScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem("opensprint.executeView", viewMode);
  }, [viewMode]);

  const {
    statusFilter,
    setStatusFilter,
    searchExpanded,
    searchInputValue,
    setSearchInputValue,
    searchQuery,
    searchInputRef,
    isSearchActive,
    handleSearchExpand,
    handleSearchClose,
    handleSearchKeyDown,
  } = useTaskFilter();

  const queryClient = useQueryClient();
  const tasks = useAppSelector(selectTasks);
  const plans = useAppSelector((s) => s.plan.plans);
  const selectedTaskIdFromStore = useAppSelector((s) => s.execute.selectedTaskId);
  const awaitingApproval = useAppSelector((s) => s.execute.awaitingApproval);
  const baselineStatus = useAppSelector((s) => s.execute.baselineStatus);
  const baselineFailureSummary = useAppSelector((s) => s.execute.baselineFailureSummary);
  const baselineRemediationStatus = useAppSelector((s) => s.execute.baselineRemediationStatus);
  const mergeValidationStatus = useAppSelector((s) => s.execute.mergeValidationStatus);
  const mergeValidationFailureSummary = useAppSelector(
    (s) => s.execute.mergeValidationFailureSummary
  );
  const selfImprovementRunInProgress = useAppSelector(
    (s) => s.execute.selfImprovementRunInProgress ?? false
  );
  const selfImprovementRunMode = useAppSelector((s) => s.execute.selfImprovementRunMode);
  const effectiveSelectedTask =
    propSelectedTaskId ?? initialTaskIdFromUrl ?? selectedTaskIdFromStore ?? null;
  const loading = useAppSelector((s) => s.execute?.async?.tasks?.loading ?? false);
  const activeTasks = useAppSelector((s) => s.execute?.activeTasks ?? EMPTY_ACTIVE_TASKS);
  const taskIdToStartedAt = useAppSelector(
    (s) => s.execute?.taskIdToStartedAt ?? EMPTY_TASK_STARTED_AT
  );
  const wsConnected = useAppSelector((s) => s.websocket?.connected ?? false);
  const selectedTaskFromStore = useAppSelector((s) =>
    effectiveSelectedTask ? (selectTaskById(s, effectiveSelectedTask) ?? null) : null
  );
  const selectedAgentOutput = useAppSelector((s) =>
    selectSelectedTaskOutput(s, effectiveSelectedTask)
  );
  const agentOutputLastReceivedAt = useAppSelector((s) =>
    selectAgentOutputLastReceivedAt(s, effectiveSelectedTask)
  );
  const completionState = useAppSelector((s) => selectCompletionState(s, effectiveSelectedTask));

  const taskDetailQuery = useTaskDetail(projectId, effectiveSelectedTask ?? undefined);
  const archivedQuery = useArchivedSessions(projectId, effectiveSelectedTask ?? undefined, {
    enabled: Boolean(effectiveSelectedTask),
  });
  const liveOutputQuery = useLiveOutputBackfill(projectId, effectiveSelectedTask ?? undefined, {
    enabled: Boolean(effectiveSelectedTask),
  });
  const markDoneMutation = useMarkTaskDone(projectId);
  const unblockMutation = useUnblockTask(projectId);
  const deleteTaskMutation = useDeleteTask(projectId);
  const forceRetryMutation = useForceRetryTask(projectId);
  const projectSettingsQuery = useProjectSettings(projectId);

  const taskIdToWorktreePath = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const t of activeTasks) {
      map[t.taskId] = t.worktreePath;
    }
    return map;
  }, [activeTasks]);

  const taskDetailData = taskDetailQuery.data;
  const taskDetailLoading = taskDetailQuery.isFetching;
  const taskDetailError = taskDetailQuery.error
    ? taskDetailQuery.error instanceof Error
      ? taskDetailQuery.error.message
      : String(taskDetailQuery.error)
    : null;
  const archivedSessionsData = archivedQuery.data;
  const archivedSessions = archivedSessionsData ?? [];
  const archivedLoading = archivedQuery.isFetching;
  const liveOutputData = liveOutputQuery.data;
  const liveOutputRefetch = liveOutputQuery.refetch;
  const markDoneLoading = markDoneMutation.isPending;
  /** Per-task in-flight unblock count — React Query mutation only tracks one pending `variables` at a time. */
  const [unblockInflightByTaskId, setUnblockInflightByTaskId] = useState<Record<string, number>>(
    {}
  );
  const requestUnblock = useCallback(
    (taskId: string, options?: { resetAttempts?: boolean }) => {
      setUnblockInflightByTaskId((prev) => ({
        ...prev,
        [taskId]: (prev[taskId] ?? 0) + 1,
      }));
      const vars =
        options?.resetAttempts !== undefined
          ? { taskId, resetAttempts: options.resetAttempts }
          : { taskId };
      unblockMutation.mutate(vars, {
        onSettled: () => {
          setUnblockInflightByTaskId((prev) => {
            const next = { ...prev };
            const c = (next[taskId] ?? 1) - 1;
            if (c <= 0) delete next[taskId];
            else next[taskId] = c;
            return next;
          });
        },
      });
    },
    [unblockMutation]
  );
  const unblockLoading = Boolean(
    effectiveSelectedTask && (unblockInflightByTaskId[effectiveSelectedTask] ?? 0) > 0
  );
  const selectedTaskData = mergeExecuteSelectedTaskData(
    taskDetailData ?? null,
    selectedTaskFromStore ?? null
  );
  const isDoneTask = selectedTaskData?.kanbanColumn === "done";
  const isBlockedTask = selectedTaskData?.kanbanColumn === "blocked";
  const isInProgressTask =
    selectedTaskData?.kanbanColumn === "in_progress" ||
    selectedTaskData?.kanbanColumn === "in_review";
  const diagnosticsQuery = useTaskExecutionDiagnostics(
    projectId,
    effectiveSelectedTask ?? undefined,
    {
      enabled: Boolean(effectiveSelectedTask),
      refetchInterval: effectiveSelectedTask && !isDoneTask ? 1000 : false,
    }
  );
  const prevWsConnectedRef = useRef(wsConnected);
  const emptyArchivedRefetchTaskIdRef = useRef<string | null>(null);
  const previousPropSelectedTaskIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (propSelectedTaskId === previousPropSelectedTaskIdRef.current) return;
    previousPropSelectedTaskIdRef.current = propSelectedTaskId;
    if (propSelectedTaskId === undefined || selectedTaskIdFromStore === propSelectedTaskId) return;
    dispatch(setSelectedTaskId(propSelectedTaskId ?? null));
  }, [dispatch, propSelectedTaskId, selectedTaskIdFromStore]);

  // Merge task detail into list cache so Redux sync gets it
  useEffect(() => {
    if (!projectId || !effectiveSelectedTask || !taskDetailData) return;
    queryClient.setQueryData(queryKeys.tasks.list(projectId), (prev: unknown) => {
      const list = Array.isArray(prev) ? prev : [];
      const byId = new Map(list.map((t: { id: string }) => [t.id, t]));
      byId.set(taskDetailData.id, taskDetailData);
      return [...byId.values()];
    });
  }, [projectId, effectiveSelectedTask, taskDetailData, queryClient]);

  useEffect(() => {
    if (archivedSessionsData) dispatch(setArchivedSessions(archivedSessionsData));
  }, [archivedSessionsData, dispatch]);

  useEffect(() => {
    if (effectiveSelectedTask && typeof liveOutputData === "string") {
      dispatch(
        setAgentOutputBackfill({
          taskId: effectiveSelectedTask,
          output: liveOutputData,
        })
      );
    }
  }, [effectiveSelectedTask, liveOutputData, dispatch]);

  useEffect(() => {
    const prev = prevWsConnectedRef.current;
    prevWsConnectedRef.current = wsConnected;
    if (!effectiveSelectedTask || isDoneTask) return;
    if (!prev && wsConnected) {
      void liveOutputRefetch();
    }
    // Intentionally omit liveOutputQuery (full object) to avoid effect re-running on every query identity change
    // eslint-disable-next-line react-hooks/exhaustive-deps -- we only need refetch and connection state
  }, [effectiveSelectedTask, isDoneTask, liveOutputQuery.refetch, wsConnected]);

  useEffect(() => {
    if (!effectiveSelectedTask || isDoneTask) {
      emptyArchivedRefetchTaskIdRef.current = null;
      return;
    }
    if (archivedLoading || archivedSessionsData === undefined) return;
    if (archivedSessionsData.length > 0) {
      emptyArchivedRefetchTaskIdRef.current = null;
      return;
    }
    // Retry one time when the first empty response races with a just-finished agent session.
    if (emptyArchivedRefetchTaskIdRef.current === effectiveSelectedTask) return;
    emptyArchivedRefetchTaskIdRef.current = effectiveSelectedTask;
    void archivedQuery.refetch();
    // Intentionally omit archivedQuery (full object) to avoid effect re-running on every query identity change
    // eslint-disable-next-line react-hooks/exhaustive-deps -- we depend on .data, .refetch, and loading
  }, [
    effectiveSelectedTask,
    isDoneTask,
    archivedSessionsData,
    archivedLoading,
    archivedQuery.refetch,
  ]);

  // Subscribe to live agent output. Middleware queues subscribe when WS not yet connected
  useEffect(() => {
    if (effectiveSelectedTask && !isDoneTask) {
      dispatch(wsSend({ type: "agent.subscribe", taskId: effectiveSelectedTask }));
      return () => {
        if (wsConnected) {
          dispatch(wsSend({ type: "agent.unsubscribe", taskId: effectiveSelectedTask }));
        }
      };
    }
  }, [effectiveSelectedTask, isDoneTask, wsConnected, dispatch]);

  const handleMarkDone = async () => {
    if (!effectiveSelectedTask || isDoneTask) return;
    markDoneMutation.mutate(effectiveSelectedTask);
  };

  const handleUnblock = () => {
    if (!effectiveSelectedTask || !isBlockedTask) return;
    requestUnblock(effectiveSelectedTask);
  };

  const handleDeleteTask = async () => {
    if (!effectiveSelectedTask) return;
    await deleteTaskMutation.mutateAsync(effectiveSelectedTask);
    handleClose();
  };

  const handleForceRetry = async () => {
    if (!effectiveSelectedTask) return;
    try {
      await forceRetryMutation.mutateAsync(effectiveSelectedTask);
      dispatch(
        addNotification({ message: "Task reset and queued for retry", severity: "success" })
      );
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const message =
        status === 409 ? "Cannot force-retry a completed task" : "Failed to force-retry task";
      dispatch(addNotification({ message, severity: "error" }));
    }
  };

  const handleSelectTask = useCallback(
    (taskId: string) => {
      dispatch(setSelectedTaskId(taskId));
      onSelectTaskId?.(taskId);
    },
    [dispatch, onSelectTaskId]
  );

  const handleClose = () => {
    dispatch(setSelectedTaskId(null));
    if (onCloseProp) {
      onCloseProp();
    }
  };

  const {
    implTasks,
    filteredTasks,
    swimlanes,
    readySwimlanes,
    inLineSwimlanes,
    blockedSwimlanes,
    planningSwimlanes,
    chipConfig,
  } = useExecuteSwimlanes(tasks, plans, statusFilter, searchQuery);

  // Poll task list continuously: fast fallback when offline + low-frequency safety while connected.
  const tasksQuery = useTasks(projectId, {
    refetchInterval: getExecuteTasksRefetchInterval(wsConnected),
  });
  const tasksEmpty = implTasks.length === 0;
  const { showSpinner: showTasksSpinner, showEmptyState: showTasksEmptyState } =
    usePhaseLoadingState(tasksQuery.isLoading, tasksEmpty);

  /** Nudge scrollport layout after tasks load so `position:sticky` picks up the correct containing block (first paint / refresh). */
  useLayoutEffect(() => {
    if (showTasksSpinner || viewMode !== "timeline" || filteredTasks.length === 0) return;
    executeScrollRef.current?.getBoundingClientRect();
  }, [showTasksSpinner, viewMode, filteredTasks.length]);

  const useReadyInLineSections = showReadyInLineSections(statusFilter) && implTasks.length > 0;
  const usePlanningSection = showPlanningSection(statusFilter) && implTasks.length > 0;

  const planByEpicId = useMemo(
    () =>
      plans.reduce<Record<string, (typeof plans)[number]>>((acc, plan) => {
        acc[plan.metadata.epicId] = plan;
        return acc;
      }, {}),
    [plans]
  );
  const taskById = useMemo(
    () =>
      tasks.reduce<Record<string, (typeof tasks)[number]>>((acc, task) => {
        acc[task.id] = task;
        return acc;
      }, {}),
    [tasks]
  );

  // ── Agent chat state ──
  const chatMessages = useAppSelector((s) =>
    effectiveSelectedTask ? selectChatMessages(s, effectiveSelectedTask) : []
  );
  const chatSending = useAppSelector((s) =>
    effectiveSelectedTask ? selectChatSending(s, effectiveSelectedTask) : false
  );
  const chatSupportInfo = useAppSelector((s) =>
    effectiveSelectedTask ? selectChatSupport(s, effectiveSelectedTask) : { supported: true }
  );

  useEffect(() => {
    if (!effectiveSelectedTask) return;
    void dispatch(fetchAgentChatHistory({ projectId, taskId: effectiveSelectedTask }));
    void dispatch(fetchAgentChatSupport({ projectId, taskId: effectiveSelectedTask }));
  }, [dispatch, projectId, effectiveSelectedTask]);

  const handleChatSend = useCallback(
    (message: string) => {
      if (!effectiveSelectedTask) return false;
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      dispatch(
        addOptimisticUserMessage({ taskId: effectiveSelectedTask, tempId, content: message })
      );
      return awaitGuidanceReceipt(guidanceStore, effectiveSelectedTask, tempId, () =>
        dispatch(
          wsSend({
            type: "agent.chat.send",
            taskId: effectiveSelectedTask,
            message,
            clientMessageId: tempId,
          })
        )
      );
    },
    [dispatch, effectiveSelectedTask, guidanceStore]
  );

  const chatDraftStorageKey = effectiveSelectedTask
    ? `agent-chat-draft-${effectiveSelectedTask}`
    : undefined;

  // Default to "All" when selected filter has no visible tasks (e.g. Blocked selected but no blocked tasks)
  useEffect(() => {
    if (loading || implTasks.length === 0) return;
    if (statusFilter === "all") return;
    if (EXECUTE_FILTERS_WITHOUT_CHIPS.includes(statusFilter)) return;
    const chip = chipConfig.find((c) => c.filter === statusFilter);
    if (!chip || chip.count === 0) {
      setStatusFilter("all");
    }
  }, [loading, implTasks.length, statusFilter, chipConfig, setStatusFilter]);

  useScrollToQuestion();
  const { notifications: openQuestionNotifications, refetch: refetchNotifications } =
    useOpenQuestionNotifications(projectId);
  const taskNotification =
    (effectiveSelectedTask &&
      openQuestionNotifications.find(
        (n) => n.source === "execute" && n.sourceId === effectiveSelectedTask
      )) ??
    null;

  /* ── RENDER: Centered pulsing logo + status during fetch (no bordered container) ── */
  if (showTasksSpinner) {
    return (
      <div
        className="flex flex-1 min-h-0 items-center justify-center"
        data-testid="execute-phase-loading"
      >
        <PhaseLoadingSpinner
          data-testid="execute-phase-loading-spinner"
          aria-label="Loading tasks"
          status="Loading tasks…"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
        <ExecuteFilterToolbar
          chipConfig={chipConfig}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          awaitingApproval={awaitingApproval}
          selfImprovementRunInProgress={selfImprovementRunInProgress}
          selfImprovementRunMode={selfImprovementRunMode}
          searchExpanded={searchExpanded}
          searchInputValue={searchInputValue}
          setSearchInputValue={setSearchInputValue}
          searchInputRef={searchInputRef}
          handleSearchExpand={handleSearchExpand}
          handleSearchClose={handleSearchClose}
          handleSearchKeyDown={handleSearchKeyDown}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          mergeStrategy={projectSettingsQuery.data?.mergeStrategy}
        />

        <div
          ref={executeScrollRef}
          className={EXECUTE_MAIN_SCROLL_CLASSNAME}
          data-testid="execute-main-scroll"
        >
          <a
            href={`/collaborate/${encodeURIComponent(projectId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mb-4 inline-block text-sm text-theme-link underline"
          >
            Open shared session
          </a>
          {baselineStatus === "failing" && (
            <div
              className="mb-4 rounded-lg border border-theme-warning-border bg-theme-warning-bg px-4 py-3 text-theme-warning-text"
              data-testid="execute-baseline-paused-banner"
              role="status"
            >
              <p className="text-sm">
                Merge queue paused until baseline quality gates on main pass.
              </p>
              {baselineFailureSummary && (
                <p className="mt-1 text-xs opacity-90">{baselineFailureSummary}</p>
              )}
              {baselineRemediationStatus && (
                <p
                  className="mt-1 text-xs opacity-90"
                  data-testid="execute-baseline-remediation-status"
                >
                  {baselineRemediationStatus.status === "blocked"
                    ? `Repair blocked after ${baselineRemediationStatus.attempts} attempt${baselineRemediationStatus.attempts !== 1 ? "s" : ""}.`
                    : `Repair in progress (attempt ${baselineRemediationStatus.attempts} of ${baselineRemediationStatus.maxAttempts}).`}
                </p>
              )}
            </div>
          )}
          {mergeValidationStatus === "degraded" && (
            <div
              className="mb-4 rounded-lg border border-theme-error-border bg-theme-error-bg px-4 py-3 text-theme-error-text"
              data-testid="execute-merge-validation-degraded-banner"
              role="status"
            >
              <p className="text-sm">
                Merge validation is temporarily degraded. Coding continues, but merge retries are
                being held for periodic canary checks.
              </p>
              {mergeValidationFailureSummary && (
                <p className="mt-1 text-xs opacity-90">{mergeValidationFailureSummary}</p>
              )}
            </div>
          )}
          {showTasksEmptyState ? (
            <PhaseEmptyState
              title={EMPTY_STATE_COPY.execute.title}
              description={EMPTY_STATE_COPY.execute.description}
              illustration={<PhaseEmptyStateLogo />}
              primaryAction={{
                label: EMPTY_STATE_COPY.execute.primaryActionLabel,
                onClick: () => navigate(getProjectPhasePath(projectId, "plan")),
                "data-testid": "empty-state-go-to-plan",
              }}
            />
          ) : viewMode === "kanban" ? (
            useReadyInLineSections || usePlanningSection ? (
              readySwimlanes.length > 0 ||
              inLineSwimlanes.length > 0 ||
              blockedSwimlanes.length > 0 ||
              planningSwimlanes.length > 0 ? (
                <div className="space-y-8 [&>section:not(:first-child)>h2]:mt-8">
                  {readySwimlanes.length > 0 && (
                    <section data-testid="execute-section-ready">
                      <h2 className="text-sm font-semibold text-theme-muted tracking-wide uppercase mb-4">
                        Ready
                      </h2>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {readySwimlanes.map((lane) => (
                          <BuildEpicCard
                            key={lane.epicId || "other"}
                            epicId={lane.epicId}
                            epicTitle={lane.epicTitle}
                            statusFilter="ready"
                            searchQuery={searchQuery}
                            filteringActive={isSearchActive}
                            onTaskSelect={handleSelectTask}
                            onUnblock={requestUnblock}
                            onViewPlan={
                              lane.planId && onNavigateToPlan
                                ? () => onNavigateToPlan(lane.planId!)
                                : undefined
                            }
                            taskIdToStartedAt={taskIdToStartedAt}
                            selectedTaskId={effectiveSelectedTask}
                            unblockInflightByTaskId={unblockInflightByTaskId}
                            projectId={projectId}
                            taskIdToWorktreePath={taskIdToWorktreePath}
                            isBranchesMode={
                              projectSettingsQuery.data?.gitWorkingMode === "branches"
                            }
                          />
                        ))}
                      </div>
                    </section>
                  )}
                  {inLineSwimlanes.length > 0 && (
                    <section data-testid="execute-section-in_line">
                      <h2 className="text-sm font-semibold text-theme-muted tracking-wide uppercase mb-4">
                        Up Next
                      </h2>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {inLineSwimlanes.map((lane) => (
                          <BuildEpicCard
                            key={lane.epicId || "other"}
                            epicId={lane.epicId}
                            epicTitle={lane.epicTitle}
                            statusFilter="in_line"
                            searchQuery={searchQuery}
                            filteringActive={isSearchActive}
                            onTaskSelect={handleSelectTask}
                            onUnblock={requestUnblock}
                            onViewPlan={
                              lane.planId && onNavigateToPlan
                                ? () => onNavigateToPlan(lane.planId!)
                                : undefined
                            }
                            taskIdToStartedAt={taskIdToStartedAt}
                            selectedTaskId={effectiveSelectedTask}
                            unblockInflightByTaskId={unblockInflightByTaskId}
                            projectId={projectId}
                            taskIdToWorktreePath={taskIdToWorktreePath}
                            isBranchesMode={
                              projectSettingsQuery.data?.gitWorkingMode === "branches"
                            }
                          />
                        ))}
                      </div>
                    </section>
                  )}
                  {blockedSwimlanes.length > 0 && (
                    <section data-testid="execute-section-blocked">
                      <h2 className="text-sm font-semibold text-theme-muted tracking-wide uppercase mb-4">
                        Failures
                      </h2>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {blockedSwimlanes.map((lane) => (
                          <BuildEpicCard
                            key={lane.epicId || "other"}
                            epicId={lane.epicId}
                            epicTitle={lane.epicTitle}
                            statusFilter="blocked"
                            searchQuery={searchQuery}
                            filteringActive={isSearchActive}
                            onTaskSelect={handleSelectTask}
                            onUnblock={requestUnblock}
                            onViewPlan={
                              lane.planId && onNavigateToPlan
                                ? () => onNavigateToPlan(lane.planId!)
                                : undefined
                            }
                            taskIdToStartedAt={taskIdToStartedAt}
                            selectedTaskId={effectiveSelectedTask}
                            unblockInflightByTaskId={unblockInflightByTaskId}
                            projectId={projectId}
                            taskIdToWorktreePath={taskIdToWorktreePath}
                            isBranchesMode={
                              projectSettingsQuery.data?.gitWorkingMode === "branches"
                            }
                          />
                        ))}
                      </div>
                    </section>
                  )}
                  {planningSwimlanes.length > 0 && (
                    <section data-testid="execute-section-planning">
                      <h2 className="text-sm font-semibold text-theme-muted tracking-wide uppercase mb-4">
                        Planning
                      </h2>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {planningSwimlanes.map((lane) => (
                          <BuildEpicCard
                            key={lane.epicId || "other"}
                            epicId={lane.epicId}
                            epicTitle={lane.epicTitle}
                            statusFilter="planning"
                            searchQuery={searchQuery}
                            plans={plans}
                            filteringActive={isSearchActive}
                            onTaskSelect={handleSelectTask}
                            onUnblock={requestUnblock}
                            onViewPlan={
                              lane.planId && onNavigateToPlan
                                ? () => onNavigateToPlan(lane.planId!)
                                : undefined
                            }
                            taskIdToStartedAt={taskIdToStartedAt}
                            selectedTaskId={effectiveSelectedTask}
                            unblockInflightByTaskId={unblockInflightByTaskId}
                            projectId={projectId}
                            taskIdToWorktreePath={taskIdToWorktreePath}
                            isBranchesMode={
                              projectSettingsQuery.data?.gitWorkingMode === "branches"
                            }
                          />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              ) : (
                <div className="text-center py-10 text-theme-muted">
                  {isSearchActive
                    ? "No tasks match your search."
                    : statusFilter === "all"
                      ? "All tasks completed."
                      : "No tasks match this filter."}
                </div>
              )
            ) : swimlanes.length === 0 ? (
              <div className="text-center py-10 text-theme-muted">
                {isSearchActive
                  ? "No tasks match your search."
                  : statusFilter === "all"
                    ? "All tasks completed."
                    : "No tasks match this filter."}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {swimlanes.map((lane) => (
                    <BuildEpicCard
                      key={lane.epicId || "other"}
                      epicId={lane.epicId}
                      epicTitle={lane.epicTitle}
                      statusFilter={statusFilter}
                      searchQuery={searchQuery}
                      filteringActive={isSearchActive}
                      onTaskSelect={handleSelectTask}
                      onUnblock={requestUnblock}
                      onViewPlan={
                        lane.planId && onNavigateToPlan
                          ? () => onNavigateToPlan(lane.planId!)
                          : undefined
                      }
                      taskIdToStartedAt={taskIdToStartedAt}
                      selectedTaskId={effectiveSelectedTask}
                      unblockInflightByTaskId={unblockInflightByTaskId}
                      projectId={projectId}
                      taskIdToWorktreePath={taskIdToWorktreePath}
                      isBranchesMode={projectSettingsQuery.data?.gitWorkingMode === "branches"}
                    />
                  ))}
                </div>
              </>
            )
          ) : filteredTasks.length === 0 ? (
            <div className="text-center py-10 text-theme-muted">
              {isSearchActive
                ? "No tasks match your search."
                : statusFilter === "all"
                  ? "All tasks completed."
                  : "No tasks match this filter."}
            </div>
          ) : (
            <>
              <TimelineList
                tasks={filteredTasks}
                plans={plans}
                onTaskSelect={handleSelectTask}
                onUnblock={requestUnblock}
                unblockInflightByTaskId={unblockInflightByTaskId}
                taskIdToStartedAt={taskIdToStartedAt}
                statusFilter={statusFilter}
                scrollRef={executeScrollRef}
                selectedTaskId={effectiveSelectedTask}
                projectId={projectId}
                teamMembers={projectSettingsQuery.data?.teamMembers ?? []}
                enableHumanTeammates={projectSettingsQuery.data?.enableHumanTeammates ?? false}
              />
            </>
          )}
        </div>
      </div>

      {effectiveSelectedTask && (
        <ResizableSidebar
          storageKey="execute"
          defaultWidth={420}
          resizeHandleLabel="Resize task detail sidebar"
          responsive={true}
          overlayOnMobile={false}
          onClose={handleClose}
        >
          <TaskDetailSidebar
            projectId={projectId}
            selectedTask={effectiveSelectedTask}
            taskDetail={{
              selectedTaskData: selectedTaskData ?? null,
              taskDetailLoading,
              taskDetailError,
            }}
            openQuestionNotification={
              taskNotification && typeof taskNotification === "object"
                ? taskNotification
                : undefined
            }
            agentOutput={selectedAgentOutput}
            agentOutputLastReceivedAt={agentOutputLastReceivedAt}
            completionState={completionState}
            diagnostics={diagnosticsQuery.data ?? null}
            diagnosticsLoading={diagnosticsQuery.isFetching}
            archivedSessions={archivedSessions}
            archivedLoading={archivedLoading}
            markDoneLoading={markDoneLoading}
            unblockLoading={unblockLoading}
            deleteLoading={deleteTaskMutation.isPending}
            forceRetryLoading={forceRetryMutation.isPending}
            taskIdToStartedAt={taskIdToStartedAt}
            planByEpicId={planByEpicId}
            taskById={taskById}
            activeTasks={activeTasks}
            wsConnected={wsConnected}
            isDoneTask={isDoneTask}
            isBlockedTask={isBlockedTask}
            isInProgressTask={isInProgressTask}
            sections={{
              descriptionSectionExpanded,
              setDescriptionSectionExpanded,
              artifactsSectionExpanded,
              setArtifactsSectionExpanded,
              diagnosticsSectionExpanded,
              setDiagnosticsSectionExpanded,
              sourceFeedbackExpanded,
              setSourceFeedbackExpanded,
            }}
            teamMembers={projectSettingsQuery.data?.teamMembers ?? []}
            enableHumanTeammates={projectSettingsQuery.data?.enableHumanTeammates ?? false}
            isBranchesMode={projectSettingsQuery.data?.gitWorkingMode === "branches"}
            chatMessages={chatMessages}
            chatSending={chatSending}
            onChatSend={handleChatSend}
            chatDraftStorageKey={chatDraftStorageKey}
            chatSupported={chatSupportInfo.supported}
            chatUnsupportedReason={chatSupportInfo.reason}
            callbacks={{
              onClose: handleClose,
              onMarkDone: handleMarkDone,
              onUnblock: handleUnblock,
              onDeleteTask: handleDeleteTask,
              onForceRetry: handleForceRetry,
              onSelectTask: handleSelectTask,
              onNavigateToPlan,
              onOpenQuestionResolved: (
                resolved?: Notification,
                notificationIdToRemove?: string
              ) => {
                if (resolved) dispatch(updateNotification(resolved));
                if (notificationIdToRemove) {
                  dispatch(
                    removeNotification({ projectId, notificationId: notificationIdToRemove })
                  );
                }
                refetchNotifications();
                // Refresh task data so UI shows task as unblocked; backend already unblocks and nudges orchestrator
                if (resolved?.source === "execute" && resolved?.sourceId) {
                  void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
                  void queryClient.invalidateQueries({
                    queryKey: queryKeys.tasks.detail(projectId, resolved.sourceId),
                  });
                }
              },
            }}
          />
        </ResizableSidebar>
      )}
    </div>
  );
}
