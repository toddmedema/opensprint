import { CloseButton } from "./CloseButton";
import { formatPlanIdAsTitle } from "../lib/formatting";

export interface CrossEpicConfirmModalProps {
  planId: string;
  prerequisitePlanIds: string[];
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
}

export function CrossEpicConfirmModal({
  planId,
  prerequisitePlanIds,
  onConfirm,
  onCancel,
  confirming = false,
}: CrossEpicConfirmModalProps) {
  const prereqTitles = prerequisitePlanIds.map(formatPlanIdAsTitle);
  const prereqList = prereqTitles.join(", ");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />

      {/* Modal */}
      <div
        className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Cross-epic dependencies</h2>
          <CloseButton onClick={onCancel} ariaLabel="Close cross-epic confirmation modal" />
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-gray-700">
            This feature requires{" "}
            <span className="font-medium text-gray-900">{prereqList}</span> to be implemented first.
          </p>
          <p className="text-sm text-gray-600">
            Queueing will also queue those features in dependency order. Proceed?
          </p>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
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
