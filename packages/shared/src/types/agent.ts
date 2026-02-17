/** Supported agent backends */
export type AgentType = 'claude' | 'cursor' | 'custom';

/** Named agent roles (PRD §6.3, §12). Planning slot: dreamer–delta_planner. Coding slot: coder, reviewer. */
export type AgentRole =
  | 'dreamer'
  | 'planner'
  | 'harmonizer'
  | 'analyst'
  | 'summarizer'
  | 'auditor'
  | 'delta_planner'
  | 'coder'
  | 'reviewer';

/** Agent slot: Planning (concurrent) or Coding (single-agent per project) */
export type AgentSlot = 'planning' | 'coding';

/** Map role to slot */
export function getSlotForRole(role: AgentRole): AgentSlot {
  return role === 'coder' || role === 'reviewer' ? 'coding' : 'planning';
}

/** Human-readable display label for each role */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  dreamer: 'Dreamer',
  planner: 'Planner',
  harmonizer: 'Harmonizer',
  analyst: 'Analyst',
  summarizer: 'Summarizer',
  auditor: 'Auditor',
  delta_planner: 'Delta Planner',
  coder: 'Coder',
  reviewer: 'Reviewer',
};

/** Agent execution phase (coding vs review sub-phase within Execute) */
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
  /** Unique invocation ID (PRD §12.2) */
  invocation_id: string;
  /** Named agent role (PRD §12.2) */
  agent_role: AgentRole;
  taskId: string;
  repoPath: string;
  branch: string;
  testCommand: string;
  attempt: number;
  phase: AgentPhase;
  previousFailure: string | null;
  reviewFeedback: string | null;
  /** Full test runner output from the previous failed attempt */
  previousTestOutput?: string | null;
  /** Git diff from the previous attempt (when branch was preserved) */
  previousDiff?: string | null;
  /** Whether this retry reuses an existing branch with prior commits */
  useExistingBranch?: boolean;
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
  /** Named agent role (e.g. coder, reviewer) */
  role: AgentRole;
  label: string;
  startedAt: string;
  /** Branch name (Execute phase only) */
  branchName?: string;
}

/** Build orchestrator status (always-on per PRDv2 §5.7) */
export interface OrchestratorStatus {
  currentTask: string | null;
  currentPhase: AgentPhase | null;
  queueDepth: number;
  totalDone: number;
  totalFailed: number;
  /** True when paused waiting for HIL approval (PRD §6.5) */
  awaitingApproval?: boolean;
}
