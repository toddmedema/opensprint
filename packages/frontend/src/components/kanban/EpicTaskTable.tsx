import type { Task } from "@opensprint/shared";
import { TaskStatusBadge, COLUMN_LABELS } from "./TaskStatusBadge";
import { PRIORITY_LABELS } from "@opensprint/shared";
import type { Swimlane } from "./KanbanBoard";

export interface EpicTaskTableProps {
  swimlanes: Swimlane[];
  onTaskSelect: (taskId: string) => void;
}

export function EpicTaskTable({ swimlanes, onTaskSelect }: EpicTaskTableProps) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
      {/* Single header row */}
      <div
        className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-3 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase tracking-wide"
        role="row"
      >
        <div role="columnheader">Task</div>
        <div role="columnheader" className="text-right">
          Status
        </div>
        <div role="columnheader" className="text-right">
          Priority
        </div>
        <div role="columnheader" className="text-right">
          Assignee
        </div>
      </div>

      {/* Epic sections with sub-tasks */}
      <div className="divide-y divide-gray-100">
        {swimlanes.map((lane) => {
          const doneCount = lane.tasks.filter((t) => t.kanbanColumn === "done").length;
          const totalCount = lane.tasks.length;
          return (
            <div key={lane.epicId || "other"} className="bg-white">
              {/* Epic header row */}
              <div
                className="px-4 py-2.5 bg-gray-50/80 border-b border-gray-100 font-medium text-gray-900 text-sm"
                role="rowheader"
              >
                {lane.epicTitle}
                <span className="ml-2 text-xs font-normal text-gray-500">
                  ({doneCount}/{totalCount} done)
                </span>
              </div>
              {/* Sub-task rows */}
              <div className="divide-y divide-gray-50">
                {lane.tasks.map((task) => (
                  <EpicTaskRow
                    key={task.id}
                    task={task}
                    onClick={() => onTaskSelect(task.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EpicTaskRow({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-2.5 items-center hover:bg-brand-50/50 cursor-pointer transition-colors text-sm"
    >
      <div className="min-w-0">
        <span className="font-medium text-gray-900 truncate block" title={task.title}>
          {task.title}
        </span>
        <span className="text-xs text-gray-400 font-mono truncate block" title={task.id}>
          {task.id}
        </span>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <TaskStatusBadge column={task.kanbanColumn} size="xs" title={COLUMN_LABELS[task.kanbanColumn]} />
        <span className="text-xs text-gray-500">{COLUMN_LABELS[task.kanbanColumn]}</span>
      </div>
      <div className="text-right text-xs text-gray-500">
        {PRIORITY_LABELS[task.priority] ?? "Medium"}
      </div>
      <div className="text-right text-xs text-brand-600 truncate max-w-[8rem]" title={task.assignee ?? undefined}>
        {task.assignee ?? "—"}
      </div>
    </div>
  );
}
