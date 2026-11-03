import { useState, useEffect, useMemo } from "react";
import { api, type ModelOption, isConnectionError } from "../api/client";
import {
  getClaudeCliEffortCapabilities,
  type AgentEffort,
  type AgentType,
} from "@opensprint/shared";
import { EffortSelect } from "./EffortSelect";

interface ModelSelectProps {
  provider: AgentType;
  value: string | null;
  onChange: (modelId: string | null, effort?: AgentEffort) => void;
  effort?: AgentEffort;
  onEffortChange?: (effort: AgentEffort | undefined) => void;
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
  "codex",
  "cursor",
  "openai",
  "google",
  "lmstudio",
  "ollama",
] as const;

export function ModelSelect({
  provider,
  value,
  effort,
  onEffortChange,
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
  const [catalogProvider, setCatalogProvider] = useState<AgentType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!FETCH_PROVIDERS.includes(provider as (typeof FETCH_PROVIDERS)[number])) {
      setModels([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setModels([]);
    setCatalogProvider(null);
    setLoading(true);
    setError(null);
    api.models
      .list(
        provider,
        projectId,
        provider === "lmstudio" || provider === "ollama" ? baseUrl : undefined
      )
      .then((list) => {
        if (cancelled) return;
        setCatalogProvider(provider);
        setModels(list);
        // Initial selection is applied by the sync effect when models update (single source of truth).
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load models");
        setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, projectId, baseUrl, refreshTrigger]);

  // Default to first agent from provider list when value or models change (e.g. value no longer in list)
  useEffect(() => {
    if (catalogProvider !== provider || models.length === 0) return;
    const hasValue = value != null && value.length > 0;
    const valueInList = hasValue && models.some((m) => m.id === value);
    // An offline/older CLI can expose only its default; never overwrite a saved explicit choice.
    const preserveCliChoice = provider === "codex" || provider === "claude-cli";
    if (!hasValue || (!valueInList && !preserveCliChoice)) {
      if (onEffortChange) onChange(models[0].id, undefined);
      else onChange(models[0].id);
    }
  }, [models, value, onChange, provider, catalogProvider, onEffortChange]);

  const selectedModel = useMemo(() => {
    const catalogModel =
      catalogProvider === provider ? models.find((model) => model.id === value) : undefined;
    if (catalogModel || provider !== "claude-cli" || !value) return catalogModel;
    // Claude lists rolling aliases, but existing projects can pin a documented model ID.
    // Those documented capabilities remain reliable even when model discovery fails.
    const capabilities = getClaudeCliEffortCapabilities(value);
    return capabilities.supportedEfforts?.length
      ? { id: value, displayName: value, ...capabilities }
      : undefined;
  }, [models, catalogProvider, provider, value]);
  useEffect(() => {
    if (
      !loading &&
      effort &&
      selectedModel?.supportedEfforts &&
      !selectedModel.supportedEfforts.some((level) => level.effort === effort)
    )
      onEffortChange?.(undefined);
  }, [selectedModel, effort, loading, onEffortChange]);
  const changeModel = (modelId: string | null) => {
    if (!onEffortChange) {
      onChange(modelId);
      return;
    }
    const next = models.find((model) => model.id === modelId);
    const nextEffort =
      effort && next?.supportedEfforts?.some((level) => level.effort === effort)
        ? effort
        : undefined;
    onChange(modelId, nextEffort);
  };

  const renderModel = () => {
    if (provider === "custom") {
      return (
        <input
          type="text"
          id={id}
          className={className}
          value={value ?? ""}
          onChange={(e) => changeModel(e.target.value || null)}
          onBlur={onBlur}
          placeholder="CLI command handles model"
          disabled={disabled}
          aria-label="Custom CLI command"
        />
      );
    }

    if (loading) {
      return (
        <select
          id={id}
          className={className}
          disabled
          aria-label="Model selection"
          aria-busy="true"
        >
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
            ? isConnectionError(error) || /not reachable|running|connection/i.test(error)
              ? "Ollama is not reachable. Start Ollama and check the server URL in Settings."
              : "No models — verify the server URL or run `ollama pull <model>`"
            : provider === "claude"
              ? "Anthropic API key required — configure in Global Settings → API keys"
              : provider === "claude-cli"
                ? "Ensure claude CLI is installed"
                : provider === "codex"
                  ? "Install Codex CLI and run codex login with ChatGPT"
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
          onChange={(e) => changeModel(e.target.value || null)}
          onBlur={onBlur}
          disabled={disabled}
          aria-label="Model selection"
        >
          <option value="">
            {provider === "ollama"
              ? "No local models — run `ollama pull <model>`"
              : "No models available"}
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
        onChange={(e) => changeModel(e.target.value || null)}
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
  };
  if (!onEffortChange) return renderModel();
  const native = provider === "codex" || provider === "claude-cli";
  return (
    <div className={native ? "grid grid-cols-1 sm:grid-cols-2 gap-3" : undefined}>
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-theme-text mb-1">
          Agent
        </label>
        {renderModel()}
      </div>
      {native && (
        <EffortSelect
          id={id ? `${id}-effort` : undefined}
          value={effort}
          model={selectedModel}
          loading={loading}
          disabled={disabled}
          onChange={onEffortChange}
          onBlur={onBlur}
        />
      )}
    </div>
  );
}
