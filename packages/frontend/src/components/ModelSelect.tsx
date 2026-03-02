import { useState, useEffect } from "react";
import { api, type ModelOption } from "../api/client";
import type { AgentType } from "@opensprint/shared";

interface ModelSelectProps {
  provider: AgentType;
  value: string | null;
  onChange: (modelId: string | null) => void;
  disabled?: boolean;
  className?: string;
  /** Project ID for API key resolution when listing models (project-level keys) */
  projectId?: string;
  /** Increment to trigger a refetch of models (e.g. after saving an API key) */
  refreshTrigger?: number;
  /** Called when the control loses focus */
  onBlur?: () => void;
}

export function ModelSelect({
  provider,
  value,
  onChange,
  disabled,
  className = "input",
  projectId,
  refreshTrigger,
  onBlur,
}: ModelSelectProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (
      provider !== "claude" &&
      provider !== "claude-cli" &&
      provider !== "cursor" &&
      provider !== "openai" &&
      provider !== "google"
    ) {
      setModels([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    api.models
      .list(provider, projectId)
      .then((list) => setModels(list))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load models");
        setModels([]);
      })
      .finally(() => setLoading(false));
  }, [provider, projectId, refreshTrigger]);

  // Default to first agent from provider list when list loads and no valid selection
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
      <select className={className} disabled aria-label="Model selection" aria-busy="true">
        <option>Loading models…</option>
      </select>
    );
  }

  if (error) {
    const hint =
      provider === "claude"
        ? "Check ANTHROPIC_API_KEY in .env"
        : provider === "claude-cli"
          ? "Ensure claude CLI is installed"
          : provider === "cursor"
            ? "Check CURSOR_API_KEY in .env"
            : provider === "openai"
              ? "Check OPENAI_API_KEY in .env"
              : provider === "google"
                ? "Check GOOGLE_API_KEY in .env"
                : "";
    return (
      <div className="space-y-1" role="group" aria-label="Model selection">
        <select className={className} disabled aria-label="Model selection" aria-invalid="true">
          <option value="">No models ({hint})</option>
        </select>
        <p className="text-xs text-theme-warning-text" role="alert" aria-live="polite">
          {error}
        </p>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <select className={className} disabled aria-label="Model selection">
        <option value="">No models available</option>
      </select>
    );
  }

  const hasValue = value && value.length > 0;
  const valueInList = hasValue && models.some((m) => m.id === value);

  return (
    <select
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
