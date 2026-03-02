import { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect, memo } from "react";
import { useNavigate } from "react-router-dom";
import type { FeedbackItem, Notification } from "@opensprint/shared";
import { PRIORITY_LABELS } from "@opensprint/shared";
import {
  loadFeedbackFormDraft,
  saveFeedbackFormDraft,
  clearFeedbackFormDraft,
} from "../../lib/feedbackFormStorage";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch, useAppSelector } from "../../store";
import {
  submitFeedback,
  resolveFeedback,
  cancelFeedback,
  removeFeedbackItem,
  recategorizeFeedback,
} from "../../store/slices/evalSlice";
import { selectTasks } from "../../store/slices/executeSlice";
import { useTasks, useFeedback } from "../../api/hooks";
import { usePhaseLoadingState } from "../../hooks/usePhaseLoadingState";
import { PhaseLoadingSpinner } from "../../components/PhaseLoadingSpinner";
import { queryKeys } from "../../api/queryKeys";
import { FeedbackTaskChip } from "../../components/FeedbackTaskChip";
import { KeyboardShortcutTooltip } from "../../components/KeyboardShortcutTooltip";
import { PriorityIcon } from "../../components/PriorityIcon";
import { ImageAttachmentThumbnails, ImageAttachmentButton } from "../../components/ImageAttachment";
import { ImageDropZone } from "../../components/ImageDropZone";
import { useImageAttachment } from "../../hooks/useImageAttachment";
import { useImageDragOverPage } from "../../hooks/useImageDragOverPage";
import { useSubmitShortcut } from "../../hooks/useSubmitShortcut";
import { useScrollToQuestion } from "../../hooks/useScrollToQuestion";
import { useOpenQuestionNotifications } from "../../hooks/useOpenQuestionNotifications";
import { api } from "../../api/client";
import { CONTENT_CONTAINER_CLASS } from "../../lib/constants";
import { getProjectPhasePath } from "../../lib/phaseRouting";
import { formatPlanIdAsTitle } from "../../lib/formatting";
import { HilApprovalBlock } from "../../components/HilApprovalBlock";

/** Reply icon (message turn / corner up-right) */
function ReplyIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}

export const FEEDBACK_COLLAPSED_KEY_PREFIX = "opensprint-eval-feedback-collapsed";
export const EVALUATE_FEEDBACK_FILTER_KEY = "opensprint.evaluateFeedbackFilter";

/** Debounce before showing loading spinner or empty state (avoids flicker on fast responses) */
export const FEEDBACK_LOADING_DEBOUNCE_MS = 300;

function getFeedbackCollapsedKey(projectId: string): string {
  return `${FEEDBACK_COLLAPSED_KEY_PREFIX}-${projectId}`;
}

function loadFeedbackCollapsedIds(projectId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const stored = localStorage.getItem(getFeedbackCollapsedKey(projectId));
    if (!stored) return new Set();
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function saveFeedbackCollapsedIds(projectId: string, ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getFeedbackCollapsedKey(projectId), JSON.stringify([...ids]));
  } catch {
    // ignore
  }
}

interface EvalPhaseProps {
  projectId: string;
  onNavigateToBuildTask?: (taskId: string) => void;
  /** Feedback ID from URL (e.g. ?feedback=fsi69v) for scroll-to when navigating from Analyst dropdown */
  feedbackIdFromUrl?: string | null;
}

export type FeedbackStatusFilter = "all" | "pending" | "resolved" | "cancelled";

function matchesStatusFilter(item: FeedbackItem, filter: FeedbackStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "pending") return item.status === "pending";
  if (filter === "resolved") return item.status === "resolved";
  if (filter === "cancelled") return item.status === "cancelled";
  return true;
}

function countByStatus(feedback: FeedbackItem[], filter: FeedbackStatusFilter): number {
  return feedback.filter((item) => matchesStatusFilter(item, filter)).length;
}

const VALID_FILTER_VALUES: FeedbackStatusFilter[] = ["all", "pending", "resolved", "cancelled"];

/** Stable empty object for tasksById fallback (avoids selector returning new ref each render) */
const EMPTY_TASKS_BY_ID: Record<string, never> = {};

function loadFeedbackStatusFilter(): FeedbackStatusFilter {
  if (typeof window === "undefined") return "pending";
  try {
    const stored = localStorage.getItem(EVALUATE_FEEDBACK_FILTER_KEY);
    if (!stored) return "pending";
    if (VALID_FILTER_VALUES.includes(stored as FeedbackStatusFilter)) {
      return stored as FeedbackStatusFilter;
    }
  } catch {
    // ignore
  }
  return "pending";
}

function saveFeedbackStatusFilter(value: FeedbackStatusFilter): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(EVALUATE_FEEDBACK_FILTER_KEY, value);
  } catch {
    // ignore
  }
}

const categoryColors: Record<string, string> = {
  bug: "bg-theme-feedback-bug-bg text-theme-feedback-bug-text",
  feature: "bg-theme-feedback-feature-bg text-theme-feedback-feature-text",
  ux: "bg-theme-feedback-ux-bg text-theme-feedback-ux-text",
  scope: "bg-theme-feedback-scope-bg text-theme-feedback-scope-text",
};

/** True when feedback is awaiting AI categorization (no mapping result yet). */
function isCategorizing(item: FeedbackItem): boolean {
  if (item.status !== "pending") return false;
  return (
    item.mappedPlanId == null &&
    (item.createdTaskIds?.length ?? 0) === 0 &&
    (item.taskTitles?.length ?? 0) === 0 &&
    (item.proposedTasks?.length ?? 0) === 0
  );
}

