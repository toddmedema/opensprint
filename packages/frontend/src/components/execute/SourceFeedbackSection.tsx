import { useEffect, useRef } from "react";
import { useAppDispatch } from "../../store";
import { addNotification } from "../../store/slices/notificationSlice";
import { useFeedbackItem } from "../../api/hooks";
import { CollapsibleSection } from "./CollapsibleSection";

export function SourceFeedbackSection({
  projectId,
  feedbackId,
  expanded,
  onToggle,
  title = "Source Feedback",
}: {
  projectId: string;
  feedbackId: string;
  expanded: boolean;
  onToggle: () => void;
  /** Optional title override (e.g. "Source feedback (1 of 2)" when multiple) */
  title?: string;
}) {
  const dispatch = useAppDispatch();
  const { data: feedback, isFetching: loading, error } = useFeedbackItem(
    projectId,
    feedbackId,
    { enabled: expanded && Boolean(feedbackId) }
  );
  const lastNotifiedErrorRef = useRef<string | null>(null);
  const errorMessage = error instanceof Error ? error.message : error ? String(error) : null;

  useEffect(() => {
    if (errorMessage && errorMessage !== lastNotifiedErrorRef.current) {
      lastNotifiedErrorRef.current = errorMessage;
      dispatch(addNotification({ message: errorMessage, severity: "error" }));
    } else if (!errorMessage) {
      lastNotifiedErrorRef.current = null;
    }
  }, [errorMessage, dispatch]);

  const contentId = `source-feedback-content-${feedbackId}`;
  const headerId = `source-feedback-header-${feedbackId}`;

  return (
    <CollapsibleSection
      title={title}
      expanded={expanded}
      onToggle={onToggle}
      expandAriaLabel={`Expand ${title}`}
      collapseAriaLabel={`Collapse ${title}`}
      contentId={contentId}
      headerId={headerId}
    >
      {loading ? (
        <div className="bg-theme-code-bg rounded-lg border border-theme-border overflow-hidden">
          <div className="p-4 text-xs text-theme-muted" data-testid="source-feedback-loading">
            Loading feedback…
          </div>
        </div>
      ) : feedback ? (
        <div
          className="bg-theme-code-bg rounded-lg border border-theme-border overflow-hidden"
          data-testid="source-feedback-card"
        >
          <div className="p-4 text-xs space-y-2">
            {(feedback.status === "resolved" || feedback.status === "cancelled") && (
              <div className="flex items-start justify-between gap-2 overflow-hidden flex-wrap">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 font-medium flex-shrink-0 ${
                    feedback.status === "cancelled"
                      ? "bg-theme-border-subtle text-theme-muted"
                      : "bg-theme-success-bg text-theme-success-text"
                  }`}
                  aria-label={feedback.status === "cancelled" ? "Cancelled" : "Resolved"}
                >
                  {feedback.status === "cancelled" ? "Cancelled" : "Resolved"}
                </span>
              </div>
            )}
            <p className="text-theme-text whitespace-pre-wrap break-words min-w-0">
              {feedback.text ?? "(No feedback text)"}
            </p>
          </div>
        </div>
      ) : null}
    </CollapsibleSection>
  );
}
