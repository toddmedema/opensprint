/** OpenSprint directory within project repos */
export const OPENSPRINT_DIR = ".opensprint";

/** Paths within the .opensprint directory (repo and runtime). Settings live in global store (~/.opensprint/settings.json). Feedback, inbox, agent stats, event log, orchestrator counters, and deployments are now DB-only; no file paths. */
export const OPENSPRINT_PATHS = {
  prd: `${OPENSPRINT_DIR}/prd.json`,
  plans: `${OPENSPRINT_DIR}/plans`,
  planningRuns: `${OPENSPRINT_DIR}/planning-runs`,
  conversations: `${OPENSPRINT_DIR}/conversations`,
  /** Session log/diff files under runtime dir; session metadata is in DB (agent_sessions). */
  sessions: `${OPENSPRINT_DIR}/sessions`,
  active: `${OPENSPRINT_DIR}/active`,
  pendingCommits: `${OPENSPRINT_DIR}/pending-commits.json`,
  heartbeat: "heartbeat.json",
  agentOutputLog: "agent-output.log",
  assignment: "assignment.json",
} as const;

/** Heartbeat interval in milliseconds (10 seconds) */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Heartbeat considered stale after 2 minutes of no updates */
export const HEARTBEAT_STALE_MS = 2 * 60 * 1000;

/** Agent timeout in milliseconds (10 minutes of inactivity) */
export const AGENT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

/** Number of consecutive failures before priority demotion (PRDv2 §9.1) */
export const BACKOFF_FAILURE_THRESHOLD = 3;

/** Maximum task priority value; tasks at this level get blocked on next demotion (PRDv2 §9.1) */
export const MAX_PRIORITY_BEFORE_BLOCK = 4;

/** Block reasons that indicate technical errors (merge failure, coding failure). Tasks with these can be auto-retried. */
export const TECHNICAL_BLOCK_REASONS = ["Merge Failure", "Coding Failure"] as const;

/** Interval for auto-retrying tasks blocked by technical errors (8 hours) */
export const AUTO_RETRY_BLOCKED_INTERVAL_MS = 8 * 60 * 60 * 1000;

/** True if block_reason indicates a technical error (auto-retriable); false for human-feedback blocks. */
export function isBlockedByTechnicalError(blockReason: string | null | undefined): boolean {
  if (!blockReason || typeof blockReason !== "string") return false;
  return (TECHNICAL_BLOCK_REASONS as readonly string[]).includes(blockReason);
}

/**
 * Summarizer: invoke when task has more than this many dependencies (PRD §7.3.2, §12.3.5).
 */
export const SUMMARIZER_DEPENDENCY_THRESHOLD = 5;

/**
 * Summarizer: invoke when Plan exceeds this many words (PRD §7.3.2, §12.3.5).
 */
export const SUMMARIZER_PLAN_WORD_THRESHOLD = 5000;

/** Default API port */
export const DEFAULT_API_PORT = 3100;

/** API version prefix */
export const API_PREFIX = "/api/v1";

/** Plan status display order (planning → building → complete) */
export const PLAN_STATUS_ORDER: Record<"planning" | "building" | "complete", number> = {
  planning: 0,
  building: 1,
  complete: 2,
};

/** Task priority labels */
export const PRIORITY_LABELS: Record<number, string> = {
  0: "Critical",
  1: "High",
  2: "Medium",
  3: "Low",
  4: "Lowest",
};

/** Test framework options for setup (PRD §8.3, §10.2) */
export const TEST_FRAMEWORKS = [
  { id: "jest", label: "Jest", command: "npm test" },
  { id: "vitest", label: "Vitest", command: "npx vitest run" },
  { id: "playwright", label: "Playwright", command: "npx playwright test" },
  { id: "cypress", label: "Cypress", command: "npx cypress run" },
  { id: "pytest", label: "pytest", command: "pytest" },
  { id: "mocha", label: "Mocha", command: "npm test" },
  { id: "none", label: "None / Configure later", command: "" },
] as const;

/** Get test command for a framework id, or empty string for none */
export function getTestCommandForFramework(framework: string | null): string {
  if (!framework || framework === "none") return "";
  const found = TEST_FRAMEWORKS.find((f) => f.id === framework);
  return found?.command ?? "";
}

/** Resolve test command from settings: testCommand override, else framework-based, else default */
export function resolveTestCommand(settings: {
  testCommand?: string | null;
  testFramework?: string | null;
}): string {
  if (settings.testCommand?.trim()) return settings.testCommand.trim();
  const fromFramework = getTestCommandForFramework(settings.testFramework ?? null);
  if (fromFramework) return fromFramework;
  return "npm test";
}

// ─── Agent display names (orchestrator / task store / UI) ───

/** Coder agent names (Execute phase). Index must be fixed when the agent starts and stored (e.g. assignee); do not recompute from current position. */
export const AGENT_NAMES = [
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
] as const;

/** Returns the coder name for the given 0-based slot index; wraps with modulo (e.g. 13 → Frodo). */
export function getAgentName(slotIndex: number): string {
  const idx = slotIndex % AGENT_NAMES.length;
  return AGENT_NAMES[idx < 0 ? idx + AGENT_NAMES.length : idx]!;
}

/** Per-role display names. Use getAgentNameForRole(role, index); index must be fixed at agent start and stored, not derived from current position. */
export const AGENT_NAMES_BY_ROLE: Record<string, readonly string[]> = {
  coder: AGENT_NAMES,
  dreamer: ["Gandalf", "Saruman", "Radagast", "Pallando", "Alatar"],
  planner: ["Aragorn", "Théoden", "Thranduil", "Dáin Ironfoot", "Brand of Dale"],
  harmonizer: ["Elrond", "Galadriel", "Celeborn", "Arwen", "Círdan"],
  analyst: ["Faramir", "Halbarad", "Éomer", "Elladan", "Elrohir"],
  summarizer: ["Treebeard", "Quickbeam", "Leaflock", "Skinbark", "Beechbone"],
  auditor: ["Gimli", "Glóin", "Balin", "Dwalin", "Thorin"],
  reviewer: ["Boromir", "Imrahil", "Éowyn", "Beregond", "Húrin of the Keys"],
  merger: ["Gwaihir", "Landroval", "Meneldor", "Thorondor", "Sorontar"],
};

/** Returns the agent name for the given role and 0-based index; wraps with modulo. Unknown role falls back to coder list. */
export function getAgentNameForRole(role: string, slotIndex: number): string {
  const list = AGENT_NAMES_BY_ROLE[role] ?? AGENT_NAMES;
  const idx = slotIndex % list.length;
  return list[idx < 0 ? idx + list.length : idx]!;
}

/** All known agent display names (for task store: treat assignee as agent when in this set). */
const ALL_AGENT_NAMES = new Set<string>(
  Object.values(AGENT_NAMES_BY_ROLE).flatMap((arr) => [...arr])
);

/** True if assignee is a known agent display name (coder, reviewer, etc.). */
export function isAgentAssignee(assignee: string | null | undefined): boolean {
  return typeof assignee === "string" && ALL_AGENT_NAMES.has(assignee);
}
