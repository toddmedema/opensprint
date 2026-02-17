import { useState, useEffect, useCallback } from "react";
import { api } from "../../api/client";
import { useAppDispatch, useAppSelector } from "../../store";
import { setSelectedTaskId } from "../../store/slices/buildSlice";
import { wsSend } from "../../store/middleware/websocketMiddleware";
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

export function AgentDashboard({ projectId }: AgentDashboardProps) {
  const dispatch = useAppDispatch();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [stats, setStats] = useState({ totalCompleted: 0, totalFailed: 0, queueDepth: 0 });

  const agentOutput = useAppSelector((s) => s.build.agentOutput);

  const loadStatus = useCallback(() => {
    api.build.status(projectId).then((data: unknown) => {
      const status = data as {
        currentTask: string | null;
        totalCompleted: number;
        totalFailed: number;
        queueDepth: number;
      };
      setCurrentTask(status?.currentTask ?? null);
      setStats({
        totalCompleted: status?.totalCompleted ?? 0,
        totalFailed: status?.totalFailed ?? 0,
        queueDepth: status?.queueDepth ?? 0,
      });
    });
    api.agents.active(projectId).then((data) => {
      const list = Array.isArray(data) ? data : [];
      setAgents(
        list.map((a) => ({
          taskId: a.id,
          phase: a.phase,
          branchName: a.branchName ?? a.label,
          startedAt: a.startedAt,
          outputLength: 0,
        })),
      );
    }).catch(() => setAgents([]));
  }, [projectId]);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  }, [loadStatus]);

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
      <div className="px-6 py-4 border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Agent Dashboard</h2>
            <p className="text-sm text-gray-500">Monitor and manage all agent instances</p>
          </div>
          <div className="flex items-center gap-4">
            <div
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                currentTask ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"
              }`}
            >
              {currentTask ? "Active" : "Idle"}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: Stats & Agent List */}
        <div className="w-80 border-r border-gray-200 flex flex-col">
          {/* Performance Metrics */}
          <div className="p-4 border-b border-gray-200">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Performance</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">{stats.totalCompleted}</div>
                <div className="text-xs text-gray-500">Completed</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-red-600">{stats.totalFailed}</div>
                <div className="text-xs text-gray-500">Failed</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">{stats.queueDepth}</div>
                <div className="text-xs text-gray-500">Queue</div>
              </div>
            </div>
            {stats.totalCompleted + stats.totalFailed > 0 && (
              <div className="mt-3">
                <div className="text-xs text-gray-500 mb-1">Success Rate</div>
                <div className="w-full bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-green-500 h-2 rounded-full"
                    style={{
                      width: `${Math.round((stats.totalCompleted / (stats.totalCompleted + stats.totalFailed)) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Active Agents */}
          <div className="flex-1 overflow-y-auto p-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Active Agents ({agents.length})
            </h3>

            {agents.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">No agents currently running</div>
            ) : (
              <div className="space-y-2">
                {agents.map((agent) => (
                  <button
                    key={agent.taskId}
                    onClick={() => setSelectedAgent(agent.taskId)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedAgent === agent.taskId
                        ? "border-brand-300 bg-brand-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-900 font-mono">{agent.taskId}</span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          agent.phase === "coding" ? "bg-purple-50 text-purple-700" : "bg-orange-50 text-orange-700"
                        }`}
                      >
                        {agent.phase}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500">Branch: {agent.branchName}</div>
                    <div className="text-xs text-gray-400 mt-1">
                      Started: {new Date(agent.startedAt).toLocaleTimeString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Agent Output Stream */}
        <div className="flex-1 flex flex-col bg-gray-900">
          {selectedAgent ? (
            <>
              <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-green-400">Agent Output</span>
                  <span className="text-xs text-gray-500">{selectedAgent}</span>
                </div>
                <CloseButton
                  onClick={() => setSelectedAgent(null)}
                  className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
                />
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <pre className="text-xs font-mono text-green-400 whitespace-pre-wrap">
                  {agentOutput.length > 0 ? agentOutput.join("") : "Waiting for agent output..."}
                </pre>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
              Select an agent to view its output stream
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
