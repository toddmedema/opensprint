import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { DeploymentRecord, DeploymentConfig } from "@opensprint/shared";
import { getDeploymentTargetConfig } from "@opensprint/shared";
import { getProjectPhasePath } from "../../lib/phaseRouting";
import { MOBILE_BREAKPOINT, PHASE_TOOLBAR_BUTTON_SIZE, PHASE_TOOLBAR_HEIGHT } from "../../lib/constants";
import { shouldRightAlignDropdown } from "../../lib/dropdownViewport";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  triggerDeliver,
  deployExpo,
  rollbackDeliver,
  setSelectedDeployId,
  deliverCompleted,
} from "../../store/slices/deliverSlice";
import { useDeliverStatus, useDeliverHistory, useExpoReadiness } from "../../api/hooks";
import { queryKeys } from "../../api/queryKeys";
import { api } from "../../api/client";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";
import { CloseButton } from "../../components/CloseButton";
import { PhaseEmptyState, PhaseEmptyStateLogo } from "../../components/PhaseEmptyState";
import { EMPTY_STATE_COPY } from "../../lib/emptyStateCopy";
import { createPortal } from "react-dom";

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
  /** Opens global settings (Expo API Token). Defaults to onOpenSettings if not provided. */
  onOpenGlobalSettings?: () => void;
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
  const dotStyles: Record<DeploymentRecord["status"], string> = {
    pending: "bg-theme-ring",
    running: "bg-theme-status-ready",
    success: "bg-theme-status-done",
    failed: "bg-theme-status-blocked",
    rolled_back: "bg-theme-status-backlog",
  };
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-theme-surface-muted text-theme-text border border-theme-border-subtle">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotStyles[status]}`} />
      {status.replace("_", "-")}
    </span>
  );
}

