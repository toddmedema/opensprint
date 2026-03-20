import type { ReviewAngle } from "./settings.js";

/** Supported agent backends */
export type AgentType =
  | "claude"
  | "claude-cli"
  | "cursor"
  | "custom"
  | "openai"
  | "google"
  | "lmstudio";

/** Named agent roles (PRD §6.3, §12). Planning slot: dreamer–auditor. Coding slot: coder, reviewer. */
export type AgentRole =
  | "dreamer"
  | "planner"
  | "harmonizer"
  | "analyst"
  | "summarizer"
  | "auditor"
  | "coder"
  | "reviewer"
  | "merger";

/** Agent slot: Planning (concurrent) or Coding (single task slot; review can fan out per angle) */
export type AgentSlot = "planning" | "coding";

/** Map role to slot */
export function getSlotForRole(role: AgentRole): AgentSlot {
  return role === "coder" || role === "reviewer" || role === "merger" ? "coding" : "planning";
}

/**
 * Canonical display order for agent roles (README/PRD §6.3 Named Agent Roles table).
 * Used to sort agent icons in the 'Agents Running' indicator and dropdown.
 */
export const AGENT_ROLE_CANONICAL_ORDER: readonly AgentRole[] = [
  "dreamer",
  "planner",
  "harmonizer",
  "analyst",
  "summarizer",
  "auditor",
  "coder",
  "reviewer",
  "merger",
] as const;

/** Index of role in canonical order; unknown roles sort last. */
function getRoleSortIndex(roleOrPhase: string): number {
  const idx = AGENT_ROLE_CANONICAL_ORDER.indexOf(roleOrPhase as AgentRole);
  return idx >= 0 ? idx : AGENT_ROLE_CANONICAL_ORDER.length;
}

/** Resolve agent to a role string for sorting (role or phase-derived). */
function getSortRole(agent: { role?: AgentRole; phase?: string }): string {
  if (agent.role && AGENT_ROLE_CANONICAL_ORDER.includes(agent.role)) return agent.role;
  if (agent.phase === "review") return "reviewer";
  if (agent.phase === "coding") return "coder";
  return agent.phase ?? "";
}

/** Sort agents by canonical role order (README/PRD table). */
export function sortAgentsByCanonicalOrder<T>(
  list: T[],
  getAgent?: (item: T) => { role?: AgentRole; phase?: string }
): T[] {
  const toRole = (item: T) =>
    getSortRole(getAgent ? getAgent(item) : (item as { role?: AgentRole; phase?: string }));
  return [...list].sort((a, b) => {
    const ra = toRole(a);
    const rb = toRole(b);
    const ia = getRoleSortIndex(ra);
    const ib = getRoleSortIndex(rb);
    if (ia !== ib) return ia - ib;
    return ra.localeCompare(rb);
  });
}

/** Phase string to display label (for agents without a known role) */
const PHASE_LABELS: Record<string, string> = {
  spec: "Sketch",
  plan: "Plan",
  execute: "Execute",
  eval: "Evaluate",
  deliver: "Deliver",
  coding: "Coding",
  review: "Review",
};

/**
 * Role display label for dropdown: "Coder (Frodo)" when name present, else "Coder".
 * Uses AGENT_ROLE_LABELS when role is known; otherwise phase label.
 */
export function getRoleDisplayLabel(agent: {
  role?: AgentRole;
  phase?: string;
  name?: string;
}): string {
  const roleLabel =
    agent.role && agent.role in AGENT_ROLE_LABELS
      ? AGENT_ROLE_LABELS[agent.role as keyof typeof AGENT_ROLE_LABELS]
      : ((agent.phase && PHASE_LABELS[agent.phase]) ?? agent.phase ?? "");
  return agent.name?.trim() ? `${roleLabel} (${agent.name.trim()})` : roleLabel;
}

/** Human-readable display label for each role */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  dreamer: "Dreamer",
  planner: "Planner",
  harmonizer: "Harmonizer",
  analyst: "Analyst",
  summarizer: "Summarizer",
  auditor: "Auditor",
  coder: "Coder",
  reviewer: "Reviewer",
  merger: "Merger",
};

