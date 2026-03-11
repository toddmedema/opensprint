import { NavButton } from "../layout/NavButton";
import { NAVBAR_HEIGHT } from "../../lib/constants";

/**
 * Third-level navigation bar for Settings sub-tabs (Project mode only).
 * Uses NavButton for consistent topbar-style nav button styling.
 */
export type SettingsSubTab = "basics" | "agents" | "workflow" | "deployment" | "hil" | "team";

const TABS: { key: SettingsSubTab; label: string }[] = [
  { key: "basics", label: "Project Info" },
  { key: "agents", label: "Agent Config" },
  { key: "workflow", label: "Workflow" },
  { key: "deployment", label: "Deliver" },
  { key: "hil", label: "Autonomy" },
  { key: "team", label: "Team" },
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
    <div className="flex flex-wrap items-center gap-1 rounded-xl border border-theme-border-subtle p-1">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <NavButton
            key={tab.key}
            active={isActive}
            tone="accent"
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
      className="px-4 sm:px-6 flex items-center justify-center bg-theme-surface shrink-0"
      style={{ height: NAVBAR_HEIGHT }}
      data-testid="settings-sub-tabs-bar"
    >
      {content}
    </div>
  );
}

export { TABS as SETTINGS_SUB_TABS };
