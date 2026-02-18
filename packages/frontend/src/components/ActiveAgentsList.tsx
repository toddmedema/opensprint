import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { ActiveAgent } from "@opensprint/shared";
import { AGENT_ROLE_LABELS } from "@opensprint/shared";
import { api } from "../api/client";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { formatUptime } from "../lib/formatting";
import { useAppDispatch } from "../store";
import { setSelectedTaskId } from "../store/slices/executeSlice";

const POLL_INTERVAL_MS = 5000;

/** z-index for dropdown portal — above Build sidebar (z-50) and Navbar (z-60) */
const DROPDOWN_Z_INDEX = 9999;

interface ActiveAgentsListProps {
  projectId: string;
}

const UPTIME_TICK_MS = 1000;

export function ActiveAgentsList({ projectId }: ActiveAgentsListProps) {
  const [agents, setAgents] = useState<ActiveAgent[]>([]);
  const [open, setOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null);
  const [now, setNow] = useState(() => new Date());
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const dispatch = useAppDispatch();

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api.agents.active(projectId);
      setAgents(Array.isArray(data) ? data : []);
    } catch {
      setAgents([]);
    }
  }, [projectId]);

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  useEffect(() => {
    if (open && buttonRef.current) {
      setDropdownRect(buttonRef.current.getBoundingClientRect());
    } else {
      setDropdownRect(null);
    }
  }, [open]);

  // Live uptime tick: update every second when dropdown is open
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => setNow(new Date()), UPTIME_TICK_MS);
    return () => clearInterval(interval);
  }, [open]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
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

  const phaseLabel = (phase: string) => {
    const m: Record<string, string> = {
      spec: "Spec",
      plan: "Plan",
      execute: "Execute",
      eval: "Eval",
      deliver: "Deliver",
      coding: "Coding",
      review: "Review",
    };
    return m[phase] ?? phase;
  };

  const roleLabel = (agent: ActiveAgent) =>
    agent.role && agent.role in AGENT_ROLE_LABELS
      ? AGENT_ROLE_LABELS[agent.role as keyof typeof AGENT_ROLE_LABELS]
      : phaseLabel(agent.phase);

  const dropdownContent =
    open && dropdownRect ? (
      <div
        ref={dropdownRef}
        role="listbox"
        className="fixed min-w-[220px] max-h-[320px] overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg py-2"
        style={{
          top: dropdownRect.bottom + 4,
          right: window.innerWidth - dropdownRect.right,
          zIndex: DROPDOWN_Z_INDEX,
        }}
      >
        {agents.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">No agents running</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {agents.map((agent) => (
              <li key={agent.id} role="option">
                <button
                  type="button"
                  className="w-full px-4 py-2.5 text-sm text-left hover:bg-gray-50 transition-colors"
                  onClick={() => {
                    dispatch(setSelectedTaskId(agent.id));
                    navigate(getProjectPhasePath(projectId, "execute"));
                    setOpen(false);
                  }}
                >
                  <div className="font-medium text-gray-900">{agent.label || agent.id}</div>
                  <div className="text-gray-500 mt-0.5">
                    {roleLabel(agent)} &middot;{" "}
                    <span className="text-gray-400 tabular-nums">{formatUptime(agent.startedAt, now)}</span>
                  </div>
                </button>
              </li>
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
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-700 transition-colors"
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Active agents"
      >
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" aria-hidden />
        <span>
          {agents.length > 0 ? `${agents.length} agent${agents.length === 1 ? "" : "s"} running` : "No agents running"}
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
