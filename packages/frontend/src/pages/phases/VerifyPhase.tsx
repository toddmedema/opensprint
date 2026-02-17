import { useState, useRef, useCallback, useMemo } from "react";
import type { FeedbackItem } from "@opensprint/shared";
import { useAppDispatch, useAppSelector } from "../../store";
import { submitFeedback, setValidateError } from "../../store/slices/validateSlice";

const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

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

interface VerifyPhaseProps {
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

export function VerifyPhase({ projectId, onNavigateToBuildTask }: VerifyPhaseProps) {
  const dispatch = useAppDispatch();

  /* ── Redux state ── */
  const feedback = useAppSelector((s) => s.validate.feedback);
  const displayedFeedback = useMemo(
    () => feedback.filter((item) => item.status !== "pending"),
    [feedback],
  );
  const loading = useAppSelector((s) => s.validate.loading);
  const submitting = useAppSelector((s) => s.validate.submitting);
  const error = useAppSelector((s) => s.validate.error);

  /* ── Local UI state (preserved by mount-all) ── */
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    const result = await dispatch(
      submitFeedback({ projectId, text, images: images.length > 0 ? images : undefined }),
    );
    if (submitFeedback.fulfilled.match(result)) {
      setInput("");
      setImages([]);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex justify-between items-center">
            <span>{error}</span>
            <button type="button" onClick={() => dispatch(setValidateError(null))} className="text-red-500 hover:text-red-700 underline">
              Dismiss
            </button>
          </div>
        )}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Verify</h2>
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
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Feedback History ({displayedFeedback.length})</h3>

        {loading ? (
          <div className="text-center py-10 text-gray-400">Loading feedback...</div>
        ) : displayedFeedback.length === 0 ? (
          <div className="text-center py-10 text-gray-400 text-sm">
            No feedback submitted yet. Test your app and report findings above.
          </div>
        ) : (
          <div className="space-y-3">
            {displayedFeedback.map((item: FeedbackItem) => (
              <div key={item.id} className="card p-4">
                <div className="flex items-start justify-between mb-2">
                  <p className="text-sm text-gray-900 flex-1">{item.text}</p>
                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        categoryColors[item.category] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {getFeedbackTypeLabel(item)}
                    </span>
                  </div>
                </div>

                {item.mappedPlanId && (
                  <p className="text-xs text-gray-500">
                    <span className="font-mono">{item.mappedPlanId}</span>
                  </p>
                )}

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

                {item.createdTaskIds.length > 0 && (
                  <div className="mt-1 flex gap-1 flex-wrap">
                    {item.createdTaskIds.map((taskId) =>
                      onNavigateToBuildTask ? (
                        <button
                          key={taskId}
                          type="button"
                          onClick={() => onNavigateToBuildTask(taskId)}
                          className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-brand-600 hover:bg-brand-50 hover:text-brand-700 underline transition-colors"
                          title={`Go to ${taskId} on Build tab`}
                        >
                          {taskId}
                        </button>
                      ) : (
                        <span
                          key={taskId}
                          className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-gray-600"
                        >
                          {taskId}
                        </span>
                      ),
                    )}
                  </div>
                )}

                <p className="text-xs text-gray-400 mt-2">{new Date(item.createdAt).toLocaleString()}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
