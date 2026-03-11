import { TEST_FRAMEWORKS } from "@opensprint/shared";

export interface TestingStepProps {
  value: string;
  onChange: (value: string) => void;
  detectingFramework: boolean;
  detectedFramework: string | null;
}

export function TestingStep({
  value,
  onChange,
  detectingFramework,
  detectedFramework,
}: TestingStepProps) {
  return (
    <div className="space-y-4" data-testid="testing-step">
      <div>
        <label htmlFor="testing-framework-select" className="block text-sm font-medium text-theme-text mb-3">Test Framework</label>
        <p className="text-xs text-theme-muted mb-3">
          Open Sprint uses this to run tests during the Execute phase. We detect from your project
          when possible.
        </p>
        {detectingFramework && (
          <p className="text-sm text-theme-muted mb-2">Detecting from project...</p>
        )}
        {!detectingFramework && detectedFramework && (
          <p className="text-sm text-theme-success-text mb-2">
            Detected:{" "}
            <strong>
              {TEST_FRAMEWORKS.find((f) => f.id === detectedFramework)?.label ?? detectedFramework}
            </strong>
          </p>
        )}
        <select id="testing-framework-select" className="input w-full" value={value} onChange={(e) => onChange(e.target.value)}>
          {TEST_FRAMEWORKS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
