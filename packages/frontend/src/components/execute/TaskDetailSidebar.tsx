import React, { useRef, useEffect, useState, useMemo } from "react";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentSession,
  Notification,
  Plan,
  Task,
  TaskExecutionDiagnostics,
  TaskExecutionOutcome,
  TaskExecutionPhase,
} from "@opensprint/shared";
import { VirtualizedAgentOutput } from "./VirtualizedAgentOutput";
import {
  AGENT_ROLE_LABELS,
  complexityToDisplay,
  TASK_COMPLEXITY_MIN,
  TASK_COMPLEXITY_MAX,
} from "@opensprint/shared";
import type { ActiveTaskInfo } from "../../store/slices/executeSlice";
import { useAppDispatch } from "../../store";
import { addTaskDependency, removeTaskDependency } from "../../store/slices/executeSlice";
import { wsConnect } from "../../store/middleware/websocketMiddleware";
import { CloseButton } from "../CloseButton";
import { ComplexityIcon } from "../ComplexityIcon";
import { TaskPriorityDropdown } from "./TaskPriorityDropdown";
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

/** Execute sidebar: no horizontal rules (task feedback x5cqqc) */
const MARKDOWN_NO_HR = { hr: () => null };

const DescriptionMarkdown = React.memo(({ content }: { content: string }) => (
  <div
    className="prose-task-description prose-execute-task"
    data-testid="task-description-markdown"
  >
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_NO_HR}>
      {content}
    </ReactMarkdown>
  </div>
));
DescriptionMarkdown.displayName = "DescriptionMarkdown";

const EXECUTION_PHASE_LABELS: Record<TaskExecutionPhase, string> = {
  coding: "Coding",
  review: "Review",
  merge: "Merge",
  orchestrator: "Orchestrator",
};

const EXECUTION_OUTCOME_LABELS: Record<TaskExecutionOutcome, string> = {
  running: "Running",
  suspended: "Suspended",
  failed: "Failed",
  rejected: "Rejected",
  requeued: "Requeued",
  demoted: "Demoted",
  blocked: "Failures",
  completed: "Completed",
};

function truncateDiagnosticsText(text: string, limit = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return compact.slice(0, Math.max(0, limit - 3)).trimEnd() + "...";
}

function formatAttemptLabel(attempts: number[]): string {
  if (attempts.length === 0) return "";
  if (attempts.length === 1) return `Attempt ${attempts[0]}`;
  const first = attempts[0];
  const last = attempts[attempts.length - 1];
  return first === last ? `Attempt ${first}` : `Attempts ${first}-${last}`;
}

/** Compare task data excluding priority. When only priority changed, skip sidebar re-render (TaskPriorityDropdown handles it via Redux). */
function taskDataEqualExceptPriority(a: Task | null, b: Task | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.id !== b.id) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Task>;
  for (const k of keys) {
    if (k === "priority") continue;
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
  }
  return true;
}

export interface TaskDetailTaskDetail {
  selectedTaskData: Task | null;
  taskDetailLoading: boolean;
  taskDetailError: string | null;
}

