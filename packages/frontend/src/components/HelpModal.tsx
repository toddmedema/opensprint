import { useEffect } from "react";
import { HelpContent } from "./HelpContent";

export interface HelpModalProps {
  onClose: () => void;
  /** Optional project context (per-project view vs homepage) */
  project?: { id: string; name: string } | null;
}

/**
 * Help modal with five tabs: Ask a Question (default), Meet your Team, Analytics, Agent log, and Keyboard Shortcuts.
 * Kept for backward compatibility; prefer HelpPage for full-screen experience.
 * No standalone title or back arrow; tabs appear as second title bar with close in bar.
 */
export function HelpModal({ onClose, project }: HelpModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-theme-overlay"
        aria-label="Close help"
        onClick={onClose}
        data-testid="help-modal-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Help"
        className="relative w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col rounded-lg bg-theme-surface shadow-xl"
        data-testid="help-modal-content"
      >
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <HelpContent project={project} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}