/**
 * Primary phase(s) for each agent role (README/PRD §6.3).
 * Used in Agent reference modal and phase badges.
 */
export const AGENT_ROLE_PHASES: Record<AgentRole, readonly string[]> = {
  dreamer: ["Sketch"],
  planner: ["Plan"],
  harmonizer: ["All"],
  analyst: ["Evaluate"],
  summarizer: ["Execute"],
  auditor: ["Execute"],
  coder: ["Execute"],
  reviewer: ["Execute"],
  merger: ["Execute"],
};

/**
 * Short description for each agent role (~1 sentence for modal).
 * Matches README table (docs/assets or README.md); single source of truth for Agent reference.
 */
export const AGENT_ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  dreamer: "Refines your idea into a PRD; asks the hard questions before the journey begins.",
  planner: "Decomposes the PRD into epics, tasks, and dependency graph.",
  harmonizer: "Keeps the PRD true as implementation forces compromises.",
  analyst: "Categorizes feedback and maps it to the right epic.",
  summarizer: "Distills context to exactly what the Coder needs.",
  auditor: "Surveys what's actually built and what still needs doing.",
  coder: "Implements tasks and ships working code with tests.",
  reviewer: "Validates implementation against acceptance criteria.",
  merger: "Resolves rebase conflicts and keeps the journey moving.",
};

/** Agent execution phase (coding vs review sub-phase within Execute) */
export type AgentPhase = "coding" | "review";

/** Runtime state for an active Execute agent. */
export type AgentRuntimeState = "running" | "suspended";

/** Why an active Execute agent is currently suspended. */
export type AgentSuspendReason = "heartbeat_gap" | "output_gap" | "backend_restart";

/** Agent session status */
export type AgentSessionStatus =
  | "success"
  | "failed"
  | "timeout"
  | "cancelled"
  | "approved"
  | "rejected";

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
  /** Condensed test diagnostics from the previous failed attempt */
  previousTestOutput?: string | null;
  /** Concise highlighted failures from the previous orchestrator-owned test run */
  previousTestFailures?: string | null;
  /** Git diff from the previous attempt (when branch was preserved) */
  previousDiff?: string | null;
  /** Structured quality-gate diagnostics from the previous merge attempt, when available */
  qualityGateDetail?: {
    command?: string | null;
    reason?: string | null;
    outputSnippet?: string | null;
    worktreePath?: string | null;
    firstErrorLine?: string | null;
    category?: "quality_gate" | "environment_setup" | null;
    validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root" | null;
    repairAttempted?: boolean;
    repairSucceeded?: boolean;
    executable?: string | null;
    cwd?: string | null;
    exitCode?: number | null;
    signal?: string | null;
  } | null;
  /** Whether this retry reuses an existing branch with prior commits */
  useExistingBranch?: boolean;
  /** True when this rerun exists only to repair invalid structured output from the previous attempt. */
  structuredOutputRepairAttempted?: boolean;
  /** Human-in-the-loop config: agents use this to know when to ask (confirm all vs major only vs full autonomy) */
  hilConfig?: {
    scopeChanges: string;
    architectureDecisions: string;
    dependencyModifications: string;
  };
  /** AI Autonomy level (confirm_all | major_only | full): human-readable rule for when to emit open_questions */
  aiAutonomyLevel?: "confirm_all" | "major_only" | "full";
  /** Selected review angles for the review agent (security, performance, etc.). When empty, all angles are covered. */
  reviewAngles?: ReviewAngle[];
  /** When true with reviewAngles non-empty, run one general review plus one per angle. */
  includeGeneralReview?: boolean;
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
  status: "passed" | "failed" | "skipped";
  duration: number;
  error?: string;
}

/** Open question item in agent output (agent question protocol) */
export interface AgentOpenQuestion {
  id: string;
  text: string;
  createdAt?: string;
}

