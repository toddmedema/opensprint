import { useState, useEffect, useRef, memo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { ActiveAgent } from "@opensprint/shared";
import {
  AGENT_ROLE_DESCRIPTIONS,
  getRoleDisplayLabel,
  sortAgentsByCanonicalOrder,
} from "@opensprint/shared";
import type { AgentRole } from "@opensprint/shared";
import { useAppDispatch } from "../store";
import { setSelectedTaskId } from "../store/slices/executeSlice";
import { useActiveAgents } from "../api/hooks";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { setSelectedPlanId } from "../store/slices/planSlice";
import { useDisplayPreferences } from "../contexts/DisplayPreferencesContext";
import { UptimeDisplay } from "./UptimeDisplay";
import { api } from "../api/client";
import {
  ACTIVE_AGENTS_POLL_INTERVAL_MS,
  AGENT_DROPDOWN_ICON_SIZE,
  DROPDOWN_PORTAL_Z_INDEX,
} from "../lib/constants";
import { getAgentIconSrc, isPlanningAgent } from "../lib/agentUtils";
import { getKillAgentConfirmDisabled } from "../lib/killAgentConfirmStorage";
import { KillAgentConfirmDialog } from "./KillAgentConfirmDialog";

interface ActiveAgentsListProps {
  projectId: string;
}

/** Resolve agent to role for description lookup (role or phase-derived). */
function getAgentRoleForDescription(agent: ActiveAgent): AgentRole | null {
  if (agent.role && agent.role in AGENT_ROLE_DESCRIPTIONS) return agent.role as AgentRole;
  if (agent.phase === "review") return "reviewer";
  if (agent.phase === "coding") return "coder";
  return null;
}

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

/** Memoized row — only re-renders when agent or onClick change; UptimeDisplay handles its own tick. */
const AgentDropdownItem = memo(function AgentDropdownItem({
  agent,
  projectId,
  onClick,
  onKillSuccess,
}: {
  agent: ActiveAgent;
  projectId: string;
  onClick: (agent: ActiveAgent) => void;
  onKillSuccess: () => void;
}) {
  const [killing, setKilling] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const roleForDesc = getAgentRoleForDescription(agent);
  const description = roleForDesc ? AGENT_ROLE_DESCRIPTIONS[roleForDesc] : undefined;

  const performKill = useCallback(() => {
    setKilling(true);
    api.agents
      .kill(projectId, agent.id)
      .then(() => onKillSuccess())
      .finally(() => {
        setKilling(false);
        setShowConfirmDialog(false);
      });
  }, [projectId, agent.id, onKillSuccess]);

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
        onClick={() => onClick(agent)}
        title={description}
      >
        <img
          src={getAgentIconSrc(agent)}
          alt=""
          className="shrink-0 object-contain object-center -mt-1 translate-y-1"
          style={{
            width: AGENT_DROPDOWN_ICON_SIZE,
            height: AGENT_DROPDOWN_ICON_SIZE,
            marginLeft: "2px",
          }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-theme-text">{agent.label || agent.id}</div>
          <div className="text-theme-muted mt-0.5">
            {getRoleDisplayLabel(agent)} &middot; <UptimeDisplay startedAt={agent.startedAt} />
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

export function ActiveAgentsList({ projectId }: ActiveAgentsListProps) {
  const dispatch = useAppDispatch();
  const { data, isFetching, refetch } = useActiveAgents(projectId, {
    refetchInterval: ACTIVE_AGENTS_POLL_INTERVAL_MS,
  });
  const agents = data?.agents ?? [];
  /** Only show loading when never loaded; use cached list when refreshing (avoids flash on open) */
  const loadedOnce = data !== undefined;
  const showLoading = !loadedOnce && isFetching;
  const showLoadingInDropdown = !loadedOnce;
  const [open, setOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { runningAgentsDisplayMode } = useDisplayPreferences();

  useEffect(() => {
    if (open && buttonRef.current) {
      setDropdownRect(buttonRef.current.getBoundingClientRect());
    } else {
      setDropdownRect(null);
    }
  }, [open]);

  // When dropdown opens: immediately refresh agents so elapsed time is correct from first frame
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);

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

  const handleAgentClick = useCallback(
    (agent: ActiveAgent) => {
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
    [dispatch, navigate, projectId]
  );

  const handleKillSuccess = useCallback(() => {
    void refetch();
  }, [refetch]);

  /** Sort agents by canonical README/PRD order for consistent icon display. */
  const sortedAgents = sortAgentsByCanonicalOrder(agents);

  const BUTTON_AGENT_ICON_SIZE = "1.5rem";

  const dropdownContent =
    open && dropdownRect ? (
      <div
        ref={dropdownRef}
        role="listbox"
        className="fixed min-w-[220px] max-h-[320px] overflow-y-auto bg-theme-surface rounded-lg shadow-lg border border-theme-border py-2"
        style={{
          top: dropdownRect.bottom + 4,
          right: window.innerWidth - dropdownRect.right,
          zIndex: DROPDOWN_PORTAL_Z_INDEX,
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
        ) : agents.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-theme-muted">No agents running</div>
        ) : (
          <ul className="divide-y divide-theme-border-subtle">
            {sortedAgents.map((agent) => (
              <AgentDropdownItem
                key={agent.id}
                agent={agent}
                projectId={projectId}
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
          ) : agents.length > 0 ? (
            <>
              {(runningAgentsDisplayMode === "count" || runningAgentsDisplayMode === "both") && (
                <span>
                  {agents.length} agent{agents.length === 1 ? "" : "s"} running
                </span>
              )}
              {(runningAgentsDisplayMode === "icons" || runningAgentsDisplayMode === "both") && (
                <span className="inline-flex items-center gap-0.5" aria-hidden>
                  {sortedAgents.map((agent) => (
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
