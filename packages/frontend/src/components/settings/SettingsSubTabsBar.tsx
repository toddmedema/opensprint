import { useEffect, useRef } from "react";
import { NavButton } from "../layout/NavButton";
import { NAVBAR_HEIGHT } from "../../lib/constants";

/**
 * Third-level navigation bar for Settings sub-tabs (Project mode only).
 * Uses NavButton for consistent topbar-style nav button styling.
 */
export type SettingsSubTab =
  | "basics"
  | "agents"
  | "workflow"
  | "governance"
  | "deployment"
  | "hil"
  | "team"
  | "integrations";

const TABS: { key: SettingsSubTab; label: string }[] = [
  { key: "basics", label: "Project Info" },
  { key: "agents", label: "Agent Config" },
  { key: "workflow", label: "Workflow" },
  { key: "governance", label: "Review governance" },
  { key: "deployment", label: "Deliver" },
  { key: "hil", label: "Autonomy" },
  { key: "team", label: "Team" },
  { key: "integrations", label: "Integrations" },
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
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tabs = tabsRef.current;
    const selected = tabs?.querySelector<HTMLElement>('[data-active="true"]');
    if (tabs && selected && tabs.scrollWidth > tabs.clientWidth) {
      tabs.scrollTo?.({
        left: selected.offsetLeft - (tabs.clientWidth - selected.offsetWidth) / 2,
      });
    }
  }, [activeTab]);
  const content = (
    <div
      ref={tabsRef}
      className="relative flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-theme-border-subtle p-1 sm:flex-wrap"
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <NavButton
            key={tab.key}
            active={isActive}
            tone="accent"
            className="shrink-0 whitespace-nowrap min-h-[44px] sm:min-h-[36px]"
            aria-current={isActive ? "page" : undefined}
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
      className="px-4 py-2 sm:px-6 sm:py-0 flex items-center justify-center bg-theme-surface shrink-0"
      style={{ minHeight: NAVBAR_HEIGHT }}
      data-testid="settings-sub-tabs-bar"
    >
      {content}
    </div>
  );
}

export { TABS as SETTINGS_SUB_TABS };
