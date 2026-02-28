import React, { useRef, useEffect, useState, useMemo } from "react";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentSession, Notification, Plan, Task } from "@opensprint/shared";
import { VirtualizedAgentOutput } from "./VirtualizedAgentOutput";
import { PRIORITY_LABELS, AGENT_ROLE_LABELS, complexityToDisplay } from "@opensprint/shared";
import type { ActiveTaskInfo } from "../../store/slices/executeSlice";
import { useAppDispatch } from "../../store";
import { updateTaskPriority, addTaskDependency } from "../../store/slices/executeSlice";
import { wsConnect } from "../../store/middleware/websocketMiddleware";
import { CloseButton } from "../CloseButton";
import { PriorityIcon } from "../PriorityIcon";
import { ComplexityIcon } from "../ComplexityIcon";
import { TaskStatusBadge, COLUMN_LABELS } from "../kanban";
import { formatUptime, formatTaskDuration } from "../../lib/formatting";
import { getEpicTitleFromPlan } from "../../lib/planContentUtils";
import { getMessageBasedHint } from "../../store/listeners/notificationListener";
import { filterAgentOutput } from "../../utils/agentOutputFilter";
import { ArchivedSessionView } from "./ArchivedSessionView";
import { CollapsibleSection } from "./CollapsibleSection";
import { SourceFeedbackSection } from "./SourceFeedbackSection";
import { AddLinkFlow } from "./AddLinkFlow";
import { OpenQuestionsBlock } from "../OpenQuestionsBlock";
import { api } from "../../api/client";

const DescriptionMarkdown = React.memo(({ content }: { content: string }) => (
  <div
    className="prose-task-description prose-execute-task"
    data-testid="task-description-markdown"
  >
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
  </div>
));

export interface TaskDetailSidebarProps {
  projectId: string;
  selectedTask: string;
  /** Selected task from state.tasks (single source of truth; enriched when fetchTaskDetail completes) */
  selectedTaskData: Task | null;
  taskDetailLoading: boolean;
  taskDetailError: string | null;
  agentOutput: string[];
  completionState: {
    status: string;
    testResults: { passed: number; failed: number; skipped: number; total: number } | null;
    reason?: string | null;
  } | null;
  archivedSessions: AgentSession[];
  archivedLoading: boolean;
  markDoneLoading: boolean;
  unblockLoading: boolean;
  taskIdToStartedAt: Record<string, string>;
  plans: Plan[];
  tasks: Task[];
  activeTasks: ActiveTaskInfo[];
  wsConnected: boolean;
  isDoneTask: boolean;
  isBlockedTask: boolean;
  sourceFeedbackExpanded: Record<string, boolean>;
  setSourceFeedbackExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  descriptionSectionExpanded: boolean;
  setDescriptionSectionExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  artifactsSectionExpanded: boolean;
  setArtifactsSectionExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  onNavigateToPlan?: (planId: string) => void;
  onClose: () => void;
  /** Open question notification for this task (renders block with Answer/Dismiss) */
  openQuestionNotification?: Notification | null;
  /** Called when open question is resolved (refetch notifications) */
  onOpenQuestionResolved?: () => void;
  onMarkDone: () => void;
  onUnblock: () => void;
  onSelectTask: (taskId: string) => void;
}

const activeRoleLabel = (selectedTask: string, activeTasks: ActiveTaskInfo[]) => {
  const active = activeTasks.find((a) => a.taskId === selectedTask);
  if (!active) return null;
  const phase = active.phase as "coding" | "review";
  return AGENT_ROLE_LABELS[phase === "coding" ? "coder" : "reviewer"] ?? null;
};

