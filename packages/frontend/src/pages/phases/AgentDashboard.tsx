import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAppDispatch, useAppSelector } from "../../store";
import { setSelectedTaskId, setAgentOutputBackfill } from "../../store/slices/executeSlice";
import { wsSend } from "../../store/middleware/websocketMiddleware";
import {
  useExecuteStatus,
  useActiveAgents,
  useLiveOutputBackfill,
} from "../../api/hooks";
import { CloseButton } from "../../components/CloseButton";

interface AgentDashboardProps {
  projectId: string;
}

interface AgentInfo {
  taskId: string;
  phase: string;
  branchName: string;
  startedAt: string;
  outputLength: number;
}

const DASHBOARD_POLL_MS = 5000;
const LIVE_OUTPUT_POLL_MS = 1000;

export function AgentDashboard({ projectId }: AgentDashboardProps) {
  const dispatch = useAppDispatch();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const statusQuery = useExecuteStatus(projectId, { refetchInterval: DASHBOARD_POLL_MS });
  const agentsQuery = useActiveAgents(projectId, { refetchInterval: DASHBOARD_POLL_MS });
  const liveOutputQuery = useLiveOutputBackfill(projectId, selectedAgent ?? undefined, {
    enabled: Boolean(selectedAgent),
    refetchInterval: selectedAgent ? LIVE_OUTPUT_POLL_MS : undefined,
  });

  const agentOutputMap = useAppSelector((s) => s.execute.agentOutput);
  const agentOutput = selectedAgent ? (agentOutputMap[selectedAgent] ?? []) : [];
  const status = statusQuery.data;
  const activeTasks = status?.activeTasks ?? [];
  const totalDone = status?.totalDone ?? 0;
  const totalFailed = status?.totalFailed ?? 0;
  const queueDepth = status?.queueDepth ?? 0;
  const activeAgents = agentsQuery.data?.agents ?? [];

  const currentTask = activeTasks[0]?.taskId ?? null;
  const stats = { totalDone, totalFailed, queueDepth };
  const agents: AgentInfo[] = activeAgents.map((a) => ({
    taskId: a.id,
    phase: a.phase,
    branchName: a.branchName ?? a.label,
    startedAt: a.startedAt,
    outputLength: 0,
  }));

  // Sync polled live output into Redux so display (and WS chunks) stay in sync
  useEffect(() => {
    if (selectedAgent && liveOutputQuery.data !== undefined) {
      dispatch(setAgentOutputBackfill({ taskId: selectedAgent, output: liveOutputQuery.data }));
    }
  }, [selectedAgent, liveOutputQuery.data, dispatch]);

  // Sync selected agent with Redux so agent.output events are stored; subscribe/unsubscribe via wsSend
  useEffect(() => {
    if (selectedAgent) {
      dispatch(setSelectedTaskId(selectedAgent));
      dispatch(wsSend({ type: "agent.subscribe", taskId: selectedAgent }));
      return () => {
        dispatch(wsSend({ type: "agent.unsubscribe", taskId: selectedAgent }));
        dispatch(setSelectedTaskId(null));
      };
    } else {
      dispatch(setSelectedTaskId(null));
    }
  }, [selectedAgent, dispatch]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-theme-border bg-theme-surface">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-theme-text">Agent Dashboard</h2>
            <p className="text-sm text-theme-muted">Monitor and manage all agent instances</p>
          </div>
          <div className="flex items-center gap-4">
            <div
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                currentTask
                  ? "bg-theme-success-bg text-theme-success-text"
                  : "bg-theme-surface-muted text-theme-muted"
              }`}
            >
              {currentTask ? "Active" : "Idle"}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: Stats & Agent List */}
        <div className="w-80 border-r border-theme-border flex flex-col">
          {/* Performance Metrics */}
          <div className="p-4 border-b border-theme-border">
            <h3 className="text-xs font-semibold text-theme-muted uppercase tracking-wide mb-3">
              Performance
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <div className="text-2xl font-bold text-theme-success-text">{stats.totalDone}</div>
                <div className="text-xs text-theme-muted">Done</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-theme-error-text">{stats.totalFailed}</div>
                <div className="text-xs text-theme-muted">Failed</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-theme-info-text">{stats.queueDepth}</div>
                <div className="text-xs text-theme-muted">Queue</div>
              </div>
            </div>
            {stats.totalDone + stats.totalFailed > 0 && (
              <div className="mt-3">
                <div className="text-xs text-theme-muted mb-1">Success Rate</div>
                <div className="w-full bg-theme-surface-muted rounded-full h-2">
                  <div
                    className="bg-theme-success-solid h-2 rounded-full"
                    style={{
                      width: `${Math.round((stats.totalDone / (stats.totalDone + stats.totalFailed)) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Active Agents */}
          <div className="flex-1 overflow-y-auto p-4">
            <h3 className="text-xs font-semibold text-theme-muted uppercase tracking-wide mb-3">
              Active Agents ({agents.length})
            </h3>

            {agents.length === 0 ? (
              <div className="text-center py-8 text-theme-muted text-sm">
                No agents currently running
              </div>
            ) : (
              <div className="space-y-2">
                {agents.map((agent) => (
                  <button
                    key={agent.taskId}
                    onClick={() => setSelectedAgent(agent.taskId)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedAgent === agent.taskId
                        ? "border-theme-info-border bg-theme-info-bg"
                        : "border-theme-border hover:border-theme-ring"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-theme-text font-mono">
                        {agent.taskId}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          agent.phase === "coding"
                            ? "bg-theme-feedback-feature-bg text-theme-feedback-feature-text"
                            : "bg-theme-warning-bg text-theme-warning-text"
                        }`}
                      >
                        {agent.phase}
                      </span>
                    </div>
                    <div className="text-xs text-theme-muted">Branch: {agent.branchName}</div>
                    <div className="text-xs text-theme-muted mt-1">
                      Started: {new Date(agent.startedAt).toLocaleTimeString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Agent Output Stream (terminal-style) */}
        <div className="flex-1 flex flex-col bg-theme-code-bg">
          {selectedAgent ? (
            <>
              <div className="flex items-center justify-between px-4 py-2 border-b border-theme-border">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-theme-code-text">Agent Output</span>
                  <span className="text-xs text-theme-muted">{selectedAgent}</span>
                </div>
                <CloseButton
                  onClick={() => setSelectedAgent(null)}
                  ariaLabel="Close agent output"
                  className="p-1 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-surface transition-colors"
                />
              </div>
              <div
                className="flex-1 overflow-y-auto p-4 prose prose-sm prose-neutral dark:prose-invert prose-execute-task max-w-none text-theme-success-muted prose-pre:bg-theme-code-bg prose-pre:text-theme-code-text prose-pre:border prose-pre:border-theme-border prose-pre:rounded-lg"
                data-testid="agent-output"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {agentOutput.length > 0 ? agentOutput.join("") : "Waiting for agent output..."}
                </ReactMarkdown>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-theme-muted text-sm">
              Select an agent to view its output stream
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
