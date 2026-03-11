import { useState, useRef } from "react";
import { CloseButton } from "../CloseButton";
import { useSubmitShortcut } from "../../hooks/useSubmitShortcut";
import { useModalA11y } from "../../hooks/useModalA11y";

export interface AddPlanModalProps {
  onGenerate: (description: string) => void;
  onClose: () => void;
}

export function AddPlanModal({ onGenerate, onClose }: AddPlanModalProps) {
  const [featureDescription, setFeatureDescription] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  useModalA11y({ containerRef, onClose, isOpen: true });

  const handleGenerate = () => {
    const description = featureDescription.trim();
    if (!description) return;
    onGenerate(description);
    setFeatureDescription("");
    onClose();
  };

  const onKeyDown = useSubmitShortcut(handleGenerate, {
    multiline: true,
    disabled: !featureDescription.trim(),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" onClick={onClose} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add Plan"
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="add-plan-modal"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border">
          <h2 className="text-lg font-semibold text-theme-text">Add Plan</h2>
          <CloseButton onClick={onClose} ariaLabel="Close Add Plan modal" />
        </div>
        <div className="px-5 py-4">
          <label
            htmlFor="add-plan-feature-description"
            className="block text-sm font-medium text-theme-text mb-2"
          >
            Feature plan idea
          </label>
          <textarea
            id="add-plan-feature-description"
            className="input w-full text-sm min-h-[100px] resize-y"
            value={featureDescription}
            onChange={(e) => setFeatureDescription(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Describe your feature idea…"
            data-testid="feature-description-input"
            autoFocus
          />
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!featureDescription.trim()}
            className="btn-primary text-sm disabled:opacity-50"
            data-testid="generate-plan-button"
          >
            Generate Plan
          </button>
        </div>
      </div>
    </div>
  );
}
