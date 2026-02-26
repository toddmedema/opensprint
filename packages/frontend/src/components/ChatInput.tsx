import { useRef, useLayoutEffect } from "react";
import { useSubmitShortcut } from "../hooks/useSubmitShortcut";
import { SendIcon } from "./icons/PrdIcons";

const LINE_HEIGHT = 24;
const MAX_LINES = 5;
const MAX_HEIGHT = LINE_HEIGHT * MAX_LINES;

const INPUT_CLASS =
  "flex-1 rounded-xl border-0 py-2.5 px-3.5 text-sm text-theme-input-text bg-theme-input-bg shadow-sm ring-1 ring-inset ring-theme-ring placeholder:text-theme-input-placeholder focus:ring-2 focus:ring-inset focus:ring-brand-500 resize-none overflow-y-auto min-h-[2.5rem]";

const SEND_BUTTON_CLASS =
  "w-9 min-w-9 h-[2.5rem] rounded-xl bg-brand-600 text-white flex items-center justify-center hover:bg-brand-700 disabled:opacity-40 transition-colors shrink-0";

export interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** When true, disables the send button (e.g. while sending). Input stays enabled so user can compose next message. */
  sendDisabled?: boolean;
  /** Tooltip shown when send button is disabled due to sendDisabled (e.g. "Waiting on Dreamer to finish current response"). */
  sendDisabledTooltip?: string;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  "aria-label"?: string;
  /** Optional className for the send button (e.g. btn-primary for Plan phase styling) */
  sendButtonClassName?: string;
}

/**
 * Shared multi-line chat input: textarea + submit button.
 * - Shift+Enter inserts newline; Enter submits.
 * - Auto-expands up to 5 lines in height.
 */
export function ChatInput({
  value,
  onChange,
  onSend,
  sendDisabled = false,
  sendDisabledTooltip,
  placeholder,
  inputRef: externalInputRef,
  "aria-label": ariaLabel = "Chat message",
  sendButtonClassName = SEND_BUTTON_CLASS,
}: ChatInputProps) {
  const internalInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = externalInputRef ?? internalInputRef;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0";
    const h = Math.max(LINE_HEIGHT, Math.min(el.scrollHeight, MAX_HEIGHT));
    el.style.height = `${h}px`;
  }, [value, inputRef]);

  const onKeyDown = useSubmitShortcut(onSend, {
    multiline: true,
    disabled: !value.trim() || sendDisabled,
  });

  return (
    <div className="flex gap-2 items-end">
      <textarea
        ref={inputRef}
        rows={1}
        className={INPUT_CLASS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      <button
        type="button"
        onClick={onSend}
        disabled={sendDisabled || !value.trim()}
        aria-label="Send"
        title={sendDisabled && sendDisabledTooltip ? sendDisabledTooltip : undefined}
        className={sendButtonClassName}
      >
        <SendIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
