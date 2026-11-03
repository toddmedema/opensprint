import type {
  AgentRole,
  StructuredReviewFinding,
  ReviewAppeal,
  ReviewAgentResult,
} from "./agent.js";
import type { AgentConfig } from "./settings.js";

export type GovernanceMode = "disabled" | "shadow" | "enforced";
export interface GovernanceConfig {
  mode: GovernanceMode;
  version: number;
  judgeAgent?: AgentConfig | null;
  /** Read-only API model for reconsideration; independent of the initial reviewer and judge. */
  reconsiderationAgent?: AgentConfig | null;
  reconsiderationTokenPricing?: { inputPerMillionUsd: number; outputPerMillionUsd: number } | null;
  judgeTokenPricing?: { inputPerMillionUsd: number; outputPerMillionUsd: number } | null;
  maxAppeals: number;
  maxTokens: number;
  maxCostUsd: number;
  maxElapsedMs: number;
  contextMaxChars: number;
  recurrenceThreshold: number;
}
export interface PolicyRuleRevision {
  id: string;
  ruleId: string;
  revision: number;
  text: string;
  rationale: string;
  owner: string;
  paths: string[];
  components: string[];
  roles: AgentRole[];
  severity: "standard" | "constraint";
  mandatory: boolean;
  exceptionEligible: boolean;
  examples: { compliant: string[]; noncompliant: string[] };
  parentIds: string[];
  overrideIds: string[];
  conflictIds: string[];
  layer: number;
  sourceHash: string;
}
export interface PolicyRelease {
  id: string;
  projectId: string;
  rules: PolicyRuleRevision[];
  instructions: Partial<Record<AgentRole, string>>;
  sourceHashes: Record<string, string>;
  contentHash: string;
  enforcementRevision: string;
  createdAt: string;
  createdBy: string;
}
export interface PolicyContextReceipt {
  releaseId: string;
  role: AgentRole;
  changedPaths: string[];
  selected: { id: string; ruleId: string; sourceHash: string }[];
  excluded: { id: string; reason: string }[];
  conflicts: string[];
  truncated: boolean;
  contentHash: string;
}
export interface PolicyContext {
  content: string;
  receipt: PolicyContextReceipt;
}
export interface GovernanceTaskPin {
  projectId: string;
  taskId: string;
  releaseId: string;
  mode: GovernanceMode;
  baseSha: string;
  baseBranch?: string;
  mergeBaseSha?: string;
  trustedScope: string;
  instructionsByRole: Partial<Record<AgentRole, string>>;
  worktreePath: string;
  branchName: string;
  createdAt: string;
}
export type ReviewCaseState =
  | "awaiting_reconsideration"
  | "awaiting_judge"
  | "awaiting_human"
  | "evidence_requested"
  | "allowed"
  | "fix_required"
  | "cancelled"
  | "stale";
export type GovernanceDecisionAction =
  | "require_fix"
  | "allow_once"
  | "allow_reusable"
  | "request_evidence"
  | "cancel"
  /** Ends the work: the case stops holding its task, and the task closes unmerged. */
  | "abandon";
