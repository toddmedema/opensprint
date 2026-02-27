import { useState } from "react";
import { CloseButton } from "./CloseButton";
import { api } from "../api/client";

const BODY_COPY =
  "At least one agent API key is required to use Open Sprint. Or, select 'Custom/CLI' if you'll be using your own agent or a CLI integration rather than an API.";

type ProviderOption = "claude" | "cursor" | "custom";

const PROVIDER_OPTIONS: { value: ProviderOption; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "cursor", label: "Cursor" },
  { value: "custom", label: "Custom/CLI" },
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
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
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
  intendedRoute,
}: ApiKeySetupModalProps) {
  const [provider, setProvider] = useState<ProviderOption>("claude");
  const [keyValue, setKeyValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsKeyInput = provider === "claude" || provider === "cursor";

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      if (provider === "custom") {
        await api.env.setGlobalSettings({ useCustomCli: true });
      } else {
        const value = keyValue.trim();
        if (!value) {
          setError("Please enter an API key");
          setSaving(false);
          return;
        }
        const apiProvider = provider === "claude" ? "claude" : "cursor";
        const { valid, error: validateError } = await api.env.validateKey(apiProvider, value);
        if (!valid) {
          setError(validateError ?? "Invalid API key");
          setSaving(false);
          return;
        }
        const envKey = provider === "claude" ? "ANTHROPIC_API_KEY" : "CURSOR_API_KEY";
        await api.env.saveKey(envKey, value);
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    provider === "custom" ||
    (needsKeyInput && keyValue.trim().length > 0);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-key-modal-title"
      onKeyDown={handleKeyDown}
      data-testid="api-key-setup-modal-backdrop"
    >
      <div
        className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
        onClick={onCancel}
        data-testid="api-key-setup-modal-overlay"
      />
      <div
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="api-key-setup-modal"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border">
          <h2
            id="api-key-modal-title"
            className="text-lg font-semibold text-theme-text"
          >
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
                setProvider(e.target.value as ProviderOption);
                setKeyValue("");
                setError(null);
              }}
              data-testid="api-key-provider-select"
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

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
                    provider === "claude" ? "sk-ant-..." : "key_..."
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
                  {showKey ? (
                    <EyeOffIcon className="w-4 h-4" />
                  ) : (
                    <EyeIcon className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div
              className="p-3 rounded-lg bg-theme-error-bg border border-theme-error-border"
              role="alert"
            >
              <p className="text-sm text-theme-error-text">{error}</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
          <button
            type="button"
            onClick={onCancel}
            className="btn-secondary"
            disabled={saving}
          >
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
