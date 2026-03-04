import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import remarkGfm from "remark-gfm";
import { api } from "../api/client";
import { useTheme } from "../contexts/ThemeContext";
import {
  AGENT_ROLE_CANONICAL_ORDER,
  AGENT_ROLE_LABELS,
} from "@opensprint/shared";
import type { AgentRole } from "@opensprint/shared";

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

type AgentInstructionsTab = "general" | AgentRole;

const AGENT_TABS: { key: AgentInstructionsTab; label: string }[] = [
  { key: "general", label: "General" },
  ...AGENT_ROLE_CANONICAL_ORDER.map((role) => ({
    key: role as AgentInstructionsTab,
    label: AGENT_ROLE_LABELS[role],
  })),
];

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
  const [activeTab, setActiveTab] = useState<AgentInstructionsTab>("general");
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<"saved" | "error" | null>(null);

  const loadContent = useCallback(
    async (tab: AgentInstructionsTab) => {
      setLoading(true);
      setError(null);
      try {
        if (tab === "general") {
          const data = await api.projects.getAgentsInstructions(projectId);
          setContent(data.content);
          setEditValue(data.content);
        } else {
          const data = await api.projects.getAgentsInstructionsForRole(projectId, tab);
          setContent(data.content);
          setEditValue(data.content);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load agent instructions");
      } finally {
        setLoading(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    loadContent(activeTab);
  }, [activeTab, loadContent]);

  const editValueRef = useRef(editValue);
  editValueRef.current = editValue;

  const handleSave = useCallback(async () => {
    const value = editValueRef.current;
    setSaving(true);
    setSaveFeedback(null);
    try {
      const toSave = await prettifyMarkdown(value);
      if (activeTab === "general") {
        await api.projects.updateAgentsInstructions(projectId, toSave);
      } else {
        await api.projects.updateAgentsInstructionsForRole(projectId, activeTab, toSave);
      }
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
  }, [projectId, activeTab]);

  const handleTabChange = useCallback((tab: AgentInstructionsTab) => {
    if (editing) {
      if (!confirm("Discard unsaved changes?")) return;
    }
    setActiveTab(tab);
    setEditing(false);
    setSaveFeedback(null);
  }, [editing]);

  const tabLabel = AGENT_TABS.find((t) => t.key === activeTab)?.label ?? "General";
  const rolePlaceholder = "No role-specific instructions. Add instructions that apply only to this agent.";
  const generalEmptyText = "No agent instructions yet. Click Edit to add.";

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent, tabIndex: number) => {
      let nextIndex: number | null = null;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        nextIndex = tabIndex > 0 ? tabIndex - 1 : AGENT_TABS.length - 1;
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        nextIndex = tabIndex < AGENT_TABS.length - 1 ? tabIndex + 1 : 0;
      } else if (e.key === "Home") {
        e.preventDefault();
        nextIndex = 0;
      } else if (e.key === "End") {
        e.preventDefault();
        nextIndex = AGENT_TABS.length - 1;
      }
      if (nextIndex !== null) {
        handleTabChange(AGENT_TABS[nextIndex]!.key);
        (e.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex]?.focus();
      }
    },
    [handleTabChange]
  );

  if (loading && content === null) {
    return (
      <div className="pt-2">
        <h3 className="text-sm font-semibold text-theme-text mb-3">Agent Instructions</h3>
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
          Agent Instructions
        </h3>
        <div className="p-3 rounded-lg bg-theme-error-bg border border-theme-error-border">
          <p className="text-sm text-theme-error-text">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-2">
      <div
        className="flex flex-wrap items-center gap-1 bg-theme-border-subtle rounded-lg p-1 mb-3"
        role="tablist"
        aria-label="Agent instruction tabs"
      >
        {AGENT_TABS.map((tab, index) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              id={`agents-tab-${tab.key}`}
              aria-controls={`agents-tabpanel-${tab.key}`}
              onClick={() => handleTabChange(tab.key)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                isActive
                  ? "bg-theme-surface text-theme-text shadow-sm"
                  : "text-theme-muted hover:text-theme-text hover:bg-theme-bg-elevated"
              }`}
              data-testid={`agents-tab-${tab.key}`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`agents-tabpanel-${activeTab}`}
        aria-labelledby={`agents-tab-${activeTab}`}
      >
        <div className="flex items-center justify-between gap-4 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-tight text-theme-text">
            Agent Instructions
          </h3>
          <p className="text-xs leading-tight text-theme-muted mt-0.5">
            {activeTab === "general"
              ? "Shared instructions for all agents. Edit to customize behavior for this project."
              : `Role-specific instructions for ${tabLabel}. Combined with General when this agent runs.`}
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
                placeholder={
                  activeTab === "general"
                    ? "# Agent Instructions\n\nAdd instructions for your agents..."
                    : rolePlaceholder
                }
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
                    placeholder:
                      activeTab === "general"
                        ? "# Agent Instructions\n\nAdd instructions for your agents..."
                        : rolePlaceholder,
                    onBlur: () => void handleSave(),
                  }}
                  extraCommands={[
                    {
                      name: "save",
                      keyCommand: "save",
                      buttonProps: { "aria-label": "Save markdown" },
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
                        handleSave();
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
              onClick={handleSave}
              disabled={saving}
              className="btn-secondary text-sm"
              data-testid="agents-md-save"
            >
              Save
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
                {activeTab === "general" ? generalEmptyText : rolePlaceholder}
              </p>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
