import type { KanbanColumn, Task } from "@opensprint/shared";
import { KANBAN_COLUMNS } from "@opensprint/shared";
import { TaskStatusBadge, COLUMN_LABELS } from "./TaskStatusBadge";
import { KanbanCard } from "./KanbanCard";

export interface Swimlane {
  epicId: string;
  epicTitle: string;
  tasks: Task[];
}

export interface KanbanBoardProps {
  swimlanes: Swimlane[];
  onTaskSelect: (taskId: string) => void;
}

export function KanbanBoard({ swimlanes, onTaskSelect }: KanbanBoardProps) {
  return (
    <div className="space-y-6">
      {swimlanes.map((lane) => {
        const laneTasksByCol = KANBAN_COLUMNS.reduce(
          (acc, col) => {
            acc[col] = lane.tasks.filter((t) => t.kanbanColumn === col);
            return acc;
          },
          {} as Record<KanbanColumn, Task[]>,
        );
        return (
          <div key={lane.epicId || "other"} className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-700">{lane.epicTitle}</h3>
              <p className="text-xs text-gray-500">
                {lane.tasks.filter((t) => t.kanbanColumn === "done").length}/{lane.tasks.length} done
              </p>
            </div>
            <div className="flex gap-4 p-4 overflow-x-auto min-w-0" data-testid="kanban-columns-scroll">
              {KANBAN_COLUMNS.map((col) => (
                <div key={col} className="kanban-column flex-shrink-0 w-56">
                  <div className="flex items-center gap-2 mb-2">
                    <TaskStatusBadge column={col} size="sm" title={COLUMN_LABELS[col]} />
                    <span className="text-xs font-semibold text-gray-600">{COLUMN_LABELS[col]}</span>
                    <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">
                      {laneTasksByCol[col].length}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {laneTasksByCol[col].map((task) => (
                      <KanbanCard
                        key={task.id}
                        task={task}
                        onClick={() => onTaskSelect(task.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
