import { useState, useEffect, useRef, useMemo } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { NavButton } from "./NavButton";
import type { Project, ProjectPhase } from "@opensprint/shared";
import { NAVBAR_HEIGHT } from "../../lib/constants";
import { shouldRightAlignDropdown } from "../../lib/dropdownViewport";
import { useAppSelector, useAppDispatch } from "../../store";
import { selectTasks } from "../../store/slices/executeSlice";
import {
  selectPhaseUnread,
  EMPTY_PHASE_UNREAD,
  setPhaseUnread,
  clearPhaseUnread,
} from "../../store/slices/unreadPhaseSlice";
import { wsConnectHome } from "../../store/middleware/websocketMiddleware";
import { getProjectPhasePath } from "../../lib/phaseRouting";
import { api } from "../../api/client";
import { ActiveAgentsList } from "../ActiveAgentsList";
import { GlobalActiveAgentsList } from "../GlobalActiveAgentsList";
import { NotificationBell } from "../NotificationBell";
import { GlobalNotificationBell } from "../GlobalNotificationBell";
import { ConnectionIndicator } from "../ConnectionIndicator";
import { useDbStatus } from "../../api/hooks";
import { useIsOffline } from "../../hooks/useIsOffline";
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
  onProjectSaved: _onProjectSaved,
}: NavbarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectDropdownAlignRight, setProjectDropdownAlignRight] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);

  const isSettingsActive = Boolean(
    location.pathname === "/settings" ||
      (project ? location.pathname === `/projects/${project.id}/settings` : false)
  );

  const isHelpActive = Boolean(
    location.pathname === "/help" ||
      (project ? location.pathname === `/projects/${project.id}/help` : false)
  );

  const settingsHref = project ? `/projects/${project.id}/settings` : "/settings";
  const helpHref = project ? `/projects/${project.id}/help` : "/help";

  const dispatch = useAppDispatch();
  const { data: dbStatus } = useDbStatus();
  const executeBlockedCount = useAppSelector((s) => {
    const implTasks = selectTasks(s).filter((t) => t.type !== "epic");
    return implTasks.filter((t) => t.kanbanColumn === "blocked").length;
  });

  const phaseUnread = useAppSelector((s) =>
    project?.id ? selectPhaseUnread(s, project.id) : EMPTY_PHASE_UNREAD
  );

  const phaseTabs = useMemo(
    () =>
      (["sketch", "plan", "execute", "eval", "deliver"] as const).map((key) => {
        const label = PHASE_LABELS[key];
        const showUnreadDot =
          key === "plan" ? phaseUnread.plan : key === "sketch" ? phaseUnread.sketch : key === "execute" ? phaseUnread.execute : false;
        const ariaLabel =
          showUnreadDot && key === "plan"
            ? "Plan has updates"
            : showUnreadDot && key === "sketch"
              ? "Sketch has updates"
              : showUnreadDot && key === "execute"
                ? "Execute has blocked tasks"
                : `Switch to ${label} phase`;
        return { key, label, showUnreadDot, ariaLabel };
      }),
    [phaseUnread.plan, phaseUnread.sketch, phaseUnread.execute]
  );
  const showDbBackedChrome = dbStatus?.ok === true;
  const isOffline = useIsOffline();
  const showAgentDropdown = showDbBackedChrome && !isOffline;
  /** In Electron, Help and Settings are in app menus only; hide from nav bar. */
  const showHelpAndSettingsInNav = typeof window === "undefined" || !window.electron?.isElectron;

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

  // Set or clear Execute unread from task list: set when not on Execute and has blocked tasks; clear when on Execute or no blocked tasks
  useEffect(() => {
    if (!project?.id) return;
    if (currentPhase !== "execute" && executeBlockedCount > 0) {
      dispatch(setPhaseUnread({ projectId: project.id, phase: "execute" }));
    } else {
      dispatch(clearPhaseUnread({ projectId: project.id, phase: "execute" }));
    }
  }, [project?.id, currentPhase, executeBlockedCount, dispatch]);

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

  useEffect(() => {
    if (dropdownOpen && projectTriggerRef.current) {
      setProjectDropdownAlignRight(
        shouldRightAlignDropdown(projectTriggerRef.current.getBoundingClientRect())
      );
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
      className="relative z-[60] flex items-stretch bg-theme-surface shrink-0 overflow-hidden py-0"
      style={{ height: NAVBAR_HEIGHT }}
    >
      {/* Bottom border overlay — ensures continuous line across full width, above phase buttons */}
      <div
        data-testid="navbar-bottom-border"
        className="absolute bottom-0 left-0 right-0 h-px bg-theme-border pointer-events-none z-10"
        aria-hidden="true"
      />
      {/* Grid: 1fr auto 1fr so center (phase tabs) is viewport-centered regardless of left content width. */}
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-stretch gap-2 min-w-0 py-0 pl-4 md:pl-6 pr-4 md:pr-6">
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          {/* Left: Logo + Project Selector */}
          <Link to="/" className="flex items-center gap-2" data-testid="navbar-logo-link">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 80 80"
              className="w-8 h-8"
              aria-hidden="true"
            >
              <polygon points="4,10 36,40 4,70" fill="#d8d8de" />
              <polygon points="22,10 54,40 22,70" fill="#a1a1aa" />
              <polygon points="40,10 72,40 40,70" fill="#0071e3" />
            </svg>
          </Link>

          <div
            data-testid="navbar-project-select"
            className="relative hidden min-[800px]:flex items-center min-w-0"
            ref={dropdownRef}
          >
            <button
              ref={projectTriggerRef}
              type="button"
              onClick={() => setDropdownOpen((o) => !o)}
              className="dropdown-trigger inline-flex items-center gap-1 min-h-[44px] min-w-[44px] text-sm font-medium text-theme-muted hover:text-theme-text transition-colors rounded py-1 px-2 hover:bg-theme-border-subtle max-w-[120px] md:max-w-none"
              aria-expanded={dropdownOpen}
              aria-haspopup="listbox"
              aria-label={`Select project: ${project ? project.name : "All Projects"}`}
            >
              <span className="truncate">{project ? project.name : "All Projects"}</span>
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
                className={`absolute top-full mt-1 min-w-[200px] max-w-[min(280px,calc(100vw-2rem))] max-h-[min(280px,calc(100vh-6rem))] overflow-y-auto bg-theme-surface border border-theme-border rounded-lg shadow-lg py-1 z-50 ${projectDropdownAlignRight ? "right-0 left-auto" : "left-0 right-auto"}`}
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

        {/* Center: Phase Tabs — viewport-centered via grid; horizontally scrollable on mobile */}
        <div className="flex justify-center min-w-0 overflow-x-auto px-1 md:px-0 items-stretch [&::-webkit-scrollbar]:h-1">
          {project && currentPhase && onPhaseChange ? (
            <div
              className="flex items-stretch gap-1 bg-theme-border-subtle rounded-lg py-0 px-1 shrink-0 self-stretch min-h-0"
              role="tablist"
              aria-label="Phase navigation"
            >
              {phaseTabs.map((phase, index) => {
                const isActive = currentPhase === phase.key && !isSettingsActive && !isHelpActive;
                return (
                  <NavButton
                    key={phase.key}
                    role="tab"
                    active={isActive}
                    tone="accent"
                    className="min-h-0 h-full"
                    showUnreadDot={phase.showUnreadDot}
                    onClick={() => onPhaseChange(phase.key)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowLeft" && index > 0) {
                        e.preventDefault();
                        onPhaseChange(phaseTabs[index - 1].key);
                      } else if (e.key === "ArrowRight" && index < phaseTabs.length - 1) {
                        e.preventDefault();
                        onPhaseChange(phaseTabs[index + 1].key);
                      }
                    }}
                    aria-label={phase.ariaLabel}
                    aria-selected={isActive}
                    aria-current={isActive ? "page" : undefined}
                  >
                    {phase.label}
                  </NavButton>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* Right: Active agents + Help + Settings (Help/Settings only in web; in Electron they're in app menus) */}
        <div className="flex items-center justify-end [&>*:not(:first-child)]:pl-1 md:[&>*:not(:first-child)]:pl-3">
          {project ? (
            <>
              {showAgentDropdown && <ActiveAgentsList projectId={project.id} />}
              {showDbBackedChrome && <NotificationBell projectId={project.id} />}
              <ConnectionIndicator />
              {showHelpAndSettingsInNav && (
                <>
                  <NavButton
                    to={helpHref}
                    active={isHelpActive}
                    tone="accent"
                    variant="icon"
                    className="shrink-0"
                    aria-label="Help"
                    title="Help"
                  >
                    <span className="text-lg font-medium leading-none">?</span>
                  </NavButton>
                  <NavButton
                    to={settingsHref}
                    active={isSettingsActive}
                    tone="accent"
                    variant="icon"
                    className="shrink-0"
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
                  </NavButton>
                </>
              )}
            </>
          ) : projects.length >= 1 ? (
            <>
              {showAgentDropdown && <GlobalActiveAgentsList />}
              {showDbBackedChrome && <GlobalNotificationBell />}
              {showHelpAndSettingsInNav && (
                <>
                  <NavButton
                    to={helpHref}
                    active={isHelpActive}
                    tone="accent"
                    variant="icon"
                    className="shrink-0"
                    aria-label="Help"
                    title="Help"
                  >
                    <span className="text-lg font-medium leading-none">?</span>
                  </NavButton>
                  <NavButton
                    to={settingsHref}
                    active={isSettingsActive}
                    tone="accent"
                    variant="icon"
                    className="shrink-0"
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
                  </NavButton>
                </>
              )}
            </>
          ) : (
            <>
              {showHelpAndSettingsInNav && (
                <>
                  <NavButton
                    to={helpHref}
                    active={isHelpActive}
                    tone="accent"
                    variant="icon"
                    className="shrink-0"
                    aria-label="Help"
                    title="Help"
                  >
                    <span className="text-lg font-medium leading-none">?</span>
                  </NavButton>
                  <NavButton
                    to={settingsHref}
                    active={isSettingsActive}
                    tone="accent"
                    variant="icon"
                    className="shrink-0"
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
                  </NavButton>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
