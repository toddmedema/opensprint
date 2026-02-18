import { useState, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentSession, FeedbackItem, Plan, Task } from "@opensprint/shared";
import { PRIORITY_LABELS, AGENT_ROLE_LABELS } from "@opensprint/shared";
import { useAppDispatch, useAppSelector } from "../../store";
import { api } from "../../api/client";
import {
  fetchTaskDetail,
  fetchArchivedSessions,
  markTaskDone,
  unblockTask,
  setSelectedTaskId,
} from "../../store/slices/executeSlice";
import { addNotification } from "../../store/slices/notificationSlice";
import { wsSend } from "../../store/middleware/websocketMiddleware";
import { CloseButton } from "../../components/CloseButton";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";
import { BuildEpicCard, TaskStatusBadge, COLUMN_LABELS } from "../../components/kanban";
import { sortEpicTasksByStatus } from "../../lib/executeTaskSort";

interface ExecutePhaseProps {
  projectId: string;
  onNavigateToPlan?: (planId: string) => void;
}

function ArchivedSessionView({ sessions }: { sessions: AgentSession[] }) {
  const [activeTab, setActiveTab] = useState<"output" | "diff">("output");
  const [selectedIdx, setSelectedIdx] = useState(sessions.length - 1);
  useEffect(() => {
    setSelectedIdx(Math.max(0, sessions.length - 1));
  }, [sessions]);
  const safeIdx = Math.min(selectedIdx, Math.max(0, sessions.length - 1));
  const session = sessions[safeIdx];
  if (!session) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-theme-border flex items-center gap-4 text-xs flex-wrap">
        {sessions.length > 1 ? (
          <select
            value={safeIdx}
            onChange={(e) => setSelectedIdx(Number(e.target.value))}
            className="bg-theme-bg-elevated text-theme-success-muted border border-theme-border rounded px-2 py-1"
          >
            {sessions.map((s, i) => (
              <option key={s.attempt} value={i}>
                Attempt {s.attempt} ({s.status})
              </option>
            ))}
          </select>
        ) : (
          <span className="text-theme-muted">
            Attempt {session.attempt} · {session.status} · {session.agentType}
          </span>
        )}
        {session.testResults && session.testResults.total > 0 && (
          <span className="text-theme-success-muted">
            {session.testResults.passed} passed
            {session.testResults.failed > 0 && `, ${session.testResults.failed} failed`}
          </span>
        )}
        {session.failureReason && (
          <span className="text-theme-warning-solid truncate max-w-[200px]" title={session.failureReason}>
            {session.failureReason}
          </span>
        )}
      </div>
      <div className="flex gap-2 px-4 py-2 border-b border-theme-border shrink-0">
        <button
          type="button"
          onClick={() => setActiveTab("output")}
          className={`text-xs font-medium ${
            activeTab === "output" ? "text-theme-success-muted" : "text-theme-muted hover:text-theme-text"
          }`}
        >
          Output log
        </button>
        {session.gitDiff && (
          <button
            type="button"
            onClick={() => setActiveTab("diff")}
            className={`text-xs font-medium ${
              activeTab === "diff" ? "text-theme-success-muted" : "text-theme-muted hover:text-theme-text"
            }`}
          >
            Git diff
          </button>
        )}
      </div>
      <pre className="flex-1 p-4 text-xs font-mono whitespace-pre-wrap overflow-y-auto">
        {activeTab === "output" ? session.outputLog || "(no output)" : session.gitDiff || "(no diff)"}
      </pre>
    </div>
  );
}

