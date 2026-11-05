import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "../../api/client";
import { queryKeys } from "../../api/queryKeys";
import type { IntegrationSourceOption } from "@opensprint/shared";

interface GitHubIntegrationCardProps {
  projectId: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATUS_BADGE = {
  active: { label: "Connected", className: "text-green-400 bg-green-500/10" },
  needs_reconnect: { label: "Needs Reconnect", className: "text-orange-400 bg-orange-500/10" },
  disconnected: {
    label: "Not Connected",
    className: "text-theme-text-secondary bg-theme-surface-hover",
  },
  loading: { label: "Loading…", className: "text-theme-text-secondary bg-theme-surface-hover" },
} as const;

const primaryBtn =
  "px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const secondaryBtn =
  "px-2 py-1 bg-theme-surface-hover hover:bg-theme-border text-theme-text text-xs rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const dangerBtn =
  "px-2 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

function GitHubIcon() {
  return (
    <div
      className="w-7 h-7 rounded-md bg-[#24292f] dark:bg-[#f0f6fc] flex items-center justify-center flex-shrink-0"
      aria-hidden="true"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="text-white dark:text-[#24292f]"
      >
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
    </div>
  );
}

export function GitHubIntegrationCard({ projectId }: GitHubIntegrationCardProps) {
  const queryClient = useQueryClient();
  const [tokenInput, setTokenInput] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{
    text: string;
    severity: "success" | "error" | "warning";
  } | null>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [, setTick] = useState(0);

  const statusQuery = useQuery({
    queryKey: queryKeys.integrations.githubStatus(projectId),
    queryFn: () => api.integrations.github.getStatus(projectId),
    retry: false,
  });

  const connectMutation = useMutation({
    mutationFn: (token: string) => api.integrations.github.connect(projectId, { token }),
    onSuccess: () => {
      setTokenInput("");
      setShowTokenForm(false);
      setPickerOpen(false);
      setSelectedRepoId("");
      setSyncMessage(null);
      queryClient.removeQueries({ queryKey: queryKeys.integrations.githubRepos(projectId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.integrations.githubStatus(projectId),
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.integrations.github.disconnect(projectId),
    onSuccess: () => {
      setShowDisconnectConfirm(false);
      setPickerOpen(false);
      setSelectedRepoId("");
      setSyncMessage(null);
      queryClient.removeQueries({ queryKey: queryKeys.integrations.githubRepos(projectId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.integrations.githubStatus(projectId),
      });
    },
  });

  const shouldShowPicker =
    pickerOpen || (!!statusQuery.data?.connected && !statusQuery.data?.selectedSource);

  const reposQuery = useQuery({
    queryKey: queryKeys.integrations.githubRepos(projectId),
    queryFn: () => api.integrations.github.listRepos(projectId),
    enabled: shouldShowPicker && statusQuery.data?.status === "active",
    retry: 1,
    staleTime: 30_000,
  });

  const selectRepoMutation = useMutation({
    mutationFn: (repo: IntegrationSourceOption) =>
      api.integrations.github.selectRepo(projectId, {
        repoId: repo.id,
        repoFullName: repo.name,
      }),
    onSuccess: () => {
      setSaveSuccess(true);
      setPickerOpen(false);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.integrations.githubStatus(projectId),
      });
      setTimeout(() => setSaveSuccess(false), 3_000);
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.integrations.githubStatus(projectId),
      });
    },
  });

  const syncNowMutation = useMutation({
    mutationFn: () => api.integrations.github.syncNow(projectId),
    onSuccess: (data) => {
      setSyncMessage({
        text:
          data.errors > 0
            ? `${data.imported} plan${data.imported === 1 ? "" : "s"} created; ${data.errors} issue${data.errors === 1 ? "" : "s"} could not be imported. Sync again to retry.`
            : data.imported === 0
              ? "No new plans. Previously imported issues are already tracked."
              : `${data.imported} plan${data.imported === 1 ? "" : "s"} created from GitHub issues`,
        severity: data.errors > 0 ? "warning" : "success",
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.integrations.githubStatus(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.plans.list(projectId),
      });
    },
    onError: (error) => {
      if (
        isApiError(error) &&
        (error.code === "RATE_LIMITED" || error.code === "SYNC_RATE_LIMITED")
      ) {
        setSyncMessage({
          text: "Please wait before syncing again",
          severity: "warning",
        });
      } else {
        setSyncMessage({
          text: error instanceof Error ? error.message : "Sync failed",
          severity: "error",
        });
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.integrations.githubStatus(projectId),
      });
    },
  });

  const refreshStatus = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.integrations.githubStatus(projectId),
    });
  }, [queryClient, projectId]);

  useEffect(() => {
    if (pickerOpen && !selectedRepoId && statusQuery.data?.selectedSource?.id) {
      setSelectedRepoId(statusQuery.data.selectedSource.id);
    }
  }, [pickerOpen, selectedRepoId, statusQuery.data?.selectedSource?.id]);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  const lastError = statusQuery.data?.lastError;
  useEffect(() => {
    setErrorDismissed(false);
  }, [lastError]);

  useEffect(() => {
    if (
      isApiError(reposQuery.error) &&
      (reposQuery.error.code === "GITHUB_AUTH_FAILED" ||
        reposQuery.error.code === "NEEDS_RECONNECT")
    ) {
      refreshStatus();
    }
  }, [reposQuery.error, refreshStatus]);

  const badge = statusQuery.isLoading
    ? STATUS_BADGE.loading
    : !statusQuery.data?.connected
      ? STATUS_BADGE.disconnected
      : statusQuery.data.status === "needs_reconnect"
        ? STATUS_BADGE.needs_reconnect
        : STATUS_BADGE.active;

  // Loading
  if (statusQuery.isLoading) {
    return <Shell description="Import open GitHub issues as plans" badge={badge} />;
  }

  // Error fetching status
  if (statusQuery.isError) {
    return (
      <Shell
        description="Import open GitHub issues as plans"
        badge={STATUS_BADGE.disconnected}
        footer={
          <button type="button" className={secondaryBtn} onClick={refreshStatus}>
            Retry
          </button>
        }
      >
        <div className="p-3 rounded-lg bg-theme-error-bg border border-theme-error-border">
          <p className="text-xs text-theme-error-text">
            Failed to load GitHub status. Please try again.
          </p>
        </div>
      </Shell>
    );
  }

  const status = statusQuery.data;

  // Disconnected
  if (!status?.connected) {
    return (
      <Shell
        description="Import open GitHub issues as plans"
        badge={STATUS_BADGE.disconnected}
        footer={
          !showTokenForm ? (
            <button
              type="button"
              className={primaryBtn}
              onClick={() => setShowTokenForm(true)}
              data-testid="github-connect-btn"
            >
              Connect
            </button>
          ) : undefined
        }
      >
        {showTokenForm && (
          <div className="space-y-2" data-testid="github-token-form">
            <label htmlFor="github-pat-input" className="block text-xs font-medium text-theme-text">
              GitHub Personal Access Token
            </label>
            <p className="text-[10px] text-theme-muted">
              Create a{" "}
              <a
                href="https://github.com/settings/tokens?type=beta"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                fine-grained PAT
              </a>{" "}
              with <strong>Issues: Read-only</strong> and <strong>Metadata: Read-only</strong>{" "}
              permissions. Your token is stored locally and encrypted at rest.
            </p>
            <input
              id="github-pat-input"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="github_pat_..."
              className="w-full text-sm rounded border border-theme-border bg-theme-bg px-2 py-1.5 text-theme-text font-mono"
              autoComplete="off"
              data-testid="github-pat-input"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={primaryBtn}
                disabled={!tokenInput.trim() || connectMutation.isPending}
                onClick={() => connectMutation.mutate(tokenInput.trim())}
                data-testid="github-save-token-btn"
              >
                {connectMutation.isPending ? "Connecting…" : "Save & Connect"}
              </button>
              <button
                type="button"
                className={secondaryBtn}
                onClick={() => {
                  setShowTokenForm(false);
                  setTokenInput("");
                }}
              >
                Cancel
              </button>
            </div>
            {connectMutation.isError && (
              <p className="text-xs text-theme-error-text" data-testid="github-connect-error">
                {isApiError(connectMutation.error) && connectMutation.error.code === "INVALID_TOKEN"
                  ? "Invalid token. Please check the token and permissions."
                  : "Failed to connect. Please try again."}
              </p>
            )}
          </div>
        )}
      </Shell>
    );
  }

  // Connected
  const needsReconnect = status.status === "needs_reconnect";
  const userName = status.user?.id ?? "Unknown";
  const selectedSource = status.selectedSource;
  const repos = reposQuery.data?.repos ?? [];

  return (
    <Shell
      description="Import open GitHub issues as plans"
      badge={badge}
      footer={
        <>
          {selectedSource && (
            <button
              type="button"
              className={`${secondaryBtn} inline-flex items-center gap-1.5`}
              onClick={() => syncNowMutation.mutate()}
              disabled={syncNowMutation.isPending || needsReconnect || selectRepoMutation.isPending}
              data-testid="github-sync-now-btn"
            >
              {syncNowMutation.isPending && (
                <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              )}
              {syncNowMutation.isPending ? "Syncing…" : "Sync issues to plans"}
            </button>
          )}
          {!showDisconnectConfirm ? (
            <button
              type="button"
              className={`${dangerBtn} ${selectedSource ? "ml-auto" : ""}`}
              onClick={() => setShowDisconnectConfirm(true)}
              data-testid="github-disconnect-btn"
            >
              Disconnect
            </button>
          ) : null}
          {showDisconnectConfirm && (
            <div
              className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-theme-error-bg border border-theme-error-border w-full"
              data-testid="github-disconnect-confirm"
            >
              <p className="text-xs text-theme-error-text flex-1 min-w-[12rem]">
                This will remove your stored GitHub token. Imported plans will be kept. Continue?
              </p>
              <button
                type="button"
                className="text-xs font-medium text-theme-error-text hover:underline"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
                data-testid="github-disconnect-confirm-btn"
              >
                {disconnectMutation.isPending ? "Disconnecting…" : "Yes, disconnect"}
              </button>
              <button
                type="button"
                className="text-xs text-theme-muted hover:underline"
                onClick={() => setShowDisconnectConfirm(false)}
                data-testid="github-disconnect-cancel-btn"
              >
                Cancel
              </button>
            </div>
          )}
        </>
      }
    >
      <p className="text-xs text-theme-text-secondary">
        Each open issue becomes a plan in Planning. Sync again to import new issues; existing plans
        and your edits are kept. Nothing starts automatically or changes on GitHub.
      </p>
      <p className="text-xs text-theme-muted break-words" data-testid="github-status-line">
        Connected as {userName}
        {selectedSource && <> · Repo: {selectedSource.name}</>}
        {status.lastSyncAt && <> · Last sync: {relativeTime(status.lastSyncAt)}</>}
      </p>

      {needsReconnect && (
        <div
          className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
          data-testid="github-reconnect-banner"
        >
          <p className="text-xs text-theme-warning-text">
            Your GitHub token is no longer valid. Please reconnect with a new token.
          </p>
          <button
            type="button"
            className={`${secondaryBtn} mt-2`}
            onClick={() => setShowTokenForm(true)}
            data-testid="github-reconnect-btn"
          >
            Reconnect
          </button>
          {showTokenForm && (
            <div className="mt-2 space-y-2">
              <input
                type="password"
                aria-label="New GitHub Personal Access Token"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="github_pat_..."
                className="w-full text-sm rounded border border-theme-border bg-theme-bg px-2 py-1.5 text-theme-text font-mono"
                autoComplete="off"
              />
              <button
                type="button"
                className={primaryBtn}
                disabled={!tokenInput.trim() || connectMutation.isPending}
                onClick={() => connectMutation.mutate(tokenInput.trim())}
              >
                {connectMutation.isPending ? "Connecting…" : "Save & Connect"}
              </button>
            </div>
          )}
        </div>
      )}

      {status.lastError && !needsReconnect && !errorDismissed && (
        <div
          className="p-3 rounded-lg bg-theme-error-bg border border-theme-error-border"
          data-testid="github-error-banner"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs text-theme-error-text">{status.lastError}</p>
              <p className="text-xs text-theme-error-text mt-1 opacity-75">
                Check your GitHub token or try syncing again.
              </p>
            </div>
            <button
              type="button"
              className="text-theme-error-text hover:opacity-70 flex-shrink-0"
              onClick={() => setErrorDismissed(true)}
              aria-label="Dismiss error"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      {shouldShowPicker ? (
        <RepoPicker
          repos={repos}
          isLoading={reposQuery.isLoading || reposQuery.isFetching}
          isError={reposQuery.isError}
          selectedRepoId={selectedRepoId}
          selectMutation={selectRepoMutation}
          existingSource={selectedSource ?? null}
          onSelectChange={setSelectedRepoId}
          onCancel={() => {
            setPickerOpen(false);
            setSelectedRepoId(selectedSource?.id ?? "");
          }}
          onRetry={() => void reposQuery.refetch()}
        />
      ) : selectedSource ? (
        <div data-testid="github-repo-info">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-theme-muted">
              Repo:{" "}
              <span className="font-medium text-theme-text break-all">{selectedSource.name}</span>
            </span>
            <button
              type="button"
              className="text-xs text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => {
                setPickerOpen(true);
                setSelectedRepoId(selectedSource.id);
              }}
              data-testid="github-change-repo-btn"
            >
              Change
            </button>
          </div>
          {saveSuccess && (
            <p
              className="text-xs text-green-600 dark:text-green-400 mt-1"
              data-testid="github-save-success"
            >
              Repository saved successfully.
            </p>
          )}
        </div>
      ) : null}

      {selectedSource && (
        <div className="space-y-2" data-testid="github-sync-section">
          {syncMessage && (
            <p
              className={`text-xs ${
                syncMessage.severity === "success"
                  ? "text-green-600 dark:text-green-400"
                  : syncMessage.severity === "warning"
                    ? "text-theme-warning-text"
                    : "text-theme-error-text"
              }`}
              role={syncMessage.severity === "error" ? "alert" : "status"}
              data-testid="github-sync-message"
            >
              {syncMessage.text}
            </p>
          )}
          <a
            href={`/projects/${encodeURIComponent(projectId)}/plan`}
            className="text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            View plans
          </a>
        </div>
      )}
    </Shell>
  );
}

