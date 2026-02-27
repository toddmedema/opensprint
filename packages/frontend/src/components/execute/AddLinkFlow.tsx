import React, { useState, useRef, useEffect } from "react";
import type { Task } from "@opensprint/shared";

const LINK_TYPES = [
  { value: "blocks", label: "Blocks" },
  { value: "parent-child", label: "Parent-child" },
  { value: "related", label: "Related" },
] as const;

export interface AddLinkFlowProps {
  projectId: string;
  /** The task we're adding a dependency TO (this task will depend on the selected task) */
  childTaskId: string;
  tasks: Task[];
  /** Task IDs to exclude from suggestions (e.g. self, already linked) */
  excludeIds?: Set<string>;
  onSave: (parentTaskId: string, type: "blocks" | "parent-child" | "related") => Promise<void>;
  onCancel: () => void;
  disabled?: boolean;
}

/** Filter tasks by query (matches id or title, case-insensitive). */
function filterTasksByQuery(tasks: Task[], query: string, excludeIds: Set<string>): Task[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return tasks.filter((t) => {
    if (excludeIds.has(t.id)) return false;
    return t.id.toLowerCase().includes(q) || (t.title ?? "").toLowerCase().includes(q);
  });
}

export function AddLinkFlow({
  projectId: _projectId,
  childTaskId,
  tasks,
  excludeIds = new Set(),
  onSave,
  onCancel,
  disabled = false,
}: AddLinkFlowProps) {
  const [linkType, setLinkType] = useState<"blocks" | "parent-child" | "related">("blocks");
  const [inputValue, setInputValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const exclude = new Set(excludeIds);
  exclude.add(childTaskId);

  const suggestions = filterTasksByQuery(tasks, inputValue, exclude);
  const showSuggestions = inputValue.trim().length > 0 && suggestions.length > 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [inputValue, suggestions.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && suggestions[highlightedIndex]) {
      e.preventDefault();
      selectTask(suggestions[highlightedIndex]);
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  const selectTask = (task: Task) => {
    setInputValue("");
    setHighlightedIndex(0);
    handleSave(task.id);
  };

  const handleSave = async (taskId?: string) => {
    const id = taskId ?? inputValue.trim();
    if (!id) {
      setError("Enter a task ID or select from suggestions");
      return;
    }
    const matched = tasks.find(
      (t) => t.id === id || t.id.toLowerCase() === id.toLowerCase()
    );
    const parentId = matched?.id ?? id;
    if (exclude.has(parentId)) {
      setError("Cannot link to this task");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(parentId, linkType);
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add link");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 space-y-2" data-testid="add-link-flow">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={linkType}
          onChange={(e) =>
            setLinkType(e.target.value as "blocks" | "parent-child" | "related")
          }
          className="text-xs rounded border border-theme-border bg-theme-surface text-theme-text px-2 py-1"
          data-testid="add-link-type-select"
          aria-label="Link type"
        >
          {LINK_TYPES.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[120px]">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Task ID or name"
            className="w-full text-xs rounded border border-theme-border bg-theme-surface text-theme-text px-2 py-1"
            data-testid="add-link-input"
            aria-label="Task to link"
            aria-autocomplete="list"
            aria-expanded={showSuggestions}
          />
          {showSuggestions && (
            <ul
              role="listbox"
              className="absolute left-0 right-0 top-full mt-0.5 z-50 max-h-32 overflow-y-auto rounded border border-theme-border bg-theme-surface shadow-lg py-1"
              data-testid="add-link-suggestions"
            >
              {suggestions.slice(0, 8).map((t, i) => (
                <li
                  key={t.id}
                  role="option"
                  aria-selected={i === highlightedIndex}
                  className={`px-2 py-1 text-xs cursor-pointer ${
                    i === highlightedIndex ? "bg-theme-border-subtle" : "hover:bg-theme-border-subtle/50"
                  }`}
                  onClick={() => selectTask(t)}
                >
                  <span className="font-mono text-theme-muted">{t.id}</span>
                  <span className="ml-2 truncate">{t.title ?? ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleSave()}
            disabled={saving || disabled}
            className="p-1 rounded text-theme-success-muted hover:bg-theme-success-bg hover:text-theme-success-text disabled:opacity-50"
            aria-label="Save link"
            data-testid="add-link-save-btn"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="p-1 rounded text-theme-muted hover:bg-theme-error-bg hover:text-theme-error-text disabled:opacity-50"
            aria-label="Cancel"
            data-testid="add-link-cancel-btn"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
      {error && (
        <div className="text-xs text-theme-error-text" data-testid="add-link-error">
          {error}
        </div>
      )}
    </div>
  );
}
