import { useState, useRef, useCallback, useMemo } from "react";
import type { FeedbackItem, KanbanColumn } from "@opensprint/shared";
import { useAppDispatch, useAppSelector } from "../../store";
import { submitFeedback, resolveFeedback, setEvalError } from "../../store/slices/evalSlice";
import { TaskStatusBadge, COLUMN_LABELS } from "../../components/kanban";

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

const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

export const FEEDBACK_COLLAPSED_KEY_PREFIX = "opensprint-eval-feedback-collapsed";

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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function isImageFile(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(file.type);
}

interface EvalPhaseProps {
  projectId: string;
  onNavigateToBuildTask?: (taskId: string) => void;
}

const categoryColors: Record<string, string> = {
  bug: "bg-red-50 text-red-700",
  feature: "bg-purple-50 text-purple-700",
  ux: "bg-blue-50 text-blue-700",
  scope: "bg-yellow-50 text-yellow-700",
};

/** Display label for feedback type chip (Bug/Feature/UX/Scope). */
function getFeedbackTypeLabel(item: FeedbackItem): string {
  return item.category === "ux" ? "UX" : item.category.charAt(0).toUpperCase() + item.category.slice(1);
}

/** Tree node for feedback display (parent + children) */
interface FeedbackTreeNode {
  item: FeedbackItem;
  children: FeedbackTreeNode[];
}

