import type { Plan, Task } from "@opensprint/shared";
import { COLUMN_LABELS } from "./kanban/TaskStatusBadge";

export interface EpicCardProps {
  plan: Plan;
  tasks: Task[];
  shippingPlanId: string | null;
  reshippingPlanId: string | null;
  onSelect: () => void;
  onShip: () => void;
  onReship: () => void;
}

const statusColors: Record<string, string> = {
  planning: "bg-yellow-50 text-yellow-700",
  building: "bg-blue-50 text-blue-700",
  done: "bg-green-50 text-green-700",
};

export function EpicCard({
  plan,
  tasks,
  shippingPlanId,
  reshippingPlanId,
  onSelect,
  onShip,
  onReship,
}: EpicCardProps) {
  const progress = plan.taskCount > 0 ? (plan.doneTaskCount / plan.taskCount) * 100 : 0;

  return (
    <div
      className="card p-3 cursor-pointer hover:shadow-md transition-shadow"
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="font-semibold text-gray-900 text-sm truncate flex-1 min-w-0">
          {plan.metadata.planId.replace(/-/g, " ")}
        </h3>
        <span
          className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
            statusColors[plan.status] ?? "bg-gray-100 text-gray-600"
          }`}
        >
          {plan.status}
        </span>
      </div>

      {/* Progress bar */}
      <div className="mb-2">
        <div className="w-full bg-gray-100 rounded-full h-1.5">
          <div
            className="bg-brand-600 h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
            role="progressbar"
            aria-valuenow={plan.doneTaskCount}
            aria-valuemin={0}
            aria-valuemax={plan.taskCount}
            aria-label={`${plan.doneTaskCount} of ${plan.taskCount} tasks done`}
          />
        </div>
        <p className="text-xs text-gray-500 mt-0.5">
          {plan.doneTaskCount}/{plan.taskCount} done
          {plan.doneTaskCount > 0 && plan.doneTaskCount < plan.taskCount && (
            <span className="ml-1">· {plan.metadata.complexity}</span>
          )}
        </p>
      </div>

      {/* Nested subtasks */}
      {tasks.length > 0 && (
        <ul className="space-y-1 mb-2 max-h-20 overflow-y-auto">
          {tasks.map((task) => (
            <li
              key={task.id}
              className="flex items-center gap-1.5 text-xs text-gray-600"
              title={`${task.title} — ${COLUMN_LABELS[task.kanbanColumn]}`}
            >
              <span
                className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                  task.kanbanColumn === "done"
                    ? "bg-green-500"
                    : task.kanbanColumn === "in_progress" || task.kanbanColumn === "in_review"
                      ? "bg-blue-500"
                      : "bg-gray-300"
                }`}
              />
              <span className="truncate flex-1 min-w-0">{task.title}</span>
            </li>
          ))}
        </ul>
      )}

      {plan.status === "planning" && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onShip();
          }}
          disabled={!!shippingPlanId}
          className="btn-primary text-xs w-full py-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {shippingPlanId === plan.metadata.planId ? "Building…" : "Build It!"}
        </button>
      )}
      {plan.status === "done" &&
        plan.metadata.shippedAt &&
        plan.lastModified &&
        plan.lastModified > plan.metadata.shippedAt && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReship();
            }}
            disabled={!!reshippingPlanId}
            className="btn-secondary text-xs w-full py-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {reshippingPlanId === plan.metadata.planId ? "Rebuilding…" : "Rebuild"}
          </button>
        )}
    </div>
  );
}
