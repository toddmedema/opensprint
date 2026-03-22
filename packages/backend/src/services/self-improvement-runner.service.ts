/**
 * SelfImprovementRunnerService — runs a self-improvement review over the codebase and creates
 * improvement tasks. Builds context (SPEC.md, file tree), runs one review per lens (or one general
 * review when no lenses), parses agent output into tasks with source: 'self-improvement', and
 * updates last run timestamp only on success.
 */

import type { ReviewAngle } from "@opensprint/shared";
import { REVIEW_ANGLE_OPTIONS, clampTaskComplexity } from "@opensprint/shared";
import { getAgentForPlanningRole } from "@opensprint/shared";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";
import { PlanService } from "./plan.service.js";
import { ContextAssembler } from "./context-assembler.js";
import { updateSettingsInStore, getSettingsFromStore } from "./settings-store.service.js";
import type { ProjectSettings } from "@opensprint/shared";
import {
  extractJsonFromAgentResponse,
  extractJsonArrayFromAgentResponse,
} from "../utils/json-extract.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { createLogger } from "../utils/logger.js";
import { shellExec } from "../utils/shell-exec.js";
import { notificationService } from "./notification.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { invokeStructuredPlanningAgent } from "./structured-agent-output.service.js";

const log = createLogger("self-improvement-runner");

export interface ImprovementItem {
  title: string;
  description?: string;
  priority?: number;
  /** Task-level complexity 1-10 (1=simplest, 10=most complex). Assigned by AI. */
  complexity?: number;
}

/** Enriched item with AI-assigned priority/complexity. Used internally to skip tasks that would get defaults. */
export interface EnrichedImprovementItem extends ImprovementItem {
  /** True when priority and complexity came from AI (main or enrichment agent). False when defaults were used. */
  _aiAssigned?: boolean;
}

export interface RunSelfImprovementOptions {
  planId?: string;
  runId?: string;
  /** If provided, stored as selfImprovementLastCommitSha on success. If omitted, current HEAD is used. */
  lastCommitSha?: string;
  /** Caller context: 'scheduled' (daily/weekly tick) or 'after_each_plan'. */
  trigger?: "scheduled" | "after_each_plan";
}

/** Result of runSelfImprovement: success with counts or skip when run already in progress. */
export type RunSelfImprovementResult =
  | { tasksCreated: number; runId: string }
  | { tasksCreated: 0; skipped: "run_in_progress" };

const SELF_IMPROVEMENT_SYSTEM_PROMPT = `You are the Self-Improvement reviewer for Open Sprint. Your job is to review the codebase (SPEC, file tree, and key files) and produce a structured list of improvement tasks.

**CRITICAL:** Every improvement task MUST have both priority and complexity assigned by you. Tasks without these fields will not be created.

Output MUST be one of:

1. **JSON** — a single JSON array of improvement items. Each item MUST include priority and complexity assigned by you:
[
  {"title": "Short task title", "description": "Optional details", "priority": 1, "complexity": 5},
  ...
]
- title: required, short phrase
- description: optional
- priority: required in JSON. Number 0-4 (0=highest). Assign based on impact and urgency.
- complexity: required in JSON. Number 1-10 (1=simplest, 10=most complex). Assign per task based on implementation difficulty (1-3: routine; 4-6: moderate; 7-10: challenging). Use the full range as appropriate.

2. **Markdown** — a list where each item has a title (first line or bold) and optional description:
- **Title one** — optional description
- Title two: optional description
(Items from markdown will later get priority and complexity assigned by a separate AI step.)

Focus on actionable improvements: code quality, test coverage, documentation, performance, security, design/UX. Be concise; do not propose more than 10 items. If there are no clear improvements, return an empty array or empty list.`;

