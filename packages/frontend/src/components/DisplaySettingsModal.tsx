import { CloseButton } from "./CloseButton";
import { useTheme } from "../contexts/ThemeContext";
import { useDisplayPreferences } from "../contexts/DisplayPreferencesContext";
import type { RunningAgentsDisplayMode } from "../lib/displayPrefs";

const THEME_OPTIONS: { value: "light" | "dark" | "system"; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const RUNNING_AGENTS_DISPLAY_OPTIONS: { value: RunningAgentsDisplayMode; label: string }[] = [
  { value: "count", label: "Count" },
  { value: "icons", label: "Icons" },
  { value: "both", label: "Both" },
];

interface DisplaySettingsModalProps {
  onClose: () => void;
}

/**
 * Lightweight settings modal for the homepage (no project selected).
 * Shows only global display preferences: theme and running agents display mode.
 */
export function DisplaySettingsModal({ onClose }: DisplaySettingsModalProps) {
  const { preference: themePreference, setTheme } = useTheme();
  const { runningAgentsDisplayMode, setRunningAgentsDisplayMode } = useDisplayPreferences();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col"
        data-testid="display-settings-modal"
      >
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-4 border-b border-theme-border">
          <h2 className="text-lg font-semibold text-theme-text">Settings</h2>
          <CloseButton onClick={onClose} ariaLabel="Close settings modal" />
        </div>
        <div className="px-5 py-4 space-y-6" data-testid="display-section">
          <div>
            <h3 className="text-sm font-semibold text-theme-text">Theme</h3>
            <p className="text-xs text-theme-muted mb-3">
              Choose how Open Sprint looks. System follows your operating system preference.
            </p>
            <div className="flex gap-2 flex-wrap">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setTheme(opt.value)}
                  data-testid={`theme-option-${opt.value}`}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    themePreference === opt.value
                      ? "bg-brand-600 text-white"
                      : "bg-theme-border-subtle text-theme-text hover:bg-theme-bg-elevated"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-theme-text">Running agents display mode</h3>
            <p className="text-xs text-theme-muted mb-3">
              How to show running agents in the navbar and execute view: count only, icons only, or
              both.
            </p>
            <select
              value={runningAgentsDisplayMode}
              onChange={(e) =>
                setRunningAgentsDisplayMode(e.target.value as RunningAgentsDisplayMode)
              }
              data-testid="running-agents-display-mode"
              className="rounded-lg border border-theme-border bg-theme-bg pl-3 pr-10 py-2 text-sm text-theme-text focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            >
              {RUNNING_AGENTS_DISPLAY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
