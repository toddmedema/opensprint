import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  sendDesignMessage,
  savePrdSection,
  uploadPrdFile,
  addUserMessage,
  setDesignError,
  fetchPrd,
  fetchPrdHistory,
  fetchDesignChat,
} from "../../store/slices/designSlice";
import { decomposePlans } from "../../store/slices/planSlice";
import { formatSectionKey, formatTimestamp } from "../../lib/formatting";
import { getPrdSourceColor } from "../../lib/constants";
import { getOrderedSections } from "../../lib/prdUtils";

/* ── Types ──────────────────────────────────────────────── */

interface DreamPhaseProps {
  projectId: string;
  onNavigateToPlan?: () => void;
}

interface SelectionInfo {
  text: string;
  sectionKey: string;
  rect: DOMRect;
}

/* ── Constants ──────────────────────────────────────────── */

const EXAMPLE_IDEAS = [
  "A multiplayer Jeopardy game for phones where friends compete in real-time",
  "A web service that charges my EV when solar panels are producing excess energy",
  "A bot that replies to my boss's weekend texts with a poop emoji",
  "A fitness app that scans gym equipment with your camera and builds custom workouts",
  "A fridge inventory tracker that suggests recipes for stuff about to expire",
  "A browser extension that summarizes meeting invites and tells you which to skip",
  "A neighborhood tool-sharing app where neighbors lend and borrow power tools",
  "A pet mood tracker that uses AI to analyze photos and gauge your dog's happiness",
  "A bill-splitting app that remembers who always forgets to pay and shames them politely",
  "A parking spot predictor that learns patterns and finds open spots near you",
  "A gift recommendation engine that scans wishlists across Amazon, Etsy, and more",
  "An AI soundscape generator that creates unique ambient sleep sounds every night",
  "A subscription auditor that alerts you about services you haven't used in months",
];

const ACCEPTED_FILE_TYPES = ".md,.docx,.pdf";

/* ── Helpers ────────────────────────────────────────────── */

function findParentSection(node: Node): string | null {
  let el: HTMLElement | null =
    node instanceof HTMLElement ? node : node.parentElement;
  while (el) {
    if (el.dataset.prdSection) return el.dataset.prdSection;
    el = el.parentElement;
  }
  return null;
}

/* ── SVG Icons (inline for zero-dep usage) ──────────────── */

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" />
    </svg>
  );
}

function CommentIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

/* ── Main Component ─────────────────────────────────────── */