/** Prompt for assigning priority and complexity to improvement items that lack them (e.g. from markdown or partial JSON). */
const ASSIGN_PRIORITY_COMPLEXITY_PROMPT = `You are given a list of improvement task titles (and optional descriptions). For each task, assign:
- priority: number 0-4 (0=highest priority, 4=lowest). Base on impact and urgency.
- complexity: number 1-10 (1=simplest, 10=most complex). Base on implementation difficulty (1-3: routine; 4-6: moderate; 7-10: challenging). Use the full range as appropriate.

Respond with a single JSON array. Each element must have exactly: "title" (string, must match one of the input titles exactly), "priority" (number 0-4), "complexity" (number 1-10). Include one entry per input task. Example:
[{"title": "Add unit tests", "priority": 1, "complexity": 3}, {"title": "Refactor API layer", "priority": 2, "complexity": 6}]`;

/** Maximum improvement tasks created per self-improvement run (across all lenses). Prevents runaway task creation from agent output or multiple lenses. */
const MAX_SELF_IMPROVEMENT_TASKS_PER_RUN = 10;

/** Minimum title length for an improvement task. Filters out junk from truncated or malformed agent output (e.g. single chars or "th"). */
export const MIN_IMPROVEMENT_TITLE_LENGTH = 3;

/** True when item is a fallback/error task that should always be created (run failed or parse failed). */
function isFallbackOrErrorTask(item: { title: string }): boolean {
  return (
    (item.title.startsWith("Self-improvement (") && item.title.includes("): run failed")) ||
    item.title === "Self-improvement review failed to parse — please review agent output"
  );
}

/** Max retries for enrichment agent when it throws. Ensures AI-assigned priority/complexity when possible. */
const ENRICHMENT_MAX_RETRIES = 3;

/**
 * For all improvement items, call the planning agent to assign priority and complexity.
 * Self-improvement tasks must always have AI-assigned priority and complexity (never defaults
 * without an agent call). Returns items with priority (0-4) and complexity (1-10) filled in;
 * sets _aiAssigned=false when defaults are used so callers can skip creating those tasks.
 * Exported for tests.
 */
export async function enrichPriorityAndComplexity(
  projectId: string,
  items: ImprovementItem[],
  options: {
    repoPath: string;
    settings: ProjectSettings;
    runId: string;
  }
): Promise<EnrichedImprovementItem[]> {
  if (items.length === 0) return [];

  const config = getAgentForPlanningRole(options.settings, "auditor");
  const taskList = items
    .map(
      (i) =>
        `- ${i.title}${i.description ? `: ${i.description.slice(0, 200)}${i.description.length > 200 ? "…" : ""}` : ""}`
    )
    .join("\n");
  const userPrompt = `Assign priority (0-4) and complexity (1-10) to each of these improvement tasks:\n\n${taskList}`;
  const systemPrompt = ASSIGN_PRIORITY_COMPLEXITY_PROMPT;

  let lastErr: unknown;
  for (let attempt = 0; attempt < ENRICHMENT_MAX_RETRIES; attempt++) {
    try {
      const response = await invokeStructuredPlanningAgent<ParsedPriorityComplexity>({
        projectId,
        role: "auditor",
        config,
        messages: [{ role: "user", content: userPrompt }],
        systemPrompt,
        cwd: options.repoPath,
        tracking: {
          id: `self-improvement-enrich-${projectId}-${options.runId}`,
          projectId,
          phase: "execute",
          role: "auditor",
          label: "Self-improvement (assign priority & complexity)",
          planId: undefined,
        },
        contract: {
          parse: (content) => {
            const parsed = parsePriorityComplexityResponse(
              content,
              items.map((item) => item.title)
            );
            const hasEntries =
              parsed.byTitle.size > 0 ||
              parsed.byIndex.some((entry) => entry.priority != null || entry.complexity != null);
            return hasEntries ? parsed : null;
          },
          repairPrompt:
            'Return valid JSON only as an array of objects in this shape: [{"title":"Task title","priority":1,"complexity":5}]',
          invalidReason: () =>
            "Response did not include any valid priority/complexity assignments.",
          onExhausted: (): ParsedPriorityComplexity => ({ byTitle: new Map(), byIndex: [] }),
        },
      });

      const parsed = response.parsed ?? { byTitle: new Map(), byIndex: [] };
      return items.map((item, i) => {
        // Prefer title-based match; fall back to index when counts align (agent returns same order)
        let assigned = parsed.byTitle.get(item.title.trim());
        if (!assigned && items.length === parsed.byIndex.length && i < parsed.byIndex.length) {
          const byIndex = parsed.byIndex[i];
          if (byIndex && (byIndex.priority != null || byIndex.complexity != null)) {
            assigned = byIndex;
          }
        }
        const priority =
          assigned?.priority != null
            ? Math.min(4, Math.max(0, Math.round(assigned.priority)))
            : item.priority != null
              ? item.priority
              : 2;
        const complexity =
          assigned?.complexity != null
            ? (clampTaskComplexity(assigned.complexity) ?? 5)
            : item.complexity != null
              ? item.complexity
              : 5;
        const priorityFromAI = assigned?.priority != null || item.priority != null;
        const complexityFromAI = assigned?.complexity != null || item.complexity != null;
        const aiAssigned = priorityFromAI && complexityFromAI;
        return { ...item, priority, complexity, _aiAssigned: aiAssigned };
      });
    } catch (err) {
      lastErr = err;
      log.warn("Self-improvement priority/complexity enrichment failed", {
        projectId,
        attempt: attempt + 1,
        maxRetries: ENRICHMENT_MAX_RETRIES,
        err,
      });
    }
  }
  log.warn("Self-improvement enrichment exhausted retries, using item values or skipping", {
    projectId,
    err: lastErr,
  });
  return items.map((item) => {
    // Only treat as AI-assigned when main agent provided BOTH priority and complexity.
    // Self-improvement tasks must have both assigned by an AI agent (never defaults).
    const validComplexity = clampTaskComplexity(item.complexity);
    const bothFromMain =
      item.priority != null &&
      typeof item.priority === "number" &&
      !Number.isNaN(item.priority) &&
      validComplexity != null;
    return {
      ...item,
      priority: item.priority ?? 2,
      complexity: validComplexity ?? 5,
      _aiAssigned: bothFromMain,
    };
  });
}

