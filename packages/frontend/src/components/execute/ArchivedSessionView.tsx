import React, { useState, useRef, useMemo, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AgentSession } from "@opensprint/shared";
import { filterAgentOutput } from "../../utils/agentOutputFilter";

/** Execute sidebar: no horizontal rules (task feedback x5cqqc) */
const MARKDOWN_NO_HR = { hr: () => null };

/** Estimated height per session card (header + tabs + content area) */
const ESTIMATED_SESSION_HEIGHT = 400;

/** Single session card - only mounted when virtualized into view */
const SessionCard = React.memo(function SessionCard({
  session,
  isLast,
}: {
  session: AgentSession;
  isLast: boolean;
}) {
  const [activeTab, setActiveTab] = useState<"output" | "diff">("output");
  const filteredOutput = useMemo(
    () => (session.outputLog ? filterAgentOutput(session.outputLog) : ""),
    [session.outputLog]
  );

  return (
    <div className={!isLast ? "pb-6" : ""} data-testid={`session-card-${session.attempt}`}>
      <div className="px-4 py-2 flex items-center gap-4 text-xs flex-wrap text-theme-muted">
        <span>
          Attempt {session.attempt} · {session.status} · {session.agentType}
        </span>
        {session.testResults && session.testResults.total > 0 && (
          <span className="text-theme-success-muted">
            {session.testResults.passed} passed
            {session.testResults.failed > 0 && `, ${session.testResults.failed} failed`}
          </span>
        )}
        {session.failureReason && (
          <span
            className="text-theme-warning-solid truncate max-w-[200px]"
            title={session.failureReason}
          >
            {session.failureReason}
          </span>
        )}
      </div>
      <div className="flex gap-2 px-4 py-2">
        <button
          type="button"
          onClick={() => setActiveTab("output")}
          className={`text-xs font-medium ${
            activeTab === "output"
              ? "text-theme-success-muted"
              : "text-theme-muted hover:text-theme-text"
          }`}
        >
          Output log
        </button>
        {session.gitDiff && (
          <button
            type="button"
            onClick={() => setActiveTab("diff")}
            className={`text-xs font-medium ${
              activeTab === "diff"
                ? "text-theme-success-muted"
                : "text-theme-muted hover:text-theme-text"
            }`}
          >
            Git diff
          </button>
        )}
      </div>
      {activeTab === "output" ? (
        <div className="p-4 text-xs prose prose-sm prose-neutral dark:prose-invert prose-execute-task max-w-none prose-pre:bg-theme-code-bg prose-pre:text-theme-code-text prose-pre:border prose-pre:border-theme-border prose-pre:rounded-lg">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_NO_HR}>
            {filteredOutput || "(no output)"}
          </ReactMarkdown>
        </div>
      ) : (
        <pre className="p-4 text-xs font-mono whitespace-pre-wrap">
          {session.gitDiff || "(no diff)"}
        </pre>
      )}
    </div>
  );
});

function ArchivedSessionViewInner({ sessions }: { sessions: AgentSession[] }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_SESSION_HEIGHT,
    overscan: 2,
  });

  // Scroll to last (most recent) session on mount, matching previous dropdown default
  useEffect(() => {
    if (sessions.length > 1) {
      virtualizer.scrollToIndex(sessions.length - 1, { align: "end" });
    }
  }, [sessions.length]); // eslint-disable-line react-hooks/exhaustive-deps -- scroll only when session count changes

  if (sessions.length === 0) return null;

  const virtualItems = virtualizer.getVirtualItems();

  // Fallback: when scroll container has no height (e.g. jsdom, initial layout),
  // render all sessions so content is visible. Virtualization kicks in when
  // the scroll element has measurable dimensions.
  const useFallback = virtualItems.length === 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto min-h-0"
        data-testid="archived-sessions-list"
      >
        {useFallback ? (
          <div className="space-y-6">
            {sessions.map((session, i) => (
              <SessionCard
                key={session.attempt}
                session={session}
                isLast={i === sessions.length - 1}
              />
            ))}
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualItems.map((virtualItem) => {
              const session = sessions[virtualItem.index];
              if (!session) return null;
              return (
                <div
                  key={session.attempt}
                  data-index={virtualItem.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <SessionCard
                    session={session}
                    isLast={virtualItem.index === sessions.length - 1}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export const ArchivedSessionView = React.memo(ArchivedSessionViewInner);
