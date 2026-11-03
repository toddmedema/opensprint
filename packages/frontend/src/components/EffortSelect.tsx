import type { AgentEffort, AgentModelOption } from "@opensprint/shared";

const LABELS: Record<AgentEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra (automatic delegation)",
};

export function EffortSelect({
  id,
  value,
  model,
  loading,
  disabled,
  onChange,
  onBlur,
}: {
  id?: string;
  value?: AgentEffort;
  model?: AgentModelOption;
  loading: boolean;
  disabled?: boolean;
  onChange: (effort: AgentEffort | undefined) => void;
  onBlur?: () => void;
}) {
  const levels = model?.supportedEfforts;
  const unverified = levels === undefined;
  const savedUnknown = value && !levels?.some((level) => level.effort === value);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-theme-text mb-1">
        Effort
      </label>
      <select
        id={id}
        className="input w-full"
        aria-label="Effort"
        value={value ?? ""}
        disabled={disabled || loading || (!value && !levels?.length)}
        onChange={(event) =>
          onChange(event.target.value ? (event.target.value as AgentEffort) : undefined)
        }
        onBlur={onBlur}
      >
        <option value="">CLI default</option>
        {savedUnknown && <option value={value}>{LABELS[value]} (saved; unverified)</option>}
        {levels?.map((level) => (
          <option key={level.effort} value={level.effort} title={level.description}>
            {LABELS[level.effort]}
          </option>
        ))}
      </select>
      {value === "ultra" && (
        <p className="text-xs text-theme-muted mt-1">
          Uses automatic task delegation to subagents.
        </p>
      )}
      {unverified && value && !loading && (
        <p className="text-xs text-theme-warning-text mt-1">
          Effort availability could not be verified. Your saved selection is retained; refresh the
          model catalog before running.
        </p>
      )}
      {!unverified && !levels.length && (
        <p className="text-xs text-theme-muted mt-1">Select a supported model to set effort.</p>
      )}
    </div>
  );
}
