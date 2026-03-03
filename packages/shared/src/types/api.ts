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

/** Structured agent/provider failure details carried in ApiErrorResponse.error.details. */
export interface AgentApiFailureDetails {
  kind: "rate_limit" | "auth" | "out_of_credit" | "scope_compliance";
  agentType: "claude" | "claude-cli" | "cursor" | "custom" | "openai" | "google";
  raw: string;
  userMessage: string;
  notificationMessage: string;
  isLimitError: boolean;
  retryAfterSeconds?: number;
  allKeysExhausted?: boolean;
}

/** Union of success and error response */
export type ApiResult<T> = ApiResponse<T> | ApiErrorResponse;

export type BackendPlatform = "linux" | "darwin" | "win32";

export type RepoPathPolicy = "any" | "linux_fs_only";

export interface EnvRuntimeResponse {
  platform: BackendPlatform;
  isWsl: boolean;
  wslDistroName: string | null;
  repoPathPolicy: RepoPathPolicy;
}

/** Task context for Execute chat replies (enables agent to resolve "this task" references) */
export interface ExecuteTaskContext {
  id: string;
  title: string;
  description: string;
  status?: string;
  kanbanColumn?: string;
}

/** Chat message request */
export interface ChatRequest {
  message: string;
  context?: string;
  /** PRD section key to add as context to this message (PRD §7.1.5 click-to-focus) */
  prdSectionFocus?: string;
  /** Base64-encoded image attachments (data URLs or raw base64) for sketch/Dreamer */
  images?: string[];
  /** Task metadata for Execute chat replies (context execute:taskId). Enables agent to resolve "this task" references. */
  taskContext?: ExecuteTaskContext;
}

/** Chat message response */
export interface ChatResponse {
  message: string;
  planGenerated?: {
    planId: string;
  };
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

/** Help chat history (persisted messages for Ask a Question) */
export interface HelpChatHistory {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/** Task analytics: per-complexity bucket (1-10) */
export interface TaskAnalyticsBucket {
  complexity: number;
  taskCount: number;
  avgCompletionTimeMs: number;
}

/** Task analytics response (100 most recently completed tasks, grouped by complexity) */
export interface TaskAnalytics {
  byComplexity: TaskAnalyticsBucket[];
  totalTasks: number;
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
