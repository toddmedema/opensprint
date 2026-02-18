import { useState } from "react";
import { api } from "../api/client";
import { CloseButton } from "./CloseButton";
import type { Plan } from "@opensprint/shared";
import { getPlanTemplate } from "@opensprint/shared";

interface AddPlanModalProps {
  projectId: string;
  onClose: () => void;
  onCreated: (plan: Plan) => void;
}

export function AddPlanModal({ projectId, onClose, onCreated }: AddPlanModalProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (!value.trim()) {
      setContent("");
    } else if (!content.trim()) {
      setContent(getPlanTemplate(value));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const plan = await api.plans.create(projectId, {
        title: trimmedTitle,
        content: content.trim() || getPlanTemplate(trimmedTitle),
      });
      onCreated(plan);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create plan");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <form
        onSubmit={handleSubmit}
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border">
          <h2 className="text-lg font-semibold text-theme-text">Add Feature</h2>
          <CloseButton onClick={onClose} ariaLabel="Close add plan modal" />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-theme-text mb-1">Feature Title</label>
            <input
              type="text"
              className="input"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="e.g. User Authentication"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-theme-text mb-1">Plan Markdown</label>
            <textarea
              className="input font-mono text-sm min-h-[280px]"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Plan specification in markdown format"
            />
            <p className="mt-1 text-xs text-theme-muted">
              Include overview, acceptance criteria, technical approach, and other sections per PRD §7.2.3
            </p>
          </div>
        </div>

        {error && (
          <div className="mx-5 mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={saving || !title.trim()} className="btn-primary disabled:opacity-50">
            {saving ? "Creating…" : "Create Plan"}
          </button>
        </div>
      </form>
    </div>
  );
}
