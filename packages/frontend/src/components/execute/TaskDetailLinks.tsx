import React from "react";
import type { Plan, Task } from "@opensprint/shared";
import { TaskStatusBadge, COLUMN_LABELS } from "../kanban";
import { getEpicTitleFromPlan } from "../../lib/planContentUtils";
import AddLinkFlow from "./AddLinkFlow";

const TYPE_ORDER: Record<string, number> = {
  blocks: 0,
  "parent-child": 1,
  related: 2,
};

const TYPE_LABEL: Record<string, string> = {
  blocks: "Blocked on:",
  "parent-child": "Parent:",
  related: "Related:",
};

const TYPE_LABEL_SHORT: Record<string, string> = {
  blocks: "Blocked on",
  "parent-child": "Parent",
  related: "Related",
};

export interface TaskDetailLinksProps {
  projectId: string;
  selectedTask: string;
  task: Task;
  planByEpicId: Record<string, Plan>;
  taskById: Record<string, Task>;
  allTasks: Task[];
  onNavigateToPlan?: (planId: string) => void;
  onSelectTask: (taskId: string) => void;
  setDeleteLinkConfirm: React.Dispatch<
    React.SetStateAction<{
      targetId: string;
      type: string;
      taskName: string;
      expectedRevision?: number;
    } | null>
  >;
  removeLinkRemovingId: string | null;
  onAddLink: (parentTaskId: string, type: string, expectedRevision?: number) => Promise<void>;
}

export function TaskDetailLinks({
  projectId,
  selectedTask,
  task,
  planByEpicId,
  taskById,
  allTasks,
  onNavigateToPlan,
  onSelectTask,
  setDeleteLinkConfirm,
  removeLinkRemovingId,
  onAddLink,
}: TaskDetailLinksProps) {
  const [addLinkOpen, setAddLinkOpen] = React.useState(false);
  const addLinkRevision = React.useRef<number | undefined>(undefined);

  const plan = task.epicId && onNavigateToPlan ? planByEpicId[task.epicId] : null;
  const planTitle = plan ? getEpicTitleFromPlan(plan) : null;

  const nonEpicDeps = (task.dependencies ?? []).filter(
    (d) => d.targetId && d.type !== "discovered-from" && d.targetId !== task.epicId
  );

  const sorted = [...nonEpicDeps].sort(
    (a, b) => (TYPE_ORDER[a.type ?? ""] ?? 3) - (TYPE_ORDER[b.type ?? ""] ?? 3)
  );

  const hasPlanLink = !!plan && !!planTitle;
  const hasDeps = nonEpicDeps.length > 0;
  const showLinks = hasPlanLink || hasDeps;

  const excludeIds = new Set([
    selectedTask,
    ...(task.dependencies ?? []).filter((d) => d.targetId).map((d) => d.targetId!),
  ]);

  return (
    <div data-section="view-plan-deps-addlink">
      <div className="px-4 flex flex-col gap-3">
        {showLinks && (
          <div className="text-xs">
            <div className="flex flex-col gap-y-1.5">
              {hasPlanLink && (
                <button
                  type="button"
                  onClick={() => onNavigateToPlan!(plan!.metadata.planId)}
                  className="inline-flex items-center gap-1.5 text-left text-brand-600 hover:text-brand-500 transition-colors"
                  title={`View plan: ${planTitle}`}
                  data-testid="sidebar-view-plan-btn"
                >
                  <span className="text-theme-muted shrink-0">Plan:</span>
                  <span className="truncate max-w-[200px] hover:underline" title={planTitle!}>
                    {planTitle}
                  </span>
                </button>
              )}
              {sorted.map((d) => {
                const depTask = d.targetId ? taskById[d.targetId] : undefined;
                const label = depTask?.title ?? d.targetId ?? "";
                const col = depTask?.kanbanColumn ?? "backlog";
                const typeLabel = TYPE_LABEL[d.type ?? ""] ?? "Related:";
                const removing = removeLinkRemovingId === d.targetId;
                return (
                  <div key={d.targetId} className="inline-flex items-center gap-1.5 w-full group">
                    <button
                      type="button"
                      onClick={() => onSelectTask(d.targetId!)}
                      className="flex-1 min-w-0 inline-flex items-center gap-1.5 text-left text-brand-600 hover:text-brand-500 transition-colors"
                    >
                      <TaskStatusBadge column={col} size="xs" title={COLUMN_LABELS[col]} />
                      <span className="text-theme-muted shrink-0">{typeLabel}</span>
                      <span className="truncate max-w-[200px] hover:underline" title={label}>
                        {label}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteLinkConfirm({
                          targetId: d.targetId!,
                          type: d.type ?? "related",
                          taskName: label,
                          expectedRevision: task.revision,
                        });
                      }}
                      disabled={removing}
                      className="shrink-0 p-0.5 rounded text-theme-muted hover:text-theme-error-text hover:bg-theme-error-bg transition-colors disabled:opacity-50"
                      aria-label={`Remove ${TYPE_LABEL_SHORT[d.type ?? ""] ?? "Related"} link to ${label}`}
                      data-testid={`sidebar-remove-link-btn-${d.targetId}`}
                    >
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {addLinkOpen ? (
          <AddLinkFlow
            projectId={projectId}
            childTaskId={selectedTask}
            tasks={allTasks}
            excludeIds={excludeIds}
            onSave={async (parentTaskId, type) => {
              await onAddLink(parentTaskId, type, addLinkRevision.current);
            }}
            onCancel={() => setAddLinkOpen(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              addLinkRevision.current = task.revision;
              setAddLinkOpen(true);
            }}
            className="text-xs text-brand-600 hover:text-brand-700 hover:underline text-left"
            data-testid="sidebar-add-link-btn"
          >
            Add link
          </button>
        )}
      </div>
    </div>
  );
}
