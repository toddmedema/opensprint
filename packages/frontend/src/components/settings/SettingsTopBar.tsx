import { Link } from "react-router-dom";
import { SaveIndicator, type SaveStatus } from "../SaveIndicator";

/**
 * Second-level top bar for Settings pages. Matches Execute/Plan layout pattern:
 * Global | Project navigation on left, save status on right.
 * No "Settings" header - removed per design.
 */
interface SettingsTopBarProps {
  /** When set, we're in project context; Project tab is active */
  projectId?: string | null;
  saveStatus: SaveStatus;
}

export function SettingsTopBar({ projectId, saveStatus }: SettingsTopBarProps) {
  const isGlobal = !projectId;
  const globalHref = "/settings";
  const projectHref = projectId ? `/projects/${projectId}/settings` : "/";

  return (
    <div
      className="px-6 min-h-[48px] flex items-center justify-between py-2 border-b border-theme-border bg-theme-surface shrink-0"
      data-testid="settings-top-bar"
    >
      <div className="flex items-center gap-1 bg-theme-border-subtle rounded-lg p-1">
        <Link
          to={globalHref}
          className={`phase-tab ${isGlobal ? "phase-tab-active" : "phase-tab-inactive"}`}
          data-testid="settings-global-tab"
        >
          Global
        </Link>
        <Link
          to={projectHref}
          className={`phase-tab ${!isGlobal ? "phase-tab-active" : "phase-tab-inactive"}`}
          data-testid="settings-project-tab"
        >
          Project
        </Link>
      </div>
      <SaveIndicator status={saveStatus} data-testid="settings-save-indicator" />
    </div>
  );
}
