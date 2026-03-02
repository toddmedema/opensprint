import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { DeploymentRecord, DeploymentConfig } from "@opensprint/shared";
import { getDeploymentTargetConfig } from "@opensprint/shared";
import { getProjectPhasePath } from "../../lib/phaseRouting";
import { MOBILE_BREAKPOINT } from "../../lib/constants";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  triggerDeliver,
  deployExpo,
  rollbackDeliver,
  setSelectedDeployId,
  deliverCompleted,
} from "../../store/slices/deliverSlice";
import { useDeliverStatus, useDeliverHistory } from "../../api/hooks";
import { queryKeys } from "../../api/queryKeys";
import { api } from "../../api/client";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";

/** Normalize target for display (staging → Staging, production → Production, custom as-is) */
function formatTarget(target: DeploymentRecord["target"]): string {
  if (!target) return "—";
  const s = typeof target === "string" ? target : target;
  if (s === "staging") return "Staging";
  if (s === "production") return "Production";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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

function EnvironmentChip({ target }: { target: DeploymentRecord["target"] }) {
  const label = formatTarget(target);
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-theme-surface-muted text-theme-muted shrink-0"
      title={`Environment: ${label}`}
    >
      {label}
    </span>
  );
}

function FilterIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 3h12M4 8h8M6 13h4" />
    </svg>
  );
}

