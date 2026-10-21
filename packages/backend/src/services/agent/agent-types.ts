import type { AgentConfig, AgentRole } from "@opensprint/shared";
import type { AgentCacheUsageMetrics, PromptCacheContext } from "../../utils/prompt-cache.js";

/** Message for planning agent (user or assistant) */
export interface PlanningMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Optional tracking descriptor — when provided, the agent is automatically
 * registered in activeAgentsService on invocation and unregistered on exit.
 */
export interface AgentTrackingInfo {
  id: string;
  projectId: string;
  phase: string;
  role: AgentRole;
  label: string;
  branchName?: string;
  /** Plan ID when agent is working in plan context (e.g. task generation for a plan) */
  planId?: string;
  /** Feedback ID when Analyst is categorizing a specific feedback item */
  feedbackId?: string;
  /** Owning task for Execute deep links when `id` is a per-run token (e.g. merger). */
  taskId?: string;
  attempt?: number;
  attemptId?: string;
}

/** Options for invokePlanningAgent */
export interface InvokePlanningAgentOptions {
  /** Project ID (required for Claude API key resolution and retry) */
  projectId: string;
  /** Agent role for agent log (required so every planning run is recorded) */
  role: AgentRole;
  /** Agent configuration (model from config) */
  config: AgentConfig;
  /** Conversation messages in order */
  messages: PlanningMessage[];
  /** Optional system prompt */
  systemPrompt?: string;
  /** Optional image attachments (base64 or data URLs). Claude: inline in message. Cursor/custom: written to temp files and paths appended to prompt. */
  images?: string[];
  /** Working directory for CLI agents (cursor/custom) */
  cwd?: string;
  /** Callback for streaming text chunks */
  onChunk?: (chunk: string) => void;
  /** When provided, auto-registers/unregisters with activeAgentsService */
  tracking?: AgentTrackingInfo;
  /** OpenAI Responses conversation chaining for repeated planning chats */
  previousResponseId?: string;
  /** Provider-specific prompt caching context */
  promptCacheContext?: PromptCacheContext;
}

/** Response from planning agent */
export interface PlanningAgentResponse {
  content: string;
  responseId?: string;
  cacheMetrics?: AgentCacheUsageMetrics;
}

/** Options for invokeCodingAgent (file-based prompt) */
export interface InvokeCodingAgentOptions {
  /** Working directory for the agent (typically repo path) */
  cwd: string;
  /** Callback for streaming output chunks */
  onOutput: (chunk: string) => void;
  /** Callback when agent process exits */
  onExit: (code: number | null) => void;
  /** Human-readable agent role for logging (e.g. 'coder', 'code reviewer') */
  agentRole?: string;
  /** When provided, auto-registers/unregisters with activeAgentsService */
  tracking?: AgentTrackingInfo;
  /** File path to redirect agent stdout/stderr for crash-resilient output */
  outputLogPath?: string;
  /** Project ID for Cursor: ApiKeyResolver for CURSOR_API_KEY, retry on limit error, clearLimitHit on success */
  projectId?: string;
}

/** Return type for invokeCodingAgent — handle with kill() to terminate */
export interface CodingAgentHandle {
  kill: () => void;
  pid: number | null;
  /** A recovered PID proves liveness only, and must not authorize signalling it. */
  ownership?: "local" | "recovered_unverified";
  /** Bounded queue for injecting live user messages into the agentic loop (API backends only). */
  pendingMessages?: import("../agentic-loop.js").PendingMessageQueue | null;
}

export type MergerPhase = "rebase_before_merge" | "merge_to_main" | "push_rebase";

export interface RunMergerAgentOptions {
  projectId: string;
  cwd: string;
  config: AgentConfig;
  phase: MergerPhase;
  taskId: string;
  branchName: string;
  conflictedFiles: string[];
  testCommand?: string;
  mergeQualityGates?: string[];
  /** Base branch for merger prompt context (default: "main") */
  baseBranch?: string;
}

export interface RecordAgentRunOptions {
  projectId: string;
  role: AgentRole;
  config: AgentConfig;
  runId: string;
  startedAt: string;
  completedAt: string;
  outcome: "success" | "failed";
}
