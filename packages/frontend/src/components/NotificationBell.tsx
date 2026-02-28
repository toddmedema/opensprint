import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { Notification, NotificationSource, ApiBlockedErrorCode } from "@opensprint/shared";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { setSelectedPlanId } from "../store/slices/planSlice";
import { setSelectedTaskId } from "../store/slices/executeSlice";
import { fetchProjectNotifications } from "../store/slices/openQuestionsSlice";
import { useAppDispatch, useAppSelector } from "../store";

const POLL_INTERVAL_MS = 5000;

/** z-index for dropdown portal — above Build sidebar (z-50) and Navbar (z-60) */
const DROPDOWN_Z_INDEX = 9999;

const SOURCE_LABELS: Record<NotificationSource, string> = {
  plan: "Plan",
  prd: "PRD/Sketch",
  execute: "Execute",
  eval: "Evaluate",
};

/** Human-readable labels for API-blocked error types — user can distinguish failure types */
const API_BLOCKED_LABELS: Record<ApiBlockedErrorCode, string> = {
  rate_limit: "Rate limit",
  auth: "Invalid API key",
  out_of_credit: "Out of credit",
};

function truncatePreview(text: string, maxLen = 60): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim() + "…";
}

function formatTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

interface NotificationBellProps {
  projectId: string;
}

const EMPTY_NOTIFICATIONS: Notification[] = [];

export function NotificationBell({ projectId }: NotificationBellProps) {
  const notifications = useAppSelector((s) => {
    const list = s.openQuestions?.byProject?.[projectId];
    return list ?? EMPTY_NOTIFICATIONS;
  });
  const [open, setOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const dispatch = useAppDispatch();

  useEffect(() => {
    dispatch(fetchProjectNotifications(projectId));
    const interval = setInterval(
      () => dispatch(fetchProjectNotifications(projectId)),
      POLL_INTERVAL_MS
    );
    return () => clearInterval(interval);
  }, [projectId, dispatch]);

  useEffect(() => {
    if (open && buttonRef.current) {
      setDropdownRect(buttonRef.current.getBoundingClientRect());
    } else {
      setDropdownRect(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    dispatch(fetchProjectNotifications(projectId));
  }, [open, projectId, dispatch]);

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

  const handleNotificationClick = useCallback(
    (n: Notification) => {
      const phase =
        n.source === "plan"
          ? "plan"
          : n.source === "prd"
            ? "sketch"
            : n.source === "execute"
              ? "execute"
              : "eval";
      const options: { plan?: string; task?: string; feedback?: string; section?: string; question: string } = {
        question: n.id,
      };
      if (n.source === "plan") {
        options.plan = n.sourceId;
        dispatch(setSelectedPlanId(n.sourceId));
      } else if (n.source === "prd") {
        options.section = n.sourceId || "open_questions";
      } else if (n.source === "execute") {
        options.task = n.sourceId;
        dispatch(setSelectedTaskId(n.sourceId));
      } else if (n.source === "eval") {
        options.feedback = n.sourceId;
      }
      navigate(getProjectPhasePath(projectId, phase, options));
      setOpen(false);
    },
    [projectId, navigate, dispatch]
  );

  // Hide when zero notifications
  if (notifications.length === 0) return null;

  const preview = (n: Notification) =>
    n.questions.length > 0 ? truncatePreview(n.questions[0].text) : "Open question";

  const isApiBlocked = (n: Notification) => n.kind === "api_blocked";
  const getApiBlockedLabel = (n: Notification) =>
    n.errorCode ? API_BLOCKED_LABELS[n.errorCode] : "API blocked";

  const dropdownContent =
    open && dropdownRect ? (
      <div
        ref={dropdownRef}
        role="listbox"
        className="fixed min-w-[260px] max-h-[320px] overflow-y-auto bg-theme-surface rounded-lg shadow-lg border border-theme-border py-2"
        style={{
          top: dropdownRect.bottom + 4,
          right: window.innerWidth - dropdownRect.right,
          zIndex: DROPDOWN_Z_INDEX,
        }}
      >
        <ul className="divide-y divide-theme-border-subtle">
          {notifications.map((n) => (
            <li key={n.id} role="option">
              <button
                type="button"
                className={`w-full text-left px-4 py-2.5 text-sm hover:bg-theme-border-subtle transition-colors ${
                  isApiBlocked(n) ? "border-l-2 border-l-amber-500" : ""
                }`}
                onClick={() => handleNotificationClick(n)}
              >
                <div className="font-medium text-theme-text flex items-center gap-2">
                  {SOURCE_LABELS[n.source]}
                  {isApiBlocked(n) && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400"
                      title="Requires your action (API key, rate limit, or credits)"
                    >
                      {getApiBlockedLabel(n)}
                    </span>
                  )}
                </div>
                <div className="text-theme-muted mt-0.5">{truncatePreview(preview(n), 80)}</div>
                <div className="text-theme-muted text-xs mt-1">{formatTimestamp(n.createdAt)}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative p-1.5 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${notifications.length} notification${notifications.length === 1 ? "" : "s"}`}
        title="Notifications (open questions & API issues)"
      >
        <svg
          className="w-5 h-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        <span
          className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-theme-surface"
          aria-hidden
        />
      </button>
      {dropdownContent && createPortal(dropdownContent, document.body)}
    </div>
  );
}
