import React from "react";
import { CloseButton } from "../CloseButton";
import { shouldRightAlignDropdown } from "../../lib/dropdownViewport";
import { useModalA11y } from "../../hooks/useModalA11y";
import { OpenInEditorButton } from "../OpenInEditorButton";

export interface TaskDetailHeaderProps {
  title: string;
  hasActions: boolean;
  isBlockedTask: boolean;
  isDoneTask: boolean;
  markDoneLoading: boolean;
  unblockLoading: boolean;
  deleteLoading: boolean;
  forceRetryLoading: boolean;
  onClose: () => void;
  onMarkDone: () => void;
  onUnblock: () => void;
  onDeleteTask: () => void | Promise<void>;
  onForceRetry: () => void | Promise<void>;
  deleteConfirmOpen: boolean;
  setDeleteConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
  deleteLinkConfirm: {
    targetId: string;
    type: string;
    taskName: string;
  } | null;
  setDeleteLinkConfirm: React.Dispatch<
    React.SetStateAction<{
      targetId: string;
      type: string;
      taskName: string;
    } | null>
  >;
  removeLinkRemovingId: string | null;
  onRemoveLink: (targetId: string) => Promise<void>;
  /** Project ID for the open-editor API call. */
  projectId?: string;
  /** Task ID for the open-editor API call. */
  taskId?: string;
  /** Whether the task is currently being worked on by an agent. */
  isInProgressTask?: boolean;
  /** Worktree path from the active task slot; null when not available. */
  worktreePath?: string | null;
  /** True when the project uses branches mode (shared checkout warning). */
  isBranchesMode?: boolean;
  /** A durable standards hold is resolved through its docket, not ordinary retry actions. */
  isGovernanceHeld?: boolean;
  governanceCaseId?: string;
}

