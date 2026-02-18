import { useState, useRef, useEffect } from "react";
import { ChatIcon, ChevronLeftIcon, ChevronRightIcon, SendIcon, SparklesIcon } from "../icons/PrdIcons";
import { CloseButton } from "../CloseButton";
import { formatSectionKey } from "../../lib/formatting";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface SelectionContext {
  text: string;
  section: string;
}

export interface PrdChatPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: ChatMessage[];
  sending: boolean;
  /** @deprecated Use global notification bar instead */
  error?: string | null;
  /** @deprecated Use global notification bar instead */
  onDismissError?: () => void;
  selectionContext: SelectionContext | null;
  onClearSelectionContext: () => void;
  onSend: (message: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** "floating" = overlay panel with toggle button; "inline" = always-visible sidebar in split-pane */
  variant?: "floating" | "inline";
  /** When inline: whether sidebar is collapsed (narrow bar only). Ignored for floating. */
  collapsed?: boolean;
  /** When inline: called when user toggles collapse. Ignored for floating. */
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function PrdChatPanel({
  open,
  onOpenChange,
  messages,
  sending,
  selectionContext,
  onClearSelectionContext,
  onSend,
  inputRef: externalInputRef,
  variant = "floating",
  collapsed = false,
  onCollapsedChange,
}: PrdChatPanelProps) {
  const [chatInput, setChatInput] = useState("");
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalInputRef;
  const isInline = variant === "inline";
  const isCollapsed = isInline && collapsed;

  useEffect(() => {
    chatMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  const handleSend = () => {
    const text = chatInput.trim();
    if (!text || sending) return;
    setChatInput("");
    onSend(text);
  };

  // In inline mode: single container with smooth width transition when opening/closing
  if (isInline) {
    const inlineContainerClass = `flex flex-col h-full min-h-0 border-l border-theme-border bg-theme-bg shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
      isCollapsed ? "w-12 min-w-[48px] items-center justify-start pt-3" : "w-[380px] min-w-[320px]"
    }`;
    return (
      <div className={inlineContainerClass} data-testid="prd-chat-sidebar">
        {isCollapsed ? (
          <button
            type="button"
            onClick={() => onCollapsedChange?.(false)}
            className="flex flex-col items-center gap-1 p-2 shrink-0 text-theme-muted hover:text-brand-600 dark:hover:text-brand-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            title="Expand Discuss"
            aria-label="Expand Discuss sidebar"
          >
            <ChatIcon className="w-5 h-5" />
            <ChevronLeftIcon className="w-4 h-4" />
          </button>
        ) : (
          <>
            {/* Chat header — sticky so toggle stays pinned to top when container scrolls */}
            <div
              className="flex items-center justify-between px-4 py-3 border-b border-theme-border bg-theme-bg shrink-0 sticky top-0 z-10"
              data-testid="prd-chat-header"
            >
              <div className="flex items-center gap-2">
                <SparklesIcon className="w-4 h-4 text-brand-500" />
                <span className="text-sm font-semibold text-theme-text">Discuss</span>
              </div>
              {onCollapsedChange && (
                <button
                  type="button"
                  onClick={() => onCollapsedChange(true)}
                  className="p-1.5 rounded-full hover:bg-theme-border-subtle text-theme-muted hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                  title="Collapse Discuss"
                  aria-label="Collapse Discuss sidebar"
                >
                  <ChevronRightIcon className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 && (
                <div className="text-center py-8 text-theme-muted text-sm">
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
                        : "bg-theme-border-subtle text-theme-text"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="bg-theme-border-subtle rounded-2xl px-3.5 py-2.5 text-sm text-theme-muted">
                    <span className="flex gap-1">
                      <span className="w-1.5 h-1.5 bg-theme-muted rounded-full animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 bg-theme-muted rounded-full animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 bg-theme-muted rounded-full animate-bounce [animation-delay:300ms]" />
                    </span>
                  </div>
                </div>
              )}
              <div ref={chatMessagesEndRef} />
            </div>

            {/* Selection context indicator */}
            {selectionContext && (
              <div className="mx-3 mb-1 px-3 py-2 bg-brand-50 dark:bg-brand-900/30 border border-brand-200 dark:border-brand-700 rounded-lg text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-brand-700 dark:text-brand-400">
                    Discussing: {formatSectionKey(selectionContext.section)}
                  </span>
                  <CloseButton
                    onClick={onClearSelectionContext}
                    ariaLabel="Clear selection"
                    className="p-0.5 text-brand-500 dark:text-brand-400 hover:text-brand-600 dark:hover:text-brand-300 hover:bg-transparent"
                    size="w-3 h-3"
                  />
                </div>
                <p className="text-brand-600 dark:text-brand-400 line-clamp-2 italic">
                  &ldquo;{selectionContext.text}&rdquo;
                </p>
              </div>
            )}

            {/* Input */}
            <div className="p-3 border-t border-theme-border shrink-0">
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  className="flex-1 rounded-xl border-0 py-2.5 px-3.5 text-sm text-theme-input-text bg-theme-input-bg shadow-sm ring-1 ring-inset ring-theme-ring placeholder:text-theme-input-placeholder focus:ring-2 focus:ring-inset focus:ring-brand-500"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
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
                  onClick={handleSend}
                  disabled={sending || !chatInput.trim()}
                  className="w-9 h-9 rounded-xl bg-brand-600 text-white flex items-center justify-center hover:bg-brand-700 disabled:opacity-40 transition-colors shrink-0"
                >
                  <SendIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // In floating mode when closed: show toggle button
  if (!open && !isInline) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-brand-600 text-white shadow-lg hover:bg-brand-700 hover:shadow-xl transition-all flex items-center justify-center z-40 group"
        title="Chat with AI"
      >
        <ChatIcon className="w-6 h-6 group-hover:scale-110 transition-transform" />
        {messages.filter((m) => m.role === "assistant").length > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {messages.filter((m) => m.role === "assistant").length}
          </span>
        )}
      </button>
    );
  }

  // Floating mode: open panel
  const containerClass =
    "fixed bottom-6 right-6 w-96 h-[520px] bg-theme-surface rounded-2xl shadow-2xl border border-theme-border flex flex-col z-40 overflow-hidden animate-slide-up-fade";

  return (
    <div className={containerClass}>
      {/* Chat header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border bg-theme-surface shrink-0">
        <div className="flex items-center gap-2">
          <SparklesIcon className="w-4 h-4 text-brand-500" />
          <span className="text-sm font-semibold text-theme-text">Chat with AI</span>
        </div>
        <CloseButton
          onClick={() => {
            onOpenChange(false);
            onClearSelectionContext();
          }}
          ariaLabel="Close chat panel"
          className="p-1.5 rounded-full hover:bg-theme-border-subtle text-theme-muted hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          size="w-4 h-4"
        />
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center py-8 text-theme-muted text-sm">
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
                  : "bg-theme-border-subtle text-theme-text"
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-theme-border-subtle rounded-2xl px-3.5 py-2.5 text-sm text-theme-muted">
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-theme-muted rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-theme-muted rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-theme-muted rounded-full animate-bounce [animation-delay:300ms]" />
              </span>
            </div>
          </div>
        )}
        <div ref={chatMessagesEndRef} />
      </div>

      {/* Selection context indicator */}
      {selectionContext && (
        <div className="mx-3 mb-1 px-3 py-2 bg-brand-50 dark:bg-brand-900/30 border border-brand-200 dark:border-brand-700 rounded-lg text-xs">
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-brand-700 dark:text-brand-400">
              Discussing: {formatSectionKey(selectionContext.section)}
            </span>
            <CloseButton
              onClick={onClearSelectionContext}
              ariaLabel="Clear selection"
              className="p-0.5 text-brand-500 dark:text-brand-400 hover:text-brand-600 dark:hover:text-brand-300 hover:bg-transparent"
              size="w-3 h-3"
            />
          </div>
          <p className="text-brand-600 dark:text-brand-400 line-clamp-2 italic">
            &ldquo;{selectionContext.text}&rdquo;
          </p>
        </div>
      )}

      {/* Input */}
      <div className="p-3 border-t border-theme-border shrink-0">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            className="flex-1 rounded-xl border-0 py-2.5 px-3.5 text-sm text-theme-input-text bg-theme-input-bg shadow-sm ring-1 ring-inset ring-theme-ring placeholder:text-theme-input-placeholder focus:ring-2 focus:ring-inset focus:ring-brand-500"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
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
            onClick={handleSend}
            disabled={sending || !chatInput.trim()}
            className="w-9 h-9 rounded-xl bg-brand-600 text-white flex items-center justify-center hover:bg-brand-700 disabled:opacity-40 transition-colors shrink-0"
          >
            <SendIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
