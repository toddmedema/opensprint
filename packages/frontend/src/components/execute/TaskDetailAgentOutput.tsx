import React from "react";
import type { AgentSession } from "@opensprint/shared";
import { VirtualizedAgentOutput } from "./VirtualizedAgentOutput";
import { ArchivedSessionView } from "./ArchivedSessionView";
import { useAppDispatch } from "../../store";
import { wsConnect } from "../../store/middleware/websocketMiddleware";
import { getMessageBasedHint } from "../../store/listeners/notificationListener";

export interface TaskDetailAgentOutputProps {
  projectId: string;
  taskDetailLoading: boolean;
  isDoneTask: boolean;
  archivedLoading: boolean;
  archivedSessions: AgentSession[];
  liveOutputContent: string;
  completionState: {
    status: string;
    testResults: { passed: number; failed: number; skipped: number; total: number } | null;
    reason?: string | null;
  } | null;
  wsConnected: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  showJumpToBottom: boolean;
  jumpToBottom: () => void;
}

export function TaskDetailAgentOutput({
  projectId,
  taskDetailLoading,
  isDoneTask,
  archivedLoading,
  archivedSessions,
  liveOutputContent,
  completionState,
  wsConnected,
  containerRef,
  onScroll,
  showJumpToBottom,
  jumpToBottom,
}: TaskDetailAgentOutputProps) {
  const dispatch = useAppDispatch();

  return (
    <div className="bg-theme-code-bg rounded-lg border border-theme-border overflow-hidden min-h-[200px] max-h-[400px] flex flex-col">
      {taskDetailLoading ? (
        <div className="p-4 space-y-2" data-testid="artifacts-loading">
          <div className="h-3 w-full bg-theme-surface-muted rounded animate-pulse" />
          <div className="h-3 w-4/5 bg-theme-surface-muted rounded animate-pulse" />
          <div className="h-20 w-full bg-theme-surface-muted rounded animate-pulse mt-4" />
        </div>
      ) : isDoneTask ? (
        archivedLoading ? (
          <div className="p-4 text-theme-muted text-sm">Loading archived sessions...</div>
        ) : archivedSessions.length === 0 ? (
          <div className="p-4 text-theme-muted text-sm">No archived sessions for this task.</div>
        ) : (
          <ArchivedSessionView sessions={archivedSessions} />
        )
      ) : (
        <div className="relative flex flex-col min-h-0 flex-1">
          {!wsConnected ? (
            <div className="p-4 flex flex-col gap-3" data-testid="live-output-connecting">
              <div className="text-sm text-theme-muted flex items-center gap-2">
                <span
                  className="inline-block w-4 h-4 border-2 border-theme-border border-t-brand-500 rounded-full animate-spin"
                  aria-hidden
                />
                Connecting to live output…
              </div>
              <p className="text-xs text-theme-muted">If the connection fails, you can retry.</p>
              <button
                type="button"
                onClick={() => dispatch(wsConnect({ projectId }))}
                className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline self-start"
                data-testid="live-output-retry"
              >
                Retry connection
              </button>
            </div>
          ) : (
            <>
              <VirtualizedAgentOutput
                content={liveOutputContent}
                mode="markdown"
                containerRef={containerRef}
                onScroll={onScroll}
                data-testid="live-agent-output"
              />
              {showJumpToBottom && (
                <button
                  type="button"
                  onClick={jumpToBottom}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs font-medium rounded-full bg-theme-surface border border-theme-border text-theme-text shadow-md hover:bg-theme-border-subtle/50 transition-colors z-10"
                  data-testid="jump-to-bottom"
                  aria-label="Jump to bottom"
                >
                  Jump to bottom
                </button>
              )}
            </>
          )}
          {completionState && (
            <div className="px-4 pb-4 pt-3 mt-0">
              <div
                className={`text-sm font-medium ${
                  completionState.status === "approved"
                    ? "text-theme-success-muted"
                    : "text-theme-warning-solid"
                }`}
              >
                Agent done: {completionState.status}
              </div>
              {completionState.status === "failed" &&
                completionState.reason &&
                completionState.reason.trim() !== "" && (
                  <div
                    className="text-xs text-theme-error-text mt-1"
                    data-testid="completion-failure-reason"
                  >
                    {completionState.reason}
                    {getMessageBasedHint(completionState.reason) && (
                      <div className="mt-1 text-theme-muted">
                        {getMessageBasedHint(completionState.reason)}
                      </div>
                    )}
                  </div>
                )}
              {completionState.testResults && completionState.testResults.total > 0 && (
                <div className="text-xs text-theme-muted mt-1">
                  {completionState.testResults.passed} passed
                  {completionState.testResults.failed > 0
                    ? `, ${completionState.testResults.failed} failed`
                    : ""}
                  {completionState.testResults.skipped > 0 &&
                    `, ${completionState.testResults.skipped} skipped`}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