/** Display label for feedback type chip (Bug/Feature/UX/Scope). */
function getFeedbackTypeLabel(item: FeedbackItem): string {
  return item.category === "ux"
    ? "UX"
    : item.category.charAt(0).toUpperCase() + item.category.slice(1);
}

/** Tree node for feedback display (parent + children) */
interface FeedbackTreeNode {
  item: FeedbackItem;
  children: FeedbackTreeNode[];
}

/** Compare nodes for memo — only re-render when this node or any descendant's item changed */
function areFeedbackNodesEqual(a: FeedbackTreeNode, b: FeedbackTreeNode): boolean {
  if (a.item !== b.item) return false;
  if (a.children.length !== b.children.length) return false;
  return a.children.every((c, i) => areFeedbackNodesEqual(c, b.children[i]));
}

/** Count total replies in a feedback subtree (direct + nested). Works for arbitrary nesting depth. */
function countTotalReplies(node: FeedbackTreeNode): number {
  let count = node.children.length;
  for (const child of node.children) {
    count += countTotalReplies(child);
  }
  return count;
}

/** Build tree from flat feedback list. Top-level first, then children by createdAt desc.
 * Items whose parent is not in the list are shown at top level (e.g. when filtering). */
function buildFeedbackTree(items: FeedbackItem[]): FeedbackTreeNode[] {
  const idSet = new Set(items.map((i) => i.id));
  const byParent = new Map<string | null, FeedbackItem[]>();
  for (const item of items) {
    let pid = item.parent_id ?? null;
    if (pid !== null && !idSet.has(pid)) pid = null;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid)!.push(item);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }
  function build(pid: string | null): FeedbackTreeNode[] {
    const list = byParent.get(pid) ?? [];
    return list.map((item) => ({
      item,
      children: build(item.id),
    }));
  }
  return build(null);
}

/** Task columns that indicate feedback is in progress (agent may be working). */
const IN_PROGRESS_TASK_COLUMNS = ["in_progress", "in_review"] as const;

/** Show Cancel when feedback is in progress: Analyst has created tasks and an agent may be working. */
function canShowCancelButton(
  item: FeedbackItem,
  tasks: Array<{ id: string; kanbanColumn: string }>
): boolean {
  if (item.status !== "pending") return false;
  const taskIds = item.createdTaskIds ?? [];
  if (taskIds.length === 0) return false;
  return taskIds.some((tid) => {
    const t = tasks.find((x) => x.id === tid);
    if (!t) return false;
    return IN_PROGRESS_TASK_COLUMNS.includes(
      t.kanbanColumn as (typeof IN_PROGRESS_TASK_COLUMNS)[number]
    );
  });
}

interface FeedbackCardProps {
  node: FeedbackTreeNode;
  depth: number;
  projectId: string;
  onNavigateToBuildTask?: (taskId: string) => void;
  replyingToId: string | null;
  onStartReply: (id: string) => void;
  onCancelReply: () => void;
  onSubmitReply: (parentId: string, text: string, images?: string[]) => void;
  onResolve: (feedbackId: string) => void;
  onCancel: (feedbackId: string) => void;
  onRemoveAfterAnimation: (feedbackId: string) => void;
  collapsedIds: Set<string>;
  onToggleCollapse: (id: string) => void;
  submitting: boolean;
  isDraggingImage: boolean;
  clearDragState: () => void;
  tasks: Array<{ id: string; kanbanColumn: string }>;
  /** Notification ID for scroll-to-question when this feedback has open questions */
  questionId?: string | null;
  /** Map of feedbackId -> notificationId for nested feedback cards */
  questionIdByFeedbackId?: Record<string, string>;
  /** Open-question notification for this feedback (when Analyst needs clarification) */
  notification?: Notification | null;
  /** Map of feedbackId -> notification for nested cards to look up their notification */
  notificationByFeedbackId?: Record<string, Notification>;
  /** Resolve notification and re-enqueue feedback for Analyst retry with answer */
  onAnswerOpenQuestion?: (feedbackId: string, notificationId: string, answer: string) => void;
  /** Resolve notification without re-enqueueing (dismiss) */
  onDismissOpenQuestion?: (feedbackId: string, notificationId: string) => void;
  /** Whether answer/dismiss is in progress */
  answeringOpenQuestion?: boolean;
  /** Refetch notifications when HIL approval is resolved */
  onHilResolved?: () => void;
}

const FADE_OUT_DURATION_MS = 500;

