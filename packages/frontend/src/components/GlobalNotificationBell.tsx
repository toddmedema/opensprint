import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { Notification, Project } from "@opensprint/shared";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { setSelectedPlanId } from "../store/slices/planSlice";
import { setSelectedTaskId } from "../store/slices/executeSlice";
import { fetchGlobalNotifications } from "../store/slices/openQuestionsSlice";
import { useAppDispatch, useAppSelector } from "../store";
import { api } from "../api/client";
import { DROPDOWN_PORTAL_Z_INDEX } from "../lib/constants";
import {
  NOTIFICATION_POLL_INTERVAL_MS,
  NOTIFICATION_SOURCE_LABELS,
  truncatePreview,
  formatNotificationTimestamp,
} from "../lib/notificationUtils";

const EMPTY_NOTIFICATIONS: Notification[] = [];

export function GlobalNotificationBell() {
  const notifications = useAppSelector((s) => s.openQuestions?.global ?? EMPTY_NOTIFICATIONS);
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const dispatch = useAppDispatch();

  useEffect(() => {
    dispatch(fetchGlobalNotifications());
    const interval = setInterval(
      () => dispatch(fetchGlobalNotifications()),
      NOTIFICATION_POLL_INTERVAL_MS
    );
    return () => clearInterval(interval);
  }, [dispatch]);

  useEffect(() => {
    api.projects.list().then(setProjects).catch(console.error);
  }, []);

  useEffect(() => {
    if (open && buttonRef.current) {
      setDropdownRect(buttonRef.current.getBoundingClientRect());
    } else {
      setDropdownRect(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    dispatch(fetchGlobalNotifications());
  }, [open, dispatch]);

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

  const projectNameMap = new Map(projects.map((p) => [p.id, p.name]));

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
      navigate(getProjectPhasePath(n.projectId, phase, options));
      setOpen(false);
    },
    [navigate, dispatch]
  );

  // Hide when zero notifications
  if (notifications.length === 0) return null;

  const preview = (n: Notification) =>
    n.questions.length > 0 ? truncatePreview(n.questions[0].text) : "Open question";

  const dropdownContent =
    open && dropdownRect ? (
      <div
        ref={dropdownRef}
        role="listbox"
        className="fixed min-w-[280px] max-h-[320px] overflow-y-auto bg-theme-surface rounded-lg shadow-lg border border-theme-border py-2"
        style={{
          top: dropdownRect.bottom + 4,
          right: window.innerWidth - dropdownRect.right,
          zIndex: DROPDOWN_PORTAL_Z_INDEX,
        }}
      >
        <ul className="divide-y divide-theme-border-subtle">
          {notifications.map((n) => (
            <li key={n.id} role="option">
              <button
                type="button"
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-theme-border-subtle transition-colors"
                onClick={() => handleNotificationClick(n)}
              >
                <div className="font-medium text-theme-text">
                  {projectNameMap.get(n.projectId) ?? n.projectId} · {NOTIFICATION_SOURCE_LABELS[n.source]}
                </div>
                <div className="text-theme-muted mt-0.5">{truncatePreview(preview(n), 80)}</div>
                <div className="text-theme-muted text-xs mt-1">{formatNotificationTimestamp(n.createdAt)}</div>
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
        title="Open questions"
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
