import { useState, useEffect, useRef, memo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { ActiveAgent, Project } from "@opensprint/shared";
import {
  AGENT_ROLE_DESCRIPTIONS,
  AGENT_ROLE_LABELS,
  getRoleDisplayLabel,
  getSlotForRole,
  sortAgentsByCanonicalOrder,
} from "@opensprint/shared";
import type { AgentRole } from "@opensprint/shared";
import { useAppDispatch, useAppSelector } from "../store";
import { fetchGlobalActiveAgents } from "../store/slices/globalSlice";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { setSelectedTaskId } from "../store/slices/executeSlice";
import { setSelectedPlanId } from "../store/slices/planSlice";
import { useDisplayPreferences } from "../contexts/DisplayPreferencesContext";
import { UptimeDisplay } from "./UptimeDisplay";
import { api } from "../api/client";
import { getKillAgentConfirmDisabled } from "../lib/killAgentConfirmStorage";
import { KillAgentConfirmDialog } from "./KillAgentConfirmDialog";

/** Circled X icon (⊗) for Kill button */
function KillAgentCircledXIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M8 8l8 8M16 8l-8 8" />
    </svg>
  );
}

const POLL_INTERVAL_MS = 5000;

/** z-index for dropdown portal — above Build sidebar (z-50) and Navbar (z-60) */
const DROPDOWN_Z_INDEX = 9999;

/** Icon size matching two lines of text-sm in dropdown rows */
const DROPDOWN_AGENT_ICON_SIZE = "3.01875rem";

