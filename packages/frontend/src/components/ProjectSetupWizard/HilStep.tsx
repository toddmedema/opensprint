import type { HilConfig, HilNotificationMode } from "@opensprint/shared";

export interface HilStepProps {
  value: HilConfig;
  onChange: (config: HilConfig) => void;
}

const HIL_CATEGORIES = [
  { key: "scopeChanges", label: "Scope Changes", desc: "Adds, removes, or alters features" },
  {
    key: "architectureDecisions",
    label: "Architecture Decisions",
    desc: "Tech stack, integrations, schema changes",
  },
  {
    key: "dependencyModifications",
    label: "Dependency Modifications",
    desc: "Task reordering and re-prioritization",
  },
] as const;

export function HilStep({ value, onChange }: HilStepProps) {
  return (
    <div className="space-y-4" data-testid="hil-step">
      <p className="text-sm text-gray-500 mb-4">
        Configure when OpenSprint should pause for your input vs. proceed autonomously.
      </p>
      {HIL_CATEGORIES.map((cat) => (
        <div key={cat.key} className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
          <div>
            <p className="text-sm font-medium text-gray-900">{cat.label}</p>
            <p className="text-xs text-gray-500">{cat.desc}</p>
          </div>
          <select
            className="input w-48"
            value={value[cat.key]}
            onChange={(e) =>
              onChange({ ...value, [cat.key]: e.target.value as HilNotificationMode })
            }
          >
            <option value="requires_approval">Requires Approval</option>
            <option value="notify_and_proceed">Notify & Proceed</option>
            <option value="automated">Automated</option>
          </select>
        </div>
      ))}
    </div>
  );
}
