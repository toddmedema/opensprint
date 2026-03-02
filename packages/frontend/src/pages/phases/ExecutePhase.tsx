import { useState, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  setSelectedTaskId,
  setAgentOutputBackfill,
  setArchivedSessions,
  selectTasks,
  selectTaskById,
  selectSelectedTaskOutput,
  selectCompletionState,
} from "../../store/slices/executeSlice";
import { wsSend } from "../../store/middleware/websocketMiddleware";
import {
  useTaskDetail,
  useArchivedSessions,
  useLiveOutputBackfill,
  useTaskExecutionDiagnostics,
  useMarkTaskDone,
  useUnblockTask,
  useTasks,
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
} from "../../hooks/useExecuteSwimlanes";
import { useScrollToQuestion } from "../../hooks/useScrollToQuestion";
import { useOpenQuestionNotifications } from "../../hooks/useOpenQuestionNotifications";
import { ExecuteFilterToolbar } from "../../components/execute/ExecuteFilterToolbar";
import { TaskDetailSidebar } from "../../components/execute/TaskDetailSidebar";
import { TimelineList } from "../../components/execute/TimelineList";

interface ExecutePhaseProps {
  projectId: string;
  /** Task ID from URL (?task=...) so sidebar can show on first paint before Redux sync. */
  initialTaskIdFromUrl?: string | null;
  onNavigateToPlan?: (planId: string) => void;
  /** Called when user closes the sidebar. When provided (e.g. from ProjectView), clears URL param; otherwise just clears Redux. */
  onClose?: () => void;
}

