import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../../api/client";
import { useWebSocket } from "../../hooks/useWebSocket";

interface DesignPhaseProps {
  projectId: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface PrdChangeLogEntry {
  section: string;
  version: number;
  source: "design" | "plan" | "build" | "validate";
  timestamp: string;
  diff: string;
}

function formatSectionKey(key: string): string {
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

const RESIZE_STORAGE_KEY = "opensprint.design.chatPct";
const MIN_CHAT_PCT = 20;
const MAX_CHAT_PCT = 80;

const PRD_SECTION_ORDER = [
  "executive_summary",
  "problem_statement",
  "goals_and_metrics",
  "user_personas",
  "technical_architecture",
  "feature_list",
  "non_functional_requirements",
  "data_model",
  "api_contracts",
  "open_questions",
] as const;

function parsePrdSections(prd: unknown): Record<string, string> {
  const data = prd as { sections?: Record<string, { content: string }> };
  const content: Record<string, string> = {};
  if (data?.sections) {
    for (const [key, section] of Object.entries(data.sections)) {
      content[key] = section.content;
    }
  }
  return content;
}

function getOrderedSections(prdContent: Record<string, string>): string[] {
  const orderSet = new Set<string>(PRD_SECTION_ORDER);
  const ordered = PRD_SECTION_ORDER.filter((k) => prdContent[k]);
  const rest = Object.keys(prdContent).filter((k) => !orderSet.has(k));
  return [...ordered, ...rest];
}

export function DesignPhase({ projectId }: DesignPhaseProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prdContent, setPrdContent] = useState<Record<string, string>>({});
  const [prdHistory, setPrdHistory] = useState<PrdChangeLogEntry[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [focusedSection, setFocusedSection] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resizable split: chatPct = percent of width for chat (20–80)
  const [chatPct, setChatPct] = useState(() => {
    try {
      const stored = localStorage.getItem(RESIZE_STORAGE_KEY);
      if (stored != null) {
        const n = Number(stored);
        if (n >= MIN_CHAT_PCT && n <= MAX_CHAT_PCT) return n;
      }
    } catch {
      /* ignore */
    }
    return 50;
  });

  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startPctRef = useRef(50);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    startXRef.current = e.clientX;
    startPctRef.current = chatPct;
  }, [chatPct]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const width = rect.width;
      const deltaX = e.clientX - startXRef.current;
      const deltaPct = (deltaX / width) * 100;
      let next = startPctRef.current + deltaPct;
      next = Math.max(MIN_CHAT_PCT, Math.min(MAX_CHAT_PCT, next));
      setChatPct(next);
    };
    const onUp = () => {
      isResizingRef.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Persist chatPct to localStorage when it changes (during drag)
  useEffect(() => {
    try {
      localStorage.setItem(RESIZE_STORAGE_KEY, String(chatPct));
    } catch {
      /* ignore */
    }
  }, [chatPct]);

  const refetchPrd = useCallback(async () => {
    const data = await api.prd.get(projectId);
    setPrdContent(parsePrdSections(data));
  }, [projectId]);

  const refetchHistory = useCallback(async () => {
    const data = await api.prd.getHistory(projectId);
    setPrdHistory((data as PrdChangeLogEntry[]) ?? []);
  }, [projectId]);

  // Subscribe to live PRD updates via WebSocket
  useWebSocket({
    projectId,
    onEvent: (event) => {
      if (event.type === "prd.updated") {
        refetchPrd();
        refetchHistory();
      }
    },
  });

  const refetchConversation = useCallback(async () => {
    const data = await api.chat.history(projectId, "design");
    const conv = data as { messages?: Message[] };
    if (conv?.messages) {
      setMessages(conv.messages);
    }
  }, [projectId]);

  // Load conversation history, PRD, and change history
  useEffect(() => {
    refetchConversation();
    refetchPrd();
    refetchHistory();
  }, [projectId, refetchPrd, refetchHistory, refetchConversation]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;

    const userMessage: Message = {
      role: "user",
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const prdFocus = focusedSection;
      setFocusedSection(null);
      const response = (await api.chat.send(projectId, userMessage.content, "design", prdFocus ?? undefined)) as {
        message: string;
        prdChanges?: { section: string; previousVersion: number; newVersion: number }[];
      };
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: response.message,
          timestamp: new Date().toISOString(),
        },
      ]);
      // Live PRD update: refetch when agent applied PRD changes (WebSocket may also fire, but this ensures updates)
      if (response.prdChanges?.length) {
        refetchPrd();
        refetchHistory();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send message. Please try again.";
      setError(msg);
    } finally {
      setSending(false);
    }
  };

  const handleStartEdit = (section: string) => {
    setEditingSection(section);
    setEditDraft(prdContent[section] ?? "");
  };

  const handleCancelEdit = () => {
    setEditingSection(null);
    setEditDraft("");
  };

  const handleSaveEdit = async () => {
    if (!editingSection || savingSection) return;
    setSavingSection(editingSection);
    try {
      await api.prd.updateSection(projectId, editingSection, editDraft);
      await refetchPrd();
      await refetchHistory();
      await refetchConversation();
      setEditingSection(null);
      setEditDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save PRD section");
    } finally {
      setSavingSection(null);
    }
  };

  return (
    <div ref={containerRef} className="flex h-full">
      {/* Left: Chat Pane */}
      <div
        className="flex flex-col border-r border-gray-200 shrink-0 overflow-hidden"
        style={{ flexBasis: `${chatPct}%`, minWidth: 0 }}
      >
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.length === 0 && (
            <div className="text-center py-20">
              <h3 className="text-lg font-medium text-gray-900 mb-2">Start designing your product</h3>
              <p className="text-gray-500 max-w-md mx-auto">
                Describe your product vision and the AI planning agent will help you build a comprehensive PRD through
                conversation.
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                  msg.role === "user" ? "bg-brand-600 text-white" : "bg-gray-100 text-gray-900"
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-gray-100 rounded-2xl px-4 py-3 text-sm text-gray-400">Thinking...</div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-4 mb-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
            <button
              type="button"
              onClick={() => setError(null)}
              className="ml-2 text-red-500 hover:text-red-700 underline"
              aria-label="Dismiss"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Input */}
        <div className="p-4 border-t border-gray-200">
          <div className="flex gap-3">
            <input
              type="text"
              className="input flex-1"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={
                focusedSection
                  ? `Focusing on ${formatSectionKey(focusedSection)} — describe changes or ask questions...`
                  : "Describe your product vision..."
              }
              disabled={sending}
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="btn-primary disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={chatPct}
        aria-valuemin={MIN_CHAT_PCT}
        aria-valuemax={MAX_CHAT_PCT}
        tabIndex={0}
        onMouseDown={handleResizeStart}
        className="w-1.5 flex-shrink-0 cursor-col-resize bg-gray-200 hover:bg-brand-400 active:bg-brand-500 transition-colors select-none shrink-0"
        title="Drag to resize"
      />

      {/* Right: Live PRD + Change History */}
      <div className="flex-1 min-w-0 overflow-y-auto p-6 bg-gray-50 flex flex-col">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Living PRD</h2>

        {Object.keys(prdContent).length === 0 ? (
          <div className="text-center py-10 text-gray-400 text-sm">
            PRD sections will appear here as you design your product
          </div>
        ) : (
          <div className="space-y-4 flex-1">
            {getOrderedSections(prdContent).map((sectionKey) => (
              <div
                key={sectionKey}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (editingSection !== sectionKey) {
                    setFocusedSection((prev) => (prev === sectionKey ? null : sectionKey));
                  }
                }}
                onKeyDown={(e) => {
                  if (editingSection !== sectionKey && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    setFocusedSection((prev) => (prev === sectionKey ? null : sectionKey));
                  }
                }}
                className={`rounded-lg border p-4 transition-colors cursor-pointer select-none ${
                  focusedSection === sectionKey
                    ? "bg-brand-50 border-brand-400 ring-2 ring-brand-200"
                    : "bg-white border-gray-200 hover:border-gray-300"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-700">
                    {formatSectionKey(sectionKey)}
                    {focusedSection === sectionKey && (
                      <span className="ml-2 text-xs font-normal text-brand-600">(added to next message)</span>
                    )}
                  </h3>
                  {editingSection !== sectionKey ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStartEdit(sectionKey);
                      }}
                      className="text-xs text-brand-600 hover:text-brand-700 font-medium"
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
                {editingSection === sectionKey ? (
                  <div className="space-y-2">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      className="w-full min-h-[120px] p-3 text-sm border border-gray-300 rounded-md font-mono focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                      placeholder="Markdown content..."
                      disabled={!!savingSection}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleSaveEdit}
                        disabled={savingSection === sectionKey || editDraft === (prdContent[sectionKey] ?? "")}
                        className="btn-primary text-sm py-1.5 px-3 disabled:opacity-50"
                      >
                        {savingSection === sectionKey ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        disabled={!!savingSection}
                        className="btn-secondary text-sm py-1.5 px-3"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="prose prose-sm prose-gray max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {prdContent[sectionKey] || "_No content yet_"}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* PRD Change History */}
        <div className="mt-6 pt-4 border-t border-gray-200">
          <button
            type="button"
            onClick={() => setHistoryExpanded(!historyExpanded)}
            className="flex items-center justify-between w-full text-left text-sm font-medium text-gray-700 hover:text-gray-900"
          >
            <span>Change history</span>
            <span className="text-gray-400">
              {prdHistory.length} {prdHistory.length === 1 ? "entry" : "entries"}
            </span>
          </button>
          {historyExpanded && (
            <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
              {prdHistory.length === 0 ? (
                <p className="text-sm text-gray-400">No changes yet</p>
              ) : (
                [...prdHistory].reverse().map((entry, i) => (
                  <div
                    key={`${entry.section}-${entry.version}-${i}`}
                    className="text-xs bg-white rounded border border-gray-200 p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-800">
                        {formatSectionKey(entry.section)}
                      </span>
                      <span className="text-gray-500 shrink-0">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          entry.source === "design"
                            ? "bg-blue-100 text-blue-800"
                            : entry.source === "plan"
                              ? "bg-amber-100 text-amber-800"
                              : entry.source === "build"
                                ? "bg-green-100 text-green-800"
                                : "bg-purple-100 text-purple-800"
                        }`}
                      >
                        {entry.source}
                      </span>
                      <span className="text-gray-500">v{entry.version}</span>
                      <span className="text-gray-400 truncate">{entry.diff}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
