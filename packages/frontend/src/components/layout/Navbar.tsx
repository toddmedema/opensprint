import { useState, useEffect, useRef, useMemo } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import type { Project, ProjectPhase } from "@opensprint/shared";
import { NAVBAR_HEIGHT } from "../../lib/constants";
import { useAppSelector, useAppDispatch } from "../../store";
import { selectTasks } from "../../store/slices/executeSlice";
import { wsConnectHome } from "../../store/middleware/websocketMiddleware";
import { getProjectPhasePath } from "../../lib/phaseRouting";
import { api } from "../../api/client";
import { ActiveAgentsList } from "../ActiveAgentsList";
import { GlobalActiveAgentsList } from "../GlobalActiveAgentsList";
import { NotificationBell } from "../NotificationBell";
import { GlobalNotificationBell } from "../GlobalNotificationBell";
import { ConnectionIndicator } from "../ConnectionIndicator";
interface NavbarProps {
  project?: Project | null;
  currentPhase?: ProjectPhase;
  onPhaseChange?: (phase: ProjectPhase) => void;
  onProjectSaved?: () => void;
}

const PHASE_LABELS: Record<ProjectPhase, string> = {
  sketch: "Sketch",
  plan: "Plan",
  execute: "Execute",
  eval: "Evaluate",
  deliver: "Deliver",
};