export function TaskDetailHeader({
  title,
  hasActions,
  isBlockedTask,
  isDoneTask,
  markDoneLoading,
  unblockLoading,
  deleteLoading,
  forceRetryLoading,
  onClose,
  onMarkDone,
  onUnblock,
  onDeleteTask,
  onForceRetry,
  deleteConfirmOpen,
  setDeleteConfirmOpen,
  deleteLinkConfirm,
  setDeleteLinkConfirm,
  removeLinkRemovingId,
  onRemoveLink,
  projectId,
  taskId,
  isInProgressTask = false,
  worktreePath,
  isBranchesMode = false,
  isGovernanceHeld = false,
  governanceCaseId,
}: TaskDetailHeaderProps) {
  const [actionsMenuOpen, setActionsMenuOpen] = React.useState(false);
  const [actionsMenuAlignRight, setActionsMenuAlignRight] = React.useState(false);
  const [forceRetryConfirmOpen, setForceRetryConfirmOpen] = React.useState(false);
  const actionsMenuRef = React.useRef<HTMLDivElement>(null);
  const actionsMenuTriggerRef = React.useRef<HTMLButtonElement>(null);
  const deleteConfirmDialogRef = React.useRef<HTMLDivElement>(null);
  const forceRetryDialogRef = React.useRef<HTMLDivElement>(null);
  const deleteLinkDialogRef = React.useRef<HTMLDivElement>(null);

  const closeDeleteConfirm = React.useCallback(
    () => setDeleteConfirmOpen(false),
    [setDeleteConfirmOpen]
  );
  const closeForceRetryConfirm = React.useCallback(
    () => setForceRetryConfirmOpen(false),
    [setForceRetryConfirmOpen]
  );
  const closeDeleteLinkConfirm = React.useCallback(
    () => setDeleteLinkConfirm(null),
    [setDeleteLinkConfirm]
  );

  useModalA11y({
    containerRef: deleteConfirmDialogRef,
    onClose: closeDeleteConfirm,
    isOpen: deleteConfirmOpen,
  });
  useModalA11y({
    containerRef: forceRetryDialogRef,
    onClose: closeForceRetryConfirm,
    isOpen: forceRetryConfirmOpen,
  });
  useModalA11y({
    containerRef: deleteLinkDialogRef,
    onClose: closeDeleteLinkConfirm,
    isOpen: deleteLinkConfirm != null,
  });

  React.useEffect(() => {
    if (!actionsMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [actionsMenuOpen]);

  React.useEffect(() => {
    if (actionsMenuOpen && actionsMenuTriggerRef.current) {
      setActionsMenuAlignRight(
        shouldRightAlignDropdown(actionsMenuTriggerRef.current.getBoundingClientRect())
      );
    }
  }, [actionsMenuOpen]);

  const handleConfirmDeleteTask = async () => {
    await onDeleteTask();
    setDeleteConfirmOpen(false);
  };

  const handleConfirmForceRetry = async () => {
    if (isGovernanceHeld) return;
    await onForceRetry();
    setForceRetryConfirmOpen(false);
  };

  return (
    <>
      <div className="flex items-center gap-2 px-4 pt-4 pb-2 shrink-0 min-h-0 flex-nowrap">
        <div className="min-w-0 flex-1">
          <h3
            className="font-semibold text-theme-text truncate block"
            data-testid="task-detail-title"
          >
            {title}
          </h3>
        </div>
        {projectId && taskId && (
          <OpenInEditorButton
            projectId={projectId}
            taskId={taskId}
            isInProgress={isInProgressTask}
            worktreePath={worktreePath ?? null}
            isBranchesMode={isBranchesMode}
            variant="sm"
          />
        )}
        {hasActions && (
          <div ref={actionsMenuRef} className="relative shrink-0">
            <button
              ref={actionsMenuTriggerRef}
              type="button"
              onClick={() => setActionsMenuOpen((o) => !o)}
              className="p-1.5 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
              aria-label="Task actions"
              aria-haspopup="menu"
              aria-expanded={actionsMenuOpen}
              data-testid="sidebar-actions-menu-trigger"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
              </svg>
            </button>
            {actionsMenuOpen && (
              <ul
                role="menu"
                className={`dropdown-menu-elevated dropdown-menu-surface absolute top-full mt-1 min-w-[140px] ${actionsMenuAlignRight ? "right-0 left-auto" : "left-0 right-auto"}`}
                data-testid="sidebar-actions-menu"
              >
                {isGovernanceHeld && projectId && (
                  <li role="none">
                    <a
                      role="menuitem"
                      className="dropdown-item block px-3 py-2 text-xs font-medium text-violet-700 dark:text-violet-300"
                      href={`/projects/${projectId}/settings?tab=governance${governanceCaseId ? `&case=${encodeURIComponent(governanceCaseId)}` : ""}`}
                    >
                      Review governance docket
                    </a>
                  </li>
                )}
                {isBlockedTask && (
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onUnblock();
                      }}
                      disabled={unblockLoading || isGovernanceHeld}
                      title={
                        isGovernanceHeld
                          ? "Resolve the governance docket before retrying"
                          : undefined
                      }
                      aria-busy={unblockLoading}
                      aria-label={unblockLoading ? "Retrying" : "Retry"}
                      className="dropdown-item w-full flex items-center gap-2 text-left text-xs text-theme-error-text hover:bg-theme-border focus-visible:bg-theme-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[2rem]"
                      data-testid="sidebar-retry-btn"
                    >
                      {unblockLoading ? (
                        <span
                          className="inline-block w-4 h-4 border-2 border-theme-border border-t-brand-500 rounded-full animate-spin shrink-0"
                          aria-hidden
                          data-testid="sidebar-retry-spinner"
                        />
                      ) : (
                        "Retry"
                      )}
                    </button>
                  </li>
                )}
                {!isDoneTask && (
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onMarkDone();
                        setActionsMenuOpen(false);
                      }}
                      disabled={markDoneLoading || isGovernanceHeld}
                      className="dropdown-item w-full flex items-center gap-2 text-left text-xs font-medium text-brand-600 hover:bg-theme-border focus-visible:bg-theme-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid="sidebar-mark-done-btn"
                    >
                      {markDoneLoading ? "Marking…" : "Mark done"}
                    </button>
                  </li>
                )}
                {!isDoneTask && (
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setForceRetryConfirmOpen(true);
                        setActionsMenuOpen(false);
                      }}
                      disabled={forceRetryLoading || isGovernanceHeld}
                      className="dropdown-item w-full flex items-center gap-2 text-left text-xs text-theme-warning-text hover:bg-theme-border focus-visible:bg-theme-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid="sidebar-force-retry-btn"
                    >
                      {forceRetryLoading ? "Retrying..." : "Force Retry"}
                    </button>
                  </li>
                )}
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDeleteConfirmOpen(true);
                      setActionsMenuOpen(false);
                    }}
                    disabled={deleteLoading}
                    className="dropdown-item w-full flex items-center gap-2 text-left text-xs text-theme-error-text hover:bg-theme-border focus-visible:bg-theme-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="sidebar-delete-task-btn"
                  >
                    {deleteLoading ? "Deleting..." : "Delete"}
                  </button>
                </li>
              </ul>
            )}
          </div>
        )}
        <div className="shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center">
          <CloseButton onClick={onClose} ariaLabel="Close task detail" />
        </div>
      </div>

      {deleteConfirmOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close delete task confirmation"
            onClick={closeDeleteConfirm}
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          />
          <div
            ref={deleteConfirmDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-task-confirm-title"
            className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col"
            data-testid="sidebar-delete-task-dialog"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border shrink-0">
              <h2 id="delete-task-confirm-title" className="text-lg font-semibold text-theme-text">
                Delete task
              </h2>
              <CloseButton
                onClick={closeDeleteConfirm}
                ariaLabel="Close delete task confirmation"
              />
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-theme-text">
                Delete this task permanently? This also removes links and references to this task.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
              <button
                type="button"
                onClick={closeDeleteConfirm}
                className="btn-secondary"
                data-testid="sidebar-delete-task-cancel-btn"
                disabled={deleteLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleConfirmDeleteTask();
                }}
                className="btn-primary disabled:opacity-50"
                data-testid="sidebar-delete-task-confirm-btn"
                disabled={deleteLoading}
              >
                {deleteLoading ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {forceRetryConfirmOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close force retry confirmation"
            onClick={closeForceRetryConfirm}
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          />
          <div
            ref={forceRetryDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="force-retry-confirm-title"
            className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col"
            data-testid="sidebar-force-retry-dialog"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border shrink-0">
              <h2 id="force-retry-confirm-title" className="text-lg font-semibold text-theme-text">
                Force retry task
              </h2>
              <CloseButton
                onClick={closeForceRetryConfirm}
                ariaLabel="Close force retry confirmation"
              />
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-theme-text">
                This will destroy all in-progress work and worktrees for this task and restart it
                from scratch. This action cannot be undone.
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
              <button
                type="button"
                onClick={closeForceRetryConfirm}
                className="btn-secondary"
                data-testid="sidebar-force-retry-cancel-btn"
                disabled={forceRetryLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleConfirmForceRetry();
                }}
                className="btn-primary disabled:opacity-50"
                data-testid="sidebar-force-retry-confirm-btn"
                disabled={forceRetryLoading || isGovernanceHeld}
              >
                {forceRetryLoading ? (
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin shrink-0"
                      aria-hidden
                    />
                    Retrying...
                  </span>
                ) : (
                  "Force Retry"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteLinkConfirm && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close delete link confirmation"
            onClick={closeDeleteLinkConfirm}
            className="absolute inset-0 bg-theme-overlay backdrop-blur-sm"
          />
          <div
            ref={deleteLinkDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-link-confirm-title"
            className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col"
            data-testid="sidebar-delete-link-dialog"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-theme-border shrink-0">
              <h2 id="delete-link-confirm-title" className="text-lg font-semibold text-theme-text">
                Remove link
              </h2>
              <CloseButton
                onClick={closeDeleteLinkConfirm}
                ariaLabel="Close delete link confirmation"
              />
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-theme-text">
                Are you sure you want to delete the{" "}
                {deleteLinkConfirm.type === "blocks"
                  ? "Blocked on"
                  : deleteLinkConfirm.type === "parent-child"
                    ? "Parent"
                    : "Related"}{" "}
                link to {deleteLinkConfirm.taskName}?
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
              <button
                type="button"
                onClick={closeDeleteLinkConfirm}
                className="btn-secondary"
                data-testid="sidebar-delete-link-cancel-btn"
                disabled={removeLinkRemovingId !== null}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { targetId } = deleteLinkConfirm;
                  await onRemoveLink(targetId);
                }}
                className="btn-primary disabled:opacity-50"
                data-testid="sidebar-delete-link-confirm-btn"
                disabled={removeLinkRemovingId !== null}
              >
                {removeLinkRemovingId ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
