import { useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { getProjectPhasePath } from "../lib/phaseRouting";
import type { ProjectPhase } from "@opensprint/shared";

const PHASE_BY_DIGIT: Record<string, ProjectPhase> = {
  "1": "sketch",
  "2": "plan",
  "3": "execute",
  "4": "eval",
  "5": "deliver",
};

/** Digit key codes (main keyboard and numpad when NumLock on). */
const PHASE_BY_CODE: Record<string, ProjectPhase> = {
  Digit1: "sketch",
  Digit2: "plan",
  Digit3: "execute",
  Digit4: "eval",
  Digit5: "deliver",
};

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  if (target.isContentEditable) return true;
  return false;
}

/** True if a modal/dialog is open so Escape should close it instead of opening settings. */
function isModalOpen(): boolean {
  const modal = document.querySelector("[role='dialog'], [aria-modal='true']");
  if (!modal || !(modal instanceof HTMLElement)) return false;
  // Consider only visible modals (exclude hidden or detached)
  const style = window.getComputedStyle(modal);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** True if the event target is inside a modal/dialog so Escape should close it, not open settings. */
function isFocusInModal(e: KeyboardEvent): boolean {
  const target = e.target;
  if (!target || !(target instanceof Element)) return false;
  const dialog = target.closest("[role='dialog'], [aria-modal='true']");
  return Boolean(dialog);
}

/**
 * Registers global keyboard shortcuts (web and Electron):
 * - 1/2/3/4/5: switch to Sketch/Plan/Execute/Evaluate/Deliver (when on a project)
 * - ~ (Backquote): go to home
 * - Escape: close modal if one is open; otherwise open settings (project if in a project, else global)
 * - ? or F1: open help (project help if in a project, else global; same navigation as Settings)
 */
/** Parse projectId from pathname when under /projects/:projectId/... (GlobalKeyboardShortcuts is outside Routes so useParams is empty). */
function projectIdFromPathname(pathname: string): string | undefined {
  const m = pathname.match(/^\/projects\/([^/]+)(?:\/|$)/);
  if (!m) return undefined;
  const id = m[1];
  if (id === "add-existing" || id === "create-new") return undefined;
  return id;
}

export function GlobalKeyboardShortcuts() {
  const navigate = useNavigate();
  const location = useLocation();
  const projectId = projectIdFromPathname(location.pathname);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isEditableElement(e.target)) return;

      const key = e.key;
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;

      // 1–5: phase tabs (only when we're under a project; no modifiers so we don't steal Cmd+1 etc.)
      if (!hasModifier) {
        const phaseByKey = PHASE_BY_DIGIT[key];
        const phaseByCode = e.code in PHASE_BY_CODE ? PHASE_BY_CODE[e.code] : undefined;
        const phase = phaseByKey ?? phaseByCode;
        if (phase) {
          if (projectId) {
            e.preventDefault();
            e.stopPropagation();
            navigate(getProjectPhasePath(projectId, phase));
          }
          return;
        }
      }

      // ~ (Backquote): home (no modifiers)
      if (!hasModifier && (key === "`" || key === "~")) {
        e.preventDefault();
        e.stopPropagation();
        navigate("/");
        return;
      }

      // Escape: close modal if one is open; do NOT open settings (let modal's handler close it)
      if (key === "Escape") {
        if (isModalOpen() || isFocusInModal(e)) {
          e.preventDefault();
          return;
        }
        if (projectId) {
          e.preventDefault();
          navigate(`/projects/${projectId}/settings`);
        } else {
          e.preventDefault();
          navigate("/settings");
        }
        return;
      }

      // ? or F1: open help in same context as help icon (project when path is under /projects/:id, else global)
      if (key === "?" || key === "F1") {
        e.preventDefault();
        e.stopPropagation();
        if (projectId) {
          navigate(`/projects/${projectId}/help`);
        } else {
          navigate("/help");
        }
      }
    },
    [navigate, projectId]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  return null;
}
