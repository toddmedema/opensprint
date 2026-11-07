import { useRef, type ReactNode } from "react";
import { useModalA11y } from "../../hooks/useModalA11y";

/** A focused sheet remains nested in its workspace so modal focus ownership stays ordered. */
export function CollaborationDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ containerRef: ref, onClose });
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-3">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex max-h-[calc(100dvh-3rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-bg shadow-xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-theme-border px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button
            type="button"
            aria-label={"Close " + title}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-theme-muted hover:bg-theme-surface-muted"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
