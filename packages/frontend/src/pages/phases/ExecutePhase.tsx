import { useState, useEffect } from "react";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  fetchTaskDetail,
  fetchArchivedSessions,
  fetchLiveOutputBackfill,
  fetchActiveAgents,
  markTaskDone,
  unblockTask,
  setSelectedTaskId,
} from "../../store/slices/executeSlice";
import { wsSend } from "../../store/middleware/websocketMiddleware";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";
import { BuildEpicCard } from "../../components/kanban";
import { useTaskFilter } from "../../hooks/useTaskFilter";
import { useExecuteSwimlanes } from "../../hooks/useExecuteSwimlanes";
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

  const tasks = useAppSelector((s) => s.execute.tasks);
  const plans = useAppSelector((s) => s.plan.plans);
  const awaitingApproval = useAppSelector((s) => s.execute.awaitingApproval);
  const selectedTask = useAppSelector((s) => s.execute.selectedTaskId);
  /** Resolve selection from Redux or URL so sidebar shows on first paint when opening with ?task= */
  const effectiveSelectedTask = selectedTask ?? initialTaskIdFromUrl ?? null;
  const taskDetailLoading = useAppSelector((s) => s.execute?.async?.taskDetail?.loading ?? false);
  const taskDetailError = useAppSelector((s) => s.execute?.async?.taskDetail?.error ?? null);
  const agentOutput = useAppSelector((s) => s.execute?.agentOutput ?? {});
  const completionState = useAppSelector((s) => s.execute?.completionState ?? null);
  const archivedSessions = useAppSelector((s) => s.execute?.archivedSessions ?? []);
  const archivedLoading = useAppSelector((s) => s.execute?.async?.archived?.loading ?? false);
  const markDoneLoading = useAppSelector((s) => s.execute?.async?.markDone?.loading ?? false);
  const unblockLoading = useAppSelector((s) => s.execute?.async?.unblock?.loading ?? false);
  const loading = useAppSelector((s) => s.execute?.async?.tasks?.loading ?? false);
  const taskIdToStartedAt = useAppSelector((s) => s.execute?.taskIdToStartedAt ?? {});
  const selectedTaskData = effectiveSelectedTask
    ? (tasks.find((t) => t.id === effectiveSelectedTask) ?? null)
    : null;
  const isDoneTask = selectedTaskData?.kanbanColumn === "done";
  const activeTasks = useAppSelector((s) => s.execute.activeTasks);
  const wsConnected = useAppSelector((s) => s.websocket?.connected ?? false);
  const isBlockedTask = selectedTaskData?.kanbanColumn === "blocked";

  useEffect(() => {
    dispatch(fetchActiveAgents(projectId));
    const interval = setInterval(() => dispatch(fetchActiveAgents(projectId)), 5000);
    return () => clearInterval(interval);
  }, [projectId, dispatch]);

  useEffect(() => {
    if (effectiveSelectedTask) {
      dispatch(fetchTaskDetail({ projectId, taskId: effectiveSelectedTask }));
    }
  }, [projectId, effectiveSelectedTask, dispatch]);

  useEffect(() => {
    if (effectiveSelectedTask && isDoneTask) {
      dispatch(fetchArchivedSessions({ projectId, taskId: effectiveSelectedTask }));
    }
  }, [projectId, effectiveSelectedTask, isDoneTask, dispatch]);

  const selectedAgentOutput = effectiveSelectedTask
    ? (agentOutput[effectiveSelectedTask] ?? [])
    : [];

  useEffect(() => {
    if (
      effectiveSelectedTask &&
      !isDoneTask &&
      completionState &&
      selectedAgentOutput.length === 0 &&
      !archivedLoading
    ) {
      dispatch(fetchArchivedSessions({ projectId, taskId: effectiveSelectedTask }));
    }
  }, [
    projectId,
    effectiveSelectedTask,
    isDoneTask,
    completionState,
    selectedAgentOutput.length,
    archivedLoading,
    dispatch,
  ]);

  // Subscribe to live agent output. Middleware queues subscribe when WS not yet connected
  // and replays on open, fixing "stuck/never loads" when opening sidebar before connection ready.
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

  // Live polling: refresh agent output every 1s while viewing an in-progress task.
  // WebSocket streams chunks when available; polling ensures updates even when WS fails (e.g. Cursor agent).
  useEffect(() => {
    if (!effectiveSelectedTask || isDoneTask) return;
    dispatch(fetchLiveOutputBackfill({ projectId, taskId: effectiveSelectedTask }));
    const interval = setInterval(() => {
      dispatch(fetchLiveOutputBackfill({ projectId, taskId: effectiveSelectedTask }));
    }, 1000);
    return () => clearInterval(interval);
  }, [projectId, effectiveSelectedTask, isDoneTask, dispatch]);

  const handleMarkDone = async () => {
    if (!effectiveSelectedTask || isDoneTask) return;
    dispatch(markTaskDone({ projectId, taskId: effectiveSelectedTask }));
  };

  const handleUnblock = async () => {
    if (!effectiveSelectedTask || !isBlockedTask) return;
    dispatch(unblockTask({ projectId, taskId: effectiveSelectedTask }));
  };

  const handleClose = () => {
    if (onCloseProp) {
      onCloseProp();
    } else {
      dispatch(setSelectedTaskId(null));
    }
  };

  const { implTasks, filteredTasks, swimlanes, chipConfig } = useExecuteSwimlanes(
    tasks,
    plans,
    statusFilter,
    searchQuery
  );

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

        <div className="flex-1 min-h-0 overflow-auto p-6">
          {loading ? (
            <div className="text-center py-10 text-theme-muted">Loading tasks...</div>
          ) : implTasks.length === 0 ? (
            <div className="text-center py-10 text-theme-muted">
              No tasks yet. Ship a Plan to start generating tasks.
            </div>
          ) : viewMode === "kanban" ? (
            swimlanes.length === 0 ? (
              <div className="text-center py-10 text-theme-muted">
                {isSearchActive
                  ? "No tasks match your search."
                  : statusFilter === "all"
                    ? "All tasks completed."
                    : "No tasks match this filter."}
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {swimlanes.map((lane) => (
                  <BuildEpicCard
                    key={lane.epicId || "other"}
                    epicId={lane.epicId}
                    epicTitle={lane.epicTitle}
                    tasks={lane.tasks}
                    filteringActive={isSearchActive}
                    onTaskSelect={(taskId) => dispatch(setSelectedTaskId(taskId))}
                    onUnblock={(taskId) => dispatch(unblockTask({ projectId, taskId }))}
                    onViewPlan={
                      lane.planId && onNavigateToPlan
                        ? () => onNavigateToPlan(lane.planId!)
                        : undefined
                    }
                    taskIdToStartedAt={taskIdToStartedAt}
                  />
                ))}
              </div>
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
            <TimelineList
              tasks={filteredTasks}
              plans={plans}
              onTaskSelect={(taskId) => dispatch(setSelectedTaskId(taskId))}
              onUnblock={(taskId) => dispatch(unblockTask({ projectId, taskId }))}
              taskIdToStartedAt={taskIdToStartedAt}
            />
          )}
        </div>
      </div>

      {effectiveSelectedTask && (
        <>
          <button
            type="button"
            className="md:hidden fixed inset-0 bg-theme-overlay z-40 animate-fade-in"
            onClick={handleClose}
            aria-label="Dismiss task detail"
          />
          <ResizableSidebar
            storageKey="execute"
            defaultWidth={420}
            className="fixed md:static inset-y-0 right-0 z-50 md:border-l border-theme-border shadow-xl md:shadow-none animate-slide-in-right md:animate-none max-w-[100vw] md:max-w-none"
          >
            <TaskDetailSidebar
              projectId={projectId}
              selectedTask={effectiveSelectedTask}
              selectedTaskData={selectedTaskData ?? null}
              taskDetailLoading={taskDetailLoading}
              taskDetailError={taskDetailError}
              agentOutput={selectedAgentOutput}
              completionState={completionState}
              archivedSessions={archivedSessions}
              archivedLoading={archivedLoading}
              markDoneLoading={markDoneLoading}
              unblockLoading={unblockLoading}
              taskIdToStartedAt={taskIdToStartedAt}
              plans={plans}
              tasks={tasks}
              activeTasks={activeTasks}
              wsConnected={wsConnected}
              isDoneTask={isDoneTask}
              isBlockedTask={isBlockedTask}
              sourceFeedbackExpanded={sourceFeedbackExpanded}
              setSourceFeedbackExpanded={setSourceFeedbackExpanded}
              descriptionSectionExpanded={descriptionSectionExpanded}
              setDescriptionSectionExpanded={setDescriptionSectionExpanded}
              artifactsSectionExpanded={artifactsSectionExpanded}
              setArtifactsSectionExpanded={setArtifactsSectionExpanded}
              onNavigateToPlan={onNavigateToPlan}
              onClose={handleClose}
              onMarkDone={handleMarkDone}
              onUnblock={handleUnblock}
              onSelectTask={(taskId) => dispatch(setSelectedTaskId(taskId))}
            />
          </ResizableSidebar>
        </>
      )}
    </div>
  );
}
