/**
 * Secondary-styled saving-state indicator for settings pages.
 * Shows "Saved" by default, "(spinner) Saving" when save in progress, and
 * "Not saved" when the latest save failed.
 */
export type SaveStatus = "idle" | "saving" | "saved" | "not_saved";

interface SaveIndicatorProps {
  status: SaveStatus;
  "data-testid"?: string;
}

export function SaveIndicator({ status, "data-testid": testId }: SaveIndicatorProps) {
  return (
    <span
      className="text-xs text-theme-muted opacity-80 flex items-center gap-1.5"
      data-testid={testId ?? "save-indicator"}
      role="status"
      aria-live="polite"
    >
      {status === "saving" ? (
        <>
          <span
            className="w-3 h-3 border border-theme-muted border-t-transparent rounded-full animate-spin"
            aria-hidden
          />
          <span>Saving</span>
        </>
      ) : status === "not_saved" ? (
        <span className="font-medium text-theme-error-text">Not saved</span>
      ) : (
        <span>Saved</span>
      )}
    </span>
  );
}
