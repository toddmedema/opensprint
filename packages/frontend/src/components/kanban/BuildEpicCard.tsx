import { useState, useMemo, memo, useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Task } from "@opensprint/shared";
import { shallowEqual } from "react-redux";
import { useAppSelector } from "../../store";
import { selectTaskById } from "../../store/slices/executeSlice";
import { PriorityIcon } from "../PriorityIcon";
import { ComplexityIcon } from "../ComplexityIcon";
import { TaskStatusBadge, COLUMN_LABELS } from "./TaskStatusBadge";
import { formatUptime } from "../../lib/formatting";

const VISIBLE_SUBTASKS = 3;
/** Virtualize when expanded and task count exceeds this (avoids virtualization for small lists; improves testability in jsdom). */
const VIRTUALIZE_THRESHOLD = 10;
const TASK_ROW_HEIGHT = 44;
const EPIC_TASK_LIST_MAX_HEIGHT = 320;

/** Task row: subscribes to single task for granular re-renders when task.updated fires. When task prop is provided (e.g. tests), use it instead of Redux. */
const EpicTaskRow = memo(function EpicTaskRow({
  taskId,
  task: taskProp,
  elapsed,
  onTaskSelect,
  onUnblock,
}: {
  taskId: string;
  task?: Task;
  elapsed: string | null;
  onTaskSelect: (taskId: string) => void;
  onUnblock?: (taskId: string) => void;
}) {
  const taskFromRedux = useAppSelector((s) => selectTaskById(s, taskId), shallowEqual);
  const task = taskProp ?? taskFromRedux;
  if (!task) return null;

  const rightContent = [task.assignee, elapsed].filter(Boolean).join(" · ");
  return (
    <li data-testid={task.kanbanColumn === "blocked" ? "task-blocked" : undefined}>
      <div className="flex items-center gap-2 px-4 py-2.5 group">
        <button
          type="button"
          onClick={() => onTaskSelect(task.id)}
          className="flex-1 flex items-center gap-3 text-left hover:bg-theme-info-bg/50 transition-colors text-sm min-w-0"
        >
          <TaskStatusBadge
            column={task.kanbanColumn}
            size="xs"
            title={COLUMN_LABELS[task.kanbanColumn]}
          />
          <PriorityIcon priority={task.priority ?? 1} size="xs" />
          <ComplexityIcon complexity={task.complexity} size="xs" />
          <span className="flex-1 min-w-0 truncate font-medium text-theme-text" title={task.title}>
            {task.title}
          </span>
          {rightContent ? (
            <span
              className="text-xs text-theme-muted shrink-0 tabular-nums"
              data-testid="task-row-right"
            >
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
            Retry
          </button>
        )}
      </div>
    </li>
  );
});

import type { StatusFilter } from "../../lib/executeTaskFilter";
import { filterTasksByStatusAndSearch } from "../../lib/executeTaskFilter";
import type { Plan } from "@opensprint/shared";
import { sortEpicTasksByStatus } from "../../lib/executeTaskSort";
import { selectTasksForEpic } from "../../store/slices/executeSlice";

export interface BuildEpicCardProps {
  epicId: string;
  epicTitle: string;
  /** Status and search filter for task list. Default "all" and "" when tasks prop is provided. */
  statusFilter?: StatusFilter;
  searchQuery?: string;
  /** When provided (e.g. in tests), use this instead of Redux. Otherwise subscribe to tasks via selectTasksForEpic. */
  tasks?: Task[];
  /** Required when statusFilter is "planning" to determine parent plan status. */
  plans?: Plan[];
  /** When true, progress summary reflects filtered results; show indicator */
  filteringActive?: boolean;
  onTaskSelect: (taskId: string) => void;
  onUnblock?: (taskId: string) => void;
  /** Navigate to the plan associated with this epic */
  onViewPlan?: () => void;
  /** Map of task ID to startedAt for active tasks (elapsed time display) */
  taskIdToStartedAt?: Record<string, string>;
  /** When provided, scrolls the selected task into view when expanded. */
  selectedTaskId?: string | null;
}

