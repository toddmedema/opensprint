import { useCallback, useLayoutEffect, useRef, useState } from "react";

interface ScrollAnchor {
  id: string | undefined;
  offset: number;
  top: number;
  height: number;
}

function captureAnchor(element: HTMLElement): ScrollAnchor {
  const viewport = element.getBoundingClientRect();
  const first = [...element.querySelectorAll<HTMLElement>("[data-conversation-entry]")].find(
    (row) => row.getBoundingClientRect().bottom > viewport.top
  );
  return {
    id: first?.dataset.conversationEntry,
    offset: first ? first.getBoundingClientRect().top - viewport.top : 0,
    top: element.scrollTop,
    height: element.scrollHeight,
  };
}

/** Follow live discussion without moving a reader who is inspecting earlier messages. */
export function useConversationScroll({
  scope,
  visible,
  ready,
  contentKey,
}: {
  scope: string;
  visible: boolean;
  ready: boolean;
  contentKey: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const initialized = useRef(false);
  const previousScope = useRef(scope);
  const readingAnchor = useRef<ScrollAnchor | null>(null);
  const lastPosition = useRef(0);
  const wasVisible = useRef(false);
  const scheduledJump = useRef<number | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const bottom = (element: HTMLElement) => Math.max(0, element.scrollHeight - element.clientHeight);

  const jumpToLatest = useCallback(() => {
    pinned.current = true;
    readingAnchor.current = null;
    setShowJumpToLatest(false);
    if (scheduledJump.current !== null) cancelAnimationFrame(scheduledJump.current);
    const targetScope = previousScope.current;
    scheduledJump.current = requestAnimationFrame(() => {
      scheduledJump.current = null;
      const element = containerRef.current;
      if (previousScope.current !== targetScope || !element || element.clientHeight === 0) return;
      element.scrollTop = bottom(element);
      lastPosition.current = element.scrollTop;
    });
  }, []);

  const handleScroll = useCallback(() => {
    const element = containerRef.current;
    // Switching to Work can reset the browser's numeric scroll position. Keep the last
    // visible row until Discussion is laid out again.
    if (!element || element.clientHeight === 0) return;
    lastPosition.current = element.scrollTop;
    pinned.current = bottom(element) - element.scrollTop <= 50;
    readingAnchor.current = pinned.current ? null : captureAnchor(element);
    setShowJumpToLatest(!pinned.current && element.scrollHeight > element.clientHeight);
  }, []);

  /** Capture the reading position before older rows are revealed or another page is fetched. */
  const beforeHistoryChange = useCallback(() => {
    const element = containerRef.current;
    if (!element || element.clientHeight === 0) return;
    readingAnchor.current = captureAnchor(element);
    pinned.current = false;
    setShowJumpToLatest(element.scrollHeight > element.clientHeight);
  }, []);

  useLayoutEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope;
      initialized.current = false;
      pinned.current = true;
      readingAnchor.current = null;
      lastPosition.current = 0;
      if (scheduledJump.current !== null) {
        cancelAnimationFrame(scheduledJump.current);
        scheduledJump.current = null;
      }
    }
    const returning = visible && !wasVisible.current;
    wasVisible.current = visible;
    const element = containerRef.current;
    if (!visible || !ready || !element || element.clientHeight === 0) return;
    const anchor = readingAnchor.current;
    if (!initialized.current) {
      element.scrollTop = bottom(element);
      initialized.current = true;
    } else if (anchor) {
      const row = [...element.querySelectorAll<HTMLElement>("[data-conversation-entry]")].find(
        (candidate) => candidate.dataset.conversationEntry === anchor.id
      );
      element.scrollTop = row
        ? element.scrollTop +
          row.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          anchor.offset
        : Math.max(0, anchor.top + element.scrollHeight - anchor.height);
    } else if (pinned.current) {
      element.scrollTop = bottom(element);
    } else if (returning) {
      element.scrollTop = lastPosition.current;
    }
    lastPosition.current = element.scrollTop;
    // Refresh rather than consume the anchor: live updates may trim retained
    // rows or arrive before an in-flight history page inserts its earlier rows.
    readingAnchor.current = pinned.current ? null : captureAnchor(element);
    setShowJumpToLatest(!pinned.current && element.scrollHeight > element.clientHeight);
  }, [scope, visible, ready, contentKey]);

  useLayoutEffect(
    () => () => {
      if (scheduledJump.current !== null) cancelAnimationFrame(scheduledJump.current);
    },
    []
  );

  return { containerRef, handleScroll, beforeHistoryChange, showJumpToLatest, jumpToLatest };
}
