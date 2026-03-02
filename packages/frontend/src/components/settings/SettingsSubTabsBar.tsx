/**
 * Third-level navigation bar for Settings sub-tabs (Project mode only).
 * Styling matches Execute/Plan filter toolbars.
 */
export type SettingsSubTab = "basics" | "agents" | "deployment" | "hil";

const TABS: { key: SettingsSubTab; label: string }[] = [
  { key: "basics", label: "Project Info" },
  { key: "agents", label: "Agent Config" },
  { key: "deployment", label: "Deliver" },
  { key: "hil", label: "Autonomy" },
];

interface SettingsSubTabsBarProps {
  activeTab: SettingsSubTab;
  onTabChange: (tab: SettingsSubTab) => void;
  /** When "inline", omit the bar wrapper (for modal overlay) */
  variant?: "bar" | "inline";
}

export function SettingsSubTabsBar({
  activeTab,
  onTabChange,
  variant = "bar",
}: SettingsSubTabsBarProps) {
  const content = (
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onTabChange(tab.key)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-brand-600 text-white ring-2 ring-brand-500 ring-offset-2 ring-offset-theme-bg"
                  : "bg-theme-surface-muted text-theme-text hover:bg-theme-border-subtle"
              }`}
              aria-pressed={isActive}
              data-testid={`settings-tab-${tab.key}`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
  );

  if (variant === "inline") {
    return <div data-testid="settings-sub-tabs-bar">{content}</div>;
  }
  return (
    <div
      className="px-6 min-h-[48px] flex items-center py-2 border-b border-theme-border bg-theme-surface shrink-0"
      data-testid="settings-sub-tabs-bar"
    >
      {content}
    </div>
  );
}

export { TABS as SETTINGS_SUB_TABS };
