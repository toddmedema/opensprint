import React from "react";
import type { Task } from "@opensprint/shared";
import {
  complexityToDisplay,
  isAgentAssignee,
  TASK_COMPLEXITY_MIN,
  TASK_COMPLEXITY_MAX,
} from "@opensprint/shared";
import { ComplexityIcon } from "../ComplexityIcon";
import { TaskPriorityDropdown } from "./TaskPriorityDropdown";
import { AssigneeSelector } from "./AssigneeSelector";
import { TaskStatusBadge, COLUMN_LABELS } from "../kanban";
import { formatUptime, formatTaskDuration } from "../../lib/formatting";

export interface TaskDetailMetadataProps {
  projectId: string;
  selectedTask: string;
  task: Task | null;
  taskDetailLoading: boolean;
  taskDetailError: string | null;
  taskIdToStartedAt: Record<string, string>;
  roleLabel: string | null;
  isDoneTask: boolean;
  isBlockedTask: boolean;
  isInProgressTask?: boolean;
  enableHumanTeammates?: boolean;
  teamMembers?: Array<{ id: string; name: string }>;
}

export function TaskDetailMetadata({
  projectId,
  selectedTask,
  task,
  taskDetailLoading,
  taskDetailError,
  taskIdToStartedAt,
  roleLabel,
  isDoneTask,
  isBlockedTask,
  isInProgressTask = false,
  enableHumanTeammates = false,
  teamMembers = [],
}: TaskDetailMetadataProps) {
  const displayLabel = task ? complexityToDisplay(task.complexity) : null;
  const mergeStateLabel =
    task?.mergeGateState === "blocked_on_baseline"
      ? "Blocked on main"
      : task?.mergeGateState === "candidate_fix_needed"
        ? "Candidate fix needed"
        : task?.mergeGateState === "environment_repair_needed"
          ? "Environment repair needed"
          : task?.mergeGateState === "merging"
            ? "Merging"
            : task?.mergeGateState === "validating"
              ? "Validating"
              : task?.mergeWaitingOnMain
                ? "Blocked on main"
                : null;

  return (
    <div className="px-4 pt-2 pb-0">
      {task && (
        <>
          <div
            className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 mb-1 text-xs text-theme-muted"
            data-testid="task-detail-priority-state-row"
          >
            <span className="inline-flex items-center gap-1.5 flex-wrap">
              <TaskStatusBadge
                column={task.kanbanColumn}
                size="xs"
                title={COLUMN_LABELS[task.kanbanColumn]}
              />
              <span>{COLUMN_LABELS[task.kanbanColumn]}</span>
              {task.kanbanColumn === "waiting_to_merge" && mergeStateLabel && (
                <span
                  className="text-theme-muted"
                  title={mergeStateLabel}
                  data-testid={
                    mergeStateLabel === "Blocked on main"
                      ? "task-detail-merge-waiting-on-main-hint"
                      : "task-detail-merge-state-hint"
                  }
                >
                  · {mergeStateLabel}
                </span>
              )}
            </span>
            <TaskPriorityDropdown
              projectId={projectId}
              taskId={selectedTask}
              isDoneTask={isDoneTask}
            />
            {displayLabel != null && (
              <span
                className="inline-flex items-center gap-1.5"
                data-testid="task-complexity"
                aria-label={`Complexity: ${displayLabel}`}
                title={
                  typeof task.complexity === "number" &&
                  task.complexity >= TASK_COMPLEXITY_MIN &&
                  task.complexity <= TASK_COMPLEXITY_MAX
                    ? `Score: ${task.complexity}/10`
                    : undefined
                }
              >
                <ComplexityIcon complexity={task.complexity} size="sm" />
                {displayLabel}
              </span>
            )}
            {enableHumanTeammates ? (
              <AssigneeSelector
                projectId={projectId}
                taskId={selectedTask}
                currentAssignee={task.assignee ?? null}
                teamMembers={teamMembers}
                readOnly={isDoneTask || isInProgressTask}
                isAgentAssignee={!!task.assignee && isAgentAssignee(task.assignee)}
                matchTaskNameTypography
              />
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-theme-muted">
                {task.assignee?.trim() ? task.assignee : "—"}
              </span>
            )}
            {isDoneTask &&
              (() => {
                const duration = formatTaskDuration(task.startedAt, task.completedAt);
                return duration ? (
                  <span
                    className="inline-flex items-center gap-1.5 text-theme-muted"
                    data-testid="task-duration"
                    aria-label={`Took ${duration}`}
                  >
                    Took {duration}
                  </span>
                ) : null;
              })()}
          </div>
          {isBlockedTask && task.blockReason && (
            <div className="mb-3 text-xs text-theme-error-text" data-testid="task-block-reason">
              {task.blockReason}
            </div>
          )}
          {task.kanbanColumn === "waiting_to_merge" && task.lastExecutionSummary && (
            <div
              className="mb-3 text-xs text-theme-muted"
              data-testid="task-detail-merge-summary"
              title={task.lastExecutionSummary}
            >
              {task.lastExecutionSummary}
            </div>
          )}
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
  );
}