function EnvironmentChip({ target }: { target: DeploymentRecord["target"] }) {
  const label = formatTarget(target);
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-theme-surface-muted text-theme-muted border border-theme-border-subtle shrink-0"
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

export function DeliverPhase({ projectId, onOpenSettings, onOpenGlobalSettings }: DeliverPhaseProps) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { projectId: paramProjectId } = useParams<{ projectId: string }>();
  const effectiveProjectId = projectId ?? paramProjectId ?? "";
  const viewportWidth = useViewportWidth();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;
  const [settings, setSettings] = useState<{ deployment: DeploymentConfig } | null>(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [envFilter, setEnvFilter] = useState<string>("all");
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false);
  const [filterDropdownAlignRight, setFilterDropdownAlignRight] = useState(false);
  const filterDropdownRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);

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

  useEffect(() => {
    if (filterDropdownOpen && filterTriggerRef.current) {
      setFilterDropdownAlignRight(
        shouldRightAlignDropdown(filterTriggerRef.current.getBoundingClientRect())
      );
    }
  }, [filterDropdownOpen]);

  const activeDeployId = useAppSelector((s) => s.deliver.activeDeployId);
  const selectedDeployId = useAppSelector((s) => s.deliver.selectedDeployId);
  const liveLog = useAppSelector((s) => s.deliver.liveLog);
  const deliverLoading = useAppSelector((s) => s.deliver?.async?.trigger?.loading ?? false);
  const expoDeployLoading = useAppSelector((s) => s.deliver?.async?.expoDeploy?.loading ?? false);
  const expoDeployError = useAppSelector((s) => s.deliver?.async?.expoDeploy?.error ?? null);
  const historyLoading = useAppSelector((s) => s.deliver?.async?.history?.loading ?? false);
  const rollbackLoading = useAppSelector((s) => s.deliver?.async?.rollback?.loading ?? false);

  const polling = Boolean(activeDeployId && projectId);
  useDeliverStatus(projectId, { refetchInterval: polling ? 1000 : undefined });
  useDeliverHistory(projectId, undefined, { refetchInterval: polling ? 1000 : undefined });

  const { data: expoReadiness } = useExpoReadiness(effectiveProjectId, {
    deploymentMode: settings?.deployment?.mode ?? undefined,
  });

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

  const handleCloseDetailOverlay = () => {
    dispatch(setSelectedDeployId(null));
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

  const showExpoAuthBanner =
    settings?.deployment?.mode === "expo" &&
    expoReadiness &&
    expoReadiness.authOk === false;

  const deliverEmptyStateProps = {
    title: EMPTY_STATE_COPY.deliver.title,
    description: EMPTY_STATE_COPY.deliver.description,
    illustration: <PhaseEmptyStateLogo />,
    primaryAction: onOpenSettings
      ? {
          label: EMPTY_STATE_COPY.deliver.primaryActionLabel,
          onClick: onOpenSettings,
          "data-testid": "empty-state-configure-targets",
        }
      : undefined,
  };

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {showExpoAuthBanner && (
          <div
            className="mx-4 sm:mx-6 mt-2 mb-0 p-4 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text shrink-0"
            data-testid="expo-readiness-auth-banner"
          >
            Expo deployment requires an access token. Add it in Settings → Expo API Token.
            {(onOpenGlobalSettings ?? onOpenSettings) && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={onOpenGlobalSettings ?? onOpenSettings}
                  className="text-brand-600 hover:text-brand-700 font-medium underline"
                  data-testid="expo-readiness-open-settings"
                >
                  Open Settings
                </button>
              </div>
            )}
          </div>
        )}
        <div
          className="phase-toolbar w-full px-4 sm:px-6 flex items-center justify-end py-0.5 bg-theme-surface shrink-0 border-b border-theme-border"
          style={{ height: PHASE_TOOLBAR_HEIGHT }}
          data-testid="deliver-top-bar"
        >
          <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
            {settings?.deployment?.mode === "expo" ? (
              isDeploying ? (
                <>
                  <button
                    type="button"
                    onClick={handleResetDeliver}
                    disabled={resetLoading}
                    style={{ minHeight: PHASE_TOOLBAR_BUTTON_SIZE, minWidth: PHASE_TOOLBAR_BUTTON_SIZE }}
                    className="btn-secondary rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
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
                    style={{ minHeight: PHASE_TOOLBAR_BUTTON_SIZE, minWidth: PHASE_TOOLBAR_BUTTON_SIZE }}
                    className="btn-secondary rounded-sm"
                    data-testid="deploy-beta-button"
                  >
                    Deploy to Staging
                  </button>
                  <button
                    type="button"
                    onClick={handleDeployToProd}
                    style={{ minHeight: PHASE_TOOLBAR_BUTTON_SIZE, minWidth: PHASE_TOOLBAR_BUTTON_SIZE }}
                    className="btn-primary rounded-sm"
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
                  style={{ minHeight: PHASE_TOOLBAR_BUTTON_SIZE, minWidth: PHASE_TOOLBAR_BUTTON_SIZE }}
                  className="btn-secondary rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
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
                          style={{ minHeight: PHASE_TOOLBAR_BUTTON_SIZE, minWidth: PHASE_TOOLBAR_BUTTON_SIZE }}
                          className={`rounded-sm ${t.isDefault ? "btn-primary" : "btn-secondary"}`}
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
          {/* Mobile: history full-width as main content. Desktop: ResizableSidebar with history. */}
          {isMobile ? (
            <div
              className="flex-1 flex flex-col min-h-0 min-w-0 bg-theme-bg overflow-hidden"
              data-testid="delivery-history-mobile-main"
            >
              <div className="px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0 border-b border-theme-border">
                <h3 className="text-sm font-medium text-theme-text">Delivery History</h3>
                {history.length > 0 && (
                  <div className="relative shrink-0" ref={filterDropdownRef}>
                    <button
                      ref={filterTriggerRef}
                      type="button"
                      onClick={() => setFilterDropdownOpen((o) => !o)}
                      className="min-h-[44px] min-w-[44px] p-1 flex items-center justify-center rounded text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
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
                        className={`absolute top-full mt-1 z-10 min-w-[10rem] max-h-[90vh] overflow-y-auto py-1 bg-theme-surface border border-theme-border rounded-lg shadow-lg ${filterDropdownAlignRight ? "right-0 left-auto" : "left-0 right-auto"}`}
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
                  <PhaseEmptyState {...deliverEmptyStateProps} />
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
                          className={`w-full text-left px-4 sm:px-6 py-3 flex flex-wrap items-center gap-2 hover:bg-theme-border-subtle transition-colors min-h-[44px] ${
                            selectedDeployId === r.id ||
                            (!selectedDeployId && r.id === filteredHistory[0]?.id)
                              ? "bg-theme-surface border-l-4 border-brand-600"
                              : ""
                          }`}
                        >
                          <StatusBadge status={r.status} />
                          <EnvironmentChip target={r.target} />
                          <span className="text-xs text-theme-muted truncate flex-1 min-w-0">
                            {formatDate(r.startedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <ResizableSidebar
              storageKey="deliver"
              defaultWidth={280}
              side="left"
              resizeHandleLabel="Resize delivery history sidebar"
              responsive
            >
              <div className="h-full flex flex-col border-r border-theme-border bg-theme-bg">
                <div className="px-3 py-2 flex items-center justify-between gap-2 border-b border-theme-border">
                  <h3 className="text-sm font-medium text-theme-text">Delivery History</h3>
                  {history.length > 0 && (
                    <div className="relative shrink-0" ref={filterDropdownRef}>
                      <button
                        ref={filterTriggerRef}
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
                          className={`absolute top-full mt-1 z-10 min-w-[10rem] py-1 bg-theme-surface border border-theme-border rounded-lg shadow-lg ${filterDropdownAlignRight ? "right-0 left-auto" : "left-0 right-auto"}`}
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
                    <PhaseEmptyState {...deliverEmptyStateProps} />
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

          {/* Desktop: detail inline. Mobile: detail only when deploy selected (rendered as overlay below). */}
          {!isMobile && (
          <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-theme-surface">
            <div className="px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0 border-b border-theme-border">
              <h3 className="text-sm font-medium text-theme-text">
                {selectedRecord ? `Delivery ${formatDate(selectedRecord.startedAt)}` : "Live Log"}
              </h3>
              {canRollback && (
                <button
                  type="button"
                  onClick={handleRollback}
                  disabled={rollbackLoading}
                  className="min-h-[44px] min-w-[44px] text-sm text-theme-warning-text hover:opacity-80 disabled:opacity-50 flex items-center justify-center"
                >
                  {rollbackLoading ? "Rolling back…" : "Rollback"}
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4 sm:p-6">
              {expoDeployError && (
                <div
                  className="mb-4 p-4 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text whitespace-pre-wrap"
                  data-testid="expo-deploy-auth-error"
                >
                  {expoDeployError}
                  {(onOpenGlobalSettings ?? onOpenSettings) && (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={onOpenGlobalSettings ?? onOpenSettings}
                        className="text-brand-600 hover:text-brand-700 font-medium underline"
                        data-testid="expo-auth-settings-link"
                      >
                        Open Settings to add Expo API Token →
                      </button>
                    </div>
                  )}
                </div>
              )}
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
          )}

        </div>

        {/* Mobile: deploy detail as overlay when a deploy is selected */}
        {isMobile && selectedDeployId && selectedRecord && (
          <>
            {createPortal(
              <div
                className="fixed inset-0 z-40"
                aria-modal="true"
                role="dialog"
                aria-label="Deployment detail"
              >
                <button
                  type="button"
                  onClick={handleCloseDetailOverlay}
                  className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                  aria-label="Close deployment detail (backdrop)"
                />
                <div className="absolute inset-x-0 bottom-0 top-1/4 bg-theme-surface rounded-t-xl shadow-xl flex flex-col max-h-[90vh]">
                  <div className="px-4 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0 border-b border-theme-border">
                    <h3 className="text-sm font-medium text-theme-text">
                      {selectedRecord ? `Delivery ${formatDate(selectedRecord.startedAt)}` : "Live Log"}
                    </h3>
                    <div className="flex flex-wrap items-center gap-2 min-h-[44px]">
                      {canRollback && (
                        <button
                          type="button"
                          onClick={handleRollback}
                          disabled={rollbackLoading}
                          className="min-h-[44px] min-w-[44px] text-sm text-theme-warning-text hover:opacity-80 disabled:opacity-50 flex items-center justify-center"
                        >
                          {rollbackLoading ? "Rolling back…" : "Rollback"}
                        </button>
                      )}
                      <CloseButton
                        onClick={handleCloseDetailOverlay}
                        ariaLabel="Close deployment detail"
                        className="p-2 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors bg-theme-surface"
                        size="w-5 h-5"
                      />
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 min-h-0">
                    {expoDeployError && (
                      <div
                        className="mb-4 p-4 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text whitespace-pre-wrap"
                        data-testid="expo-deploy-auth-error"
                      >
                        {expoDeployError}
                        {(onOpenGlobalSettings ?? onOpenSettings) && (
                          <div className="mt-3">
                            <button
                              type="button"
                              onClick={onOpenGlobalSettings ?? onOpenSettings}
                              className="text-brand-600 hover:text-brand-700 font-medium underline"
                              data-testid="expo-auth-settings-link"
                            >
                              Open Settings to add Expo API Token →
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    <pre
                      className="text-xs font-mono whitespace-pre-wrap text-theme-text bg-theme-code-bg text-theme-code-text p-4 rounded-lg"
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
                              onClick={() =>
                                navigate(getProjectPhasePath(effectiveProjectId, "execute"))
                              }
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
              </div>,
              document.body
            )}
          </>
        )}
      </div>
    </div>
  );
}
