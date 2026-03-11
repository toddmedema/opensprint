import { useEffect, useState } from "react";
import { CloseButton } from "./CloseButton";
import { api, isConnectionError } from "../api/client";
import {
  AGENT_PROVIDER_OPTIONS,
  type AgentProviderValue,
} from "../lib/agentProviders";

const BODY_COPY =
  "At least one agent API key is required to use Open Sprint. Or, select 'Custom/CLI' if you'll be using your own agent or a CLI integration rather than an API.";

const NO_KEY_MESSAGE = "No API key needed — you're good to go.";

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

export interface ApiKeySetupModalProps {
  onComplete: () => void;
  onCancel: () => void;
  intendedRoute: string;
}

/**
 * Modal for entering an agent API key when user has none and has not selected Custom/CLI.
 * Shown when clicking Create New or Add Existing without keys configured.
 */
export function ApiKeySetupModal({
  onComplete,
  onCancel,
  intendedRoute: _intendedRoute,
}: ApiKeySetupModalProps) {
  const [provider, setProvider] = useState<AgentProviderValue>("claude");
  const [keyValue, setKeyValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerOption = AGENT_PROVIDER_OPTIONS.find((o) => o.value === provider);
  const needsKeyInput = providerOption?.needsKeyInput ?? true;

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      if (provider === "lmstudio") {
        onComplete();
        setSaving(false);
        return;
      }
      if (provider === "custom") {
        await api.env.setGlobalSettings({ useCustomCli: true });
      } else {
        const value = keyValue.trim();
        if (!value) {
          setError("Please enter an API key");
          setSaving(false);
          return;
        }
        const apiProvider: "claude" | "cursor" | "openai" | "google" =
          provider === "claude"
            ? "claude"
            : provider === "cursor"
              ? "cursor"
              : provider === "openai"
                ? "openai"
                : "google";
        const { valid, error: validateError } = await api.env.validateKey(apiProvider, value);
        if (!valid) {
          setError(validateError ?? "Invalid API key");
          setSaving(false);
          return;
        }
        const envKey =
          provider === "claude"
            ? "ANTHROPIC_API_KEY"
            : provider === "cursor"
              ? "CURSOR_API_KEY"
              : provider === "openai"
                ? "OPENAI_API_KEY"
                : "GOOGLE_API_KEY";
        await api.env.saveKey(envKey, value);
      }
      onComplete();
    } catch (err) {
      const message = isConnectionError(err)
        ? "Unable to connect. Please check your network and try again."
        : err instanceof Error
          ? err.message
          : "Failed to save";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    provider === "custom" ||
    provider === "lmstudio" ||
    (needsKeyInput && keyValue.trim().length > 0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      data-testid="api-key-setup-modal-backdrop"
    >
      <button
        type="button"
        className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
        aria-label="Close API key setup modal"
        onClick={onCancel}
        data-testid="api-key-setup-modal-overlay"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-key-modal-title"
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col"
        data-testid="api-key-setup-modal"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border">
          <h2 id="api-key-modal-title" className="text-lg font-semibold text-theme-text">
            Enter agent API key
          </h2>
          <CloseButton onClick={onCancel} ariaLabel="Close API key modal" />
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-theme-text">{BODY_COPY}</p>

          <div>
            <label
              htmlFor="api-key-provider"
              className="block text-sm font-medium text-theme-text mb-1"
            >
              Provider
            </label>
            <select
              id="api-key-provider"
              className="input w-full"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as AgentProviderValue);
                setKeyValue("");
                setError(null);
              }}
              data-testid="api-key-provider-select"
            >
              {AGENT_PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {!needsKeyInput && (
            <p className="text-sm text-theme-muted" data-testid="api-key-no-key-message">
              {NO_KEY_MESSAGE}
            </p>
          )}

          {needsKeyInput && (
            <div>
              <label
                htmlFor="api-key-input"
                className="block text-sm font-medium text-theme-text mb-1"
              >
                API Key
              </label>
              <div className="relative flex">
                <input
                  id="api-key-input"
                  type={showKey ? "text" : "password"}
                  className="input font-mono text-sm w-full pr-10"
                  placeholder={
                    provider === "claude"
                      ? "sk-ant-..."
                      : provider === "cursor"
                        ? "key_..."
                        : provider === "openai"
                          ? "sk-..."
                          : "AIza..."
                  }
                  value={keyValue}
                  onChange={(e) => {
                    setKeyValue(e.target.value);
                    setError(null);
                  }}
                  autoComplete="off"
                  data-testid="api-key-input"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-theme-muted hover:text-theme-text p-1"
                  aria-label={showKey ? "Hide key" : "Show key"}
                  data-testid="api-key-eye-toggle"
                >
                  {showKey ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                </button>
              </div>
              {error && (
                <p
                  className="mt-1.5 text-sm text-theme-error-text"
                  role="alert"
                  data-testid="api-key-error"
                >
                  {error}
                </p>
              )}
            </div>
          )}

          {error && !needsKeyInput && (
            <div
              className="p-3 rounded-lg bg-theme-error-bg border border-theme-error-border"
              role="alert"
            >
              <p className="text-sm text-theme-error-text">{error}</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
          <button type="button" onClick={onCancel} className="btn-secondary" disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave || saving}
            className="btn-primary disabled:opacity-50"
            data-testid="api-key-save-button"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
