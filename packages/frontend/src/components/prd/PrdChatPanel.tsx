import { useState, useRef, useLayoutEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AGENT_ROLE_LABELS, type AgentRole } from "@opensprint/shared";
import { ChatInput } from "../ChatInput";
import {
  ChatIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SparklesIcon,
} from "../icons/PrdIcons";
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
  selectionContext: SelectionContext | null;
  onClearSelectionContext: () => void;
  onSend: (message: string) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** "floating" = overlay panel with toggle button; "inline" = always-visible sidebar in split-pane */
  variant?: "floating" | "inline";
  /** When inline: whether sidebar is collapsed (narrow bar only). Ignored for floating. */
  collapsed?: boolean;
  /** When inline: called when user toggles collapse. Ignored for floating. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** When inline and expanded: parent controls width (e.g. ResizableSidebar). Uses w-full instead of fixed width. */
  resizable?: boolean;
  /** Agent role for phase-specific context (e.g. Sketch = Dreamer). Defaults to dreamer. */
  agentRole?: AgentRole;
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
          isUser ? "bg-brand-600 text-white" : "bg-theme-border-subtle text-theme-text"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{msg.content}</p>
        ) : (
          <div className="prose-chat-bubble">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
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
  resizable = false,
  agentRole = "dreamer",
}: PrdChatPanelProps) {
  const [chatInput, setChatInput] = useState("");
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const internalInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = externalInputRef ?? internalInputRef;
  const isInline = variant === "inline";
  const isCollapsed = isInline && collapsed;
  const agentLabel = AGENT_ROLE_LABELS[agentRole];

  const scrollToBottom = useCallback(() => {
    const scrollEl = scrollContainerRef.current ?? chatMessagesEndRef.current?.parentElement;
    if (scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
    }
  }, []);

  useLayoutEffect(() => {
    scrollToBottom();
    // Run again on next frame in case layout wasn't complete (e.g. parent ResizableSidebar)
    const id = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(id);
  }, [messages, open, collapsed, scrollToBottom]);

  // ResizeObserver: scroll to bottom when scroll container gets real dimensions on mount
  // (handles delayed layout when nested in ResizableSidebar)
  useLayoutEffect(() => {
    const el = scrollContainerRef.current ?? chatMessagesEndRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => scrollToBottom());
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom, isCollapsed]);

  const handleSend = () => {
    const text = chatInput.trim();
    if (!text || sending) return;
    setChatInput("");
    onSend(text);
  };

  // In inline mode: single container with smooth width transition when opening/closing
  if (isInline) {
    const widthClass = isCollapsed
      ? "w-12 min-w-[48px] items-center justify-start pt-3"
      : resizable
        ? "w-full min-w-0"
        : "w-[380px] min-w-[320px]";
    const borderClass = resizable && !isCollapsed ? "" : "border-l border-theme-border";
    const inlineContainerClass = `flex flex-col h-full min-h-0 bg-theme-bg shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${borderClass} ${widthClass}`;
    return (
      <div className={inlineContainerClass} data-testid="prd-chat-sidebar">
        {isCollapsed ? (
          <button
            type="button"
            onClick={() => onCollapsedChange?.(false)}
            className="flex flex-col items-center gap-1 p-2 shrink-0 text-theme-muted hover:text-brand-600 dark:hover:text-brand-400 hover:bg-theme-border-subtle rounded-lg transition-colors"
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
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <SparklesIcon className="w-4 h-4 text-brand-500 shrink-0" />
                <span className="text-sm font-semibold text-theme-text">
                  Chatting with {agentLabel}
                </span>
              </div>
              {onCollapsedChange && (
                <button
                  type="button"
                  onClick={() => onCollapsedChange(true)}
                  className="p-1.5 rounded-full hover:bg-theme-border-subtle text-theme-muted hover:text-theme-text transition-colors"
                  title="Collapse Discuss"
                  aria-label="Collapse Discuss sidebar"
                >
                  <ChevronRightIcon className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Messages */}
            <div
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto p-4 space-y-3"
              data-testid="prd-chat-messages"
            >
              {messages.length === 0 && (
                <div className="text-center py-8 text-theme-muted text-sm">
                  <ChatIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p>Ask questions or refine your PRD</p>
                </div>
              )}
              {messages.map((msg, i) => (
                <ChatBubble key={i} msg={msg} />
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
              <ChatInput
                value={chatInput}
                onChange={setChatInput}
                onSend={handleSend}
                sendDisabled={sending}
                sendDisabledTooltip={
                  sending ? `Waiting on ${agentLabel} to finish current response` : undefined
                }
                placeholder={
                  selectionContext ? "Comment on this selection..." : "Ask about your PRD..."
                }
                inputRef={inputRef}
                aria-label="Discuss message"
              />
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
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-theme-error-solid text-white text-[10px] font-bold rounded-full flex items-center justify-center">
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
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-theme-border bg-theme-surface shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <SparklesIcon className="w-4 h-4 text-brand-500 shrink-0" />
          <span className="text-sm font-semibold text-theme-text">
            Chatting with {agentLabel}
          </span>
        </div>
        <CloseButton
          onClick={() => {
            onOpenChange(false);
            onClearSelectionContext();
          }}
          ariaLabel="Close chat panel"
          className="p-1.5 rounded-full hover:bg-theme-border-subtle text-theme-muted hover:text-theme-text transition-colors"
          size="w-4 h-4"
        />
      </div>

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto p-4 space-y-3"
        data-testid="prd-chat-messages"
      >
        {messages.length === 0 && (
          <div className="text-center py-8 text-theme-muted text-sm">
            <ChatIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p>Ask questions or refine your PRD</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatBubble key={i} msg={msg} />
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
        <ChatInput
          value={chatInput}
          onChange={setChatInput}
          onSend={handleSend}
          sendDisabled={sending}
          sendDisabledTooltip={
            sending ? `Waiting on ${agentLabel} to finish current response` : undefined
          }
          placeholder={
            selectionContext ? "Comment on this selection..." : "Ask about your PRD..."
          }
          inputRef={inputRef}
          aria-label="Chat message"
        />
      </div>
    </div>
  );
}
