import { useState } from "react";
import type { Task } from "@opensprint/shared";
import { TaskStatusBadge, COLUMN_LABELS } from "./TaskStatusBadge";
import { formatUptime } from "../../lib/formatting";

const VISIBLE_SUBTASKS = 3;

/** Task row: status badge left, title center, assignee right. No duplicate indicators. */
function EpicTaskRow({
  task,
  elapsed,
  onTaskSelect,
  onUnblock,
}: {
  task: Task;
  elapsed: string | null;
  onTaskSelect: (taskId: string) => void;
  onUnblock?: (taskId: string) => void;
}) {
  const rightContent = [task.assignee, elapsed].filter(Boolean).join(" · ");
  return (
    <li data-testid={task.kanbanColumn === "blocked" ? "task-blocked" : undefined}>
      <div className="flex items-center gap-2 px-4 py-2.5 group">
        <button
          type="button"
          onClick={() => onTaskSelect(task.id)}
          className="flex-1 flex items-center gap-3 text-left hover:bg-theme-info-bg/50 transition-colors text-sm min-w-0"
        >
          {/* Status: exclusively on the left */}
          <TaskStatusBadge column={task.kanbanColumn} size="xs" title={COLUMN_LABELS[task.kanbanColumn]} />
          <span className="flex-1 min-w-0 truncate font-medium text-theme-text" title={task.title}>
            {task.title}
          </span>
          {/* Assignee/elapsed: exclusively on the right; nothing when unassigned and no elapsed */}
          {rightContent ? (
            <span className="text-xs text-theme-muted shrink-0 tabular-nums" data-testid="task-row-right">
              {rightContent}
            </span>
          ) : null}
        </button>
        {task.kanbanColumn === "blocked" && onUnblock && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onUnblock(task.id);
            }}
            className="shrink-0 text-xs font-medium text-theme-error-text hover:bg-theme-error-bg px-2 py-1 rounded transition-colors"
          >
            Unblock
          </button>
        )}
      </div>
    </li>
  );
}

export interface BuildEpicCardProps {
  epicId: string;
  epicTitle: string;
  tasks: Task[];
  onTaskSelect: (taskId: string) => void;
  onUnblock?: (taskId: string) => void;
  /** Map of task ID to startedAt for active tasks (elapsed time display) */
  taskIdToStartedAt?: Record<string, string>;
}

export function BuildEpicCard({
  epicId,
  epicTitle,
  tasks,
  onTaskSelect,
  onUnblock,
  taskIdToStartedAt = {},
}: BuildEpicCardProps) {
  const [expanded, setExpanded] = useState(false);
  const doneCount = tasks.filter((t) => t.kanbanColumn === "done").length;
  const totalCount = tasks.length;
  const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;
  const hasMore = tasks.length > VISIBLE_SUBTASKS;
  const visibleTasks = expanded ? tasks : tasks.slice(0, VISIBLE_SUBTASKS);
  const hiddenCount = tasks.length - VISIBLE_SUBTASKS;

  return (
    <div
      className="rounded-xl bg-theme-surface shadow-sm ring-1 ring-theme-border overflow-hidden"
      data-testid={`epic-card-${epicId || "other"}`}
    >
      {/* Epic header with progress */}
      <div className="px-4 pt-4 pb-3">
        <h3 className="font-semibold text-theme-text text-base truncate mb-2">{epicTitle}</h3>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-theme-muted">Progress</span>
          <span className="text-xs font-semibold text-theme-text">
            {doneCount}/{totalCount}
            {totalCount > 0 && (
              <span className="ml-1 text-theme-muted font-normal">({Math.round(progress)}%)</span>
            )}
          </span>
        </div>
        <div className="w-full bg-theme-surface-muted rounded-full h-2 overflow-hidden">
          <div
            className="h-2 rounded-full transition-all duration-500 ease-out bg-gradient-to-r from-brand-500 to-brand-600"
            style={{ width: `${progress}%` }}
            role="progressbar"
            aria-valuenow={doneCount}
            aria-valuemin={0}
            aria-valuemax={totalCount}
            aria-label={`${doneCount} of ${totalCount} tasks done`}
          />
        </div>
      </div>

      {/* Nested subtasks: status left, title center, assignee right (no duplicates) */}
      {tasks.length > 0 && (
        <div className="border-t border-theme-border-subtle">
          <ul className="divide-y divide-theme-border-subtle">
            {visibleTasks.map((task) => (
              <EpicTaskRow
                key={task.id}
                task={task}
                elapsed={taskIdToStartedAt[task.id] ? formatUptime(taskIdToStartedAt[task.id]) : null}
                onTaskSelect={onTaskSelect}
                onUnblock={task.kanbanColumn === "blocked" ? onUnblock : undefined}
              />
            ))}
          </ul>
          {hasMore && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full px-4 py-2.5 text-xs font-medium text-brand-600 hover:text-brand-700 hover:bg-theme-info-bg/50 transition-colors border-t border-theme-border-subtle"
            >
              +{hiddenCount} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
