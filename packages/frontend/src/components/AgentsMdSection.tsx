import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import remarkGfm from "remark-gfm";
import { api } from "../api/client";
import { useTheme } from "../contexts/ThemeContext";

const MDEditor = lazy(() => import("@uiw/react-md-editor").then((m) => ({ default: m.default })));
const AgentsMdPreview = lazy(() =>
  import("./AgentsMdPreview").then((module) => ({ default: module.AgentsMdPreview }))
);

let markdownFormatterPromise: Promise<{
  prettier: typeof import("prettier");
  parserMarkdown: typeof import("prettier/plugins/markdown");
}> | null = null;

function EditorLoadingFallback() {
  return (
    <div className="flex items-center gap-2 py-4" data-testid="agents-md-editor-loading">
      <div className="w-4 h-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      <span className="text-sm text-theme-muted">Loading editor...</span>
    </div>
  );
}

function PreviewLoadingFallback() {
  return (
    <div className="flex items-center gap-2 py-4" data-testid="agents-md-preview-loading">
      <div className="w-4 h-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      <span className="text-sm text-theme-muted">Loading preview...</span>
    </div>
  );
}

interface AgentsMdSectionProps {
  projectId: string;
  /** When true, renders a plain textarea for simpler testing. */
  testMode?: boolean;
}

async function prettifyMarkdown(content: string): Promise<string> {
  if (!markdownFormatterPromise) {
    markdownFormatterPromise = Promise.all([
      import("prettier"),
      import("prettier/plugins/markdown"),
    ]).then(([prettier, parserMarkdown]) => ({ prettier, parserMarkdown }));
  }
  const { prettier, parserMarkdown } = await markdownFormatterPromise;
  return prettier.format(content, {
    parser: "markdown",
    plugins: [parserMarkdown],
    proseWrap: "preserve",
  });
}

export function AgentsMdSection({ projectId, testMode = false }: AgentsMdSectionProps) {
  const { resolved } = useTheme();
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

  const handlePrettify = useCallback(async () => {
    try {
      const formatted = await prettifyMarkdown(editValue);
      setEditValue(formatted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Prettify failed");
    }
  }, [editValue]);

  const editValueRef = useRef(editValue);
  editValueRef.current = editValue;

  const handleSave = useCallback(async () => {
    const value = editValueRef.current;
    setSaving(true);
    setSaveFeedback(null);
    try {
      const toSave = await prettifyMarkdown(value);
      await api.projects.updateAgentsInstructions(projectId, toSave);
      setContent(toSave);
      setEditValue(toSave);
      setEditing(false);
      setSaveFeedback("saved");
      setTimeout(() => setSaveFeedback(null), 2000);
    } catch (err) {
      setSaveFeedback("error");
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [projectId]);

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
      <div className="flex items-center justify-between gap-4 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-tight text-theme-text">
            Agent Instructions (AGENTS.md)
          </h3>
          <p className="text-xs leading-tight text-theme-muted mt-0.5">
            Agent-specific instructions read by coding agents. Edit to customize behavior for this
            project.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="btn-secondary text-sm"
              data-testid="agents-md-edit"
            >
              Edit
            </button>
          )}
          {saveFeedback === "saved" && (
            <span className="text-sm text-theme-success-muted" data-testid="agents-md-saved">
              Saved
            </span>
          )}
        </div>
      </div>

      {editing ? (
        <div className="space-y-3" data-color-mode={resolved}>
          <div data-testid="agents-md-editor">
            {testMode ? (
              <textarea
                className="input w-full font-mono text-sm min-h-[200px] resize-y"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => void handleSave()}
                placeholder="# Agent Instructions\n\nAdd instructions for your agents..."
                data-testid="agents-md-textarea"
              />
            ) : (
              <Suspense fallback={<EditorLoadingFallback />}>
                <MDEditor
                  value={editValue}
                  onChange={(v) => setEditValue(v ?? "")}
                  height={280}
                  visibleDragbar={false}
                  preview="edit"
                  textareaProps={{
                    placeholder: "# Agent Instructions\n\nAdd instructions for your agents...",
                    onBlur: () => void handleSave(),
                  }}
                  extraCommands={[
                    {
                      name: "prettify",
                      keyCommand: "prettify",
                      buttonProps: { "aria-label": "Prettify markdown" },
                      icon: (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M4 6h16M4 12h10M4 18h16" />
                        </svg>
                      ),
                      execute: () => {
                        handlePrettify();
                      },
                    },
                  ]}
                  previewOptions={{
                    remarkPlugins: [remarkGfm],
                  }}
                />
              </Suspense>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrettify}
              disabled={saving}
              className="btn-secondary text-sm"
              data-testid="agents-md-prettify"
            >
              Prettify
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
              <Suspense fallback={<PreviewLoadingFallback />}>
                <AgentsMdPreview content={content} />
              </Suspense>
            ) : (
              <p className="text-theme-muted text-sm italic">
                No agent instructions yet. Click Edit to add.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