export interface PrecedentConditions {
  version: 1;
  paths: string[];
  ruleRevisionIds: string[];
  expiresAt: string;
}
export interface JudgeRecommendation {
  disposition: "finding_invalid" | "fix_required" | "exception_authorized" | "human_required";
  rationale: string;
  evidence: string[];
  ruleIds: string[];
  decisionIds: string[];
}
export interface ReviewCase {
  id: string;
  projectId: string;
  taskId: string;
  releaseId: string;
  /** Explicit human revalidation supersedes old-policy blockers, without approving code. */
  supersededByReleaseId?: string;
  /** Explicit human cancellation retains a hold until a safe human disposition. */
  humanCancelled?: boolean;
  abandoned?: boolean;
  /** Trusted origin proof established this artifact was already published; this is remediation evidence, never new authority. */
  publishedRemediationOnly?: boolean;
  state: ReviewCaseState;
  version: number;
  headSha: string;
  diffHash: string;
  baseSha: string;
  changedPaths: string[];
  title: string;
  summary: string;
  findings: StructuredReviewFinding[];
  appeals: ReviewAppeal[];
  evidence: Record<string, unknown>;
  evidenceHash: string;
  recommendation?: JudgeRecommendation;
  reconsideration?: ReviewAgentResult;
  verifiedDisposition?: {
    kind: "reviewer_withdrew" | "finding_not_applicable" | "precedent_applied" | "fix_required";
    decisionIds: string[];
  };
  worktreePath: string;
  branchName: string;
  createdAt: string;
  updatedAt: string;
}
/** A docket row. Evidence holds whole prompts and diffs, so it is fetched per selected case. */
export type ReviewCaseSummary = Omit<ReviewCase, "evidence">;
export interface PolicyDecision {
  id: string;
  projectId: string;
  caseId: string;
  taskId: string;
  releaseId: string;
  action: GovernanceDecisionAction;
  actor: string;
  rationale: string;
  headSha: string;
  diffHash: string;
  findingIds: string[];
  ruleRevisionIds: string[];
  conditions?: PrecedentConditions;
  createdAt: string;
  revokedAt?: string;
}
export interface GovernanceEvent {
  id: string;
  projectId: string;
  caseId?: string;
  kind: string;
  actor: string;
  createdAt: string;
  payload: Record<string, unknown>;
}
export interface PolicyRulePatch {
  ruleId: string;
  before: PolicyRuleRevision | null;
  after: PolicyRuleRevision | null;
}
/** Accept: the output must stand. Block or avoid: the known violation must not be accepted. */
export type ReplayExpectedOutcome = "accept" | "block_or_avoid";
/** One replayed fixture's bound identity and whether it actually exercised the amendment. */
export interface PolicyEvaluationFixtureCoverage {
  fixtureId: string;
  fixtureHash: string;
  taskId: string;
  label: string;
  expectedOutcome: ReplayExpectedOutcome;
  holdout: boolean;
  /** The task is cited by the amendment's own evidence, so it cannot count as held out. */
  evidenceTask: boolean;
  amendedRuleSelected: boolean;
  /** Rendered policy differs beyond release and revision identifiers. */
  contentDiffers: boolean;
}
export interface PolicyEvaluation {
  complete: boolean;
  passed: boolean;
  executor: string;
  fixtureIds: string[];
  heldOutCount: number;
  positiveCount: number;
  negativeCount: number;
  fixtureCoverage: PolicyEvaluationFixtureCoverage[];
  /** Server-measured values only; image-reported usage is labeled and never gates activation. */
  baseline: Record<string, number>;
  candidate: Record<string, number>;
  artifactHash: string;
  releaseContentHash: string;
  measuredAt: string;
}
export interface PolicyProposal {
  id: string;
  projectId: string;
  baseReleaseId: string;
  sourceNominationId?: string;
  /** Set on mined nominations: the only rule revision a Congress draft may change. */
  nominatedRuleRevisionId?: string;
  state: "nominated" | "draft" | "evaluated" | "activated" | "rejected";
  version: number;
  title: string;
  rationale: string;
  patches: PolicyRulePatch[];
  instructions?: Partial<Record<AgentRole, string>>;
  sourceHashes?: Record<string, string>;
  supportingDecisionIds: string[];
  contraryDecisionIds: string[];
  /** Advisory review/fix signals; these never grant reusable exception authority. */
  supportingEventIds?: string[];
  contraryEventIds?: string[];
  scope: string;
  compatibility: string;
  enforcementRevision: string;
  positiveExamples: string[];
  negativeExamples: string[];
  evaluation?: PolicyEvaluation;
  createdAt: string;
}
export interface GovernanceSummary {
  config: GovernanceConfig;
  activeReleaseId: string | null;
  rules: PolicyRuleRevision[];
  releases: PolicyRelease[];
  cases: ReviewCaseSummary[];
  decisions: PolicyDecision[];
  proposals: PolicyProposal[];
  events: GovernanceEvent[];
  authority: { configured: boolean; owner?: string };
}
export interface ResolveGovernanceCaseInput {
  expectedVersion: number;
  idempotencyKey: string;
  action: GovernanceDecisionAction;
  rationale: string;
  headSha: string;
  diffHash: string;
  conditions?: PrecedentConditions;
}