function areTaskDetailSidebarPropsEqual(
  prev: TaskDetailSidebarProps,
  next: TaskDetailSidebarProps
): boolean {
  if (
    prev.projectId !== next.projectId ||
    prev.selectedTask !== next.selectedTask ||
    prev.selectedTaskData !== next.selectedTaskData ||
    prev.taskDetailLoading !== next.taskDetailLoading ||
    prev.taskDetailError !== next.taskDetailError ||
    prev.archivedLoading !== next.archivedLoading ||
    prev.markDoneLoading !== next.markDoneLoading ||
    prev.unblockLoading !== next.unblockLoading ||
    prev.taskIdToStartedAt !== next.taskIdToStartedAt ||
    prev.plans !== next.plans ||
    prev.tasks !== next.tasks ||
    prev.activeTasks !== next.activeTasks ||
    prev.wsConnected !== next.wsConnected ||
    prev.isDoneTask !== next.isDoneTask ||
    prev.isBlockedTask !== next.isBlockedTask ||
    prev.sourceFeedbackExpanded !== next.sourceFeedbackExpanded ||
    prev.setSourceFeedbackExpanded !== next.setSourceFeedbackExpanded ||
    prev.descriptionSectionExpanded !== next.descriptionSectionExpanded ||
    prev.setDescriptionSectionExpanded !== next.setDescriptionSectionExpanded ||
    prev.artifactsSectionExpanded !== next.artifactsSectionExpanded ||
    prev.setArtifactsSectionExpanded !== next.setArtifactsSectionExpanded ||
    prev.onNavigateToPlan !== next.onNavigateToPlan ||
    prev.onClose !== next.onClose ||
    prev.openQuestionNotification !== next.openQuestionNotification ||
    prev.onOpenQuestionResolved !== next.onOpenQuestionResolved ||
    prev.onMarkDone !== next.onMarkDone ||
    prev.onUnblock !== next.onUnblock ||
    prev.onSelectTask !== next.onSelectTask
  ) {
    return false;
  }
  if (prev.agentOutput !== next.agentOutput) return false;
  if (prev.archivedSessions !== next.archivedSessions) return false;
  if (prev.completionState !== next.completionState) return false;
  return true;
}

