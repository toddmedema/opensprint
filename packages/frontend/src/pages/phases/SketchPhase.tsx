import React, { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  sendSketchMessage,
  savePrdSection,
  uploadPrdFile,
  addUserMessage,
  setPrdContent,
  setPrdHistory,
  setMessages,
  setSketchError,
} from "../../store/slices/sketchSlice";
import { usePrd, usePrdHistory, useSketchChat, usePlanStatus, useDecomposePlans, usePlans } from "../../api/hooks";
import { usePhaseLoadingState } from "../../hooks/usePhaseLoadingState";
import { PhaseLoadingSpinner } from "../../components/PhaseLoadingSpinner";
import { queryKeys } from "../../api/queryKeys";
import {
  PrdViewer,
  PrdChatPanel,
  PrdTocPanel,
  PrdUploadButton,
  PrdChangeLog,
} from "../../components/prd";
import { ResizableSidebar } from "../../components/layout/ResizableSidebar";
import { useSubmitShortcut } from "../../hooks/useSubmitShortcut";
import { useImageAttachment } from "../../hooks/useImageAttachment";
import { useScrollToQuestion } from "../../hooks/useScrollToQuestion";
import { useOpenQuestionNotifications } from "../../hooks/useOpenQuestionNotifications";
import { HilApprovalBlock } from "../../components/HilApprovalBlock";
import { ImageAttachmentThumbnails, ImageAttachmentButton } from "../../components/ImageAttachment";
import { SparklesIcon, CommentIcon } from "../../components/icons/PrdIcons";
import { api } from "../../api/client";
import { isApiError } from "../../api/client";

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
const SKETCH_TOC_SIDEBAR_STORAGE_KEY = "opensprint-sketch-toc-sidebar-collapsed";

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

function loadSketchTocSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = localStorage.getItem(SKETCH_TOC_SIDEBAR_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // ignore
  }
  return false;
}

function saveSketchTocSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SKETCH_TOC_SIDEBAR_STORAGE_KEY, String(collapsed));
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
  const queryClient = useQueryClient();

  /* ── TanStack Query (server state) ── */
  const { data: prdData, isLoading: prdLoading } = usePrd(projectId);
  const { data: prdHistoryData } = usePrdHistory(projectId);
  const { data: chatMessagesData } = useSketchChat(projectId);
  const hasPrdContentFromQuery = Object.values(prdData ?? {}).some(
    (c) => String(c ?? "").trim().length > 0
  );
  const { data: planStatus } = usePlanStatus(projectId, { enabled: hasPrdContentFromQuery });
  const decomposeMutation = useDecomposePlans(projectId ?? "");
  const refetchPlans = usePlans(projectId);

  /* ── Sync query data to Redux for components that read from store ── */
  useEffect(() => {
    if (prdData) dispatch(setPrdContent(prdData));
  }, [prdData, dispatch]);
  useEffect(() => {
    if (prdHistoryData) dispatch(setPrdHistory(prdHistoryData));
  }, [prdHistoryData, dispatch]);
  useEffect(() => {
    if (chatMessagesData) dispatch(setMessages(chatMessagesData));
  }, [chatMessagesData, dispatch]);

  /* ── Redux state (client + synced server state) ── */
  const messages = useAppSelector((s) => s.sketch.messages);
  const prdContent = useAppSelector((s) => s.sketch.prdContent);
  const prdHistory = useAppSelector((s) => s.sketch.prdHistory);
  const sending = useAppSelector((s) => s.sketch.sendingChat);
  const sketchError = useAppSelector((s) => s.sketch.error);
  const savingSections = useAppSelector((s) => s.sketch.savingSections);
  const decomposing = decomposeMutation.isPending;

  /* ── Local UI state (preserved by mount-all) ── */
  const [initialInput, setInitialInput] = useState("");
  const imageAttachment = useImageAttachment();
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [selectionContext, setSelectionContext] = useState<{
    text: string;
    section: string;
  } | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [planningIt, setPlanningIt] = useState(false);
  const [discussCollapsed, setDiscussCollapsedState] = useState(loadSketchChatSidebarCollapsed);
  const [tocCollapsed, setTocCollapsedState] = useState(loadSketchTocSidebarCollapsed);
  const [sketchContext, setSketchContext] = useState<{ hasExistingCode: boolean } | null>(null);
  const [generatingFromCodebase, setGeneratingFromCodebase] = useState(false);

  const setDiscussCollapsed = useCallback((collapsed: boolean) => {
    setDiscussCollapsedState(collapsed);
    saveSketchChatSidebarCollapsed(collapsed);
  }, []);

  const setTocCollapsed = useCallback((collapsed: boolean) => {
    setTocCollapsedState(collapsed);
    saveSketchTocSidebarCollapsed(collapsed);
  }, []);

  useScrollToQuestion();
  const { notifications: openQuestionNotifications, refetch: refetchNotifications } =
    useOpenQuestionNotifications(projectId);
  const architectureHilNotification = React.useMemo(
    () =>
      openQuestionNotifications.find(
        (n) => n.source === "prd" && n.sourceId === "architecture" && n.kind === "hil_approval"
      ),
    [openQuestionNotifications]
  );
  const questionIdBySection = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const n of openQuestionNotifications) {
      if (n.source === "prd" && n.sourceId) {
        map[n.sourceId] = n.id;
      }
    }
    return map;
  }, [openQuestionNotifications]);

  /* ── Refs ── */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prdContainerRef = useRef<HTMLDivElement>(null);
  const prdScrollContainerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Derived ── */
  // Show empty-state prompt when no section has substantive content (new projects get SPEC.md with all sections empty)
  const hasPrdContent = Object.values(prdContent).some((c) => String(c ?? "").trim().length > 0);
  const prdEmpty = !Object.values(prdData ?? {}).some((c) => String(c ?? "").trim().length > 0);
  const { showSpinner: showPrdSpinner, showEmptyState: showPrdEmptyState } = usePhaseLoadingState(
    prdLoading,
    prdEmpty
  );

  /* ── Fetch sketch-context when in empty state (for "Generate from codebase" visibility) ── */
  useEffect(() => {
    if (!hasPrdContent && projectId) {
      api.projects
        .getSketchContext(projectId)
        .then((data) => setSketchContext({ hasExistingCode: data.hasExistingCode }))
        .catch(() => setSketchContext({ hasExistingCode: false }));
    } else {
      setSketchContext(null);
    }
  }, [projectId, hasPrdContent]);

  /* ── Debounced refresh cascade (3 s after last section save, or immediate on blur) ── */
  const REFRESH_DEBOUNCE_MS = 3000;

  const triggerRefreshCascade = useCallback(() => {
    if (!projectId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.prd.detail(projectId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.prd.history(projectId) });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.chat.history(projectId, "sketch"),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.plans.status(projectId) });
  }, [projectId, queryClient]);

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

      const target = e.target as Element;
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
    const text = initialInput.trim();
    if (text.length < 10 || sending) return;
    setInitialInput("");

    dispatch(
      addUserMessage({
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      })
    );

    const images = imageAttachment.images.length > 0 ? imageAttachment.images : undefined;
    const result = await dispatch(sendSketchMessage({ projectId, message: text, images }));
    if (sendSketchMessage.fulfilled.match(result)) {
      imageAttachment.reset();
      triggerRefreshCascade();
    }
  }, [initialInput, sending, projectId, dispatch, imageAttachment, triggerRefreshCascade]);

  const onKeyDownInitial = useSubmitShortcut(handleInitialSubmit, {
    multiline: true,
    disabled: sending || initialInput.trim().length < 10,
  });

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
        triggerRefreshCascade();
      }
    },
    [projectId, dispatch, triggerRefreshCascade]
  );

  const handleGenerateFromCodebase = useCallback(async () => {
    if (generatingFromCodebase || sending) return;
    setGeneratingFromCodebase(true);
    dispatch(setSketchError(null));
    try {
      await api.prd.generateFromCodebase(projectId);
      triggerRefreshCascade();
    } catch (err) {
      const message = isApiError(err) ? err.message : String(err);
      dispatch(setSketchError(message));
    } finally {
      setGeneratingFromCodebase(false);
    }
  }, [projectId, generatingFromCodebase, sending, dispatch, triggerRefreshCascade]);

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
        sendSketchMessage({ projectId, message: fullMessage, prdSectionFocus: prdFocus })
      );
      if (sendSketchMessage.fulfilled.match(result)) {
        triggerRefreshCascade();
      }
    },
    [selectionContext, projectId, dispatch, triggerRefreshCascade]
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
    try {
      await decomposeMutation.mutateAsync();
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.plans.status(projectId) });
        await refetchPlans.refetch();
      }
      onNavigateToPlan?.();
    } finally {
      setPlanningIt(false);
    }
  };

  /* ══════════════════════════════════════════════════════════
   *  RENDER: Loading spinner during fetch
   * ══════════════════════════════════════════════════════════ */
  if (showPrdSpinner) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center bg-theme-bg" data-testid="sketch-phase-loading">
        <PhaseLoadingSpinner data-testid="sketch-phase-loading-spinner" aria-label="Loading" />
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════
   *  RENDER: Initial Prompt View (No PRD yet)
   * ══════════════════════════════════════════════════════════ */
  const showGeneratingOverlay = sending || generatingFromCodebase;

  if (showPrdEmptyState) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 relative bg-theme-bg">
        {/* Generating overlay */}
        {showGeneratingOverlay && (
          <div className="absolute inset-0 bg-theme-bg/90 backdrop-blur-sm flex flex-col items-center justify-center z-10">
            <div className="flex gap-1.5 mb-4">
              <span className="w-3 h-3 bg-brand-500 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-3 h-3 bg-brand-500 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-3 h-3 bg-brand-500 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
            <p className="text-lg font-medium text-theme-text">
              {generatingFromCodebase
                ? "Analyzing codebase and generating PRD..."
                : "Generating your PRD..."}
            </p>
            <p className="text-sm text-theme-muted mt-1">
              {generatingFromCodebase
                ? "The AI is scanning your repo and drafting a product requirements document."
                : "This may take a moment while the AI crafts your product requirements"}
            </p>
          </div>
        )}

        {/* Agent/API error — e.g. credit balance, connection failed */}
        {sketchError && (
          <div
            className="w-full max-w-2xl mb-4 rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 flex items-start gap-3"
            role="alert"
          >
            <p className="text-sm text-red-600 dark:text-red-400 flex-1 whitespace-pre-wrap">
              {sketchError}
            </p>
            <button
              type="button"
              onClick={() => dispatch(setSketchError(null))}
              className="shrink-0 text-red-600 dark:text-red-400 hover:underline text-sm font-medium"
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
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

        {/* Big textarea with typewriter placeholder and image attachment */}
        <div className="w-full max-w-2xl">
          <div
            className="relative"
            onDragOver={imageAttachment.handleDragOver}
            onDrop={imageAttachment.handleDrop}
          >
            <ImageAttachmentThumbnails attachment={imageAttachment} className="mb-3" />
            <textarea
              ref={textareaRef}
              value={initialInput}
              onChange={(e) => setInitialInput(e.target.value)}
              onKeyDown={onKeyDownInitial}
              onPaste={imageAttachment.handlePaste}
              disabled={sending}
              rows={4}
              className="w-full rounded-2xl border-0 py-5 px-6 text-lg text-theme-input-text bg-theme-input-bg shadow-lg ring-1 ring-inset ring-theme-ring placeholder:text-theme-input-placeholder focus:ring-2 focus:ring-inset focus:ring-brand-500 resize-none transition-shadow hover:shadow-xl disabled:opacity-60"
            />
            <div className="absolute bottom-4 right-4 flex items-center gap-2">
              <ImageAttachmentButton
                attachment={imageAttachment}
                disabled={sending}
                data-testid="sketch-attach-images"
              />
              <button
                type="button"
                onClick={handleInitialSubmit}
                disabled={sending || initialInput.trim().length < 10}
                className="h-10 px-4 rounded-full bg-brand-600 text-white flex items-center justify-center gap-2 hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-md text-sm font-medium"
                title="Sketch it"
                aria-label="Sketch it"
                data-testid="sketch-it-button"
              >
                {sending ? (
                  <>
                    <div
                      className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"
                      data-testid="sketch-it-spinner"
                      aria-hidden
                    />
                    <span>Sketch it</span>
                  </>
                ) : (
                  <span>Sketch it</span>
                )}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 mt-4">
            <PrdUploadButton onUpload={handleFileUpload} disabled={sending} />
            {sketchContext?.hasExistingCode && (
              <button
                type="button"
                onClick={handleGenerateFromCodebase}
                disabled={showGeneratingOverlay}
                className="ml-auto text-sm text-theme-muted hover:text-brand-600 dark:hover:text-brand-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="generate-from-codebase"
              >
                Generate from codebase
              </button>
            )}
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
      {/* Left: Table of contents (collapsible, resizable when expanded) */}
      {tocCollapsed ? (
        <PrdTocPanel
          prdContent={prdContent}
          scrollContainerRef={prdScrollContainerRef}
          collapsed={true}
          onCollapsedChange={setTocCollapsed}
        />
      ) : (
        <ResizableSidebar
          storageKey="sketch-toc"
          defaultWidth={220}
          minWidth={160}
          side="left"
          resizeHandleLabel="Resize table of contents"
          noBorder
        >
          <PrdTocPanel
            prdContent={prdContent}
            scrollContainerRef={prdScrollContainerRef}
            collapsed={false}
            onCollapsedChange={setTocCollapsed}
            resizable
          />
        </ResizableSidebar>
      )}

      {/* Center: live PRD document */}
      <div ref={prdScrollContainerRef} className="flex-1 min-w-0 overflow-y-auto">
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

          {architectureHilNotification && (
            <div className="mb-4">
              <HilApprovalBlock
                notification={architectureHilNotification}
                projectId={projectId}
                onResolved={refetchNotifications}
              />
            </div>
          )}
          <PrdViewer
            prdContent={prdContent}
            savingSections={savingSections}
            onSectionChange={handleSectionChange}
            containerRef={prdContainerRef}
            questionIdBySection={questionIdBySection}
          />

          <PrdChangeLog
            entries={prdHistory}
            expanded={historyExpanded}
            onToggle={() => setHistoryExpanded(!historyExpanded)}
          />
        </div>
      </div>

      {/* Right pane: Discuss sidebar (collapsible, resizable when expanded) */}
      {discussCollapsed ? (
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
          collapsed={true}
          onCollapsedChange={setDiscussCollapsed}
        />
      ) : (
        <ResizableSidebar
          storageKey="sketch"
          defaultWidth={380}
          resizeHandleLabel="Resize Discuss sidebar"
        >
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
            collapsed={false}
            onCollapsedChange={setDiscussCollapsed}
            resizable
          />
        </ResizableSidebar>
      )}

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
            className="flex items-center gap-1.5 px-3 py-2 bg-theme-surface text-theme-text text-xs font-medium rounded-lg shadow-lg ring-1 ring-theme-border hover:bg-theme-bg-elevated transition-colors"
          >
            <CommentIcon className="w-3.5 h-3.5" />
            Discuss
          </button>
        </div>
      )}
    </div>
  );
}