export function DeliverPhase({ projectId, onOpenSettings }: DeliverPhaseProps) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { projectId: paramProjectId } = useParams<{ projectId: string }>();
  const effectiveProjectId = projectId ?? paramProjectId ?? "";
  const viewportWidth = useViewportWidth();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(true);
  const [settings, setSettings] = useState<{ deployment: DeploymentConfig } | null>(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [envFilter, setEnvFilter] = useState<string>("all");
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

  const history = useAppSelector((s) => s.deliver.history);

  const envCounts = useMemo(() => {
    const counts: Record<string, number> = { all: history.length };
    for (const r of history) {
      const key = r.target ? (typeof r.target === "string" ? r.target : r.target) : "unknown";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [history]);

  const filteredHistory = useMemo(() => {
    if (envFilter === "all") return history;
    return history.filter((r) => {
      const key = r.target ? (typeof r.target === "string" ? r.target : r.target) : "unknown";
      return key === envFilter;
    });
  }, [history, envFilter]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
        setFilterDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  const activeDeployId = useAppSelector((s) => s.deliver.activeDeployId);
  const selectedDeployId = useAppSelector((s) => s.deliver.selectedDeployId);
  const liveLog = useAppSelector((s) => s.deliver.liveLog);
  const deliverLoading = useAppSelector((s) => s.deliver?.async?.trigger?.loading ?? false);
  const expoDeployLoading = useAppSelector((s) => s.deliver?.async?.expoDeploy?.loading ?? false);
  const historyLoading = useAppSelector((s) => s.deliver?.async?.history?.loading ?? false);
  const rollbackLoading = useAppSelector((s) => s.deliver?.async?.rollback?.loading ?? false);

  const polling = Boolean(activeDeployId && projectId);
  useDeliverStatus(projectId, { refetchInterval: polling ? 1000 : undefined });
  useDeliverHistory(projectId, undefined, { refetchInterval: polling ? 1000 : undefined });

  useEffect(() => {
    api.projects
      .getSettings(projectId)
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [projectId]);

  const selectedRecord = selectedDeployId
    ? (history.find((r) => r.id === selectedDeployId) ?? null)
    : (filteredHistory[0] ?? history[0] ?? null);

  const displayLog = (() => {
    if (activeDeployId && (selectedDeployId === activeDeployId || !selectedDeployId)) {
      // Prefer live WebSocket stream; fallback to polled history (e.g. after refresh)
      return liveLog.length > 0 ? liveLog : (selectedRecord?.log ?? []);
    }
    return selectedRecord?.log ?? [];
  })();

  const selectedRecordTarget =
    selectedRecord?.target && typeof selectedRecord.target === "string"
      ? selectedRecord.target
      : "production";
  const selectedTargetConfig = settings?.deployment
    ? getDeploymentTargetConfig(settings.deployment, selectedRecordTarget)
    : undefined;
  const canRollback =
    settings?.deployment?.mode === "custom" &&
    !!(selectedTargetConfig?.rollbackCommand ?? settings?.deployment?.rollbackCommand) &&
    selectedRecord?.status === "success";

  const handleDeployToBeta = () => {
    dispatch(deployExpo({ projectId, variant: "beta" }));
  };

  const handleDeployToProd = () => {
    dispatch(deployExpo({ projectId, variant: "prod" }));
  };

  const handleRollback = () => {
    if (!selectedRecord?.id || !canRollback || rollbackLoading) return;
    dispatch(rollbackDeliver({ projectId, deployId: selectedRecord.id }));
  };

  const handleSelectDeploy = (id: string) => {
    dispatch(setSelectedDeployId(id));
  };

  const handleResetDeliver = async () => {
    if (resetLoading) return;
    setResetLoading(true);
    try {
      await api.deliver.cancel(projectId);
      if (activeDeployId) {
        dispatch(deliverCompleted({ deployId: activeDeployId, success: false }));
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.deliver.status(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deliver.history(projectId) });
    } finally {
      setResetLoading(false);
    }
  };

  const isDeploying = deliverLoading || expoDeployLoading || !!activeDeployId;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div
          className="w-full px-6 min-h-[48px] flex items-center justify-end py-2 border-b border-theme-border bg-theme-surface shrink-0"
          data-testid="deliver-top-bar"
        >
          <div className="flex items-center gap-2 shrink-0">
            {settings?.deployment?.mode === "expo" ? (
              isDeploying ? (
                <>
                  <button
                    type="button"
                    onClick={handleResetDeliver}
                    disabled={resetLoading}
                    className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="cancel-deployment-button"
                  >
                    {resetLoading ? "Cancelling…" : "Cancel Deployment"}
                  </button>
                  <div
                    className="w-5 h-5 border-2 border-brand-600 border-t-transparent rounded-full animate-spin"
                    data-testid="deploy-spinner"
                    aria-label="Deploying"
                  />
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleDeployToBeta}
                    className="btn-secondary"
                    data-testid="deploy-beta-button"
                  >
                    Deploy to Staging
                  </button>
                  <button
                    type="button"
                    onClick={handleDeployToProd}
                    className="btn-primary"
                    data-testid="deploy-prod-button"
                  >
                    Deploy to Production
                  </button>
                </>
              )
            ) : isDeploying ? (
              <>
                <button
                  type="button"
                  onClick={handleResetDeliver}
                  disabled={resetLoading}
                  className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="cancel-deployment-button"
                >
                  {resetLoading ? "Cancelling…" : "Cancel Deployment"}
                </button>
                <div
                  className="w-5 h-5 border-2 border-brand-600 border-t-transparent rounded-full animate-spin"
                  data-testid="deploy-spinner"
                  aria-label="Delivering"
                />
              </>
            ) : (
              (() => {
                const targets = settings?.deployment?.targets ?? [];
                const hasTargets = targets.length > 0;
                if (hasTargets) {
                  const nonDefault = targets.filter((t) => !t.isDefault);
                  const defaultTarget = targets.find((t) => t.isDefault) ?? targets[0];
                  const ordered = [...nonDefault, defaultTarget];
                  return (
                    <>
                      {ordered.map((t) => (
                        <button
                          key={t.name}
                          type="button"
                          onClick={() => dispatch(triggerDeliver({ projectId, target: t.name }))}
                          className={t.isDefault ? "btn-primary" : "btn-secondary"}
                          data-testid={`deploy-to-${t.name}-button`}
                        >
                          Deploy to {t.name}
                        </button>
                      ))}
                    </>
                  );
                }
                if (onOpenSettings) {
                  return (
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="text-sm text-brand-600 hover:text-brand-700"
                      data-testid="deliver-configure-targets-link"
                    >
                      Configure Targets
                    </button>
                  );
                }
                return null;
              })()
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* On mobile with overlay closed: show trigger. Otherwise show sidebar. */}
          {isMobile && !mobileHistoryOpen ? (
            <button
              type="button"
              onClick={() => setMobileHistoryOpen(true)}
              className="md:hidden fixed left-0 top-1/2 -translate-y-1/2 z-30 min-h-[44px] min-w-[44px] flex items-center justify-center bg-theme-surface border border-theme-border rounded-r-lg shadow-lg text-theme-muted hover:text-theme-text hover:bg-theme-bg-elevated transition-colors"
              aria-label="Open delivery history"
              data-testid="delivery-history-open-button"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </button>
          ) : (
          <ResizableSidebar
            storageKey="deliver"
            defaultWidth={280}
            side="left"
            resizeHandleLabel="Resize delivery history sidebar"
            responsive
            onClose={isMobile ? () => setMobileHistoryOpen(false) : undefined}
          >
            <div className="h-full flex flex-col border-r border-theme-border bg-theme-bg">
              <div className="px-3 py-2 border-b border-theme-border flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-theme-text">Delivery History</h3>
                {history.length > 0 && (
                  <div className="relative shrink-0" ref={filterDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setFilterDropdownOpen((o) => !o)}
                      className="p-1 rounded text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
                      aria-label="Filter by environment"
                      aria-expanded={filterDropdownOpen}
                      aria-haspopup="listbox"
                      data-testid="delivery-history-filter-button"
                    >
                      <FilterIcon className="w-4 h-4" />
                    </button>
                    {filterDropdownOpen && (
                      <div
                        role="listbox"
                        className="absolute right-0 top-full mt-1 z-10 min-w-[10rem] py-1 bg-theme-surface border border-theme-border rounded-lg shadow-lg"
                        data-testid="delivery-history-filter-dropdown"
                      >
                        <button
                          role="option"
                          aria-selected={envFilter === "all"}
                          type="button"
                          onClick={() => {
                            setEnvFilter("all");
                            setFilterDropdownOpen(false);
                          }}
                          className={`dropdown-item w-full text-left text-sm hover:bg-theme-border-subtle ${
                            envFilter === "all" ? "bg-theme-surface-muted font-medium" : ""
                          }`}
                        >
                          All ({envCounts.all})
                        </button>
                        {["staging", "production"].map((key) => (
                          <button
                            key={key}
                            role="option"
                            aria-selected={envFilter === key}
                            type="button"
                            onClick={() => {
                              setEnvFilter(key);
                              setFilterDropdownOpen(false);
                            }}
                            className={`dropdown-item w-full text-left text-sm hover:bg-theme-border-subtle ${
                              envFilter === key ? "bg-theme-surface-muted font-medium" : ""
                            }`}
                          >
                            {formatTarget(key)} ({envCounts[key] ?? 0})
                          </button>
                        ))}
                        {Object.entries(envCounts)
                          .filter(
                            ([k]) =>
                              k !== "all" &&
                              k !== "staging" &&
                              k !== "production" &&
                              k !== "unknown"
                          )
                          .map(([key]) => (
                            <button
                              key={key}
                              role="option"
                              aria-selected={envFilter === key}
                              type="button"
                              onClick={() => {
                                setEnvFilter(key);
                                setFilterDropdownOpen(false);
                              }}
                              className={`dropdown-item w-full text-left text-sm hover:bg-theme-border-subtle ${
                                envFilter === key ? "bg-theme-surface-muted font-medium" : ""
                              }`}
                            >
                              {formatTarget(key)} ({envCounts[key]})
                            </button>
                          ))}
                        {(envCounts.unknown ?? 0) > 0 && (
                          <button
                            role="option"
                            aria-selected={envFilter === "unknown"}
                            type="button"
                            onClick={() => {
                              setEnvFilter("unknown");
                              setFilterDropdownOpen(false);
                            }}
                            className={`dropdown-item w-full text-left text-sm hover:bg-theme-border-subtle ${
                              envFilter === "unknown" ? "bg-theme-surface-muted font-medium" : ""
                            }`}
                          >
                            Unknown ({envCounts.unknown})
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto">
                {historyLoading ? (
                  <div className="p-4 text-center text-sm text-theme-muted">Loading…</div>
                ) : history.length === 0 ? (
                  <div className="p-4 text-center text-sm text-theme-muted">
                    No deliveries yet. Configure targets and deploy.
                  </div>
                ) : filteredHistory.length === 0 ? (
                  <div className="p-4 text-center text-sm text-theme-muted">
                    No deployments match this filter.
                  </div>
                ) : (
                  <ul className="py-2">
                    {filteredHistory.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => handleSelectDeploy(r.id)}
                          className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-theme-border-subtle transition-colors ${
                            selectedDeployId === r.id ||
                            (!selectedDeployId && r.id === filteredHistory[0]?.id)
                              ? "bg-theme-surface border-l-2 border-brand-600"
                              : ""
                          }`}
                        >
                          <StatusBadge status={r.status} />
                          <EnvironmentChip target={r.target} />
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
          )}

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
