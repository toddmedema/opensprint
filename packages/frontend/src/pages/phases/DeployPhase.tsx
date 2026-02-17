import { useState, useEffect } from "react";
import type { DeploymentRecord } from "@opensprint/shared";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  triggerDeploy,
  rollbackDeploy,
  fetchDeployHistory,
  fetchDeployStatus,
  setSelectedDeployId,
} from "../../store/slices/deploySlice";
import { api } from "../../api/client";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";

interface DeployPhaseProps {
  projectId: string;
  onOpenSettings?: () => void;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: DeploymentRecord["status"] }) {
  const styles: Record<DeploymentRecord["status"], string> = {
    pending: "bg-gray-100 text-gray-700",
    running: "bg-blue-100 text-blue-700",
    success: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

export function DeployPhase({ projectId, onOpenSettings }: DeployPhaseProps) {
  const dispatch = useAppDispatch();
  const [settings, setSettings] = useState<{ deployment: { mode: string; customCommand?: string; webhookUrl?: string; rollbackCommand?: string } } | null>(null);

  const history = useAppSelector((s) => s.deploy.history);
  const currentDeploy = useAppSelector((s) => s.deploy.currentDeploy);
  const activeDeployId = useAppSelector((s) => s.deploy.activeDeployId);
  const selectedDeployId = useAppSelector((s) => s.deploy.selectedDeployId);
  const liveLog = useAppSelector((s) => s.deploy.liveLog);
  const deployLoading = useAppSelector((s) => s.deploy.deployLoading);
  const historyLoading = useAppSelector((s) => s.deploy.historyLoading);
  const rollbackLoading = useAppSelector((s) => s.deploy.rollbackLoading);
  const error = useAppSelector((s) => s.deploy.error);

  useEffect(() => {
    api.projects.getSettings(projectId).then(setSettings).catch(() => setSettings(null));
  }, [projectId]);

  useEffect(() => {
    dispatch(fetchDeployStatus(projectId));
    dispatch(fetchDeployHistory(projectId));
  }, [projectId, dispatch]);

  const selectedRecord = selectedDeployId
    ? history.find((r) => r.id === selectedDeployId) ?? null
    : history[0] ?? null;

  const displayLog = (() => {
    if (activeDeployId && (selectedDeployId === activeDeployId || !selectedDeployId)) {
      return liveLog;
    }
    return selectedRecord?.log ?? [];
  })();

  const canRollback =
    settings?.deployment?.mode === "custom" &&
    !!settings?.deployment?.rollbackCommand &&
    selectedRecord?.status === "success";

  const handleDeploy = () => {
    dispatch(triggerDeploy(projectId));
  };

  const handleRollback = () => {
    if (!selectedRecord?.id || !canRollback || rollbackLoading) return;
    dispatch(rollbackDeploy({ projectId, deployId: selectedRecord.id }));
  };

  const handleSelectDeploy = (id: string) => {
    dispatch(setSelectedDeployId(id));
  };

  const isDeploying = deployLoading || !!activeDeployId;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div className="px-6 py-4 border-b border-gray-200 bg-white shrink-0">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Deploy</h2>
              <p className="text-sm text-gray-500">
                Deploy your project to Expo.dev or a custom pipeline
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-sm text-gray-500">
                Environment:{" "}
                <span className="font-medium text-gray-700">
                  {settings?.deployment?.mode === "expo" ? "Expo" : "Custom"}
                </span>
                {onOpenSettings && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="ml-2 text-brand-600 hover:text-brand-700 text-xs"
                  >
                    Configure
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={handleDeploy}
                disabled={isDeploying}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="deploy-button"
              >
                {isDeploying ? "Deploying…" : "Deploy!"}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="mx-4 mt-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 shrink-0">
            {error}
          </div>
        )}

        <div className="flex-1 min-h-0 flex overflow-hidden">
          <ResizableSidebar storageKey="deploy" defaultWidth={280} visible>
            <div className="h-full flex flex-col border-r border-gray-200 bg-gray-50">
              <div className="px-3 py-2 border-b border-gray-200">
                <h3 className="text-sm font-medium text-gray-900">Deployment History</h3>
              </div>
              <div className="flex-1 overflow-y-auto">
                {historyLoading ? (
                  <div className="p-4 text-center text-sm text-gray-500">Loading…</div>
                ) : history.length === 0 ? (
                  <div className="p-4 text-center text-sm text-gray-500">
                    No deployments yet. Click Deploy! to start.
                  </div>
                ) : (
                  <ul className="py-2">
                    {history.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => handleSelectDeploy(r.id)}
                          className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-gray-100 transition-colors ${
                            selectedDeployId === r.id || (!selectedDeployId && r.id === history[0]?.id)
                              ? "bg-white border-l-2 border-brand-600"
                              : ""
                          }`}
                        >
                          <StatusBadge status={r.status} />
                          <span className="text-xs text-gray-600 truncate flex-1">
                            {formatDate(r.startedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </ResizableSidebar>

          <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-white">
            <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between shrink-0">
              <h3 className="text-sm font-medium text-gray-900">
                {selectedRecord ? `Deploy ${formatDate(selectedRecord.startedAt)}` : "Live Log"}
              </h3>
              {canRollback && (
                <button
                  type="button"
                  onClick={handleRollback}
                  disabled={rollbackLoading}
                  className="text-sm text-amber-600 hover:text-amber-700 disabled:opacity-50"
                >
                  {rollbackLoading ? "Rolling back…" : "Rollback"}
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <pre
                className="text-xs font-mono whitespace-pre-wrap text-gray-800 bg-gray-900 text-green-400 p-4 rounded-lg min-h-full"
                data-testid="deploy-log"
              >
                {displayLog.length > 0 ? displayLog.join("") : "(No log output)"}
              </pre>
              {selectedRecord?.url && (
                <div className="mt-3">
                  <a
                    href={selectedRecord.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-600 hover:text-brand-700 text-sm"
                  >
                    Open deployment →
                  </a>
                </div>
              )}
              {selectedRecord?.error && (
                <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                  {selectedRecord.error}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