export function BuildEpicCard({
  epicId,
  epicTitle,
  statusFilter = "all",
  searchQuery = "",
  tasks: tasksProp,
  plans,
  filteringActive = false,
  onTaskSelect,
  onUnblock,
  onViewPlan,
  taskIdToStartedAt = {},
  selectedTaskId,
}: BuildEpicCardProps) {
  const [expanded, setExpanded] = useState(false);
  const taskListRef = useRef<HTMLDivElement>(null);
  const tasksFromRedux = useAppSelector((s) => selectTasksForEpic(s, epicId), shallowEqual);
  const tasks = tasksProp ?? tasksFromRedux;
  const filteredTasks = useMemo(
    () => filterTasksByStatusAndSearch(tasks, statusFilter, searchQuery, plans),
    [tasks, statusFilter, searchQuery, plans]
  );
  const sortedTasks = useMemo(() => sortEpicTasksByStatus(filteredTasks), [filteredTasks]);
  const doneCount = sortedTasks.filter((t) => t.kanbanColumn === "done").length;
  const totalCount = sortedTasks.length;
  const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;
  const hasMore = sortedTasks.length > VISIBLE_SUBTASKS;
  const visibleTasks = expanded ? sortedTasks : sortedTasks.slice(0, VISIBLE_SUBTASKS);
  const hiddenCount = sortedTasks.length - VISIBLE_SUBTASKS;
  const allTasksDone = totalCount > 0 && sortedTasks.every((t) => t.kanbanColumn === "done");
  const useTaskProp = tasksProp != null;
  const useVirtualization = expanded && sortedTasks.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: sortedTasks.length,
    getScrollElement: () => taskListRef.current,
    estimateSize: () => TASK_ROW_HEIGHT,
    overscan: 3,
  });

  const selectedIndex =
    selectedTaskId != null ? sortedTasks.findIndex((t) => t.id === selectedTaskId) : -1;

  useEffect(() => {
    if (selectedTaskId && selectedIndex >= 0 && !expanded && selectedIndex >= VISIBLE_SUBTASKS) {
      setExpanded(true);
    }
  }, [selectedTaskId, selectedIndex, expanded]);

  useEffect(() => {
    if (expanded && selectedIndex >= 0 && useVirtualization) {
      virtualizer.scrollToIndex(selectedIndex, { align: "center", behavior: "smooth" });
    }
  }, [expanded, selectedIndex, useVirtualization, virtualizer]);

  return (
    <div
      className="rounded-xl bg-theme-surface shadow-sm ring-1 ring-theme-border overflow-hidden"
      data-testid={`epic-card-${epicId || "other"}`}
    >
      {/* Epic header with progress */}
      <div className="px-4 pt-4 pb-3">
        <h3 className="font-semibold text-theme-text text-base truncate mb-2 flex items-center gap-2">
          {allTasksDone && (
            <span
              className="shrink-0 inline-flex text-theme-success-muted"
              aria-label="All tasks completed"
              data-testid="epic-completed-checkmark"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </span>
          )}
          {onViewPlan ? (
            <button
              type="button"
              onClick={onViewPlan}
              className="truncate hover:text-brand-600 transition-colors text-left"
              title={`View plan: ${epicTitle}`}
            >
              {epicTitle}
            </button>
          ) : (
            <span className="truncate">{epicTitle}</span>
          )}
        </h3>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-theme-muted">Progress</span>
          <span className="text-xs font-semibold text-theme-text">
            {doneCount}/{totalCount}
            {totalCount > 0 && (
              <span className="ml-1 text-theme-muted font-normal">({Math.round(progress)}%)</span>
            )}
            {filteringActive && (
              <span className="ml-1.5 text-theme-muted font-normal" title="Filtered view">
                filtered
              </span>
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

      {/* Nested subtasks: each row subscribes to its task for granular re-renders (or uses task prop when provided) */}
      {sortedTasks.length > 0 && (
        <div className="border-t border-theme-border-subtle">
          {useVirtualization ? (
            <div
              ref={taskListRef}
              className="overflow-auto divide-y divide-theme-border-subtle"
              style={{ maxHeight: EPIC_TASK_LIST_MAX_HEIGHT }}
            >
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: "100%",
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const t = sortedTasks[virtualRow.index];
                  if (!t) return null;
                  return (
                    <div
                      key={t.id}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                      }}
                    >
                      <ul className="divide-y divide-theme-border-subtle">
                        <EpicTaskRow
                          taskId={t.id}
                          task={useTaskProp ? t : undefined}
                          elapsed={
                            taskIdToStartedAt[t.id] ? formatUptime(taskIdToStartedAt[t.id]) : null
                          }
                          onTaskSelect={onTaskSelect}
                          onUnblock={onUnblock}
                        />
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-theme-border-subtle">
              {visibleTasks.map((t) => (
                <EpicTaskRow
                  key={t.id}
                  taskId={t.id}
                  task={useTaskProp ? t : undefined}
                  elapsed={taskIdToStartedAt[t.id] ? formatUptime(taskIdToStartedAt[t.id]) : null}
                  onTaskSelect={onTaskSelect}
                  onUnblock={onUnblock}
                />
              ))}
            </ul>
          )}
          {hasMore && !expanded && hiddenCount > 0 && (
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
