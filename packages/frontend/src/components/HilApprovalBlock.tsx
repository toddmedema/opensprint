import { useState, useCallback, useMemo } from "react";
import type { Notification, ScopeChangeMetadata } from "@opensprint/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { DiffView } from "./diff/DiffView";
import { PrdDiffView } from "./prd/PrdDiffView";

export interface HilApprovalBlockProps {
  /** HIL approval notification (kind: hil_approval) */
  notification: Notification;
  projectId: string;
  /** Called when notification is resolved (after Approve or Reject) */
  onResolved: () => void;
  /** When true, do not show PRD diff in this block (diff is shown inline in PrdViewer instead) */
  hideDiffInBlock?: boolean;
}

/**
 * Renders Approve/Reject buttons for HIL approval notifications.
 * When scopeChangeMetadata is present, shows a PRD diff for review before accepting/rejecting.
 * Surfaces in eval (scope change) and sketch (architecture) contexts.
 */
export function HilApprovalBlock({
  notification,
  projectId,
  onResolved,
  hideDiffInBlock = false,
}: HilApprovalBlockProps) {
  const [loading, setLoading] = useState(false);
  const [diffErrorDismissed, setDiffErrorDismissed] = useState(false);

  const scopeMeta =
    notification.kind === "hil_approval" &&
    notification.scopeChangeMetadata &&
    "scopeChangeProposedUpdates" in notification.scopeChangeMetadata
      ? (notification.scopeChangeMetadata as ScopeChangeMetadata)
      : undefined;
  const hasPrdApprovalScope = !!scopeMeta?.scopeChangeProposedUpdates?.length;

  const proposedUpdates = scopeMeta?.scopeChangeProposedUpdates ?? [];
  const hasPrdDiff = !hideDiffInBlock && proposedUpdates.length > 0;

  const {
    data: proposedDiffPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isSuccess: proposedDiffSuccess,
    isError: proposedDiffError,
    isPending: proposedDiffPending,
    error: proposedDiffErr,
  } = useInfiniteQuery({
    queryKey: queryKeys.prd.proposedDiff(projectId, notification.id),
    queryFn: ({ pageParam }) =>
      api.prd.getProposedDiff(projectId, notification.id, { lineOffset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.diff.pagination?.hasMore
        ? last.diff.pagination.offset + last.diff.pagination.limit
        : undefined,
    enabled: !hideDiffInBlock && hasPrdApprovalScope,
    retry: false,
  });

  const proposedDiffData = useMemo(() => {
    if (!proposedDiffPages?.pages.length) return undefined;
    const lines = proposedDiffPages.pages.flatMap((p) => p.diff.lines);
    const first = proposedDiffPages.pages[0]!;
    return {
      requestId: first.requestId,
      fromContent: first.fromContent,
      toContent: first.toContent,
      diff: { lines, summary: first.diff.summary },
    };
  }, [proposedDiffPages]);

  const showPrdFallback = diffErrorDismissed && proposedDiffError;
  const useApiDiff = hasPrdDiff && proposedDiffSuccess && proposedDiffData?.diff;
  const showDiffError = hasPrdDiff && proposedDiffError && !diffErrorDismissed;
  const diffErrorMessage =
    proposedDiffErr instanceof Error ? proposedDiffErr.message : "Could not load proposed diff";

  const { data: currentPrd } = useQuery({
    queryKey: queryKeys.prd.detail(projectId),
    queryFn: () => api.prd.get(projectId),
    enabled: !hideDiffInBlock && hasPrdApprovalScope && showPrdFallback,
  });

  const defaultDiffMode =
    proposedDiffData?.fromContent != null && proposedDiffData?.toContent != null
      ? ("rendered" as const)
      : ("raw" as const);

  const handleApprove = useCallback(async () => {
    setLoading(true);
    try {
      await api.notifications.resolve(
        projectId,
        notification.id,
        {
          approved: true,
        },
        ...(notification.revision === undefined
          ? []
          : ([{ expectedRevision: notification.revision }] as const))
      );
      onResolved();
    } finally {
      setLoading(false);
    }
  }, [projectId, notification.id, notification.revision, onResolved]);

  const handleReject = useCallback(async () => {
    setLoading(true);
    try {
      await api.notifications.resolve(
        projectId,
        notification.id,
        {
          approved: false,
        },
        ...(notification.revision === undefined
          ? []
          : ([{ expectedRevision: notification.revision }] as const))
      );
      onResolved();
    } finally {
      setLoading(false);
    }
  }, [projectId, notification.id, notification.revision, onResolved]);

  const description = notification.questions?.[0]?.text ?? "Approval required";

  const actionButtons = (
    <>
      <button
        type="button"
        onClick={handleApprove}
        disabled={loading}
        className="btn-primary text-sm px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="hil-approve-btn"
      >
        {loading ? "Submitting…" : "Approve"}
      </button>
      <button
        type="button"
        onClick={handleReject}
        disabled={loading}
        className="text-sm px-3 py-2 rounded-lg border border-theme-border bg-theme-surface-muted text-theme-text hover:bg-theme-border-subtle disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="hil-reject-btn"
      >
        Reject
      </button>
    </>
  );

  return (
    <div
      className="p-4 border-b border-theme-border border-l-4 bg-theme-warning-bg/30 border-l-theme-warning-solid flex flex-col"
      data-question-id={notification.id}
      data-testid="hil-approval-block"
    >
      <h4 className="text-xs font-medium text-theme-muted uppercase tracking-wide mb-2">
        Approval required
      </h4>
      <p className="text-sm text-theme-text mb-3">{description}</p>
      {hasPrdDiff && scopeMeta && (
        <div className="mb-4 rounded-lg border border-theme-border bg-theme-surface flex flex-col max-h-[min(70vh,42rem)] min-h-[12rem] overflow-hidden">
          <h5 className="text-xs font-medium text-theme-muted uppercase tracking-wide px-3 pt-3 pb-0 shrink-0">
            Proposed PRD changes
          </h5>
          <div className="flex-1 min-h-0 flex flex-col px-3 pt-2">
            {proposedDiffPending ? (
              <div className="text-sm text-theme-muted py-4 px-1" data-testid="hil-diff-loading">
                Loading proposed changes…
              </div>
            ) : showDiffError ? (
              <div className="min-h-0 overflow-y-auto">
                <div
                  className="rounded border border-theme-error-border bg-theme-error-bg/50 p-3"
                  data-testid="hil-diff-error"
                >
                  <p className="text-sm text-theme-error mb-2">{diffErrorMessage}</p>
                  <button
                    type="button"
                    onClick={() => setDiffErrorDismissed(true)}
                    className="text-sm px-3 py-1.5 rounded border border-theme-border bg-theme-surface text-theme-text hover:bg-theme-border-subtle"
                    data-testid="hil-diff-error-dismiss"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ) : showPrdFallback ? (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <PrdDiffView currentPrd={currentPrd ?? null} scopeChangeMetadata={scopeMeta} />
              </div>
            ) : useApiDiff ? (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden gap-2">
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                  <DiffView
                    embedFullHeight
                    diff={proposedDiffData.diff}
                    fromContent={proposedDiffData.fromContent}
                    toContent={proposedDiffData.toContent}
                    defaultMode={defaultDiffMode}
                  />
                </div>
                {hasNextPage ? (
                  <div className="shrink-0 pt-1 border-t border-theme-border">
                    <button
                      type="button"
                      onClick={() => fetchNextPage()}
                      disabled={isFetchingNextPage}
                      className="text-sm text-accent-primary hover:underline disabled:opacity-50"
                      data-testid="hil-proposed-diff-load-more"
                    >
                      {isFetchingNextPage ? "Loading…" : "Load more diff"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="shrink-0 border-t border-theme-border bg-theme-surface/95 backdrop-blur-sm px-3 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] flex flex-wrap gap-2 z-10">
            {actionButtons}
          </div>
        </div>
      )}
      {!hasPrdDiff && <div className="flex gap-2 shrink-0">{actionButtons}</div>}
    </div>
  );
}
