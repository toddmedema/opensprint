import { useRef } from "react";
import { CloseButton } from "./CloseButton";
import { formatPlanIdAsTitle } from "../lib/formatting";
import { useModalA11y } from "../hooks/useModalA11y";

export interface CrossEpicConfirmModalProps {
  planId: string;
  prerequisitePlanIds: string[];
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
}

export function CrossEpicConfirmModal({
  prerequisitePlanIds,
  onConfirm,
  onCancel,
  confirming = false,
}: CrossEpicConfirmModalProps) {
  const prereqTitles = prerequisitePlanIds.map(formatPlanIdAsTitle);
  const prereqList = prereqTitles.join(", ");
  const containerRef = useRef<HTMLDivElement>(null);
  useModalA11y({ containerRef, onClose: onCancel, isOpen: true });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" onClick={onCancel} />

      {/* Modal */}
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cross-epic-modal-title"
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border">
          <h2 id="cross-epic-modal-title" className="text-lg font-semibold text-theme-text">
            Cross-epic dependencies
          </h2>
          <CloseButton onClick={onCancel} ariaLabel="Close cross-epic confirmation modal" />
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-theme-text">
            This feature requires <span className="font-medium text-theme-text">{prereqList}</span>{" "}
            to be implemented first.
          </p>
          <p className="text-sm text-theme-muted">
            Queueing will also queue those features in dependency order. Proceed?
          </p>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
          <button type="button" onClick={onCancel} className="btn-secondary" disabled={confirming}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className="btn-primary disabled:opacity-50"
          >
            {confirming ? "Executing…" : "Proceed"}
          </button>
        </div>
      </div>
    </div>
  );
}