/** Build tree from flat feedback list. Top-level first, then children by createdAt desc. */
function buildFeedbackTree(items: FeedbackItem[]): FeedbackTreeNode[] {
  const byParent = new Map<string | null, FeedbackItem[]>();
  for (const item of items) {
    const pid = item.parent_id ?? null;
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

interface FeedbackCardProps {
  node: FeedbackTreeNode;
  depth: number;
  projectId: string;
  getTaskColumn: (taskId: string) => KanbanColumn;
  onNavigateToBuildTask?: (taskId: string) => void;
  replyingToId: string | null;
  onStartReply: (id: string) => void;
  onCancelReply: () => void;
  onSubmitReply: (parentId: string, text: string) => void;
  onResolve: (feedbackId: string) => void;
  collapsedIds: Set<string>;
  onToggleCollapse: (id: string) => void;
  submitting: boolean;
}

function FeedbackCard({
  node,
  depth,
  projectId,
  getTaskColumn,
  onNavigateToBuildTask,
  replyingToId,
  onStartReply,
  onCancelReply,
  onSubmitReply,
  onResolve,
  collapsedIds,
  onToggleCollapse,
  submitting,
}: FeedbackCardProps) {
  const { item, children } = node;
  const [replyText, setReplyText] = useState("");
  const isReplying = replyingToId === item.id;
  const isCollapsed = collapsedIds.has(item.id);
  const hasChildren = children.length > 0;

  const handleSubmitReply = () => {
    if (!replyText.trim() || submitting) return;
    onSubmitReply(item.id, replyText.trim());
    setReplyText("");
    onCancelReply();
  };

  return (
    <div className={depth > 0 ? "ml-4 mt-2 border-l-2 border-gray-200 pl-4" : ""}>
      <div className="card p-4">
        {/* Category badge/spinner floats top-right */}
        <div className="mb-2 overflow-hidden">
          {item.status === "pending" ? (
            <span
              className="float-right ml-2 mb-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 flex-shrink-0"
              aria-label="Categorizing feedback"
            >
              <div
                className="h-3 w-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"
                aria-hidden="true"
              />
              Categorizing…
            </span>
          ) : (
            <>
              {item.status === "resolved" && (
                <span
                  className="float-right ml-2 mb-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium flex-shrink-0 bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                  aria-label="Resolved"
                >
                  Resolved
                </span>
              )}
              <span
                className={`float-right ml-2 mb-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium flex-shrink-0 ${
                  categoryColors[item.category] ?? "bg-gray-100 text-gray-600"
                }`}
              >
                {getFeedbackTypeLabel(item)}
              </span>
            </>
          )}
          <p className="text-sm text-gray-700 whitespace-pre-wrap break-words min-w-0">
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
                className="h-16 w-16 object-cover rounded border border-gray-200"
              />
            ))}
          </div>
        )}

        {/* Ticket info and reply button share same line */}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          {item.createdTaskIds.length > 0 && (
            <div className="flex gap-1 flex-wrap min-w-0">
              {item.createdTaskIds.map((taskId) => {
                const column = getTaskColumn(taskId);
                const statusLabel = COLUMN_LABELS[column];
                return onNavigateToBuildTask ? (
                  <button
                    key={taskId}
                    type="button"
                    onClick={() => onNavigateToBuildTask(taskId)}
                    className="inline-flex items-center gap-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-brand-600 hover:bg-brand-50 hover:text-brand-700 underline transition-colors"
                    title={`Go to ${taskId} on Execute tab (${statusLabel})`}
                  >
                    <TaskStatusBadge column={column} size="xs" />
                    <span className="text-gray-500 font-sans font-normal no-underline" aria-label={`Status: ${statusLabel}`}>
                      {statusLabel}
                    </span>
                    {taskId}
                  </button>
                ) : (
                  <span
                    key={taskId}
                    className="inline-flex items-center gap-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-gray-600"
                  >
                    <TaskStatusBadge column={column} size="xs" />
                    <span className="text-gray-500 font-sans font-normal" aria-label={`Status: ${statusLabel}`}>
                      {statusLabel}
                    </span>
                    {taskId}
                  </span>
                );
              })}
            </div>
          )}
          <div className="flex gap-2 flex-shrink-0 ml-auto">
            {item.status === "mapped" && (
              <button
                type="button"
                onClick={() => onResolve(item.id)}
                className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-green-600 hover:bg-green-50 hover:text-green-800 transition-colors"
                title="Mark as resolved"
                aria-label="Resolve"
              >
                Resolve
              </button>
            )}
            <button
              type="button"
              onClick={() => (isReplying ? onCancelReply() : onStartReply(item.id))}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-800 transition-colors"
              title="Reply"
              aria-label={isReplying ? "Cancel reply" : "Reply"}
            >
              <ReplyIcon className="w-4 h-4" />
              {isReplying ? "Cancel" : "Reply"}
            </button>
            {hasChildren && (
              <button
                type="button"
                onClick={() => onToggleCollapse(item.id)}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-800 transition-colors"
                aria-label={isCollapsed ? "Expand replies" : "Collapse replies"}
              >
                {isCollapsed ? "Expand" : "Collapse"} ({children.length} {children.length === 1 ? "reply" : "replies"})
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Inline reply composer (PRD §7.4.1: quote snippet of parent above text input) */}
      {isReplying && (
        <div className="mt-2 ml-0 card p-3">
          <blockquote className="mb-2 pl-3 border-l-2 border-gray-300 text-sm text-gray-600 italic">
            {item.text && item.text.length > 80 ? `${item.text.slice(0, 80)}…` : (item.text || "(No feedback text)")}
          </blockquote>
          <textarea
            className="input min-h-[60px] mb-2 text-sm"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleSubmitReply();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onCancelReply();
              }
            }}
            placeholder="Write a reply..."
            disabled={submitting}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancelReply}
              className="btn-secondary text-sm py-1 px-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmitReply}
              disabled={submitting || !replyText.trim()}
              className="btn-primary text-sm py-1 px-2 disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit Reply"}
            </button>
          </div>
        </div>
      )}

      {/* Nested children (hidden when collapsed) */}
      {!isCollapsed &&
        children.map((child) => (
          <FeedbackCard
            key={child.item.id}
            node={child}
            depth={depth + 1}
            projectId={projectId}
            getTaskColumn={getTaskColumn}
            onNavigateToBuildTask={onNavigateToBuildTask}
            replyingToId={replyingToId}
            onStartReply={onStartReply}
            onCancelReply={onCancelReply}
            onSubmitReply={onSubmitReply}
            onResolve={onResolve}
            collapsedIds={collapsedIds}
            onToggleCollapse={onToggleCollapse}
            submitting={submitting}
          />
        ))}
    </div>
  );
}

