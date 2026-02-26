/** localStorage key prefix for Evaluate feedback form draft state (per project) */
export const FEEDBACK_FORM_DRAFT_KEY_PREFIX = "opensprint-eval-feedback-draft";

/** Max total bytes for persisted images (base64 ~33% larger than binary). ~1.5MB keeps under typical 5MB localStorage limit. */
export const MAX_STORED_IMAGES_BYTES = 1.5 * 1024 * 1024;

export interface FeedbackFormDraft {
  text: string;
  images: string[];
  priority: number | null;
}

function getStorageKey(projectId: string): string {
  return `${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-${projectId}`;
}

/** Estimate base64 string size in bytes (each char ≈ 1 byte for UTF-16, base64 is ASCII) */
function estimateBase64Size(str: string): number {
  return str.length;
}

/** Load saved feedback form state from localStorage. Returns empty draft if missing or invalid. */
export function loadFeedbackFormDraft(projectId: string): FeedbackFormDraft {
  if (typeof window === "undefined") {
    return { text: "", images: [], priority: null };
  }
  try {
    const stored = localStorage.getItem(getStorageKey(projectId));
    if (!stored) return { text: "", images: [], priority: null };
    const parsed = JSON.parse(stored) as unknown;
    if (parsed === null || typeof parsed !== "object") return { text: "", images: [], priority: null };
    const obj = parsed as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text : "";
    const imagesRaw = obj.images;
    let images: string[] = [];
    if (Array.isArray(imagesRaw)) {
      let totalBytes = 0;
      for (const item of imagesRaw) {
        if (typeof item !== "string" || !item.startsWith("data:image/")) continue;
        const size = estimateBase64Size(item);
        if (totalBytes + size > MAX_STORED_IMAGES_BYTES) break;
        images.push(item);
        totalBytes += size;
      }
    }
    const priorityRaw = obj.priority;
    const priority =
      typeof priorityRaw === "number" && Number.isInteger(priorityRaw) && priorityRaw >= 0 && priorityRaw <= 4
        ? priorityRaw
        : null;
    return { text, images, priority };
  } catch {
    return { text: "", images: [], priority: null };
  }
}

/** Save feedback form state to localStorage. Truncates images if total size exceeds limit. */
export function saveFeedbackFormDraft(projectId: string, draft: FeedbackFormDraft): void {
  if (typeof window === "undefined") return;
  try {
    let images = draft.images ?? [];
    let totalBytes = 0;
    const truncated: string[] = [];
    for (const img of images) {
      if (typeof img !== "string" || !img.startsWith("data:image/")) continue;
      const size = estimateBase64Size(img);
      if (totalBytes + size > MAX_STORED_IMAGES_BYTES) break;
      truncated.push(img);
      totalBytes += size;
    }
    const toStore: FeedbackFormDraft = {
      text: typeof draft.text === "string" ? draft.text : "",
      images: truncated,
      priority:
        typeof draft.priority === "number" &&
        Number.isInteger(draft.priority) &&
        draft.priority >= 0 &&
        draft.priority <= 4
          ? draft.priority
          : null,
    };
    localStorage.setItem(getStorageKey(projectId), JSON.stringify(toStore));
  } catch {
    // ignore quota or parse errors
  }
}

/** Clear saved feedback form state (e.g. after successful submit). */
export function clearFeedbackFormDraft(projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(getStorageKey(projectId));
  } catch {
    // ignore
  }
}