function getEpicTitleFromPlan(plan: Plan): string {
  const firstLine = plan.content.split("\n")[0] ?? "";
  const heading = firstLine.replace(/^#+\s*/, "").trim();
  if (heading) return heading;
  return plan.metadata.planId.replace(/-/g, " ");
}

const feedbackCategoryColors: Record<string, string> = {
  bug: "bg-theme-feedback-bug-bg text-theme-feedback-bug-text",
  feature: "bg-theme-feedback-feature-bg text-theme-feedback-feature-text",
  ux: "bg-theme-feedback-ux-bg text-theme-feedback-ux-text",
  scope: "bg-theme-feedback-scope-bg text-theme-feedback-scope-text",
};

function getFeedbackTypeLabel(item: FeedbackItem): string {
  return item.category === "ux" ? "UX" : item.category.charAt(0).toUpperCase() + item.category.slice(1);
}

function SourceFeedbackSection({
  projectId,
  feedbackId,
  plans,
}: {
  projectId: string;
  feedbackId: string;
  plans: Plan[];
}) {
  const dispatch = useAppDispatch();
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackItem | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    setLoading(true);
    api.feedback
      .get(projectId, feedbackId)
      .then(setFeedback)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : "Failed to load feedback";
        dispatch(addNotification({ message: msg, severity: "error" }));
      })
      .finally(() => setLoading(false));
  }, [projectId, feedbackId, expanded, dispatch]);

  const mappedPlan = feedback?.mappedPlanId
    ? plans.find((p) => p.metadata.planId === feedback.mappedPlanId)
    : null;
  const planTitle = mappedPlan ? getEpicTitleFromPlan(mappedPlan) : feedback?.mappedPlanId ?? null;

  return (
    <div className="border border-theme-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-theme-border-subtle transition-colors text-sm font-medium text-theme-text"
        aria-expanded={expanded}
        aria-controls="source-feedback-content"
        id="source-feedback-header"
      >
        <span>Source feedback</span>
        <span className="text-theme-muted text-xs" aria-hidden>
          {expanded ? "▼" : "▶"}
        </span>
      </button>
      {expanded && (
        <div
          id="source-feedback-content"
          role="region"
          aria-labelledby="source-feedback-header"
          className="p-3 pt-0 border-t border-theme-border"
        >
          {loading ? (
            <div className="text-xs text-theme-muted py-2">Loading feedback…</div>
          ) : feedback ? (
            <div className="card p-3 text-xs space-y-2" data-testid="source-feedback-card">
              <div className="flex items-start justify-between gap-2 overflow-hidden flex-wrap">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 font-medium flex-shrink-0 ${
                    feedbackCategoryColors[feedback.category] ?? "bg-theme-border-subtle text-theme-muted"
                  }`}
                >
                  {getFeedbackTypeLabel(feedback)}
                </span>
                {feedback.status === "resolved" && (
                  <span
                    className="inline-flex rounded-full px-2 py-0.5 font-medium flex-shrink-0 bg-theme-success-bg text-theme-success-text"
                    aria-label="Resolved"
                  >
                    Resolved
                  </span>
                )}
              </div>
              <p className="text-theme-text whitespace-pre-wrap break-words min-w-0">
                {feedback.text ?? "(No feedback text)"}
              </p>
              {planTitle && (
                <div className="text-theme-muted">
                  Mapped plan: <span className="font-medium text-theme-text">{planTitle}</span>
                </div>
              )}
              {feedback.createdAt && (
                <div className="text-theme-muted">
                  {new Date(feedback.createdAt).toLocaleString()}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

type StatusFilter =
  | "all"
  | "ready"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked";

function matchesFilter(kanbanColumn: string, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "blocked") return ["planning", "backlog", "blocked"].includes(kanbanColumn);
  return kanbanColumn === filter;
}

export function ExecutePhase({ projectId, onNavigateToPlan }: ExecutePhaseProps) {
  const dispatch = useAppDispatch();
  const [taskIdToStartedAt, setTaskIdToStartedAt] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const tasks = useAppSelector((s) => s.execute.tasks);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const agents = await api.agents.active(projectId);
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const a of agents) {
          if (a.phase === "coding" || a.phase === "review") {
            map[a.id] = a.startedAt;
          }
        }
        setTaskIdToStartedAt(map);
      } catch {
        if (!cancelled) setTaskIdToStartedAt({});
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectId]);
  const plans = useAppSelector((s) => s.plan.plans);
  const awaitingApproval = useAppSelector((s) => s.execute.awaitingApproval);
  const selectedTask = useAppSelector((s) => s.execute.selectedTaskId);
  const taskDetail = useAppSelector((s) => s.execute.taskDetail);
  const taskDetailLoading = useAppSelector((s) => s.execute.taskDetailLoading);
  const agentOutput = useAppSelector((s) => s.execute.agentOutput);
  const completionState = useAppSelector((s) => s.execute.completionState);
  const archivedSessions = useAppSelector((s) => s.execute.archivedSessions);
  const archivedLoading = useAppSelector((s) => s.execute.archivedLoading);
  const markDoneLoading = useAppSelector((s) => s.execute.markDoneLoading);
  const unblockLoading = useAppSelector((s) => s.execute.unblockLoading);
  const loading = useAppSelector((s) => s.execute.loading);
  const selectedTaskData = selectedTask ? tasks.find((t) => t.id === selectedTask) : null;
  const isDoneTask = selectedTaskData?.kanbanColumn === "done";
  const currentTaskId = useAppSelector((s) => s.execute.currentTaskId);
  const currentPhase = useAppSelector((s) => s.execute.currentPhase);
  const activeRoleLabel =
    selectedTask && selectedTask === currentTaskId && currentPhase
      ? AGENT_ROLE_LABELS[currentPhase === "coding" ? "coder" : "reviewer"]
      : null;

  useEffect(() => {
    if (selectedTask) {
      dispatch(fetchTaskDetail({ projectId, taskId: selectedTask }));
    }
  }, [projectId, selectedTask, dispatch]);

  useEffect(() => {
    if (selectedTask && isDoneTask) {
      dispatch(fetchArchivedSessions({ projectId, taskId: selectedTask }));
    }
  }, [projectId, selectedTask, isDoneTask, dispatch]);

  useEffect(() => {
    if (selectedTask && !isDoneTask) {
      dispatch(wsSend({ type: "agent.subscribe", taskId: selectedTask }));
      return () => {
        dispatch(wsSend({ type: "agent.unsubscribe", taskId: selectedTask }));
      };
    }
  }, [selectedTask, isDoneTask, dispatch]);

  const handleMarkDone = async () => {
    if (!selectedTask || isDoneTask) return;
    dispatch(markTaskDone({ projectId, taskId: selectedTask }));
  };

  const isBlockedTask = selectedTaskData?.kanbanColumn === "blocked";
  const handleUnblock = async () => {
    if (!selectedTask || !isBlockedTask) return;
    dispatch(unblockTask({ projectId, taskId: selectedTask }));
  };

  const implTasks = useMemo(
    () =>
      tasks.filter((t) => {
        const isEpic = t.type === "epic";
        const isGating = /\.0$/.test(t.id);
        return !isEpic && !isGating;
      }),
    [tasks],
  );

  const filteredTasks = useMemo(
    () => implTasks.filter((t) => matchesFilter(t.kanbanColumn, statusFilter)),
    [implTasks, statusFilter],
  );

  const swimlanes = useMemo(() => {
    const epicIdToTitle = new Map<string, string>();
    plans.forEach((p) => {
      epicIdToTitle.set(p.metadata.beadEpicId, getEpicTitleFromPlan(p));
    });

    const byEpic = new Map<string | null, Task[]>();
    for (const t of filteredTasks) {
      const key = t.epicId ?? null;
      if (!byEpic.has(key)) byEpic.set(key, []);
      byEpic.get(key)!.push(t);
    }

    const allDone = (tasks: Task[]) => tasks.length > 0 && tasks.every((t) => t.kanbanColumn === "done");
    const hideCompletedEpics = statusFilter === "all";

    const includeLane = (laneTasks: Task[]) =>
      laneTasks.length > 0 && (!hideCompletedEpics || !allDone(laneTasks));

    const result: { epicId: string; epicTitle: string; tasks: Task[] }[] = [];
    for (const plan of plans) {
      const epicId = plan.metadata.beadEpicId;
      if (!epicId) continue;
      const laneTasks = byEpic.get(epicId) ?? [];
      if (includeLane(laneTasks)) {
        result.push({
          epicId,
          epicTitle: epicIdToTitle.get(epicId) ?? epicId,
          tasks: sortEpicTasksByStatus(laneTasks),
        });
      }
    }
    const seenEpics = new Set(result.map((r) => r.epicId));
    for (const [epicId, laneTasks] of byEpic) {
      if (epicId && !seenEpics.has(epicId) && includeLane(laneTasks)) {
        result.push({
          epicId,
          epicTitle: epicId,
          tasks: sortEpicTasksByStatus(laneTasks),
        });
        seenEpics.add(epicId);
      }
    }
    const unassigned = byEpic.get(null) ?? [];
    if (includeLane(unassigned)) {
      result.push({ epicId: "", epicTitle: "Other", tasks: sortEpicTasksByStatus(unassigned) });
    }
    return result;
  }, [filteredTasks, plans]);

  const totalTasks = implTasks.length;
  const readyCount = implTasks.filter((t) => t.kanbanColumn === "ready").length;
  const blockedCount = implTasks.filter((t) =>
    ["planning", "backlog", "blocked"].includes(t.kanbanColumn),
  ).length;
  const inProgressCount = implTasks.filter((t) => t.kanbanColumn === "in_progress").length;
  const inReviewCount = implTasks.filter((t) => t.kanbanColumn === "in_review").length;
  const doneCount = implTasks.filter((t) => t.kanbanColumn === "done").length;

  const chipConfig: { label: string; filter: StatusFilter; count: number }[] = [
    { label: "All", filter: "all", count: totalTasks },
    { label: "Ready", filter: "ready", count: readyCount },
    { label: "In Progress", filter: "in_progress", count: inProgressCount },
    { label: "In Review", filter: "in_review", count: inReviewCount },
    { label: "Done", filter: "done", count: doneCount },
    { label: "Blocked", filter: "blocked", count: blockedCount },
  ];

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div className="px-6 py-4 border-b border-theme-border bg-theme-surface shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            {chipConfig.map(({ label, filter, count }) => {
              const isActive = statusFilter === filter;
              const isAll = filter === "all";
              const handleClick = () => {
                setStatusFilter(isActive && !isAll ? "all" : filter);
              };
              return (
                <button
                  key={filter}
                  type="button"
                  onClick={handleClick}
                  data-testid={`filter-chip-${filter}`}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-brand-600 text-white ring-2 ring-brand-500 ring-offset-2 ring-offset-theme-bg"
                      : "bg-theme-surface-muted text-theme-text hover:bg-theme-border-subtle"
                  }`}
                  aria-pressed={isActive}
                  aria-label={`${label} ${count}${isActive ? ", selected" : ""}`}
                >
                  <span>{label}</span>
                  <span className={isActive ? "opacity-90" : "text-theme-muted"}>{count}</span>
                </button>
              );
            })}
            {awaitingApproval && (
              <span className="ml-2 text-sm font-medium text-theme-warning-text">Awaiting approval…</span>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-6">
          {loading ? (
            <div className="text-center py-10 text-theme-muted">Loading tasks...</div>
          ) : implTasks.length === 0 ? (
            <div className="text-center py-10 text-theme-muted">No tasks yet. Ship a Plan to start generating tasks.</div>
          ) : swimlanes.length === 0 ? (
            <div className="text-center py-10 text-theme-muted">
              {statusFilter === "all" ? "All tasks completed." : "No tasks match this filter."}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {swimlanes.map((lane) => (
                <BuildEpicCard
                  key={lane.epicId || "other"}
                  epicId={lane.epicId}
                  epicTitle={lane.epicTitle}
                  tasks={lane.tasks}
                  onTaskSelect={(taskId) => dispatch(setSelectedTaskId(taskId))}
                  onUnblock={(taskId) => dispatch(unblockTask({ projectId, taskId }))}
                  taskIdToStartedAt={taskIdToStartedAt}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedTask && (
        <>
          {/* Backdrop for narrow screens: tap to close */}
          <button
            type="button"
            className="md:hidden fixed inset-0 bg-theme-overlay z-40 animate-fade-in"
            onClick={() => dispatch(setSelectedTaskId(null))}
            aria-label="Dismiss task detail"
          />
          {/* Task detail panel: overlay on narrow, sidebar on md+ */}
          <ResizableSidebar
            storageKey="execute"
            defaultWidth={420}
            responsive
            className="fixed md:static inset-y-0 right-0 z-50 md:border-l border-theme-border shadow-xl md:shadow-none animate-slide-in-right md:animate-none"
          >
            <div className="flex items-center justify-between p-4 border-b border-theme-border shrink-0">
              <div className="min-w-0 flex-1 pr-2">
              <h3 className="font-semibold text-theme-text truncate">
                {taskDetailLoading ? "Loading…" : taskDetail?.title ?? selectedTask}
              </h3>
              {taskDetail?.epicId && !taskDetailLoading && (() => {
                const plan = plans.find((p) => p.metadata.beadEpicId === taskDetail.epicId);
                if (!plan || !onNavigateToPlan) return null;
                const planTitle = getEpicTitleFromPlan(plan);
                return (
                  <button
                    type="button"
                    onClick={() => onNavigateToPlan(plan.metadata.planId)}
                    className="mt-1 text-xs text-brand-600 hover:text-brand-700 hover:underline truncate block text-left"
                    title={`View plan: ${planTitle}`}
                  >
                    View plan: {planTitle}
                  </button>
                );
              })()}
              </div>
              <div className="flex items-center gap-2 shrink-0">
              {isBlockedTask && (
                <button
                  type="button"
                  onClick={handleUnblock}
                  disabled={unblockLoading}
                  className="text-xs py-1.5 px-3 font-medium text-theme-error-text hover:bg-theme-error-bg rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {unblockLoading ? "Unblocking…" : "Unblock"}
                </button>
              )}
              {!isDoneTask && !isBlockedTask && (
                <button
                  type="button"
                  onClick={handleMarkDone}
                  disabled={markDoneLoading}
                  className="btn-primary text-xs py-1.5 px-3 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {markDoneLoading ? "Marking…" : "Mark done"}
                </button>
              )}
              <CloseButton onClick={() => dispatch(setSelectedTaskId(null))} ariaLabel="Close task detail" />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0">
              <div className="p-4 border-b border-theme-border">
              {activeRoleLabel && (
                <div className="mb-3 px-3 py-1.5 rounded-md bg-theme-warning-bg border border-theme-warning-border text-xs font-medium text-theme-warning-text">
                  Active: {activeRoleLabel}
                </div>
              )}
              {taskDetailLoading ? (
                <div className="text-sm text-theme-muted">Loading task details...</div>
              ) : taskDetail ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-theme-muted">
                    <span className="font-medium text-theme-text">{taskDetail.title}</span>
                    <span className="text-theme-muted">·</span>
                    <span className="text-theme-muted">{PRIORITY_LABELS[taskDetail.priority] ?? "Medium"}</span>
                    <span className="text-theme-muted">·</span>
                    <span className="text-theme-muted">{COLUMN_LABELS[taskDetail.kanbanColumn]}</span>
                    {taskDetail.assignee && (
                      <>
                        <span className="text-theme-muted">·</span>
                        <span className="text-brand-600">{taskDetail.assignee}</span>
                      </>
                    )}
                  </div>
                  {taskDetail.sourceFeedbackId && (
                    <SourceFeedbackSection
                      projectId={projectId}
                      feedbackId={taskDetail.sourceFeedbackId}
                      plans={plans}
                    />
                  )}
                  {(() => {
                    const desc = taskDetail.description ?? "";
                    const isOnlyFeedbackId = /^Feedback ID:\s*.+$/.test(desc.trim());
                    const displayDesc = taskDetail.sourceFeedbackId && isOnlyFeedbackId ? "" : desc;
                    return displayDesc ? (
                      <div className="prose prose-sm max-w-none bg-theme-surface p-4 rounded-lg border border-theme-border text-xs overflow-y-auto min-h-0 max-h-[50vh]">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayDesc}</ReactMarkdown>
                      </div>
                    ) : null;
                  })()}
                  {taskDetail.dependencies.filter((d) => d.targetId && d.type !== "discovered-from").length > 0 && (
                    <div className="text-xs">
                      <span className="text-theme-muted">Depends on:</span>
                      <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-1.5">
                        {taskDetail.dependencies
                          .filter((d) => d.targetId && d.type !== "discovered-from")
                          .map((d) => {
                            const depTask = tasks.find((t) => t.id === d.targetId);
                            const label = depTask?.title ?? d.targetId;
                            const col = depTask?.kanbanColumn ?? "backlog";
                            return (
                              <button
                                key={d.targetId}
                                type="button"
                                onClick={() => dispatch(setSelectedTaskId(d.targetId))}
                                className="inline-flex items-center gap-1.5 text-left hover:underline text-brand-600 hover:text-brand-500 transition-colors"
                              >
                                <TaskStatusBadge column={col} size="xs" title={COLUMN_LABELS[col]} />
                                <span className="truncate max-w-[200px]" title={label}>
                                  {label}
                                </span>
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-theme-muted">Could not load task details.</div>
              )}
              </div>

              <div className="p-4">
              <h4 className="text-xs font-medium text-theme-muted uppercase tracking-wide mb-2">
                {isDoneTask ? "Done work artifacts" : "Live agent output"}
              </h4>
              <div className="bg-theme-code-bg rounded-lg border border-theme-border overflow-hidden min-h-[200px] max-h-[400px] flex flex-col">
                {isDoneTask ? (
                  archivedLoading ? (
                    <div className="p-4 text-theme-muted text-sm">Loading archived sessions...</div>
                  ) : archivedSessions.length === 0 ? (
                    <div className="p-4 text-theme-muted text-sm">No archived sessions for this task.</div>
                  ) : (
                    <ArchivedSessionView sessions={archivedSessions} />
                  )
                ) : (
                  <div className="flex flex-col min-h-0 flex-1">
                    <pre className="p-4 text-xs font-mono whitespace-pre-wrap text-theme-success-muted min-h-[120px] overflow-y-auto flex-1 min-h-0" data-testid="live-agent-output">
                      {agentOutput.length > 0 ? agentOutput.join("") : "Waiting for agent output..."}
                    </pre>
                    {completionState && (
                      <div className="px-4 pb-4 border-t border-theme-border pt-3 mt-0">
                        <div
                          className={`text-sm font-medium ${
                            completionState.status === "approved" ? "text-theme-success-muted" : "text-theme-warning-solid"
                          }`}
                        >
                          Agent done: {completionState.status}
                        </div>
                        {completionState.testResults && completionState.testResults.total > 0 && (
                          <div className="text-xs text-theme-muted mt-1">
                            {completionState.testResults.passed} passed
                            {completionState.testResults.failed > 0 ? `, ${completionState.testResults.failed} failed` : ""}
                            {completionState.testResults.skipped > 0 &&
                              `, ${completionState.testResults.skipped} skipped`}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              </div>
            </div>
          </ResizableSidebar>
        </>
      )}
    </div>
  );
}