/** Normalize title for matching: trim, collapse whitespace, lowercase. */
function normalizeTitleForMatch(t: string): string {
  return t.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Parsed enrichment response: by-title map and by-index array for fallback matching. */
interface ParsedPriorityComplexity {
  byTitle: Map<string, { priority?: number; complexity?: number }>;
  byIndex: Array<{ priority?: number; complexity?: number }>;
}

/** Parse agent response into by-title map and by-index array. Matches by trimmed title,
 * with case-insensitive fallback. Index-based fallback used when title match fails but counts align.
 * Accepts partial data: include entry when at least one of priority or complexity is present. */
function parsePriorityComplexityResponse(
  content: string,
  titles: string[]
): ParsedPriorityComplexity {
  const byTitle = new Map<string, { priority?: number; complexity?: number }>();
  const byIndex: Array<{ priority?: number; complexity?: number }> = [];
  let arr: Array<{ title?: string; priority?: number; complexity?: number }> | null = null;
  try {
    const parsed = JSON.parse(content.trim()) as unknown;
    if (Array.isArray(parsed)) arr = parsed;
  } catch {
    // JSON.parse failed; fall through to extractJsonArrayFromAgentResponse below.
  }
  if (!arr) {
    type PrioItem = { title?: string; priority?: number; complexity?: number };
    const extractedArr = extractJsonArrayFromAgentResponse<Array<PrioItem>>(content);
    if (Array.isArray(extractedArr)) {
      arr =
        extractedArr.length > 0 && Array.isArray(extractedArr[0])
          ? (extractedArr as unknown as PrioItem[][]).flat()
          : (extractedArr as PrioItem[]);
    }
  }
  if (!arr) {
    const obj = extractJsonFromAgentResponse<{
      items?: Array<{ title?: string; priority?: number; complexity?: number }>;
      improvements?: Array<{ title?: string; priority?: number; complexity?: number }>;
    }>(content, "title");
    const extractedArr = obj?.items ?? obj?.improvements;
    if (Array.isArray(extractedArr)) {
      type Item = { title?: string; priority?: number; complexity?: number };
      if (extractedArr.length > 0 && Array.isArray(extractedArr[0])) {
        arr = (extractedArr as unknown as Item[][]).flat();
      } else {
        arr = extractedArr as Item[];
      }
    }
  }
  if (!arr || arr.length === 0) return { byTitle, byIndex };
  const titleSet = new Set(titles.map((t) => t.trim()));
  const lowerToCanonical = new Map(titles.map((t) => [normalizeTitleForMatch(t), t.trim()]));
  for (const row of arr) {
    const rawTitle = typeof row?.title === "string" ? row.title.trim() : "";
    const priority =
      typeof row?.priority === "number" && !Number.isNaN(row.priority)
        ? Math.min(4, Math.max(0, Math.round(row.priority)))
        : undefined;
    const complexity = clampTaskComplexity(row?.complexity);
    const entry =
      priority != null || complexity != null
        ? { ...(priority != null && { priority }), ...(complexity != null && { complexity }) }
        : undefined;
    byIndex.push(entry ?? {});
    if (!rawTitle || !entry) continue;
    const canonical = titleSet.has(rawTitle)
      ? rawTitle
      : lowerToCanonical.get(normalizeTitleForMatch(rawTitle));
    if (!canonical) continue;
    byTitle.set(canonical, entry);
  }
  return { byTitle, byIndex };
}

/** Dedupe by normalized title and cap to max tasks; sort by priority (lower first, undefined treated as 2). Skips items with title shorter than MIN_IMPROVEMENT_TITLE_LENGTH. Exported for tests. */
export function capAndDedupeImprovementItems(
  items: ImprovementItem[],
  max: number
): ImprovementItem[] {
  const seen = new Set<string>();
  const deduped: ImprovementItem[] = [];
  for (const item of items) {
    const title = item.title.trim();
    if (title.length < MIN_IMPROVEMENT_TITLE_LENGTH) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2)).slice(0, max);
}

