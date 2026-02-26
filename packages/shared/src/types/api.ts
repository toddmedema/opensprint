/** Generic API response wrapper */
export interface ApiResponse<T> {
  data: T;
  error?: never;
}

/** API error response */
export interface ApiErrorResponse {
  data?: never;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Union of success and error response */
export type ApiResult<T> = ApiResponse<T> | ApiErrorResponse;

/** Chat message request */
export interface ChatRequest {
  message: string;
  context?: string;
  /** PRD section key to add as context to this message (PRD §7.1.5 click-to-focus) */
  prdSectionFocus?: string;
  /** Base64-encoded image attachments (data URLs or raw base64) for sketch/Dreamer */
  images?: string[];
}

/** Chat message response */
export interface ChatResponse {
  message: string;
  prdChanges?: Array<{
    section: string;
    previousVersion: number;
    newVersion: number;
    /** New section content for optimistic UI update */
    content?: string;
  }>;
}

/** Help chat request (Ask a Question — ask-only agent, no state changes) */
export interface HelpChatRequest {
  message: string;
  /** Project ID when in per-project view; omit for homepage */
  projectId?: string | null;
  /** Prior conversation for multi-turn context (optional) */
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
}

/** Help chat response */
export interface HelpChatResponse {
  message: string;
}

/** Feedback submission */
export interface FeedbackSubmitRequest {
  text: string;
  /** Base64-encoded image attachments (data URLs or raw base64) */
  images?: string[];
  /** ID of the parent feedback item when creating a reply. PRD §7.4.1 threaded replies */
  parent_id?: string | null;
  /** User-specified priority (0=Critical, 1=High, 2=Medium, 3=Low, 4=Lowest). Omitted when not set. */
  priority?: number | null;
}
