import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "../contexts/ThemeContext";
import { useDisplayPreferences } from "../contexts/DisplayPreferencesContext";
import type { RunningAgentsDisplayMode } from "../lib/displayPrefs";
import { api, isConnectionError } from "../api/client";
import { DB_STATUS_QUERY_KEY } from "../api/hooks/db-status";
import { ApiKeysSection } from "./ApiKeysSection";
import { CloseButton } from "./CloseButton";
import type {
  ApiKeyEntry,
  ApiKeys,
  ApiKeyUpdateEntry,
  ApiKeysUpdate,
  MaskedApiKeyEntry,
  MaskedApiKeys,
} from "@opensprint/shared";
import { API_KEY_PROVIDERS } from "@opensprint/shared";
import type { SaveStatus } from "./SaveIndicator";

/** Minimum time (ms) the Saving spinner is visible, regardless of request completion time */
const MIN_SAVE_SPINNER_MS = 500;

const THEME_OPTIONS: { value: "light" | "dark" | "system"; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const RUNNING_AGENTS_DISPLAY_OPTIONS: { value: RunningAgentsDisplayMode; label: string }[] = [
  { value: "count", label: "Count" },
  { value: "icons", label: "Icons" },
  { value: "both", label: "Both" },
];

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
      />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.98 8.22A10.48 10.48 0 001.93 12C3.23 16.34 7.24 19.5 12 19.5c.99 0 1.95-.14 2.86-.4M6.23 6.23A10.45 10.45 0 0112 4.5c4.76 0 8.77 3.16 10.07 7.5-.72 2.39-2.26 4.43-4.3 5.77M6.23 6.23L3 3M6.23 6.23l3.65 3.65M17.77 17.77L21 21M17.77 17.77l-3.65-3.65M14.12 14.12a3 3 0 11-4.24-4.24M14.12 14.12L9.88 9.88"
      />
    </svg>
  );
}

export interface GlobalSettingsContentProps {
  /** Called when save state changes (for indicator and beforeunload) */
  onSaveStateChange?: (status: SaveStatus) => void;
}

/**
 * Single source component for global settings: API keys, database URL, theme, running agents display mode.
 * Used by both the homepage Settings page and the project-view Global settings tab.
 * All settings and inputs are defined here; adding a new setting requires changes in only one location.
 */
