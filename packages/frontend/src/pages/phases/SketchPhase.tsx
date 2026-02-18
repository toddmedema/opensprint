import React, { useState, useEffect, useRef, useCallback } from "react";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  sendSpecMessage,
  savePrdSection,
  uploadPrdFile,
  addUserMessage,
  fetchPrd,
  fetchPrdHistory,
  fetchSpecChat,
} from "../../store/slices/specSlice";
import { decomposePlans, fetchPlanStatus } from "../../store/slices/planSlice";
import { PrdViewer, PrdChatPanel, PrdUploadButton, PrdChangeLog } from "../../components/prd";
import { SendIcon, SparklesIcon, CommentIcon } from "../../components/icons/PrdIcons";

/* ── Types ──────────────────────────────────────────────── */

interface SketchPhaseProps {
  projectId: string;
  onNavigateToPlan?: () => void;
}

interface SelectionInfo {
  text: string;
  sectionKey: string;
  rect: DOMRect;
}

/* ── Constants ──────────────────────────────────────────────── */

const SKETCH_CHAT_SIDEBAR_STORAGE_KEY = "opensprint-sketch-chat-sidebar-collapsed";

function loadSketchChatSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = localStorage.getItem(SKETCH_CHAT_SIDEBAR_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // ignore
  }
  return false;
}

function saveSketchChatSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SKETCH_CHAT_SIDEBAR_STORAGE_KEY, String(collapsed));
  } catch {
    // ignore
  }
}

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

/* ── Helpers ────────────────────────────────────────────── */

function findParentSection(node: Node): string | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
  while (el) {
    if (el.dataset.prdSection) return el.dataset.prdSection;
    el = el.parentElement;
  }
  return null;
}

/* ── Main Component ─────────────────────────────────────── */