export function DreamPhase({ projectId, onNavigateToPlan }: DreamPhaseProps) {
  const dispatch = useAppDispatch();

  /* ── Redux state ── */
  const messages = useAppSelector((s) => s.design.messages);
  const prdContent = useAppSelector((s) => s.design.prdContent);
  const prdHistory = useAppSelector((s) => s.design.prdHistory);
  const sending = useAppSelector((s) => s.design.sendingChat);
  const savingSection = useAppSelector((s) => s.design.savingSection);
  const error = useAppSelector((s) => s.design.error);

  /* ── Local UI state (preserved by mount-all) ── */
  const [initialInput, setInitialInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [selectionContext, setSelectionContext] = useState<{
    text: string;
    section: string;
  } | null>(null);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [planningIt, setPlanningIt] = useState(false);

  /* ── Refs ── */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prdContainerRef = useRef<HTMLDivElement>(null);
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);

  /* ── Derived ── */
  const hasPrdContent = Object.keys(prdContent).length > 0;

  // Auto-scroll chat messages
  useEffect(() => {
    chatMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, chatOpen]);

  /* ── Typewriter placeholder effect ── */
  useEffect(() => {
    if (hasPrdContent) return;
    const el = textareaRef.current;
    if (!el) return;

    let textIdx = Math.floor(Math.random() * EXAMPLE_IDEAS.length);
    let charIdx = 0;
    let isDeleting = false;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function tick() {
      if (cancelled || !el) return;
      const currentText = EXAMPLE_IDEAS[textIdx];

      if (!isDeleting) {
        charIdx++;
        el.placeholder = currentText.slice(0, charIdx);
        if (charIdx >= currentText.length) {
          timer = setTimeout(() => {
            isDeleting = true;
            tick();
          }, 2500);
          return;
        }
        timer = setTimeout(tick, 40 + Math.random() * 40);
      } else {
        charIdx--;
        el.placeholder = currentText.slice(0, charIdx);
        if (charIdx <= 0) {
          isDeleting = false;
          textIdx = (textIdx + 1) % EXAMPLE_IDEAS.length;
          timer = setTimeout(tick, 400);
          return;
        }
        timer = setTimeout(tick, 20);
      }
    }

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hasPrdContent]);

  /* ── Text selection handler for inline commenting ── */
  useEffect(() => {
    if (!hasPrdContent) return;
    const container = prdContainerRef.current;
    if (!container) return;

    const handleMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setTimeout(() => {
          const activeEl = document.activeElement;
          if (!activeEl || !activeEl.closest("[data-selection-toolbar]")) {
            setSelection(null);
          }
        }, 200);
        return;
      }

      const text = sel.toString().trim();
      if (!text) {
        setSelection(null);
        return;
      }

      const sectionKey = findParentSection(sel.anchorNode!);
      if (!sectionKey) {
        setSelection(null);
        return;
      }

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setSelection({ text, sectionKey, rect });
    };

    container.addEventListener("mouseup", handleMouseUp);
    return () => container.removeEventListener("mouseup", handleMouseUp);
  }, [hasPrdContent]);

  /* ── Handlers ── */

  const handleInitialSubmit = useCallback(async () => {
    if (!initialInput.trim() || sending) return;
    const text = initialInput.trim();
    setInitialInput("");

    dispatch(
      addUserMessage({
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      }),
    );

    const result = await dispatch(sendDesignMessage({ projectId, message: text }));
    if (sendDesignMessage.fulfilled.match(result) && result.payload.prdChanges?.length) {
      dispatch(fetchPrd(projectId));
      dispatch(fetchPrdHistory(projectId));
    }
  }, [initialInput, sending, projectId, dispatch]);

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      dispatch(
        addUserMessage({
          role: "user",
          content: `[Uploaded: ${file.name}]`,
          timestamp: new Date().toISOString(),
        }),
      );

      const result = await dispatch(uploadPrdFile({ projectId, file }));
      if (uploadPrdFile.fulfilled.match(result)) {
        dispatch(fetchPrd(projectId));
        dispatch(fetchPrdHistory(projectId));
        dispatch(fetchDesignChat(projectId));
      }

      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [projectId, dispatch],
  );

  const handleChatSend = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || sending) return;

    setChatInput("");

    const fullMessage = selectionContext
      ? `Regarding "${selectionContext.text}":\n${text}`
      : text;
    const prdFocus = selectionContext?.section ?? undefined;
    setSelectionContext(null);

    dispatch(
      addUserMessage({
        role: "user",
        content: fullMessage,
        timestamp: new Date().toISOString(),
      }),
    );

    const result = await dispatch(
      sendDesignMessage({ projectId, message: fullMessage, prdSectionFocus: prdFocus }),
    );
    if (sendDesignMessage.fulfilled.match(result) && result.payload.prdChanges?.length) {
      dispatch(fetchPrd(projectId));
      dispatch(fetchPrdHistory(projectId));
    }
  }, [chatInput, sending, selectionContext, projectId, dispatch]);

  const handleDiscuss = () => {
    if (!selection) return;
    setSelectionContext({
      text: selection.text,
      section: selection.sectionKey,
    });
    setSelection(null);
    setChatOpen(true);
    window.getSelection()?.removeAllRanges();
    setTimeout(() => chatInputRef.current?.focus(), 100);
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
    const result = await dispatch(
      savePrdSection({ projectId, section: editingSection, content: editDraft }),
    );
    if (savePrdSection.fulfilled.match(result)) {
      dispatch(fetchPrd(projectId));
      dispatch(fetchPrdHistory(projectId));
      dispatch(fetchDesignChat(projectId));
      setEditingSection(null);
      setEditDraft("");
    }
  };

  const handlePlanIt = async () => {
    dispatch(setDesignError(null));
    setPlanningIt(true);
    const result = await dispatch(decomposePlans(projectId));
    setPlanningIt(false);
    if (decomposePlans.fulfilled.match(result)) {
      onNavigateToPlan?.();
    }
  };

  /* ══════════════════════════════════════════════════════════
   *  RENDER: Initial Prompt View (No PRD yet)
   * ══════════════════════════════════════════════════════════ */
  if (!hasPrdContent) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 relative bg-white">
        {/* Generating overlay */}
        {sending && (
          <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center z-10">
            <div className="flex gap-1.5 mb-4">
              <span className="w-3 h-3 bg-brand-500 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-3 h-3 bg-brand-500 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-3 h-3 bg-brand-500 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
            <p className="text-lg font-medium text-gray-700">
              Generating your PRD...
            </p>
            <p className="text-sm text-gray-500 mt-1">
              This may take a moment while the AI crafts your product
              requirements
            </p>
          </div>
        )}

        {/* Branding / Sparkle */}
        <div className="mb-8 text-center">
          <SparklesIcon className="w-10 h-10 text-brand-500 mx-auto mb-4" />
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">
            What do you want to build?
          </h1>
          <p className="text-gray-500 mt-2 max-w-md mx-auto">
            Describe your app idea and AI will generate a comprehensive product
            requirements document for you.
          </p>
        </div>

        {/* Big textarea with typewriter placeholder */}
        <div className="w-full max-w-2xl">
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={initialInput}
              onChange={(e) => setInitialInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleInitialSubmit();
                }
              }}
              disabled={sending}
              rows={4}
              className="w-full rounded-2xl border-0 py-5 px-6 text-lg text-gray-900 shadow-lg ring-1 ring-inset ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-brand-500 resize-none transition-shadow hover:shadow-xl disabled:opacity-60"
            />
            {/* Submit button inside textarea */}
            <button
              type="button"
              onClick={handleInitialSubmit}
              disabled={sending || !initialInput.trim()}
              className="absolute bottom-4 right-4 w-10 h-10 rounded-full bg-brand-600 text-white flex items-center justify-center hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-md"
              title="Dream it"
            >
              <SendIcon className="w-4 h-4" />
            </button>
          </div>

          {/* Actions row */}
          <div className="flex items-center justify-between mt-4">
            {/* Upload button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              className="flex items-center gap-2 text-sm text-gray-500 hover:text-brand-600 transition-colors disabled:opacity-40"
            >
              <UploadIcon className="w-4 h-4" />
              <span>Upload existing PRD</span>
              <span className="text-xs text-gray-400">
                (.md, .docx, .pdf)
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              onChange={handleFileUpload}
              className="hidden"
            />

            {/* Keyboard hint */}
            <span className="text-xs text-gray-400">
              Press{" "}
              <kbd className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-mono text-[10px]">
                Enter
              </kbd>{" "}
              to submit
            </span>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mt-6 w-full max-w-2xl p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
            <button
              type="button"
              onClick={() => dispatch(setDesignError(null))}
              className="ml-2 text-red-500 hover:text-red-700 underline"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════
   *  RENDER: PRD Document View (PRD exists)
   * ══════════════════════════════════════════════════════════ */
  return (
    <div className="h-full overflow-y-auto relative bg-white">
      {/* ── Document area ── */}
      <div
        ref={prdContainerRef}
        className="max-w-4xl mx-auto px-6 py-8 pb-24"
      >
        {/* Header toolbar */}
        <div className="flex items-center justify-between mb-8 sticky top-0 bg-white/90 backdrop-blur-sm py-3 -mx-6 px-6 z-20 border-b border-transparent">
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
            Product Requirements Document
          </h1>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handlePlanIt}
              disabled={planningIt}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {planningIt ? "Planning..." : "Plan it"}
            </button>
          </div>
        </div>

        {/* PRD Sections */}
        <div className="space-y-8">
          {getOrderedSections(prdContent).map((sectionKey) => (
            <div
              key={sectionKey}
              data-prd-section={sectionKey}
              className="group relative"
            >
              {/* Section header */}
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-800">
                  {formatSectionKey(sectionKey)}
                </h2>
                {editingSection !== sectionKey && (
                  <button
                    type="button"
                    onClick={() => handleStartEdit(sectionKey)}
                    className="opacity-0 group-hover:opacity-100 text-xs text-brand-600 hover:text-brand-700 font-medium transition-opacity"
                  >
                    Edit
                  </button>
                )}
              </div>

              {/* Section content */}
              {editingSection === sectionKey ? (
                <div className="space-y-3">
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    className="w-full min-h-[160px] p-4 text-sm border border-gray-300 rounded-lg font-mono focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                    placeholder="Markdown content..."
                    disabled={!!savingSection}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleSaveEdit}
                      disabled={
                        savingSection === sectionKey ||
                        editDraft === (prdContent[sectionKey] ?? "")
                      }
                      className="btn-primary text-sm py-1.5 px-3 disabled:opacity-50"
                    >
                      {savingSection === sectionKey ? "Saving..." : "Save"}
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
                <div className="prose prose-gray max-w-none prose-headings:text-gray-800 prose-p:text-gray-700 prose-li:text-gray-700 prose-td:text-gray-700 prose-th:text-gray-700 prose-a:text-brand-600 selection:bg-brand-100">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {prdContent[sectionKey] || "_No content yet_"}
                  </ReactMarkdown>
                </div>
              )}

              {/* Divider */}
              <div className="mt-8 border-b border-gray-100" />
            </div>
          ))}
        </div>

        {/* Change History */}
        <div className="mt-10 pt-6 border-t border-gray-200">
          <button
            type="button"
            onClick={() => setHistoryExpanded(!historyExpanded)}
            className="flex items-center justify-between w-full text-left text-sm font-medium text-gray-600 hover:text-gray-900"
          >
            <span>Change history</span>
            <span className="text-gray-400 text-xs">
              {prdHistory.length}{" "}
              {prdHistory.length === 1 ? "entry" : "entries"}
              <span className="ml-1">{historyExpanded ? "▲" : "▼"}</span>
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
                    className="text-xs bg-gray-50 rounded border border-gray-200 p-2"
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
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getPrdSourceColor(entry.source)}`}
                      >
                        {entry.source}
                      </span>
                      <span className="text-gray-500">v{entry.version}</span>
                      <span className="text-gray-400 truncate">
                        {entry.diff}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Selection toolbar (floating near selected text) ── */}
      {selection && (
        <div
          data-selection-toolbar
          className="fixed z-50 animate-fade-in"
          style={{
            top: selection.rect.top - 44,
            left:
              selection.rect.left + selection.rect.width / 2 - 56,
          }}
        >
          <button
            type="button"
            onClick={handleDiscuss}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-900 text-white text-xs font-medium rounded-lg shadow-lg hover:bg-gray-800 transition-colors"
          >
            <CommentIcon className="w-3.5 h-3.5" />
            Discuss
          </button>
        </div>
      )}

      {/* ── Chat bubble & panel (bottom-right) ── */}
      {!chatOpen ? (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-brand-600 text-white shadow-lg hover:bg-brand-700 hover:shadow-xl transition-all flex items-center justify-center z-40 group"
          title="Chat with AI"
        >
          <ChatIcon className="w-6 h-6 group-hover:scale-110 transition-transform" />
          {messages.length > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {messages.filter((m) => m.role === "assistant").length}
            </span>
          )}
        </button>
      ) : (
        <div className="fixed bottom-6 right-6 w-96 h-[520px] bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col z-40 overflow-hidden animate-slide-up-fade">
          {/* Chat header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50/80 shrink-0">
            <div className="flex items-center gap-2">
              <SparklesIcon className="w-4 h-4 text-brand-500" />
              <span className="text-sm font-semibold text-gray-800">
                Chat with AI
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setChatOpen(false);
                setSelectionContext(null);
              }}
              className="w-7 h-7 rounded-full hover:bg-gray-200 flex items-center justify-center transition-colors"
            >
              <CloseIcon className="w-4 h-4 text-gray-500" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center py-8 text-gray-400 text-sm">
                <ChatIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p>Ask questions or refine your PRD</p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-brand-600 text-white"
                      : "bg-gray-100 text-gray-800"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="bg-gray-100 rounded-2xl px-3.5 py-2.5 text-sm text-gray-400">
                  <span className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                  </span>
                </div>
              </div>
            )}
            <div ref={chatMessagesEndRef} />
          </div>

          {/* Selection context indicator */}
          {selectionContext && (
            <div className="mx-3 mb-1 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg text-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-brand-700">
                  Discussing: {formatSectionKey(selectionContext.section)}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectionContext(null)}
                  className="text-brand-400 hover:text-brand-600"
                >
                  <CloseIcon className="w-3 h-3" />
                </button>
              </div>
              <p className="text-brand-600 line-clamp-2 italic">
                &ldquo;{selectionContext.text}&rdquo;
              </p>
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="mx-3 mb-1 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              {error}
              <button
                type="button"
                onClick={() => dispatch(setDesignError(null))}
                className="ml-1 underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Input */}
          <div className="p-3 border-t border-gray-100 shrink-0">
            <div className="flex gap-2">
              <input
                ref={chatInputRef}
                type="text"
                className="flex-1 rounded-xl border-0 py-2.5 px-3.5 text-sm text-gray-900 shadow-sm ring-1 ring-inset ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-brand-500"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleChatSend();
                  }
                }}
                placeholder={
                  selectionContext
                    ? "Comment on this selection..."
                    : "Ask about your PRD..."
                }
                disabled={sending}
              />
              <button
                type="button"
                onClick={handleChatSend}
                disabled={sending || !chatInput.trim()}
                className="w-9 h-9 rounded-xl bg-brand-600 text-white flex items-center justify-center hover:bg-brand-700 disabled:opacity-40 transition-colors shrink-0"
              >
                <SendIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
