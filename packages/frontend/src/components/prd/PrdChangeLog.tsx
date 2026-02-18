import { formatSectionKey, formatTimestamp } from "../../lib/formatting";
import { getPrdSourceColor, PRD_SOURCE_LABELS } from "../../lib/constants";

export interface PrdHistoryEntry {
  section: string;
  version: number;
  timestamp: string;
  source: string;
  diff: string;
}

export interface PrdChangeLogProps {
  entries: PrdHistoryEntry[];
  expanded: boolean;
  onToggle: () => void;
}

export function PrdChangeLog({ entries, expanded, onToggle }: PrdChangeLogProps) {
  return (
    <div className="mt-10 pt-6 border-t border-gray-200 dark:border-gray-700">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center justify-between w-full text-left text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
      >
        <span>Change history</span>
        <span className="text-gray-400 dark:text-gray-500 text-xs">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
          <span className="ml-1">{expanded ? "▲" : "▼"}</span>
        </span>
      </button>
      {expanded && (
        <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
          {entries.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">No changes yet</p>
          ) : (
            [...entries].reverse().map((entry, i) => (
              <div
                key={`${entry.section}-${entry.version}-${i}`}
                className="text-xs bg-gray-50 dark:bg-gray-800/50 rounded border border-gray-200 dark:border-gray-700 p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-gray-800 dark:text-gray-200">
                    {formatSectionKey(entry.section)}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400 shrink-0">
                    {formatTimestamp(entry.timestamp)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getPrdSourceColor(entry.source)}`}
                  >
                    {PRD_SOURCE_LABELS[entry.source] ?? entry.source}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400">v{entry.version}</span>
                  <span className="text-gray-400 dark:text-gray-500 truncate">{entry.diff}</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
