import { useState, useRef, useEffect } from "react";
import { ChatIcon, SendIcon, SparklesIcon } from "../icons/PrdIcons";
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
  error: string | null;
  onDismissError: () => void;
  selectionContext: SelectionContext | null;
  onClearSelectionContext: () => void;
  onSend: (message: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** "floating" = overlay panel with toggle button; "inline" = always-visible sidebar in split-pane */
  variant?: "floating" | "inline";
}

export function PrdChatPanel({
  open,
  onOpenChange,
  messages,
  sending,
  error,
  onDismissError,
  selectionContext,
  onClearSelectionContext,
  onSend,
  inputRef: externalInputRef,
  variant = "floating",
}: PrdChatPanelProps) {
  const [chatInput, setChatInput] = useState("");
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalInputRef;
  const isInline = variant === "inline";

  useEffect(() => {
    chatMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  const handleSend = () => {
    const text = chatInput.trim();
    if (!text || sending) return;
    setChatInput("");
    onSend(text);
  };

  // In inline mode, always show chat; in floating mode, show toggle when closed
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

  const containerClass = isInline
    ? "flex flex-col h-full w-[380px] min-w-[320px] border-r border-gray-200 bg-gray-50/50 shrink-0 overflow-hidden"
    : "fixed bottom-6 right-6 w-96 h-[520px] bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col z-40 overflow-hidden animate-slide-up-fade";

  return (
    <div className={containerClass} data-testid={isInline ? "prd-chat-sidebar" : undefined}>
      {/* Chat header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50/80 shrink-0">
        <div className="flex items-center gap-2">
          <SparklesIcon className="w-4 h-4 text-brand-500" />
          <span className="text-sm font-semibold text-gray-800">Chat with AI</span>
        </div>
        {!isInline && (
          <CloseButton
            onClick={() => {
              onOpenChange(false);
              onClearSelectionContext();
            }}
            ariaLabel="Close chat panel"
            className="p-1.5 rounded-full hover:bg-gray-200 text-gray-500 hover:text-gray-700 transition-colors"
            size="w-4 h-4"
          />
        )}
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
            <CloseButton
              onClick={onClearSelectionContext}
              ariaLabel="Clear selection"
              className="p-0.5 text-brand-400 hover:text-brand-600 hover:bg-transparent"
              size="w-3 h-3"
            />
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
          <button type="button" onClick={onDismissError} className="ml-1 underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Input */}
      <div className="p-3 border-t border-gray-100 shrink-0">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            className="flex-1 rounded-xl border-0 py-2.5 px-3.5 text-sm text-gray-900 shadow-sm ring-1 ring-inset ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-brand-500"
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