export interface TaskDetailSections {
  descriptionSectionExpanded: boolean;
  setDescriptionSectionExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  artifactsSectionExpanded: boolean;
  setArtifactsSectionExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  diagnosticsSectionExpanded: boolean;
  setDiagnosticsSectionExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  sourceFeedbackExpanded: Record<string, boolean>;
  setSourceFeedbackExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

export interface TaskDetailCallbacks {
  onClose: () => void;
  onMarkDone: () => void;
  onUnblock: () => void;
  onDeleteTask: () => void | Promise<void>;
  onSelectTask: (taskId: string) => void;
  onNavigateToPlan?: (planId: string) => void;
  onOpenQuestionResolved?: () => void;
}

export interface TaskDetailSidebarProps {
  projectId: string;
  selectedTask: string;
  taskDetail: TaskDetailTaskDetail;
  agentOutput: string[];
  completionState: {
    status: string;
    testResults: { passed: number; failed: number; skipped: number; total: number } | null;
    reason?: string | null;
  } | null;
  diagnostics: TaskExecutionDiagnostics | null;
  diagnosticsLoading: boolean;
  archivedSessions: AgentSession[];
  archivedLoading: boolean;
  markDoneLoading: boolean;
  unblockLoading: boolean;
  deleteLoading: boolean;
  taskIdToStartedAt: Record<string, string>;
  planByEpicId: Record<string, Plan>;
  taskById: Record<string, Task>;
  activeTasks: ActiveTaskInfo[];
  wsConnected: boolean;
  isDoneTask: boolean;
  isBlockedTask: boolean;
  sections: TaskDetailSections;
  /** Open question notification for this task (renders block with Answer/Dismiss) */
  openQuestionNotification?: Notification | null;
  callbacks: TaskDetailCallbacks;
}

/** Build active agent label(s) for the selected task. Handles multi-angle review: shows each reviewer with angle (e.g. "Reviewer (Security), Reviewer (Performance)"). */
const activeRoleLabel = (selectedTask: string, activeTasks: ActiveTaskInfo[]): string | null => {
  const matching = activeTasks.filter((a) => a.taskId === selectedTask);
  if (matching.length === 0) return null;
  const labels = matching.map((a) => {
    const phase = a.phase as "coding" | "review";
    const roleLabel = AGENT_ROLE_LABELS[phase === "coding" ? "coder" : "reviewer"] ?? "";
    return a.name?.trim() || roleLabel;
  });
  return labels.filter(Boolean).join(", ") || null;
};

function areTaskDetailSidebarPropsEqual(
  prev: TaskDetailSidebarProps,
  next: TaskDetailSidebarProps
): boolean {
  const td = (a: TaskDetailSidebarProps) => a.taskDetail;
  const sec = (a: TaskDetailSidebarProps) => a.sections;
  const cb = (a: TaskDetailSidebarProps) => a.callbacks;
  if (
    prev.projectId !== next.projectId ||
    prev.selectedTask !== next.selectedTask ||
    !taskDataEqualExceptPriority(td(prev).selectedTaskData, td(next).selectedTaskData) ||
    td(prev).taskDetailLoading !== td(next).taskDetailLoading ||
    td(prev).taskDetailError !== td(next).taskDetailError ||
    prev.archivedLoading !== next.archivedLoading ||
    prev.markDoneLoading !== next.markDoneLoading ||
    prev.unblockLoading !== next.unblockLoading ||
    prev.deleteLoading !== next.deleteLoading ||
    prev.taskIdToStartedAt !== next.taskIdToStartedAt ||
    prev.planByEpicId !== next.planByEpicId ||
    prev.taskById !== next.taskById ||
    prev.activeTasks !== next.activeTasks ||
    prev.wsConnected !== next.wsConnected ||
    prev.isDoneTask !== next.isDoneTask ||
    prev.isBlockedTask !== next.isBlockedTask ||
    prev.diagnostics !== next.diagnostics ||
    prev.diagnosticsLoading !== next.diagnosticsLoading ||
    sec(prev).sourceFeedbackExpanded !== sec(next).sourceFeedbackExpanded ||
    sec(prev).setSourceFeedbackExpanded !== sec(next).setSourceFeedbackExpanded ||
    sec(prev).descriptionSectionExpanded !== sec(next).descriptionSectionExpanded ||
    sec(prev).setDescriptionSectionExpanded !== sec(next).setDescriptionSectionExpanded ||
    sec(prev).artifactsSectionExpanded !== sec(next).artifactsSectionExpanded ||
    sec(prev).setArtifactsSectionExpanded !== sec(next).setArtifactsSectionExpanded ||
    sec(prev).diagnosticsSectionExpanded !== sec(next).diagnosticsSectionExpanded ||
    sec(prev).setDiagnosticsSectionExpanded !== sec(next).setDiagnosticsSectionExpanded ||
    cb(prev).onNavigateToPlan !== cb(next).onNavigateToPlan ||
    cb(prev).onClose !== cb(next).onClose ||
    prev.openQuestionNotification !== next.openQuestionNotification ||
    cb(prev).onOpenQuestionResolved !== cb(next).onOpenQuestionResolved ||
    cb(prev).onMarkDone !== cb(next).onMarkDone ||
    cb(prev).onUnblock !== cb(next).onUnblock ||
    cb(prev).onDeleteTask !== cb(next).onDeleteTask ||
    cb(prev).onSelectTask !== cb(next).onSelectTask
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
  taskDetail,
  agentOutput,
  completionState,
  diagnostics,
  diagnosticsLoading,
  archivedSessions,
  archivedLoading,
  markDoneLoading,
  unblockLoading,
  deleteLoading,
  taskIdToStartedAt,
  planByEpicId,
  taskById,
  activeTasks,
  wsConnected,
  isDoneTask,
  isBlockedTask,
  sections,
  openQuestionNotification,
  callbacks,
}: TaskDetailSidebarProps) {
  const { selectedTaskData, taskDetailLoading, taskDetailError } = taskDetail;
  const {
    sourceFeedbackExpanded,
    setSourceFeedbackExpanded,
    descriptionSectionExpanded,
    setDescriptionSectionExpanded,
    artifactsSectionExpanded,
    setArtifactsSectionExpanded,
    diagnosticsSectionExpanded,
    setDiagnosticsSectionExpanded,
  } = sections;
  const {
    onNavigateToPlan,
    onClose,
    onOpenQuestionResolved,
    onMarkDone,
    onUnblock,
    onDeleteTask,
    onSelectTask,
  } = callbacks;
  const dispatch = useAppDispatch();
  const roleLabel = activeRoleLabel(selectedTask, activeTasks);
  const [showLoadingPlaceholder, setShowLoadingPlaceholder] = useState(false);

  const agentOutputText = useMemo(() => agentOutput.join(""), [agentOutput]);
  const activeTaskState = useMemo(
    () => activeTasks.find((task) => task.taskId === selectedTask) ?? null,
    [activeTasks, selectedTask]
  );

  const liveOutputContent = useMemo(() => {
    if (agentOutputText.length > 0) return agentOutputText;
    if (archivedSessions.length > 0) {
      return (
        filterAgentOutput(archivedSessions[archivedSessions.length - 1]?.outputLog ?? "") ||
        (activeTaskState?.state === "suspended"
          ? "Agent suspended; waiting for reconnect or new output..."
          : "Waiting for agent output...")
      );
    }
    if (activeTaskState?.state === "suspended") {
      return "Agent suspended; waiting for reconnect or new output...";
    }
    return showLoadingPlaceholder ? "Loading output…" : "Waiting for agent output...";
  }, [activeTaskState?.state, agentOutputText, archivedSessions, showLoadingPlaceholder]);

  const {
    containerRef: liveOutputRef,
    showJumpToBottom,
    jumpToBottom,
    handleScroll: handleLiveOutputScroll,
  } = useAutoScroll({
    contentLength: liveOutputContent.length,
    resetKey: selectedTask,
  });
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteLinkConfirm, setDeleteLinkConfirm] = useState<{
    targetId: string;
    type: string;
    taskName: string;
  } | null>(null);
  const [removeLinkRemovingId, setRemoveLinkRemovingId] = useState<string | null>(null);
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const task = selectedTaskData;
  const displayLabel = task ? complexityToDisplay(task.complexity) : null;
  const allTasks = useMemo(() => Object.values(taskById), [taskById]);