export function GlobalSettingsContent({ onSaveStateChange }: GlobalSettingsContentProps = {}) {
  const queryClient = useQueryClient();
  const { preference: themePreference, setTheme } = useTheme();
  const { runningAgentsDisplayMode, setRunningAgentsDisplayMode } = useDisplayPreferences();

  const [apiKeys, setApiKeys] = useState<ApiKeys | MaskedApiKeys | undefined>(undefined);
  const [apiKeysError, setApiKeysError] = useState<string | null>(null);
  const [databaseUrl, setDatabaseUrl] = useState<string>("");
  const databaseUrlRef = useRef(databaseUrl);
  databaseUrlRef.current = databaseUrl;
  const [databaseUrlLoading, setDatabaseUrlLoading] = useState(true);
  const [, setDatabaseUrlSaving] = useState(false);
  const [databaseUrlError, setDatabaseUrlError] = useState<string | null>(null);
  const [showDatabaseUrl, setShowDatabaseUrl] = useState(false);
  const [setupTablesDialogOpen, setSetupTablesDialogOpen] = useState(false);
  const [setupTablesLoading, setSetupTablesLoading] = useState(false);
  const [setupTablesError, setSetupTablesError] = useState<string | null>(null);
  const initialLoadRef = useRef(true);

  const notifySaveState = useCallback(
    (status: SaveStatus) => {
      onSaveStateChange?.(status);
    },
    [onSaveStateChange]
  );

  const saveGenerationRef = useRef(0);
  const saveCompleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSaveComplete = useCallback(
    (startTime: number) => {
      const completedGeneration = saveGenerationRef.current;
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, MIN_SAVE_SPINNER_MS - elapsed);
      const run = () => {
        if (saveGenerationRef.current === completedGeneration) {
          notifySaveState("saved");
        }
      };
      if (remaining > 0) {
        saveCompleteTimeoutRef.current = setTimeout(run, remaining);
      } else {
        run();
      }
    },
    [notifySaveState]
  );

  useEffect(() => {
    return () => {
      if (saveCompleteTimeoutRef.current) {
        clearTimeout(saveCompleteTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setDatabaseUrlLoading(true);
    api.globalSettings
      .get()
      .then((res) => {
        setDatabaseUrl(res.databaseUrl ?? "");
        setApiKeys(res.apiKeys);
      })
      .catch(() => {
        setDatabaseUrl("");
        setApiKeys(undefined);
      })
      .finally(() => {
        setDatabaseUrlLoading(false);
        initialLoadRef.current = false;
      });
  }, []);

  // Debounced save for database URL when value changes (immediate save on change)
  useEffect(() => {
    if (databaseUrlLoading || initialLoadRef.current) return;
    const trimmed = databaseUrl.trim();
    if (!trimmed || trimmed.includes("***")) return;

    const t = setTimeout(() => {
      setDatabaseUrlError(null);
      setDatabaseUrlSaving(true);
      saveGenerationRef.current += 1;
      const startTime = Date.now();
      notifySaveState("saving");
      api.globalSettings
        .put({ databaseUrl: trimmed })
        .then((res) => {
          setDatabaseUrl(res.databaseUrl);
          void queryClient.invalidateQueries({ queryKey: DB_STATUS_QUERY_KEY });
          scheduleSaveComplete(startTime);
        })
        .catch((err) => {
          setDatabaseUrlError(
            isConnectionError(err)
              ? "Unable to connect. Please check your network and try again."
              : err instanceof Error
                ? err.message
                : "Failed to save"
          );
          scheduleSaveComplete(startTime);
        })
        .finally(() => {
          setDatabaseUrlSaving(false);
        });
    }, 300);
    return () => clearTimeout(t);
  }, [databaseUrl, databaseUrlLoading, notifySaveState, queryClient, scheduleSaveComplete]);

  const handleClearLimitHit = useCallback(
    async (
      provider: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY",
      id: string
    ) => {
      setApiKeysError(null);
      saveGenerationRef.current += 1;
      const startTime = Date.now();
      notifySaveState("saving");
      try {
        const res = await api.globalSettings.clearLimitHit(provider, id);
        setApiKeys(res.apiKeys);
        scheduleSaveComplete(startTime);
      } catch (err) {
        const message = isConnectionError(err)
          ? "Unable to connect. Please check your network and try again."
          : err instanceof Error
            ? err.message
            : "Failed to clear limit";
        setApiKeysError(message);
        scheduleSaveComplete(startTime);
      }
    },
    [notifySaveState, scheduleSaveComplete]
  );

  const handleApiKeysChange = async (updates: ApiKeysUpdate) => {
    setApiKeysError(null);
    saveGenerationRef.current += 1;
    const startTime = Date.now();
    notifySaveState("saving");
    const merged: ApiKeysUpdate = {};
    for (const provider of API_KEY_PROVIDERS) {
      const currentEntries = (apiKeys?.[provider] ?? []).flatMap(
        (entry: ApiKeyEntry | MaskedApiKeyEntry) => {
          const id = typeof entry.id === "string" ? entry.id.trim() : "";
          if (!id) return [];
          const preserved: ApiKeyUpdateEntry = {
            id,
            ...(entry.limitHitAt ? { limitHitAt: entry.limitHitAt } : {}),
          };
          if ("value" in entry && typeof entry.value === "string" && entry.value) {
            preserved.value = entry.value;
          }
          return [preserved];
        }
      );
      const nextEntries = updates[provider];
      const sourceEntries = nextEntries ?? currentEntries;
      const normalizedEntries = sourceEntries.flatMap((entry: ApiKeyUpdateEntry) => {
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        if (!id) return [];
        const normalized: ApiKeyUpdateEntry = {
          id,
          ...(entry.limitHitAt ? { limitHitAt: entry.limitHitAt } : {}),
        };
        if (typeof entry.value === "string" && entry.value) {
          normalized.value = entry.value;
        }
        return [normalized];
      });
      if (normalizedEntries.length > 0) {
        merged[provider] = normalizedEntries;
      }
    }
    try {
      const res = await api.globalSettings.put({ apiKeys: merged });
      setApiKeys(res.apiKeys);
      scheduleSaveComplete(startTime);
    } catch (err) {
      const message = isConnectionError(err)
        ? "Unable to connect. Please check your network and try again."
        : err instanceof Error
          ? err.message
          : "Failed to save";
      setApiKeysError(message);
      scheduleSaveComplete(startTime);
    }
  };

  const handleSetupTablesConfirm = useCallback(async () => {
    const trimmed = databaseUrlRef.current.trim();
    if (!trimmed || trimmed.includes("***")) return;
    setSetupTablesError(null);
    setSetupTablesLoading(true);
    try {
      await api.globalSettings.setupTables(trimmed);
      void queryClient.invalidateQueries({ queryKey: DB_STATUS_QUERY_KEY });
      setSetupTablesDialogOpen(false);
    } catch (err) {
      setSetupTablesError(
        isConnectionError(err)
          ? "Unable to connect. Please check your network and try again."
          : err instanceof Error
            ? err.message
            : "Failed to set up tables"
      );
    } finally {
      setSetupTablesLoading(false);
    }
  }, [queryClient]);

  const showSetupTablesButton = databaseUrl.trim().length > 0 && !databaseUrl.includes("***");

  return (
    <div className="space-y-6" data-testid="global-settings-content">
      <div data-testid="api-keys-section-wrapper">
        <ApiKeysSection
          apiKeys={apiKeys}
          providers={API_KEY_PROVIDERS}
          variant="global"
          onRevealKey={(provider, id) =>
            api.globalSettings.revealKey(provider, id).then((r) => r.value)
          }
          onClearLimitHit={handleClearLimitHit}
          onApiKeysChange={handleApiKeysChange}
        />
        {apiKeysError && (
          <p className="text-sm text-theme-error-text mt-2" role="alert">
            {apiKeysError}
          </p>
        )}
      </div>
      <div data-testid="database-url-section">
        <h3 className="text-sm font-semibold text-theme-text">Database URL</h3>
        <p className="text-xs text-theme-muted mb-3">
          PostgreSQL connection URL for tasks, feedback, and sessions. Default: local Docker. Use a
          remote URL (e.g. Supabase) for hosted deployments. Password is hidden in display.
        </p>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <div className="relative flex">
              <input
                type={showDatabaseUrl ? "text" : "password"}
                className="input font-mono text-sm w-full pr-10"
                placeholder="postgresql://user:password@host:port/database"
                value={databaseUrl}
                onChange={(e) => {
                  setDatabaseUrl(e.target.value);
                  setDatabaseUrlError(null);
                }}
                onBlur={() => {
                  const trimmed = databaseUrlRef.current.trim();
                  if (trimmed && trimmed.includes("***")) {
                    setDatabaseUrlError("Enter the full connection URL to save changes");
                  } else {
                    setDatabaseUrlError(null);
                  }
                }}
                disabled={databaseUrlLoading}
                autoComplete="off"
                data-testid="database-url-input"
              />
              <button
                type="button"
                onClick={() => setShowDatabaseUrl((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-theme-muted hover:text-theme-text p-1"
                aria-label={showDatabaseUrl ? "Hide database URL" : "Show database URL"}
              >
                {showDatabaseUrl ? (
                  <EyeOffIcon className="w-4 h-4" />
                ) : (
                  <EyeIcon className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
          {showSetupTablesButton && (
            <button
              type="button"
              onClick={() => setSetupTablesDialogOpen(true)}
              disabled={databaseUrlLoading}
              className="btn-secondary"
              data-testid="setup-tables-button"
            >
              Set up tables
            </button>
          )}
        </div>
        {databaseUrlError && (
          <p className="text-sm text-theme-error-text mt-2" role="alert">
            {databaseUrlError}
          </p>
        )}
      </div>
      {setupTablesDialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          data-testid="setup-tables-dialog"
        >
          <div
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
            onClick={() => !setupTablesLoading && setSetupTablesDialogOpen(false)}
          />
          <div
            className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border">
              <h2 className="text-lg font-semibold text-theme-text">Set up tables</h2>
              <CloseButton
                onClick={() => !setupTablesLoading && setSetupTablesDialogOpen(false)}
                ariaLabel="Close setup tables confirmation"
              />
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-sm text-theme-text">
                Data loss may occur. Please confirm that you&apos;ve backed up any important data in
                this database before proceeding.
              </p>
              {setupTablesError && (
                <p className="text-sm text-theme-error-text" role="alert">
                  {setupTablesError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
              <button
                type="button"
                onClick={() => !setupTablesLoading && setSetupTablesDialogOpen(false)}
                className="btn-secondary"
                disabled={setupTablesLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSetupTablesConfirm()}
                disabled={setupTablesLoading}
                className="btn-primary disabled:opacity-50"
                data-testid="setup-tables-confirm"
              >
                {setupTablesLoading ? "Setting up…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
      <div>
        <h3 className="text-sm font-semibold text-theme-text">Theme</h3>
        <p className="text-xs text-theme-muted mb-3">
          Choose how Open Sprint looks. System follows your operating system preference.
        </p>
        <div className="flex gap-2 flex-wrap">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTheme(opt.value)}
              data-testid={`theme-option-${opt.value}`}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                themePreference === opt.value
                  ? "bg-brand-600 text-white"
                  : "bg-theme-border-subtle text-theme-text hover:bg-theme-bg-elevated"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-theme-text">Running agents display mode</h3>
        <p className="text-xs text-theme-muted mb-3">
          How to show running agents in the navbar and execute view: count only, icons only, or
          both.
        </p>
        <select
          value={runningAgentsDisplayMode}
          onChange={(e) => setRunningAgentsDisplayMode(e.target.value as RunningAgentsDisplayMode)}
          data-testid="running-agents-display-mode"
          className="input w-full max-w-xs"
        >
          {RUNNING_AGENTS_DISPLAY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
