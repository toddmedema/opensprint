import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { DeploymentRecord, DeploymentConfig } from "@opensprint/shared";
import { getDefaultDeploymentTarget } from "@opensprint/shared";
import { getProjectPhasePath } from "../../lib/phaseRouting";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  triggerDeliver,
  rollbackDeliver,
  fetchDeliverHistory,
  fetchDeliverStatus,
  setSelectedDeployId,
} from "../../store/slices/deliverSlice";
import { api } from "../../api/client";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";

interface DeliverPhaseProps {
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
    pending: "bg-theme-surface-muted text-theme-text",
    running: "bg-theme-info-bg text-theme-info-text",
    success: "bg-theme-success-bg text-theme-success-text",
    failed: "bg-theme-error-bg text-theme-error-text",
    rolled_back: "bg-theme-warning-bg text-theme-warning-text",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}
    >
      {status.replace("_", "-")}
    </span>
  );
}

export function DeliverPhase({ projectId, onOpenSettings }: DeliverPhaseProps) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { projectId: paramProjectId } = useParams<{ projectId: string }>();
  const effectiveProjectId = projectId ?? paramProjectId ?? "";
  const [settings, setSettings] = useState<{ deployment: DeploymentConfig } | null>(null);
  const defaultTarget = useMemo(
    () => (settings?.deployment ? getDefaultDeploymentTarget(settings.deployment) : "production"),
    [settings?.deployment]
  );
  const [selectedTarget, setSelectedTarget] = useState<string>(defaultTarget);

  const history = useAppSelector((s) => s.deliver.history);
  const activeDeployId = useAppSelector((s) => s.deliver.activeDeployId);
  const selectedDeployId = useAppSelector((s) => s.deliver.selectedDeployId);
  const liveLog = useAppSelector((s) => s.deliver.liveLog);
  const deliverLoading = useAppSelector((s) => s.deliver.deliverLoading);
  const historyLoading = useAppSelector((s) => s.deliver.historyLoading);
  const rollbackLoading = useAppSelector((s) => s.deliver.rollbackLoading);

  useEffect(() => {
    api.projects
      .getSettings(projectId)
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [projectId]);

  useEffect(() => {
    setSelectedTarget(defaultTarget);
  }, [defaultTarget]);

  useEffect(() => {
    dispatch(fetchDeliverStatus(projectId));
    dispatch(fetchDeliverHistory(projectId));
  }, [projectId, dispatch]);

  const selectedRecord = selectedDeployId
    ? (history.find((r) => r.id === selectedDeployId) ?? null)
    : (history[0] ?? null);

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
    dispatch(triggerDeliver({ projectId, target: selectedTarget }));
  };

  const handleRollback = () => {
    if (!selectedRecord?.id || !canRollback || rollbackLoading) return;
    dispatch(rollbackDeliver({ projectId, deployId: selectedRecord.id }));
  };

  const handleSelectDeploy = (id: string) => {
    dispatch(setSelectedDeployId(id));
  };

  const isDeploying = deliverLoading || !!activeDeployId;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div className="px-6 py-4 border-b border-theme-border bg-theme-surface shrink-0">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-lg font-semibold text-theme-text">Deliver</h2>
              <p className="text-sm text-theme-muted">
                Deliver your project to Expo.dev or a custom pipeline
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {settings?.deployment?.targets && settings.deployment.targets.length > 0 ? (
                <div className="flex items-center gap-2">
                  <label htmlFor="deploy-target" className="text-sm text-theme-muted">
                    Target:
                  </label>
                  <select
                    id="deploy-target"
                    value={selectedTarget}
                    onChange={(e) => setSelectedTarget(e.target.value)}
                    className="input text-sm py-1.5 px-2"
                    data-testid="deploy-target-select"
                  >
                    {settings.deployment.targets.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                        {t.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="text-sm text-theme-muted">
                  Environment:{" "}
                  <span className="font-medium text-theme-text">
                    {settings?.deployment?.mode === "expo" ? "Expo" : "Custom"}
                  </span>
                </div>
              )}
              {onOpenSettings && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="text-sm text-brand-600 hover:text-brand-700"
                >
                  Configure
                </button>
              )}
              <button
                type="button"
                onClick={handleDeploy}
                disabled={isDeploying}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="deliver-button"
              >
                {isDeploying ? "Delivering…" : "Deliver!"}
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          <ResizableSidebar storageKey="deliver" defaultWidth={280} visible>
            <div className="h-full flex flex-col border-r border-theme-border bg-theme-bg">
              <div className="px-3 py-2 border-b border-theme-border">
                <h3 className="text-sm font-medium text-theme-text">Delivery History</h3>
              </div>
              <div className="flex-1 overflow-y-auto">
                {historyLoading ? (
                  <div className="p-4 text-center text-sm text-theme-muted">Loading…</div>
                ) : history.length === 0 ? (
                  <div className="p-4 text-center text-sm text-theme-muted">
                    No deliveries yet. Click Deliver! to start.
                  </div>
                ) : (
                  <ul className="py-2">
                    {history.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => handleSelectDeploy(r.id)}
                          className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-theme-border-subtle transition-colors ${
                            selectedDeployId === r.id ||
                            (!selectedDeployId && r.id === history[0]?.id)
                              ? "bg-theme-surface border-l-2 border-brand-600"
                              : ""
                          }`}
                        >
                          <StatusBadge status={r.status} />
                          <span className="text-xs text-theme-muted truncate flex-1">
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

          <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-theme-surface">
            <div className="px-4 py-2 border-b border-theme-border flex items-center justify-between shrink-0">
              <h3 className="text-sm font-medium text-theme-text">
                {selectedRecord ? `Delivery ${formatDate(selectedRecord.startedAt)}` : "Live Log"}
              </h3>
              {canRollback && (
                <button
                  type="button"
                  onClick={handleRollback}
                  disabled={rollbackLoading}
                  className="text-sm text-theme-warning-text hover:opacity-80 disabled:opacity-50"
                >
                  {rollbackLoading ? "Rolling back…" : "Rollback"}
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <pre
                className="text-xs font-mono whitespace-pre-wrap text-theme-text bg-theme-code-bg text-theme-code-text p-4 rounded-lg min-h-full"
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
                    Open delivery →
                  </a>
                </div>
              )}
              {selectedRecord?.error && (
                <div className="mt-3 p-3 bg-theme-error-bg border border-theme-error-border rounded text-sm text-theme-error-text">
                  {selectedRecord.error}
                  {selectedRecord.fixEpicId && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => navigate(getProjectPhasePath(effectiveProjectId, "execute"))}
                        className="text-brand-600 hover:text-brand-700 font-medium underline"
                        data-testid="fix-epic-link"
                      >
                        View fix epic ({selectedRecord.fixEpicId}) →
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