function Shell({
  description,
  badge,
  children,
  footer,
}: {
  description: string;
  badge: { label: string; className: string };
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border border-theme-border bg-theme-surface p-4 flex flex-col gap-3 h-full"
      data-testid="github-integration-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <GitHubIcon />
          <div className="min-w-0">
            <p className="text-sm font-medium text-theme-text">GitHub Issues</p>
            <p className="text-xs text-theme-text-secondary">{description}</p>
          </div>
        </div>
        <span
          className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-medium ${badge.className}`}
          data-testid="github-status-badge"
        >
          {badge.label}
        </span>
      </div>
      {children}
      {footer != null ? (
        <div className="flex flex-wrap items-center gap-2 mt-auto pt-2 border-t border-theme-border">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function RepoPicker({
  repos,
  isLoading,
  isError,
  selectedRepoId,
  selectMutation,
  existingSource,
  onSelectChange,
  onCancel,
  onRetry,
}: {
  repos: IntegrationSourceOption[];
  isLoading: boolean;
  isError: boolean;
  selectedRepoId: string;
  selectMutation: {
    isPending: boolean;
    isError: boolean;
    mutate: (repo: IntegrationSourceOption) => void;
  };
  existingSource: { id: string; name: string } | null;
  onSelectChange: (id: string) => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const hasRepos = repos.length > 0;

  const handleSave = () => {
    const repo = repos.find((r) => r.id === selectedRepoId);
    if (repo) selectMutation.mutate(repo);
  };

  return (
    <div data-testid="github-repo-picker">
      <label
        htmlFor="github-repo-select"
        className="block text-xs font-medium text-theme-text mb-1"
      >
        {existingSource ? "Change repository" : "Select a repository"}
      </label>

      {isLoading && !hasRepos && (
        <div className="flex items-center gap-2 py-2" data-testid="github-repos-loading">
          <div className="w-4 h-4 border-2 border-theme-border border-t-blue-500 rounded-full animate-spin" />
          <span className="text-xs text-theme-muted">Loading repositories…</span>
        </div>
      )}

      {isError && !hasRepos && (
        <div
          className="p-3 rounded-lg bg-theme-error-bg border border-theme-error-border"
          data-testid="github-repos-error"
        >
          <p className="text-xs text-theme-error-text">Failed to load repositories.</p>
          <button
            type="button"
            className="text-xs text-theme-error-text font-medium hover:underline mt-1"
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      )}

      {(hasRepos || (!isLoading && !isError)) && (
        <>
          <select
            id="github-repo-select"
            className="w-full text-sm rounded border border-theme-border bg-theme-bg px-2 py-1.5 text-theme-text"
            value={selectedRepoId}
            onChange={(e) => onSelectChange(e.target.value)}
            disabled={selectMutation.isPending}
            data-testid="github-repo-select"
          >
            <option value="">Select a repository…</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.itemCount != null ? ` (${r.itemCount} open issues)` : ""}
              </option>
            ))}
          </select>

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className={primaryBtn}
              disabled={!selectedRepoId || selectMutation.isPending}
              onClick={handleSave}
              data-testid="github-save-repo-btn"
            >
              {selectMutation.isPending ? "Saving…" : "Save"}
            </button>
            {existingSource && (
              <button
                type="button"
                className={secondaryBtn}
                onClick={onCancel}
                disabled={selectMutation.isPending}
                data-testid="github-cancel-picker-btn"
              >
                Cancel
              </button>
            )}
          </div>

          {selectMutation.isError && (
            <p className="text-xs text-theme-error-text mt-2" data-testid="github-save-error">
              Failed to save repository selection. Please try again.
            </p>
          )}
        </>
      )}
    </div>
  );
}
