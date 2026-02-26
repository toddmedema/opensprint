import { useEffect, useRef } from "react";
import { useAppDispatch, useAppSelector } from "../../store";
import { fetchFeedbackItem } from "../../store/slices/evalSlice";
import { addNotification } from "../../store/slices/notificationSlice";
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
  const feedback = useAppSelector((s) =>
    feedbackId ? (s.eval?.feedbackItemCache?.[feedbackId] ?? null) : null
  );
  const loading = useAppSelector((s) => s.eval?.feedbackItemLoadingId === feedbackId);
  const error = useAppSelector((s) =>
    s.eval?.feedbackItemErrorId === feedbackId ? (s.eval?.async?.feedbackItem?.error ?? null) : null
  );
  const lastNotifiedErrorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!expanded || !feedbackId) return;
    dispatch(fetchFeedbackItem({ projectId, feedbackId }));
  }, [projectId, feedbackId, expanded, dispatch]);

  useEffect(() => {
    if (error && error !== lastNotifiedErrorRef.current) {
      lastNotifiedErrorRef.current = error;
      dispatch(addNotification({ message: error, severity: "error" }));
    } else if (!error) {
      lastNotifiedErrorRef.current = null;
    }
  }, [error, dispatch]);

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
