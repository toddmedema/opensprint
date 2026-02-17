import type { KanbanColumn } from "@opensprint/shared";

export const COLUMN_LABELS: Record<KanbanColumn, string> = {
  planning: "Planning",
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
};

const columnColors: Record<KanbanColumn, string> = {
  planning: "bg-gray-400",
  backlog: "bg-yellow-400",
  ready: "bg-blue-400",
  in_progress: "bg-purple-400",
  in_review: "bg-orange-400",
  done: "bg-green-400",
  blocked: "bg-red-500",
};

export interface TaskStatusBadgeProps {
  column: KanbanColumn;
  size?: "sm" | "xs";
  title?: string;
}

export function TaskStatusBadge({ column, size = "sm", title }: TaskStatusBadgeProps) {
  const dim = size === "sm" ? "w-2.5 h-2.5" : "w-2 h-2";
  const label = title ?? COLUMN_LABELS[column];

  if (column === "done") {
    return (
      <span className="inline-flex" title={label}>
        <svg
          className={`${dim} shrink-0 text-green-500`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  if (column === "blocked") {
    return (
      <span className="inline-flex" title={label}>
        <svg
          className={`${dim} shrink-0 text-red-500`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </span>
    );
  }
  return <span className={`${dim} rounded-full shrink-0 ${columnColors[column]}`} title={label} />;
}