  const displayDesc = useMemo(() => {
    if (!task) return "";
    const desc = task.description ?? "";
    const isOnlyFeedbackId = /^Feedback ID:\s*.+$/.test(desc.trim());
    const hasSourceFeedback =
      (task.sourceFeedbackIds?.length ?? (task.sourceFeedbackId ? 1 : 0)) > 0;
    return hasSourceFeedback && isOnlyFeedbackId ? "" : desc;
  }, [task?.description, task?.sourceFeedbackIds, task?.sourceFeedbackId]);

  const feedbackIds = useMemo(
    () => task?.sourceFeedbackIds ?? (task?.sourceFeedbackId ? [task.sourceFeedbackId] : []),
    [task?.sourceFeedbackIds, task?.sourceFeedbackId]
  );
  const earlierFailureSummaries = useMemo(() => {
    if (!diagnostics || diagnostics.attempts.length < 2) return [];

    const normalizeSummary = (summary: string) =>
      summary
        .replace(/\bAttempt \d+\b/gi, "Attempt")
        .replace(/\s+/g, " ")
        .trim();

    const olderAttempts = [...diagnostics.attempts.slice(1)]
      .filter((attempt) => attempt.finalOutcome !== "running" && attempt.finalSummary.trim() !== "")
      .sort((a, b) => a.attempt - b.attempt);
    const groups: Array<{ attempts: number[]; summary: string }> = [];

    for (const attempt of olderAttempts) {
      const summary = normalizeSummary(attempt.finalSummary);
      const previous = groups[groups.length - 1];
      if (previous && previous.summary === summary) {
        previous.attempts.push(attempt.attempt);
        continue;
      }
      groups.push({ attempts: [attempt.attempt], summary });
    }

    return groups
      .slice(0, 2)
      .map(
        (group) =>
          `${formatAttemptLabel(group.attempts)}: ${truncateDiagnosticsText(group.summary)}`
      );
  }, [diagnostics]);

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
    if (!actionsMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [actionsMenuOpen]);

