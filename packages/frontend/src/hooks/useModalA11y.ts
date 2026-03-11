import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && el.offsetParent !== null
  );
}

export interface UseModalA11yOptions {
  /** Ref to the modal container (the element with role="dialog") */
  containerRef: RefObject<HTMLElement | null>;
  /** Called when Escape is pressed */
  onClose: () => void;
  /** Optional ref to the element that opened the modal; focus returns here on close */
  triggerRef?: RefObject<HTMLElement | null>;
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
  isOpen = true,
}: UseModalA11yOptions): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen || !containerRef.current) return;

    const container = containerRef.current;

    // Store the element that had focus when the modal opened (for fallback restore)
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    // Focus first focusable element inside the modal
    const focusable = getFocusableElements(container);
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      container.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key !== "Tab") return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) return;

      const focusedIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (focusedIndex === -1) return;

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

    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);

      // Restore focus to trigger or previously focused element
      requestAnimationFrame(() => {
        const target = triggerRef?.current ?? previouslyFocusedRef.current;
        if (target && typeof target.focus === "function") {
          target.focus();
        }
      });
    };
  }, [isOpen, onClose, containerRef, triggerRef]);
}