function TaskDetailSidebarInner({
  projectId,
  selectedTask,
  selectedTaskData,
  taskDetailLoading,
  taskDetailError,
  agentOutput,
  completionState,
  archivedSessions,
  archivedLoading,
  markDoneLoading,
  unblockLoading,
  taskIdToStartedAt,
  plans,
  tasks,
  activeTasks,
  wsConnected,
  isDoneTask,
  isBlockedTask,
  sourceFeedbackExpanded,
  setSourceFeedbackExpanded,
  descriptionSectionExpanded,
  setDescriptionSectionExpanded,
  artifactsSectionExpanded,
  setArtifactsSectionExpanded,
  onNavigateToPlan,
  onClose,
  openQuestionNotification,
  onOpenQuestionResolved,
  onMarkDone,
  onUnblock,
  onSelectTask,
}: TaskDetailSidebarProps) {
  const dispatch = useAppDispatch();
  const roleLabel = activeRoleLabel(selectedTask, activeTasks);
  const [priorityDropdownOpen, setPriorityDropdownOpen] = useState(false);
  const [showLoadingPlaceholder, setShowLoadingPlaceholder] = useState(false);

  const agentOutputText = useMemo(() => agentOutput.join(""), [agentOutput]);

  const liveOutputContent = useMemo(() => {
    if (agentOutputText.length > 0) return agentOutputText;
    if (archivedSessions.length > 0) {
      return (
        filterAgentOutput(archivedSessions[archivedSessions.length - 1]?.outputLog ?? "") ||
        "Waiting for agent output..."
      );
    }
    return showLoadingPlaceholder ? "Loading output…" : "Waiting for agent output...";
  }, [
    agentOutputText,
    archivedSessions,
    showLoadingPlaceholder,
  ]);

  const {
    containerRef: liveOutputRef,
    showJumpToBottom,
    jumpToBottom,
    handleScroll: handleLiveOutputScroll,
  } = useAutoScroll({
    contentLength: liveOutputContent.length,
    resetKey: selectedTask,
  });
  const priorityDropdownRef = useRef<HTMLDivElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const task = selectedTaskData;
  const displayLabel = task ? complexityToDisplay(task.complexity) : null;

  const displayDesc = useMemo(() => {
    if (!task) return "";
    const desc = task.description ?? "";
    const isOnlyFeedbackId = /^Feedback ID:\s*.+$/.test(desc.trim());
    const hasSourceFeedback =
      (task.sourceFeedbackIds?.length ?? (task.sourceFeedbackId ? 1 : 0)) > 0;
    return hasSourceFeedback && isOnlyFeedbackId ? "" : desc;
  }, [task?.description, task?.sourceFeedbackIds, task?.sourceFeedbackId]);

  const feedbackIds = useMemo(
    () =>
      task?.sourceFeedbackIds ?? (task?.sourceFeedbackId ? [task.sourceFeedbackId] : []),
    [task?.sourceFeedbackIds, task?.sourceFeedbackId]
  );

  const sourceFeedbackToggleCallbacks = useMemo(() => {
    const map: Record<string, () => void> = {};
    feedbackIds.forEach((feedbackId, index) => {
      map[feedbackId] = () =>
        setSourceFeedbackExpanded((prev) => ({
          ...prev,
          [feedbackId]: !(prev[feedbackId] ?? index === 0),
        }));
    });
    return map;
  }, [feedbackIds, setSourceFeedbackExpanded]);

  const hasActions = isBlockedTask || (!isDoneTask && !isBlockedTask);

  useEffect(() => {
    setShowLoadingPlaceholder(true);
    const t = setTimeout(() => setShowLoadingPlaceholder(false), 2000);
    return () => clearTimeout(t);
  }, [selectedTask]);

  useEffect(() => {
    if (!priorityDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (priorityDropdownRef.current && !priorityDropdownRef.current.contains(e.target as Node)) {
        setPriorityDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [priorityDropdownOpen]);

  useEffect(() => {
    if (!actionsMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [actionsMenuOpen]);

  const handlePrioritySelect = (priority: number) => {
    if (!task || !selectedTask || task.priority === priority) return;
    const previousPriority = task.priority ?? 1;
    dispatch(
      updateTaskPriority({
        projectId,
        taskId: selectedTask,
        priority,
        previousPriority,
      })
    );
    setPriorityDropdownOpen(false);
  };

  return (
    <>
      <div className="flex items-center gap-2 p-4 border-b border-theme-border shrink-0 min-h-0 flex-nowrap">
        {/* Title: single line for header */}
        <div className="min-w-0 flex-1">
          <h3
            className="font-semibold text-theme-text truncate block"
            data-testid="task-detail-title"
          >
            {task?.title ?? selectedTask ?? ""}
          </h3>
        </div>
        {/* Actions overflow menu (three-dot) — left of close */}
        {hasActions && (
          <div ref={actionsMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setActionsMenuOpen((o) => !o)}
              className="p-1.5 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
              aria-label="Task actions"
              aria-haspopup="menu"
              aria-expanded={actionsMenuOpen}
              data-testid="sidebar-actions-menu-trigger"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
              </svg>
            </button>
            {actionsMenuOpen && (
              <ul
                role="menu"
                className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-theme-border bg-theme-surface shadow-lg py-1"
                data-testid="sidebar-actions-menu"
              >
                {isBlockedTask && (
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onUnblock();
                        setActionsMenuOpen(false);
                      }}
                      disabled={unblockLoading}
                      className="dropdown-item w-full flex items-center gap-2 text-left text-xs text-theme-error-text hover:bg-theme-error-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid="sidebar-unblock-btn"
                    >
                      {unblockLoading ? "Unblocking…" : "Unblock"}
                    </button>
                  </li>
                )}
                {!isDoneTask && !isBlockedTask && (
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onMarkDone();
                        setActionsMenuOpen(false);
                      }}
                      disabled={markDoneLoading}
                      className="dropdown-item w-full flex items-center gap-2 text-left text-xs font-medium text-brand-600 hover:bg-theme-border-subtle/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid="sidebar-mark-done-btn"
                    >
                      {markDoneLoading ? "Marking…" : "Mark done"}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
        <div className="shrink-0">
          <CloseButton onClick={onClose} ariaLabel="Close task detail" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Open questions block — when coder needs clarification */}
        {openQuestionNotification && task && (
          <OpenQuestionsBlock
            notification={openQuestionNotification}
            projectId={projectId}
            source="execute"
            sourceId={selectedTask}
            onResolved={onOpenQuestionResolved ?? (() => {})}
            onAnswerSent={async (message) => {
              await api.chat.send(projectId, message, `execute:${selectedTask}`);
            }}
          />
        )}

        <div className="p-4 border-b border-theme-border has-[+_[data-section=view-plan-deps-addlink]]:border-b-0">
          {task && (
            <>
              {/* Row 1: Status and priority on a single row */}
              <div
                className="flex flex-wrap items-center gap-2 mb-3 text-xs text-theme-muted"
                data-testid="task-detail-priority-state-row"
              >
                <span className="inline-flex items-center gap-1.5">
                  <TaskStatusBadge
                    column={task.kanbanColumn}
                    size="xs"
                    title={COLUMN_LABELS[task.kanbanColumn]}
                  />
                  <span>{COLUMN_LABELS[task.kanbanColumn]}</span>
                </span>
                {isDoneTask ? (
                  <span
                    className="inline-flex items-center gap-1.5 text-theme-muted/80 cursor-default"
                    data-testid="priority-read-only"
                    aria-label={`Priority: ${PRIORITY_LABELS[task.priority ?? 1] ?? "Medium"}`}
                  >
                    <PriorityIcon priority={task.priority ?? 1} size="sm" />
                    {PRIORITY_LABELS[task.priority ?? 1] ?? "Medium"}
                  </span>
                ) : (
                  <div ref={priorityDropdownRef} className="relative inline-block">
                    <button
                      type="button"
                      onClick={() => setPriorityDropdownOpen((o) => !o)}
                      className="dropdown-trigger inline-flex items-center gap-2 rounded py-1 text-theme-muted hover:bg-theme-border-subtle/50 hover:text-theme-text transition-colors cursor-pointer"
                      aria-haspopup="listbox"
                      aria-expanded={priorityDropdownOpen}
                      aria-label={`Priority: ${PRIORITY_LABELS[task.priority ?? 1] ?? "Medium"}. Click to change`}
                      data-testid="priority-dropdown-trigger"
                    >
                      <PriorityIcon priority={task.priority ?? 1} size="sm" />
                      <span>{PRIORITY_LABELS[task.priority ?? 1] ?? "Medium"}</span>
                      <span className="text-[10px] opacity-70 pr-2">
                        {priorityDropdownOpen ? "▲" : "▼"}
                      </span>
                    </button>
                    {priorityDropdownOpen && (
                      <ul
                        role="listbox"
                        className="absolute left-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-theme-border bg-theme-surface shadow-lg py-1"
                        data-testid="priority-dropdown"
                      >
                        {([0, 1, 2, 3, 4] as const).map((p) => (
                          <li key={p} role="option">
                            <button
                              type="button"
                              onClick={() => handlePrioritySelect(p)}
                              className={`dropdown-item w-full flex items-center gap-2 text-left text-xs hover:bg-theme-border-subtle/50 transition-colors ${
                                (task.priority ?? 1) === p
                                  ? "text-brand-600 font-medium"
                                  : "text-theme-text"
                              }`}
                              data-testid={`priority-option-${p}`}
                            >
                              <PriorityIcon priority={p} size="sm" />
                              {p}: {PRIORITY_LABELS[p]}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <span
                  className="inline-flex items-center gap-1.5 text-theme-muted/80"
                  data-testid="task-complexity"
                  aria-label={
                    displayLabel
                      ? `Complexity: ${displayLabel}`
                      : "Complexity: not set"
                  }
                >
                  <ComplexityIcon complexity={task.complexity} size="sm" />
                  {displayLabel ?? "—"}
                </span>
                {isDoneTask && (() => {
                  const duration = formatTaskDuration(task.startedAt, task.completedAt);
                  return duration ? (
                    <span
                      className="inline-flex items-center text-theme-muted/80"
                      data-testid="task-duration"
                      aria-label={`Took ${duration}`}
                    >
                      Took {duration}
                    </span>
                  ) : null;
                })()}
              </div>
              {/* Block reason: shown below status/priority row when task is blocked */}
              {isBlockedTask && task.blockReason && (
                <div
                  className="mb-3 text-xs text-theme-error-text"
                  data-testid="task-block-reason"
                >
                  {task.blockReason}
                </div>
              )}
              {/* Row 2: Active agent section (role, name, elapsed time) — only when agent is active */}
              {roleLabel && (
                <div
                  className="mb-3 px-3 py-1.5 rounded-md bg-theme-warning-bg border border-theme-warning-border text-xs font-medium text-theme-warning-text flex items-center gap-3 min-w-0"
                  data-testid="task-detail-active-callout"
                >
                  <span className="truncate">
                    Active: {roleLabel}
                    {task.assignee && ` · ${task.assignee}`}
                    {selectedTask && taskIdToStartedAt[selectedTask] && (
                      <> · {formatUptime(taskIdToStartedAt[selectedTask])}</>
                    )}
                  </span>
                </div>
              )}
            </>
          )}
          {taskDetailError ? (
            <div
              className="rounded-lg border border-theme-error-border bg-theme-error-bg p-4 text-sm text-theme-error-text"
              data-testid="task-detail-error"
            >
              {taskDetailError}
            </div>
          ) : taskDetailLoading ? (
            <div className="space-y-3" data-testid="task-detail-loading">
              <div className="h-4 w-3/4 bg-theme-surface-muted rounded animate-pulse" />
              <div className="h-3 w-full bg-theme-surface-muted rounded animate-pulse" />
              <div className="h-3 w-2/3 bg-theme-surface-muted rounded animate-pulse" />
              <div className="h-24 w-full bg-theme-surface-muted rounded animate-pulse" />
            </div>
          ) : !task ? (
            <div className="text-sm text-theme-muted" data-testid="task-detail-empty">
              Could not load task details.
            </div>
          ) : null}
        </div>

        {/* Links (Plan first, then blocked/parent/related) and Add link */}
        {task && (
          <div className="p-4 border-b border-theme-border" data-section="view-plan-deps-addlink">
            {/* Links: Plan first, then blocked/parent/related */}
            {(() => {
              const plan =
                task.epicId && onNavigateToPlan
                  ? plans.find((p) => p.metadata.epicId === task.epicId)
                  : null;
              const planTitle = plan ? getEpicTitleFromPlan(plan) : null;

              const nonEpicDeps = (task.dependencies ?? []).filter(
                (d) =>
                  d.targetId &&
                  d.type !== "discovered-from" &&
                  d.targetId !== task.epicId
              );

              const TYPE_ORDER: Record<string, number> = {
                blocks: 0,
                "parent-child": 1,
                related: 2,
              };
              const TYPE_LABEL: Record<string, string> = {
                blocks: "Blocked on:",
                "parent-child": "Parent:",
                related: "Related:",
              };
              const sorted = [...nonEpicDeps].sort(
                (a, b) =>
                  (TYPE_ORDER[a.type] ?? 3) - (TYPE_ORDER[b.type] ?? 3)
              );

              const hasPlanLink = !!plan && !!planTitle;
              const hasDeps = nonEpicDeps.length > 0;
              if (!hasPlanLink && !hasDeps) return null;

              return (
                <div className="text-xs">
                  <span className="text-theme-muted">Links:</span>
                  <div className="flex flex-col gap-y-1.5 mt-1.5">
                    {/* Plan link as first item */}
                    {hasPlanLink && (
                      <button
                        type="button"
                        onClick={() => onNavigateToPlan!(plan!.metadata.planId)}
                        className="inline-flex items-center gap-1.5 text-left hover:underline text-brand-600 hover:text-brand-500 transition-colors"
                        title={`View plan: ${planTitle}`}
                        data-testid="sidebar-view-plan-btn"
                      >
                        <span className="text-theme-muted shrink-0">Plan:</span>
                        <span className="truncate max-w-[200px]" title={planTitle!}>
                          {planTitle}
                        </span>
                      </button>
                    )}
                    {sorted.map((d) => {
                      const depTask = tasks.find((t) => t.id === d.targetId);
                      const label = depTask?.title ?? d.targetId;
                      const col = depTask?.kanbanColumn ?? "backlog";
                      const typeLabel = TYPE_LABEL[d.type] ?? "Related:";
                      return (
                        <button
                          key={d.targetId}
                          type="button"
                          onClick={() => onSelectTask(d.targetId!)}
                          className="inline-flex items-center gap-1.5 text-left hover:underline text-brand-600 hover:text-brand-500 transition-colors"
                        >
                          <TaskStatusBadge
                            column={col}
                            size="xs"
                            title={COLUMN_LABELS[col]}
                          />
                          <span className="text-theme-muted shrink-0">
                            {typeLabel}
                          </span>
                          <span className="truncate max-w-[200px]" title={label}>
                            {label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Add link button / flow */}
            {addLinkOpen ? (
              <AddLinkFlow
                projectId={projectId}
                childTaskId={selectedTask}
                tasks={tasks}
                excludeIds={new Set([
                  selectedTask,
                  ...(task.dependencies ?? [])
                    .filter((d) => d.targetId)
                    .map((d) => d.targetId!),
                ])}
                onSave={async (parentTaskId, type) => {
                  await dispatch(
                    addTaskDependency({
                      projectId,
                      taskId: selectedTask,
                      parentTaskId,
                      type,
                    })
                  ).unwrap();
                }}
                onCancel={() => setAddLinkOpen(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAddLinkOpen(true)}
                className="text-xs text-brand-600 hover:text-brand-700 hover:underline text-left mt-1.5"
                data-testid="sidebar-add-link-btn"
              >
                Add link
              </button>
            )}
          </div>
        )}

        {task && displayDesc ? (
          <CollapsibleSection
            title="Description"
            expanded={descriptionSectionExpanded}
            onToggle={() => setDescriptionSectionExpanded((prev) => !prev)}
            expandAriaLabel="Expand Description"
            collapseAriaLabel="Collapse Description"
            contentId="description-content"
            headerId="description-header"
          >
            <DescriptionMarkdown content={displayDesc} />
          </CollapsibleSection>
        ) : null}

        {feedbackIds.length > 0
          ? feedbackIds.map((feedbackId, index) => (
              <SourceFeedbackSection
                key={feedbackId}
                projectId={projectId}
                feedbackId={feedbackId}
                expanded={sourceFeedbackExpanded[feedbackId] ?? index === 0}
                onToggle={sourceFeedbackToggleCallbacks[feedbackId] ?? (() => {})}
                title={
                  feedbackIds.length > 1
                    ? `Source feedback (${index + 1} of ${feedbackIds.length})`
                    : "Source Feedback"
                }
              />
            ))
          : null}

        <CollapsibleSection
          title={isDoneTask ? "Done Work Artifacts" : "Live agent output"}
          expanded={artifactsSectionExpanded}
          onToggle={() => setArtifactsSectionExpanded(!artifactsSectionExpanded)}
          expandAriaLabel={`Expand ${isDoneTask ? "Done Work Artifacts" : "Live agent output"}`}
          collapseAriaLabel={`Collapse ${isDoneTask ? "Done Work Artifacts" : "Live agent output"}`}
          contentId="artifacts-content"
          headerId="artifacts-header"
        >
          <div className="bg-theme-code-bg rounded-lg border border-theme-border overflow-hidden min-h-[200px] max-h-[400px] flex flex-col">
            {taskDetailLoading ? (
              <div className="p-4 space-y-2" data-testid="artifacts-loading">
                <div className="h-3 w-full bg-theme-surface-muted rounded animate-pulse" />
                <div className="h-3 w-4/5 bg-theme-surface-muted rounded animate-pulse" />
                <div className="h-20 w-full bg-theme-surface-muted rounded animate-pulse mt-4" />
              </div>
            ) : isDoneTask ? (
              archivedLoading ? (
                <div className="p-4 text-theme-muted text-sm">Loading archived sessions...</div>
              ) : archivedSessions.length === 0 ? (
                <div className="p-4 text-theme-muted text-sm">
                  No archived sessions for this task.
                </div>
              ) : (
                <ArchivedSessionView sessions={archivedSessions} />
              )
            ) : (
              <div className="flex flex-col min-h-0 flex-1">
                {!wsConnected ? (
                  <div className="p-4 flex flex-col gap-3" data-testid="live-output-connecting">
                    <div className="text-sm text-theme-muted flex items-center gap-2">
                      <span
                        className="inline-block w-4 h-4 border-2 border-theme-border border-t-brand-500 rounded-full animate-spin"
                        aria-hidden
                      />
                      Connecting to live output…
                    </div>
                    <p className="text-xs text-theme-muted">
                      If the connection fails, you can retry.
                    </p>
                    <button
                      type="button"
                      onClick={() => dispatch(wsConnect({ projectId }))}
                      className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline self-start"
                      data-testid="live-output-retry"
                    >
                      Retry connection
                    </button>
                  </div>
                ) : (
                  <div className="relative flex-1 min-h-0 flex flex-col">
                    <VirtualizedAgentOutput
                      content={liveOutputContent}
                      useMarkdown={true}
                      containerRef={liveOutputRef}
                      onScroll={handleLiveOutputScroll}
                      data-testid="live-agent-output"
                    />
                    {showJumpToBottom && (
                      <button
                        type="button"
                        onClick={jumpToBottom}
                        className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs font-medium rounded-full bg-theme-surface border border-theme-border text-theme-text shadow-md hover:bg-theme-border-subtle/50 transition-colors z-10"
                        data-testid="jump-to-bottom"
                        aria-label="Jump to bottom"
                      >
                        Jump to bottom
                      </button>
                    )}
                  </div>
                )}
                {completionState && (
                  <div className="px-4 pb-4 border-t border-theme-border pt-3 mt-0">
                    <div
                      className={`text-sm font-medium ${
                        completionState.status === "approved"
                          ? "text-theme-success-muted"
                          : "text-theme-warning-solid"
                      }`}
                    >
                      Agent done: {completionState.status}
                    </div>
                    {completionState.status === "failed" &&
                      completionState.reason &&
                      completionState.reason.trim() !== "" && (
                        <div
                          className="text-xs text-theme-error-text mt-1"
                          data-testid="completion-failure-reason"
                        >
                          {completionState.reason}
                          {getMessageBasedHint(completionState.reason) && (
                            <div className="mt-1 text-theme-muted">
                              {getMessageBasedHint(completionState.reason)}
                            </div>
                          )}
                        </div>
                      )}
                    {completionState.testResults && completionState.testResults.total > 0 && (
                      <div className="text-xs text-theme-muted mt-1">
                        {completionState.testResults.passed} passed
                        {completionState.testResults.failed > 0
                          ? `, ${completionState.testResults.failed} failed`
                          : ""}
                        {completionState.testResults.skipped > 0 &&
                          `, ${completionState.testResults.skipped} skipped`}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </CollapsibleSection>
      </div>
    </>
  );
}

export const TaskDetailSidebar = React.memo(
  TaskDetailSidebarInner,
  areTaskDetailSidebarPropsEqual
);
