import type {
  ActiveAgent,
  AgentRuntimeState,
  AgentSuspendReason,
  AgentSession,
  BaselineRuntimeStatus,
  MergeValidationRuntimeStatus,
  Task,
} from "@opensprint/shared";
import { createInitialAsyncStates, type AsyncStates } from "../asyncHelpers";

/** Task display shape for kanban (subset of Task) */
export type TaskCard = Pick<
  Task,
  "id" | "title" | "kanbanColumn" | "priority" | "assignee" | "epicId" | "testResults"
>;

/** Active task entry from orchestrator status (v2 multi-slot model) */
export interface ActiveTaskInfo {
  taskId: string;
  phase: string;
  startedAt: string;
  state: AgentRuntimeState;
  lastOutputAt?: string;
  suspendedAt?: string;
  suspendReason?: AgentSuspendReason;
  /** Per-agent ID when multi-angle review (e.g. taskId--review--security). */
  id?: string;
  /** Display name when multi-angle review (e.g. "Reviewer (Security)"). */
  name?: string;
}

export const TASKS_IN_FLIGHT_KEY = "tasksInFlightCount" as const;

export const EXECUTE_ASYNC_KEYS = [
  "tasks",
  "status",
  "taskDetail",
  "archived",
  "markDone",
  "unblock",
  "activeAgents",
] as const;
export type ExecuteAsyncKey = (typeof EXECUTE_ASYNC_KEYS)[number];

export interface ExecuteState {
  /** Tasks keyed by ID — duplicates impossible. */
  tasksById: Record<string, Task>;
  /** Ordered task IDs for display. */
  taskIdsOrder: string[];
  [TASKS_IN_FLIGHT_KEY]: number;
  orchestratorRunning: boolean;
  awaitingApproval: boolean;
  /** Active tasks being worked on by orchestrator agents (v2 multi-slot) */
  activeTasks: ActiveTaskInfo[];
  /** Full active agents from fetchActiveAgents (for ActiveAgentsList, AgentDashboard) */
  activeAgents: ActiveAgent[];
  /** True after first fetchActiveAgents completes (fulfilled or rejected) — used to avoid showing "No agents running" during initial load */
  activeAgentsLoadedOnce: boolean;
  /** taskId -> startedAt for agents in coding/review (from fetchActiveAgents) */
  taskIdToStartedAt: Record<string, string>;
  /** Orchestrator stats (from fetchExecuteStatus) */
  totalDone: number;
  totalFailed: number;
  queueDepth: number;
  baselineStatus: BaselineRuntimeStatus;
  baselineCheckedAt: string | null;
  baselineFailureSummary: string | null;
  mergeValidationStatus: MergeValidationRuntimeStatus;
  mergeValidationFailureSummary: string | null;
  dispatchPausedReason: string | null;
  /** True when a self-improvement run is in progress (from execute status / WebSocket) */
  selfImprovementRunInProgress: boolean;
  selectedTaskId: string | null;
  agentOutput: Record<string, string[]>;
  completionStateByTaskId: Record<
    string,
    {
      status: string;
      testResults: { passed: number; failed: number; skipped: number; total: number } | null;
      reason?: string | null;
    }
  >;
  archivedSessions: AgentSession[];
  async: AsyncStates<ExecuteAsyncKey>;
  /** Last error from any async operation (for backward compat / display) */
  error: string | null;
  /** Task ID for which priority update is in flight (for loading state) */
  priorityUpdatePendingTaskId: string | null;
}

export const initialExecuteState: ExecuteState = {
  tasksById: {},
  taskIdsOrder: [],
  [TASKS_IN_FLIGHT_KEY]: 0,
  orchestratorRunning: false,
  awaitingApproval: false,
  activeTasks: [],
  activeAgents: [],
  activeAgentsLoadedOnce: false,
  taskIdToStartedAt: {},
  totalDone: 0,
  totalFailed: 0,
  queueDepth: 0,
  baselineStatus: "unknown",
  baselineCheckedAt: null,
  baselineFailureSummary: null,
  mergeValidationStatus: "healthy",
  mergeValidationFailureSummary: null,
  dispatchPausedReason: null,
  selfImprovementRunInProgress: false,
  selectedTaskId: null,
  agentOutput: {},
  completionStateByTaskId: {},
  archivedSessions: [],
  async: createInitialAsyncStates(EXECUTE_ASYNC_KEYS),
  error: null,
  priorityUpdatePendingTaskId: null,
};

/** State shape for selectors (execute may be missing in tests). */
export type ExecuteRootState = { execute?: ExecuteState };

/** Max chunks to retain per task (configurable; reduced for memory). */
export const MAX_AGENT_OUTPUT = 2000;
