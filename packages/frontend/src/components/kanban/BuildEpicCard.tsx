import { useState } from "react";
import type { Task } from "@opensprint/shared";
import { TaskStatusBadge, COLUMN_LABELS } from "./TaskStatusBadge";

const VISIBLE_SUBTASKS = 3;

export interface BuildEpicCardProps {
  epicId: string;
  epicTitle: string;
  tasks: Task[];
  onTaskSelect: (taskId: string) => void;
  onUnblock?: (taskId: string) => void;
}

export function BuildEpicCard({ epicId, epicTitle, tasks, onTaskSelect, onUnblock }: BuildEpicCardProps) {
  const [expanded, setExpanded] = useState(false);
  const doneCount = tasks.filter((t) => t.kanbanColumn === "done").length;
  const totalCount = tasks.length;
  const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;
  const hasMore = tasks.length > VISIBLE_SUBTASKS;
  const visibleTasks = expanded ? tasks : tasks.slice(0, VISIBLE_SUBTASKS);
  const hiddenCount = tasks.length - VISIBLE_SUBTASKS;

  return (
    <div
      className="rounded-xl bg-white shadow-sm ring-1 ring-gray-200/80 overflow-hidden"
      data-testid={`epic-card-${epicId || "other"}`}
    >
      {/* Epic header with progress */}
      <div className="px-4 pt-4 pb-3">
        <h3 className="font-semibold text-gray-900 text-base truncate mb-2">{epicTitle}</h3>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-gray-500">Progress</span>
          <span className="text-xs font-semibold text-gray-700">
            {doneCount}/{totalCount}
            {totalCount > 0 && (
              <span className="ml-1 text-gray-500 font-normal">({Math.round(progress)}%)</span>
            )}
          </span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
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

      {/* Nested subtasks with names and statuses */}
      {tasks.length > 0 && (
        <div className="border-t border-gray-100">
          <ul className="divide-y divide-gray-50">
            {visibleTasks.map((task) => (
              <li key={task.id} data-testid={task.kanbanColumn === "blocked" ? "task-blocked" : undefined}>
                <div className="flex items-center gap-2 px-4 py-2.5 group">
                  <button
                    type="button"
                    onClick={() => onTaskSelect(task.id)}
                    className="flex-1 flex items-center gap-3 text-left hover:bg-brand-50/50 transition-colors text-sm min-w-0"
                  >
                    <span
                      className={`shrink-0 w-2 h-2 rounded-full ${
                        task.kanbanColumn === "done"
                          ? "bg-emerald-500"
                          : task.kanbanColumn === "blocked"
                            ? "bg-red-500"
                            : task.kanbanColumn === "in_progress" || task.kanbanColumn === "in_review"
                              ? "bg-blue-500"
                              : "bg-gray-300"
                      }`}
                    />
                    <span className="flex-1 min-w-0 truncate font-medium text-gray-900" title={task.title}>
                      {task.title}
                    </span>
                    <TaskStatusBadge column={task.kanbanColumn} size="xs" title={COLUMN_LABELS[task.kanbanColumn]} />
                    <span className="text-xs text-gray-500 shrink-0">{COLUMN_LABELS[task.kanbanColumn]}</span>
                  </button>
                  {task.kanbanColumn === "blocked" && onUnblock && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnblock(task.id);
                      }}
                      className="shrink-0 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded transition-colors"
                    >
                      Unblock
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {hasMore && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full px-4 py-2.5 text-xs font-medium text-brand-600 hover:text-brand-700 hover:bg-brand-50/50 transition-colors border-t border-gray-50"
            >
              +{hiddenCount} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
