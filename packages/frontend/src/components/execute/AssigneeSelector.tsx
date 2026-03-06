import React, { useState, useEffect, useRef } from "react";
import { isAgentAssignee } from "@opensprint/shared";
import { useAppDispatch } from "../../store";
import { updateTaskAssignee } from "../../store/slices/executeSlice";

export interface AssigneeSelectorProps {
  projectId: string;
  taskId: string;
  currentAssignee: string | null;
  teamMembers: Array<{ id: string; name: string }>;
  /** Called after assignee update succeeds. Optional; Redux is updated by the thunk. */
  onSelect?: (assignee: string | null) => void;
  /** When true, show agent icon instead of person icon. Default: derived from isAgentAssignee(currentAssignee). */
  isAgentAssignee?: boolean;
  /** When true, show read-only display (e.g. for done tasks). */
  readOnly?: boolean;
}

/** Person icon for human-assigned tasks. */
function PersonIcon({ size = "sm" }: { size?: "xs" | "sm" }) {
  const cls = size === "xs" ? "w-3 h-3" : "w-4 h-4";
  return (
    <svg
      className={`${cls} shrink-0 text-theme-muted`}
      viewBox="0 0 16 16"
      role="img"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 2-2 2H4c-1 0-2-1-2-2v-1a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v1z"
      />
    </svg>
  );
}

/** Agent/bot icon for agent-assigned tasks. */
function AgentIcon({ size = "sm" }: { size?: "xs" | "sm" }) {
  const cls = size === "xs" ? "w-3 h-3" : "w-4 h-4";
  return (
    <svg
      className={`${cls} shrink-0 text-theme-muted`}
      viewBox="0 0 16 16"
      role="img"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M8 2a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-1H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2V4a2 2 0 0 1 2-2h2zm0 2v2h2V4H8zm-4 3v2h2V7H4zm8 0v2h2V7h-2zm-4 3v2h2v-2H8z"
      />
    </svg>
  );
}

export function AssigneeSelector({
  projectId,
  taskId,
  currentAssignee,
  teamMembers,
  onSelect,
  isAgentAssignee: isAgentProp,
  readOnly = false,
}: AssigneeSelectorProps) {
  const dispatch = useAppDispatch();
  const isAgent = isAgentProp ?? (!!currentAssignee && isAgentAssignee(currentAssignee));
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [otherInput, setOtherInput] = useState("");
  const [showOtherInput, setShowOtherInput] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowOtherInput(false);
        setOtherInput("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const displayLabel = currentAssignee?.trim() ? currentAssignee : "—";

  const handleSelect = async (assignee: string | null) => {
    if (assignee === currentAssignee) {
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      await dispatch(
        updateTaskAssignee({ projectId, taskId, assignee })
      ).unwrap();
      onSelect?.(assignee);
      setOpen(false);
      setShowOtherInput(false);
      setOtherInput("");
    } finally {
      setLoading(false);
    }
  };

  const handleOtherSubmit = async () => {
    const trimmed = otherInput.trim();
    if (!trimmed) return;
    await handleSelect(trimmed);
  };

  if (readOnly) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-theme-muted/80 cursor-default"
        data-testid="assignee-read-only"
      >
        {isAgent ? <AgentIcon size="sm" /> : <PersonIcon size="sm" />}
        {displayLabel}
      </span>
    );
  }

  return (
    <div ref={dropdownRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={loading}
        className="dropdown-trigger inline-flex items-center gap-2 rounded py-1 text-theme-muted hover:bg-theme-border-subtle/50 hover:text-theme-text transition-colors cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={loading}
        aria-label={`Assignee: ${displayLabel}. Click to change`}
        data-testid="assignee-dropdown-trigger"
      >
        {isAgent ? <AgentIcon size="sm" /> : <PersonIcon size="sm" />}
        <span>{displayLabel}</span>
        {loading ? (
          <span className="text-[10px] opacity-70 pr-2 animate-pulse">Updating…</span>
        ) : (
          <span className="text-[10px] opacity-70 pr-2">{open ? "▲" : "▼"}</span>
        )}
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 top-full mt-1 z-50 min-w-[160px] rounded-lg border border-theme-border bg-theme-surface shadow-lg py-1"
          data-testid="assignee-dropdown"
        >
          <li role="option">
            <button
              type="button"
              onClick={() => handleSelect(null)}
              className={`dropdown-item w-full flex items-center gap-2 text-left text-xs hover:bg-theme-border-subtle/50 transition-colors px-3 py-2 ${
                !currentAssignee ? "text-brand-600 font-medium" : "text-theme-text"
              }`}
              data-testid="assignee-option-unassigned"
            >
              Unassigned
            </button>
          </li>
          {teamMembers.map((m) => {
            const label = m.name || m.id;
            const isSelected = currentAssignee === m.id || currentAssignee === m.name;
            return (
              <li key={m.id} role="option">
                <button
                  type="button"
                  onClick={() => handleSelect(m.name || m.id)}
                  className={`dropdown-item w-full flex items-center gap-2 text-left text-xs hover:bg-theme-border-subtle/50 transition-colors px-3 py-2 ${
                    isSelected ? "text-brand-600 font-medium" : "text-theme-text"
                  }`}
                  data-testid={`assignee-option-${m.id}`}
                >
                  <PersonIcon size="xs" />
                  {label}
                </button>
              </li>
            );
          })}
          {showOtherInput ? (
            <li className="px-3 py-2 border-t border-theme-border mt-1 pt-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={otherInput}
                  onChange={(e) => setOtherInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleOtherSubmit();
                    if (e.key === "Escape") {
                      setShowOtherInput(false);
                      setOtherInput("");
                    }
                  }}
                  placeholder="Enter name…"
                  className="flex-1 text-xs px-2 py-1 rounded border border-theme-border bg-theme-surface text-theme-text focus:outline-none focus:ring-1 focus:ring-brand-500"
                  data-testid="assignee-other-input"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleOtherSubmit}
                  disabled={!otherInput.trim()}
                  className="text-xs px-2 py-1 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="assignee-other-submit"
                >
                  Add
                </button>
              </div>
            </li>
          ) : (
            <li role="option">
              <button
                type="button"
                onClick={() => setShowOtherInput(true)}
                className="dropdown-item w-full flex items-center gap-2 text-left text-xs hover:bg-theme-border-subtle/50 transition-colors px-3 py-2 text-theme-muted"
                data-testid="assignee-option-other"
              >
                Other…
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