/** Parse agent response into improvement items. Tries JSON array first, then markdown list; on failure returns one fallback task. */
export function parseImprovementList(content: string): ImprovementItem[] {
  if (!content || !content.trim()) {
    return [
      {
        title: "Self-improvement review failed to parse — please review agent output",
        description: "Review produced no parseable output.",
      },
    ];
  }

  // Try bare JSON array (extractJsonFromAgentResponse only finds {...} objects)
  try {
    const parsed = JSON.parse(content.trim()) as unknown;
    if (Array.isArray(parsed)) {
      const items: ImprovementItem[] = [];
      for (const item of parsed) {
        if (
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof (item as ImprovementItem).title === "string"
        ) {
          const t = item as ImprovementItem;
          const complexity = clampTaskComplexity(t.complexity);
          items.push({
            title: t.title.trim(),
            description: typeof t.description === "string" ? t.description.trim() : undefined,
            priority:
              typeof t.priority === "number" && !Number.isNaN(t.priority)
                ? Math.min(4, Math.max(0, Math.round(t.priority)))
                : undefined,
            ...(complexity != null && { complexity }),
          });
        }
      }
      return items;
    }
  } catch {
    // not a bare array, continue
  }

  // Try JSON array embedded in text (e.g. "Here are the items:\n[...]")
  const extractedArr = extractJsonArrayFromAgentResponse<ImprovementItem[]>(content);
  if (Array.isArray(extractedArr) && extractedArr.length > 0) {
    const items: ImprovementItem[] = [];
    for (const item of extractedArr) {
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as ImprovementItem).title === "string"
      ) {
        const t = item as ImprovementItem;
        const complexity = clampTaskComplexity(t.complexity);
        items.push({
          title: t.title.trim(),
          description: typeof t.description === "string" ? t.description.trim() : undefined,
          priority:
            typeof t.priority === "number" && !Number.isNaN(t.priority)
              ? Math.min(4, Math.max(0, Math.round(t.priority)))
              : undefined,
          ...(complexity != null && { complexity }),
        });
      }
    }
    if (items.length > 0) return items;
  }

  // Try JSON object/array embedded in text
  const json = extractJsonFromAgentResponse<ImprovementItem[]>(content);
  if (Array.isArray(json) && json.length >= 0) {
    const items: ImprovementItem[] = [];
    for (const item of json) {
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as ImprovementItem).title === "string"
      ) {
        const t = item as ImprovementItem;
        const complexity = clampTaskComplexity(t.complexity);
        items.push({
          title: t.title.trim(),
          description: typeof t.description === "string" ? t.description.trim() : undefined,
          priority:
            typeof t.priority === "number" && !Number.isNaN(t.priority)
              ? Math.min(4, Math.max(0, Math.round(t.priority)))
              : undefined,
          ...(complexity != null && { complexity }),
        });
      }
    }
    if (items.length > 0) return items;
    return [];
  }

  // Try single JSON object with "items" or "improvements" array
  const obj = extractJsonFromAgentResponse<{
    items?: ImprovementItem[];
    improvements?: ImprovementItem[];
  }>(content);
  if (obj && (Array.isArray(obj.items) || Array.isArray(obj.improvements))) {
    const arr = (obj.items ?? obj.improvements) as ImprovementItem[];
    const items: ImprovementItem[] = [];
    for (const item of arr) {
      if (item && typeof item === "object" && typeof item.title === "string") {
        const complexity = clampTaskComplexity(item.complexity);
        items.push({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : undefined,
          priority:
            typeof item.priority === "number" && !Number.isNaN(item.priority)
              ? Math.min(4, Math.max(0, Math.round(item.priority)))
              : undefined,
          ...(complexity != null && { complexity }),
        });
      }
    }
    if (items.length > 0) return items;
  }

  // Try markdown list: - **Title** or - Title: description
  const lines = content.split(/\n/);
  const items: ImprovementItem[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-") && !trimmed.startsWith("*")) continue;
    const rest = trimmed.slice(1).trim();
    let title = rest;
    let description: string | undefined;
    const boldMatch = rest.match(/^\*\*(.+?)\*\*(?:\s*[—\-:]\s*(.+))?$/);
    if (boldMatch) {
      title = boldMatch[1]!.trim();
      description = boldMatch[2]?.trim();
    } else {
      const colon = rest.indexOf(":");
      if (colon > 0) {
        title = rest.slice(0, colon).replace(/\*\*/g, "").trim();
        description = rest.slice(colon + 1).trim();
      }
    }
    if (title.length > 0) items.push({ title, description });
  }
  if (items.length > 0) return items;

  return [
    {
      title: "Self-improvement review failed to parse — please review agent output",
      description: content.slice(0, 500),
    },
  ];
}

