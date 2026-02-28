import fs from "fs/promises";
import path from "path";
import type {
  Plan,
  PlanMetadata,
  PlanMockup,
  PlanDependencyGraph,
  PlanDependencyEdge,
  SuggestedPlan,
  PlanComplexity,
  PlanStatusResponse,
  Prd,
  CrossEpicDependenciesResponse,
} from "@opensprint/shared";
import {
  OPENSPRINT_PATHS,
  getEpicId,
  getAgentForPlanningRole,
  PLAN_MARKDOWN_SECTIONS,
  validatePlanContent,
  parsePlanTasks,
  clampTaskComplexity,
} from "@opensprint/shared";
import { syncPlanTasksFromContent } from "./plan-task-sync.service.js";
import { ProjectService } from "./project.service.js";
import { planComplexityToTask } from "./plan-complexity.js";
import { taskStore as taskStoreSingleton, type StoredTask } from "./task-store.service.js";
import { ChatService } from "./chat.service.js";
import { PrdService } from "./prd.service.js";
import { agentService } from "./agent.service.js";
import { buildAuditorPrompt, parseAuditorResult } from "./auditor.service.js";
import { buildAutonomyDescription } from "./context-assembler.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { broadcastToProject } from "../websocket/index.js";
import { writeJsonAtomic } from "../utils/file-utils.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("plan");
const PLAN_TEMPLATE_STRUCTURE = PLAN_MARKDOWN_SECTIONS.join(", ");

