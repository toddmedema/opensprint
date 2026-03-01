import { useState, useEffect, useRef } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useDisplayPreferences } from "../contexts/DisplayPreferencesContext";
import type { RunningAgentsDisplayMode } from "../lib/displayPrefs";
import { api, isConnectionError } from "../api/client";
import { ApiKeysSection } from "./ApiKeysSection";
import type { ApiKeys, MaskedApiKeys } from "@opensprint/shared";
import { API_KEY_PROVIDERS } from "@opensprint/shared";

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
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878a4.5 4.5 0 106.262 6.262M4.031 11.117A9.956 9.956 0 004 12c0 4.478 2.943 8.268 7 9.542 1.274.357 2.648.542 4 .542.89 0 1.76-.127 2.587-.364m-1.746-1.746A9.958 9.958 0 015.458 12"
      />
    </svg>
  );
}

/**
 * Shared display settings content: theme and running agents display mode.
 * Used in DisplaySettingsModal (global) and ProjectSettingsModal (Display mode).
 * All settings are stored globally (localStorage at opensprint.theme, opensprint.runningAgentsDisplayMode).
 */
export function DisplaySettingsContent() {
  const { preference: themePreference, setTheme } = useTheme();
  const { runningAgentsDisplayMode, setRunningAgentsDisplayMode } = useDisplayPreferences();

  const [apiKeys, setApiKeys] = useState<ApiKeys | MaskedApiKeys | undefined>(undefined);
  const [apiKeysError, setApiKeysError] = useState<string | null>(null);
  const [databaseUrl, setDatabaseUrl] = useState<string>("");
  const databaseUrlRef = useRef(databaseUrl);
  databaseUrlRef.current = databaseUrl;
  const [databaseUrlLoading, setDatabaseUrlLoading] = useState(true);
  const [databaseUrlSaving, setDatabaseUrlSaving] = useState(false);
  const [databaseUrlError, setDatabaseUrlError] = useState<string | null>(null);
  const [showDatabaseUrl, setShowDatabaseUrl] = useState(false);

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
      .finally(() => setDatabaseUrlLoading(false));
  }, []);

  const handleApiKeysChange = async (
    updates: Partial<Record<"ANTHROPIC_API_KEY" | "CURSOR_API_KEY", Array<{ id: string; value?: string; limitHitAt?: string }>>>
  ) => {
    setApiKeysError(null);
    const merged: ApiKeys = {
      ...(apiKeys as ApiKeys),
      ...updates,
    };
    try {
      const res = await api.globalSettings.put({ apiKeys: merged });
      setApiKeys(res.apiKeys);
    } catch (err) {
      const message = isConnectionError(err)
        ? "Unable to connect. Please check your network and try again."
        : err instanceof Error
          ? err.message
          : "Failed to save";
      setApiKeysError(message);
    }
  };

  return (
    <div className="space-y-6" data-testid="display-section">
      <div data-testid="api-keys-section-wrapper">
        <ApiKeysSection
          apiKeys={apiKeys}
          providers={API_KEY_PROVIDERS}
          variant="global"
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
                onBlur={async () => {
                  const trimmed = databaseUrlRef.current.trim();
                  if (!trimmed) return;
                  if (trimmed.includes("***")) {
                    setDatabaseUrlError("Enter the full connection URL to save changes");
                    return;
                  }
                  setDatabaseUrlError(null);
                  setDatabaseUrlSaving(true);
                  try {
                    const res = await api.globalSettings.put({ databaseUrl: trimmed });
                    setDatabaseUrl(res.databaseUrl);
                  } catch (err) {
                    setDatabaseUrlError(
                      isConnectionError(err)
                        ? "Unable to connect. Please check your network and try again."
                        : err instanceof Error
                          ? err.message
                          : "Failed to save"
                    );
                  } finally {
                    setDatabaseUrlSaving(false);
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
        </div>
        {databaseUrlError && (
          <p className="text-sm text-theme-error-text mt-2" role="alert">
            {databaseUrlError}
          </p>
        )}
      </div>
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
          onChange={(e) =>
            setRunningAgentsDisplayMode(e.target.value as RunningAgentsDisplayMode)
          }
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
