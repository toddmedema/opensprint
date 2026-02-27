import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api/client";

interface AgentsMdSectionProps {
  projectId: string;
}

export function AgentsMdSection({ projectId }: AgentsMdSectionProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<"saved" | "error" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.projects
      .getAgentsInstructions(projectId)
      .then((data) => {
        if (!cancelled) {
          setContent(data.content);
          setEditValue(data.content);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load agent instructions");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleSave = async () => {
    setSaving(true);
    setSaveFeedback(null);
    try {
      await api.projects.updateAgentsInstructions(projectId, editValue);
      setContent(editValue);
      setEditing(false);
      setSaveFeedback("saved");
      setTimeout(() => setSaveFeedback(null), 2000);
    } catch (err) {
      setSaveFeedback("error");
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditValue(content ?? "");
    setEditing(false);
    setError(null);
  };

  if (loading) {
    return (
      <div className="pt-2">
        <h3 className="text-sm font-semibold text-theme-text mb-3">
          Agent Instructions (AGENTS.md)
        </h3>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-theme-muted">Loading...</span>
        </div>
      </div>
    );
  }

  if (error && !editing) {
    return (
      <div className="pt-2">
        <h3 className="text-sm font-semibold text-theme-text mb-3">
          Agent Instructions (AGENTS.md)
        </h3>
        <div className="p-3 rounded-lg bg-theme-error-bg border border-theme-error-border">
          <p className="text-sm text-theme-error-text">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-2">
      <h3 className="text-sm font-semibold text-theme-text mb-3">
        Agent Instructions (AGENTS.md)
      </h3>
      <p className="text-xs text-theme-muted mb-3">
        Agent-specific instructions read by coding agents. Edit to customize behavior for this
        project.
      </p>

      {editing ? (
        <div className="space-y-3">
          <textarea
            className="input w-full font-mono text-sm min-h-[200px] resize-y"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            placeholder="# Agent Instructions\n\nAdd instructions for your agents..."
            data-testid="agents-md-textarea"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="btn-primary disabled:opacity-50"
              data-testid="agents-md-save"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="btn-secondary text-sm"
              data-testid="agents-md-cancel"
            >
              Cancel
            </button>
            {saveFeedback === "saved" && (
              <span className="text-sm text-theme-success-muted" data-testid="agents-md-saved">
                Saved
              </span>
            )}
            {saveFeedback === "error" && (
              <span className="text-sm text-theme-error-text">{error}</span>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div
            className="prose prose-sm prose-neutral dark:prose-invert max-w-none text-theme-text prose-headings:text-theme-text prose-p:text-theme-text prose-li:text-theme-text prose-code:text-theme-text prose-pre:bg-theme-code-bg prose-pre:text-theme-code-text prose-pre:border prose-pre:border-theme-border prose-pre:rounded-lg prose-a:text-brand-600 hover:prose-a:text-brand-700 p-3 rounded-lg bg-theme-bg-elevated border border-theme-border min-h-[80px] max-h-[400px] overflow-y-auto"
            data-testid="agents-md-view"
          >
            {content && content.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            ) : (
              <p className="text-theme-muted text-sm italic">
                No agent instructions yet. Click Edit to add.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="btn-secondary text-sm"
              data-testid="agents-md-edit"
            >
              Edit
            </button>
            {saveFeedback === "saved" && (
              <span className="text-sm text-theme-success-muted" data-testid="agents-md-saved">
                Saved
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
