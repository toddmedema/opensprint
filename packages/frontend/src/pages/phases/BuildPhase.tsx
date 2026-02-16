import { useState, useEffect, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { api } from "../../api/client";
import { useProjectWebSocket } from "../../contexts/ProjectWebSocketContext";
import type { ServerEvent, KanbanColumn, AgentSession, Task, Plan } from "@opensprint/shared";
import { KANBAN_COLUMNS, PRIORITY_LABELS } from "@opensprint/shared";

interface BuildPhaseProps {
  projectId: string;
  initialTaskId?: string | null;
  onInitialTaskConsumed?: () => void;
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

/** Extract epic title from plan content (first # heading) or planId */
function getEpicTitleFromPlan(plan: Plan): string {
  const firstLine = plan.content.split("\n")[0] ?? "";
  const heading = firstLine.replace(/^#+\s*/, "").trim();
  if (heading) return heading;
  return plan.metadata.planId.replace(/-/g, " ");
}

export function BuildPhase({ projectId, initialTaskId, onInitialTaskConsumed }: BuildPhaseProps) {
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [orchestratorRunning, setOrchestratorRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [agentOutput, setAgentOutput] = useState<string[]>([]);
  const [completionState, setCompletionState] = useState<{
    status: string;
    testResults: { passed: number; failed: number; skipped: number; total: number } | null;
  } | null>(null);
  const [archivedSessions, setArchivedSessions] = useState<AgentSession[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [taskDetail, setTaskDetail] = useState<Task | null>(null);
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [markCompleteLoading, setMarkCompleteLoading] = useState(false);

  const handleWsEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "task.updated":
          api.tasks.list(projectId).then((data) => setTasks(data as TaskCard[]));
          break;
        case "agent.started":
          // Refresh task list and build status in real-time
          api.tasks.list(projectId).then((data) => setTasks(data as TaskCard[]));
          api.build.status(projectId).then((data: unknown) => {
            const status = data as { running: boolean };
            setOrchestratorRunning(status?.running ?? false);
          });
          break;
        case "agent.completed":
          // Refresh task list and build status (PRD §11.2)
          api.tasks.list(projectId).then((data) => setTasks(data as TaskCard[]));
          api.build.status(projectId).then((data: unknown) => {
            const status = data as { running: boolean };
            setOrchestratorRunning(status?.running ?? false);
          });
          // Show completion state when viewing the completed task
          if (event.taskId === selectedTask) {
            setCompletionState({
              status: event.status,
              testResults: event.testResults,
            });
          }
          break;
        case "agent.output":
          if (event.taskId === selectedTask) {
            setCompletionState(null); // Agent running again (e.g. retry)
            setAgentOutput((prev) => [...prev, event.chunk]);
          }
          break;
        case "build.status":
          setOrchestratorRunning(event.running);
          if ("awaitingApproval" in event) {
            setAwaitingApproval(Boolean(event.awaitingApproval));
          }
          break;
        case "build.awaiting_approval":
          setAwaitingApproval(event.awaiting);
          break;
      }
    },
    [projectId, selectedTask],
  );

  // Apply initial task selection when navigating from Validate (e.g. clicking an issue ID)
  useEffect(() => {
    if (initialTaskId) {
      setSelectedTask(initialTaskId);
      onInitialTaskConsumed?.();
    }
  }, [initialTaskId, onInitialTaskConsumed]);

  // Clear completion state, archived sessions, and task detail when switching tasks
  useEffect(() => {
    setCompletionState(null);
    setArchivedSessions([]);
    setTaskDetail(null);
  }, [selectedTask]);

  // Fetch full task specification when a task is selected (PRD §7.3.4)
  useEffect(() => {
    if (selectedTask) {
      setTaskDetailLoading(true);
      api.tasks
        .get(projectId, selectedTask)
        .then((data) => setTaskDetail(data as Task))
        .catch(() => setTaskDetail(null))
        .finally(() => setTaskDetailLoading(false));
    }
  }, [projectId, selectedTask]);

  const { connected, subscribeToAgent, unsubscribeFromAgent, registerEventHandler } = useProjectWebSocket();

  useEffect(() => {
    return registerEventHandler(handleWsEvent);
  }, [registerEventHandler, handleWsEvent]);

  useEffect(() => {
    setError(null);
    Promise.all([
      api.tasks.list(projectId),
      api.plans.list(projectId),
    ])
      .then(([tasksData, plansData]) => {
        setTasks((tasksData as TaskCard[]) ?? []);
        setPlans((plansData as Plan[]) ?? []);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load tasks");
      })
      .finally(() => setLoading(false));

    api.build.status(projectId).then((data: unknown) => {
      const status = data as { running: boolean };
      setOrchestratorRunning(status?.running ?? false);
    });
  }, [projectId]);

  const selectedTaskData = selectedTask ? tasks.find((t) => t.id === selectedTask) : null;
  const isDoneTask = selectedTaskData?.kanbanColumn === "done";

  // Fetch archived sessions when a done task is selected (PRD §7.3.4)
  useEffect(() => {
    if (selectedTask && isDoneTask) {
      setArchivedLoading(true);
      api.tasks
        .sessions(projectId, selectedTask)
        .then((data) => setArchivedSessions((data as AgentSession[]) ?? []))
        .catch(() => setArchivedSessions([]))
        .finally(() => setArchivedLoading(false));
    }
  }, [projectId, selectedTask, isDoneTask]);

  // Subscribe to agent output when a task is selected (only for in-progress/in-review)
  useEffect(() => {
    if (selectedTask && !isDoneTask) {
      setAgentOutput([]);
      subscribeToAgent(selectedTask);
      return () => unsubscribeFromAgent(selectedTask);
    }
  }, [selectedTask, isDoneTask, subscribeToAgent, unsubscribeFromAgent]);

  const handleStartBuild = async () => {
    setError(null);
    try {
      await api.build.start(projectId);
      setOrchestratorRunning(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start build";
      setError(msg);
    }
  };

  const handlePauseBuild = async () => {
    setError(null);
    try {
      await api.build.pause(projectId);
      setOrchestratorRunning(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to pause build";
      setError(msg);
    }
  };

  const handleMarkComplete = async () => {
    if (!selectedTask || isDoneTask) return;
    setMarkCompleteLoading(true);
    setError(null);
    try {
      await api.tasks.markComplete(projectId, selectedTask);
      const [tasksData, plansData] = await Promise.all([api.tasks.list(projectId), api.plans.list(projectId)]);
      setTasks((tasksData as TaskCard[]) ?? []);
      setPlans((plansData as Plan[]) ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to mark complete";
      setError(msg);
    } finally {
      setMarkCompleteLoading(false);
    }
  };

  /** Implementation tasks only (exclude epics and gating tasks) */
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

  /** Swimlanes grouped by Plan epic (PRD §7.3.4). Hide epics where all tasks are done. */
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
    // Epics with plans first (in plan order)
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
    // Epics without plans (e.g. feedback-created tasks under beads epic)
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
    // Unassigned tasks (no epic)
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
          <button type="button" onClick={() => setError(null)} className="text-red-500 hover:text-red-700 underline">
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
              {connected && <span className="ml-2 text-green-500">Connected</span>}
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

      {/* Kanban Board — swimlanes by Plan epic (PRD §7.3.4) */}
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
                              onClick={() => setSelectedTask(task.id)}
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

      {/* Task Detail Panel — full spec, live output, or completed artifacts (PRD §7.3.4) */}
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
              <button onClick={() => setSelectedTask(null)} className="text-gray-500 hover:text-gray-300 text-xs">
                Close
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
            {/* Full task specification (PRD §7.3.4) */}
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
                                onClick={() => setSelectedTask(d.targetId)}
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
