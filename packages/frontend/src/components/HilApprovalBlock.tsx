import { useState, useCallback } from "react";
import type { Notification, ScopeChangeMetadata } from "@opensprint/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { PrdDiffView } from "./prd/PrdDiffView";
import { ServerDiffView } from "./prd/ServerDiffView";

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
  const hasPrdApprovalScope = !!(scopeMeta?.scopeChangeProposedUpdates?.length);

  const { data: currentPrd } = useQuery({
    queryKey: queryKeys.prd.detail(projectId),
    queryFn: () => api.prd.get(projectId),
    enabled: !hideDiffInBlock && hasPrdApprovalScope,
  });

  const {
    data: proposedDiffData,
    isSuccess: proposedDiffSuccess,
    isError: proposedDiffError,
    error: proposedDiffErr,
  } = useQuery({
    queryKey: queryKeys.prd.proposedDiff(projectId, notification.id),
    queryFn: () => api.prd.getProposedDiff(projectId, notification.id),
    enabled: !hideDiffInBlock && hasPrdApprovalScope,
    retry: false,
  });

  const handleApprove = useCallback(async () => {
    setLoading(true);
    try {
      await api.notifications.resolve(projectId, notification.id, {
        approved: true,
      });
      onResolved();
    } finally {
      setLoading(false);
    }
  }, [projectId, notification.id, onResolved]);

  const handleReject = useCallback(async () => {
    setLoading(true);
    try {
      await api.notifications.resolve(projectId, notification.id, {
        approved: false,
      });
      onResolved();
    } finally {
      setLoading(false);
    }
  }, [projectId, notification.id, onResolved]);

  const description = notification.questions?.[0]?.text ?? "Approval required";
  const proposedUpdates = scopeMeta?.scopeChangeProposedUpdates ?? [];
  const hasPrdDiff = !hideDiffInBlock && proposedUpdates.length > 0;
  const useServerDiff = hasPrdDiff && proposedDiffSuccess && proposedDiffData?.diff;
  const showDiffError = hasPrdDiff && proposedDiffError && !diffErrorDismissed;
  const diffErrorMessage =
    proposedDiffErr instanceof Error ? proposedDiffErr.message : "Could not load proposed diff";

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
        <div className="mb-4 rounded-lg border border-theme-border bg-theme-surface p-3 min-h-0 flex flex-col">
          <h5 className="text-xs font-medium text-theme-muted uppercase tracking-wide mb-2 shrink-0">
            Proposed PRD changes
          </h5>
          <div className="min-h-0 max-h-[24rem] overflow-y-auto">
            {useServerDiff ? (
              <ServerDiffView
                diff={proposedDiffData.diff}
                fromVersion="current"
                toVersion="proposed"
              />
            ) : showDiffError ? (
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
            ) : (
              <PrdDiffView
                currentPrd={currentPrd ?? null}
                scopeChangeMetadata={scopeMeta}
              />
            )}
          </div>
        </div>
      )}
      <div className="flex gap-2 shrink-0">
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
      </div>
    </div>
  );
}
