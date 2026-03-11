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
import { useAppDispatch, useAppSelector } from "../store";
import { setSelectedTaskId } from "../store/slices/executeSlice";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { setSelectedPlanId } from "../store/slices/planSlice";
import { useDisplayPreferences } from "../contexts/DisplayPreferencesContext";
import { UptimeDisplay } from "./UptimeDisplay";
import { api } from "../api/client";
import { AGENT_DROPDOWN_ICON_SIZE } from "../lib/constants";
import { getDropdownPositionRightAligned } from "../lib/dropdownViewport";
import { getAgentIconSrc, getPhaseForAgentNavigation } from "../lib/agentUtils";
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
  onKillSuccess: (agentId: string) => void;
}) {
  const [killing, setKilling] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const roleForDesc = getAgentRoleForDescription(agent);
  const description = roleForDesc ? AGENT_ROLE_DESCRIPTIONS[roleForDesc] : undefined;
  const statusLabel = agent.state === "suspended" ? "Suspended" : null;

  const performKill = useCallback(() => {
    setKilling(true);
    api.agents
      .kill(projectId, agent.id)
      .then(() => onKillSuccess(agent.id))
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
            {getRoleDisplayLabel(agent)} &middot;{" "}
            {statusLabel ? statusLabel : <UptimeDisplay startedAt={agent.startedAt} />}
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
  const agents = useAppSelector((state) => state.execute.activeAgents);
  const loadedOnce = useAppSelector((state) => state.execute.activeAgentsLoadedOnce);
  const showLoading = !loadedOnce;
  const showLoadingInDropdown = !loadedOnce;
  const [open, setOpen] = useState(false);
  const [hiddenAgentIds, setHiddenAgentIds] = useState<Set<string>>(new Set());
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

  useEffect(() => {
    setHiddenAgentIds((prev) => {
      if (prev.size === 0) return prev;
      const liveIds = new Set(agents.map((agent) => agent.id));
      const next = new Set([...prev].filter((id) => liveIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [agents]);

  useEffect(() => {
    setHiddenAgentIds(new Set());
  }, [projectId]);

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
      const phase = getPhaseForAgentNavigation(agent);
      if (agent.role === "analyst" && agent.feedbackId) {
        navigate(getProjectPhasePath(projectId, "eval", { feedback: agent.feedbackId }));
      } else if (agent.role === "auditor" && agent.planId) {
        // Auditor results deep-link to Plan view (not Execute tasks)
        dispatch(setSelectedPlanId(agent.planId));
        navigate(getProjectPhasePath(projectId, "plan", { plan: agent.planId }));
      } else if (agent.planId && phase === "plan") {
        dispatch(setSelectedPlanId(agent.planId));
        navigate(getProjectPhasePath(projectId, "plan", { plan: agent.planId }));
      } else if (phase === "execute") {
        const selectedTaskId = agent.taskId ?? agent.id;
        dispatch(setSelectedTaskId(selectedTaskId));
        navigate(getProjectPhasePath(projectId, "execute", { task: selectedTaskId }));
      } else {
        if (phase === "plan") dispatch(setSelectedPlanId(null));
        navigate(getProjectPhasePath(projectId, phase));
      }
      setOpen(false);
    },
    [dispatch, navigate, projectId]
  );

  const handleKillSuccess = useCallback((agentId: string) => {
    setHiddenAgentIds((prev) => new Set(prev).add(agentId));
  }, []);

  /** Sort agents by canonical README/PRD order for consistent icon display. */
  const visibleAgents =
    hiddenAgentIds.size === 0 ? agents : agents.filter((agent) => !hiddenAgentIds.has(agent.id));
  const sortedAgents = sortAgentsByCanonicalOrder(visibleAgents);

  const BUTTON_AGENT_ICON_SIZE = "1.5rem";

  const dropdownContent =
    open && dropdownRect ? (
      <div
        ref={dropdownRef}
        role="listbox"
        className="bg-theme-surface rounded-lg shadow-lg border border-theme-border py-2"
        style={{
          ...getDropdownPositionRightAligned(dropdownRect, {
            minWidth: 0,
            estimatedHeight: 280,
          }),
          width: "fit-content",
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
        ) : sortedAgents.length === 0 ? (
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
    <div className="relative w-fit">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border-none ring-0 bg-transparent hover:bg-theme-border-subtle focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 text-theme-text transition-colors w-fit select-none"
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Active agents"
      >
        <span
          className={`inline-flex items-center gap-1.5 flex-wrap ${
            runningAgentsDisplayMode === "icons" ? "justify-end" : "justify-center"
          }`}
        >
          {showLoading ? (
            <LoadingSpinner className="w-4 h-4" />
          ) : sortedAgents.length > 0 ? (
            <>
              {(runningAgentsDisplayMode === "count" || runningAgentsDisplayMode === "both") && (
                <span>
                  {sortedAgents.length} agent{sortedAgents.length === 1 ? "" : "s"} running
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