  const handleConfirmDeleteTask = async () => {
    await onDeleteTask();
    setDeleteConfirmOpen(false);
  };

  return (
    <>
      <div className="flex items-center gap-2 px-4 pt-4 pb-2 shrink-0 min-h-0 flex-nowrap">
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
                      data-testid="sidebar-retry-btn"
                    >
                      {unblockLoading ? "Retrying…" : "Retry"}
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
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDeleteConfirmOpen(true);
                      setActionsMenuOpen(false);
                    }}
                    disabled={deleteLoading}
                    className="dropdown-item w-full flex items-center gap-2 text-left text-xs text-theme-error-text hover:bg-theme-error-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="sidebar-delete-task-btn"
                  >
                    {deleteLoading ? "Deleting..." : "Delete"}
                  </button>
                </li>
              </ul>
            )}
          </div>
        )}
        <div className="shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center">
          <CloseButton onClick={onClose} ariaLabel="Close task detail" />
        </div>
      </div>

      {deleteConfirmOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close delete task confirmation"
            onClick={() => setDeleteConfirmOpen(false)}
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-task-confirm-title"
            className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col"
            data-testid="sidebar-delete-task-dialog"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border shrink-0">
              <h2 id="delete-task-confirm-title" className="text-lg font-semibold text-theme-text">
                Delete task
              </h2>
              <CloseButton
                onClick={() => setDeleteConfirmOpen(false)}
                ariaLabel="Close delete task confirmation"
              />
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-theme-text">
                Delete this task permanently? This also removes links and references to this task.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
              <button
                type="button"
                onClick={() => setDeleteConfirmOpen(false)}
                className="btn-secondary"
                data-testid="sidebar-delete-task-cancel-btn"
                disabled={deleteLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleConfirmDeleteTask();
                }}
                className="btn-primary disabled:opacity-50"
                data-testid="sidebar-delete-task-confirm-btn"
                disabled={deleteLoading}
              >
                {deleteLoading ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteLinkConfirm && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close delete link confirmation"
            onClick={() => setDeleteLinkConfirm(null)}
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-link-confirm-title"
            className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col"
            data-testid="sidebar-delete-link-dialog"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border shrink-0">
              <h2 id="delete-link-confirm-title" className="text-lg font-semibold text-theme-text">
                Remove link
              </h2>
              <CloseButton
                onClick={() => setDeleteLinkConfirm(null)}
                ariaLabel="Close delete link confirmation"
              />
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-theme-text">
                Are you sure you want to delete the{" "}
                {deleteLinkConfirm.type === "blocks"
                  ? "Blocked on"
                  : deleteLinkConfirm.type === "parent-child"
                    ? "Parent"
                    : "Related"}{" "}
                link to {deleteLinkConfirm.taskName}?
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
              <button
                type="button"
                onClick={() => setDeleteLinkConfirm(null)}
                className="btn-secondary"
                data-testid="sidebar-delete-link-cancel-btn"
                disabled={removeLinkRemovingId !== null}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { targetId } = deleteLinkConfirm;
                  setRemoveLinkRemovingId(targetId);
                  try {
                    await dispatch(
                      removeTaskDependency({
                        projectId,
                        taskId: selectedTask,
                        parentTaskId: targetId,
                      })
                    ).unwrap();
                    setDeleteLinkConfirm(null);
                  } finally {
                    setRemoveLinkRemovingId(null);
                  }
                }}
                className="btn-primary disabled:opacity-50"
                data-testid="sidebar-delete-link-confirm-btn"
                disabled={removeLinkRemovingId !== null}
              >
                {removeLinkRemovingId ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}

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
              const taskContext = task
                ? {
                    id: task.id,
                    title: task.title,
                    description: task.description ?? "",
                    status: task.status,
                    kanbanColumn: task.kanbanColumn,
                  }
                : undefined;
              await api.chat.send(
                projectId,
                message,
                `execute:${selectedTask}`,
                undefined,
                undefined,
                taskContext
              );
            }}
          />
        )}

        <div className="px-4 pt-2 pb-4">
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
                <TaskPriorityDropdown
                  projectId={projectId}
                  taskId={selectedTask}
                  isDoneTask={isDoneTask}
                />
                <span
                  className="inline-flex items-center gap-1.5 text-theme-muted/80"
                  data-testid="task-complexity"
                  aria-label={displayLabel ? `Complexity: ${displayLabel}` : "Complexity: not set"}
                  title={
                    typeof task.complexity === "number" &&
                    task.complexity >= TASK_COMPLEXITY_MIN &&
                    task.complexity <= TASK_COMPLEXITY_MAX
                      ? `Score: ${task.complexity}/10`
                      : undefined
                  }
                >
                  <ComplexityIcon complexity={task.complexity} size="sm" />
                  {displayLabel ?? "—"}
                </span>
                {isDoneTask &&
                  (() => {
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
                <div className="mb-3 text-xs text-theme-error-text" data-testid="task-block-reason">
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
          <div className="p-4" data-section="view-plan-deps-addlink">
            {/* Links: Plan first, then blocked/parent/related */}
            {(() => {
              const plan = task.epicId && onNavigateToPlan ? planByEpicId[task.epicId] : null;
              const planTitle = plan ? getEpicTitleFromPlan(plan) : null;

              const nonEpicDeps = (task.dependencies ?? []).filter(
                (d) => d.targetId && d.type !== "discovered-from" && d.targetId !== task.epicId
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
              const TYPE_LABEL_SHORT: Record<string, string> = {
                blocks: "Blocked on",
                "parent-child": "Parent",
                related: "Related",
              };
              const sorted = [...nonEpicDeps].sort(
                (a, b) => (TYPE_ORDER[a.type] ?? 3) - (TYPE_ORDER[b.type] ?? 3)
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
                        className="inline-flex items-center gap-1.5 text-left text-brand-600 hover:text-brand-500 transition-colors"
                        title={`View plan: ${planTitle}`}
                        data-testid="sidebar-view-plan-btn"
                      >
                        <span className="text-theme-muted shrink-0">Plan:</span>
                        <span className="truncate max-w-[200px] hover:underline" title={planTitle!}>
                          {planTitle}
                        </span>
                      </button>
                    )}
                    {sorted.map((d) => {
                      const depTask = d.targetId ? taskById[d.targetId] : undefined;
                      const label = depTask?.title ?? d.targetId ?? "";
                      const col = depTask?.kanbanColumn ?? "backlog";
                      const typeLabel = TYPE_LABEL[d.type] ?? "Related:";
                      const removing = removeLinkRemovingId === d.targetId;
                      return (
                        <div
                          key={d.targetId}
                          className="inline-flex items-center gap-1.5 w-full group"
                        >
                          <button
                            type="button"
                            onClick={() => onSelectTask(d.targetId!)}
                            className="flex-1 min-w-0 inline-flex items-center gap-1.5 text-left text-brand-600 hover:text-brand-500 transition-colors"
                          >
                            <TaskStatusBadge column={col} size="xs" title={COLUMN_LABELS[col]} />
                            <span className="text-theme-muted shrink-0">{typeLabel}</span>
                            <span className="truncate max-w-[200px] hover:underline" title={label}>
                              {label}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteLinkConfirm({
                                targetId: d.targetId!,
                                type: d.type ?? "related",
                                taskName: label,
                              });
                            }}
                            disabled={removing}
                            className="shrink-0 p-0.5 rounded text-theme-muted hover:text-theme-error-text hover:bg-theme-error-bg transition-colors disabled:opacity-50"
                            aria-label={`Remove ${TYPE_LABEL_SHORT[d.type] ?? "Related"} link to ${label}`}
                            data-testid={`sidebar-remove-link-btn-${d.targetId}`}
                          >
                            <svg
                              className="w-3.5 h-3.5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          </button>
                        </div>
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
                tasks={allTasks}
                excludeIds={
                  new Set([
                    selectedTask,
                    ...(task.dependencies ?? []).filter((d) => d.targetId).map((d) => d.targetId!),
                  ])
                }
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
          title="Execution diagnostics"
          expanded={diagnosticsSectionExpanded}
          onToggle={() => setDiagnosticsSectionExpanded((prev) => !prev)}
          expandAriaLabel="Expand Execution diagnostics"
          collapseAriaLabel="Collapse Execution diagnostics"
          contentId="execution-diagnostics-content"
          headerId="execution-diagnostics-header"
        >
          <div
            className="rounded-lg border border-theme-border bg-theme-surface p-4"
            data-testid="execution-diagnostics-section"
          >
            {diagnosticsLoading && !diagnostics ? (
              <div className="text-xs text-theme-muted">Loading execution diagnostics...</div>
            ) : diagnostics &&
              (diagnostics.latestSummary ||
                diagnostics.attempts.length > 0 ||
                diagnostics.timeline.length > 0) ? (
              <div className="space-y-3">
                <div className="space-y-1 text-xs">
                  {task?.blockReason && (
                    <div
                      className="font-medium text-theme-error-text"
                      data-testid="execution-diagnostics-block-reason"
                    >
                      Failures: {task.blockReason}
                    </div>
                  )}
                  {diagnostics.latestSummary && (
                    <div data-testid="execution-diagnostics-latest-summary">
                      <span className="text-theme-muted">Latest summary:</span>{" "}
                      <span className="text-theme-text">{diagnostics.latestSummary}</span>
                    </div>
                  )}
                  {earlierFailureSummaries.length > 0 && (
                    <div data-testid="execution-diagnostics-earlier-failures">
                      <span className="text-theme-muted">Earlier failures:</span>{" "}
                      <span className="text-theme-text">{earlierFailureSummaries.join("; ")}</span>
                    </div>
                  )}
                  {diagnostics.latestNextAction && (
                    <div data-testid="execution-diagnostics-next-action">
                      <span className="text-theme-muted">Next action:</span>{" "}
                      <span className="text-theme-text">{diagnostics.latestNextAction}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-theme-muted">Attempts:</span>{" "}
                    <span className="text-theme-text">{diagnostics.cumulativeAttempts}</span>
                  </div>
                </div>

                <div>
                  <div className="text-xs font-medium text-theme-text">Attempt history</div>
                  <div className="mt-2 space-y-2">
                    {diagnostics.attempts.map((attempt) => (
                      <div
                        key={attempt.attempt}
                        className="rounded-md border border-theme-border-subtle bg-theme-code-bg px-3 py-2 text-xs"
                        data-testid={`execution-attempt-${attempt.attempt}`}
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium text-theme-text">
                            Attempt {attempt.attempt}
                          </span>
                          <span className="text-theme-muted">
                            {EXECUTION_PHASE_LABELS[attempt.finalPhase]} ·{" "}
                            {EXECUTION_OUTCOME_LABELS[attempt.finalOutcome]}
                          </span>
                        </div>
                        {(attempt.codingModel || attempt.reviewModel) && (
                          <div className="mt-1 text-theme-muted">
                            {attempt.codingModel && `Coder: ${attempt.codingModel}`}
                            {attempt.codingModel && attempt.reviewModel && " · "}
                            {attempt.reviewModel && `Reviewer: ${attempt.reviewModel}`}
                          </div>
                        )}
                        {attempt.mergeStage && (
                          <div className="mt-1 text-theme-muted">
                            Merge stage: {attempt.mergeStage}
                          </div>
                        )}
                        {(attempt.conflictedFiles?.length ?? 0) > 0 && (
                          <div className="mt-1 text-theme-muted">
                            Conflicts: {attempt.conflictedFiles?.join(", ")}
                          </div>
                        )}
                        <div className="mt-1 text-theme-text">{attempt.finalSummary}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-theme-muted">No execution diagnostics yet.</div>
            )}
          </div>
        </CollapsibleSection>

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
              <div className="relative flex flex-col min-h-0 flex-1">
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
                  <>
                    <VirtualizedAgentOutput
                      content={liveOutputContent}
                      mode={completionState ? "markdown" : "stream"}
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
                  </>
                )}
                {completionState && (
                  <div className="px-4 pb-4 pt-3 mt-0">
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

export const TaskDetailSidebar = React.memo(TaskDetailSidebarInner, areTaskDetailSidebarPropsEqual);