const FeedbackCard = memo(
  function FeedbackCard({
    node,
    depth,
    projectId,
    onNavigateToBuildTask,
    replyingToId,
    onStartReply,
    onCancelReply,
    onSubmitReply,
    onResolve,
    onCancel,
    onRemoveAfterAnimation,
    collapsedIds,
    onToggleCollapse,
    submitting,
    isDraggingImage,
    clearDragState,
    tasks,
    questionId,
    questionIdByFeedbackId,
    notification,
    notificationByFeedbackId,
    onAnswerOpenQuestion,
    onDismissOpenQuestion,
    answeringOpenQuestion = false,
    onHilResolved,
  }: FeedbackCardProps) {
    const { item, children } = node;
    const navigate = useNavigate();
    const [replyText, setReplyText] = useState("");
    const [answerText, setAnswerText] = useState("");
    const replyImages = useImageAttachment();
    const isReplying = replyingToId === item.id;
    const isCollapsed = collapsedIds.has(item.id);
    const hasChildren = children.length > 0;

    const innerRef = useRef<HTMLDivElement>(null);
    const collapseRef = useRef<HTMLDivElement>(null);
    const [isAnimatingOut, setIsAnimatingOut] = useState(false);
    const [collapseHeight, setCollapseHeight] = useState<number | null>(null);
    const prevStatusRef = useRef(item.status);

    useEffect(() => {
      const justResolved =
        (item.status === "resolved" || item.status === "cancelled") &&
        prevStatusRef.current !== "resolved" &&
        prevStatusRef.current !== "cancelled";
      prevStatusRef.current = item.status;

      if (!justResolved || isAnimatingOut) return;
      setIsAnimatingOut(true);
    }, [item.status, isAnimatingOut]);

    useLayoutEffect(() => {
      if (!isAnimatingOut || collapseRef.current == null) return;
      const el = collapseRef.current;
      const measured = el.scrollHeight;
      setCollapseHeight(measured);
      const id = requestAnimationFrame(() => {
        setCollapseHeight(0);
      });
      return () => cancelAnimationFrame(id);
    }, [isAnimatingOut]);

    const removeRef = useRef<(() => void) | undefined>(undefined);
    removeRef.current = () => onRemoveAfterAnimation(item.id);

    const handleTransitionEnd = useCallback(
      (e: React.TransitionEvent) => {
        if (e.target !== collapseRef.current) return;
        if (e.propertyName === "max-height") {
          removeRef.current?.();
        }
      },
      []
    );

    useEffect(() => {
      if (!isAnimatingOut) return;
      const fallback = setTimeout(() => {
        removeRef.current?.();
      }, FADE_OUT_DURATION_MS + 100);
      return () => clearTimeout(fallback);
    }, [isAnimatingOut]);

    const handleSubmitReply = () => {
      if (!replyText.trim() || submitting) return;
      const imagePayload = replyImages.images.length > 0 ? replyImages.images : undefined;
      onSubmitReply(item.id, replyText.trim(), imagePayload);
      setReplyText("");
      replyImages.reset();
      onCancelReply();
    };

    const onKeyDownReply = useSubmitShortcut(handleSubmitReply, {
      multiline: true,
      disabled: !replyText.trim() || submitting,
    });

    const isResolvedAndAnimating =
      (item.status === "resolved" || item.status === "cancelled") && isAnimatingOut;

    const innerStyle: React.CSSProperties = isResolvedAndAnimating
      ? {
          opacity: 0,
          transition: `opacity ${FADE_OUT_DURATION_MS}ms ease-out`,
        }
      : {};

    const rootStyle: React.CSSProperties =
      collapseHeight !== null
        ? {
            overflow: "hidden",
            maxHeight: collapseHeight,
            marginTop: 0,
            marginBottom: 0,
            transition: `max-height ${FADE_OUT_DURATION_MS}ms ease-out, margin ${FADE_OUT_DURATION_MS}ms ease-out`,
          }
        : {};

    return (
      <div
        ref={collapseRef}
        className={depth > 0 ? "ml-4 mt-2 border-l-2 border-theme-border pl-4" : ""}
        data-feedback-id={item.id}
        {...(questionId && { "data-question-id": questionId })}
        style={rootStyle}
        onTransitionEnd={handleTransitionEnd}
      >
        <div ref={innerRef} style={innerStyle}>
          <div className="card p-4">
          {/* Category badge/spinner floats top-right */}
          <div className="mb-2 overflow-hidden">
            {isCategorizing(item) ? (
              <span
                className="float-right ml-2 mb-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium bg-theme-border-subtle text-theme-muted flex-shrink-0"
                aria-label="Categorizing feedback"
              >
                <div
                  className="h-3 w-3 border-2 border-theme-ring border-t-transparent rounded-full animate-spin"
                  aria-hidden="true"
                />
                Categorizing…
              </span>
            ) : (
              <>
                {(item.status === "resolved" || item.status === "cancelled") && (
                  <span
                    className={`float-right ml-2 mb-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium flex-shrink-0 ${
                      item.status === "cancelled"
                        ? "bg-theme-border-subtle text-theme-muted"
                        : "bg-theme-success-bg text-theme-success-text"
                    }`}
                    aria-label={item.status === "cancelled" ? "Cancelled" : "Resolved"}
                  >
                    {item.status === "cancelled" ? "Cancelled" : "Resolved"}
                  </span>
                )}
                <span
                  className={`float-right ml-2 mb-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium flex-shrink-0 ${
                    categoryColors[item.category] ?? "bg-theme-border-subtle text-theme-muted"
                  }`}
                >
                  {getFeedbackTypeLabel(item)}
                </span>
              </>
            )}
            <p className="text-sm text-theme-text whitespace-pre-wrap break-words min-w-0">
              {item.text ?? "(No feedback text)"}
            </p>
          </div>

          {item.images && item.images.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {item.images.map((dataUrl, i) => (
                <img
                  key={i}
                  src={dataUrl}
                  alt={`Attachment ${i + 1}`}
                  className="h-16 w-16 object-cover rounded border border-theme-border"
                />
              ))}
            </div>
          )}

          {/* HIL approval (scope change) — Approve/Reject via notification system */}
          {notification?.kind === "hil_approval" && (
            <div className="mt-3">
              <HilApprovalBlock
                notification={notification}
                projectId={projectId}
                onResolved={() => onHilResolved?.()}
              />
            </div>
          )}
          {/* Open questions (Analyst needs clarification) — Answer/Dismiss controls */}
          {notification &&
            notification.kind !== "hil_approval" &&
            notification.questions.length > 0 && (
            <div
              className="mt-3 p-3 rounded-lg border border-theme-border bg-theme-border-subtle/30"
              data-testid="feedback-open-questions"
            >
              <p className="text-xs font-medium text-theme-muted mb-2">
                The Analyst needs clarification before categorizing:
              </p>
              <ul className="list-disc list-inside text-sm text-theme-text space-y-1 mb-3">
                {notification.questions.map((q) => (
                  <li key={q.id}>{q.text}</li>
                ))}
              </ul>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[200px]">
                  <textarea
                    className="input text-sm min-h-[60px] w-full"
                    value={answerText}
                    onChange={(e) => setAnswerText(e.target.value)}
                    placeholder="Type your answer..."
                    disabled={answeringOpenQuestion}
                    data-testid="feedback-answer-input"
                  />
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      if (answerText.trim() && onAnswerOpenQuestion) {
                        onAnswerOpenQuestion(item.id, notification.id, answerText.trim());
                        setAnswerText("");
                      }
                    }}
                    disabled={!answerText.trim() || answeringOpenQuestion}
                    className="btn-primary text-sm py-1.5 px-3 disabled:opacity-50"
                    data-testid="feedback-answer-submit"
                  >
                    {answeringOpenQuestion ? "Submitting..." : "Answer"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismissOpenQuestion?.(item.id, notification.id)}
                    disabled={answeringOpenQuestion}
                    className="btn-secondary text-sm py-1.5 px-3 disabled:opacity-50"
                    data-testid="feedback-dismiss-question"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Ticket info on left, action buttons (Reply, Resolve, etc.) on right — same line */}
          <div
            className="mt-1 flex flex-wrap items-center justify-between gap-2"
            data-testid="feedback-card-actions-row"
          >
            {(() => {
              const taskIds = item.createdTaskIds ?? [];
              const isPlanLinked =
                item.mappedPlanId != null && item.mappedPlanId !== "" && taskIds.length === 0;
              if (isPlanLinked) {
                return (
                  <div
                    className="flex gap-1 flex-wrap min-w-0"
                    data-testid="feedback-card-plan-link"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        navigate(getProjectPhasePath(projectId, "plan", { plan: item.mappedPlanId! }))
                      }
                      className="inline-flex items-center gap-1.5 rounded bg-theme-border-subtle px-1.5 py-0.5 text-xs font-mono text-brand-600 hover:bg-theme-info-bg hover:text-theme-info-text underline transition-colors"
                      title={`View plan: ${formatPlanIdAsTitle(item.mappedPlanId!)}`}
                      aria-label={`View plan ${formatPlanIdAsTitle(item.mappedPlanId!)}`}
                    >
                      Plan: {formatPlanIdAsTitle(item.mappedPlanId!)}
                    </button>
                  </div>
                );
              }
              if (taskIds.length > 0) {
                return (
                  <div className="flex gap-1 flex-wrap min-w-0" data-testid="feedback-card-ticket-info">
                    {taskIds.map((taskId) => (
                      <FeedbackTaskChip
                        key={taskId}
                        taskId={taskId}
                        projectId={projectId}
                        onNavigateToBuildTask={onNavigateToBuildTask}
                      />
                    ))}
                  </div>
                );
              }
              return null;
            })()}
            <div className="flex gap-2 flex-shrink-0 ml-auto">
              {hasChildren && (
                <button
                  type="button"
                  onClick={() => onToggleCollapse(item.id)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-theme-muted hover:bg-theme-border-subtle hover:text-theme-text transition-colors"
                  aria-label={isCollapsed ? "Expand replies" : "Collapse replies"}
                  data-testid={`collapse-replies-${item.id}`}
                >
                  {isCollapsed ? "Expand" : "Collapse"} ({countTotalReplies(node)}{" "}
                  {countTotalReplies(node) === 1 ? "reply" : "replies"})
                </button>
              )}
              {item.status === "pending" && !isCategorizing(item) && (
                <>
                  {canShowCancelButton(item, tasks) && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onCancel(item.id);
                      }}
                      className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-theme-muted hover:bg-theme-border-subtle transition-colors"
                      title="Cancel feedback and delete associated tasks"
                      aria-label="Cancel"
                      data-testid="feedback-cancel-button"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onResolve(item.id);
                    }}
                    className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-theme-success-text hover:bg-theme-success-bg transition-colors"
                    title="Mark as resolved"
                    aria-label="Resolve"
                  >
                    Resolve
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => (isReplying ? onCancelReply() : onStartReply(item.id))}
                className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-theme-muted hover:bg-theme-border-subtle hover:text-theme-text transition-colors"
                title="Reply"
                aria-label={isReplying ? "Cancel reply" : "Reply"}
              >
                <ReplyIcon className="w-4 h-4" />
                {isReplying ? "Cancel" : "Reply"}
              </button>
            </div>
          </div>
        </div>
        </div>

        {/* Inline reply composer (PRD §7.4.1: quote snippet of parent above text input) */}
        {isReplying && (
          <ImageDropZone
            variant="reply"
            isDraggingImage={isDraggingImage}
            onDragOver={replyImages.handleDragOver}
            onDrop={async (e) => {
              clearDragState();
              await replyImages.handleDrop(e);
            }}
            className="mt-2 ml-0 card p-3"
            data-testid="reply-drop-zone"
          >
            <blockquote className="mb-2 pl-3 border-l-2 border-theme-border text-sm text-theme-muted italic">
              {item.text && item.text.length > 80
                ? `${item.text.slice(0, 80)}…`
                : item.text || "(No feedback text)"}
            </blockquote>
            <textarea
              className="input min-h-[60px] mb-2 text-sm"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onPaste={replyImages.handlePaste}
              onKeyDown={(e) => {
                onKeyDownReply(e);
                if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelReply();
                }
              }}
              placeholder="Write a reply..."
              disabled={submitting}
              autoFocus
            />
            <ImageAttachmentThumbnails attachment={replyImages} className="mb-2" />
            <div className="flex justify-end items-stretch gap-2 flex-wrap">
              <button type="button" onClick={onCancelReply} className="btn-secondary h-10">
                Cancel
              </button>
              <ImageAttachmentButton
                attachment={replyImages}
                variant="icon"
                disabled={submitting}
                data-testid="reply-attach-images"
              />
              <KeyboardShortcutTooltip>
                <button
                  type="button"
                  onClick={handleSubmitReply}
                  disabled={submitting || !replyText.trim()}
                  className="btn-primary h-10 disabled:opacity-50"
                >
                  {submitting ? "Submitting..." : "Submit"}
                </button>
              </KeyboardShortcutTooltip>
            </div>
          </ImageDropZone>
        )}

        {/* Nested children (hidden when collapsed) */}
        {!isCollapsed &&
          children.map((child) => (
            <FeedbackCard
              key={child.item.id}
              node={child}
              depth={depth + 1}
              projectId={projectId}
              onNavigateToBuildTask={onNavigateToBuildTask}
              replyingToId={replyingToId}
              onStartReply={onStartReply}
              onCancelReply={onCancelReply}
              onSubmitReply={onSubmitReply}
              onResolve={onResolve}
              onCancel={onCancel}
              onRemoveAfterAnimation={onRemoveAfterAnimation}
              collapsedIds={collapsedIds}
              onToggleCollapse={onToggleCollapse}
              submitting={submitting}
              isDraggingImage={isDraggingImage}
              clearDragState={clearDragState}
              tasks={tasks}
              questionId={questionIdByFeedbackId?.[child.item.id]}
              questionIdByFeedbackId={questionIdByFeedbackId}
              notification={notificationByFeedbackId?.[child.item.id]}
              notificationByFeedbackId={notificationByFeedbackId}
              onAnswerOpenQuestion={onAnswerOpenQuestion}
              onDismissOpenQuestion={onDismissOpenQuestion}
              answeringOpenQuestion={answeringOpenQuestion}
              onHilResolved={onHilResolved}
            />
          ))}
      </div>
    );
  },
  (prev, next) => {
    if (!areFeedbackNodesEqual(prev.node, next.node)) return false;
    if (prev.collapsedIds !== next.collapsedIds) return false;
    if (prev.replyingToId !== next.replyingToId) return false;
    if (prev.submitting !== next.submitting) return false;
    if (prev.isDraggingImage !== next.isDraggingImage) return false;
    if (prev.clearDragState !== next.clearDragState) return false;
    if (prev.tasks !== next.tasks) return false;
    if (prev.questionId !== next.questionId) return false;
    if (prev.questionIdByFeedbackId !== next.questionIdByFeedbackId) return false;
    if (prev.notification !== next.notification) return false;
    if (prev.notificationByFeedbackId !== next.notificationByFeedbackId) return false;
    if (prev.answeringOpenQuestion !== next.answeringOpenQuestion) return false;
    if (prev.onHilResolved !== next.onHilResolved) return false;
    return true;
  }
);