/** High-level status of the self-improvement pipeline for a project. */
export type SelfImprovementStatusValue =
  | "idle"
  | "running_audit"
  | "running_experiments"
  | "awaiting_approval";

/** Stage within an active experiment run. */
export type SelfImprovementStage =
  | "collecting_replay_cases"
  | "generating_candidate"
  | "replaying"
  | "scoring"
  | "promoting";

/** In-memory run state tracked per project while a self-improvement run is active. */
export interface SelfImprovementRunState {
  status: SelfImprovementStatusValue;
  stage?: SelfImprovementStage;
  pendingCandidateId?: string;
  summary?: string;
}

/** Snapshot returned by the status endpoint. */
export interface SelfImprovementStatusSnapshot {
  status: SelfImprovementStatusValue;
  stage?: SelfImprovementStage;
  pendingCandidateId?: string;
  summary?: string;
}

/** Per-project in-progress state: projectIds → run state while self-improvement is active. */
const inProgressProjects = new Map<string, SelfImprovementRunState>();

/** Returns true when a self-improvement run is in progress for the given project. */
export function isSelfImprovementRunInProgress(projectId: string): boolean {
  return inProgressProjects.has(projectId);
}

/** Returns the current run mode for a project's self-improvement run, or undefined when idle. */
export function getSelfImprovementRunMode(
  projectId: string
): "audit" | "experiments" | undefined {
  const state = inProgressProjects.get(projectId);
  if (!state) return undefined;
  if (state.status === "running_experiments") return "experiments";
  if (state.status === "running_audit") return "audit";
  return undefined;
}

