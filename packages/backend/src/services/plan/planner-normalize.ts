/**
 * Planner output normalization: accept camelCase and snake_case from Planner/API.
 * Pure helpers for parsing and normalizing plan/task JSON.
 */
import type { PlanDependencyEdge } from "@opensprint/shared";
import { clampTaskComplexity, PLAN_MARKDOWN_SECTIONS } from "@opensprint/shared";
import { extractJsonFromAgentResponse } from "../../utils/json-extract.js";

export const MAX_TASKS_PER_PLAN = 15;

/**
 * Validate that a batch of tasks does not exceed the per-plan cap.
 * Returns whether the batch is valid, the count, and the excess (0 when valid).
 */
export function validateTaskBatchSize(tasks: unknown[]): {
  valid: boolean;
  count: number;
  excess: number;
} {
  const count = tasks.length;
  const excess = Math.max(0, count - MAX_TASKS_PER_PLAN);
  return { valid: count <= MAX_TASKS_PER_PLAN, count, excess };
}

const PLAN_UPDATE_WRAPPER_RE = /^\s*\[PLAN_UPDATE\]\s*([\s\S]*?)\s*\[\/PLAN_UPDATE\]\s*$/;
const PROPOSED_PLAN_WRAPPER_RE = /^\s*<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>\s*$/i;
const FENCED_BLOCK_RE = /^```[^\n]*\n([\s\S]*?)\n```$/;
const PLAN_SECTION_HEADING_PATTERNS = PLAN_MARKDOWN_SECTIONS.map(
  (section) => new RegExp(`^##\\s+${escapeRegex(section)}(?:\\s|\\(|$)`, "i")
);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlanSectionHeading(line: string): boolean {
  const trimmed = line.trim();
  return PLAN_SECTION_HEADING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function looksLikePlanMarkdown(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/^#\s+\S/.test(trimmed)) return true;
  return trimmed.split("\n").some((line) => isPlanSectionHeading(line));
}

function unwrapOuterPlanContainer(content: string): string {
  const planUpdateMatch = content.match(PLAN_UPDATE_WRAPPER_RE);
  if (planUpdateMatch?.[1]) return planUpdateMatch[1].trim();

  const proposedPlanMatch = content.match(PROPOSED_PLAN_WRAPPER_RE);
  if (proposedPlanMatch?.[1]) return proposedPlanMatch[1].trim();

  const fencedMatch = content.match(FENCED_BLOCK_RE);
  if (fencedMatch?.[1]) {
    const inner = fencedMatch[1].trim();
    if (looksLikePlanMarkdown(inner)) return inner;
  }

  return content;
}

function promotePlainTitleToH1(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  const lines = trimmed.split("\n");
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim() !== "");
  if (firstNonEmptyIndex < 0) return "";

  const firstLine = lines[firstNonEmptyIndex]!.trim();
  if (
    !firstLine ||
    /^#+\s/.test(firstLine) ||
    /^```/.test(firstLine) ||
    /^<\/?proposed_plan>$/i.test(firstLine) ||
    /^\[\/?PLAN_UPDATE\]$/.test(firstLine)
  ) {
    return trimmed;
  }

  const nextNonEmptyIndex = lines.findIndex(
    (line, index) => index > firstNonEmptyIndex && line.trim() !== ""
  );
  if (nextNonEmptyIndex < 0) return trimmed;

  const nextLine = lines[nextNonEmptyIndex]!.trim();
  if (!isPlanSectionHeading(nextLine)) return trimmed;

  lines[firstNonEmptyIndex] = `# ${firstLine}`;
  if (nextNonEmptyIndex === firstNonEmptyIndex + 1) {
    lines.splice(firstNonEmptyIndex + 1, 0, "");
  }
  return lines.join("\n").trim();
}

/**
 * Canonicalize plan markdown before persistence.
 * Safely strips known wrappers and promotes a plain-text title line to H1 when it is
 * immediately followed by plan sections.
 */
export function normalizePlanMarkdownContent(content: string): string {
  let normalized = (content ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  for (let i = 0; i < 3; i++) {
    const unwrapped = unwrapOuterPlanContainer(normalized);
    if (unwrapped === normalized) break;
    normalized = unwrapped;
  }

  return promotePlainTitleToH1(normalized);
}

/** Derive epic title from plan content (first # heading) or format planId as title. */
export function getEpicTitleFromPlanContent(content: string, planId: string): string {
  const firstLine = (content ?? "").trim().split("\n")[0] ?? "";
  const match = firstLine.match(/^#\s+(.*)$/);
  const fromHeading = match?.[1]?.trim();
  if (fromHeading) return fromHeading;
  return planId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Normalize Planner task output: accept both camelCase (dependsOn) and snake_case (depends_on).
 * When tasksArray is provided, numeric indices in depends_on are resolved to task titles.
 */
export function normalizePlannerTaskDeps(
  task: Record<string, unknown>,
  tasksArray?: Array<{ title?: string; [k: string]: unknown }>
): string[] {
  const arr = (task.dependsOn ?? task.depends_on ?? []) as unknown;
  if (!Array.isArray(arr)) return [];
  const result: string[] = [];
  for (const x of arr) {
    if (typeof x === "string") {
      result.push(x);
    } else if (typeof x === "number" && tasksArray && x >= 0 && x < tasksArray.length) {
      const ref = tasksArray[x];
      const t = (ref?.title ?? (ref as Record<string, unknown>)?.task_title) as string | undefined;
      if (t) result.push(t);
    }
  }
  return result;
}

/** Normalized task shape for Planner output (accepts camelCase and snake_case field names). */
export interface NormalizedPlannerTask {
  title: string;
  description: string;
  priority: number;
  dependsOn: string[];
  complexity?: number;
  files?: { modify?: string[]; create?: string[]; test?: string[] };
}

/** First found tasks array in planner JSON, with source path for diagnostics. */
export interface ExtractedPlannerTaskArray {
  key: "tasks" | "task_list" | "taskList";
  path: string;
  value: unknown[];
  count: number;
}

/**
 * Find a planner tasks array recursively.
 * Accepts nested shapes like { result: { tasks: [...] } } in addition to top-level arrays.
 */
export function findPlannerTaskArray(value: unknown, path = "$"): ExtractedPlannerTaskArray | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findPlannerTaskArray(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }

  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  if (Array.isArray(record.tasks)) {
    return { key: "tasks", path: `${path}.tasks`, value: record.tasks, count: record.tasks.length };
  }
  if (Array.isArray(record.task_list)) {
    return {
      key: "task_list",
      path: `${path}.task_list`,
      value: record.task_list,
      count: record.task_list.length,
    };
  }
  if (Array.isArray(record.taskList)) {
    return {
      key: "taskList",
      path: `${path}.taskList`,
      value: record.taskList,
      count: record.taskList.length,
    };
  }

  for (const [key, child] of Object.entries(record)) {
    const found = findPlannerTaskArray(child, `${path}.${key}`);
    if (found) return found;
  }

  return null;
}

/**
 * Normalize a single Planner task: accept title/task_title, description/task_description,
 * priority, and dependsOn/depends_on (strings or indices when tasksArray provided).
 */
export function normalizePlannerTask(
  task: Record<string, unknown>,
  tasksArray?: Array<Record<string, unknown>>
): NormalizedPlannerTask {
  const title = (task.title as string) ?? (task.task_title as string) ?? "Untitled task";
  const description = (task.description as string) ?? (task.task_description as string) ?? "";
  const rawPriority = task.priority ?? task.task_priority;
  const priority =
    typeof rawPriority === "number" && rawPriority >= 0 && rawPriority <= 4 ? rawPriority : 2;
  const dependsOn = normalizePlannerTaskDeps(
    task,
    tasksArray as Array<{ title?: string; [k: string]: unknown }> | undefined
  );
  const raw = task.complexity;
  const complexity = clampTaskComplexity(raw);
  const rawFiles = task.files;
  const files =
    rawFiles && typeof rawFiles === "object"
      ? {
          modify: Array.isArray((rawFiles as { modify?: unknown }).modify)
            ? (rawFiles as { modify: unknown[] }).modify.filter(
                (f): f is string => typeof f === "string"
              )
            : undefined,
          create: Array.isArray((rawFiles as { create?: unknown }).create)
            ? (rawFiles as { create: unknown[] }).create.filter(
                (f): f is string => typeof f === "string"
              )
            : undefined,
          test: Array.isArray((rawFiles as { test?: unknown }).test)
            ? (rawFiles as { test: unknown[] }).test.filter(
                (f): f is string => typeof f === "string"
              )
            : undefined,
        }
      : undefined;
  return { title, description, priority, dependsOn, complexity, files };
}

/** Reject blank or duplicate normalized titles before title-based dependency resolution. */
export function getPlannerTaskTitleError(
  tasks: ReadonlyArray<Pick<NormalizedPlannerTask, "title">>
): string | undefined {
  const titles = new Set<string>();
  for (const task of tasks) {
    if (typeof task.title !== "string" || !task.title.trim()) {
      return "invalid-task-title: Every task must have a nonempty string title.";
    }
    const title = task.title.trim();
    if (titles.has(title)) {
      return `duplicate-task-title: Multiple tasks use the title ${JSON.stringify(title)}. Return unique task titles and update dependsOn references to those titles.`;
    }
    titles.add(title);
  }
  return undefined;
}

/** Normalize plan-level dependsOnPlans: accept both camelCase and snake_case. */
export function normalizeDependsOnPlans(spec: Record<string, unknown>): string[] {
  const arr = (spec.dependsOnPlans ?? spec.depends_on_plans ?? []) as unknown;
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
}

export function normalizePlannerOpenQuestions(
  raw: Record<string, unknown>
): Array<{ id: string; text: string }> {
  const input = (raw.open_questions ?? raw.openQuestions ?? []) as unknown;
  if (!Array.isArray(input)) return [];

  return input
    .filter(
      (item): item is { id?: string; text: string } =>
        item != null && typeof item === "object" && typeof item.text === "string"
    )
    .map((item) => ({
      id: item.id?.trim() ? item.id.trim() : `q-${Math.random().toString(36).slice(2, 10)}`,
      text: item.text.trim(),
    }))
    .filter((item) => item.text.length > 0);
}

/**
 * Normalize plan-level fields from Planner output: accept both camelCase and snake_case.
 * Planner may return title/plan_title, content/plan_content/body, mockups/mock_ups, tasks/task_list.
 */
export function normalizePlanSpec(spec: Record<string, unknown>): {
  title: string;
  content: string;
  complexity?: string;
  mockups: Array<{ title: string; content: string }>;
  tasks: Array<Record<string, unknown>>;
} {
  const title = (spec.title as string) ?? (spec.plan_title as string) ?? "Untitled Feature";
  const content =
    (spec.content as string) ??
    (spec.plan_content as string) ??
    (spec.body as string) ??
    `# ${title}\n\nNo content.`;
  const rawMockups = (spec.mockups ?? spec.mock_ups ?? []) as unknown;
  const mockups = Array.isArray(rawMockups)
    ? rawMockups
        .filter((m): m is Record<string, unknown> => m != null && typeof m === "object")
        .map((m) => ({
          title: (m.title ?? m.label ?? "Mockup") as string,
          content: (m.content ?? m.body ?? "") as string,
        }))
        .filter((m) => m.title && m.content)
    : [];
  const rawTasksInput = (spec.tasks ?? spec.task_list ?? []) as unknown;
  const tasks = Array.isArray(rawTasksInput)
    ? rawTasksInput.filter((t): t is Record<string, unknown> => t != null && typeof t === "object")
    : [];
  return {
    title,
    content,
    complexity: spec.complexity as string | undefined,
    mockups,
    tasks,
  };
}

/** Normalized sub-plan shape returned by the decomposition agent. */
export interface NormalizedSubPlan {
  title: string;
  overview: string;
  content: string;
  dependsOnPlans: string[];
}

/**
 * Slugify a plan title the same way `PlanCrudService.createPlan` derives `planId`.
 */
export function slugifyPlanTitleToId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Result of ordering sibling sub-plans by `dependsOnPlans` (Kahn topological sort). */
export type SortSubPlansTopologicallyResult =
  | { ok: true; ordered: NormalizedSubPlan[] }
  | { ok: false; reason: "cyclic_depends_on_plans" };

/**
 * Topologically sort sibling sub-plans so each plan appears after its `dependsOnPlans` references
 * (slugified sibling titles). Unknown dependency slugs are ignored (no edge). A cycle among
 * resolved edges yields `ok: false` so callers can surface a user-visible error.
 */
export function sortSubPlansTopologically(
  subPlans: NormalizedSubPlan[]
): SortSubPlansTopologicallyResult {
  if (subPlans.length <= 1) return { ok: true, ordered: [...subPlans] };

  const slugFor = (sp: NormalizedSubPlan) => slugifyPlanTitleToId(sp.title);
  const indexBySlug = new Map<string, number>();
  for (let i = 0; i < subPlans.length; i++) {
    indexBySlug.set(slugFor(subPlans[i]!), i);
  }

  const n = subPlans.length;
  const indegree = Array(n).fill(0);
  const adj: number[][] = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    const sp = subPlans[i]!;
    for (const depSlug of sp.dependsOnPlans) {
      const j = indexBySlug.get(depSlug);
      if (j === undefined || j === i) continue;
      adj[j]!.push(i);
      indegree[i]++;
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (indegree[i] === 0) queue.push(i);
  }

  const result: NormalizedSubPlan[] = [];
  while (queue.length > 0) {
    const i = queue.shift()!;
    result.push(subPlans[i]!);
    for (const v of adj[i]!) {
      indegree[v]--;
      if (indegree[v] === 0) queue.push(v);
    }
  }

  if (result.length !== n) {
    return { ok: false, reason: "cyclic_depends_on_plans" };
  }
  return { ok: true, ordered: result };
}

/**
 * Build blocking edges between sibling sub-plans from `dependsOnPlans` slugs
 * (same resolution rules as `sortSubPlansTopologically`). Includes self-edges
 * when a plan lists its own slug so DAG validation can reject them.
 */
export function buildSubPlanDependencyEdges(subPlans: NormalizedSubPlan[]): PlanDependencyEdge[] {
  if (subPlans.length === 0) return [];
  const slugFor = (sp: NormalizedSubPlan) => slugifyPlanTitleToId(sp.title);
  const indexBySlug = new Map<string, number>();
  for (let i = 0; i < subPlans.length; i++) {
    indexBySlug.set(slugFor(subPlans[i]!), i);
  }
  const edges: PlanDependencyEdge[] = [];
  const seen = new Set<string>();
  for (const sp of subPlans) {
    const toSlug = slugFor(sp);
    for (const depSlug of sp.dependsOnPlans) {
      if (!indexBySlug.has(depSlug)) continue;
      const key = `${depSlug}->${toSlug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: depSlug, to: toSlug, type: "blocks" });
    }
  }
  return edges;
}

/**
 * Normalize a single sub-plan object: validate required string fields and
 * normalize `depends_on_plans` / `dependsOnPlans` via the existing helper.
 * Returns null when any required field is missing or not a string.
 */
export function normalizeSubPlan(raw: Record<string, unknown>): NormalizedSubPlan | null {
  const title = (raw.title as string | undefined) ?? (raw.plan_title as string | undefined);
  const overview = (raw.overview as string | undefined) ?? (raw.summary as string | undefined);
  const content = (raw.content as string | undefined) ?? (raw.body as string | undefined);

  if (typeof title !== "string" || !title.trim()) return null;
  if (typeof overview !== "string" || !overview.trim()) return null;
  if (typeof content !== "string" || !content.trim()) return null;

  return {
    title: title.trim(),
    overview: overview.trim(),
    content: content.trim(),
    dependsOnPlans: normalizeDependsOnPlans(raw),
  };
}

/** First-found sub_plans / subPlans array with source path for diagnostics. */
export interface ExtractedSubPlanArray {
  key: "sub_plans" | "subPlans";
  path: string;
  value: unknown[];
  count: number;
}

/**
 * Recursively find a sub-plan array in planner JSON.
 * Accepts keys `sub_plans` and `subPlans`, mirroring `findPlannerTaskArray`.
 */
export function findSubPlanArray(value: unknown, path = "$"): ExtractedSubPlanArray | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findSubPlanArray(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }

  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  if (Array.isArray(record.sub_plans)) {
    return {
      key: "sub_plans",
      path: `${path}.sub_plans`,
      value: record.sub_plans,
      count: record.sub_plans.length,
    };
  }
  if (Array.isArray(record.subPlans)) {
    return {
      key: "subPlans",
      path: `${path}.subPlans`,
      value: record.subPlans,
      count: record.subPlans.length,
    };
  }

  for (const [key, child] of Object.entries(record)) {
    const found = findSubPlanArray(child, `${path}.${key}`);
    if (found) return found;
  }

  return null;
}

/** Discriminated union returned by `parseSubPlanDecompositionResponse`. */
export type SubPlanDecompositionResult =
  | { strategy: "tasks"; tasks: NormalizedPlannerTask[] }
  | { strategy: "sub_plans"; subPlans: NormalizedSubPlan[] };

/**
 * Parse an agent response that may contain either a tasks-based or sub-plans-based
 * decomposition. Extracts JSON via `extractJsonFromAgentResponse`, inspects
 * `strategy` field and validates the payload shape.
 *
 * Returns null when the content cannot be parsed or fails validation.
 */
export function parseSubPlanDecompositionResponse(
  content: string
): SubPlanDecompositionResult | null {
  const parsed = extractJsonFromAgentResponse<Record<string, unknown>>(content);
  if (!parsed || typeof parsed !== "object") return null;

  const strategy = (parsed.strategy as string | undefined) ?? inferStrategy(parsed);

  if (strategy === "tasks") {
    const extracted = findPlannerTaskArray(parsed);
    if (!extracted) return null;
    const rawTasks = extracted.value.filter(
      (t): t is Record<string, unknown> => t != null && typeof t === "object"
    );
    if (rawTasks.length === 0) return null;
    const { valid } = validateTaskBatchSize(rawTasks);
    if (!valid) return null;
    const tasks = rawTasks.map((t) => normalizePlannerTask(t, rawTasks));
    if (getPlannerTaskTitleError(tasks)) return null;
    return { strategy: "tasks", tasks };
  }

  if (strategy === "sub_plans") {
    const extracted = findSubPlanArray(parsed);
    if (!extracted) return null;
    const rawPlans = extracted.value.filter(
      (p): p is Record<string, unknown> => p != null && typeof p === "object"
    );
    const subPlans: NormalizedSubPlan[] = [];
    for (const raw of rawPlans) {
      const normalized = normalizeSubPlan(raw);
      if (!normalized) return null;
      subPlans.push(normalized);
    }
    if (subPlans.length === 0) return null;
    return { strategy: "sub_plans", subPlans };
  }

  return null;
}

function inferStrategy(parsed: Record<string, unknown>): "tasks" | "sub_plans" | undefined {
  if (findSubPlanArray(parsed)) return "sub_plans";
  if (findPlannerTaskArray(parsed)) return "tasks";
  return undefined;
}

/**
 * Ensure plan content has a ## Dependencies section from dependsOnPlans (slugified plan IDs).
 */
export function ensureDependenciesSection(content: string, dependsOnPlans: string[]): string {
  if (!dependsOnPlans?.length) return content;
  const section = `## Dependencies\n\n${dependsOnPlans.map((s) => `- ${s}`).join("\n")}`;
  const re = /## Dependencies[\s\S]*?(?=##|$)/i;
  if (re.test(content)) {
    return content.replace(re, section);
  }
  return content.trimEnd() + "\n\n" + section;
}
