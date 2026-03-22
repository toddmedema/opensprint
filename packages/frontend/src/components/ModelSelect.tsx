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
  /** Local provider base URL (e.g. LM Studio/Ollama); used when provider is lmstudio or ollama */
  baseUrl?: string;
  /** Increment to trigger a refetch of models (e.g. after saving an API key) */
  refreshTrigger?: number;
  /** Called when the control loses focus */
  onBlur?: () => void;
}

const FETCH_PROVIDERS = [
  "claude",
  "claude-cli",
  "cursor",
  "openai",
  "google",
  "lmstudio",
  "ollama",
] as const;

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
      .list(
        provider,
        projectId,
        provider === "lmstudio" || provider === "ollama" ? baseUrl : undefined
      )
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
        : provider === "ollama"
          ? /not found/i.test(error)
            ? "Ollama CLI not found — install Ollama and restart Open Sprint"
            : /not reachable|running/i.test(error)
              ? "Ollama is not reachable. Start Ollama and check the server URL in Settings."
              : "No models — run `ollama pull <model>` in your terminal"
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
    const displayMessage = provider === "lmstudio" || provider === "ollama" ? hint : error;
    const optionLabel =
      provider === "lmstudio" || provider === "ollama"
        ? "No models"
        : `No models${hint ? ` (${hint})` : ""}`;
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
        <option value="">
          {provider === "ollama" ? "No local models — run `ollama pull <model>`" : "No models available"}
        </option>
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