export function EvalPhase({
  projectId,
  onNavigateToBuildTask,
  feedbackIdFromUrl: feedbackIdFromUrlProp,
}: EvalPhaseProps) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const { data: tasksList = [] } = useTasks(projectId);
  const feedbackQuery = useFeedback(projectId);

  /* ── Redux state ── */
  const feedback = useAppSelector((s) => s.eval.feedback);
  const tasksById = useAppSelector((s) => s.execute?.tasksById ?? EMPTY_TASKS_BY_ID);
  const tasks = useAppSelector((s) =>
    selectTasks(s).map((t) => ({ id: t.id, kanbanColumn: t.kanbanColumn }))
  );
  const tasksCount = tasks.length;
  const submitting = useAppSelector((s) => s.eval?.async?.submit?.loading ?? false);

  const feedbackEmpty = feedback.length === 0;
  const { showSpinner: showFeedbackSpinner, showEmptyState: showFeedbackEmptyState } = usePhaseLoadingState(
    feedbackQuery.isLoading,
    feedbackEmpty,
    FEEDBACK_LOADING_DEBOUNCE_MS
  );

  /* Fetch missing tasks for feedback cards (createdTaskIds) and merge into query cache so list stays in sync */
  const taskIdsFromFeedback = useMemo(() => {
    const ids = new Set<string>();
    for (const item of feedback) {
      for (const id of item.createdTaskIds ?? []) ids.add(id);
    }
    return ids;
  }, [feedback]);

  useEffect(() => {
    if (!projectId || taskIdsFromFeedback.size === 0) return;
    const listIds = new Set(tasksList.map((t) => t.id));
    const missing = [...taskIdsFromFeedback].filter((id) => !listIds.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const fetched = await Promise.all(
        missing.map((taskId) =>
          queryClient.fetchQuery({
            queryKey: queryKeys.tasks.detail(projectId, taskId),
            queryFn: () => api.tasks.get(projectId, taskId),
          })
        )
      );
      if (cancelled) return;
      queryClient.setQueryData(queryKeys.tasks.list(projectId), (prev: unknown) => {
        const prevList = Array.isArray(prev) ? prev : [];
        const byId = new Map(prevList.map((t: { id: string }) => [t.id, t]));
        for (const t of fetched) byId.set(t.id, t);
        return [...byId.values()];
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, taskIdsFromFeedback, tasksList, queryClient]);

  /* Auto-focus feedback input when Evaluate tab activates */
  useLayoutEffect(() => {
    feedbackInputRef.current?.focus();
  }, []);

  /* ── Local UI state (restored from localStorage on mount) ── */
  const initialDraft = useMemo(() => loadFeedbackFormDraft(projectId), [projectId]);
  const [input, setInput] = useState(initialDraft.text);
  const imageAttachment = useImageAttachment(initialDraft.images);
  const { isDraggingImage, clearDragState } = useImageDragOverPage();
  const [priority, setPriority] = useState<number | null>(initialDraft.priority);

  /* Sync state when projectId changes (e.g. navigate to different project) */
  useEffect(() => {
    const draft = loadFeedbackFormDraft(projectId);
    setInput(draft.text);
    setPriority(draft.priority);
    imageAttachment.resetTo(draft.images);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps -- resetTo is stable

  /* Persist form state to localStorage on change */
  useEffect(() => {
    saveFeedbackFormDraft(projectId, {
      text: input,
      images: imageAttachment.images,
      priority,
    });
  }, [projectId, input, imageAttachment.images, priority]);
  const [feedbackPriorityDropdownOpen, setFeedbackPriorityDropdownOpen] = useState(false);
  const feedbackPriorityDropdownRef = useRef<HTMLDivElement>(null);
  const feedbackInputRef = useRef<HTMLTextAreaElement>(null);
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() =>
    loadFeedbackCollapsedIds(projectId)
  );
  const [statusFilter, setStatusFilter] = useState<FeedbackStatusFilter>(() =>
    loadFeedbackStatusFilter()
  );
  /** IDs of items animating out (resolved but still visible during collapse). Keeps them in the tree when filter would hide them. */
  const [animatingOutIds, setAnimatingOutIds] = useState<Set<string>>(new Set());

  // Reset filter when "cancelled" is selected but no feedback has status cancelled (option no longer shown)
  const hasCancelled = feedback.some((f) => f.status === "cancelled");
  useEffect(() => {
    if (statusFilter === "cancelled" && !hasCancelled) {
      setStatusFilter("pending");
      saveFeedbackStatusFilter("pending");
    }
  }, [statusFilter, hasCancelled]);

  const handleSubmit = async () => {
    if (!input.trim() || submitting) return;
    const text = input.trim();
    const imagePayload = imageAttachment.images.length > 0 ? imageAttachment.images : undefined;
    const priorityPayload = priority != null ? priority : undefined;
    setInput("");
    imageAttachment.reset();
    setPriority(null);
    const result = await dispatch(
      submitFeedback({ projectId, text, images: imagePayload, priority: priorityPayload })
    );
    if (submitFeedback.fulfilled.match(result)) {
      clearFeedbackFormDraft(projectId);
      feedbackInputRef.current?.focus();
    }
  };

  const onKeyDownFeedback = useSubmitShortcut(handleSubmit, {
    multiline: true,
    disabled: !input.trim() || submitting,
  });

  const handleSubmitReply = useCallback(
    async (parentId: string, text: string, images?: string[]) => {
      if (!text.trim() || submitting) return;
      await dispatch(submitFeedback({ projectId, text, images, parentId }));
    },
    [dispatch, projectId, submitting]
  );

  useEffect(() => {
    if (!feedbackPriorityDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        feedbackPriorityDropdownRef.current &&
        !feedbackPriorityDropdownRef.current.contains(e.target as Node)
      ) {
        setFeedbackPriorityDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFeedbackPriorityDropdownOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [feedbackPriorityDropdownOpen]);

  const feedbackFeedRef = useRef<HTMLDivElement>(null);
  const feedbackIdFromUrl = feedbackIdFromUrlProp ?? null;
  const hasScrolledToFeedbackRef = useRef(false);

  const handleResolve = useCallback(
    (feedbackId: string) => {
      const scrollEl = feedbackFeedRef.current;
      const scrollTop = scrollEl?.scrollTop ?? 0;
      setAnimatingOutIds((prev) => new Set(prev).add(feedbackId));
      dispatch(resolveFeedback({ projectId, feedbackId }));
      // Restore scroll after React re-renders; double rAF + setTimeout catches layout updates
      const restore = () => {
        if (scrollEl) scrollEl.scrollTop = scrollTop;
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(restore);
      });
      setTimeout(restore, 0);
      setTimeout(restore, 50);
    },
    [dispatch, projectId]
  );

  const handleCancel = useCallback(
    (feedbackId: string) => {
      const scrollEl = feedbackFeedRef.current;
      const scrollTop = scrollEl?.scrollTop ?? 0;
      setAnimatingOutIds((prev) => new Set(prev).add(feedbackId));
      dispatch(cancelFeedback({ projectId, feedbackId }));
      const restore = () => {
        if (scrollEl) scrollEl.scrollTop = scrollTop;
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(restore);
      });
      setTimeout(restore, 0);
      setTimeout(restore, 50);
    },
    [dispatch, projectId]
  );

  const handleRemoveAfterAnimation = useCallback(
    (feedbackId: string) => {
      const scrollEl = feedbackFeedRef.current;
      const scrollTop = scrollEl?.scrollTop ?? 0;
      dispatch(removeFeedbackItem(feedbackId));
      setAnimatingOutIds((prev) => {
        const next = new Set(prev);
        next.delete(feedbackId);
        return next;
      });
      // Restore scroll after DOM update (item removed, list reflows)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (scrollEl) scrollEl.scrollTop = scrollTop;
        });
      });
      setTimeout(() => {
        if (scrollEl) scrollEl.scrollTop = scrollTop;
      }, 0);
    },
    [dispatch]
  );

  const handleToggleCollapse = useCallback(
    (id: string) => {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        saveFeedbackCollapsedIds(projectId, next);
        return next;
      });
    },
    [projectId]
  );

  // When navigating with ?feedback=id (e.g. from Analyst dropdown), ensure visibility, expand ancestors, and scroll
  useEffect(() => {
    if (!feedbackIdFromUrl || feedbackQuery.isLoading || feedback.length === 0) return;
    const targetItem = feedback.find((f) => f.id === feedbackIdFromUrl);
    if (!targetItem) return;
    if (hasScrolledToFeedbackRef.current) return;

    // Ensure filter shows the target (e.g. when coming from Analyst, feedback is usually pending)
    if (!matchesStatusFilter(targetItem, statusFilter)) {
      setStatusFilter("all");
      saveFeedbackStatusFilter("all");
    }

    // Expand all ancestors so the target is visible (replies may be inside collapsed parents)
    const ancestorIds: string[] = [];
    let pid: string | null = targetItem.parent_id ?? null;
    while (pid) {
      ancestorIds.push(pid);
      const parent = feedback.find((f) => f.id === pid);
      pid = parent?.parent_id ?? null;
    }
    if (ancestorIds.length > 0) {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        for (const id of ancestorIds) next.delete(id);
        if (next.size !== prev.size) {
          saveFeedbackCollapsedIds(projectId, next);
          return next;
        }
        return prev;
      });
    }

    // Scroll after a brief delay to allow layout (especially after expanding)
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-feedback-id="${feedbackIdFromUrl}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        hasScrolledToFeedbackRef.current = true;
      }
    }, ancestorIds.length > 0 ? 150 : 0);

    return () => clearTimeout(timer);
  }, [feedbackIdFromUrl, feedback, feedbackQuery.isLoading, projectId, statusFilter]);

  const filteredFeedback = useMemo(
    () =>
      feedback.filter(
        (item) => matchesStatusFilter(item, statusFilter) || animatingOutIds.has(item.id)
      ),
    [feedback, statusFilter, animatingOutIds]
  );
  const feedbackTree = useMemo(() => buildFeedbackTree(filteredFeedback), [filteredFeedback]);

  useScrollToQuestion();
  const { notifications: openQuestionNotifications, refetch: refetchNotifications } =
    useOpenQuestionNotifications(projectId);
  const questionIdByFeedbackId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const n of openQuestionNotifications) {
      if (n.source === "eval" && n.sourceId) {
        map[n.sourceId] = n.id;
      }
    }
    return map;
  }, [openQuestionNotifications]);
  const notificationByFeedbackId = useMemo(() => {
    const map: Record<string, Notification> = {};
    for (const n of openQuestionNotifications) {
      if (n.source === "eval" && n.sourceId) {
        map[n.sourceId] = n;
      }
    }
    return map;
  }, [openQuestionNotifications]);

  const [answerNotificationId, setAnswerNotificationId] = useState<string | null>(null);
  const answeringOpenQuestion = answerNotificationId != null;

  const handleAnswerOpenQuestion = useCallback(
    async (feedbackId: string, notificationId: string, answer: string) => {
      if (!answer.trim()) return;
      setAnswerNotificationId(notificationId);
      try {
        await api.notifications.resolve(projectId, notificationId);
        await dispatch(
          recategorizeFeedback({ projectId, feedbackId, answer: answer.trim() })
        ).unwrap();
        refetchNotifications();
      } finally {
        setAnswerNotificationId(null);
      }
    },
    [dispatch, projectId, refetchNotifications]
  );

  const handleDismissOpenQuestion = useCallback(
    async (feedbackId: string, notificationId: string) => {
      setAnswerNotificationId(notificationId);
      try {
        await api.notifications.resolve(projectId, notificationId);
        refetchNotifications();
      } finally {
        setAnswerNotificationId(null);
      }
    },
    [projectId, refetchNotifications]
  );

  /* ── RENDER: Loading spinner during fetch (no fake page content) ── */
  if (showFeedbackSpinner) {
    return (
      <div
        className="flex flex-1 min-h-0 items-center justify-center bg-theme-bg"
        data-testid="feedback-loading"
      >
        <PhaseLoadingSpinner
          data-testid="feedback-loading-spinner"
          aria-label="Loading feedback"
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div
        ref={feedbackFeedRef}
        className="flex-1 min-h-0 overflow-y-auto"
        data-testid="eval-feedback-feed-scroll"
      >
        <div className={`${CONTENT_CONTAINER_CLASS} py-8`} data-testid="eval-feedback-content">
          {/* Feedback Input */}
          <ImageDropZone
            variant="main"
            isDraggingImage={isDraggingImage}
            onDragOver={imageAttachment.handleDragOver}
            onDrop={async (e) => {
              clearDragState();
              await imageAttachment.handleDrop(e);
            }}
            className="card p-5 mb-8"
            data-testid="main-feedback-drop-zone"
          >
            <label className="block text-sm font-medium text-theme-text mb-2">
              What did you find?
            </label>
            <textarea
              ref={feedbackInputRef}
              className="input min-h-[100px] mb-3"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={imageAttachment.handlePaste}
              onKeyDown={onKeyDownFeedback}
              placeholder="Describe a bug, suggest a feature, or report a UX issue..."
              disabled={submitting}
              data-testid="eval-feedback-input"
            />
            <ImageAttachmentThumbnails attachment={imageAttachment} className="mb-3" />
            <div className="flex justify-end items-stretch gap-2 flex-wrap">
              <div ref={feedbackPriorityDropdownRef} className="relative shrink-0 flex">
                <button
                  type="button"
                  onClick={() => !submitting && setFeedbackPriorityDropdownOpen((o) => !o)}
                  disabled={submitting}
                  className="input text-sm h-10 min-h-10 py-2.5 px-3 w-auto min-w-[10rem] inline-flex items-center gap-2 bg-theme-input-bg text-theme-input-text ring-theme-ring"
                  aria-label="Priority (optional)"
                  aria-haspopup="listbox"
                  aria-expanded={feedbackPriorityDropdownOpen}
                  data-testid="feedback-priority-select"
                >
                  {priority != null ? (
                    <>
                      <PriorityIcon priority={priority} size="sm" />
                      <span className="flex-1 text-left">{PRIORITY_LABELS[priority]}</span>
                    </>
                  ) : (
                    <span className="flex-1 text-left text-theme-muted">Priority (optional)</span>
                  )}
                  <span className="text-[10px] opacity-70 shrink-0">
                    {feedbackPriorityDropdownOpen ? "▲" : "▼"}
                  </span>
                </button>
                {feedbackPriorityDropdownOpen && (
                  <ul
                    role="listbox"
                    className="absolute left-0 top-full mt-1 z-50 min-w-[10rem] rounded-lg border border-theme-border bg-theme-surface shadow-lg py-1"
                    data-testid="feedback-priority-dropdown"
                  >
                    <li role="option">
                      <button
                        type="button"
                        onClick={() => {
                          setPriority(null);
                          setFeedbackPriorityDropdownOpen(false);
                        }}
                        className="w-full flex items-center gap-2 text-left px-3 py-2 text-xs hover:bg-theme-border-subtle/50 transition-colors text-theme-muted"
                        data-testid="feedback-priority-option-clear"
                      >
                        No priority
                      </button>
                    </li>
                    {([0, 1, 2, 3, 4] as const).map((p) => (
                      <li key={p} role="option">
                        <button
                          type="button"
                          onClick={() => {
                            setPriority(p);
                            setFeedbackPriorityDropdownOpen(false);
                          }}
                          className={`w-full flex items-center gap-2 text-left px-3 py-2 text-xs hover:bg-theme-border-subtle/50 transition-colors ${
                            priority === p ? "text-brand-600 font-medium" : "text-theme-text"
                          }`}
                          data-testid={`feedback-priority-option-${p}`}
                        >
                          <PriorityIcon priority={p} size="sm" />
                          {PRIORITY_LABELS[p]}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <ImageAttachmentButton
                attachment={imageAttachment}
                variant="icon"
                disabled={submitting}
                data-testid="feedback-attach-image"
              />
              <KeyboardShortcutTooltip>
                <button
                  onClick={handleSubmit}
                  disabled={submitting || !input.trim()}
                  className="btn-primary h-10 disabled:opacity-50"
                >
                  {submitting ? "Submitting..." : "Submit Feedback"}
                </button>
              </KeyboardShortcutTooltip>
            </div>
          </ImageDropZone>

          {/* Feedback Feed */}
          <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
            <h3 className="text-sm font-semibold text-theme-text">Feedback History</h3>
            {feedback.length > 0 && (
              <select
                value={statusFilter}
                onChange={(e) => {
                  const value = e.target.value as FeedbackStatusFilter;
                  setStatusFilter(value);
                  saveFeedbackStatusFilter(value);
                }}
                className="input text-sm py-1.5 pl-3 w-auto min-w-[7rem] bg-theme-input-bg text-theme-input-text ring-theme-ring"
                aria-label="Filter feedback by status"
                data-testid="feedback-status-filter"
              >
                <option value="all">All ({countByStatus(feedback, "all")})</option>
                <option value="pending">Pending ({countByStatus(feedback, "pending")})</option>
                <option value="resolved">Resolved ({countByStatus(feedback, "resolved")})</option>
                {feedback.some((f) => f.status === "cancelled") && (
                  <option value="cancelled">
                    Cancelled ({countByStatus(feedback, "cancelled")})
                  </option>
                )}
              </select>
            )}
          </div>

          {showFeedbackEmptyState ? (
            <div className="text-center py-10 text-theme-muted text-sm">
              No feedback submitted yet. Test your app and report findings above.
            </div>
          ) : filteredFeedback.length === 0 ? (
            <div className="text-center py-10 text-theme-muted text-sm">
              {statusFilter === "all"
                ? "No feedback yet."
                : statusFilter === "pending"
                  ? "No pending feedback yet."
                  : statusFilter === "resolved"
                    ? "No resolved feedback yet."
                    : "No cancelled feedback yet."}
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {/* key=node.item.id preserves DOM identity when a single item is updated via WebSocket */}
                {feedbackTree.map((node) => (
                  <FeedbackCard
                    key={node.item.id}
                    node={node}
                    depth={0}
                    projectId={projectId}
                    onNavigateToBuildTask={onNavigateToBuildTask}
                    replyingToId={replyingToId}
                    onStartReply={setReplyingToId}
                    onCancelReply={() => setReplyingToId(null)}
                    onSubmitReply={handleSubmitReply}
                    onResolve={handleResolve}
                    onCancel={handleCancel}
                    onRemoveAfterAnimation={handleRemoveAfterAnimation}
                    collapsedIds={collapsedIds}
                    onToggleCollapse={handleToggleCollapse}
                    submitting={submitting}
                    isDraggingImage={isDraggingImage}
                    clearDragState={clearDragState}
                    tasks={tasks}
                    questionId={questionIdByFeedbackId[node.item.id]}
                    questionIdByFeedbackId={questionIdByFeedbackId}
                    notification={notificationByFeedbackId[node.item.id]}
                    notificationByFeedbackId={notificationByFeedbackId}
                    onAnswerOpenQuestion={handleAnswerOpenQuestion}
                    onDismissOpenQuestion={handleDismissOpenQuestion}
                    answeringOpenQuestion={answeringOpenQuestion}
                    onHilResolved={refetchNotifications}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