export function ExecutePhase({
  projectId,
  initialTaskIdFromUrl,
  onNavigateToPlan,
  onClose: onCloseProp,
}: ExecutePhaseProps) {
  const dispatch = useAppDispatch();
  const [viewMode, setViewMode] = useState<"kanban" | "timeline">(() => {
    const stored = localStorage.getItem("opensprint.executeView");
    return stored === "kanban" || stored === "timeline" ? stored : "kanban";
  });
  const [artifactsSectionExpanded, setArtifactsSectionExpanded] = useState(true);
  const [descriptionSectionExpanded, setDescriptionSectionExpanded] = useState(true);
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
  const awaitingApproval = useAppSelector((s) => s.execute.awaitingApproval);
  const selectedTask = useAppSelector((s) => s.execute.selectedTaskId);
  /** Resolve selection from Redux or URL so sidebar shows on first paint when opening with ?task= */
  const effectiveSelectedTask = selectedTask ?? initialTaskIdFromUrl ?? null;
  const loading = useAppSelector((s) => s.execute?.async?.tasks?.loading ?? false);
  const activeTasks = useAppSelector((s) => s.execute.activeTasks);
  const taskIdToStartedAt = useAppSelector((s) => s.execute.taskIdToStartedAt);
  const wsConnected = useAppSelector((s) => s.websocket?.connected ?? false);
  const selectedTaskFromStore = useAppSelector((s) =>
    effectiveSelectedTask ? (selectTaskById(s, effectiveSelectedTask) ?? null) : null
  );
  const selectedAgentOutput = useAppSelector((s) =>
    selectSelectedTaskOutput(s, effectiveSelectedTask)
  );
  const completionState = useAppSelector((s) =>
    selectCompletionState(s, effectiveSelectedTask)
  );

  const taskDetailQuery = useTaskDetail(projectId, effectiveSelectedTask ?? undefined);
  const archivedQuery = useArchivedSessions(
    projectId,
    effectiveSelectedTask ?? undefined,
    { enabled: Boolean(effectiveSelectedTask) }
  );
  const liveOutputQuery = useLiveOutputBackfill(
    projectId,
    effectiveSelectedTask ?? undefined,
    {
      enabled: Boolean(effectiveSelectedTask),
    }
  );
  const markDoneMutation = useMarkTaskDone(projectId);
  const unblockMutation = useUnblockTask(projectId);

  const taskDetailData = taskDetailQuery.data;
  const taskDetailLoading = taskDetailQuery.isFetching;
  const taskDetailError = taskDetailQuery.error
    ? (taskDetailQuery.error instanceof Error ? taskDetailQuery.error.message : String(taskDetailQuery.error))
    : null;
  const archivedSessions = archivedQuery.data ?? [];
  const archivedLoading = archivedQuery.isFetching;
  const markDoneLoading = markDoneMutation.isPending;
  const unblockLoading = unblockMutation.isPending;
  const selectedTaskData = effectiveSelectedTask
    ? (taskDetailData ?? selectedTaskFromStore ?? null)
    : null;
  const isDoneTask = selectedTaskData?.kanbanColumn === "done";
  const isBlockedTask = selectedTaskData?.kanbanColumn === "blocked";
  const diagnosticsQuery = useTaskExecutionDiagnostics(
    projectId,
    effectiveSelectedTask ?? undefined,
    {
      enabled: Boolean(effectiveSelectedTask),
      refetchInterval: effectiveSelectedTask && !isDoneTask ? 1000 : false,
    }
  );
  const prevWsConnectedRef = useRef<boolean | null>(null);

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
    if (archivedQuery.data) dispatch(setArchivedSessions(archivedQuery.data));
  }, [archivedQuery.data, dispatch]);

  useEffect(() => {
    if (effectiveSelectedTask && typeof liveOutputQuery.data === "string") {
      dispatch(
        setAgentOutputBackfill({
          taskId: effectiveSelectedTask,
          output: liveOutputQuery.data,
        })
      );
    }
  }, [effectiveSelectedTask, liveOutputQuery.data, dispatch]);

  useEffect(() => {
    const prev = prevWsConnectedRef.current;
    prevWsConnectedRef.current = wsConnected;
    if (prev == null) return;
    if (!effectiveSelectedTask || isDoneTask) return;
    if (!prev && wsConnected) {
      void liveOutputQuery.refetch();
    }
  }, [effectiveSelectedTask, isDoneTask, liveOutputQuery, wsConnected]);

  useEffect(() => {
    if (effectiveSelectedTask && !isDoneTask && archivedQuery.data?.length === 0 && !archivedLoading) {
      void archivedQuery.refetch();
    }
  }, [effectiveSelectedTask, isDoneTask, archivedQuery.data?.length, archivedLoading, archivedQuery]);

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

  const handleUnblock = async () => {
    if (!effectiveSelectedTask || !isBlockedTask) return;
    unblockMutation.mutate({ taskId: effectiveSelectedTask });
  };

  const handleClose = () => {
    if (onCloseProp) {
      onCloseProp();
    } else {
      dispatch(setSelectedTaskId(null));
    }
  };

  const {
    implTasks,
    filteredTasks,
    swimlanes,
    readySwimlanes,
    inLineSwimlanes,
    chipConfig,
  } = useExecuteSwimlanes(tasks, plans, statusFilter, searchQuery);

  const tasksQuery = useTasks(projectId);
  const tasksEmpty = implTasks.length === 0;
  const { showSpinner: showTasksSpinner, showEmptyState: showTasksEmptyState } = usePhaseLoadingState(
    tasksQuery.isLoading,
    tasksEmpty
  );

  const useReadyInLineSections =
    showReadyInLineSections(statusFilter) && implTasks.length > 0;

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

  // Default to "All" when selected filter has no visible tasks (e.g. user navigated with "Blocked" selected but no blocked tasks)
  useEffect(() => {
    if (loading || implTasks.length === 0) return;
    if (statusFilter === "all") return;
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
      )) ?? null;

  /* ── RENDER: Loading spinner during fetch (no fake page content) ── */
  if (showTasksSpinner) {
    return (
      <div
        className="flex flex-1 min-h-0 items-center justify-center bg-theme-bg"
        data-testid="execute-phase-loading"
      >
        <PhaseLoadingSpinner
          data-testid="execute-phase-loading-spinner"
          aria-label="Loading tasks"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <ExecuteFilterToolbar
          chipConfig={chipConfig}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          awaitingApproval={awaitingApproval}
          searchExpanded={searchExpanded}
          searchInputValue={searchInputValue}
          setSearchInputValue={setSearchInputValue}
          searchInputRef={searchInputRef}
          handleSearchExpand={handleSearchExpand}
          handleSearchClose={handleSearchClose}
          handleSearchKeyDown={handleSearchKeyDown}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />

        <div ref={executeScrollRef} className="flex-1 min-h-0 overflow-auto p-6" data-testid="execute-main-scroll">
          {showTasksEmptyState ? (
            <div className="text-center py-10 text-theme-muted">
              No tasks yet. Ship a Plan to start generating tasks.
            </div>
          ) : viewMode === "kanban" ? (
            useReadyInLineSections ? (
              (readySwimlanes.length > 0 || inLineSwimlanes.length > 0) ? (
                <div className="space-y-8">
                  {readySwimlanes.length > 0 && (
                    <section data-testid="execute-section-ready">
                      <h2 className="text-sm font-semibold text-theme-muted tracking-wide uppercase mb-4">
                        Ready
                      </h2>
                      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {readySwimlanes.map((lane) => (
                          <BuildEpicCard
                            key={lane.epicId || "other"}
                            epicId={lane.epicId}
                            epicTitle={lane.epicTitle}
                            statusFilter="ready"
                            searchQuery={searchQuery}
                            filteringActive={isSearchActive}
                            onTaskSelect={(taskId) => dispatch(setSelectedTaskId(taskId))}
                            onUnblock={(taskId) => unblockMutation.mutate({ taskId })}
                            onViewPlan={
                              lane.planId && onNavigateToPlan
                                ? () => onNavigateToPlan(lane.planId!)
                                : undefined
                            }
                            taskIdToStartedAt={taskIdToStartedAt}
                            selectedTaskId={effectiveSelectedTask}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                  {inLineSwimlanes.length > 0 && (
                    <section data-testid="execute-section-in_line">
                      <h2 className="text-sm font-semibold text-theme-muted tracking-wide uppercase mb-4">
                        In Line
                      </h2>
                      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {inLineSwimlanes.map((lane) => (
                          <BuildEpicCard
                            key={lane.epicId || "other"}
                            epicId={lane.epicId}
                            epicTitle={lane.epicTitle}
                            statusFilter="in_line"
                            searchQuery={searchQuery}
                            filteringActive={isSearchActive}
                            onTaskSelect={(taskId) => dispatch(setSelectedTaskId(taskId))}
                            onUnblock={(taskId) => unblockMutation.mutate({ taskId })}
                            onViewPlan={
                              lane.planId && onNavigateToPlan
                                ? () => onNavigateToPlan(lane.planId!)
                                : undefined
                            }
                            taskIdToStartedAt={taskIdToStartedAt}
                            selectedTaskId={effectiveSelectedTask}
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
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {swimlanes.map((lane) => (
                    <BuildEpicCard
                      key={lane.epicId || "other"}
                      epicId={lane.epicId}
                      epicTitle={lane.epicTitle}
                      statusFilter={statusFilter}
                      searchQuery={searchQuery}
                      filteringActive={isSearchActive}
                      onTaskSelect={(taskId) => dispatch(setSelectedTaskId(taskId))}
                      onUnblock={(taskId) => unblockMutation.mutate({ taskId })}
                      onViewPlan={
                        lane.planId && onNavigateToPlan
                          ? () => onNavigateToPlan(lane.planId!)
                          : undefined
                      }
                      taskIdToStartedAt={taskIdToStartedAt}
                      selectedTaskId={effectiveSelectedTask}
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
                onTaskSelect={(taskId) => dispatch(setSelectedTaskId(taskId))}
                onUnblock={(taskId) => unblockMutation.mutate({ taskId })}
                taskIdToStartedAt={taskIdToStartedAt}
                statusFilter={statusFilter}
                scrollRef={executeScrollRef}
                selectedTaskId={effectiveSelectedTask}
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
          responsive
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
            completionState={completionState}
            diagnostics={diagnosticsQuery.data ?? null}
            diagnosticsLoading={diagnosticsQuery.isFetching}
            archivedSessions={archivedSessions}
            archivedLoading={archivedLoading}
            markDoneLoading={markDoneLoading}
            unblockLoading={unblockLoading}
            taskIdToStartedAt={taskIdToStartedAt}
            planByEpicId={planByEpicId}
            taskById={taskById}
            activeTasks={activeTasks}
            wsConnected={wsConnected}
            isDoneTask={isDoneTask}
            isBlockedTask={isBlockedTask}
            sections={{
              descriptionSectionExpanded,
              setDescriptionSectionExpanded,
              artifactsSectionExpanded,
              setArtifactsSectionExpanded,
              sourceFeedbackExpanded,
              setSourceFeedbackExpanded,
            }}
            callbacks={{
              onClose: handleClose,
              onMarkDone: handleMarkDone,
              onUnblock: handleUnblock,
              onSelectTask: (taskId) => dispatch(setSelectedTaskId(taskId)),
              onNavigateToPlan,
              onOpenQuestionResolved: refetchNotifications,
            }}
          />
        </ResizableSidebar>
      )}
    </div>
  );
}
