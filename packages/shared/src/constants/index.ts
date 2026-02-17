/** OpenSprint directory within project repos */
export const OPENSPRINT_DIR = ".opensprint";

/** Paths within the .opensprint directory */
export const OPENSPRINT_PATHS = {
  prd: `${OPENSPRINT_DIR}/prd.json`,
  plans: `${OPENSPRINT_DIR}/plans`,
  planningRuns: `${OPENSPRINT_DIR}/planning-runs`,
  conversations: `${OPENSPRINT_DIR}/conversations`,
  sessions: `${OPENSPRINT_DIR}/sessions`,
  feedback: `${OPENSPRINT_DIR}/feedback`,
  active: `${OPENSPRINT_DIR}/active`,
  settings: `${OPENSPRINT_DIR}/settings.json`,
  orchestratorState: `${OPENSPRINT_DIR}/orchestrator-state.json`,
  deployments: `${OPENSPRINT_DIR}/deployments`,
  heartbeat: "heartbeat.json",
} as const;

/** Heartbeat interval in milliseconds (10 seconds) */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Heartbeat considered stale after 2 minutes of no updates */
export const HEARTBEAT_STALE_MS = 2 * 60 * 1000;

/** Agent timeout in milliseconds (10 minutes of inactivity) */
export const AGENT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

/** Number of consecutive failures before priority demotion (PRDv2 §9.1) */
export const BACKOFF_FAILURE_THRESHOLD = 3;

/** Maximum beads priority value; tasks at this level get blocked on next demotion (PRDv2 §9.1) */
export const MAX_PRIORITY_BEFORE_BLOCK = 4;

/** Summarizer: invoke when task has more than this many dependencies (PRD §7.3.2, §12.3.5) */
export const SUMMARIZER_DEPENDENCY_THRESHOLD = 2;

/** Summarizer: invoke when Plan exceeds this many words (PRD §7.3.2, §12.3.5) */
export const SUMMARIZER_PLAN_WORD_THRESHOLD = 2000;

/** Default API port */
export const DEFAULT_API_PORT = 3100;

/** API version prefix */
export const API_PREFIX = "/api/v1";

/** Kanban columns in display order */
export const KANBAN_COLUMNS = [
  "planning",
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "blocked",
] as const;

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
