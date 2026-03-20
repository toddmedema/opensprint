import { useState, useEffect } from "react";
import { api, type ModelOption, isConnectionError } from "../api/client";
import type { AgentType } from "@opensprint/shared";

interface ModelSelectProps {
  provider: AgentType;
  value: string | null;
  onChange: (modelId: string | null) => void;
  disabled?: boolean;
  className?: string;
  /** ID for label association (htmlFor) */
  id?: string;
  /** Project ID for API key resolution when listing models (project-level keys) */
  projectId?: string;
  /** LM Studio base URL (e.g. http://localhost:1234); used when provider is lmstudio */
  baseUrl?: string;
  /** Increment to trigger a refetch of models (e.g. after saving an API key) */
  refreshTrigger?: number;
  /** Called when the control loses focus */
  onBlur?: () => void;
}

const FETCH_PROVIDERS = ["claude", "claude-cli", "cursor", "openai", "google", "lmstudio"] as const;

export function ModelSelect({
  provider,
  value,
  onChange,
  disabled,
  className = "input",
  projectId,
  baseUrl,
  refreshTrigger,
  onBlur,
  id,
}: ModelSelectProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!FETCH_PROVIDERS.includes(provider as (typeof FETCH_PROVIDERS)[number])) {
      setModels([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    api.models
      .list(provider, projectId, provider === "lmstudio" ? baseUrl : undefined)
      .then((list) => {
        setModels(list);
        // Initial selection is applied by the sync effect when models update (single source of truth).
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load models");
        setModels([]);
      })
      .finally(() => setLoading(false));
  }, [provider, projectId, baseUrl, refreshTrigger]);

  // Default to first agent from provider list when value or models change (e.g. value no longer in list)
  useEffect(() => {
    if (models.length === 0) return;
    const hasValue = value != null && value.length > 0;
    const valueInList = hasValue && models.some((m) => m.id === value);
    if (!hasValue || !valueInList) {
      onChange(models[0].id);
    }
  }, [models, value, onChange]);

  if (provider === "custom") {
    return (
      <input
        type="text"
        id={id}
        className={className}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        onBlur={onBlur}
        placeholder="CLI command handles model"
        disabled={disabled}
        aria-label="Custom CLI command"
      />
    );
  }

  if (loading) {
    return (
      <select id={id} className={className} disabled aria-label="Model selection" aria-busy="true">
        <option>Loading models…</option>
      </select>
    );
  }

  if (error) {
    const hint =
      provider === "lmstudio"
        ? isConnectionError(error)
          ? "LM Studio is not reachable. Check the server URL in Settings."
          : "No models — start LM Studio and load a model"
        : provider === "claude"
          ? "Anthropic API key required — configure in Global Settings → API keys"
          : provider === "claude-cli"
            ? "Ensure claude CLI is installed"
            : provider === "cursor"
              ? "Cursor API key required — configure in Global Settings → API keys"
              : provider === "openai"
                ? "OpenAI API key required — configure in Global Settings → API keys"
                : provider === "google"
                  ? "Google API key required — configure in Global Settings → API keys"
                  : "";
    const displayMessage = provider === "lmstudio" ? hint : error;
    const optionLabel =
      provider === "lmstudio" ? "No models" : `No models${hint ? ` (${hint})` : ""}`;
    return (
      <div className="space-y-1" role="group" aria-label="Model selection">
        <select
          id={id}
          className={className}
          disabled
          aria-label="Model selection"
          aria-invalid="true"
        >
          <option value="">{optionLabel}</option>
        </select>
        <p className="text-xs text-theme-warning-text" role="alert" aria-live="polite">
          {displayMessage}
        </p>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <select
        id={id}
        className={className}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        onBlur={onBlur}
        disabled={disabled}
        aria-label="Model selection"
      >
        <option value="">No models available</option>
      </select>
    );
  }

  const hasValue = value && value.length > 0;
  const valueInList = hasValue && models.some((m) => m.id === value);

  return (
    <select
      id={id}
      className={className}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      onBlur={onBlur}
      disabled={disabled}
      aria-label="Model selection"
    >
      <option value="">Select model</option>
      {hasValue && !valueInList && <option value={value!}>{value}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.displayName}
        </option>
      ))}
    </select>
  );
}
