import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && el.offsetParent !== null
  );
}

interface ModalSession {
  container: HTMLElement;
}
const modalSessions: ModalSession[] = [];
let focusRevision = 0;

export interface UseModalA11yOptions {
  /** Ref to the modal container (the element with role="dialog") */
  containerRef: RefObject<HTMLElement | null>;
  /** Called when Escape is pressed */
  onClose: () => void;
  /** Optional ref to the element that opened the modal; focus returns here on close */
  triggerRef?: RefObject<HTMLElement | null>;
  /** When set, this element receives initial focus instead of the first focusable in DOM order */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Whether the modal is open (enables/disables the hook) */
  isOpen?: boolean;
}

/**
 * Provides keyboard accessibility for modal dialogs:
 * - Escape closes the modal
 * - Focus is trapped inside the modal (Tab cycles within)
 * - Focus returns to the trigger element on close
 */
export function useModalA11y({
  containerRef,
  onClose,
  triggerRef,
  initialFocusRef,
  isOpen = true,
}: UseModalA11yOptions): void {
  const onCloseRef = useRef(onClose);
  const openingFocusRef = useRef<HTMLElement | null>(null);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen || !containerRef.current) return;

    const container = containerRef.current;

    // Store the element that had focus when the modal opened (for fallback restore)
    const focused = document.activeElement as HTMLElement | null;
    // StrictMode repeats setup while focus is already inside this dialog.
    // Keep the external opening focus from the first setup in that case.
    if (!focused || !container.contains(focused)) openingFocusRef.current = focused;
    const previouslyFocused = openingFocusRef.current;
    const triggerElement = triggerRef?.current;
    const session = { container };
    // Children can register before parents on a shared mount. Keep the nested
    // dialog above its ancestor even in that effect order.
    const descendantIndex = modalSessions.findIndex((entry) => container.contains(entry.container));
    if (descendantIndex < 0) modalSessions.push(session);
    else modalSessions.splice(descendantIndex, 0, session);
    focusRevision++;

    const focusable = getFocusableElements(container);
    const initial = initialFocusRef?.current;
    if (modalSessions.at(-1) !== session) {
      // An already registered child owns focus.
    } else if (initial && container.contains(initial) && !initial.hasAttribute("disabled")) {
      initial.focus();
    } else if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      container.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (modalSessions.at(-1) !== session || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }

      if (e.key !== "Tab") return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }

      const focusedIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (focusedIndex === -1) {
        e.preventDefault();
        focusable[e.shiftKey ? focusable.length - 1 : 0].focus();
        return;
      }

      if (e.shiftKey) {
        // Tab backward
        if (focusedIndex === 0) {
          e.preventDefault();
          focusable[focusable.length - 1].focus();
        }
      } else {
        // Tab forward
        if (focusedIndex === focusable.length - 1) {
          e.preventDefault();
          focusable[0].focus();
        }
      }
    };

    // Trap Tab before focus can leave, but let inner dismissible surfaces (such
    // as a focused tooltip) consume Escape before it reaches the dialog.
    const handleCaptureKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") handleKeyDown(event);
    };
    const handleBubbleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleKeyDown(event);
    };
    document.addEventListener("keydown", handleCaptureKeyDown, true);
    document.addEventListener("keydown", handleBubbleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleCaptureKeyDown, true);
      document.removeEventListener("keydown", handleBubbleKeyDown);
      const wasTopmost = modalSessions.at(-1) === session;
      const index = modalSessions.indexOf(session);
      if (index >= 0) modalSessions.splice(index, 1);
      const revision = ++focusRevision;
      if (!wasTopmost) return;
      // A newly opened dialog (or StrictMode remount) supersedes this restore.
      requestAnimationFrame(() => {
        if (revision !== focusRevision) return;
        const parent = modalSessions.at(-1)?.container;
        const target = triggerElement ?? previouslyFocused;
        if (target?.isConnected && (!parent || parent.contains(target))) {
          target.focus();
        } else if (parent?.isConnected) {
          (getFocusableElements(parent)[0] ?? parent).focus();
        }
      });
    };
  }, [isOpen, containerRef, triggerRef, initialFocusRef]);
}
