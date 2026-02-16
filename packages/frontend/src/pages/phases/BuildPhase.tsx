import { useState, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { KanbanColumn, AgentSession, Plan } from "@opensprint/shared";
import { KANBAN_COLUMNS, PRIORITY_LABELS } from "@opensprint/shared";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  fetchTaskDetail,
  fetchArchivedSessions,
  startBuild,
  pauseBuild,
  markTaskComplete,
  setSelectedTaskId,
  setBuildError,
} from "../../store/slices/buildSlice";
import { wsSend } from "../../store/middleware/websocketMiddleware";

interface BuildPhaseProps {
  projectId: string;
}

interface TaskCard {
  id: string;
  title: string;
  kanbanColumn: KanbanColumn;
  priority: number;
  assignee: string | null;
  epicId: string | null;
  testResults?: { passed: number; failed: number; skipped: number; total: number } | null;
}

const columnLabels: Record<KanbanColumn, string> = {
  planning: "Planning",
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

const columnColors: Record<KanbanColumn, string> = {
  planning: "bg-gray-400",
  backlog: "bg-yellow-400",
  ready: "bg-blue-400",
  in_progress: "bg-purple-400",
  in_review: "bg-orange-400",
  done: "bg-green-400",
};

function StatusIcon({ col, size = "sm", title }: { col: KanbanColumn; size?: "sm" | "xs"; title?: string }) {
  const dim = size === "sm" ? "w-2.5 h-2.5" : "w-2 h-2";
  if (col === "done") {
    return (
      <span className="inline-flex" title={title}>
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
  return <span className={`${dim} rounded-full shrink-0 ${columnColors[col]}`} title={title} />;
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
      {/* Session summary and selector */}
      <div className="px-4 py-2 border-b border-gray-700 flex items-center gap-4 text-xs flex-wrap">
        {sessions.length > 1 ? (
          <select
            value={safeIdx}
            onChange={(e) => setSelectedIdx(Number(e.target.value))}
            className="bg-gray-800 text-green-400 border border-gray-600 rounded px-2 py-1"
          >
            {sessions.map((s, i) => (
              <option key={s.attempt} value={i}>
                Attempt {s.attempt} ({s.status})
              </option>
            ))}
          </select>
        ) : (
          <span className="text-gray-400">
            Attempt {session.attempt} · {session.status} · {session.agentType}
          </span>
        )}
        {session.testResults && session.testResults.total > 0 && (
          <span className="text-green-400">
            {session.testResults.passed} passed
            {session.testResults.failed > 0 && `, ${session.testResults.failed} failed`}
          </span>
        )}
        {session.failureReason && (
          <span className="text-amber-400 truncate max-w-[200px]" title={session.failureReason}>
            {session.failureReason}
          </span>
        )}
      </div>
      {/* Tabs */}
      <div className="flex gap-2 px-4 py-2 border-b border-gray-700 shrink-0">
        <button
          type="button"
          onClick={() => setActiveTab("output")}
          className={`text-xs font-medium ${
            activeTab === "output" ? "text-green-400" : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Output log
        </button>
        {session.gitDiff && (
          <button
            type="button"
            onClick={() => setActiveTab("diff")}
            className={`text-xs font-medium ${
              activeTab === "diff" ? "text-green-400" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            Git diff
          </button>
        )}
      </div>
      {/* Content */}
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

export function BuildPhase({ projectId }: BuildPhaseProps) {
  const dispatch = useAppDispatch();

  /* ── Redux state ── */
  const tasks = useAppSelector((s) => s.build.tasks) as TaskCard[];
  const plans = useAppSelector((s) => s.build.plans);
  const orchestratorRunning = useAppSelector((s) => s.build.orchestratorRunning);
  const awaitingApproval = useAppSelector((s) => s.build.awaitingApproval);
  const selectedTask = useAppSelector((s) => s.build.selectedTaskId);
  const taskDetail = useAppSelector((s) => s.build.taskDetail);
  const taskDetailLoading = useAppSelector((s) => s.build.taskDetailLoading);
  const agentOutput = useAppSelector((s) => s.build.agentOutput);
  const completionState = useAppSelector((s) => s.build.completionState);
  const archivedSessions = useAppSelector((s) => s.build.archivedSessions);
  const archivedLoading = useAppSelector((s) => s.build.archivedLoading);
  const markCompleteLoading = useAppSelector((s) => s.build.markCompleteLoading);
  const loading = useAppSelector((s) => s.build.loading);
  const error = useAppSelector((s) => s.build.error);
  const selectedTaskData = selectedTask ? tasks.find((t) => t.id === selectedTask) : null;
  const isDoneTask = selectedTaskData?.kanbanColumn === "done";

  // Fetch full task specification when a task is selected
  useEffect(() => {
    if (selectedTask) {
      dispatch(fetchTaskDetail({ projectId, taskId: selectedTask }));
    }
  }, [projectId, selectedTask, dispatch]);

  // Fetch archived sessions when a done task is selected
  useEffect(() => {
    if (selectedTask && isDoneTask) {
      dispatch(fetchArchivedSessions({ projectId, taskId: selectedTask }));
    }
  }, [projectId, selectedTask, isDoneTask, dispatch]);

  // Subscribe to agent output when a task is selected (only for in-progress/in-review)
  useEffect(() => {
    if (selectedTask && !isDoneTask) {
      dispatch(wsSend({ type: "agent.subscribe", taskId: selectedTask }));
      return () => {
        dispatch(wsSend({ type: "agent.unsubscribe", taskId: selectedTask }));
      };
    }
  }, [selectedTask, isDoneTask, dispatch]);

  const handleStartBuild = async () => {
    dispatch(setBuildError(null));
    dispatch(startBuild(projectId));
  };

  const handlePauseBuild = async () => {
    dispatch(setBuildError(null));
    dispatch(pauseBuild(projectId));
  };

  const handleMarkComplete = async () => {
    if (!selectedTask || isDoneTask) return;
    dispatch(markTaskComplete({ projectId, taskId: selectedTask }));
  };

  const implTasks = useMemo(
    () =>
      tasks.filter((t) => {
        const task = t as TaskCard & { type?: string };
        const isEpic = task.type === "epic";
        const isGating = /\.0$/.test(t.id);
        return !isEpic && !isGating;
      }),
    [tasks],
  );

  const swimlanes = useMemo(() => {
    const epicIdToTitle = new Map<string, string>();
    plans.forEach((p) => {
      epicIdToTitle.set(p.metadata.beadEpicId, getEpicTitleFromPlan(p));
    });

    const byEpic = new Map<string | null, TaskCard[]>();
    for (const t of implTasks) {
      const key = t.epicId ?? null;
      if (!byEpic.has(key)) byEpic.set(key, []);
      byEpic.get(key)!.push(t);
    }

    const allDone = (tasks: TaskCard[]) => tasks.length > 0 && tasks.every((t) => t.kanbanColumn === "done");

    const result: { epicId: string; epicTitle: string; tasks: TaskCard[] }[] = [];
    for (const plan of plans) {
      const epicId = plan.metadata.beadEpicId;
      if (!epicId) continue;
      const laneTasks = byEpic.get(epicId) ?? [];
      if (laneTasks.length > 0 && !allDone(laneTasks)) {
        result.push({
          epicId,
          epicTitle: epicIdToTitle.get(epicId) ?? epicId,
          tasks: laneTasks,
        });
      }
    }
    const seenEpics = new Set(result.map((r) => r.epicId));
    for (const [epicId, laneTasks] of byEpic) {
      if (epicId && !seenEpics.has(epicId) && laneTasks.length > 0 && !allDone(laneTasks)) {
        result.push({
          epicId,
          epicTitle: epicId,
          tasks: laneTasks,
        });
        seenEpics.add(epicId);
      }
    }
    const unassigned = byEpic.get(null) ?? [];
    if (unassigned.length > 0 && !allDone(unassigned)) {
      result.push({ epicId: "", epicTitle: "Other", tasks: unassigned });
    }
    return result;
  }, [implTasks, plans]);

  const totalTasks = implTasks.length;
  const doneTasks = implTasks.filter((t) => t.kanbanColumn === "done").length;
  const progress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return (
    <div className="flex flex-col h-full">
      {error && (
        <div className="mx-4 mt-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex justify-between items-center">
          <span>{error}</span>
          <button type="button" onClick={() => dispatch(setBuildError(null))} className="text-red-500 hover:text-red-700 underline">
            Dismiss
          </button>
        </div>
      )}
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Build</h2>
            <p className="text-sm text-gray-500">
              {doneTasks}/{totalTasks} tasks completed
            </p>
          </div>
          <div className="flex items-center gap-3">
            {awaitingApproval && <span className="text-sm font-medium text-amber-600">Awaiting approval…</span>}
            {orchestratorRunning ? (
              <button onClick={handlePauseBuild} className="btn-secondary text-sm" disabled={awaitingApproval}>
                Pause Build
              </button>
            ) : (
              <button onClick={handleStartBuild} className="btn-primary text-sm">
                Start Build
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-gray-100 rounded-full h-2">
          <div
            className="bg-brand-600 h-2 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="text-center py-10 text-gray-400">Loading tasks...</div>
        ) : implTasks.length === 0 ? (
          <div className="text-center py-10 text-gray-500">No tasks yet. Ship a Plan to start generating tasks.</div>
        ) : (
          <div className="space-y-6">
            {swimlanes.map((lane) => {
              const laneTasksByCol = KANBAN_COLUMNS.reduce(
                (acc, col) => {
                  acc[col] = lane.tasks.filter((t) => t.kanbanColumn === col);
                  return acc;
                },
                {} as Record<KanbanColumn, TaskCard[]>,
              );
              return (
                <div key={lane.epicId || "other"} className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
                    <h3 className="text-sm font-semibold text-gray-700">{lane.epicTitle}</h3>
                    <p className="text-xs text-gray-500">
                      {lane.tasks.filter((t) => t.kanbanColumn === "done").length}/{lane.tasks.length} done
                    </p>
                  </div>
                  <div className="flex gap-4 p-4 min-w-max overflow-x-auto">
                    {KANBAN_COLUMNS.map((col) => (
                      <div key={col} className="kanban-column flex-shrink-0 w-56">
                        <div className="flex items-center gap-2 mb-2">
                          <StatusIcon col={col} size="sm" title={columnLabels[col]} />
                          <span className="text-xs font-semibold text-gray-600">{columnLabels[col]}</span>
                          <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">
                            {laneTasksByCol[col].length}
                          </span>
                        </div>
                        <div className="space-y-2">
                          {laneTasksByCol[col].map((task) => (
                            <div
                              key={task.id}
                              className="kanban-card cursor-pointer"
                              onClick={() => dispatch(setSelectedTaskId(task.id))}
                            >
                              <p className="text-sm font-medium text-gray-900 mb-2">{task.title}</p>
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-400 font-mono truncate" title={task.id}>
                                  {task.id}
                                </span>
                                <span className="text-xs text-gray-500">
                                  {PRIORITY_LABELS[task.priority] ?? "Medium"}
                                </span>
                              </div>
                              {task.assignee && <div className="mt-2 text-xs text-brand-600">{task.assignee}</div>}
                              {task.testResults && task.testResults.total > 0 && (
                                <div
                                  className={`mt-2 text-xs font-medium ${
                                    task.testResults.failed > 0 ? "text-red-600" : "text-green-600"
                                  }`}
                                >
                                  {task.testResults.passed} passed
                                  {task.testResults.failed > 0 ? `, ${task.testResults.failed} failed` : ""}
                                  {task.testResults.skipped > 0 ? `, ${task.testResults.skipped} skipped` : ""}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Task Detail Panel */}
      {selectedTask && (
        <div className="h-80 border-t border-gray-200 bg-gray-900 text-gray-100 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 shrink-0">
            <span className="text-xs font-mono text-gray-400">{selectedTask}</span>
            <div className="flex items-center gap-2">
              {!isDoneTask && (
                <button
                  type="button"
                  onClick={handleMarkComplete}
                  disabled={markCompleteLoading}
                  className="text-xs px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {markCompleteLoading ? "Marking…" : "Mark as complete"}
                </button>
              )}
              <button onClick={() => dispatch(setSelectedTaskId(null))} className="text-gray-500 hover:text-gray-300 text-xs">
                Close
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
            {/* Full task specification */}
            <div className="shrink-0 border-b border-gray-700 bg-gray-800/50">
              {taskDetailLoading ? (
                <div className="p-4 text-gray-400 text-sm">Loading task spec...</div>
              ) : taskDetail ? (
                <div className="p-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-white">{taskDetail.title}</span>
                    <span className="text-gray-500">·</span>
                    <span className="text-gray-400">{taskDetail.type}</span>
                    <span className="text-gray-500">·</span>
                    <span className="text-gray-400">{PRIORITY_LABELS[taskDetail.priority] ?? "Medium"}</span>
                    <span className="text-gray-500">·</span>
                    <span className="text-gray-400">{columnLabels[taskDetail.kanbanColumn]}</span>
                    {taskDetail.assignee && (
                      <>
                        <span className="text-gray-500">·</span>
                        <span className="text-brand-400">{taskDetail.assignee}</span>
                      </>
                    )}
                  </div>
                  {taskDetail.description && (
                    <div className="prose prose-invert prose-sm max-w-none text-gray-300">
                      <ReactMarkdown>{taskDetail.description}</ReactMarkdown>
                    </div>
                  )}
                  {taskDetail.dependencies.filter((d) => d.targetId).length > 0 && (
                    <div className="text-xs">
                      <span className="text-gray-500">Depends on:</span>
                      <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-1.5">
                        {taskDetail.dependencies
                          .filter((d) => d.targetId)
                          .map((d) => {
                            const depTask = tasks.find((t) => t.id === d.targetId);
                            const label = depTask?.title ?? d.targetId;
                            const col = depTask?.kanbanColumn ?? "backlog";
                            return (
                              <button
                                key={d.targetId}
                                type="button"
                                onClick={() => dispatch(setSelectedTaskId(d.targetId))}
                                className="inline-flex items-center gap-1.5 text-left hover:underline text-brand-400 hover:text-brand-300 transition-colors"
                              >
                                <StatusIcon col={col} size="xs" title={columnLabels[col]} />
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
                <div className="p-4 text-gray-500 text-sm">Could not load task details.</div>
              )}
            </div>
            {/* Live agent output or completed artifacts */}
            <div className="flex-1 min-h-0 flex flex-col text-green-400">
              <div className="px-4 py-2 border-b border-gray-700 text-xs text-gray-400 shrink-0">
                {isDoneTask ? "Completed work artifacts" : "Live agent output"}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0">
                {isDoneTask ? (
                  archivedLoading ? (
                    <div className="p-4 text-gray-400 text-sm">Loading archived sessions...</div>
                  ) : archivedSessions.length === 0 ? (
                    <div className="p-4 text-gray-400 text-sm">No archived sessions for this task.</div>
                  ) : (
                    <ArchivedSessionView sessions={archivedSessions} />
                  )
                ) : (
                  <>
                    <pre className="p-4 text-xs font-mono whitespace-pre-wrap">
                      {agentOutput.length > 0 ? agentOutput.join("") : "Waiting for agent output..."}
                    </pre>
                    {completionState && (
                      <div className="px-4 pb-4 border-t border-gray-700 pt-3 mt-2">
                        <div
                          className={`text-sm font-medium ${
                            completionState.status === "approved" ? "text-green-400" : "text-amber-400"
                          }`}
                        >
                          Agent completed: {completionState.status}
                        </div>
                        {completionState.testResults && completionState.testResults.total > 0 && (
                          <div className="text-xs text-gray-400 mt-1">
                            {completionState.testResults.passed} passed
                            {completionState.testResults.failed > 0 && `, ${completionState.testResults.failed} failed`}
                            {completionState.testResults.skipped > 0 &&
                              `, ${completionState.testResults.skipped} skipped`}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
