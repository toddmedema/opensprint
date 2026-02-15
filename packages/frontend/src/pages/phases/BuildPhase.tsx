import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { api } from "../../api/client";
import { useProjectWebSocket } from "../../contexts/ProjectWebSocketContext";
import type { ServerEvent, KanbanColumn, AgentSession, Task } from "@opensprint/shared";
import { KANBAN_COLUMNS, PRIORITY_LABELS } from "@opensprint/shared";

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
        {activeTab === "output"
          ? session.outputLog || "(no output)"
          : session.gitDiff || "(no diff)"}
      </pre>
    </div>
  );
}

export function BuildPhase({ projectId }: BuildPhaseProps) {
  const [tasks, setTasks] = useState<TaskCard[]>([]);
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

  const handleWsEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "task.updated":
          api.tasks.list(projectId).then((data) => setTasks(data as TaskCard[]));
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
          break;
      }
    },
    [projectId, selectedTask],
  );

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

  const { connected, subscribeToAgent, unsubscribeFromAgent, registerEventHandler } =
    useProjectWebSocket();

  useEffect(() => {
    return registerEventHandler(handleWsEvent);
  }, [registerEventHandler, handleWsEvent]);

  useEffect(() => {
    api.tasks
      .list(projectId)
      .then((data) => setTasks(data as TaskCard[]))
      .catch(console.error)
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

  const tasksByColumn = KANBAN_COLUMNS.reduce(
    (acc, col) => {
      acc[col] = tasks.filter((t) => t.kanbanColumn === col);
      return acc;
    },
    {} as Record<KanbanColumn, TaskCard[]>,
  );

  const totalTasks = tasks.length;
  const doneTasks = tasksByColumn.done.length;
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
            {orchestratorRunning ? (
              <button onClick={handlePauseBuild} className="btn-secondary text-sm">
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
      <div className="flex-1 overflow-x-auto p-6">
        {loading ? (
          <div className="text-center py-10 text-gray-400">Loading tasks...</div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-10 text-gray-500">No tasks yet. Ship a Plan to start generating tasks.</div>
        ) : (
          <div className="flex gap-4 min-w-max">
            {KANBAN_COLUMNS.map((col) => (
              <div key={col} className="kanban-column">
                {/* Column header */}
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${columnColors[col]}`} />
                  <h3 className="text-sm font-semibold text-gray-700">{columnLabels[col]}</h3>
                  <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">
                    {tasksByColumn[col].length}
                  </span>
                </div>

                {/* Task cards */}
                <div className="space-y-2">
                  {tasksByColumn[col].map((task) => (
                    <div key={task.id} className="kanban-card" onClick={() => setSelectedTask(task.id)}>
                      <p className="text-sm font-medium text-gray-900 mb-2">{task.title}</p>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-400 font-mono">{task.id}</span>
                        <span className="text-xs text-gray-500">{PRIORITY_LABELS[task.priority] ?? "Medium"}</span>
                      </div>
                      {task.assignee && <div className="mt-2 text-xs text-brand-600">{task.assignee}</div>}
                      {task.testResults && task.testResults.total > 0 && (
                        <div
                          className={`mt-2 text-xs font-medium ${
                            task.testResults.failed > 0 ? "text-red-600" : "text-green-600"
                          }`}
                        >
                          {task.testResults.passed} passed
                          {task.testResults.failed > 0 && `, ${task.testResults.failed} failed`}
                          {task.testResults.skipped > 0 && `, ${task.testResults.skipped} skipped`}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Task Detail Panel — full spec, live output, or completed artifacts (PRD §7.3.4) */}
      {selectedTask && (
        <div className="h-80 border-t border-gray-200 bg-gray-900 text-gray-100 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 shrink-0">
            <span className="text-xs font-mono text-gray-400">{selectedTask}</span>
            <button onClick={() => setSelectedTask(null)} className="text-gray-500 hover:text-gray-300 text-xs">
              Close
            </button>
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
                  {taskDetail.dependencies.length > 0 && (
                    <div className="text-xs text-gray-500">
                      Depends on: {taskDetail.dependencies.map((d) => d.targetId).join(", ")}
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
                            {completionState.testResults.failed > 0 &&
                              `, ${completionState.testResults.failed} failed`}
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
