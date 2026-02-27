import { useState } from "react";
import { CloseButton } from "./CloseButton";
import { setKillAgentConfirmDisabled } from "../lib/killAgentConfirmStorage";

export interface KillAgentConfirmDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
}

export function KillAgentConfirmDialog({
  onConfirm,
  onCancel,
  confirming = false,
}: KillAgentConfirmDialogProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const handleConfirm = () => {
    setKillAgentConfirmDisabled(dontShowAgain);
    onConfirm();
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" onClick={onCancel} />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kill-agent-confirm-title"
        data-kill-agent-dialog
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border">
          <h2 id="kill-agent-confirm-title" className="text-lg font-semibold text-theme-text">
            Kill agent
          </h2>
          <CloseButton onClick={onCancel} ariaLabel="Close kill agent confirmation" />
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-theme-text">
            Are you sure you want to kill this agent?
          </p>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="rounded border-theme-border text-brand-600 focus:ring-brand-500"
            />
            <span className="text-sm text-theme-text">Don&apos;t show this again</span>
          </label>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
          <button type="button" onClick={onCancel} className="btn-secondary" disabled={confirming}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirming}
            className="btn-primary disabled:opacity-50"
          >
            {confirming ? "Killing…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