export function SketchPhase({ projectId, onNavigateToPlan }: SketchPhaseProps) {
  const dispatch = useAppDispatch();

  /* ── Redux state ── */
  const messages = useAppSelector((s) => s.spec.messages);
  const prdContent = useAppSelector((s) => s.spec.prdContent);
  const prdHistory = useAppSelector((s) => s.spec.prdHistory);
  const sending = useAppSelector((s) => s.spec.sendingChat);
  const savingSections = useAppSelector((s) => s.spec.savingSections);
  const planStatus = useAppSelector((s) => s.plan.planStatus);
  const decomposing = useAppSelector((s) => s.plan.decomposing);

  /* ── Local UI state (preserved by mount-all) ── */
  const [initialInput, setInitialInput] = useState("");
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [selectionContext, setSelectionContext] = useState<{
    text: string;
    section: string;
  } | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [planningIt, setPlanningIt] = useState(false);
  const [discussCollapsed, setDiscussCollapsedState] = useState(loadSketchChatSidebarCollapsed);

  const setDiscussCollapsed = useCallback((collapsed: boolean) => {
    setDiscussCollapsedState(collapsed);
    saveSketchChatSidebarCollapsed(collapsed);
  }, []);

  /* ── Refs ── */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prdContainerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Derived ── */
  const hasPrdContent = Object.keys(prdContent).length > 0;

  /* ── Fetch plan-status on Sketch load and after PRD saves (PRD §7.1.5) ── */
  useEffect(() => {
    if (!hasPrdContent) return;
    void dispatch(fetchPlanStatus(projectId));
  }, [projectId, hasPrdContent, dispatch]);

  /* ── Debounced refresh cascade (3 s after last section save, or immediate on blur) ── */
  const REFRESH_DEBOUNCE_MS = 3000;

  const triggerRefreshCascade = useCallback(() => {
    dispatch(fetchPrd(projectId));
    dispatch(fetchPrdHistory(projectId));
    dispatch(fetchSpecChat(projectId));
    dispatch(fetchPlanStatus(projectId));
  }, [projectId, dispatch]);

  const scheduleRefreshCascade = useCallback(() => {
    if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
    refreshDebounceRef.current = setTimeout(() => {
      refreshDebounceRef.current = null;
      triggerRefreshCascade();
    }, REFRESH_DEBOUNCE_MS);
  }, [triggerRefreshCascade]);

  // Flush pending cascade immediately when focus leaves the PRD editor
  useEffect(() => {
    const container = prdContainerRef.current;
    if (!container || !hasPrdContent) return;

    const handleFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget && container.contains(e.relatedTarget as Node)) return;
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
        refreshDebounceRef.current = null;
        triggerRefreshCascade();
      }
    };

    container.addEventListener("focusout", handleFocusOut);
    return () => container.removeEventListener("focusout", handleFocusOut);
  }, [hasPrdContent, triggerRefreshCascade]);

  // Clean up refresh timer on unmount
  useEffect(() => {
    return () => {
      if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
    };
  }, []);

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

  /* ── Dismiss Discuss popover on click/touch outside popover and selection ── */
  const selectionRef = useRef<SelectionInfo | null>(null);
  selectionRef.current = selection;

  useEffect(() => {
    if (!hasPrdContent || !selection) return;

    const handlePointerDown = (e: PointerEvent) => {
      const current = selectionRef.current;
      if (!current) return;

      const target = e.target as Node;
      if (target.closest("[data-selection-toolbar]")) return;

      const { clientX, clientY } = e;
      const { rect } = current;
      const inSelection =
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom;
      if (inSelection) return;

      setSelection(null);
      window.getSelection()?.removeAllRanges();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [hasPrdContent, selection]);

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
      })
    );

    const result = await dispatch(sendSpecMessage({ projectId, message: text }));
    if (sendSpecMessage.fulfilled.match(result) && result.payload.prdChanges?.length) {
      dispatch(fetchPrd(projectId));
      dispatch(fetchPrdHistory(projectId));
      dispatch(fetchPlanStatus(projectId));
    }
  }, [initialInput, sending, projectId, dispatch]);

  const handleFileUpload = useCallback(
    async (file: File) => {
      dispatch(
        addUserMessage({
          role: "user",
          content: `[Uploaded: ${file.name}]`,
          timestamp: new Date().toISOString(),
        })
      );

      const result = await dispatch(uploadPrdFile({ projectId, file }));
      if (uploadPrdFile.fulfilled.match(result)) {
        dispatch(fetchPrd(projectId));
        dispatch(fetchPrdHistory(projectId));
        dispatch(fetchSpecChat(projectId));
        dispatch(fetchPlanStatus(projectId));
      }
    },
    [projectId, dispatch]
  );

  const handleChatSend = useCallback(
    async (text: string) => {
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
        })
      );

      const result = await dispatch(
        sendSpecMessage({ projectId, message: fullMessage, prdSectionFocus: prdFocus })
      );
      if (sendSpecMessage.fulfilled.match(result) && result.payload.prdChanges?.length) {
        dispatch(fetchPrd(projectId));
        dispatch(fetchPrdHistory(projectId));
        dispatch(fetchPlanStatus(projectId));
      }
    },
    [selectionContext, projectId, dispatch]
  );

  const handleDiscuss = () => {
    if (!selection) return;
    // Auto-open sidebar if collapsed so user sees the Discuss flow
    const wasCollapsed = discussCollapsed;
    if (wasCollapsed) {
      setDiscussCollapsed(false);
    }
    setSelectionContext({
      text: selection.text,
      section: selection.sectionKey,
    });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    // Delay focus to allow sidebar expansion (200ms transition); when expanding from
    // collapsed, the input is not in DOM until the next render
    const focusDelay = wasCollapsed ? 250 : 50;
    setTimeout(() => chatInputRef.current?.focus(), focusDelay);
  };

  const handleSectionChange = useCallback(
    async (section: string, content: string) => {
      if (savingSections.includes(section)) return;
      const result = await dispatch(savePrdSection({ projectId, section, content }));
      if (savePrdSection.fulfilled.match(result)) {
        scheduleRefreshCascade();
      }
    },
    [projectId, savingSections, dispatch, scheduleRefreshCascade]
  );

  const handlePlanIt = async () => {
    setPlanningIt(true);
    const result = await dispatch(decomposePlans(projectId));
    setPlanningIt(false);
    if (decomposePlans.fulfilled.match(result)) {
      dispatch(fetchPlanStatus(projectId));
      onNavigateToPlan?.();
    }
  };

  /* ══════════════════════════════════════════════════════════
   *  RENDER: Initial Prompt View (No PRD yet)
   * ══════════════════════════════════════════════════════════ */
  if (!hasPrdContent) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 relative bg-theme-bg">
        {/* Generating overlay */}
        {sending && (
          <div className="absolute inset-0 bg-theme-bg/90 backdrop-blur-sm flex flex-col items-center justify-center z-10">
            <div className="flex gap-1.5 mb-4">
              <span className="w-3 h-3 bg-brand-500 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-3 h-3 bg-brand-500 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-3 h-3 bg-brand-500 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
            <p className="text-lg font-medium text-theme-text">Generating your PRD...</p>
            <p className="text-sm text-theme-muted mt-1">
              This may take a moment while the AI crafts your product requirements
            </p>
          </div>
        )}

        {/* Branding / Sparkle */}
        <div className="mb-8 text-center">
          <SparklesIcon className="w-10 h-10 text-brand-500 mx-auto mb-4" />
          <h1 className="text-3xl font-bold text-theme-text tracking-tight">
            What do you want to build?
          </h1>
          <p className="text-theme-muted mt-2 max-w-md mx-auto">
            Describe your app idea and AI will generate a comprehensive product requirements
            document for you.
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
              className="w-full rounded-2xl border-0 py-5 px-6 text-lg text-theme-input-text bg-theme-input-bg shadow-lg ring-1 ring-inset ring-theme-ring placeholder:text-theme-input-placeholder focus:ring-2 focus:ring-inset focus:ring-brand-500 resize-none transition-shadow hover:shadow-xl disabled:opacity-60"
            />
            <button
              type="button"
              onClick={handleInitialSubmit}
              disabled={sending || !initialInput.trim()}
              className="absolute bottom-4 right-4 w-10 h-10 rounded-full bg-brand-600 text-white flex items-center justify-center hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-md"
              title="Sketch it"
              aria-label="Sketch it"
            >
              <SendIcon className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center justify-between mt-4">
            <PrdUploadButton onUpload={handleFileUpload} disabled={sending} />
            <span className="text-xs text-theme-muted">
              Press{" "}
              <kbd className="px-1.5 py-0.5 rounded bg-theme-border-subtle text-theme-muted font-mono text-[10px]">
                Enter
              </kbd>{" "}
              to submit
            </span>
          </div>
        </div>

      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════
   *  RENDER: Split-pane (PRD exists) — left: PRD, right: chat (light mode theme)
   * ══════════════════════════════════════════════════════════ */
  return (
    <div className="h-full flex overflow-hidden bg-theme-bg">
      {/* Left pane: live PRD document */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-8 pb-24">
          <div className="flex items-center justify-between mb-8 sticky top-0 bg-theme-bg/95 backdrop-blur-sm py-3 -mx-6 px-6 z-20 border-b border-theme-border">
            <h1 className="text-2xl font-bold text-theme-text tracking-tight">
              Product Requirements Document
            </h1>
            <div className="flex items-center gap-3">
              {planStatus?.action === "plan" && (
                <button
                  type="button"
                  onClick={handlePlanIt}
                  disabled={planningIt || decomposing}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {planningIt || decomposing ? "Planning..." : "Plan it"}
                </button>
              )}
              {planStatus?.action === "replan" && (
                <button
                  type="button"
                  onClick={handlePlanIt}
                  disabled={planningIt || decomposing}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {planningIt || decomposing ? "Replanning..." : "Replan it"}
                </button>
              )}
              {planStatus?.action === "none" && null}
            </div>
          </div>

          <PrdViewer
            prdContent={prdContent}
            savingSections={savingSections}
            onSectionChange={handleSectionChange}
            containerRef={prdContainerRef}
          />

          <PrdChangeLog
            entries={prdHistory}
            expanded={historyExpanded}
            onToggle={() => setHistoryExpanded(!historyExpanded)}
          />
        </div>
      </div>

      {/* Right pane: Discuss sidebar (collapsible) */}
      <PrdChatPanel
        open={true}
        onOpenChange={() => {}}
        messages={messages}
        sending={sending}
        selectionContext={selectionContext}
        onClearSelectionContext={() => setSelectionContext(null)}
        onSend={handleChatSend}
        inputRef={chatInputRef}
        variant="inline"
        collapsed={discussCollapsed}
        onCollapsedChange={setDiscussCollapsed}
      />

      {selection && (
        <div
          data-selection-toolbar
          data-testid="discuss-popover"
          className="fixed z-50 animate-fade-in"
          style={{
            top: selection.rect.top - 44,
            left: selection.rect.left + selection.rect.width / 2 - 56,
          }}
        >
          <button
            type="button"
            onClick={handleDiscuss}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 text-white text-xs font-medium rounded-lg shadow-lg hover:bg-gray-700 transition-colors"
          >
            <CommentIcon className="w-3.5 h-3.5" />
            Discuss
          </button>
        </div>
      )}
    </div>
  );
}