/** Get the current in-memory run state for a project (undefined when idle). */
export function getSelfImprovementRunState(
  projectId: string
): SelfImprovementRunState | undefined {
  return inProgressProjects.get(projectId);
}

/**
 * Build a status snapshot for the status endpoint.
 * Checks in-memory run state first; falls back to settings for awaiting_approval.
 */
export function getSelfImprovementStatus(
  projectId: string,
  settings?: { selfImprovementPendingCandidateId?: string }
): SelfImprovementStatusSnapshot {
  const runState = inProgressProjects.get(projectId);
  if (runState) {
    return {
      status: runState.status,
      ...(runState.stage && { stage: runState.stage }),
      ...(runState.pendingCandidateId && {
        pendingCandidateId: runState.pendingCandidateId,
      }),
      ...(runState.summary && { summary: runState.summary }),
    };
  }
  if (settings?.selfImprovementPendingCandidateId) {
    return {
      status: "awaiting_approval",
      pendingCandidateId: settings.selfImprovementPendingCandidateId,
      summary: "A candidate behavior version is awaiting approval.",
    };
  }
  return { status: "idle" };
}

/**
 * Test-only: set in-progress state for a project so tests can assert execute status.
 * Use in afterEach to clear state and avoid leaking across tests.
 */
export function setSelfImprovementRunInProgressForTest(
  projectId: string,
  inProgress: boolean | SelfImprovementRunState
): void {
  if (inProgress === false) {
    inProgressProjects.delete(projectId);
  } else if (inProgress === true) {
    inProgressProjects.set(projectId, { status: "running_audit" });
  } else {
    inProgressProjects.set(projectId, inProgress);
  }
}

export class SelfImprovementRunnerService {
  private taskStore = taskStoreSingleton;
  private _projectService: ProjectService | null = null;
  private _planService: PlanService | null = null;
  private _contextAssembler: ContextAssembler | null = null;

  private get projectService(): ProjectService {
    if (!this._projectService) this._projectService = new ProjectService();
    return this._projectService;
  }
  private get planService(): PlanService {
    if (!this._planService) this._planService = new PlanService();
    return this._planService;
  }
  private get contextAssembler(): ContextAssembler {
    if (!this._contextAssembler) this._contextAssembler = new ContextAssembler();
    return this._contextAssembler;
  }

  /** Returns true when a self-improvement run is in progress for the given project. */
  isSelfImprovementRunInProgress(projectId: string): boolean {
    return isSelfImprovementRunInProgress(projectId);
  }

  /**
   * Run self-improvement: build context, run one review per lens (or one general), parse output,
   * create tasks with extra.source and optional planId/runId, update last run only on success.
   * If a run is already in progress for this project, skips with { tasksCreated: 0, skipped: 'run_in_progress' }.
   */
  async runSelfImprovement(
    projectId: string,
    options?: RunSelfImprovementOptions
  ): Promise<RunSelfImprovementResult> {
    if (inProgressProjects.has(projectId)) {
      return { tasksCreated: 0, skipped: "run_in_progress" };
    }
    const settings = await this.projectService.getSettings(projectId);
    const experimentsEnabled = settings.runAgentEnhancementExperiments === true;
    const initialStatus: SelfImprovementStatusValue = experimentsEnabled
      ? "running_experiments"
      : "running_audit";
    inProgressProjects.set(projectId, { status: initialStatus });
    try {
      return await this.runSelfImprovementInner(projectId, options);
    } finally {
      inProgressProjects.delete(projectId);
    }
  }