export function EvalPhase({ projectId, onNavigateToBuildTask }: EvalPhaseProps) {
  const dispatch = useAppDispatch();

  /* ── Redux state ── */
  const feedback = useAppSelector((s) => s.eval.feedback);
  const executeTasks = useAppSelector((s) => s.execute.tasks);
  const loading = useAppSelector((s) => s.eval.loading);
  const submitting = useAppSelector((s) => s.eval.submitting);
  const error = useAppSelector((s) => s.eval.error);

  const getTaskColumn = useCallback(
    (taskId: string): KanbanColumn => {
      const task = executeTasks.find((t) => t.id === taskId);
      return task?.kanbanColumn ?? "backlog";
    },
    [executeTasks],
  );

  /* ── Local UI state (preserved by mount-all) ── */
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => loadFeedbackCollapsedIds(projectId));

  const addImagesFromFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(isImageFile);
    const toAdd: string[] = [];
    for (const file of fileArray) {
      if (toAdd.length >= MAX_IMAGES) break;
      if (file.size > MAX_IMAGE_SIZE_BYTES) continue;
      try {
        const base64 = await fileToBase64(file);
        toAdd.push(base64);
      } catch {
        // Skip invalid files
      }
    }
    if (toAdd.length > 0) {
      setImages((prev) => [...prev, ...toAdd].slice(0, MAX_IMAGES));
    }
  }, []);

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        await addImagesFromFiles(files);
      }
    },
    [addImagesFromFiles],
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer?.files;
      if (files?.length) await addImagesFromFiles(files);
    },
    [addImagesFromFiles],
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length) addImagesFromFiles(files);
    e.target.value = "";
  };

  const handleSubmit = async () => {
    if (!input.trim() || submitting) return;
    const text = input.trim();
    const imagePayload = images.length > 0 ? images : undefined;
    setInput("");
    setImages([]);
    await dispatch(submitFeedback({ projectId, text, images: imagePayload }));
  };

  const handleSubmitReply = useCallback(
    async (parentId: string, text: string) => {
      if (!text.trim() || submitting) return;
      await dispatch(submitFeedback({ projectId, text, parentId }));
    },
    [dispatch, projectId, submitting],
  );

  const handleResolve = useCallback(
    (feedbackId: string) => {
      dispatch(resolveFeedback({ projectId, feedbackId }));
    },
    [dispatch, projectId],
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
    [projectId],
  );

  const feedbackTree = useMemo(() => buildFeedbackTree(feedback), [feedback]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex justify-between items-center">
            <span>{error}</span>
            <button type="button" onClick={() => dispatch(setEvalError(null))} className="text-red-500 hover:text-red-700 underline">
              Dismiss
            </button>
          </div>
        )}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Eval</h2>
          <p className="text-sm text-gray-500">
            Test your application and report feedback. The AI will map issues to the right features and create tickets
            automatically.
          </p>
        </div>

        {/* Feedback Input */}
        <div
          className="card p-5 mb-8"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <label className="block text-sm font-medium text-gray-700 mb-2">What did you find?</label>
          <textarea
            className="input min-h-[100px] mb-3"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Describe a bug, suggest a feature, or report a UX issue..."
            disabled={submitting}
          />
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {images.map((dataUrl, i) => (
                <div key={i} className="relative group">
                  <img
                    src={dataUrl}
                    alt={`Attachment ${i + 1}`}
                    className="h-16 w-16 object-cover rounded border border-gray-200"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(i)}
                    className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center hover:bg-red-600 transition-colors shadow"
                    aria-label="Remove image"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting || images.length >= MAX_IMAGES}
              className="btn-secondary p-2 disabled:opacity-50"
              title="Attach image"
              aria-label="Attach image"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-5 h-5"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || !input.trim()}
              className="btn-primary disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit Feedback"}
            </button>
          </div>
        </div>

        {/* Feedback Feed */}
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Feedback History ({feedback.length})</h3>

        {loading ? (
          <div className="text-center py-10 text-gray-400">Loading feedback...</div>
        ) : feedback.length === 0 ? (
          <div className="text-center py-10 text-gray-400 text-sm">
            No feedback submitted yet. Test your app and report findings above.
          </div>
        ) : (
          <div className="space-y-3">
            {feedbackTree.map((node) => (
              <FeedbackCard
                key={node.item.id}
                node={node}
                depth={0}
                projectId={projectId}
                getTaskColumn={getTaskColumn}
                onNavigateToBuildTask={onNavigateToBuildTask}
                replyingToId={replyingToId}
                onStartReply={setReplyingToId}
                onCancelReply={() => setReplyingToId(null)}
                onSubmitReply={handleSubmitReply}
                onResolve={handleResolve}
                collapsedIds={collapsedIds}
                onToggleCollapse={handleToggleCollapse}
                submitting={submitting}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
