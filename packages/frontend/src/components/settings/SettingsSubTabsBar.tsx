import { NavButton } from "../layout/NavButton";

/**
 * Third-level navigation bar for Settings sub-tabs (Project mode only).
 * Uses NavButton for consistent topbar-style nav button styling.
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
    <div className="flex flex-wrap items-center gap-1 bg-theme-border-subtle rounded-lg p-1">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <NavButton
            key={tab.key}
            active={isActive}
            onClick={() => onTabChange(tab.key)}
            data-testid={`settings-tab-${tab.key}`}
          >
            {tab.label}
          </NavButton>
        );
      })}
    </div>
  );

  if (variant === "inline") {
    return <div data-testid="settings-sub-tabs-bar">{content}</div>;
  }
  return (
    <div
      className="px-4 sm:px-6 min-h-[48px] flex items-center justify-center py-2 border-b border-theme-border bg-theme-surface shrink-0"
      data-testid="settings-sub-tabs-bar"
    >
      {content}
    </div>
  );
}

export { TABS as SETTINGS_SUB_TABS };
