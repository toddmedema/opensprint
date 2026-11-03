import type { AiAutonomyLevel, DeliveryMode } from "@opensprint/shared";
import { CodeDeliverySelect } from "../CodeDeliverySelect";
import { AI_AUTONOMY_LEVELS, DEFAULT_AI_AUTONOMY_LEVEL } from "@opensprint/shared";

export interface HilStepProps {
  value: AiAutonomyLevel;
  onChange: (level: AiAutonomyLevel) => void;
  deliveryMode?: DeliveryMode;
  onDeliveryModeChange?: (mode: DeliveryMode) => void;
  baseBranch?: string;
}

export function HilStep({
  value,
  onChange,
  deliveryMode = "direct",
  onDeliveryModeChange,
  baseBranch = "the base branch",
}: HilStepProps) {
  const level = value ?? DEFAULT_AI_AUTONOMY_LEVEL;
  const index = AI_AUTONOMY_LEVELS.findIndex((l) => l.value === level);
  const sliderValue = index >= 0 ? index : AI_AUTONOMY_LEVELS.length - 1;

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const i = Number(e.target.value);
    const opt = AI_AUTONOMY_LEVELS[i];
    if (opt) onChange(opt.value);
  };

  return (
    <div className="space-y-4" data-testid="hil-step">
      <p className="text-sm text-theme-muted mb-4">
        Configure when Open Sprint should pause for your input vs. proceed autonomously.
      </p>
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-theme-text">AI Autonomy</h3>
        <div className="space-y-3">
          <input
            type="range"
            min={0}
            max={AI_AUTONOMY_LEVELS.length - 1}
            step={1}
            value={sliderValue}
            onChange={handleSliderChange}
            className="w-full accent-brand-600"
            aria-label="AI Autonomy level"
            data-testid="ai-autonomy-slider"
          />
          <div className="flex justify-between text-xs text-theme-muted">
            {AI_AUTONOMY_LEVELS.map((opt) => (
              <span
                key={opt.value}
                className={opt.value === level ? "font-medium text-theme-text" : ""}
              >
                {opt.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      {onDeliveryModeChange && (
        <CodeDeliverySelect
          value={deliveryMode}
          baseBranch={baseBranch}
          onChange={onDeliveryModeChange}
        />
      )}
    </div>
  );
}
