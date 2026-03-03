import { useSearchParams } from "react-router-dom";
import { NavButton } from "../layout/NavButton";
import { SaveIndicator, type SaveStatus } from "../SaveIndicator";

const LEVEL_PARAM = "level";

/**
 * Second-level top bar for Settings pages. Matches Execute/Plan layout pattern:
 * Global | Project navigation on left, save status on right.
 * No "Settings" header - removed per design.
 *
 * When in project context (projectId set), Global tab stays within project scope
 * (/projects/:id/settings?level=global) to preserve project context.
 */
interface SettingsTopBarProps {
  /** When set, we're in project context; Project tab is active unless level=global */
  projectId?: string | null;
  saveStatus: SaveStatus;
}

export function SettingsTopBar({ projectId, saveStatus }: SettingsTopBarProps) {
  const [searchParams] = useSearchParams();
  const level = searchParams.get(LEVEL_PARAM);

  const isGlobal = !projectId || level === "global";
  const globalHref = projectId ? `/projects/${projectId}/settings?level=global` : "/settings";
  const projectHref = projectId
    ? (() => {
        const tab = searchParams.get("tab") || "basics";
        const next = new URLSearchParams(searchParams);
        next.set(LEVEL_PARAM, "project");
        next.set("tab", tab);
        return `/projects/${projectId}/settings?${next.toString()}`;
      })()
    : "/";

  return (
    <div
      className="px-4 sm:px-6 min-h-[48px] flex items-center justify-between py-2 border-b border-theme-border bg-theme-surface shrink-0"
      data-testid="settings-top-bar"
    >
      <div className="flex-1 min-w-0" aria-hidden="true" />
      <div className="flex items-center justify-center gap-1 bg-theme-border-subtle rounded-lg p-1 shrink-0">
        <NavButton
          to={globalHref}
          active={isGlobal}
          data-testid="settings-global-tab"
        >
          Global
        </NavButton>
        <NavButton
          to={projectHref}
          active={!isGlobal}
          data-testid="settings-project-tab"
        >
          Project
        </NavButton>
      </div>
      <div className="flex-1 min-w-0 flex justify-end">
        <SaveIndicator status={saveStatus} data-testid="settings-save-indicator" />
      </div>
    </div>
  );
}
