import { useRef, useState, useEffect } from "react";
import { useOutletContext, useNavigate, useSearchParams } from "react-router-dom";
import { ProjectSettingsModal } from "../components/ProjectSettingsModal";
import type { ProjectSettingsModalRef } from "../components/ProjectSettingsModal";
import { GlobalSettingsContent } from "../components/GlobalSettingsContent";
import { SettingsTopBar } from "../components/settings/SettingsTopBar";
import { SettingsSubTabsBar, type SettingsSubTab } from "../components/settings/SettingsSubTabsBar";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { queryKeys } from "../api/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectShellContext } from "./ProjectShell";
import type { SaveStatus } from "../components/SaveIndicator";

const TAB_PARAM = "tab";
const LEVEL_PARAM = "level";
const VALID_SUB_TABS: SettingsSubTab[] = ["basics", "agents", "deployment", "hil"];

function parseTabFromSearch(search: string): SettingsSubTab {
  const params = new URLSearchParams(search);
  const t = params.get(TAB_PARAM);
  if (t && VALID_SUB_TABS.includes(t as SettingsSubTab)) return t as SettingsSubTab;
  return "basics";
}

function parseLevelFromSearch(search: string): "global" | "project" {
  const params = new URLSearchParams(search);
  const level = params.get(LEVEL_PARAM);
  return level === "global" ? "global" : "project";
}

/**
 * Project Settings page content. Renders inside ProjectShell's Layout.
 * Tabs live in Execute-style topbar navbar; modal holds only the content.
 */
export function ProjectSettingsContent() {
  const { projectId, project } = useOutletContext<ProjectShellContext>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const modalRef = useRef<ProjectSettingsModalRef>(null);

  const tabFromUrl = parseTabFromSearch(searchParams.toString());
  const levelFromUrl = parseLevelFromSearch(searchParams.toString());
  const [activeTab, setActiveTab] = useState<SettingsSubTab>(tabFromUrl);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const isGlobalLevel = levelFromUrl === "global";

  useEffect(() => {
    if (tabFromUrl !== activeTab) setActiveTab(tabFromUrl);
  }, [tabFromUrl]);

  const handleClose = () => {
    navigate(getProjectPhasePath(projectId, "sketch"));
  };

  const handleSaved = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    handleClose();
  };

  const handleTabChange = async (tab: SettingsSubTab) => {
    await modalRef.current?.persist();
    setActiveTab(tab);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(TAB_PARAM, tab);
        return next;
      },
      { replace: true }
    );
  };

  return (
    <div
      className="flex-1 min-h-0 overflow-hidden flex flex-col"
      data-testid="project-settings-page"
    >
      {/* Execute-style topbar: tabs live here, not inside the modal */}
      <div
        className="w-full shrink-0 border-b border-theme-border bg-theme-surface"
        data-testid="settings-topbar-navbar"
      >
        <SettingsTopBar projectId={project.id} saveStatus={saveStatus} />
        {!isGlobalLevel && (
          <SettingsSubTabsBar activeTab={activeTab} onTabChange={handleTabChange} />
        )}
      </div>

      {/* Content area: outer bg-theme-bg (from Layout), content card bg-theme-surface — matches Help page */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col pt-0">
        {isGlobalLevel ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0 overflow-y-auto max-w-[1800px] mx-auto w-full bg-theme-surface px-4 sm:px-6 pt-[15px] pb-6 sm:pb-8">
              <GlobalSettingsContent onSaveStateChange={setSaveStatus} />
            </div>
          </div>
        ) : (
          <>
            <ProjectSettingsModal
              ref={modalRef}
              project={project}
              onClose={handleClose}
              onSaved={handleSaved}
              fullScreen
              activeTab={activeTab}
              onTabChange={handleTabChange}
              onSaveStatusChange={setSaveStatus}
            />
          </>
        )}
      </div>
    </div>
  );
}