export function Navbar({
  project,
  currentPhase,
  onPhaseChange,
  onProjectSaved,
}: NavbarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const isSettingsActive =
    location.pathname === "/settings" ||
    (project && location.pathname === `/projects/${project.id}/settings`);

  const isHelpActive =
    location.pathname === "/help" ||
    (project && location.pathname === `/projects/${project.id}/help`);

  const settingsHref = project ? `/projects/${project.id}/settings` : "/settings";
  const helpHref = project ? `/projects/${project.id}/help` : "/help";

  const helpButtonClassName =
    "p-1.5 rounded-md transition-colors text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle";

  const dispatch = useAppDispatch();
  const executeBlockedCount = useAppSelector((s) => {
    const implTasks = selectTasks(s).filter((t) => t.type !== "epic");
    return implTasks.filter((t) => t.kanbanColumn === "blocked").length;
  });

  const phaseTabs = useMemo(
    () =>
      (["sketch", "plan", "execute", "eval", "deliver"] as const).map((key) => ({
        key,
        label: key === "execute" && executeBlockedCount > 0 ? "⚠️ Execute" : PHASE_LABELS[key],
      })),
    [executeBlockedCount]
  );

  // Load projects when on home (no project) so we can show GlobalActiveAgentsList when at least one exists
  useEffect(() => {
    if (!project) {
      api.projects.list().then(setProjects).catch(console.error);
    }
  }, [project]);

  // Open a lightweight WS to /ws when on homepage so backend sees a client and does not open a duplicate tab
  useEffect(() => {
    if (!project && projects.length >= 1) {
      dispatch(wsConnectHome());
    }
  }, [project, projects.length, dispatch]);

  useEffect(() => {
    if (dropdownOpen) {
      api.projects.list().then(setProjects).catch(console.error);
    }
  }, [dropdownOpen]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [dropdownOpen]);

  const handleCreateOrAddClick = async (
    route: "/projects/create-new" | "/projects/add-existing"
  ) => {
    setDropdownOpen(false);
    try {
      const { hasAnyKey, useCustomCli } = await api.env.getGlobalStatus();
      if (hasAnyKey || useCustomCli) {
        navigate(route);
      } else {
        navigate("/settings");
      }
    } catch {
      navigate(route);
    }
  };

  return (
    <nav
      className="relative z-[60] flex items-center bg-theme-surface border-b border-theme-border px-6 shrink-0"
      style={{ height: NAVBAR_HEIGHT }}
    >
      <div className="flex w-full items-center justify-between">
        {/* Left: Logo + Project Selector */}
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2" data-testid="navbar-logo-link">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 80 80"
              className="w-8 h-8"
              aria-hidden="true"
            >
              <polygon points="4,10 36,40 4,70" fill="#c7d2fe" />
              <polygon points="22,10 54,40 22,70" fill="#818cf8" />
              <polygon points="40,10 72,40 40,70" fill="#4f46e5" />
            </svg>
            <span className="hidden min-[1000px]:inline font-sans font-semibold text-lg text-theme-text">Open Sprint</span>
          </Link>

          <div className="relative flex items-center" ref={dropdownRef}>
            <span className="hidden min-[1000px]:inline text-theme-muted">/</span>
            <button
              type="button"
              onClick={() => setDropdownOpen((o) => !o)}
              className="dropdown-trigger ml-1 inline-flex items-center gap-1 text-sm font-medium text-theme-muted hover:text-theme-text transition-colors rounded py-1 hover:bg-theme-border-subtle"
              aria-expanded={dropdownOpen}
              aria-haspopup="listbox"
            >
              {project ? project.name : "All Projects"}
              <span className="pr-2">
                <svg
                  className={`w-4 h-4 transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </span>
            </button>
            {dropdownOpen && (
              <div
                className="absolute left-0 top-full mt-1 min-w-[200px] max-h-[280px] overflow-y-auto bg-theme-surface border border-theme-border rounded-lg shadow-lg py-1 z-50"
                role="listbox"
              >
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={p.id === project?.id}
                    onClick={() => {
                      setDropdownOpen(false);
                      navigate(getProjectPhasePath(p.id, currentPhase ?? "sketch"));
                    }}
                    className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                      p.id === project?.id
                        ? "bg-theme-info-bg text-theme-info-text font-medium"
                        : "text-theme-muted hover:bg-theme-info-bg"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
                {projects.length === 0 && (
                  <div className="px-4 py-3 text-sm text-theme-muted">No projects</div>
                )}
                <div className="border-t border-theme-border-subtle mt-1 pt-1 space-y-0.5">
                  <button
                    type="button"
                    onClick={() => handleCreateOrAddClick("/projects/add-existing")}
                    className="w-full text-left px-4 py-2 text-sm text-theme-text font-medium hover:bg-theme-info-bg transition-colors"
                  >
                    Add Existing Project
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCreateOrAddClick("/projects/create-new")}
                    className="w-full text-left px-4 py-2 text-sm text-theme-text font-medium hover:bg-theme-info-bg transition-colors"
                  >
                    Create New Project
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Center: Phase Tabs */}
        {project && currentPhase && onPhaseChange && (
          <div className="flex items-center gap-1 bg-theme-border-subtle rounded-lg p-1">
            {phaseTabs.map((phase) => (
              <button
                key={phase.key}
                onClick={() => onPhaseChange(phase.key)}
                className={`phase-tab ${
                  currentPhase === phase.key && !isSettingsActive && !isHelpActive
                    ? "phase-tab-active"
                    : "phase-tab-inactive"
                }`}
              >
                {phase.label}
              </button>
            ))}
          </div>
        )}

        {/* Right: Active agents + Help + Status + Settings */}
        <div className="flex items-center gap-3">
          {project ? (
            <>
              <ActiveAgentsList projectId={project.id} />
              <NotificationBell projectId={project.id} />
              <ConnectionIndicator />
              <Link
                to={helpHref}
                className={`p-1.5 rounded-md transition-colors inline-flex items-center justify-center ${
                  isHelpActive ? "phase-tab phase-tab-active aspect-square shrink-0 !p-2" : helpButtonClassName
                }`}
                aria-label="Help"
                title="Help"
              >
                <span className="text-lg font-medium leading-none">?</span>
              </Link>
              <Link
                to={settingsHref}
                className={`p-1.5 rounded-md transition-colors ${
                  isSettingsActive ? "phase-tab phase-tab-active" : "text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle"
                }`}
                aria-label="Project settings"
                title="Project settings"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </Link>
            </>
          ) : projects.length >= 1 ? (
            <>
              <GlobalActiveAgentsList />
              <GlobalNotificationBell />
              <Link
                to={helpHref}
                className={`p-1.5 rounded-md transition-colors inline-flex items-center justify-center ${
                  isHelpActive ? "phase-tab phase-tab-active aspect-square shrink-0 !p-2" : helpButtonClassName
                }`}
                aria-label="Help"
                title="Help"
              >
                <span className="text-lg font-medium leading-none">?</span>
              </Link>
              <Link
                to={settingsHref}
                className={`p-1.5 rounded-md transition-colors ${
                  isSettingsActive ? "phase-tab phase-tab-active" : "text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle"
                }`}
                aria-label="Settings"
                title="Settings"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </Link>
            </>
          ) : (
            <>
              <Link
                to={helpHref}
                className={`p-1.5 rounded-md transition-colors inline-flex items-center justify-center ${
                  isHelpActive ? "phase-tab phase-tab-active aspect-square shrink-0 !p-2" : helpButtonClassName
                }`}
                aria-label="Help"
                title="Help"
              >
                <span className="text-lg font-medium leading-none">?</span>
              </Link>
              <Link
                to={settingsHref}
                className={`p-1.5 rounded-md transition-colors ${
                  isSettingsActive ? "phase-tab phase-tab-active" : "text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle"
                }`}
                aria-label="Settings"
                title="Settings"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