  private async runSelfImprovementInner(
    projectId: string,
    options?: RunSelfImprovementOptions
  ): Promise<RunSelfImprovementResult> {
    const runId = options?.runId ?? `si-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const project = await this.projectService.getProject(projectId);
    const repoPath = project.repoPath;
    const settings = await this.projectService.getSettings(projectId);

    const angles = [...new Set((settings.reviewAngles ?? []).filter(Boolean))] as ReviewAngle[];
    const lenses = angles.length > 0 ? angles : (["general"] as const);

    const { fileTree, keyFilesContent } = await this.planService.getCodebaseContext(projectId);
    const specContent = await this.contextAssembler.extractPrdExcerpt(repoPath);

    const baseContext = `## SPEC (product/sketch)

${specContent.slice(0, 12000)}${specContent.length > 12000 ? "\n\n...(truncated)" : ""}

## File tree

\`\`\`
${fileTree}
\`\`\`

## Key file contents

${keyFilesContent.slice(0, 20000)}${keyFilesContent.length > 20000 ? "\n\n...(truncated)" : ""}

---

Review the codebase and output a structured list of improvement tasks (JSON array or markdown list).`;

    const systemPrompt = `${SELF_IMPROVEMENT_SYSTEM_PROMPT}\n\n${await getCombinedInstructions(repoPath, "auditor")}`;
    const config = getAgentForPlanningRole(settings, "auditor");
    const extraBase: Record<string, unknown> = {
      source: "self-improvement",
      runId,
      ...(options?.planId && { planId: options.planId }),
    };

    const allItems: ImprovementItem[] = [];
    let atLeastOneReviewSucceeded = false;

    for (const lens of lenses) {
      const angleLabel =
        lens === "general"
          ? "General"
          : (REVIEW_ANGLE_OPTIONS.find((o) => o.value === lens)?.label ?? lens);
      const userPrompt =
        lens === "general"
          ? `${baseContext}\n\nProvide improvement tasks from a general code quality and maintainability perspective.`
          : `${baseContext}\n\nFocus ONLY on the **${angleLabel}** lens. Provide improvement tasks for this angle only.`;

      const agentId = `self-improvement-${lens}-${projectId}-${runId}`;
      try {
        const response = await invokeStructuredPlanningAgent({
          projectId,
          role: "auditor",
          config,
          messages: [{ role: "user", content: userPrompt }],
          systemPrompt,
          cwd: repoPath,
          tracking: {
            id: agentId,
            projectId,
            phase: "execute",
            role: "auditor",
            label: `Self-improvement (${angleLabel})`,
            planId: options?.planId,
          },
          contract: {
            parse: (content) => {
              const items = parseImprovementList(content);
              return items.length === 0 || !items.every((item) => isFallbackOrErrorTask(item))
                ? items
                : null;
            },
            repairPrompt:
              'Return only structured improvement tasks. Preferred format: a JSON array of {"title":"...","description":"...","priority":0-4,"complexity":1-10}.',
            invalidReason: () => "Response did not include parseable improvement tasks.",
            onExhausted: ({ repairRawContent }) => parseImprovementList(repairRawContent),
          },
        });

        const items = response.parsed ?? parseImprovementList(response.rawContent);
        for (const item of items) {
          allItems.push(item);
        }
        atLeastOneReviewSucceeded = true;
      } catch (err) {
        log.warn("Self-improvement agent run failed", { projectId, lens, err });
        allItems.push({
          title: `Self-improvement (${angleLabel}): run failed`,
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const cappedItems = capAndDedupeImprovementItems(allItems, MAX_SELF_IMPROVEMENT_TASKS_PER_RUN);
    if (cappedItems.length < allItems.length) {
      log.info("Self-improvement run capped task count", {
        projectId,
        runId,
        total: allItems.length,
        capped: cappedItems.length,
      });
    }
    // Self-improvement tasks must ALWAYS have complexity and priority assigned by an AI agent
    // (main reviewer or enrichment agent). Never create tasks with default values.
    const enrichedItems = await enrichPriorityAndComplexity(projectId, cappedItems, {
      repoPath,
      settings: settings as ProjectSettings,
      runId,
    });
    const itemsToCreate = enrichedItems.filter((item) => item._aiAssigned === true);
    const skippedCount = enrichedItems.length - itemsToCreate.length;
    if (skippedCount > 0) {
      log.info("Self-improvement skipped tasks without AI-assigned priority/complexity", {
        projectId,
        runId,
        skipped: skippedCount,
      });
      const skippedFallbacks = enrichedItems.filter(
        (item) => item._aiAssigned !== true && isFallbackOrErrorTask(item)
      );
      if (skippedFallbacks.length > 0) {
        const message = `Self-improvement run had ${skippedFallbacks.length} failure(s) but could not assign priority/complexity via AI. Please review: ${skippedFallbacks.map((f) => f.title).join("; ")}`;
        const notification = await notificationService.createAgentFailed({
          projectId,
          source: "execute",
          sourceId: `self-improvement-${runId}`,
          message,
        });
        broadcastToProject(projectId, {
          type: "notification.added",
          notification: {
            id: notification.id,
            projectId: notification.projectId,
            source: notification.source,
            sourceId: notification.sourceId,
            questions: notification.questions.map((q) => ({
              id: q.id,
              text: q.text,
            })),
            status: notification.status,
            createdAt: notification.createdAt,
            resolvedAt: notification.resolvedAt,
            kind: notification.kind,
          },
        });
      }
    }
    let createdCount = 0;
    for (const item of itemsToCreate) {
      // Self-improvement tasks must ALWAYS have complexity and priority assigned by an AI agent
      // (main reviewer or enrichment agent). Never create with defaults.
      if (item._aiAssigned !== true) {
        log.error("Self-improvement task missing AI-assigned priority/complexity — skipping", {
          projectId,
          title: item.title,
          _aiAssigned: item._aiAssigned,
        });
        continue;
      }
      const priority = item.priority ?? 2;
      const complexity = item.complexity != null ? (clampTaskComplexity(item.complexity) ?? 5) : 5;
      if (
        item.priority === undefined ||
        item.complexity === undefined ||
        clampTaskComplexity(item.complexity) == null
      ) {
        log.error("Self-improvement task missing AI-assigned priority/complexity — skipping", {
          projectId,
          title: item.title,
          priority: item.priority,
          complexity: item.complexity,
        });
        continue;
      }
      await this.taskStore.create(projectId, item.title, {
        description: item.description,
        priority,
        complexity,
        extra: { ...extraBase, aiAssignedPriority: true, aiAssignedComplexity: true },
      });
      createdCount += 1;
    }

    // Only update lastRun when at least one Reviewer invocation succeeded (no failure/timeout).
    if (atLeastOneReviewSucceeded) {
      const now = new Date().toISOString();
      let lastCommitSha: string | undefined = options?.lastCommitSha;
      if (lastCommitSha === undefined) {
        try {
          const out = await shellExec("git rev-parse HEAD", { cwd: repoPath });
          lastCommitSha = out.stdout?.trim() || undefined;
        } catch {
          // optional
        }
      }

      const current = await getSettingsFromStore(projectId, settings as ProjectSettings);
      await updateSettingsInStore(projectId, current, (s) => ({
        ...s,
        selfImprovementLastRunAt: now,
        ...(lastCommitSha && { selfImprovementLastCommitSha: lastCommitSha }),
      }));
    }

    const experimentsEnabled = settings.runAgentEnhancementExperiments === true;
    const summary =
      createdCount > 0
        ? `Created ${createdCount} self-improvement task(s).`
        : "Audit completed; no new improvement tasks.";

    await taskStoreSingleton.insertSelfImprovementRunHistory({
      projectId,
      runId,
      completedAt: new Date().toISOString(),
      status: "success",
      tasksCreatedCount: createdCount,
      mode: experimentsEnabled ? "audit_and_experiments" : "audit_only",
      outcome: createdCount > 0 ? "tasks_created" : "no_changes",
      summary,
    });

    return { tasksCreated: createdCount, runId };
  }
}

export const selfImprovementRunnerService = new SelfImprovementRunnerService();

/** Run self-improvement for a project. Exported for API/scheduler. */
export async function runSelfImprovement(
  projectId: string,
  options?: RunSelfImprovementOptions
): Promise<RunSelfImprovementResult> {
  return selfImprovementRunnerService.runSelfImprovement(projectId, options);
}
