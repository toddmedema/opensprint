import { useState, useRef, useLayoutEffect, useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { AgentRole, TaskAnalytics, AgentLogEntry } from "@opensprint/shared";
import {
  AGENT_ROLE_CANONICAL_ORDER,
  AGENT_ROLE_LABELS,
  AGENT_ROLE_PHASES,
  AGENT_ROLE_DESCRIPTIONS,
} from "@opensprint/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatInput } from "./ChatInput";
import { NavButton } from "./layout/NavButton";
import { HelpAnalyticsChart } from "./HelpAnalyticsChart";
import { api } from "../api/client";
import { ASSET_BASE, NAVBAR_HEIGHT } from "../lib/constants";
import { getKeyboardShortcuts } from "../lib/keybindings";

export interface HelpContentProps {
  /** Optional project context (per-project view vs homepage) */
  project?: { id: string; name: string } | null;
  /** Optional close button for modal context (no standalone title/back) */
  onClose?: () => void;
}

type TabId = "ask" | "meet" | "analytics" | "agentLog" | "shortcuts";

const VALID_TAB_IDS: TabId[] = ["ask", "meet", "analytics", "agentLog", "shortcuts"];

/**
 * Shared Help content with five tabs: Ask a Question, Meet your Team, Analytics, Agent log, and Keyboard Shortcuts.
 * Used by HelpModal (legacy) and HelpPage (full-screen).
 */
export function HelpContent({ project, onClose }: HelpContentProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialTab: TabId =
    tabParam && VALID_TAB_IDS.includes(tabParam as TabId) ? (tabParam as TabId) : "ask";
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  // Sync tab from URL so /help?tab=shortcuts opens Keyboard Shortcuts.
  // Treat missing/invalid tab values as "ask".
  useEffect(() => {
    const nextTab: TabId =
      tabParam && VALID_TAB_IDS.includes(tabParam as TabId) ? (tabParam as TabId) : "ask";
    if (nextTab !== activeTab) {
      setActiveTab(nextTab);
    }
  }, [activeTab, tabParam]);

  const setTab = useCallback(
    (tab: TabId) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (tab === "ask") next.delete("tab");
        else next.set("tab", tab);
        return next;
      });
    },
    [setSearchParams]
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Full-width secondary nav bar — matches Plan/Execute filter bar pattern */}
      <div
        className="relative w-full px-4 sm:px-6 flex items-center justify-center border-b border-theme-border bg-theme-surface shrink-0"
        style={{ height: NAVBAR_HEIGHT }}
        role="tablist"
        aria-label="Help sections"
      >
        <div className="flex flex-wrap items-center justify-center gap-1 bg-theme-border-subtle rounded-lg p-1 shrink-0">
          <NavButton
            active={activeTab === "ask"}
            tone="accent"
            onClick={() => setTab("ask")}
            role="tab"
            aria-selected={activeTab === "ask"}
            aria-controls="help-tabpanel-ask"
            id="help-tab-ask"
          >
            Ask a Question
          </NavButton>
          <NavButton
            active={activeTab === "meet"}
            tone="accent"
            onClick={() => setTab("meet")}
            role="tab"
            aria-selected={activeTab === "meet"}
            aria-controls="help-tabpanel-meet"
            id="help-tab-meet"
          >
            Meet your Team
          </NavButton>
          <NavButton
            active={activeTab === "analytics"}
            tone="accent"
            onClick={() => setTab("analytics")}
            role="tab"
            aria-selected={activeTab === "analytics"}
            aria-controls="help-tabpanel-analytics"
            id="help-tab-analytics"
          >
            Analytics
          </NavButton>
          <NavButton
            active={activeTab === "agentLog"}
            tone="accent"
            onClick={() => setTab("agentLog")}
            role="tab"
            aria-selected={activeTab === "agentLog"}
            aria-controls="help-tabpanel-agent-log"
            id="help-tab-agent-log"
          >
            Agent log
          </NavButton>
          <NavButton
            active={activeTab === "shortcuts"}
            tone="accent"
            onClick={() => setTab("shortcuts")}
            role="tab"
            aria-selected={activeTab === "shortcuts"}
            aria-controls="help-tabpanel-shortcuts"
            id="help-tab-shortcuts"
          >
            Keyboard Shortcuts
          </NavButton>
        </div>
        <div className="absolute right-4 sm:right-6 top-1/2 -translate-y-1/2 flex items-center">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors shrink-0"
              aria-label="Close help"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden max-w-[1440px] mx-auto w-full bg-theme-surface px-4 sm:px-6 py-4">
          {activeTab === "ask" && (
            <div
              id="help-tabpanel-ask"
              role="tabpanel"
              aria-labelledby="help-tab-ask"
              className="flex-1 min-h-0 flex flex-col overflow-hidden"
            >
              <AskQuestionContent project={project} isActive={true} />
            </div>
          )}
          {activeTab === "meet" && (
            <div
              id="help-tabpanel-meet"
              role="tabpanel"
              aria-labelledby="help-tab-meet"
              className="flex-1 overflow-y-auto min-h-0"
            >
              <MeetYourTeamContent />
            </div>
          )}
          {activeTab === "analytics" && (
            <div
              id="help-tabpanel-analytics"
              role="tabpanel"
              aria-labelledby="help-tab-analytics"
              className="flex-1 overflow-y-auto min-h-0"
            >
              <AnalyticsContent projectId={project?.id ?? null} />
            </div>
          )}
          {activeTab === "agentLog" && (
            <div
              id="help-tabpanel-agent-log"
              role="tabpanel"
              aria-labelledby="help-tab-agent-log"
              className="flex-1 overflow-y-auto min-h-0"
            >
              <AgentLogContent projectId={project?.id ?? null} showProjectColumn={!project} />
            </div>
          )}
          {activeTab === "shortcuts" && (
            <div
              id="help-tabpanel-shortcuts"
              role="tabpanel"
              aria-labelledby="help-tab-shortcuts"
              className="flex-1 overflow-y-auto min-h-0"
            >
              <KeyboardShortcutsContent />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface HelpChatMessage {
  role: "user" | "assistant";
  content: string;
}

function HelpChatBubble({ msg }: { msg: HelpChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "border border-theme-border bg-theme-surface text-theme-text shadow-sm"
            : "bg-theme-border-subtle text-theme-text"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{msg.content}</p>
        ) : (
          <div className="prose-chat-bubble prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function AskQuestionContent({
  project,
  isActive,
}: {
  project?: { id: string; name: string } | null;
  isActive: boolean;
}) {
  const [messages, setMessages] = useState<HelpChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingHistory(true);
      try {
        const { messages: loaded } = await api.help.history(project?.id ?? null);
        if (!cancelled && Array.isArray(loaded)) {
          setMessages(loaded);
        }
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current ?? scrollEndRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight - el.clientHeight;
  }, []);

  useLayoutEffect(() => {
    scrollToBottom();
    const id = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(id);
  }, [messages, scrollToBottom]);

  useLayoutEffect(() => {
    if (isActive) {
      chatInputRef.current?.focus();
    }
  }, [isActive]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setError(null);
    const userMsg: HelpChatMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setSending(true);
    try {
      const priorMessages = messages.map((m) => ({ role: m.role, content: m.content }));
      const res = await api.help.chat({
        message: text,
        projectId: project?.id ?? null,
        messages: priorMessages,
      });
      setMessages((prev) => [...prev, { role: "assistant", content: res.message }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${msg}` }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1 overflow-hidden">
      <p className="text-theme-muted text-sm shrink-0">
        {project
          ? `Ask about ${project.name} — PRD, plans, tasks, or running agents. AI answers in ask-only mode without changing project state.`
          : "Ask about your projects, tasks, or running agents. AI answers in ask-only mode without changing project state."}
      </p>
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto min-h-[120px] space-y-3 py-2"
        data-testid="help-chat-messages"
      >
        {loadingHistory && (
          <div
            className="text-center py-6 text-theme-muted text-sm"
            data-testid="help-chat-loading-history"
          >
            Loading chat history…
          </div>
        )}
        {!loadingHistory && messages.length === 0 && (
          <div className="text-center py-6 text-theme-muted text-sm">
            <p>Type a question below and press Enter.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <HelpChatBubble key={i} msg={msg} />
        ))}
        {sending && (
          <div
            className="flex justify-start"
            role="status"
            aria-label="Agent is thinking"
            data-testid="help-chat-loading"
          >
            <div className="bg-theme-border-subtle rounded-2xl px-3.5 py-2.5 text-sm text-theme-muted">
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-theme-muted rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-theme-muted rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-theme-muted rounded-full animate-bounce [animation-delay:300ms]" />
              </span>
            </div>
          </div>
        )}
        <div ref={scrollEndRef} />
      </div>
      {error && (
        <p className="text-theme-error text-sm shrink-0" role="alert">
          {error}
        </p>
      )}
      <div className="shrink-0 pt-3">
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          sendDisabled={sending}
          placeholder="Ask a question..."
          aria-label="Help chat message"
          inputRef={chatInputRef}
        />
      </div>
    </div>
  );
}

function AnalyticsContent({ projectId }: { projectId: string | null }) {
  const [data, setData] = useState<TaskAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.help
      .analytics(projectId)
      .then((res) => {
        if (!cancelled) {
          setData(res);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load analytics");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-theme-muted text-sm">
        Loading analytics…
      </div>
    );
  }
  if (error) {
    return (
      <div className="py-6 text-theme-error text-sm" role="alert">
        {error}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-theme-muted text-sm">
        {projectId
          ? "Task completion analytics for this project (100 most recent completed tasks)."
          : "Task completion analytics across all projects (100 most recent completed tasks)."}
      </p>
      <HelpAnalyticsChart data={data.byComplexity} totalTasks={data.totalTasks} />
    </div>
  );
}

type AgentLogSortKey =
  | "attemptOutcome"
  | "summary"
  | "model"
  | "role"
  | "durationMs"
  | "endTime"
  | "projectName";

function SessionLogModal({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.help
      .sessionLog(sessionId)
      .then((res) => {
        if (!cancelled) setContent(res.content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load session log");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-log-modal-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close session log"
        onClick={onClose}
      />
      <div className="relative flex flex-col max-w-4xl w-full mx-4 max-h-[80vh] rounded-lg border border-theme-border bg-theme-surface shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border shrink-0">
          <h2 id="session-log-modal-title" className="text-lg font-medium text-theme-text">
            Session log
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
            aria-label="Close"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden p-4">
          {loading && <div className="text-theme-muted text-sm">Loading…</div>}
          {error && (
            <p className="text-theme-error text-sm" role="alert">
              {error}
            </p>
          )}
          {!loading && !error && content != null && (
            <div className="h-full overflow-auto">
              <pre
                className="text-xs font-mono text-theme-text whitespace-pre-wrap break-words rounded border border-theme-border bg-theme-surface-muted p-3"
                style={{ maxHeight: "calc(80vh - 120px)" }}
              >
                {content}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
type SortDir = "asc" | "desc";

function AgentLogContent({
  projectId,
  showProjectColumn,
}: {
  projectId: string | null;
  showProjectColumn: boolean;
}) {
  const [entries, setEntries] = useState<AgentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<AgentLogSortKey>("endTime");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [logModalSessionId, setLogModalSessionId] = useState<number | null>(null);

  const fetchLog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.help.agentLog(projectId);
      setEntries(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agent log");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchLog();
  }, [fetchLog]);

  const sortedEntries = useMemo(() => {
    const arr = [...entries];
    return arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "attemptOutcome") {
        cmp = (a.attemptOutcome ?? "").localeCompare(b.attemptOutcome ?? "");
      } else if (sortKey === "summary") {
        cmp = (a.summary ?? "").localeCompare(b.summary ?? "");
      } else if (sortKey === "model") {
        cmp = (a.model ?? "").localeCompare(b.model ?? "");
      } else if (sortKey === "role") {
        cmp = (a.role ?? "").localeCompare(b.role ?? "");
      } else if (sortKey === "durationMs") {
        cmp = (a.durationMs ?? 0) - (b.durationMs ?? 0);
      } else if (sortKey === "endTime") {
        cmp = (a.endTime ?? "").localeCompare(b.endTime ?? "");
      } else if (sortKey === "projectName" && showProjectColumn) {
        cmp = (a.projectName ?? "").localeCompare(b.projectName ?? "");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [entries, sortKey, sortDir, showProjectColumn]);

  const toggleSort = (key: AgentLogSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "endTime" ? "desc" : "asc");
    }
  };

  const SortHeader = ({ label, columnKey }: { label: string; columnKey: AgentLogSortKey }) => (
    <button
      type="button"
      onClick={() => toggleSort(columnKey)}
      className="text-left font-medium text-theme-text hover:text-theme-muted transition-colors flex items-center gap-1"
    >
      {label}
      {sortKey === columnKey && (
        <span className="text-theme-muted text-xs" aria-hidden>
          {sortDir === "asc" ? "↑" : "↓"}
        </span>
      )}
    </button>
  );

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  };

  const formatEndTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch {
      return iso;
    }
  };

  const formatAttemptOutcome = (entry: AgentLogEntry) => {
    switch (entry.attemptOutcome) {
      case "completed":
        return "Completed";
      case "requeued":
        return "Requeued";
      case "blocked":
        return "Blocked";
      case "demoted":
        return "Demoted";
      case "rejected":
        return "Rejected";
      case "failed":
        return "Failed";
      case "running":
        return "Running";
      case "suspended":
        return "Suspended";
      default:
        return entry.componentOutcome === "success" ? "Component passed" : "Component failed";
    }
  };

  const outcomeTone = (entry: AgentLogEntry) => {
    switch (entry.attemptOutcome) {
      case "completed":
        return "text-theme-success-text bg-theme-success-bg border-theme-success-border";
      case "blocked":
      case "failed":
      case "rejected":
        return "text-theme-error-text bg-theme-error-bg border-theme-error-border";
      case "requeued":
      case "demoted":
        return "text-theme-warning-text bg-theme-warning-bg border-theme-warning-border";
      default:
        return "text-theme-muted bg-theme-surface-muted border-theme-border";
    }
  };

  if (loading && entries.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-theme-muted text-sm">
        Loading agent log…
      </div>
    );
  }
  if (error) {
    return (
      <div className="py-6 text-theme-error text-sm" role="alert">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-theme-muted text-sm">
          {projectId ? "Past agent runs for this project." : "Past agent runs across all projects."}
        </p>
        <button
          type="button"
          onClick={fetchLog}
          disabled={loading}
          className="p-1.5 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors shrink-0 disabled:opacity-50"
          aria-label="Refresh agent log"
          title="Refresh"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-theme-border">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-theme-border bg-theme-surface-muted">
              <th className="px-4 py-2 text-left">
                <SortHeader label="Outcome" columnKey="attemptOutcome" />
              </th>
              <th className="px-4 py-2 text-left">
                <SortHeader label="Summary" columnKey="summary" />
              </th>
              <th className="px-4 py-2 text-left">
                <SortHeader label="Model" columnKey="model" />
              </th>
              <th className="px-4 py-2 text-left">
                <SortHeader label="Role" columnKey="role" />
              </th>
              <th className="px-4 py-2 text-left">
                <SortHeader label="Running time" columnKey="durationMs" />
              </th>
              <th className="px-4 py-2 text-left">
                <SortHeader label="End time" columnKey="endTime" />
              </th>
              {showProjectColumn && (
                <th className="px-4 py-2 text-left">
                  <SortHeader label="Project" columnKey="projectName" />
                </th>
              )}
              <th className="px-4 py-2 text-left w-12">Log</th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.length === 0 ? (
              <tr>
                <td
                  colSpan={showProjectColumn ? 8 : 7}
                  className="px-4 py-8 text-center text-theme-muted"
                >
                  No agent runs yet.
                </td>
              </tr>
            ) : (
              sortedEntries.map((e, i) => (
                <tr
                  key={i}
                  className="border-b border-theme-border last:border-b-0 hover:bg-theme-border-subtle/50"
                >
                  <td className="px-4 py-2 align-top">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${outcomeTone(e)}`}
                    >
                      {formatAttemptOutcome(e)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-theme-text align-top">
                    <div className="min-w-[280px] max-w-[520px]">
                      <div className="truncate" title={e.summary ?? undefined}>
                        {e.summary ?? "—"}
                      </div>
                      {(e.taskId || e.attempt != null || e.failureType) && (
                        <div className="mt-1 text-xs text-theme-muted">
                          {[
                            e.taskId,
                            e.attempt != null ? `attempt ${e.attempt}` : null,
                            e.failureType,
                          ]
                            .filter((part): part is string => part != null && part.length > 0)
                            .join(" · ")}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-theme-text">{e.model || "Unknown"}</td>
                  <td className="px-4 py-2 text-theme-text">{e.role}</td>
                  <td className="px-4 py-2 text-theme-text">{formatDuration(e.durationMs)}</td>
                  <td className="px-4 py-2 text-theme-text">{formatEndTime(e.endTime)}</td>
                  {showProjectColumn && (
                    <td className="px-4 py-2 text-theme-text">{e.projectName ?? "—"}</td>
                  )}
                  <td className="px-4 py-2">
                    {e.sessionId != null ? (
                      <button
                        type="button"
                        onClick={() => setLogModalSessionId(e.sessionId!)}
                        className="p-1.5 rounded-md text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle transition-colors"
                        aria-label="View session log"
                        title="View session log"
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="11" cy="11" r="8" />
                          <path d="m21 21-4.35-4.35" />
                        </svg>
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {logModalSessionId != null && (
        <SessionLogModal sessionId={logModalSessionId} onClose={() => setLogModalSessionId(null)} />
      )}
    </div>
  );
}

function KeyboardShortcutsContent() {
  const shortcuts = getKeyboardShortcuts();
  return (
    <div className="flex flex-col gap-4" data-testid="keyboard-shortcuts-content">
      <p className="text-theme-muted text-sm">
        Shortcuts are sourced from the app keybindings and match actual behavior.
      </p>
      <div className="overflow-x-auto rounded-lg border border-theme-border">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-theme-border bg-theme-surface-muted">
              <th className="px-4 py-2 text-left font-medium text-theme-text">Action</th>
              <th className="px-4 py-2 text-left font-medium text-theme-text">Keys</th>
              <th className="px-4 py-2 text-left font-medium text-theme-text">Context</th>
            </tr>
          </thead>
          <tbody>
            {shortcuts.map((entry, i) => (
              <tr
                key={i}
                className="border-b border-theme-border last:border-b-0 hover:bg-theme-border-subtle/50"
              >
                <td className="px-4 py-2 text-theme-text">{entry.action}</td>
                <td className="px-4 py-2 font-mono text-theme-text">{entry.keys}</td>
                <td className="px-4 py-2 text-theme-muted text-xs">{entry.context ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MeetYourTeamContent() {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      role="list"
      aria-label="Agent team members"
    >
      {AGENT_ROLE_CANONICAL_ORDER.map((role) => (
        <AgentCard key={role} role={role} />
      ))}
    </div>
  );
}

function AgentCard({ role }: { role: AgentRole }) {
  const [iconError, setIconError] = useState(false);
  const label = AGENT_ROLE_LABELS[role];
  const phases = AGENT_ROLE_PHASES[role];
  const description = AGENT_ROLE_DESCRIPTIONS[role];
  const iconSrc = `${ASSET_BASE}agent-icons/${role}.svg`;

  return (
    <article
      className="flex flex-col gap-2 rounded-lg border border-theme-border bg-theme-surface-muted p-4"
      role="listitem"
    >
      <div className="flex items-start gap-3">
        {iconError ? (
          <div
            className="w-12 h-12 shrink-0 rounded-lg bg-theme-border-subtle flex items-center justify-center text-theme-muted text-xs"
            aria-hidden="true"
          >
            ?
          </div>
        ) : (
          <img
            src={iconSrc}
            alt=""
            className="w-12 h-12 shrink-0 rounded-lg object-contain"
            loading="lazy"
            onError={() => setIconError(true)}
          />
        )}
        <div className="min-w-0 flex-1 flex flex-col items-start">
          <h3 className="font-medium text-theme-text m-0">{label}</h3>
          <div className="flex flex-wrap gap-1 mt-1">
            {phases.map((phase) => (
              <span
                key={phase}
                className="inline-flex items-center pl-0 pr-2 py-0.5 rounded text-xs font-medium bg-theme-border-subtle text-theme-muted"
              >
                {phase}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="text-sm text-theme-muted leading-relaxed">{description}</p>
    </article>
  );
}
