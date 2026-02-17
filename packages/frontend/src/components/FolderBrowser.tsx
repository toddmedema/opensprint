import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import { CloseButton } from "./CloseButton";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />

      {/* Dialog */}
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-xl mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Select Folder</h2>
          <CloseButton onClick={onCancel} />
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
          </div>
        </form>

        {/* Directory listing */}
        <div className="flex-1 overflow-y-auto px-5 py-2 min-h-[300px]">
          {error && <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm mb-2">{error}</div>}

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
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-gray-50 transition-colors group"
                >
                  <svg
                    className="w-5 h-5 text-gray-400 group-hover:text-brand-500 flex-shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                  </svg>
                  <span className="text-sm text-gray-500 group-hover:text-gray-700">..</span>
                </button>
              )}

              {/* Subdirectories */}
              {entries.length === 0 && !loading && (
                <p className="text-sm text-gray-400 text-center py-8">No subdirectories</p>
              )}
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => handleNavigate(entry.path)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-gray-50 transition-colors group"
                >
                  <svg
                    className="w-5 h-5 text-amber-500 flex-shrink-0"
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
                  <span className="text-sm text-gray-700 group-hover:text-gray-900 truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <p className="text-xs text-gray-500 font-mono truncate max-w-[60%]" title={currentPath}>
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
