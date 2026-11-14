export type Role = "view" | "discuss" | "steer" | "admin";

export type WorkStatus = "queued" | "ready" | "running" | "needs_human" | "held" | "done";

export type RunState =
  | "assigned"
  | "running"
  | "verifying"
  | "gating"
  | "integrating"
  | "done"
  | "needs_human"
  | "held";

export type RunRole = "discovery" | "planner" | "worker";

export type GovernanceMode = "disabled" | "shadow" | "enforced";

export type ResultStatus = "succeeded" | "failed" | "needs_human";

export interface RunbookCommand {
  argv: string[];
  cwd: string;
  timeoutSec: number;
  env?: string[];
}

export interface RunbookGate extends RunbookCommand {
  id: string;
  required: boolean;
}

export interface RunbookDocument {
  version: 1;
  install: RunbookCommand | null;
  health: RunbookCommand | null;
  gates: RunbookGate[];
  ship: null;
  runtimeTools: string[];
  dependencyPaths: string[];
  blockedPaths: string[];
}

export interface AgentRuntime {
  argv: string[];
  timeoutSec: number;
}

export interface CredentialSecret {
  type: "none" | "https_token";
  username?: string;
  token?: string;
  env?: Record<string, string>;
}

export interface EvidenceItem {
  command: string;
  exitCode: number;
  excerpt: string;
}

export interface PlannedWorkItem {
  title: string;
  body: string;
  dependsOn: string[];
}

export interface ResultFile {
  status: ResultStatus;
  summary: string;
  evidence: EvidenceItem[];
  questions: string[];
  runbookProposal?: RunbookDocument;
  workItems?: PlannedWorkItem[];
  unrecognizedStatus?: boolean;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
}

export interface TeamRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface MembershipRecord {
  teamId: string;
  userId: string;
  role: Role;
  createdAt: string;
}

export interface InviteRecord {
  id: string;
  teamId: string;
  role: Role;
  tokenHash: string;
  createdBy: string;
  acceptedBy: string | null;
  createdAt: string;
  acceptedAt: string | null;
}

export interface ProjectRecord {
  id: string;
  teamId: string;
  name: string;
  remoteUrl: string;
  baseBranch: string;
  runtime: AgentRuntime;
  credentialId: string | null;
  governanceMode: GovernanceMode;
  runbookLocked: boolean;
  activeRunbookDigest: string | null;
  shadowRecord: boolean;
  evolveCursor: string;
  createdAt: string;
}

export interface FrameRecord {
  projectId: string;
  version: number;
  markdown: string;
  createdBy: string;
  createdAt: string;
}

export interface WorkItemRecord {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  body: string;
  status: WorkStatus;
  ownerUserId: string | null;
  frameVersion: number | null;
  scopePaths: string[];
  blockedReason: string | null;
  shipCommit: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DependencyRecord {
  projectId: string;
  workItemId: string;
  dependsOnId: string;
}

export interface ThreadEntryRecord {
  id: string;
  threadId: string;
  cursor: number;
  authorId: string;
  kind: "post" | "guidance";
  body: string;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface ThreadRecord {
  id: string;
  projectId: string;
  workItemId: string;
  cursor: number;
}

export interface RunRecord {
  id: string;
  projectId: string;
  workItemId: string | null;
  attempt: number;
  state: RunState;
  role: RunRole;
  runbookDigest: string | null;
  executionContractHash: string | null;
  baseRevision: string | null;
  frameVersion: number | null;
  pid: number | null;
  heartbeatAt: string | null;
  controllerUserId: string | null;
  controlRevision: number;
  policyRule: string | null;
  retryCount: number;
  verifyHealCount: number;
  codeRetryCount: number;
  failureSignature: string | null;
  guidance: string[];
  answers: string[];
  failureNote: string | null;
  midTurn: string | null;
  toolBindings: Record<string, string>;
  runtimeArgv: string[];
  resultStatus: string | null;
  resultSummary: string | null;
  evidence: EvidenceItem[];
  questions: string[];
  worktreePath: string | null;
  assignmentPath: string | null;
  patchHash: string | null;
  policyPinId: string | null;
  slotReleased: boolean;
  gateEvaluated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RunbookRevisionRecord {
  id: string;
  projectId: string;
  digest: string;
  document: RunbookDocument;
  status: "proposed" | "active" | "rejected" | "archived";
  probe: EvidenceItem[];
  createdAt: string;
}

export interface PolicyRuleRecord {
  id: string;
  releaseId: string;
  ruleKey: string;
  revision: number;
  text: string;
  detector: string;
  paths: string[];
}

export interface PolicyReleaseRecord {
  id: string;
  projectId: string;
  version: number;
  contentHash: string;
  status: "active" | "archived";
  createdAt: string;
  activatedAt: string | null;
}

export interface PolicyPinRecord {
  id: string;
  runId: string;
  releaseId: string;
  instructionSnapshot: string;
  originalScope: string;
  baseRevision: string;
  createdAt: string;
}

export interface FindingRecord {
  id: string;
  projectId: string;
  runId: string;
  workItemId: string;
  kind: "standard" | "defect";
  ruleKey: string | null;
  ruleRevision: number | null;
  evidence: string;
  status: string;
  appeal: AppealRecord | null;
  judge: { decision: "uphold" | "dismiss"; rationale: string } | null;
  createdAt: string;
}

export interface AppealRecord {
  alternatives: string;
  evidence: string;
  risks: string;
  limits: string;
}

export interface CaseRecord {
  id: string;
  projectId: string;
  findingId: string | null;
  workItemId: string | null;
  runId: string | null;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RulingRecord {
  id: string;
  caseId: string;
  projectId: string;
  decision: string;
  rationale: string;
  allowance: Record<string, unknown> | null;
  patchHash: string | null;
  ruleKey: string | null;
  createdBy: string;
  createdAt: string;
}

export interface AllowanceRecord {
  id: string;
  projectId: string;
  releaseId: string;
  ruleKey: string;
  kind: "once" | "reusable";
  patchHash: string | null;
  paths: string[];
  expiresAt: string | null;
  used: boolean;
  createdAt: string;
}

export interface ScopeGrantRecord {
  id: string;
  projectId: string;
  workItemId: string;
  paths: string[];
  createdAt: string;
}

export interface NominationRecord {
  id: string;
  projectId: string;
  releaseId: string;
  ruleKey: string;
  status: string;
  supporting: unknown[];
  contrary: unknown[];
  createdAt: string;
}

export interface ProposalRecord {
  id: string;
  nominationId: string;
  projectId: string;
  ruleKey: string;
  text: string;
  detector: string;
  paths: string[];
  authorKind: "person" | "drafter";
  createdAt: string;
}

export interface EvaluationRecord {
  id: string;
  proposalId: string;
  status: "complete" | "incomplete";
  report: Record<string, unknown>;
  createdAt: string;
}

export const HEARTBEAT_MS = 2 * 60 * 1000;
export const WALL_CLOCK_MS = 60 * 60 * 1000;
export const PLATFORM_RULE_KEY = "protected-path";

export const PLATFORM_PROMPT =
  "You are the Open Sprint worker. Finish by writing the result file named by the environment. status is succeeded, failed, or needs_human. Include a summary and evidence with a command, an exit code, and a short excerpt. Ask a person when the repository contradicts the runbook. You have no push, merge, or deploy credential. Leave blocked paths untouched. The server grades the gates. Your result only admits the run to verification.";