/** Derive epic title from plan content (first # heading) or format planId as title. */
function getEpicTitleFromPlanContent(content: string, planId: string): string {
  const firstLine = (content ?? "").trim().split("\n")[0] ?? "";
  const match = firstLine.match(/^#\s+(.*)$/);
  const fromHeading = match?.[1]?.trim();
  if (fromHeading) return fromHeading;
  return planId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Normalize Planner task output: accept both camelCase (dependsOn) and snake_case (depends_on).
 * Planner returns tasks with dependency arrays; LLMs may use either convention.
 * When tasksArray is provided, numeric indices in depends_on are resolved to task titles.
 */
function normalizePlannerTaskDeps(
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
interface NormalizedPlannerTask {
  title: string;
  description: string;
  priority: number;
  dependsOn: string[];
  /** Task-level complexity (integer 1-10). When absent, inferred from plan. */
  complexity?: number;
}

/**
 * Normalize a single Planner task: accept title/task_title, description/task_description,
 * priority, and dependsOn/depends_on (strings or indices when tasksArray provided).
 */
function normalizePlannerTask(
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
  // Accept integer 1-10 or legacy "simple"|"complex" (map to 3, 7)
  const raw = task.complexity;
  let complexity: number | undefined = clampTaskComplexity(raw);
  if (complexity === undefined && typeof raw === "string") {
    if (raw === "simple") complexity = 3;
    else if (raw === "complex") complexity = 7;
  }
  return { title, description, priority, dependsOn, complexity };
}

/**
 * Normalize plan-level dependsOnPlans: accept both camelCase and snake_case.
 */
function normalizeDependsOnPlans(spec: Record<string, unknown>): string[] {
  const arr = (spec.dependsOnPlans ?? spec.depends_on_plans ?? []) as unknown;
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Normalize plan-level fields from Planner output: accept both camelCase and snake_case.
 * Planner may return title/plan_title, content/plan_content/body, mockups/mock_ups, tasks/task_list.
 */
function normalizePlanSpec(spec: Record<string, unknown>): {
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

/**
 * Ensure plan content has a ## Dependencies section from dependsOnPlans (slugified plan IDs).
 * Used so the dependency graph is built when the agent provides dependsOnPlans.
 */
function ensureDependenciesSection(content: string, dependsOnPlans: string[]): string {
  if (!dependsOnPlans?.length) return content;
  const section = `## Dependencies\n\n${dependsOnPlans.map((s) => `- ${s}`).join("\n")}`;
  const re = /## Dependencies[\s\S]*?(?=##|$)/i;
  if (re.test(content)) {
    return content.replace(re, section);
  }
  return content.trimEnd() + "\n\n" + section;
}

/**
 * Extract a relative path to a .json file from agent response text.
 * Matches backtick-wrapped paths (e.g. `docs/feature-plans/foo.json`) or
 * paths after "saved at" / "written to". Returns the first match or null.
 */
function extractPlanJsonPathFromResponse(content: string): string | null {
  // Backtick-wrapped path ending in .json
  const backtickMatch = content.match(/`([^`]+\.json)`/);
  if (backtickMatch) return backtickMatch[1].trim();
  // "saved at path" or "written to path"
  const phraseMatch = content.match(
    /(?:saved at|written to)\s+[`']?([a-zA-Z0-9_./-]+\.json)[`']?/i
  );
  if (phraseMatch) return phraseMatch[1].trim();
  return null;
}

/**
 * Read a plan JSON file from the repo. Resolves path relative to repoPath,
 * ensures it stays under the repo (no escape), then reads and parses.
 * Returns the parsed object if it has a "title" or "plan_title" key, else null.
 */
async function readPlanJsonFromRepo(
  repoPath: string,
  relativePath: string
): Promise<Record<string, unknown> | null> {
  const normalizedRepo = path.resolve(repoPath);
  const resolved = path.resolve(normalizedRepo, relativePath);
  const relative = path.relative(normalizedRepo, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    log.warn("Plan file path escapes repo, ignoring", { relativePath, resolved });
    return null;
  }
  try {
    const raw = await fs.readFile(resolved, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && (typeof parsed.title === "string" || typeof parsed.plan_title === "string")) {
      return parsed;
    }
    return null;
  } catch (err) {
    log.warn("Failed to read plan JSON from file", {
      path: resolved,
      err: getErrorMessage(err),
    });
    return null;
  }
}

const DECOMPOSE_SYSTEM_PROMPT = `You are an AI planning assistant for OpenSprint. You analyze Product Requirements Documents (PRDs) and suggest a breakdown into discrete, implementable features (Plans).

**Output format:** Your response MUST be the plan(s) as JSON in this message. Do NOT write plans to files; do NOT respond with only a summary or "here's what I created" — the system parses your message for JSON only. Produce exactly the JSON output (no preamble, no explanation after the JSON). You may wrap in a \`\`\`json ... \`\`\` code block. Required shape:

{
  "plans": [
    {
      "title": "Feature Name",
      "content": "# Feature Name\\n\\n## Overview\\n...\\n\\n## Acceptance Criteria\\n...\\n\\n## Dependencies\\nReferences to other plans (e.g. user-authentication) if this feature depends on them.",
      "complexity": "medium",
      "dependsOnPlans": [],
      "mockups": [
        {"title": "Main Screen", "content": "+------------------+\\n| Header           |\\n+------------------+\\n| Content area     |\\n|                  |\\n+------------------+"}
      ],
      "tasks": [
        {"title": "Task title", "description": "Task spec", "priority": 1, "dependsOn": [], "complexity": 3}
      ]
    }
  ]
}

complexity: low, medium, high, or very_high (plan-level). Task-level complexity: integer 1-10 (1=simplest, 10=most complex) — assign per task based on implementation difficulty (1-3: routine, isolated; 4-6: moderate; 7-10: challenging, many integrations). priority: 0=highest. dependsOn: array of task titles this task depends on (blocked by) — use exact titles from your own output. dependsOnPlans: array of slugified plan titles (lowercase, hyphens) that match other plan titles in your output; e.g. if Plan A is "User Authentication", another plan depending on it uses dependsOnPlans: ["user-authentication"]. mockups: array of {title, content} — ASCII wireframes; at least one required per plan.

**Task:** Given the full PRD, produce a feature decomposition. For each feature:
1. Create a Plan with a clear title and full markdown specification
2. Break the Plan into granular, atomic tasks that an AI coding agent can implement
3. Specify task dependencies (dependsOn) where one task must complete before another
4. Recommend implementation order (foundational/risky first)
5. Create at least one UI/UX mockup per Plan using ASCII wireframes

Do NOT create plans that are single massive tasks — each plan should decompose into 2+ atomic tasks.

Plan markdown MUST follow this structure (PRD §7.2.3). Each plan's content must include these sections in order:
${PLAN_MARKDOWN_SECTIONS.map((s) => `- ## ${s}`).join("\n")}

Template structure: ${PLAN_TEMPLATE_STRUCTURE}

Tasks should be atomic, implementable in one agent session, with clear acceptance criteria in the description.

MOCKUPS: Every Plan MUST include at least one mockup. Backend-heavy features: include a mockup of the admin/monitoring UI, API response shape, or data flow diagram — not "N/A". Use box-drawing characters, labels, and annotations.

If the PRD mentions integration points or external services, ensure tasks include setup/configuration steps.`;

const TASK_GENERATION_SYSTEM_PROMPT = `You are an AI planning assistant for OpenSprint. Given a feature plan specification (and optional PRD context), break it down into granular, atomic implementation tasks that an AI coding agent can complete in a single session.

For each task:
1. Title: Clear, specific action (e.g. "Add user login API endpoint", not "Handle auth")
2. Description: Detailed spec with acceptance criteria, which files to create/modify, and how to verify. Include the test command or verification step (e.g., "Run npm test to verify"). For tasks that modify existing files, specify which files.
3. Priority: 0 (highest — foundational/blocking) to 4 (lowest — polish/optional)
4. dependsOn: Array of other task titles this task is blocked by — use exact titles from your own output, copy them verbatim

Guidelines:
- Tasks must be atomic: one coding session, one concern
- Order matters: infrastructure/data-model tasks first, then API, then UI, then integration
- Include testing tasks or criteria within each task description
- Be specific about file paths and technology choices based on the plan

Respond with ONLY valid JSON (you may wrap in a markdown json code block):
{
  "tasks": [
    {"title": "Task title", "description": "Detailed implementation spec with acceptance criteria", "priority": 1, "dependsOn": [], "complexity": 3}
  ]
}

Task-level complexity: integer 1-10 (1=simplest, 10=most complex) — assign per task based on implementation difficulty (1-3: routine, isolated; 4-6: moderate; 7-10: challenging, many integrations).`;

const AUTO_REVIEW_SYSTEM_PROMPT = `You are an auto-review agent for OpenSprint. After a plan is decomposed from a PRD, you review the generated plans and tasks against the existing codebase to identify what is already implemented.

Your task: Given the list of created plans/tasks and a summary of the repository structure and key files, identify which tasks are ALREADY IMPLEMENTED in the codebase. Only mark tasks as implemented when there is clear evidence in the code (e.g., the described functionality exists, the API endpoint is present, the component is built).

Respond with ONLY valid JSON in this exact format (no markdown wrapper):
{
  "taskIdsToClose": ["<task-id-1>", "<task-id-2>"],
  "reason": "Brief explanation of what was found"
}

Rules:
- taskIdsToClose: array of task IDs from the provided plan summary — not indices. The orchestrator passes these; use them exactly (e.g. os-a3f8.1).
- Epic-blocked model: no gate tasks exist. Do NOT include epic IDs — only close individual implementation tasks.
- If nothing is implemented, return {"taskIdsToClose": [], "reason": "No existing implementation found"}.
- Be conservative: only include tasks where the implementation clearly exists. When evidence is ambiguous (e.g., similar but not identical functionality), do NOT close the task. When in doubt, leave the task open.`;

const COMPLEXITY_EVALUATION_SYSTEM_PROMPT = `Evaluate complexity (low|medium|high|very_high) based on scope, risk, integrations. Respond with JSON only: {"complexity":"<value>"}

- low: Small, isolated change; few files; minimal risk
- medium: Moderate scope; several components; standard patterns
- high: Large feature; many integrations; non-trivial architecture
- very_high: Major undertaking; high risk; complex dependencies; significant refactoring`;

const VALID_COMPLEXITIES: PlanComplexity[] = ["low", "medium", "high", "very_high"];

export class PlanService {
  private projectService = new ProjectService();
  private taskStore = taskStoreSingleton;
  private chatService = new ChatService();
  private prdService = new PrdService();

  /** Load plan infos (planId, epicId, content) from task store for building edges. */
  private async getPlanInfosFromStore(
    projectId: string
  ): Promise<Array<{ planId: string; epicId: string; content: string }>> {
    const planIds = await this.taskStore.planListIds(projectId);
    const infos: Array<{ planId: string; epicId: string; content: string }> = [];
    for (const planId of planIds) {
      const row = await this.taskStore.planGet(projectId, planId);
      if (!row) continue;
      const epicId = (row.metadata.epicId as string) ?? "";
      infos.push({ planId, epicId, content: row.content });
    }
    return infos;
  }

  /** Get the planning-runs directory for a project */
  private async getPlanningRunsDir(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, OPENSPRINT_PATHS.planningRuns);
  }

  /** Get repo path for a project */
  private async getRepoPath(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return project.repoPath;
  }

  /**
   * Evaluate plan complexity using the planning agent. Returns "medium" on parse failure.
   */
  async evaluateComplexity(
    projectId: string,
    title: string,
    content: string
  ): Promise<PlanComplexity> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.projectService.getSettings(projectId);

    const prompt = `Evaluate the implementation complexity of this feature plan.\n\n## Title\n${title}\n\n## Content\n${content}`;

    const agentId = `plan-complexity-${projectId}-${Date.now()}`;

    const response = await agentService.invokePlanningAgent({
      projectId,
      config: getAgentForPlanningRole(settings, "planner"),
      messages: [{ role: "user", content: prompt }],
      systemPrompt: COMPLEXITY_EVALUATION_SYSTEM_PROMPT,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "planner",
        label: "Complexity evaluation",
      },
    });

    const parsed = extractJsonFromAgentResponse<{ complexity?: string }>(
      response.content,
      "complexity"
    );
    if (parsed) {
      const c = parsed.complexity;
      if (c && VALID_COMPLEXITIES.includes(c as PlanComplexity)) {
        return c as PlanComplexity;
      }
    }
    return "medium";
  }

  /** Count tasks under an epic (implementation tasks only; no gate in epic-blocked model) */
  private async countTasks(
    projectId: string,
    epicId: string,
    allIssues?: StoredTask[]
  ): Promise<{ total: number; done: number }> {
    try {
      const issues = allIssues ?? (await this.taskStore.listAll(projectId));
      const children = issues.filter(
        (issue: StoredTask) =>
          issue.id.startsWith(epicId + ".") && (issue.issue_type ?? issue.type) !== "epic"
      );
      const done = children.filter(
        (issue: StoredTask) => (issue.status as string) === "closed"
      ).length;
      return { total: children.length, done };
    } catch (err) {
      log.warn("countTasks failed, using default", { err: getErrorMessage(err) });
      return { total: 0, done: 0 };
    }
  }

  /**
   * Core: build dependency edges from plan infos (task store + markdown).
   * Shared by buildDependencyEdges and buildDependencyEdgesFromProject.
   * When allIssues is provided (e.g. from listPlansWithEdges), avoids a separate listAll call.
   */
  private async buildDependencyEdgesCore(
    planInfos: Array<{ planId: string; epicId: string; content: string }>,
    projectId: string,
    allIssuesParam?: StoredTask[]
  ): Promise<PlanDependencyEdge[]> {
    const edges: PlanDependencyEdge[] = [];
    const seenEdges = new Set<string>();
    const epicToPlan = new Map(planInfos.filter((p) => p.epicId).map((p) => [p.epicId, p.planId]));

    const addEdge = (fromPlanId: string, toPlanId: string) => {
      if (fromPlanId === toPlanId) return;
      const key = `${fromPlanId}->${toPlanId}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push({ from: fromPlanId, to: toPlanId, type: "blocks" });
    };

    // 1. Build edges from task store
    try {
      const allIssues = allIssuesParam ?? (await this.taskStore.listAll(projectId));
      for (const issue of allIssues) {
        const deps = (issue.dependencies as Array<{ depends_on_id: string; type: string }>) ?? [];
        const blockers = deps.filter((d) => d.type === "blocks").map((d) => d.depends_on_id);
        const myEpicId = getEpicId(issue.id);
        const toPlanId = epicToPlan.get(myEpicId);
        if (!toPlanId) continue;
        for (const blockerId of blockers) {
          const blockerEpicId = getEpicId(blockerId);
          const fromPlanId = epicToPlan.get(blockerEpicId);
          if (fromPlanId && blockerEpicId !== myEpicId) {
            addEdge(fromPlanId, toPlanId);
          }
        }
      }
    } catch (err) {
      log.warn("buildDependencyEdgesCore: task store unavailable", { err: getErrorMessage(err) });
    }

    // 2. Parse Plan markdown for "## Dependencies" section
    for (const plan of planInfos) {
      const depsSection = plan.content.match(/## Dependencies[\s\S]*?(?=##|$)/i);
      if (!depsSection) continue;
      const text = depsSection[0].toLowerCase();
      for (const other of planInfos) {
        if (other.planId === plan.planId) continue;
        const slug = other.planId.replace(/-/g, "[\\s-]*");
        if (new RegExp(slug, "i").test(text)) {
          addEdge(other.planId, plan.planId);
        }
      }
    }

    return edges;
  }

  /** Build dependency edges between plans (from task store + markdown). */
  private async buildDependencyEdges(
    plans: Plan[],
    projectId: string
  ): Promise<PlanDependencyEdge[]> {
    const planInfos = plans.map((p) => ({
      planId: p.metadata.planId,
      epicId: p.metadata.epicId,
      content: p.content,
    }));
    return this.buildDependencyEdgesCore(planInfos, projectId);
  }

  /** List all Plans with dependency graph in one call (avoids duplicate work) */
  async listPlansWithDependencyGraph(projectId: string): Promise<PlanDependencyGraph> {
    return this.listPlansWithEdges(projectId);
  }

  /** Internal: list plans and build edges once. Uses a single listAll for the whole operation. */
  private async listPlansWithEdges(projectId: string): Promise<PlanDependencyGraph> {
    const planInfos = await this.getPlanInfosFromStore(projectId);
    const allIssues = await this.taskStore.listAll(projectId);
    const edges = await this.buildDependencyEdgesCore(planInfos, projectId, allIssues);

    const plans: Plan[] = [];
    for (const { planId } of planInfos) {
      try {
        const plan = await this.getPlan(projectId, planId, { allIssues, edges });
        plans.push(plan);
      } catch (err) {
        log.warn("Skipping broken plan", { planId, err: getErrorMessage(err) });
      }
    }

    return { plans, edges };
  }

  /** List all Plans for a project */
  async listPlans(projectId: string): Promise<Plan[]> {
    const { plans } = await this.listPlansWithEdges(projectId);
    return plans;
  }

  /** Build dependency edges from task store and plan content. */
  private async buildDependencyEdgesFromProject(projectId: string): Promise<PlanDependencyEdge[]> {
    const planInfos = await this.getPlanInfosFromStore(projectId);
    return this.buildDependencyEdgesCore(planInfos, projectId);
  }

  /** Get a single Plan by ID. Optionally pass allIssues/edges to avoid redundant task store calls (e.g. from listPlansWithEdges). */
  async getPlan(
    projectId: string,
    planId: string,
    opts?: { allIssues?: StoredTask[]; edges?: PlanDependencyEdge[] }
  ): Promise<Plan> {
    const row = await this.taskStore.planGet(projectId, planId);
    if (!row) {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan '${planId}' not found`, { planId });
    }
    const content = row.content;
    const lastModified = row.updated_at;
    const metadata: PlanMetadata = {
      planId: (row.metadata.planId as string) ?? planId,
      epicId: (row.metadata.epicId as string) ?? "",
      shippedAt: (row.metadata.shippedAt as string | null) ?? null,
      complexity: (row.metadata.complexity as PlanMetadata["complexity"]) ?? "medium",
      mockups: (row.metadata.mockups as PlanMetadata["mockups"]) ?? undefined,
    };

    // Derive status from task store: planning = epic blocked; building = epic open + tasks pending; complete = all done
    let status: Plan["status"] = "planning";
    const { total, done } = metadata.epicId
      ? opts?.allIssues
        ? await this.countTasks(projectId, metadata.epicId, opts.allIssues)
        : await this.countTasks(projectId, metadata.epicId, undefined)
      : { total: 0, done: 0 };

    if (metadata.epicId && opts?.allIssues) {
      const epicIssue = opts.allIssues.find((i) => i.id === metadata.epicId);
      const epicStatus = (epicIssue?.status as string) ?? "open";
      if (epicStatus === "blocked") {
        status = "planning";
      } else if (metadata.shippedAt) {
        status = total > 0 && done === total ? "complete" : "building";
      } else {
        status = total > 0 && done === total ? "complete" : "building";
      }
    } else if (metadata.epicId) {
      try {
        const epicIssue = await this.taskStore.show(projectId, metadata.epicId);
        const epicStatus = (epicIssue.status as string) ?? "open";
        if (epicStatus === "blocked") {
          status = "planning";
        } else if (metadata.shippedAt) {
          status = total > 0 && done === total ? "complete" : "building";
        } else {
          status = total > 0 && done === total ? "complete" : "building";
        }
      } catch {
        status = metadata.shippedAt
          ? total > 0 && done === total
            ? "complete"
            : "building"
          : "planning";
      }
    } else if (metadata.shippedAt) {
      status = total > 0 && done === total ? "complete" : "building";
    }

    const dependencyCount = opts?.edges
      ? opts.edges.filter((e) => e.to === planId).length
      : (await this.buildDependencyEdgesFromProject(projectId)).filter((e) => e.to === planId)
          .length;

    return {
      metadata,
      content,
      status,
      taskCount: total,
      doneTaskCount: done,
      dependencyCount,
      lastModified,
    };
  }

  /** Create a new Plan with epic (epic-blocked model: no gate task) */
  async createPlan(
    projectId: string,
    body: {
      title?: string;
      plan_title?: string;
      content?: string;
      plan_content?: string;
      complexity?: string;
      mockups?: PlanMockup[];
      dependsOnPlans?: string[];
      depends_on_plans?: string[];
      tasks?: Array<Record<string, unknown>>;
    }
  ): Promise<Plan> {
    await this.getRepoPath(projectId);

    // Normalize: accept camelCase (title, content) or snake_case (plan_title, plan_content) from Planner/API
    const rawTitle = (body.title ?? body.plan_title) as string | undefined;
    const rawContent = (body.content ?? body.plan_content) as string | undefined;
    if (!rawTitle?.trim()) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Plan requires title or plan_title", {});
    }
    const title = rawTitle.trim();
    const content =
      typeof rawContent === "string" && rawContent.trim()
        ? rawContent.trim()
        : `# ${title}\n\nNo content.`;

    // Ensure ## Dependencies section from dependsOnPlans so the dependency graph is populated
    const dependsOn = normalizeDependsOnPlans(body as Record<string, unknown>);
    const contentToWrite =
      dependsOn.length > 0 ? ensureDependenciesSection(content, dependsOn) : content;

    // Resolve complexity: use provided value if valid, else agent-evaluate
    let complexity: PlanComplexity;
    const provided = body.complexity as PlanComplexity | undefined;
    if (provided && VALID_COMPLEXITIES.includes(provided)) {
      complexity = provided;
    } else {
      complexity = await this.evaluateComplexity(projectId, title, contentToWrite);
    }

    // Generate plan ID from title
    const planId = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Validate against template (warn only, don't block) — PRD §7.2.3
    const validation = validatePlanContent(content);
    if (validation.warnings.length > 0) {
      log.warn("Plan validation", { planId, warnings: validation.warnings });
    }

    // Create plan epic with status blocked (Execute! will set open)
    const epicComplexity = planComplexityToTask(complexity);
    const epicResult = await this.taskStore.create(projectId, title, {
      type: "epic",
      complexity: epicComplexity,
    });
    const epicId = epicResult.id;

    // Set epic description to plan ID (canonical link is plans table epic_id)
    await this.taskStore.update(projectId, epicId, { description: planId });
    await this.taskStore.update(projectId, epicId, { status: "blocked" });

    // Create child tasks if provided (batch create + batch dependencies)
    // Normalize tasks: accept camelCase and snake_case from Planner/API; filter out malformed entries
    const createdTaskIds: string[] = [];
    const createdTaskTitles: string[] = [];
    const rawTasksInput = (body.tasks ??
      (body as Record<string, unknown>).task_list ??
      []) as unknown[];
    const rawTasks = Array.isArray(rawTasksInput)
      ? rawTasksInput.filter(
          (t): t is Record<string, unknown> => t != null && typeof t === "object"
        )
      : [];
    if (rawTasks.length > 0) {
      const tasks = rawTasks.map((t) => normalizePlannerTask(t, rawTasks));
      const planTaskComplexity = planComplexityToTask(complexity);
      const inputs = tasks.map((task) => ({
        title: task.title,
        type: "task" as const,
        description: task.description,
        priority: Math.min(4, Math.max(0, task.priority)),
        parentId: epicId,
        complexity: task.complexity ?? planTaskComplexity,
      }));
      const created = await this.taskStore.createMany(projectId, inputs);
      const taskIdMap = new Map<string, string>();
      created.forEach((t, i) => {
        taskIdMap.set(tasks[i]!.title, t.id);
        createdTaskIds.push(t.id);
        createdTaskTitles.push(tasks[i]!.title);
      });

      // Inter-task dependencies
      const interDeps: Array<{ childId: string; parentId: string; type?: string }> = [];
      for (const task of tasks) {
        const childId = taskIdMap.get(task.title);
        if (!childId || !task.dependsOn.length) continue;
        for (const depTitle of task.dependsOn) {
          const parentId = taskIdMap.get(depTitle);
          if (parentId) interDeps.push({ childId, parentId, type: "blocks" });
        }
      }
      if (interDeps.length > 0) {
        await this.taskStore.addDependencies(projectId, interDeps);
      }

      // File-scope labels for parallel scheduling (preserve from raw task)
      for (let i = 0; i < rawTasks.length; i++) {
        const task = rawTasks[i]!;
        const files = task.files as { modify?: string[]; create?: string[] } | undefined;
        if (files && (files.modify?.length || files.create?.length)) {
          const filesJson = JSON.stringify(files);
          await this.taskStore.addLabel(projectId, created[i]!.id, `files:${filesJson}`);
        }
      }
    }

    // Write plan row to task store (accept mockups or mock_ups from Planner/API)
    const rawMockups = (body.mockups ??
      (body as Record<string, unknown>).mock_ups ??
      []) as PlanMockup[];
    const mockups: PlanMockup[] = Array.isArray(rawMockups)
      ? rawMockups.filter((m) => m && typeof m === "object" && m.title && m.content)
      : [];
    const metadata: PlanMetadata = {
      planId,
      epicId: epicId,
      shippedAt: null,
      complexity,
      mockups: mockups.length > 0 ? mockups : undefined,
    };
    await this.taskStore.planInsert(projectId, planId, {
      epic_id: epicId,
      content: contentToWrite,
      metadata: JSON.stringify(metadata),
    });

    const plan: Plan & { _createdTaskIds?: string[]; _createdTaskTitles?: string[] } = {
      metadata,
      content: contentToWrite,
      status: "planning",
      taskCount: rawTasks.length,
      doneTaskCount: 0,
      dependencyCount: 0,
    };
    if (createdTaskIds.length > 0) {
      plan._createdTaskIds = createdTaskIds;
      plan._createdTaskTitles = createdTaskTitles;
    }
    return plan;
  }

  /** Update a Plan's markdown */
  async updatePlan(projectId: string, planId: string, body: { content: string }): Promise<Plan> {
    await this.taskStore.planUpdateContent(projectId, planId, body.content);

    // Validate against template (warn only, don't block) — PRD §7.2.3
    const validation = validatePlanContent(body.content);
    if (validation.warnings.length > 0) {
      log.warn("Plan validation on update", { planId, warnings: validation.warnings });
    }

    // Sync plan markdown tasks to task store when ## Tasks section is present
    await syncPlanTasksFromContent(projectId, planId, body.content);

    return this.getPlan(projectId, planId);
  }

  /**
   * Auto-generate implementation tasks for a plan that has none.
   * Invokes the planning agent to decompose the plan's markdown into atomic tasks,
   * creates them as tasks under the existing epic, and runs auto-review
   * to mark any already-implemented tasks as done.
   */
  private async generateAndCreateTasks(
    projectId: string,
    repoPath: string,
    plan: Plan
  ): Promise<{ count: number; taskRefs: Array<{ id: string; title: string }> }> {
    const settings = await this.projectService.getSettings(projectId);
    const epicId = plan.metadata.epicId;

    if (!epicId) return { count: 0, taskRefs: [] };

    // Build prompt with plan content + PRD context
    const prdContext = await this.buildPrdContext(projectId);
    const prompt = `Break down the following feature plan into implementation tasks.\n\n## Feature Plan\n\n${plan.content}\n\n## PRD Context\n\n${prdContext}`;

    const agentId = `plan-task-gen-${projectId}-${Date.now()}`;

    const taskGenPrompt = (() => {
      const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
      return autonomyDesc
        ? `${TASK_GENERATION_SYSTEM_PROMPT}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
        : TASK_GENERATION_SYSTEM_PROMPT;
    })();
    const response = await agentService.invokePlanningAgent({
      projectId,
      config: getAgentForPlanningRole(settings, "planner", plan.metadata.complexity),
      messages: [{ role: "user", content: prompt }],
      systemPrompt: taskGenPrompt,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "planner",
        label: "Task generation",
        planId: plan.metadata.planId,
      },
    });

    const content = response?.content;
    if (content == null || typeof content !== "string") {
      log.warn("Task generation agent did not return content, shipping without tasks");
      return { count: 0, taskRefs: [] };
    }

    // Parse tasks from agent response — accept "tasks" or "task_list" (Planner may use either)
    const parsed =
      extractJsonFromAgentResponse<{ tasks?: unknown[]; task_list?: unknown[] }>(
        content,
        "tasks"
      ) ??
      extractJsonFromAgentResponse<{ tasks?: unknown[]; task_list?: unknown[] }>(
        content,
        "task_list"
      );
    if (!parsed) {
      log.warn("Task generation agent did not return valid JSON, shipping without tasks");
      return { count: 0, taskRefs: [] };
    }

    const rawTasksInput = (parsed.tasks ?? parsed.task_list ?? []) as unknown[];
    const rawTasks = Array.isArray(rawTasksInput)
      ? rawTasksInput.filter(
          (t): t is Record<string, unknown> => t != null && typeof t === "object"
        )
      : [];
    if (rawTasks.length === 0) {
      log.warn("Task generation returned no tasks");
      return { count: 0, taskRefs: [] };
    }

    // Normalize: accept camelCase and snake_case from Planner (title/task_title, dependsOn/depends_on, indices)
    const tasks = rawTasks.map((t) => normalizePlannerTask(t, rawTasks));

    // Create tasks under the existing epic (batch create + batch dependencies)
    const planTaskComplexity = planComplexityToTask(plan.metadata.complexity);
    const inputs = tasks.map((task) => ({
      title: task.title,
      type: "task" as const,
      description: task.description || "",
      priority: Math.min(4, Math.max(0, task.priority ?? 2)),
      parentId: epicId,
      complexity: task.complexity ?? planTaskComplexity,
    }));
    const created = await this.taskStore.createMany(projectId, inputs);
    const taskIdMap = new Map<string, string>();
    created.forEach((t, i) => taskIdMap.set(tasks[i]!.title, t.id));

    // Inter-task dependencies (no gate dep — epic blocked state controls readiness)
    const interDeps: Array<{ childId: string; parentId: string; type?: string }> = [];
    for (const task of tasks) {
      const childId = taskIdMap.get(task.title);
      if (!childId || !task.dependsOn.length) continue;
      for (const depTitle of task.dependsOn) {
        const parentId = taskIdMap.get(depTitle);
        if (parentId) interDeps.push({ childId, parentId, type: "blocks" });
      }
    }
    if (interDeps.length > 0) {
      await this.taskStore.addDependencies(projectId, interDeps);
    }

    broadcastToProject(projectId, { type: "plan.updated", planId: plan.metadata.planId });

    log.info("Generated tasks for plan", {
      count: tasks.length,
      planId: plan.metadata.planId,
    });

    const taskRefs = tasks
      .filter((t) => taskIdMap.has(t.title))
      .map((t) => ({ id: taskIdMap.get(t.title)!, title: t.title }));
    return { count: tasks.length, taskRefs };
  }

  /**
   * Plan Tasks — Create epic if missing, then invoke Planner to generate tasks.
   * When a plan has no child implementation tasks, this creates tasks as child tasks
   * under the epic (no gate; epic blocked state controls readiness).
   * PRD §7.2.2: Planner outputs indexed task list; orchestrator creates issues.
   */
  async planTasks(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);
    let epicId = plan.metadata.epicId?.trim() || null;

    if (!epicId) {
      const title = getEpicTitleFromPlanContent(plan.content, planId);
      const epicComplexity = plan.metadata.complexity
        ? planComplexityToTask(plan.metadata.complexity)
        : undefined;
      const epicResult = await this.taskStore.create(projectId, title, {
        type: "epic",
        ...(epicComplexity != null && { complexity: epicComplexity }),
      });
      epicId = epicResult.id;
      await this.taskStore.update(projectId, epicId, { description: planId });
      await this.taskStore.update(projectId, epicId, { status: "blocked" });
      plan.metadata.epicId = epicId;
      await this.taskStore.planUpdateMetadata(
        projectId,
        planId,
        plan.metadata as unknown as Record<string, unknown>
      );
      log.info("Created missing epic for plan", { planId, epicId, title });
    } else {
      await this.taskStore.update(projectId, epicId, { status: "blocked" });
    }

    if (plan.taskCount > 0) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "Plan already has implementation tasks. Use Execute! to start building."
      );
    }

    let tasksGenerated = 0;
    let _taskRefs: Array<{ id: string; title: string }> = [];
    try {
      const genResult = await this.generateAndCreateTasks(projectId, repoPath, plan);
      tasksGenerated = genResult.count;
      _taskRefs = genResult.taskRefs;
      if (tasksGenerated > 0) {
        const updatedPlan = await this.getPlan(projectId, planId);
        await this.autoReviewPlanAgainstRepo(projectId, [updatedPlan]);
      }
    } catch (err) {
      log.error("Task generation failed", { planId, err });
      throw err;
    }

    if (tasksGenerated === 0) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_PARSE_FAILED,
        "Planner did not return valid tasks. Try refining the plan content."
      );
    }

    broadcastToProject(projectId, { type: "plan.updated", planId });
    return this.getPlan(projectId, planId);
  }

  /** Build It! — auto-generate tasks if needed, unblock epic to make tasks eligible */
  async shipPlan(projectId: string, planId: string): Promise<Plan> {
    let plan = await this.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);

    // Two-phase flow: when plan has no implementation tasks, route to Plan Tasks first
    if (plan.taskCount === 0 && plan.metadata.epicId) {
      plan = await this.planTasks(projectId, planId);
    }

    const epicId = plan.metadata.epicId;
    if (!epicId) {
      throw new AppError(400, ErrorCodes.NO_EPIC, "Plan has no epic");
    }

    // If no implementation tasks exist, auto-generate them from the plan spec
    let tasksGenerated = 0;
    if (plan.taskCount === 0) {
      try {
        const genResult = await this.generateAndCreateTasks(projectId, repoPath, plan);
        tasksGenerated = genResult.count;
        if (tasksGenerated > 0) {
          // Auto-review: mark already-implemented tasks as done
          const updatedPlan = await this.getPlan(projectId, planId);
          await this.autoReviewPlanAgainstRepo(projectId, [updatedPlan]);
        }
      } catch (err) {
        log.error("Task generation failed, shipping without tasks", { err });
        // Ship proceeds even if task generation fails; user can add tasks manually
      }
    }

    // Unblock epic (Execute!) — tasks become eligible per their own deps
    await this.taskStore.update(projectId, epicId, { status: "open" });

    // Save plan content for next Re-execute (plan_old = this content)
    await this.taskStore.planSetShippedContent(projectId, planId, plan.content);

    // Update metadata
    plan.metadata.shippedAt = new Date().toISOString();
    await this.taskStore.planUpdateMetadata(
      projectId,
      planId,
      plan.metadata as unknown as Record<string, unknown>
    );

    // Living PRD sync: invoke planning agent to review Plan vs PRD and update affected sections (PRD §15.1)
    try {
      await this.chatService.syncPrdFromPlanShip(
        projectId,
        planId,
        plan.content,
        plan.metadata.complexity
      );
    } catch (err) {
      log.error("PRD sync on build approval failed", { err });
      // Build approval succeeds even if PRD sync fails; user can manually update PRD
    }

    // Re-fetch plan to include updated task counts when tasks were generated
    if (tasksGenerated > 0) {
      const finalPlan = await this.getPlan(projectId, planId);
      return { ...finalPlan, status: "building" };
    }

    return { ...plan, status: "building" };
  }

  /** Rebuild an updated Plan — PRD §7.2.2: Auditor performs capability audit and delta task generation */
  async reshipPlan(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);
    const epicId = plan.metadata.epicId;

    // Verify all existing tasks are Done or none started
    if (epicId) {
      const allIssues = await this.taskStore.listAll(projectId);
      const children = allIssues.filter(
        (issue: StoredTask) =>
          issue.id.startsWith(epicId + ".") && (issue.issue_type ?? issue.type) !== "epic"
      );

      const hasInProgress = children.some((issue: StoredTask) => issue.status === "in_progress");
      if (hasInProgress) {
        throw new AppError(
          400,
          ErrorCodes.TASKS_IN_PROGRESS,
          "Cannot rebuild while tasks are In Progress or In Review"
        );
      }

      const allDone = children.every((issue: StoredTask) => issue.status === "closed");
      const noneStarted = children.every((issue: StoredTask) => issue.status === "open");

      if (noneStarted && children.length > 0) {
        const toDelete = allIssues.filter(
          (i: StoredTask) => i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );
        for (const child of toDelete) {
          await this.taskStore.delete(projectId, child.id);
        }
        return this.shipPlan(projectId, planId);
      }
      if (!allDone && children.length > 0) {
        throw new AppError(
          400,
          ErrorCodes.TASKS_NOT_COMPLETE,
          "All tasks must be Done before rebuilding (or none started)"
        );
      }
    }

    // All done: Auditor audits capabilities and generates delta tasks (PRD §12.3.6)
    const { fileTree, keyFilesContent, completedTasksJson } = await this.assembleReExecuteContext(
      projectId,
      repoPath,
      epicId ?? ""
    );

    const planOld =
      (await this.taskStore.planGetShippedContent(projectId, planId)) ??
      "# Plan (no previous shipped version)";
    const planNew = plan.content;

    const auditorPrompt = buildAuditorPrompt(planId, epicId ?? "");
    const auditorFullPrompt = `${auditorPrompt}

## context/file_tree.txt

${fileTree}

## context/key_files/

${keyFilesContent}

## context/completed_tasks.json

${completedTasksJson}

## context/plan_old.md

${planOld}

## context/plan_new.md

${planNew}`;

    const agentIdAuditor = `auditor-${projectId}-${planId}-${Date.now()}`;

    const settings = await this.projectService.getSettings(projectId);
    const auditorResponse = await agentService.invokePlanningAgent({
      projectId,
      config: getAgentForPlanningRole(settings, "auditor", plan.metadata.complexity),
      messages: [{ role: "user", content: auditorFullPrompt }],
      systemPrompt:
        "You are the Auditor agent for OpenSprint (PRD §12.3.6). Audit the app's current capabilities and generate delta tasks for re-execution.",
      cwd: repoPath,
      tracking: {
        id: agentIdAuditor,
        projectId,
        phase: "plan",
        role: "auditor",
        label: "Re-execute: audit & delta tasks",
        planId,
      },
    });

    const auditorResult = parseAuditorResult(auditorResponse.content);
    if (!auditorResult || auditorResult.status === "failed") {
      log.error("Auditor failed or returned invalid result, falling back to full rebuild");
      return this.shipPlan(projectId, planId);
    }

    if (
      auditorResult.status === "no_changes_needed" ||
      !auditorResult.tasks ||
      auditorResult.tasks.length === 0
    ) {
      // Re-execute no delta: don't change epic status
      return this.getPlan(projectId, planId);
    }

    // Set epic blocked before delta tasks (second Execute! will unblock)
    if (epicId) {
      await this.taskStore.update(projectId, epicId, { status: "blocked" });
    }

    // Create delta tasks without gate (epic blocked; Execute! will unblock)
    const planTaskComplexity = planComplexityToTask(plan.metadata.complexity);
    const taskIdMap = new Map<number, string>();
    for (const task of auditorResult.tasks) {
      const priority = Math.min(4, Math.max(0, task.priority ?? 2));
      const taskResult = await this.taskStore.createWithRetry(
        projectId,
        task.title,
        {
          type: "task",
          description: task.description || "",
          priority,
          parentId: epicId,
          complexity: task.complexity ?? planTaskComplexity,
        },
        { fallbackToStandalone: true }
      );
      if (!taskResult) {
        log.warn("Failed to create delta task after retries, skipping", {
          title: task.title,
          planId,
        });
        continue;
      }
      taskIdMap.set(task.index, taskResult.id);
    }

    for (const task of auditorResult.tasks) {
      if (task.depends_on && task.depends_on.length > 0) {
        const childId = taskIdMap.get(task.index);
        if (childId) {
          for (const depIndex of task.depends_on) {
            const parentId = taskIdMap.get(depIndex);
            if (parentId) {
              await this.taskStore.addDependency(projectId, childId, parentId);
            }
          }
        }
      }
    }

    return this.getPlan(projectId, planId);
  }

  /** Lightweight check: repo has at least one source file (same skip list as buildFileTree). */
  async hasExistingCode(projectId: string): Promise<boolean> {
    const project = await this.projectService.getProject(projectId);
    const repoPath = project.repoPath;
    const SKIP_DIRS = new Set([
      ".git",
      "node_modules",
      ".opensprint",
      "dist",
      "build",
      ".next",
      ".turbo",
      "coverage",
    ]);
    const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"];

    const walk = async (dir: string): Promise<boolean> => {
      let entries: { name: string; isDirectory: () => boolean }[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (await walk(full)) return true;
        } else if (SOURCE_EXT.some((e) => entry.name.endsWith(e))) {
          return true;
        }
      }
      return false;
    };
    return walk(repoPath);
  }

  /** Get codebase context (file tree + key file contents) for a project. Used by sketch generate-from-codebase and plan auto-review. */
  async getCodebaseContext(
    projectId: string
  ): Promise<{ fileTree: string; keyFilesContent: string }> {
    const project = await this.projectService.getProject(projectId);
    const fileTree = await this.buildFileTree(project.repoPath);
    const keyFilesContent = await this.getKeyFilesContent(project.repoPath);
    return { fileTree, keyFilesContent };
  }

  /** Assemble context for Auditor: file tree, key files, completed tasks (PRD §12.3.6) */
  private async assembleReExecuteContext(
    projectId: string,
    repoPath: string,
    epicId: string
  ): Promise<{ fileTree: string; keyFilesContent: string; completedTasksJson: string }> {
    const fileTree = await this.buildFileTree(repoPath);
    const keyFilesContent = await this.getKeyFilesContent(repoPath);
    const completedTasks = await this.getCompletedTasksForEpic(projectId, epicId);
    const completedTasksJson = JSON.stringify(completedTasks, null, 2);
    return { fileTree, keyFilesContent, completedTasksJson };
  }

  /** Build file tree string (excludes node_modules, .git, etc.) */
  private async buildFileTree(repoPath: string): Promise<string> {
    const SKIP_DIRS = new Set([
      ".git",
      "node_modules",
      ".opensprint",
      "dist",
      "build",
      ".next",
      ".turbo",
      "coverage",
    ]);
    const lines: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries: { name: string; isDirectory: () => boolean }[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      for (const entry of sorted) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(repoPath, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          lines.push(rel + "/");
          await walk(full);
        } else {
          lines.push(rel);
        }
      }
    };
    await walk(repoPath);
    return lines.join("\n") || "(empty)";
  }

  /** Get content of key source files (capped by size) */
  private async getKeyFilesContent(repoPath: string): Promise<string> {
    const EXT = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"];
    const SKIP = ["node_modules", ".git", ".opensprint", "dist", "build", ".next"];
    const MAX_FILE = 50 * 1024;
    const MAX_TOTAL = 200 * 1024;
    let total = 0;
    const parts: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (total >= MAX_TOTAL) return;
      let entries: { name: string; isDirectory: () => boolean }[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = full.replace(repoPath + path.sep, "").replace(/\\/g, "/");
        if (entry.isDirectory()) {
          if (!SKIP.includes(entry.name)) await walk(full);
        } else if (EXT.some((e) => entry.name.endsWith(e))) {
          try {
            const content = await fs.readFile(full, "utf-8");
            const truncated =
              content.length > MAX_FILE
                ? content.slice(0, MAX_FILE) + "\n... (truncated)"
                : content;
            parts.push(`### ${rel}\n\n\`\`\`\n${truncated}\n\`\`\`\n`);
            total += truncated.length;
            if (total >= MAX_TOTAL) return;
          } catch {
            // skip unreadable
          }
        }
      }
    };
    await walk(repoPath);
    return parts.join("\n") || "(no source files)";
  }

  /** Get completed (closed) tasks for epic for Auditor context (no gate — epic-blocked model) */
  private async getCompletedTasksForEpic(
    projectId: string,
    epicId: string
  ): Promise<Array<{ id: string; title: string; description?: string; close_reason?: string }>> {
    const all = await this.taskStore.listAll(projectId);
    const closed = all.filter(
      (i: StoredTask) =>
        i.id.startsWith(epicId + ".") &&
        (i.issue_type ?? i.type) !== "epic" &&
        (i.status as string) === "closed"
    );
    return closed.map((i: StoredTask) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      close_reason: (i.close_reason as string) ?? (i as { close_reason?: string }).close_reason,
    }));
  }

  /** Get the dependency graph for all Plans */
  async getDependencyGraph(projectId: string): Promise<PlanDependencyGraph> {
    return this.listPlansWithDependencyGraph(projectId);
  }

  /**
   * Get cross-epic dependencies: plans that must be executed first (still in Planning state).
   * Returns prerequisite plan IDs in topological order for execution.
   */
  async getCrossEpicDependencies(
    projectId: string,
    planId: string
  ): Promise<CrossEpicDependenciesResponse> {
    const { plans, edges } = await this.listPlansWithDependencyGraph(projectId);
    const planById = new Map(plans.map((p) => [p.metadata.planId, p]));
    const targetPlan = planById.get(planId);
    if (!targetPlan) {
      return { prerequisitePlanIds: [] };
    }

    // Edges: (from, to) means "from blocks to" — so "to" depends on "from"
    // Collect all prerequisites (plans that block us) that are still in planning
    const inPlanning = new Set(
      plans.filter((p) => p.status === "planning").map((p) => p.metadata.planId)
    );
    const directPrereqs = new Set<string>();
    for (const edge of edges) {
      if (edge.to === planId && inPlanning.has(edge.from)) {
        directPrereqs.add(edge.from);
      }
    }

    // Transitive closure: include prerequisites of prerequisites
    const allPrereqs = new Set<string>();
    const visit = (p: string) => {
      if (allPrereqs.has(p)) return;
      allPrereqs.add(p);
      for (const e of edges) {
        if (e.to === p && inPlanning.has(e.from)) visit(e.from);
      }
    };
    for (const p of directPrereqs) visit(p);

    // Topological sort: for each prereq, all its dependencies must come first
    const sorted: string[] = [];
    const visited = new Set<string>();
    const visitSort = (p: string) => {
      if (visited.has(p)) return;
      visited.add(p);
      for (const e of edges) {
        if (e.to === p && allPrereqs.has(e.from)) visitSort(e.from);
      }
      sorted.push(p);
    };
    for (const p of allPrereqs) visitSort(p);

    return { prerequisitePlanIds: sorted };
  }

  /**
   * Execute a plan and its prerequisites in dependency order.
   * Prerequisites must be in topological order (as returned by getCrossEpicDependencies).
   */
  async shipPlanWithPrerequisites(
    projectId: string,
    planId: string,
    prerequisitePlanIds: string[]
  ): Promise<Plan> {
    for (const prereqId of prerequisitePlanIds) {
      await this.shipPlan(projectId, prereqId);
    }
    return this.shipPlan(projectId, planId);
  }

  /** Get plan status for Sketch CTA (plan/replan/none). PRD §7.1.5 */
  async getPlanStatus(projectId: string): Promise<PlanStatusResponse> {
    const latestRun = await this.getLatestPlanningRun(projectId);
    if (!latestRun) {
      return { hasPlanningRun: false, prdChangedSinceLastRun: false, action: "plan" };
    }
    const currentPrd = await this.prdService.getPrd(projectId);
    const prdChanged = !this.prdsEqual(currentPrd, latestRun.prd_snapshot);
    if (!prdChanged) {
      return { hasPlanningRun: true, prdChangedSinceLastRun: false, action: "none" };
    }
    return { hasPlanningRun: true, prdChangedSinceLastRun: true, action: "replan" };
  }

  /** Get the latest planning run (most recent by created_at) */
  private async getLatestPlanningRun(projectId: string): Promise<{
    id: string;
    created_at: string;
    prd_snapshot: Prd;
    plans_created: string[];
  } | null> {
    const runsDir = await this.getPlanningRunsDir(projectId);
    try {
      const files = await fs.readdir(runsDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      if (jsonFiles.length === 0) return null;
      let latest: {
        id: string;
        created_at: string;
        prd_snapshot: Prd;
        plans_created: string[];
      } | null = null;
      for (const file of jsonFiles) {
        const data = await fs.readFile(path.join(runsDir, file), "utf-8");
        const run = JSON.parse(data) as {
          id: string;
          created_at: string;
          prd_snapshot: Prd;
          plans_created: string[];
        };
        if (!latest || run.created_at > latest.created_at) latest = run;
      }
      return latest;
    } catch {
      return null;
    }
  }

  /** Compare two PRDs by section content (ignoring changeLog) */
  private prdsEqual(a: Prd, b: Prd): boolean {
    const keys = new Set([...Object.keys(a.sections ?? {}), ...Object.keys(b.sections ?? {})]);
    for (const key of keys) {
      const ac = (a.sections as Record<string, { content?: string }>)?.[key]?.content ?? "";
      const bc = (b.sections as Record<string, { content?: string }>)?.[key]?.content ?? "";
      if (ac !== bc) return false;
    }
    return true;
  }

  /** Create a planning run with PRD snapshot. Called after decompose or replan. */
  async createPlanningRun(
    projectId: string,
    plansCreated: Plan[]
  ): Promise<{ id: string; created_at: string }> {
    const prd = await this.prdService.getPrd(projectId);
    const runId = crypto.randomUUID();
    const created_at = new Date().toISOString();
    const run = {
      id: runId,
      created_at,
      prd_snapshot: { ...prd },
      plans_created: plansCreated.map((p) => p.metadata.planId),
    };
    const runsDir = await this.getPlanningRunsDir(projectId);
    await fs.mkdir(runsDir, { recursive: true });
    await writeJsonAtomic(path.join(runsDir, `${runId}.json`), run);
    return { id: runId, created_at };
  }

  /**
   * Archive a plan: close all ready/open tasks to done. Tasks in progress remain unchanged.
   */
  async archivePlan(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.getPlan(projectId, planId);
    await this.getRepoPath(projectId);

    if (!plan.metadata.epicId) {
      throw new AppError(400, ErrorCodes.NO_EPIC, "Plan has no epic; cannot archive");
    }

    const epicId = plan.metadata.epicId;
    const allIssues = await this.taskStore.listAll(projectId);
    const planTasks = allIssues.filter(
      (issue: StoredTask) =>
        issue.id.startsWith(epicId + ".") && (issue.issue_type ?? issue.type) !== "epic"
    );

    const toClose = planTasks.filter((task) => ((task.status as string) ?? "open") === "open");
    if (toClose.length > 0) {
      await this.taskStore.closeMany(
        projectId,
        toClose.map((task) => ({ id: task.id, reason: "Archived plan" }))
      );
    }

    return this.getPlan(projectId, planId);
  }

  /**
   * Delete a plan from the database, its epic, and all tasks under that epic.
   */
  async deletePlan(projectId: string, planId: string): Promise<void> {
    const plan = await this.getPlan(projectId, planId);

    const epicId = plan.metadata.epicId;
    if (epicId) {
      const allIssues = await this.taskStore.listAll(projectId);
      const planTaskIds = allIssues.filter(
        (issue: StoredTask) =>
          issue.id === epicId || issue.id.startsWith(epicId + ".")
      );
      // Delete children before parent (longest ids first) to avoid dependency references to already-deleted tasks
      const sortedIds = [...planTaskIds]
        .map((t) => t.id)
        .sort((a, b) => b.length - a.length);
      for (const id of sortedIds) {
        await this.taskStore.delete(projectId, id);
      }
    }

    const deleted = await taskStoreSingleton.planDelete(projectId, planId);
    if (!deleted) {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
    }
  }

  /** Build a summary of the codebase structure for the auto-review agent (file tree, key files). */
  private async buildCodebaseContext(repoPath: string): Promise<string> {
    const SKIP_DIRS = new Set([
      ".git",
      "node_modules",
      ".next",
      "dist",
      "build",
      "__pycache__",
      ".venv",
    ]);
    const MAX_FILES = 150;
    const MAX_FILE_SIZE = 2000;

    async function walk(dir: string, prefix: string, files: string[]): Promise<void> {
      if (files.length >= MAX_FILES) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (files.length >= MAX_FILES) break;
          const rel = prefix + e.name;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
              await walk(path.join(dir, e.name), rel + "/", files);
            }
          } else {
            files.push(rel);
          }
        }
      } catch {
        // Ignore permission errors
      }
    }

    const files: string[] = [];
    await walk(repoPath, "", files);
    let context =
      "## Repository file structure\n\n```\n" + files.slice(0, MAX_FILES).join("\n") + "\n```\n\n";

    // Include key config/source files for context (truncated, max 8 files)
    const keyPatterns = ["package.json", "tsconfig.json", "src/", "app/", "lib/"];
    let keyFileCount = 0;
    for (const f of files) {
      if (context.length > 12000 || keyFileCount >= 8) break;
      if (
        keyPatterns.some((p) => f.includes(p)) &&
        (f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".json"))
      ) {
        try {
          const fullPath = path.join(repoPath, f);
          const stat = await fs.stat(fullPath);
          if (stat.size > MAX_FILE_SIZE * 10) continue;
          const content = await fs.readFile(fullPath, "utf-8");
          const excerpt = content.slice(0, MAX_FILE_SIZE);
          context += `### ${f}\n\n\`\`\`\n${excerpt}${content.length > MAX_FILE_SIZE ? "\n... (truncated)" : ""}\n\`\`\`\n\n`;
          keyFileCount++;
        } catch {
          // Skip unreadable files
        }
      }
    }
    return context;
  }

  /** Build plan/task summary for the auto-review agent using pre-collected task data. */
  private buildPlanTaskSummaryFromCreated(
    createdPlans: Array<Plan & { _createdTaskIds?: string[]; _createdTaskTitles?: string[] }>
  ): string {
    const lines: string[] = [];
    for (const plan of createdPlans) {
      const epicId = plan.metadata.epicId;
      if (!epicId) continue;
      lines.push(`## Plan: ${plan.metadata.planId} (epic: ${epicId})`);
      const ids = plan._createdTaskIds ?? [];
      const titles = plan._createdTaskTitles ?? [];
      for (let i = 0; i < ids.length; i++) {
        lines.push(`- **${ids[i]}**: ${titles[i] ?? "Untitled task"}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * Auto-review: invoke planning agent to compare created plans against the codebase
   * and mark already-implemented tasks as done. Best-effort; failures are logged, not thrown.
   */
  private async autoReviewPlanAgainstRepo(
    projectId: string,
    createdPlans: Array<Plan & { _createdTaskIds?: string[]; _createdTaskTitles?: string[] }>
  ): Promise<void> {
    if (createdPlans.length === 0) return;

    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.projectService.getSettings(projectId);

    // Use pre-collected task IDs from createPlan to avoid stale task store reads
    const validTaskIds = new Set<string>();
    for (const plan of createdPlans) {
      for (const id of plan._createdTaskIds ?? []) {
        validTaskIds.add(id);
      }
    }

    if (validTaskIds.size === 0) return;

    try {
      const codebaseContext = await this.buildCodebaseContext(repoPath);
      const planSummary = this.buildPlanTaskSummaryFromCreated(createdPlans);

      const prompt = `Review the following plans and tasks against the codebase. Identify which tasks are already implemented.\n\n## Created plans and tasks\n\n${planSummary}\n\n${codebaseContext}`;

      const agentId = `plan-auto-review-${projectId}-${Date.now()}`;

      const response = await agentService.invokePlanningAgent({
        projectId,
        config: getAgentForPlanningRole(settings, "planner"),
        messages: [{ role: "user", content: prompt }],
        systemPrompt: AUTO_REVIEW_SYSTEM_PROMPT,
        cwd: repoPath,
        tracking: {
          id: agentId,
          projectId,
          phase: "plan",
          role: "planner",
          label: "Plan auto-review",
        },
      });

      const parsed = extractJsonFromAgentResponse<{
        taskIdsToClose?: string[];
        reason?: string;
      }>(response.content, "taskIdsToClose");
      if (!parsed) {
        log.warn("Auto-review agent did not return valid JSON, skipping");
        return;
      }

      const ids = parsed.taskIdsToClose ?? [];
      const toClose = ids.filter((id) => validTaskIds.has(id));

      for (const taskId of toClose) {
        try {
          await this.taskStore.close(projectId, taskId, "Already implemented (auto-review)");
        } catch (err) {
          log.warn("Auto-review: failed to close task", { taskId, err });
        }
      }

      if (toClose.length > 0) {
        log.info("Auto-review marked tasks as done", { count: toClose.length, taskIds: toClose });
      }
    } catch (err) {
      log.error("Auto-review against repo failed", { err });
      // Decompose succeeded; auto-review is best-effort
    }
  }

  /** Build PRD context string for agent prompts */
  private async buildPrdContext(projectId: string): Promise<string> {
    try {
      const prd = await this.prdService.getPrd(projectId);
      let context = "";
      for (const [key, section] of Object.entries(prd.sections)) {
        if (section.content) {
          context += `### ${key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}\n`;
          context += `${section.content}\n\n`;
        }
      }
      return context || "The PRD is currently empty.";
    } catch (err) {
      log.warn("buildPrdContext: PRD unavailable", { err: getErrorMessage(err) });
      return "No PRD exists yet.";
    }
  }

  /**
   * Generate a plan from a freeform feature description using the Planner agent.
   * Invokes the planning agent with a specialized prompt, materializes the result
   * as a plan markdown + epic + child tasks (epic-blocked model: no gate), then returns the Plan.
   */
  async generatePlanFromDescription(projectId: string, description: string): Promise<Plan> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.projectService.getSettings(projectId);
    const prdContext = await this.buildPrdContext(projectId);

    const systemPrompt = `You are an AI planning assistant for OpenSprint. The user will describe a feature idea in freeform text. Your job is to produce a complete, implementation-ready feature plan.

## Output requirement (mandatory)
Your entire response MUST be the plan as a single JSON object. Do NOT write the plan to a file. Do NOT respond with a summary, description, or "here's what I created" text — the system parses your message for JSON only; any prose instead of JSON will cause failure.
You may wrap the JSON in a markdown code block (\`\`\`json ... \`\`\`). The JSON must include at minimum: "title", "content", "complexity", "mockups", "tasks".

Required JSON shape:
{
  "title": "Feature Name",
  "content": "# Feature Name\\n\\n## Overview\\n...full markdown...",
  "complexity": "medium",
  "mockups": [{"title": "Main Screen", "content": "ASCII wireframe"}],
  "tasks": [
    {"title": "Task title", "description": "Detailed spec", "priority": 1, "dependsOn": [], "complexity": 3}
  ]
}

Plan markdown MUST follow this structure (PRD §7.2.3). Each plan's content must include these sections in order:
${PLAN_MARKDOWN_SECTIONS.map((s) => `- ## ${s}`).join("\n")}

Template structure: ${PLAN_TEMPLATE_STRUCTURE}

Tasks should be atomic, implementable in one agent session, with clear acceptance criteria in the description.

MOCKUPS: Include at least one mockup (ASCII wireframe or text diagram) illustrating key UI for the feature.

Field rules: complexity: low, medium, high, or very_high (plan-level). Task-level complexity: integer 1-10 (1=simplest, 10=most complex) — assign per task based on implementation difficulty. priority: 0=highest. dependsOn: array of other task titles this task depends on.

**When requirements are unclear:** If the feature idea is too vague to decompose, return JSON with \`open_questions\`: [{ "id": "q1", "text": "Clarification question" }] instead of a plan. The server surfaces these via the Human Notification System; wait for user answers before proceeding.`;

    const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
    const systemPromptWithAutonomy = autonomyDesc
      ? `${systemPrompt}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
      : systemPrompt;

    const prompt = `Generate a complete feature plan for the following idea.\n\n## Feature Idea\n\n${description}\n\n## PRD Context\n\n${prdContext}`;

    const agentId = `plan-generate-${projectId}-${Date.now()}`;

    const response = await agentService.invokePlanningAgent({
      projectId,
      config: getAgentForPlanningRole(settings, "planner"),
      messages: [{ role: "user", content: prompt }],
      systemPrompt: systemPromptWithAutonomy,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "planner",
        label: "Generate plan from description",
      },
    });

    // Try "title" or "plan_title" so we find JSON when Planner uses snake_case
    let parsed: Record<string, unknown> | null =
      extractJsonFromAgentResponse<Record<string, unknown>>(response.content, "title") ??
      extractJsonFromAgentResponse<Record<string, unknown>>(response.content, "plan_title");

    // Fallback: agent may have written the plan to a JSON file and summarized in the message
    if (!parsed) {
      const planJsonPath = extractPlanJsonPathFromResponse(response.content);
      if (planJsonPath) {
        parsed = await readPlanJsonFromRepo(repoPath, planJsonPath);
        if (parsed) log.info("Used plan from file (agent wrote to file)", { path: planJsonPath });
      }
    }

    if (!parsed) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_PARSE_FAILED,
        "Planning agent did not return a valid plan. Response: " + response.content.slice(0, 500),
        { responsePreview: response.content.slice(0, 500) }
      );
    }

    const spec = normalizePlanSpec(parsed);

    const plan = await this.createPlan(projectId, {
      title: spec.title,
      content: spec.content || `# ${spec.title}\n\n${description}`,
      complexity: spec.complexity as PlanComplexity | undefined,
      mockups: spec.mockups,
      tasks: spec.tasks.map((t) => normalizePlannerTask(t, spec.tasks)) as unknown as Record<
        string,
        unknown
      >[],
    });

    // Auto-review against codebase
    try {
      await this.autoReviewPlanAgainstRepo(projectId, [plan]);
    } catch (err) {
      log.error("Auto-review after generate failed", { err });
    }

    broadcastToProject(projectId, {
      type: "plan.generated",
      planId: plan.metadata.planId,
    });

    return plan;
  }

  /**
   * AI-assisted decomposition (suggest only): Planning agent analyzes PRD and returns suggested plans.
   * Does NOT create plans or tasks — returns JSON for user to accept/modify. PRD §7.2.2
   */
  async suggestPlans(projectId: string): Promise<{ plans: SuggestedPlan[] }> {
    const settings = await this.projectService.getSettings(projectId);
    const prdContext = await this.buildPrdContext(projectId);
    const repoPath = await this.getRepoPath(projectId);

    const prompt = `Analyze the PRD below and produce a feature decomposition. Output valid JSON with a "plans" array. Each plan has: title, content (full markdown), complexity (low|medium|high|very_high), and tasks array. Each task has: title, description, priority (0-4), dependsOn (array of task titles it depends on), complexity (integer 1-10 — assign per task based on implementation difficulty, 1=simplest, 10=most complex).`;

    const agentId = `plan-suggest-${projectId}-${Date.now()}`;

    const baseSystemPrompt = DECOMPOSE_SYSTEM_PROMPT + "\n\n## Current PRD\n\n" + prdContext;
    const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
    const systemPrompt = autonomyDesc
      ? `${baseSystemPrompt}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
      : baseSystemPrompt;

    const response = await agentService.invokePlanningAgent({
      projectId,
      config: getAgentForPlanningRole(settings, "planner"),
      messages: [{ role: "user", content: prompt }],
      systemPrompt,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "planner",
        label: "Feature decomposition (suggest)",
      },
    });

    const planSpecs = this.parseDecomposeResponse(response.content);
    return { plans: planSpecs };
  }

  /**
   * Parse agent decomposition response into SuggestedPlan array.
   * Extracts JSON from response (may be wrapped in ```json ... ```).
   */
  private parseDecomposeResponse(content: string): SuggestedPlan[] {
    // Try "plans" or "plan_list" so we find JSON when Planner uses snake_case
    const parsed =
      extractJsonFromAgentResponse<{ plans?: unknown[]; plan_list?: unknown[] }>(
        content,
        "plans"
      ) ??
      extractJsonFromAgentResponse<{ plans?: unknown[]; plan_list?: unknown[] }>(
        content,
        "plan_list"
      );
    if (!parsed) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_PARSE_FAILED,
        "Planning agent did not return valid decomposition JSON. Response: " +
          content.slice(0, 500),
        { responsePreview: content.slice(0, 500) }
      );
    }

    const rawSpecs = (parsed.plans ?? parsed.plan_list ?? []) as Array<Record<string, unknown>>;
    if (rawSpecs.length === 0) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_EMPTY,
        "Planning agent returned no plans. Ensure the PRD has sufficient content."
      );
    }
    // Normalize to camelCase so API response is consistent regardless of Planner output
    return rawSpecs.map((rawSpec) => {
      const spec = normalizePlanSpec(rawSpec);
      return {
        title: spec.title,
        content: spec.content,
        complexity: spec.complexity,
        dependsOnPlans: normalizeDependsOnPlans(rawSpec),
        mockups: spec.mockups,
        tasks: spec.tasks.map((t) => normalizePlannerTask(t, spec.tasks)),
      };
    }) as SuggestedPlan[];
  }

  /**
   * AI-assisted decomposition: Planning agent analyzes PRD and suggests feature breakdown.
   * Creates Plans + tasks from AI. PRD §7.2.2
   */
  async decomposeFromPrd(projectId: string): Promise<{ created: number; plans: Plan[] }> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.projectService.getSettings(projectId);

    const prdContext = await this.buildPrdContext(projectId);

    const prompt = `Analyze the PRD below and produce a feature decomposition. Output valid JSON with a "plans" array. Each plan has: title, content (full markdown), complexity (low|medium|high|very_high), and tasks array. Each task has: title, description, priority (0-4), dependsOn (array of task titles it depends on), complexity (integer 1-10 — assign per task based on implementation difficulty, 1=simplest, 10=most complex).`;

    const agentId = `plan-decompose-${projectId}-${Date.now()}`;

    const baseSystemPrompt = DECOMPOSE_SYSTEM_PROMPT + "\n\n## Current PRD\n\n" + prdContext;
    const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
    const systemPrompt = autonomyDesc
      ? `${baseSystemPrompt}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
      : baseSystemPrompt;

    const response = await agentService.invokePlanningAgent({
      projectId,
      config: getAgentForPlanningRole(settings, "planner"),
      messages: [{ role: "user", content: prompt }],
      systemPrompt,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "planner",
        label: "Feature decomposition",
      },
    });

    const planSpecs = this.parseDecomposeResponse(response.content);

    const created: Plan[] = [];
    for (const spec of planSpecs) {
      const rawContent = spec.content || "# Untitled Feature\n\nNo content.";
      const content = ensureDependenciesSection(
        rawContent,
        normalizeDependsOnPlans(spec as unknown as Record<string, unknown>)
      );
      const rawTasks = (spec.tasks ?? []) as unknown as Array<Record<string, unknown>>;
      const plan = await this.createPlan(projectId, {
        title: spec.title || "Untitled Feature",
        content,
        complexity: (spec.complexity as PlanMetadata["complexity"]) || "medium",
        mockups: (spec.mockups ?? []).map((m) => ({
          title: m.title || "Mockup",
          content: m.content || "",
        })),
        tasks: rawTasks.map((t) => normalizePlannerTask(t, rawTasks)) as unknown as Record<
          string,
          unknown
        >[],
      });
      created.push(plan);
    }

    // Auto-review: invoke second agent to mark already-implemented tasks as done
    try {
      await this.autoReviewPlanAgainstRepo(projectId, created);
    } catch (err) {
      log.error("Auto-review after decompose failed", { err });
      // Decompose succeeded; auto-review is best-effort
    }

    // Create planning run with PRD snapshot (PRD §5.6, §7.2.2)
    await this.createPlanningRun(projectId, created);

    return { created: created.length, plans: created };
  }
}