/** Coding agent result (result.json) */
export interface CodingAgentResult {
  status: "success" | "failed" | "partial";
  summary: string;
  filesChanged: string[];
  testsWritten: number;
  testsPassed: number;
  notes: string;
  /** When task spec is ambiguous: emit questions and pause rather than guessing (agent question protocol) */
  open_questions?: AgentOpenQuestion[];
  openQuestions?: AgentOpenQuestion[];
}

/** Review agent result (result.json) */
export interface ReviewAgentResult {
  status: "approved" | "rejected";
  summary: string;
  issues?: string[];
  notes: string;
}

/** Union type for agent results */
export type AgentResult = CodingAgentResult | ReviewAgentResult;

/** Active agent (from GET /projects/:id/agents/active) */
export interface ActiveAgent {
  id: string;
  /** Owning task ID for Execute agents (when id is a per-agent runtime ID). */
  taskId?: string;
  phase: string;
  /** Named agent role (e.g. coder, reviewer) */
  role: AgentRole;
  label: string;
  startedAt: string;
  /** Branch name (Execute phase only) */
  branchName?: string;
  /** Plan ID when agent is working in plan context (e.g. Planner for a specific plan); use for deep link to Plan details */
  planId?: string;
  /** Optional agent instance name (e.g. "Frodo"); shown in dropdown as "Coder (Frodo)" when present */
  name?: string;
  /** Feedback ID when Analyst is categorizing a specific feedback item; use for deep link to Evaluate page */
  feedbackId?: string;
  /** Runtime status for Execute agents. Planning agents remain "running". */
  state?: AgentRuntimeState;
  /** ISO timestamp of the last observed output chunk. */
  lastOutputAt?: string;
  /** ISO timestamp when the agent entered suspended state. */
  suspendedAt?: string;
  /** Why the agent is currently suspended. */
  suspendReason?: AgentSuspendReason;
}

/** Feedback item awaiting categorization (PRDv2 §5.8) */
export interface PendingFeedbackCategorization {
  feedbackId: string;
  category?: string;
}

/** Active task entry within OrchestratorStatus (v2 multi-slot model) */
export interface ActiveTaskEntry {
  taskId: string;
  phase: AgentPhase;
  startedAt: string;
  state: AgentRuntimeState;
  lastOutputAt?: string;
  suspendedAt?: string;
  suspendReason?: AgentSuspendReason;
  /** Per-agent ID when multi-angle review (e.g. taskId--review--security). Enables UI to distinguish parallel reviewers. */
  id?: string;
  /** Display name when multi-angle review (e.g. "Reviewer (Security)"). */
  name?: string;
}

export type BaselineRuntimeStatus = "unknown" | "checking" | "healthy" | "failing";
export type MergeValidationRuntimeStatus = "healthy" | "degraded";

/** Build orchestrator status (always-on per PRDv2 §5.7, v2 multi-slot model) */
export interface OrchestratorStatus {
  activeTasks: ActiveTaskEntry[];
  queueDepth: number;
  totalDone: number;
  totalFailed: number;
  /** Project-wide baseline merge-gate runtime status. */
  baselineStatus?: BaselineRuntimeStatus;
  /** Last time baseline status was checked (ISO string). */
  baselineCheckedAt?: string | null;
  /** Short summary for the current baseline failure, if any. */
  baselineFailureSummary?: string | null;
  /** Project-wide merge-validation health (separate from baseline health). */
  mergeValidationStatus?: MergeValidationRuntimeStatus;
  /** Short summary for the current merge-validation health issue, if any. */
  mergeValidationFailureSummary?: string | null;
  /** Short reason for why dispatch is paused, if any. */
  dispatchPausedReason?: string | null;
  /** True when paused waiting for HIL approval (PRD §6.5) */
  awaitingApproval?: boolean;
  /** Path to active task's git worktree (null when idle) */
  worktreePath?: string | null;
  /** Feedback items awaiting categorization */
  pendingFeedbackCategorizations?: PendingFeedbackCategorization[];
  /** True when a self-improvement run is in progress for this project */
  selfImprovementRunInProgress?: boolean;
}
