import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
import type { StatusFilter } from "../../lib/executeTaskFilter";

const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 52;
const VIRTUALIZE_THRESHOLD = 25;

export interface TimelineListProps {
  tasks: Task[];
  plans: Plan[];
  onTaskSelect: (taskId: string) => void;
  onUnblock?: (taskId: string) => void;
  taskIdToStartedAt?: Record<string, string>;
  /** When "all", a Blocked section is shown at top when blocked tasks exist. */
  statusFilter?: StatusFilter;
  /** Optional scroll container ref for virtualization. When not provided, renders non-virtualized (for tests). */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  /** When provided, scrolls the selected task into view. */
  selectedTaskId?: string | null;
}

const SECTION_LABELS: Record<string, string> = {
  [TIMELINE_SECTION.active]: "In Progress",
  [TIMELINE_SECTION.queue]: "Up Next",
  [TIMELINE_SECTION.completed]: "Completed",
  blocked: "Blocked",
  ready: "Ready",
  in_line: "Up Next",
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

type TimelineItem =
  | { type: "header"; key: string; label: string }
  | {
      type: "row";
      task: Task;
      epicName: string;
      relativeTime: string;
      onUnblock?: (taskId: string) => void;
    };

export function TimelineList({
  tasks,
  plans,
  onTaskSelect,
  onUnblock,
  taskIdToStartedAt = {},
  statusFilter = "all",
  scrollRef,
  selectedTaskId,
}: TimelineListProps) {
  const epicIdToTitle = useMemo(() => {
    const m = new Map<string, string>();
    plans.forEach((p) => m.set(p.metadata.epicId, getEpicTitleFromPlan(p)));
    return m;
  }, [plans]);

  const sorted = useMemo(() => sortTasksForTimeline(tasks), [tasks]);
  const blockedTasks =
    statusFilter === "all" ? sorted.filter((t) => t.kanbanColumn === "blocked") : [];
  const showBlockedSection = blockedTasks.length > 0;

  const bySection = useMemo(
    () => ({
      [TIMELINE_SECTION.active]: sorted.filter(
        (t) => getTimelineSection(t.kanbanColumn) === TIMELINE_SECTION.active
      ),
      [TIMELINE_SECTION.completed]: sorted.filter(
        (t) => getTimelineSection(t.kanbanColumn) === TIMELINE_SECTION.completed
      ),
      blocked: blockedTasks,
      ready: sorted.filter((t) => t.kanbanColumn === "ready"),
      in_line: sorted.filter((t) => t.kanbanColumn === "backlog" || t.kanbanColumn === "planning"),
    }),
    [sorted, blockedTasks]
  );

  const sections = useMemo(
    () => [
      ...(showBlockedSection ? [{ key: "blocked" as const, tasks: bySection.blocked }] : []),
      { key: TIMELINE_SECTION.active, tasks: bySection[TIMELINE_SECTION.active] },
      { key: "ready" as const, tasks: bySection.ready },
      { key: "in_line" as const, tasks: bySection.in_line },
      { key: TIMELINE_SECTION.completed, tasks: bySection[TIMELINE_SECTION.completed] },
    ],
    [showBlockedSection, bySection]
  );

  const getRelativeTime = (task: Task): string => {
    const isActive = task.kanbanColumn === "in_progress" || task.kanbanColumn === "in_review";
    if (isActive && taskIdToStartedAt[task.id]) {
      return formatUptime(taskIdToStartedAt[task.id]);
    }
    return formatTimestamp(task.updatedAt || task.createdAt || "");
  };

  const items = useMemo((): TimelineItem[] => {
    const result: TimelineItem[] = [];
    for (const { key, tasks: sectionTasks } of sections) {
      if (sectionTasks.length === 0) continue;
      result.push({ type: "header", key, label: SECTION_LABELS[key] });
      for (const task of sectionTasks) {
        result.push({
          type: "row",
          task,
          epicName: task.epicId ? (epicIdToTitle.get(task.epicId) ?? task.epicId) : "",
          relativeTime: getRelativeTime(task),
          onUnblock: task.kanbanColumn === "blocked" ? onUnblock : undefined,
        });
      }
    }
    return result;
  }, [sections, epicIdToTitle, onUnblock, taskIdToStartedAt]);

  const taskIdToIndex = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((item, i) => {
      if (item.type === "row") m.set(item.task.id, i);
    });
    return m;
  }, [items]);

  const useVirtualization = Boolean(scrollRef) && items.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: (i) => (items[i]?.type === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    overscan: 5,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const useFallback = useVirtualization && virtualItems.length === 0;

  // Scroll to selected task only once when selection changes (sidebar opens or user picks another task).
  // Do not re-run on every render — virtualizer/taskIdToIndex can change frequently and would cause
  // continuous scroll-to-task, making content unscrollable.
  const lastScrolledTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedTaskId || !useVirtualization) {
      lastScrolledTaskIdRef.current = null;
      return;
    }
    const index = taskIdToIndex.get(selectedTaskId);
    if (index == null) return;
    if (lastScrolledTaskIdRef.current === selectedTaskId) return;
    lastScrolledTaskIdRef.current = selectedTaskId;
    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
  }, [selectedTaskId, taskIdToIndex, useVirtualization, virtualizer]);

  if (tasks.length === 0) {
    return null;
  }

  const renderSectionedList = () => (
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
                    epicName={task.epicId ? (epicIdToTitle.get(task.epicId) ?? task.epicId) : ""}
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

  if (useFallback) {
    return renderSectionedList();
  }

  if (useVirtualization) {
    return (
      <div
        data-testid="timeline-list"
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          if (item.type === "header") {
            return (
              <div
                key={`header-${item.key}`}
                data-testid={`timeline-section-${item.key}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                }}
              >
                <h3 className="text-xs font-semibold text-theme-muted tracking-wide uppercase px-4 pt-4 pb-2 border-b border-theme-border-subtle">
                  {item.label}
                </h3>
              </div>
            );
          }
          return (
            <div
              key={item.task.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
              }}
              className="border-b border-theme-border-subtle"
            >
              <ul>
                <TimelineRow
                  task={item.task}
                  epicName={item.epicName}
                  relativeTime={item.relativeTime}
                  onTaskSelect={onTaskSelect}
                  onUnblock={item.onUnblock}
                />
              </ul>
            </div>
          );
        })}
      </div>
    );
  }

  return renderSectionedList();
}
