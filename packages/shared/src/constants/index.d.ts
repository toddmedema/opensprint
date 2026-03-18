/** Maximum length for commit message title / task title display (e.g. "Closed <id>: <title>"). */
export declare const COMMIT_MESSAGE_TITLE_MAX_LENGTH = 45;
/** Open Sprint directory within project repos */
export declare const OPENSPRINT_DIR = ".opensprint";
/** Sketch phase output: flat markdown at repo root. Metadata (version, changeLog) in .opensprint. */
export declare const SPEC_MD = "SPEC.md";
export declare const SPEC_METADATA_PATH = ".opensprint/spec-metadata.json";
/** Paths within the .opensprint directory (repo and runtime). Settings live in global store (~/.opensprint/settings.json). Feedback, inbox, agent stats, event log, orchestrator counters, and deployments are now DB-only; no file paths. */
export declare const OPENSPRINT_PATHS: {
  /** @deprecated Use SPEC_MD. Legacy path for migration from prd.json. */
  readonly prd: ".opensprint/prd.json";
  readonly plans: ".opensprint/plans";
  readonly planningRuns: ".opensprint/planning-runs";
  readonly conversations: ".opensprint/conversations";
  /** Session log/diff files under runtime dir; session metadata is in DB (agent_sessions). */
  readonly sessions: ".opensprint/sessions";
  readonly active: ".opensprint/active";
  readonly agents: ".opensprint/agents";
  readonly pendingCommits: ".opensprint/pending-commits.json";
  readonly heartbeat: "heartbeat.json";
  readonly agentOutputLog: "agent-output.log";
  readonly assignment: "assignment.json";
};
/** Heartbeat interval in milliseconds (10 seconds) */
export declare const HEARTBEAT_INTERVAL_MS = 10000;
/** Heartbeat considered stale after 2 minutes of no updates */
export declare const HEARTBEAT_STALE_MS: number;
/** Agent timeout in milliseconds (10 minutes of inactivity) */
export declare const AGENT_INACTIVITY_TIMEOUT_MS: number;
/** How long a silent but still-live Execute agent may remain suspended before it is terminated. */
export declare const AGENT_SUSPEND_GRACE_MS: number;
/** Number of consecutive failures before priority demotion (PRDv2 §9.1) */
export declare const BACKOFF_FAILURE_THRESHOLD = 3;
/** Maximum task priority value; tasks at this level get blocked on next demotion (PRDv2 §9.1) */
export declare const MAX_PRIORITY_BEFORE_BLOCK = 4;
/** Block reasons that indicate technical errors. Tasks with these can be auto-retried. */
export declare const TECHNICAL_BLOCK_REASONS: readonly [
  "Merge Failure",
  "Quality Gate Failure",
  "Coding Failure",
];
/** Block reason when Coder emits open_questions (human clarification needed) */
export declare const OPEN_QUESTION_BLOCK_REASON = "Open Question";
/** Interval for auto-retrying tasks blocked by technical errors (8 hours) */
export declare const AUTO_RETRY_BLOCKED_INTERVAL_MS: number;
/** True if block_reason indicates a technical error (auto-retriable); false for human-feedback blocks. */
export declare function isBlockedByTechnicalError(blockReason: string | null | undefined): boolean;
/**
 * Summarizer: invoke when task has more than this many dependencies (PRD §7.3.2, §12.3.5).
 */
export declare const SUMMARIZER_DEPENDENCY_THRESHOLD = 5;
/**
 * Summarizer: invoke when Plan exceeds this many words (PRD §7.3.2, §12.3.5).
 */
export declare const SUMMARIZER_PLAN_WORD_THRESHOLD = 5000;
/** Default API port */
export declare const DEFAULT_API_PORT = 3100;
/** API version prefix */
export declare const API_PREFIX = "/api/v1";
/** Plan status display order (planning → building → in_review → complete) */
export declare const PLAN_STATUS_ORDER: Record<
  "planning" | "building" | "in_review" | "complete",
  number
>;
/** Task priority labels */
export declare const PRIORITY_LABELS: Record<number, string>;
/** Test framework options for setup (PRD §8.3, §10.2) */
export declare const TEST_FRAMEWORKS: readonly [
  {
    readonly id: "jest";
    readonly label: "Jest";
    readonly command: "npm test";
  },
  {
    readonly id: "vitest";
    readonly label: "Vitest";
    readonly command: "npx vitest run";
  },
  {
    readonly id: "playwright";
    readonly label: "Playwright";
    readonly command: "npx playwright test";
  },
  {
    readonly id: "cypress";
    readonly label: "Cypress";
    readonly command: "npx cypress run";
  },
  {
    readonly id: "pytest";
    readonly label: "pytest";
    readonly command: "pytest";
  },
  {
    readonly id: "mocha";
    readonly label: "Mocha";
    readonly command: "npm test";
  },
  {
    readonly id: "none";
    readonly label: "None / Configure later";
    readonly command: "";
  },
];
/** Get test command for a framework id, or empty string for none */
export declare function getTestCommandForFramework(framework: string | null): string;
/** Resolve test command from settings: testCommand override, else framework-based, else default */
export declare function resolveTestCommand(settings: {
  testCommand?: string | null;
  testFramework?: string | null;
}): string;
/** Coder agent names (Execute phase). Index must be fixed when the agent starts and stored (e.g. assignee); do not recompute from current position. */
export declare const AGENT_NAMES: readonly [
  "Frodo",
  "Samwise",
  "Meriadoc",
  "Peregrin",
  "Bilbo",
  "Rosie",
  "Lobelia",
  "Lotho",
  "Drogo",
  "Otho",
  "Ted",
  "Robin",
  "Will",
];
/** Returns the coder name for the given 0-based slot index; wraps with modulo (e.g. 13 → Frodo). */
export declare function getAgentName(slotIndex: number): string;
/** Per-role display names. Use getAgentNameForRole(role, index); index must be fixed at agent start and stored, not derived from current position. */
export declare const AGENT_NAMES_BY_ROLE: Record<string, readonly string[]>;
/** Returns the agent name for the given role and 0-based index; wraps with modulo. Unknown role falls back to coder list. */
export declare function getAgentNameForRole(role: string, slotIndex: number): string;
/** True if assignee is a known agent display name (coder, reviewer, etc.). */
export declare function isAgentAssignee(assignee: string | null | undefined): boolean;
//# sourceMappingURL=index.d.ts.map
