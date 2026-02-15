/** Supported agent backends */
export type AgentType = 'claude' | 'cursor' | 'custom';

/** Agent execution phase */
export type AgentPhase = 'coding' | 'review';

/** Agent session status */
export type AgentSessionStatus =
  | 'success'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'approved'
  | 'rejected';

/** Configuration for an active task directory (.opensprint/active/<task-id>/config.json) */
export interface ActiveTaskConfig {
  taskId: string;
  repoPath: string;
  branch: string;
  testCommand: string;
  attempt: number;
  phase: AgentPhase;
  previousFailure: string | null;
  reviewFeedback: string | null;
}

/** Agent session record (.opensprint/sessions/<task-id>-<attempt>.json) */
export interface AgentSession {
  taskId: string;
  attempt: number;
  agentType: AgentType;
  agentModel: string;
  startedAt: string;
  completedAt: string | null;
  status: AgentSessionStatus;
  outputLog: string;
  gitBranch: string;
  gitDiff: string | null;
  testResults: TestResults | null;
  failureReason: string | null;
  /** Coding agent summary (for approved sessions); used for dependency context propagation (PRD §7.3.2) */
  summary?: string;
}

/** Test execution results */
export interface TestResults {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  details: TestResultDetail[];
}

/** Individual test result */
export interface TestResultDetail {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  error?: string;
}

/** Coding agent result (result.json) */
export interface CodingAgentResult {
  status: 'success' | 'failed' | 'partial';
  summary: string;
  filesChanged: string[];
  testsWritten: number;
  testsPassed: number;
  notes: string;
}

/** Review agent result (result.json) */
export interface ReviewAgentResult {
  status: 'approved' | 'rejected';
  summary: string;
  issues?: string[];
  notes: string;
}

/** Union type for agent results */
export type AgentResult = CodingAgentResult | ReviewAgentResult;

/** Active agent (from GET /projects/:id/agents/active) */
export interface ActiveAgent {
  id: string;
  phase: string;
  label: string;
  startedAt: string;
}

/** Build orchestrator status */
export interface OrchestratorStatus {
  running: boolean;
  currentTask: string | null;
  currentPhase: AgentPhase | null;
  queueDepth: number;
  totalCompleted: number;
  totalFailed: number;
  /** True when paused waiting for HIL approval (PRD §6.5) */
  awaitingApproval?: boolean;
}
