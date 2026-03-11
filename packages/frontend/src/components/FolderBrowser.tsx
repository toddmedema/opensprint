import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api/client";
import { CloseButton } from "./CloseButton";
import { useModalA11y } from "../hooks/useModalA11y";

interface FolderBrowserProps {
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export function FolderBrowser({ initialPath, onSelect, onCancel }: FolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || "");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const browse = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.filesystem.browse(path);
      setCurrentPath(result.current);
      setParentPath(result.parent);
      setEntries(result.entries);
      setManualPath(result.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to browse directory");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    browse(initialPath || undefined);
  }, [browse, initialPath]);

  const handleNavigate = (path: string) => {
    browse(path);
  };

  const handleManualNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualPath.trim()) {
      browse(manualPath.trim());
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await api.filesystem.createFolder(currentPath, name);
      setShowCreateFolder(false);
      setNewFolderName("");
      browse(result.path);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setCreating(false);
    }
  };

  const containerRef = useRef<HTMLDivElement>(null);
  useModalA11y({ containerRef, onClose: onCancel, isOpen: true });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" onClick={onCancel} />

      {/* Dialog */}
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-browser-title"
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-xl mx-4 flex flex-col max-h-[80vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border">
          <h2 id="folder-browser-title" className="text-lg font-semibold text-theme-text">
            Select Folder
          </h2>
          <CloseButton onClick={onCancel} ariaLabel="Close folder browser" />
        </div>

        {/* Path bar */}
        <form onSubmit={handleManualNavigate} className="px-5 pt-4 pb-2">
          <div className="flex gap-2">
            <input
              type="text"
              className="input font-mono text-sm flex-1"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              placeholder="/path/to/folder"
            />
            <button type="submit" className="btn-secondary text-sm px-3 whitespace-nowrap">
              Go
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCreateFolder(true);
                setCreateError(null);
                setNewFolderName("");
              }}
              className="btn-secondary text-sm px-3 whitespace-nowrap flex items-center gap-1.5"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New folder
            </button>
          </div>
        </form>

        {/* Create folder inline form */}
        {showCreateFolder && (
          <form onSubmit={handleCreateFolder} className="px-5 pb-2">
            <div className="flex gap-2 items-center">
              <input
                type="text"
                className="input font-mono text-sm flex-1"
                value={newFolderName}
                onChange={(e) => {
                  setNewFolderName(e.target.value);
                  setCreateError(null);
                }}
                placeholder="Folder name"
                autoFocus
              />
              <button
                type="submit"
                className="btn-primary text-sm px-3 whitespace-nowrap"
                disabled={creating || !newFolderName.trim()}
              >
                {creating ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreateFolder(false);
                  setNewFolderName("");
                  setCreateError(null);
                }}
                className="btn-secondary text-sm px-3 whitespace-nowrap"
              >
                Cancel
              </button>
            </div>
            {createError && <p className="text-sm text-theme-error-text mt-1.5">{createError}</p>}
          </form>
        )}

        {/* Directory listing */}
        <div className="flex-1 overflow-y-auto px-5 py-2 min-h-[300px]">
          {error && (
            <div className="p-3 rounded-lg bg-theme-error-bg text-theme-error-text text-sm mb-2">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-0.5">
              {/* Parent directory */}
              {parentPath && (
                <button
                  onClick={() => handleNavigate(parentPath)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-theme-border-subtle transition-colors group"
                >
                  <svg
                    className="w-5 h-5 text-theme-muted group-hover:text-brand-500 flex-shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M10 19l-7-7m0 0l7-7m-7 7h18"
                    />
                  </svg>
                  <span className="text-sm text-theme-muted group-hover:text-theme-text">..</span>
                </button>
              )}

              {/* Subdirectories */}
              {entries.length === 0 && !loading && (
                <p className="text-sm text-theme-muted text-center py-8">No subdirectories</p>
              )}
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => handleNavigate(entry.path)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-theme-border-subtle transition-colors group"
                >
                  <svg
                    className="w-5 h-5 text-theme-warning-solid flex-shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                    />
                  </svg>
                  <span className="text-sm text-theme-text group-hover:text-theme-text truncate">
                    {entry.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-theme-border bg-theme-surface-muted rounded-b-xl">
          <p
            className="text-xs text-theme-muted font-mono truncate max-w-[60%]"
            title={currentPath}
          >
            {currentPath}
          </p>
          <div className="flex gap-2">
            <button onClick={onCancel} className="btn-secondary text-sm">
              Cancel
            </button>
            <button onClick={() => onSelect(currentPath)} className="btn-primary text-sm">
              Select This Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
