import type { Task } from "@opensprint/shared";
import type { Plan } from "@opensprint/shared";
import {
  sortTasksForTimeline,
  getTimelineSection,
  TIMELINE_SECTION,
} from "../../lib/executeTaskSort";
import { getEpicTitleFromPlan } from "../../lib/planContentUtils";
import { formatUptime, formatTimestamp } from "../../lib/formatting";
import { TaskStatusBadge, COLUMN_LABELS } from "../kanban";
import { PriorityIcon } from "../PriorityIcon";
import { ComplexityIcon } from "../ComplexityIcon";

export interface TimelineListProps {
  tasks: Task[];
  plans: Plan[];
  onTaskSelect: (taskId: string) => void;
  onUnblock?: (taskId: string) => void;
  taskIdToStartedAt?: Record<string, string>;
}

const SECTION_LABELS: Record<string, string> = {
  [TIMELINE_SECTION.active]: "In Progress",
  [TIMELINE_SECTION.queue]: "In Line",
  [TIMELINE_SECTION.completed]: "Completed",
};

function TimelineRow({
  task,
  epicName,
  relativeTime,
  onTaskSelect,
  onUnblock,
}: {
  task: Task;
  epicName: string;
  relativeTime: string;
  onTaskSelect: (taskId: string) => void;
  onUnblock?: (taskId: string) => void;
}) {
  const isBlocked = task.kanbanColumn === "blocked";
  const assignee = task.assignee ?? "—";

  return (
    <li data-testid={`timeline-row-${task.id}`}>
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
          <span className="hidden md:inline text-xs text-theme-muted shrink-0 truncate max-w-[120px]">
            {epicName}
          </span>
          <span className="text-xs text-theme-muted shrink-0 tabular-nums">{assignee}</span>
          <span className="text-xs text-theme-muted shrink-0 tabular-nums">{relativeTime}</span>
        </button>
        {isBlocked && onUnblock && (
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

export function TimelineList({
  tasks,
  plans,
  onTaskSelect,
  onUnblock,
  taskIdToStartedAt = {},
}: TimelineListProps) {
  if (tasks.length === 0) {
    return null;
  }

  const epicIdToTitle = new Map<string, string>();
  plans.forEach((p) => {
    epicIdToTitle.set(p.metadata.epicId, getEpicTitleFromPlan(p));
  });

  const sorted = sortTasksForTimeline(tasks);
  const bySection = {
    [TIMELINE_SECTION.active]: sorted.filter(
      (t) => getTimelineSection(t.kanbanColumn) === TIMELINE_SECTION.active
    ),
    [TIMELINE_SECTION.queue]: sorted.filter(
      (t) => getTimelineSection(t.kanbanColumn) === TIMELINE_SECTION.queue
    ),
    [TIMELINE_SECTION.completed]: sorted.filter(
      (t) => getTimelineSection(t.kanbanColumn) === TIMELINE_SECTION.completed
    ),
  };

  const sections = [
    { key: TIMELINE_SECTION.active, tasks: bySection[TIMELINE_SECTION.active] },
    { key: TIMELINE_SECTION.queue, tasks: bySection[TIMELINE_SECTION.queue] },
    { key: TIMELINE_SECTION.completed, tasks: bySection[TIMELINE_SECTION.completed] },
  ];

  const getRelativeTime = (task: Task): string => {
    const isActive = task.kanbanColumn === "in_progress" || task.kanbanColumn === "in_review";
    if (isActive && taskIdToStartedAt[task.id]) {
      return formatUptime(taskIdToStartedAt[task.id]);
    }
    return formatTimestamp(task.updatedAt || task.createdAt || "");
  };

  return (
    <div data-testid="timeline-list">
      {sections.map(
        ({ key, tasks: sectionTasks }) =>
          sectionTasks.length > 0 && (
            <section key={key} data-testid={`timeline-section-${key}`}>
              <h3 className="text-xs font-semibold text-theme-muted tracking-wide uppercase px-4 pt-4 pb-2 border-b border-theme-border-subtle">
                {SECTION_LABELS[key]}
              </h3>
              <ul className="divide-y divide-theme-border-subtle">
                {sectionTasks.map((task) => (
                  <TimelineRow
                    key={task.id}
                    task={task}
                    epicName={task.epicId ? (epicIdToTitle.get(task.epicId) ?? task.epicId) : "—"}
                    relativeTime={getRelativeTime(task)}
                    onTaskSelect={onTaskSelect}
                    onUnblock={task.kanbanColumn === "blocked" ? onUnblock : undefined}
                  />
                ))}
              </ul>
            </section>
          )
      )}
    </div>
  );
}