/** Base URL for public assets (Vite BASE_URL so icons load when app is served from a subpath) */
const ASSET_BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/*$/, "/");

export interface AgentWithProject {
  project: Project;
  agent: ActiveAgent;
}

/** Compact loading spinner matching design system (border-brand-600, animate-spin) */
function LoadingSpinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <div
      className={`border-2 border-brand-600 border-t-transparent rounded-full animate-spin ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}

/** True when agent is in Plan phase or has a planning-slot role (Planner, Dreamer, etc.). */
function isPlanningAgent(agent: ActiveAgent): boolean {
  return (
    agent.phase === "plan" ||
    (!!agent.role &&
      getSlotForRole(agent.role as Parameters<typeof getSlotForRole>[0]) === "planning")
  );
}

const getAgentIconSrc = (agent: ActiveAgent): string => {
  const role = agent.role;
  if (role && role in AGENT_ROLE_LABELS) {
    const iconName = role.replace(/_/g, "-");
    return `${ASSET_BASE}agent-icons/${iconName}.svg`;
  }
  if (agent.phase === "review") return `${ASSET_BASE}agent-icons/reviewer.svg`;
  return `${ASSET_BASE}agent-icons/coder.svg`;
};

/** Resolve agent to role for description lookup (role or phase-derived). */
function getAgentRoleForDescription(agent: ActiveAgent): AgentRole | null {
  if (agent.role && agent.role in AGENT_ROLE_DESCRIPTIONS) return agent.role as AgentRole;
  if (agent.phase === "review") return "reviewer";
  if (agent.phase === "coding") return "coder";
  return null;
}

/** Sort entries by agent role in canonical README/PRD order. */
function sortEntriesByCanonicalOrder<T extends { agent: ActiveAgent }>(entries: T[]): T[] {
  return sortAgentsByCanonicalOrder(entries, (e) => e.agent);
}

/** Memoized row — only re-renders when entry or onClick change; UptimeDisplay handles its own tick. */
const GlobalAgentDropdownItem = memo(function GlobalAgentDropdownItem({
  project,
  agent,
  onClick,
  onKillSuccess,
}: {
  project: Project;
  agent: ActiveAgent;
  onClick: (projectId: string, agent: ActiveAgent) => void;
  onKillSuccess: () => void;
}) {
  const [killing, setKilling] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const roleForDesc = getAgentRoleForDescription(agent);
  const description = roleForDesc ? AGENT_ROLE_DESCRIPTIONS[roleForDesc] : undefined;

  const performKill = useCallback(() => {
    setKilling(true);
    api.agents
      .kill(project.id, agent.id)
      .then(() => onKillSuccess())
      .finally(() => {
        setKilling(false);
        setShowConfirmDialog(false);
      });
  }, [project.id, agent.id, onKillSuccess]);

  const handleKill = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (killing) return;
      if (getKillAgentConfirmDisabled()) {
        performKill();
      } else {
        setShowConfirmDialog(true);
      }
    },
    [killing, performKill]
  );

  const handleConfirm = useCallback(() => {
    performKill();
  }, [performKill]);

  return (
    <li role="option" className="group flex items-stretch">
      <button
        type="button"
        className="flex-1 min-w-0 px-4 py-2.5 text-sm text-left hover:bg-theme-border group-hover:bg-theme-border focus-visible:bg-theme-border transition-colors flex items-start gap-3 cursor-pointer"
        onClick={() => onClick(project.id, agent)}
        title={description}
      >
        <img
          src={getAgentIconSrc(agent)}
          alt=""
          className="shrink-0 object-contain object-center -mt-1 translate-y-1"
          style={{
            width: DROPDOWN_AGENT_ICON_SIZE,
            height: DROPDOWN_AGENT_ICON_SIZE,
            marginLeft: "2px",
          }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-theme-text">{agent.label || agent.id}</div>
          <div className="text-theme-muted mt-0.5">
            {project.name} · {getRoleDisplayLabel(agent)} ·{" "}
            <UptimeDisplay startedAt={agent.startedAt} />
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={handleKill}
        disabled={killing}
        className="shrink-0 px-2 flex items-center justify-center text-theme-muted hover:text-red-600 hover:bg-theme-border group-hover:bg-theme-border transition-colors disabled:opacity-50 opacity-0 group-hover:opacity-100 cursor-pointer"
        title="Kill agent"
        aria-label="Kill agent"
      >
        <KillAgentCircledXIcon className="w-4 h-4" />
      </button>
      {showConfirmDialog &&
        createPortal(
          <KillAgentConfirmDialog
            onConfirm={handleConfirm}
            onCancel={() => setShowConfirmDialog(false)}
            confirming={killing}
          />,
          document.body
        )}
    </li>
  );
});

/**
 * Running agents across all projects for the home screen navbar.
 * Renders only when at least one project exists. Second row: [Project name] [Role] [runtime].
 */
/** Icon size for inline agent icons in the button (~20% larger than previous 1.25rem). */
const BUTTON_AGENT_ICON_SIZE = "1.5rem";

export function GlobalActiveAgentsList() {
  const { runningAgentsDisplayMode } = useDisplayPreferences();
  const dispatch = useAppDispatch();
  const entries = useAppSelector((s) => s.global?.globalActiveAgents ?? []);
  const loadedOnce = useAppSelector((s) => s.global?.globalAgentsLoadedOnce ?? false);
  /** Only show loading when never loaded; use cached list when refreshing (avoids flash on open) */
  const showLoading = !loadedOnce;
  const showLoadingInDropdown = !loadedOnce;
  const [open, setOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    dispatch(fetchGlobalActiveAgents());
    const interval = setInterval(() => dispatch(fetchGlobalActiveAgents()), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [dispatch]);

  useEffect(() => {
    if (open && buttonRef.current) {
      setDropdownRect(buttonRef.current.getBoundingClientRect());
    } else {
      setDropdownRect(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    dispatch(fetchGlobalActiveAgents());
  }, [open, dispatch]);

  const handleAgentClick = useCallback(
    (projectId: string, agent: ActiveAgent) => {
      if (agent.role === "analyst" && agent.feedbackId) {
        navigate(getProjectPhasePath(projectId, "eval", { feedback: agent.feedbackId }));
      } else if (agent.planId) {
        dispatch(setSelectedPlanId(agent.planId));
        navigate(getProjectPhasePath(projectId, "plan", { plan: agent.planId }));
      } else if (isPlanningAgent(agent)) {
        dispatch(setSelectedPlanId(null));
        navigate(getProjectPhasePath(projectId, "plan"));
      } else {
        dispatch(setSelectedTaskId(agent.id));
        navigate(getProjectPhasePath(projectId, "execute", { task: agent.id }));
      }
      setOpen(false);
    },
    [dispatch, navigate]
  );

  const handleKillSuccess = useCallback(() => {
    dispatch(fetchGlobalActiveAgents());
  }, [dispatch]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if ((target as Element).closest?.("[data-kill-agent-dialog]")) return;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  // Navbar gates visibility by projects.length >= 1, so we always render when mounted
  const dropdownContent =
    open && dropdownRect ? (
      <div
        ref={dropdownRef}
        role="listbox"
        className="fixed min-w-[220px] max-h-[320px] overflow-y-auto bg-theme-surface rounded-lg shadow-lg border border-theme-border py-2"
        style={{
          top: dropdownRect.bottom + 4,
          right: window.innerWidth - dropdownRect.right,
          zIndex: DROPDOWN_Z_INDEX,
        }}
      >
        {showLoadingInDropdown ? (
          <div
            className="px-4 py-6 flex items-center justify-center"
            role="status"
            aria-label="Loading agents"
          >
            <LoadingSpinner className="w-4 h-4" />
          </div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-theme-muted">No agents running</div>
        ) : (
          <ul className="divide-y divide-theme-border-subtle">
            {sortEntriesByCanonicalOrder(entries).map(({ project, agent }) => (
              <GlobalAgentDropdownItem
                key={`${project.id}-${agent.id}`}
                project={project}
                agent={agent}
                onClick={handleAgentClick}
                onKillSuccess={handleKillSuccess}
              />
            ))}
          </ul>
        )}
      </div>
    ) : null;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border-none ring-0 bg-transparent hover:bg-theme-border-subtle focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 text-theme-text transition-colors"
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Active agents"
      >
        <span
          className={`min-w-[7.5rem] inline-flex items-center gap-1.5 flex-wrap ${
            runningAgentsDisplayMode === "icons" ? "justify-end" : "justify-center"
          }`}
        >
          {showLoading ? (
            <LoadingSpinner className="w-4 h-4" />
          ) : entries.length > 0 ? (
            <>
              {(runningAgentsDisplayMode === "count" || runningAgentsDisplayMode === "both") && (
                <span>
                  {entries.length} agent{entries.length === 1 ? "" : "s"} running
                </span>
              )}
              {(runningAgentsDisplayMode === "icons" || runningAgentsDisplayMode === "both") && (
                <span className="inline-flex items-center gap-0.5" aria-hidden>
                  {sortEntriesByCanonicalOrder(entries).map(({ agent }) => (
                    <img
                      key={agent.id}
                      src={getAgentIconSrc(agent)}
                      alt=""
                      className="shrink-0 object-contain object-center"
                      style={{
                        width: BUTTON_AGENT_ICON_SIZE,
                        height: BUTTON_AGENT_ICON_SIZE,
                        marginLeft: "2px",
                      }}
                    />
                  ))}
                </span>
              )}
            </>
          ) : (
            "No agents running"
          )}
        </span>
        <svg
          className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {dropdownContent && createPortal(dropdownContent, document.body)}
    </div>
  );
}
