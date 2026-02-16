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

/** Paginated response */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  offset: number;
  limit: number;
}

/** Chat message request */
export interface ChatRequest {
  message: string;
  context?: string;
  /** PRD section key to add as context to this message (PRD §7.1.5 click-to-focus) */
  prdSectionFocus?: string;
}

/** Chat message response */
export interface ChatResponse {
  message: string;
  prdChanges?: Array<{
    section: string;
    previousVersion: number;
    newVersion: number;
  }>;
}

/** Build control requests */
export interface BuildStartRequest {
  projectId: string;
}

export interface BuildPauseRequest {
  projectId: string;
}

/** Feedback submission */
export interface FeedbackSubmitRequest {
  text: string;
}

/** Plan ship request */
export interface PlanShipRequest {
  planId: string;
}
